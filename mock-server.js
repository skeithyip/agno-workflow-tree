#!/usr/bin/env node
// Mock backend for developing the live view before the real Agno server exists. It replays
// trace-data.js as a run happening now: timestamps are shifted to the moment the run is first
// requested and compressed by `speed`, and events are sent when their (shifted) time arrives,
// following the stream contract in trace.js.
//
//   GET /runs/:id/events   SSE stream; resumes after Last-Event-ID. The run is created on first
//                          request, so a new id starts a new run. Query options:
//                            speed=N   compress the recorded run N times (default 20, ~1 min)
//                            jitter=1  send some nodes' start late, after their first events
//                            drop=N    close the connection after N events (tests reconnect)
//   GET /runs/:id/final    the finished trace (FINAL_OUTPUT shape); 409 while still running
//   GET /*                 static files from this directory
//
// Usage: node mock-server.js   (PORT env var, default 8787), then open http://localhost:8787/
const http = require("http");
const fs = require("fs");
const path = require("path");
const { traceToStream, retimeTrace } = require("./trace.js");

const ROOT = __dirname;
const HEARTBEAT_MS = 2000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

// trace-data.js is `window.FINAL_OUTPUT = {...};` — read it as JSON rather than evaluating it.
function loadFinalOutput(file = path.join(ROOT, "trace-data.js")) {
  const src = fs.readFileSync(file, "utf8");
  return JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
}

function createRun(source, id, { speed = 20, jitter = false } = {}) {
  const t0 = Date.parse(source.created_at);
  const start = Date.now() + 300;
  const final = retimeTrace(source, (t) => start + (t - t0) / speed, 1 / speed);
  const items = traceToStream(final, { jitter });
  const last = items[items.length - 1].evt;
  if (last.event === "run.completed") last.final_url = `/runs/${encodeURIComponent(id)}/final`;
  return { final, items, endsAt: items[items.length - 1].ts };
}

function sse(res, { id, event, data }) {
  res.write((id != null ? `id: ${id}\n` : "") + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamRun(req, res, run, { from, drop }) {
  if (from >= run.items.length) { res.writeHead(204).end(); return; } // finished: tells EventSource to stop
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 1000\n\n");
  let closed = false;
  req.on("close", () => { closed = true; });
  const beat = () => sse(res, { event: "heartbeat", data: { server_time_ms: Date.now() } });
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);

  let sent = 0;
  for (const it of run.items) {
    if (it.evt.seq <= from) continue;
    // Sleep in short slices so a closed connection is noticed promptly.
    while (!closed && it.ts > Date.now()) await new Promise((r) => setTimeout(r, Math.min(250, it.ts - Date.now())));
    if (closed) break;
    sse(res, { id: it.evt.seq, event: "trace", data: it.evt });
    if (drop && ++sent >= drop) break;
  }
  clearInterval(timer);
  res.end();
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
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
    const m = url.pathname.match(/^\/runs\/([^/]+)\/(events|final)$/);
    if (!m) { serveStatic(req, res, url.pathname); return; }
    const id = decodeURIComponent(m[1]);

    if (m[2] === "events") {
      const q = url.searchParams;
      let run = runs.get(id);
      if (!run) {
        run = createRun(source, id, { speed: Math.max(0.01, +q.get("speed") || 20), jitter: q.get("jitter") === "1" });
        runs.set(id, run);
        log(`run ${id}: ${run.items.length} events over ${((run.endsAt - Date.now()) / 1000).toFixed(1)}s`);
      }
      const from = +(req.headers["last-event-id"] || q.get("lastEventId") || 0);
      if (from) log(`run ${id}: client resumed after event ${from}`);
      streamRun(req, res, run, { from, drop: +q.get("drop") || 0 });
      return;
    }

    const run = runs.get(id);
    if (!run) { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unknown run" })); return; }
    if (Date.now() < run.endsAt) { res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "run still in progress" })); return; }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(run.final));
  });
}

if (require.main === module) {
  const port = +process.env.PORT || 8787;
  createServer({ log: (s) => console.log(s) }).listen(port, () => {
    console.log(`Mock SSE server on http://localhost:${port}/  (choose "Live stream" in the Dataset menu)`);
  });
}

module.exports = { createServer, loadFinalOutput };
