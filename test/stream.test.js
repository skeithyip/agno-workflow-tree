// Stream contract tests: folding the event stream must rebuild the finished trace exactly,
// whatever order nodes start in and however often the connection drops.
const test = require("node:test");
const assert = require("node:assert/strict");
const { traceToStream, createTraceStore, retimeTrace } = require("../trace.js");
const { createServer, loadFinalOutput } = require("../mock-server.js");

const FINAL = loadFinalOutput();

function fold(events, handlers) {
  const store = createTraceStore(handlers);
  events.forEach((e) => store.apply(e));
  return store;
}

// Same trace with node order and children order ignored, for streams that start nodes late.
function normalized(o) {
  const nodes = o.nodes.map((n) => (n.children_ids ? { ...n, children_ids: [...n.children_ids].sort() } : n));
  return { ...o, nodes: nodes.sort((a, b) => a.node_id.localeCompare(b.node_id)) };
}

test("in-order stream folds back to FINAL_OUTPUT exactly", () => {
  const events = traceToStream(FINAL).map((it) => it.evt);
  const store = fold(events);
  assert.deepEqual(store.snapshot(), FINAL);
  assert.equal(store.pending, 0);
});

test("events are in time order with consecutive seq", () => {
  const items = traceToStream(FINAL);
  items.forEach((it, i) => {
    assert.equal(it.evt.seq, i + 1);
    if (i) assert.ok(it.ts >= items[i - 1].ts, `event ${i + 1} goes back in time`);
  });
  assert.equal(items[0].evt.event, "run.started");
  assert.equal(items.at(-1).evt.event, "run.completed");
});

test("nodes added parent-first, each before its own events", () => {
  const seen = new Set();
  const order = [];
  fold(traceToStream(FINAL).map((it) => it.evt), {
    onNodeAdd: (n) => {
      assert.ok(!n.parent_id || seen.has(n.parent_id), `${n.name} added before its parent`);
      seen.add(n.node_id);
      order.push(n.node_id);
    },
    onMessage: (n) => assert.ok(seen.has(n.node_id)),
  });
  assert.equal(order.length, FINAL.nodes.length);
});

test("late node starts are buffered and the result is the same trace", () => {
  const events = traceToStream(FINAL, { jitter: true }).map((it) => it.evt);
  let early = 0;
  const started = new Set();
  events.forEach((e) => {
    if (e.node && e.node.type) started.add(e.node.node_id);
    else if (e.node_id && !started.has(e.node_id)) early++;
  });
  assert.ok(early > 0, "jitter should send some messages before their node starts");

  const added = new Set();
  const store = fold(events, {
    onNodeAdd: (n) => { assert.ok(!n.parent_id || added.has(n.parent_id)); added.add(n.node_id); },
    onMessage: (n) => assert.ok(added.has(n.node_id), "message delivered before its node"),
  });
  assert.equal(store.pending, 0);
  assert.deepEqual(normalized(store.snapshot()), normalized(FINAL));
});

test("events repeated after a reconnect are ignored", () => {
  const events = traceToStream(FINAL).map((it) => it.evt);
  const half = Math.floor(events.length / 2);
  const store = createTraceStore();
  events.slice(0, half).forEach((e) => store.apply(e));
  events.slice(half - 20).forEach((e) => store.apply(e)); // server resent the last 20
  assert.deepEqual(store.snapshot(), FINAL);
  assert.equal(store.lastSeq, events.length);
});

test("retimed trace streams and folds to the retimed trace", () => {
  const t0 = Date.parse(FINAL.created_at);
  const shifted = retimeTrace(FINAL, (t) => 1e12 + (t - t0) / 10, 0.1);
  assert.equal(shifted.created_at, new Date(1e12).toISOString());
  assert.ok(Math.abs(shifted.total_duration_seconds - FINAL.total_duration_seconds / 10) < 1e-9);
  assert.deepEqual(fold(traceToStream(shifted).map((it) => it.evt)).snapshot(), shifted);
});

// ---------- end to end against the mock server ----------

function parseSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    const f = { data: "" };
    for (const line of block.split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const k = line.slice(0, i), v = line.slice(i + 1).replace(/^ /, "");
      if (k === "data") f.data += v; else f[k] = v;
    }
    if (f.event) out.push(f);
  }
  return out;
}

// Reads the run like EventSource does: reconnect with Last-Event-ID until the server says 204.
async function readRun(base, id, query) {
  const store = createTraceStore();
  let last = 0, connections = 0, heartbeats = 0, completed = null;
  for (;;) {
    const res = await fetch(`${base}/runs/${id}/events?${query}`, { headers: last ? { "Last-Event-ID": String(last) } : {} });
    if (res.status === 204) break;
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    connections++;
    for (const f of parseSse(await res.text())) {
      if (f.event === "heartbeat") { heartbeats++; continue; }
      const evt = JSON.parse(f.data);
      assert.equal(+f.id, evt.seq);
      store.apply(evt);
      last = +f.id;
      if (evt.event === "run.completed") completed = evt;
    }
    assert.ok(connections < 1000, "runaway reconnects");
  }
  return { store, connections, heartbeats, completed };
}

test("mock server streams a run that folds to its final trace, across dropped connections", async () => {
  const server = createServer({ source: FINAL });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const { store, connections, heartbeats, completed } = await readRun(base, "e2e", "speed=20000&drop=40&jitter=1");
    assert.ok(connections > 5, `expected several reconnects, got ${connections}`);
    assert.ok(heartbeats >= connections, "each connection starts with a heartbeat");
    assert.equal(completed.final_url, "/runs/e2e/final");

    const final = await (await fetch(base + completed.final_url)).json();
    assert.equal(final.nodes.length, FINAL.nodes.length);
    assert.ok(Date.parse(final.created_at) > Date.parse(FINAL.created_at), "timestamps shifted to now");
    assert.deepEqual(normalized(store.snapshot()), normalized(final));

    assert.equal((await fetch(`${base}/runs/nope/final`)).status, 404);
    assert.equal((await fetch(`${base}/.git/config`)).status, 404);
    assert.equal((await fetch(`${base}/index.html`)).status, 200);
  } finally {
    server.close();
  }
});

test("final trace is not served while the run is in progress", async () => {
  const server = createServer({ source: FINAL });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/runs/slow/events?speed=1`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/runs/slow/final`)).status, 409);
    ctrl.abort();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
