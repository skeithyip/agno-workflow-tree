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
//                              pauses=1  pause agents before a tool call for approval or input
//                              parallel=1  run the two expert branches at the same time
//   POST /runs/:id/messages  steer running agents: { targets: [node_id, ...], text, mode?: "steer",
//                            client_msg_id?, author? } -> 202 { messages: [{ message_id, node_id }],
//                            broadcast_id?, skipped: [{ node_id, reason }] }. Targets that are no
//                            longer running are skipped; 409 only if none of them can take it.
//   POST /runs/:id/pauses/:pause_id  answer a pause: { decision: "approve" | "reject" | "submit",
//                            values?: { field: text }, note?, author? } -> 200; 409 if already answered
//   GET  /runs/:id/final     the finished trace (FINAL_OUTPUT shape); 409 while still running
//   GET  /*                  static files from this directory
//
// Each run keeps one event log that every viewer reads from, so all viewers see the same events
// with the same seq, including other viewers' messages. The mock can't change what an agent
// does: a message is marked delivered at the agent's next tool result (where a real agent would
// next call the model) or expired if the agent finishes first.
//
// With pauses=1, the 1st, 3rd, ... agents that call tools stop before their first
// mcp_execute_tool call to ask for approval, and the 2nd, 4th, ... ask which source to query.
// The recorded run is sequential, so a pause holds the whole run: later events are shifted by
// however long it waited. Rejecting skips that tool call; submitted input is merged into its args.
//
// A message to several agents is a broadcast: each target gets its own message (own message_id
// and delivery state) carrying the same broadcast_id and broadcast_size.
//
// Usage: node mock-server.js   (PORT env var, default 8787), then open http://localhost:8787/
const http = require("http");
const fs = require("fs");
const path = require("path");
const { traceToStream, retimeTrace, createTraceStore } = require("./trace.js");

const ROOT = __dirname;
const HEARTBEAT_MS = 2000;
const STEERABLE = new Set(["agent", "team"]);
const FINISHED = new Set(["completed", "failed", "error", "cancelled"]);
const DECISIONS = { confirm: { approve: "approved", reject: "rejected" }, input: { submit: "submitted", reject: "rejected" } };
const LIMITS = { body: 64 * 1024, text: 4000, targets: 50, id: 100, author: 80, value: 1000, note: 500 };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

// trace-data.js is `window.FINAL_OUTPUT = {...};` — read it as JSON rather than evaluating it.
function loadFinalOutput(file = path.join(ROOT, "trace-data.js")) {
  const src = fs.readFileSync(file, "utf8");
  return JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
}

// ---------- runs ----------

function createRun(source, id, { speed = 20, jitter = false, pauses = false, parallel = false } = {}) {
  if (parallel) source = runBranchesInParallel(source);
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
    broadcastCount: 0,
    pause: null,             // the pause holding the run, if any
    pauses: new Map(),       // pause_id -> pause
    done: false,
  };
  if (pauses) markPauses(schedule);
  pump(run);
  return run;
}

// parallel=1: the recorded workflow runs its expert branches (consecutive condition steps under
// the root) one after another. This starts them together, as an Agno Parallel step would, and
// moves the steps after them up to when the slowest has finished. Only timestamps change.
function runBranchesInParallel(o) {
  const byId = new Map(o.nodes.map((n) => [n.node_id, n]));
  const root = byId.get(o.root_ids[0]);
  const kids = (root.children_ids || []).map((id) => byId.get(id));
  const i = kids.findIndex((k, j) => k.type === "condition" && kids[j + 1] && kids[j + 1].type === "condition");
  if (i < 0) return o;
  let j = i;
  while (kids[j + 1] && kids[j + 1].type === "condition") j++;

  const t = (iso) => Date.parse(iso);
  const shift = new Map(); // node_id -> ms to move it by
  const move = (n, d) => { shift.set(n.node_id, d); (n.children_ids || []).forEach((c) => move(byId.get(c), d)); };
  const start = t(kids[i].started_at);
  let end = -Infinity;
  for (let k = i; k <= j; k++) {
    const d = start - t(kids[k].started_at);
    move(kids[k], d);
    end = Math.max(end, t(kids[k].completed_at) + d);
  }
  const later = end - t(kids[j].completed_at); // the last branch used to end the group
  kids.slice(j + 1).forEach((k) => move(k, later));

  const at = (iso, d) => new Date(t(iso) + d).toISOString();
  const nodes = o.nodes.map((n) => {
    const d = shift.get(n.node_id);
    if (d) return retimeTrace(n, (x) => x + d);
    return n === root ? { ...n, completed_at: at(n.completed_at, later) } : n;
  });
  return { ...o, nodes, completed_at: at(o.completed_at, later), total_duration_seconds: o.total_duration_seconds + later / 1000 };
}

// Picks each tool-calling agent's first mcp_execute_tool call (or first call) as a pause point.
function markPauses(schedule) {
  const agents = new Set(), seen = new Set();
  schedule.forEach(({ evt }) => { if (evt.node && evt.node.type === "agent") agents.add(evt.node.node_id); });
  let k = 0;
  agents.forEach((nodeId) => {
    const calls = schedule.filter((it) => it.evt.node_id === nodeId && it.evt.type === "tool_start");
    const it = calls.find((c) => c.evt.tool_name === "mcp_execute_tool") || calls[0];
    if (!it || seen.has(it)) return;
    seen.add(it);
    const kind = k++ % 2 === 0 ? "confirm" : "input";
    it.pause = { kind };
    if (kind === "input") {
      const current = it.evt.tool_args && it.evt.tool_args.args && it.evt.tool_args.args.source;
      it.pause.fields = [{ name: "source", type: "string", description: "Which data source should it query?", required: true, ...(current ? { default: current } : {}) }];
    }
  });
}

// Send every scheduled event whose time has come, then sleep until the next one. Stops at a
// pause point until the pause is answered.
function pump(run) {
  clearTimeout(run.timer);
  if (run.pause) return;
  while (run.next < run.schedule.length && run.schedule[run.next].ts <= Date.now()) {
    const it = run.schedule[run.next];
    if (it.pause && !it.pause.done) { requestPause(run, it); return; }
    run.next++;
    emit(run, it.evt);
  }
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
  else if (e.node && FINISHED.has(e.node.status)) settle(run, e.node.node_id, "expired");
}

function settle(run, nodeId, outcome) {
  const ids = run.queued.get(nodeId);
  if (!ids) return;
  run.queued.delete(nodeId);
  ids.forEach((message_id) => emit(run, { node_id: nodeId, type: "human", event: `human.${outcome}`, message_id, completed_at: new Date().toISOString() }));
}

function requestPause(run, it) {
  const { node_id, tool_call_id, tool_name, tool_args } = it.evt;
  const node = run.store.node(node_id);
  const p = { id: `p_${run.pauses.size + 1}`, item: it, kind: it.pause.kind, fields: it.pause.fields, nodeId: node_id, since: Date.now(), answer: null };
  run.pause = p;
  run.pauses.set(p.id, p);
  const prompt = p.kind === "confirm" ? `${node.name} wants to run ${tool_name}.` : `${node.name} needs input before running ${tool_name}.`;
  const evt = { node_id, type: "pause", event: "pause.requested", pause_id: p.id, kind: p.kind, prompt, tool_call_id, tool_name, started_at: new Date(p.since).toISOString() };
  if (tool_args !== undefined) evt.tool_args = tool_args;
  if (p.fields) evt.fields = p.fields;
  emit(run, evt);
  emit(run, { event: `${node.type}.paused`, node: { node_id, status: "paused" } });
}

// Validates an answer to a pause and lets the run continue. Returns [status, body].
function answerPause(run, pauseId, body) {
  const fail = (status, error) => [status, { error }];
  const p = run.pauses.get(pauseId);
  if (!p) return fail(404, "No such pause in this run.");
  if (p.answer) return fail(409, `Already ${p.answer.decision}${p.answer.by ? " by " + p.answer.by : ""}.`);
  const { decision, values, note, author } = body || {};
  const outcome = DECISIONS[p.kind][decision];
  if (!outcome) return fail(400, `decision must be ${Object.keys(DECISIONS[p.kind]).map((d) => `"${d}"`).join(" or ")}.`);
  if (note != null && (typeof note !== "string" || note.length > LIMITS.note)) return fail(400, "note is invalid.");
  if (author != null && (typeof author !== "string" || author.length > LIMITS.author)) return fail(400, "author is invalid.");
  let clean;
  if (decision === "submit") {
    if (!values || typeof values !== "object" || Array.isArray(values)) return fail(400, "values are required.");
    const names = new Set(p.fields.map((f) => f.name));
    const extra = Object.keys(values).find((k) => !names.has(k));
    if (extra) return fail(400, `Unknown field "${extra}".`);
    clean = {};
    for (const f of p.fields) {
      const v = values[f.name];
      if (v != null && (typeof v !== "string" || v.length > LIMITS.value)) return fail(400, `${f.name} is invalid.`);
      if (f.required && !(v || "").trim()) return fail(400, `${f.name} is required.`);
      if (v != null) clean[f.name] = v.trim();
    }
  }

  // Everything still to come happens later by however long the run waited.
  const delta = Date.now() - p.since;
  for (let i = run.next; i < run.schedule.length; i++) {
    const it = run.schedule[i];
    it.ts += delta;
    it.evt = retimeTrace(it.evt, (t) => t + delta);
  }
  p.answer = { decision: outcome, by: author };
  p.item.pause.done = true;

  const evt = { node_id: p.nodeId, type: "pause", event: "pause.resolved", pause_id: p.id, decision: outcome, completed_at: new Date().toISOString() };
  if (clean) evt.values = clean;
  if (note && note.trim()) evt.note = note.trim();
  if (author) evt.resolved_by = author;
  emit(run, evt);
  emit(run, { event: `${run.store.node(p.nodeId).type}.continued`, node: { node_id: p.nodeId, status: "running" } });

  const callId = p.item.evt.tool_call_id;
  if (outcome === "rejected") {
    // The call never happens: drop its start and end.
    run.schedule = run.schedule.filter((it, i) => i < run.next || !(it.evt.node_id === p.nodeId && it.evt.tool_call_id === callId));
  } else if (clean) {
    const a = p.item.evt.tool_args || {};
    p.item.evt.tool_args = a.args && typeof a.args === "object" ? { ...a, args: { ...a.args, ...clean } } : { ...a, ...clean };
  }
  run.pause = null;
  pump(run);
  return [200, { pause_id: p.id, decision: outcome }];
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
  const ids = [...new Set(targets)];
  if (mode !== "steer") return fail(400, `mode "${mode}" is not supported.`);
  if (client_msg_id != null && (typeof client_msg_id !== "string" || client_msg_id.length > LIMITS.id)) return fail(400, "client_msg_id is invalid.");
  if (author != null && (typeof author !== "string" || author.length > LIMITS.author)) return fail(400, "author is invalid.");

  // Unknown ids and non-agents are mistakes in the request; an agent that finished meanwhile is
  // a race with the run, so it is skipped rather than failing the whole broadcast.
  const live = [], skipped = [];
  for (const t of ids) {
    const n = run.store.node(t);
    if (!n) return fail(404, "No such node in this run.", { node_id: t });
    if (!STEERABLE.has(n.type)) return fail(422, `A ${n.type} can't take messages; send to an agent.`, { node_id: t });
    if (n.status === "running" || n.status === "paused") live.push(t);
    else skipped.push({ node_id: t, reason: `${n.name} is not running.` });
  }
  if (!live.length) return fail(409, skipped.length === 1 ? skipped[0].reason : "None of these agents are running.", { skipped });

  const sentAt = new Date().toISOString();
  const broadcast = ids.length > 1 ? { broadcast_id: `b_${++run.broadcastCount}`, broadcast_size: live.length } : null;
  const messages = live.map((node_id) => {
    const message_id = `m_${++run.msgCount}`;
    const evt = { node_id, type: "human", event: "human.message", message_id, text, mode, started_at: sentAt, ...broadcast };
    if (client_msg_id) evt.client_msg_id = client_msg_id;
    if (author) evt.author = author;
    emit(run, evt);
    if (!run.queued.has(node_id)) run.queued.set(node_id, []);
    run.queued.get(node_id).push(message_id);
    return { message_id, node_id };
  });
  return [202, { messages, skipped, ...(broadcast && { broadcast_id: broadcast.broadcast_id }) }];
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
    const m = url.pathname.match(/^\/runs\/([^/]+)\/(events|final|messages|pauses\/[^/]+)$/);
    if (!m) { serveStatic(req, res, url.pathname); return; }
    const id = decodeURIComponent(m[1]);
    const pauseId = m[2].startsWith("pauses/") ? decodeURIComponent(m[2].slice(7)) : null;
    const route = `${req.method} ${pauseId ? "pause" : m[2]}`;

    if (route === "GET events") {
      const q = url.searchParams;
      let run = runs.get(id);
      if (!run) {
        run = createRun(source, id, { speed: Math.max(0.01, +q.get("speed") || 20), jitter: q.get("jitter") === "1", pauses: q.get("pauses") === "1", parallel: q.get("parallel") === "1" });
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
        if (status === 202) log(`run ${id}: message to ${out.messages.map((x) => x.node_id.slice(0, 8)).join(", ")}${out.skipped.length ? ` (skipped ${out.skipped.length})` : ""}`);
        json(res, status, out);
      });
      return;
    }
    if (route === "POST pause") {
      if (!run) { json(res, 404, { error: "Unknown run." }); return; }
      readJson(req, res, (body) => {
        const [status, out] = answerPause(run, pauseId, body);
        if (status === 200) log(`run ${id}: pause ${pauseId} ${out.decision}`);
        json(res, status, out);
      });
      return;
    }
    res.writeHead(405, { Allow: m[2] === "messages" || pauseId ? "POST" : "GET" }).end();
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

module.exports = { createServer, loadFinalOutput, runBranchesInParallel };
