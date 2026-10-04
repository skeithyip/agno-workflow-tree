#!/usr/bin/env node
// Mock backend for developing the live view before the real Agno server exists. It replays
// trace-data.js as a run happening now: timestamps are shifted to the moment the run is first
// requested and compressed by `speed`, and events are sent when their (shifted) time arrives,
// following the stream contract in trace.js.
//
//   GET  /runs/:id/events    SSE stream; resumes after Last-Event-ID. The run is created on first
//                            request, so a new id starts a new run. Query options:
//                              speed=N   compress the recorded run N times (default 20, ~1 min)
//                              jitter=1  send some nodes' start late, after their first events
//                              drop=N    close the connection after N events (tests reconnect)
//   POST /runs/:id/messages  steer running agents: { targets: [node_id], text, mode?: "steer",
//                            client_msg_id?, author? } -> 202 { messages: [{ message_id, node_id }] }
//   GET  /runs/:id/final     the finished trace (FINAL_OUTPUT shape); 409 while still running
//   GET  /*                  static files from this directory
//
// Each run keeps one event log that every viewer reads from, so all viewers see the same events
// with the same seq, including other viewers' messages. The mock can't change what an agent
// does: a message is marked delivered at the agent's next tool result (where a real agent would
// next call the model) or expired if the agent finishes first.
//
// Usage: node mock-server.js   (PORT env var, default 8787), then open http://localhost:8787/
const http = require("http");
const fs = require("fs");
const path = require("path");
const { traceToStream, retimeTrace, createTraceStore } = require("./trace.js");

const ROOT = __dirname;
const HEARTBEAT_MS = 2000;
const STEERABLE = new Set(["agent", "team"]);
const LIMITS = { body: 64 * 1024, text: 4000, targets: 50, id: 100, author: 80 };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

// trace-data.js is `window.FINAL_OUTPUT = {...};` — read it as JSON rather than evaluating it.
function loadFinalOutput(file = path.join(ROOT, "trace-data.js")) {
  const src = fs.readFileSync(file, "utf8");
  return JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
}

// ---------- runs ----------

function createRun(source, id, { speed = 20, jitter = false } = {}) {
  const t0 = Date.parse(source.created_at);
  const start = Date.now() + 300;
  const shifted = retimeTrace(source, (t) => start + (t - t0) / speed, 1 / speed);
  const schedule = traceToStream(shifted, { jitter }).map(({ ts, evt: { seq, ...evt } }) => ({ ts, evt }));
  const last = schedule[schedule.length - 1].evt;
  if (last.event === "run.completed") last.final_url = `/runs/${encodeURIComponent(id)}/final`;

  const run = {
    schedule, next: 0, timer: null,
    log: [],                 // every event sent, in seq order
    store: createTraceStore(), // the run as viewers see it; also its final trace
    clients: new Set(),
    queued: new Map(),       // node_id -> message_ids not yet delivered
    msgCount: 0,
    done: false,
  };
  pump(run);
  return run;
}

// Send every scheduled event whose time has come, then sleep until the next one.
function pump(run) {
  clearTimeout(run.timer);
  while (run.next < run.schedule.length && run.schedule[run.next].ts <= Date.now()) emit(run, run.schedule[run.next++].evt);
  if (run.next < run.schedule.length) run.timer = setTimeout(() => pump(run), run.schedule[run.next].ts - Date.now());
}

function emit(run, evt) {
  const e = { seq: run.log.length + 1, ...evt };
  run.log.push(e);
  run.store.apply(e);
  run.clients.forEach((c) => c.send(e));
  if (e.event === "run.completed") run.done = true;

  // Delivery: a tool result is where the agent next goes back to the model.
  if (e.type === "tool_end") settle(run, e.node_id, "delivered");
  else if (e.node && e.node.status && e.node.status !== "running") settle(run, e.node.node_id, "expired");
}

function settle(run, nodeId, outcome) {
  const ids = run.queued.get(nodeId);
  if (!ids) return;
  run.queued.delete(nodeId);
  ids.forEach((message_id) => emit(run, { node_id: nodeId, type: "human", event: `human.${outcome}`, message_id, completed_at: new Date().toISOString() }));
}

// Validates a steering request and queues one message per target. Returns [status, body].
function postMessages(run, body) {
  const fail = (status, error, extra) => [status, { error, ...extra }];
  if (run.done) return fail(409, "The run has finished.");
  const { targets, text, mode = "steer", client_msg_id, author } = body || {};
  if (typeof text !== "string" || !text.trim()) return fail(400, "text is required.");
  if (text.length > LIMITS.text) return fail(400, `text is longer than ${LIMITS.text} characters.`);
  if (!Array.isArray(targets) || !targets.length || targets.length > LIMITS.targets || !targets.every((t) => typeof t === "string")) {
    return fail(400, `targets must be 1–${LIMITS.targets} node ids.`);
  }
  if (mode !== "steer") return fail(400, `mode "${mode}" is not supported.`);
  if (client_msg_id != null && (typeof client_msg_id !== "string" || client_msg_id.length > LIMITS.id)) return fail(400, "client_msg_id is invalid.");
  if (author != null && (typeof author !== "string" || author.length > LIMITS.author)) return fail(400, "author is invalid.");

  for (const t of targets) {
    const n = run.store.node(t);
    if (!n) return fail(404, "No such node in this run.", { node_id: t });
    if (!STEERABLE.has(n.type)) return fail(422, `A ${n.type} can't take messages; send to an agent.`, { node_id: t });
    if (n.status !== "running") return fail(409, `${n.name} is not running.`, { node_id: t });
  }

  const sentAt = new Date().toISOString();
  const messages = targets.map((node_id) => {
    const message_id = `m_${++run.msgCount}`;
    const evt = { node_id, type: "human", event: "human.message", message_id, text, mode, started_at: sentAt };
    if (client_msg_id) evt.client_msg_id = client_msg_id;
    if (author) evt.author = author;
    emit(run, evt);
    if (!run.queued.has(node_id)) run.queued.set(node_id, []);
    run.queued.get(node_id).push(message_id);
    return { message_id, node_id };
  });
  return [202, { messages }];
}

// ---------- http ----------

function sse(res, { id, event, data }) {
  res.write((id != null ? `id: ${id}\n` : "") + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamRun(req, res, run, { from, drop }) {
  if (run.done && from >= run.log.length) { res.writeHead(204).end(); return; } // finished: tells EventSource to stop
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 1000\n\n");
  let closed = false, sent = 0;
  const beat = () => sse(res, { event: "heartbeat", data: { server_time_ms: Date.now() } });
  const timer = setInterval(beat, HEARTBEAT_MS);
  const client = {
    send(evt) {
      if (closed) return;
      sse(res, { id: evt.seq, event: "trace", data: evt });
      if (evt.event === "run.completed" || (drop && ++sent >= drop)) close();
    },
  };
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    run.clients.delete(client);
    res.end();
  }
  req.on("close", close);
  beat();
  for (const evt of run.log) if (evt.seq > from) client.send(evt); // backlog first
  if (!closed) run.clients.add(client);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

function readJson(req, res, then) {
  if (!/^application\/json\b/.test(req.headers["content-type"] || "")) { json(res, 415, { error: "Send JSON (Content-Type: application/json)." }); return; }
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > LIMITS.body) { json(res, 413, { error: "Request body is too large." }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (size > LIMITS.body) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json(res, 400, { error: "Body is not valid JSON." }); return; }
    then(body);
  });
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || rel.split("/").some((p) => p.startsWith(".") || p === "node_modules")) {
    res.writeHead(404).end("Not found");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
}

function createServer({ source = loadFinalOutput(), log = () => {} } = {}) {
  const runs = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
    const m = url.pathname.match(/^\/runs\/([^/]+)\/(events|final|messages)$/);
    if (!m) { serveStatic(req, res, url.pathname); return; }
    const id = decodeURIComponent(m[1]);
    const route = `${req.method} ${m[2]}`;

    if (route === "GET events") {
      const q = url.searchParams;
      let run = runs.get(id);
      if (!run) {
        run = createRun(source, id, { speed: Math.max(0.01, +q.get("speed") || 20), jitter: q.get("jitter") === "1" });
        runs.set(id, run);
        log(`run ${id}: ${run.schedule.length} events over ${((run.schedule.at(-1).ts - Date.now()) / 1000).toFixed(1)}s`);
      }
      const from = +(req.headers["last-event-id"] || q.get("lastEventId") || 0);
      if (from) log(`run ${id}: client resumed after event ${from}`);
      streamRun(req, res, run, { from, drop: +q.get("drop") || 0 });
      return;
    }

    const run = runs.get(id);
    if (route === "GET final") {
      if (!run) json(res, 404, { error: "Unknown run." });
      else if (!run.done) json(res, 409, { error: "Run still in progress." });
      else json(res, 200, run.store.snapshot());
      return;
    }
    if (route === "POST messages") {
      if (!run) { json(res, 404, { error: "Unknown run." }); return; }
      readJson(req, res, (body) => {
        const [status, out] = postMessages(run, body);
        if (status === 202) log(`run ${id}: message to ${out.messages.map((x) => x.node_id.slice(0, 8)).join(", ")}`);
        json(res, status, out);
      });
      return;
    }
    res.writeHead(405, { Allow: m[2] === "messages" ? "POST" : "GET" }).end();
  });
  server.on("close", () => runs.forEach((r) => clearTimeout(r.timer)));
  return server;
}

if (require.main === module) {
  const port = +process.env.PORT || 8787;
  createServer({ log: (s) => console.log(s) }).listen(port, () => {
    console.log(`Mock SSE server on http://localhost:${port}/  (choose "Live stream" in the Dataset menu)`);
  });
}

module.exports = { createServer, loadFinalOutput };
