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

// ---------- steering ----------

// Reads an SSE response incrementally, calling onEvent(evt) for each trace event.
async function follow(url, onEvent) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const [f] = parseSse(buf.slice(0, i + 2));
      buf = buf.slice(i + 2);
      if (f && f.event === "trace") await onEvent(JSON.parse(f.data));
    }
  }
}

const post = (base, id, body, type = "application/json") =>
  fetch(`${base}/runs/${id}/messages`, { method: "POST", headers: { "Content-Type": type }, body: typeof body === "string" ? body : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test("steering: delivered at the next tool result, expired if the agent finishes, seen by every viewer", async () => {
  const server = createServer({ source: FINAL });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const byName = (name) => FINAL.nodes.find((n) => n.name === name).node_id;
  const collector = byName("Collector: Source Discovery"); // makes 100 tool calls
  const orchestrator = byName("Orchestrator");              // makes none: messages expire
  const step = byName("data_collection");
  const checks = {};
  try {
    assert.equal((await post(base, "nope", { targets: [collector], text: "hi" })).status, 404);

    const viewerA = [], viewerB = [];
    const url = `${base}/runs/steer/events?speed=200`;
    const a = follow(url, async (evt) => {
      viewerA.push(evt);
      if (evt.event === "agent.started" && evt.node.node_id === collector) {
        checks.ok = await post(base, "steer", { targets: [collector], text: "Prefer EU sources", client_msg_id: "c_1", author: "Tester" });
        checks.step = await post(base, "steer", { targets: [step], text: "x" });
        checks.empty = await post(base, "steer", { targets: [collector], text: "  " });
        checks.noTargets = await post(base, "steer", { targets: [], text: "x" });
        checks.unknown = await post(base, "steer", { targets: ["no-such-node"], text: "x" });
        checks.form = await post(base, "steer", "text=x", "application/x-www-form-urlencoded");
        checks.badJson = await post(base, "steer", "{", "application/json");
        checks.mode = await post(base, "steer", { targets: [collector], text: "x", mode: "interrupt" });
      }
      if (evt.event === "agent.started" && evt.node.node_id === orchestrator) {
        checks.late = await post(base, "steer", { targets: [orchestrator], text: "Wrap up quickly" });
        checks.finished = await post(base, "steer", { targets: [collector], text: "too late" });
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    const b = follow(url, (evt) => { viewerB.push(evt); });
    await Promise.all([a, b]);

    assert.equal(checks.ok.status, 202);
    assert.equal(checks.ok.body.messages[0].node_id, collector);
    assert.equal(checks.step.status, 422);
    assert.equal(checks.empty.status, 400);
    assert.equal(checks.noTargets.status, 400);
    assert.equal(checks.unknown.status, 404);
    assert.equal(checks.form.status, 415);
    assert.equal(checks.badJson.status, 400);
    assert.equal(checks.mode.status, 400);
    assert.equal(checks.late.status, 202);
    assert.equal(checks.finished.status, 409);
    assert.equal((await post(base, "steer", { targets: [orchestrator], text: "x" })).status, 409, "run finished");

    // Both viewers saw the same events with the same seq.
    assert.deepEqual(viewerB, viewerA);

    const human = viewerA.filter((e) => e.type === "human");
    const sent = human.find((e) => e.event === "human.message" && e.node_id === collector);
    assert.equal(sent.client_msg_id, "c_1");
    assert.equal(sent.author, "Tester");
    const delivered = human.find((e) => e.event === "human.delivered" && e.message_id === sent.message_id);
    assert.ok(delivered, "collector message delivered");
    const next = viewerA.slice(viewerA.indexOf(sent) + 1).find((e) => e.node_id === collector && e.type === "tool_end");
    assert.ok(next.seq < delivered.seq, "delivered right after the agent's next tool result");
    const expired = human.find((e) => e.event === "human.expired");
    assert.equal(expired.message_id, checks.late.body.messages[0].message_id);
    assert.equal(human.length, 4);

    // The final trace has the messages on their agents, and folding the stream rebuilds it.
    const final = await (await fetch(`${base}/runs/steer/final`)).json();
    const msgs = final.nodes.find((n) => n.node_id === collector).messages.filter((m) => m.type === "human");
    assert.deepEqual(msgs.map((m) => m.event), ["human.message", "human.delivered"]);
    assert.equal(msgs[0].node_id, undefined, "stored like other messages, without node_id or seq");
    assert.deepEqual(fold(viewerA).snapshot(), final);
    // ...and a finished trace with messages replays through traceToStream unchanged.
    assert.deepEqual(fold(traceToStream(final).map((it) => it.evt)).snapshot(), final);
  } finally {
    server.close();
  }
});

// ---------- pauses (approval and input) ----------

test("pauses: run waits for an answer; approve, submit input and reject each take effect", async () => {
  const server = createServer({ source: FINAL });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const answer = (pid, body, type) => fetch(`${base}/runs/hitl/pauses/${pid}`, { method: "POST", headers: { "Content-Type": type || "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const byName = (name) => FINAL.nodes.find((n) => n.name === name).node_id;
  const events = [];
  const seen = {};
  try {
    await follow(`${base}/runs/hitl/events?speed=400&pauses=1`, async (evt) => {
      events.push(evt);
      if (evt.event !== "pause.requested") return;
      const node = FINAL.nodes.find((n) => n.node_id === evt.node_id).name;
      seen[node] = evt;
      await new Promise((r) => setTimeout(r, 100)); // the run should hold while nobody answers

      if (node === "Collector: Source Discovery") {
        assert.equal(evt.kind, "confirm");
        assert.equal((await answer(evt.pause_id, { decision: "submit", values: {} })).status, 400, "confirm takes approve/reject");
        assert.equal((await answer(evt.pause_id, { decision: "approve" }, "text/plain")).status, 415);
        // A steering message to a paused agent is accepted and delivered after it continues.
        seen.msg = await post(base, "hitl", { targets: [evt.node_id], text: "Use recent data", author: "Tester" });
        assert.equal(seen.msg.status, 202);
        assert.equal((await answer(evt.pause_id, { decision: "approve", author: "Tester" })).status, 200);
        const again = await answer(evt.pause_id, { decision: "reject", author: "Other" });
        assert.equal(again.status, 409);
        assert.match(again.body.error, /Already approved by Tester/);
      } else if (node === "Expert: Trends") {
        assert.equal(evt.kind, "input");
        assert.equal(evt.fields[0].name, "source");
        assert.equal(evt.fields[0].default, "dataset-05");
        assert.equal((await answer(evt.pause_id, { decision: "submit", values: { source: " " } })).status, 400, "required");
        assert.equal((await answer(evt.pause_id, { decision: "submit", values: { source: "x", other: "y" } })).status, 400, "unknown field");
        assert.equal((await answer(evt.pause_id, { decision: "submit", values: { source: "dataset-99" }, note: "  newer  " })).status, 200);
      } else if (node === "Expert: Sentiment") {
        assert.equal(evt.kind, "confirm");
        assert.equal((await answer(evt.pause_id, { decision: "reject", note: "Not this one" })).status, 200);
      }
    });
    assert.deepEqual(Object.keys(seen).filter((k) => k !== "msg").sort(), ["Collector: Source Discovery", "Expert: Sentiment", "Expert: Trends"]);
    assert.equal((await answer("p_99", { decision: "approve" })).status, 404);

    const after = (pause) => events.slice(events.findIndex((e) => e.event === "pause.resolved" && e.pause_id === pause.pause_id));
    // Each pause flips the agent to paused and back, and nothing from the recorded run is sent
    // between the request and its answer (only the steering message we posted meanwhile).
    for (const p of [seen["Collector: Source Discovery"], seen["Expert: Trends"], seen["Expert: Sentiment"]]) {
      const i = events.indexOf(p);
      assert.deepEqual(events[i + 1].node, { node_id: p.node_id, status: "paused" });
      const j = events.findIndex((e) => e.event === "pause.resolved" && e.pause_id === p.pause_id);
      const during = events.slice(i + 2, j);
      assert.ok(during.every((e) => e.event === "human.message"), `sent while paused: ${during.map((e) => e.event || e.type)}`);
      assert.equal(events[j + 1].node.status, "running");
    }
    // Approved: the call runs. Input: its args carry the answer. Rejected: the call never runs.
    const starts = events.filter((e) => e.type === "tool_start");
    assert.ok(starts.some((e) => e.tool_call_id === seen["Collector: Source Discovery"].tool_call_id));
    assert.equal(starts.find((e) => e.tool_call_id === seen["Expert: Trends"].tool_call_id).tool_args.args.source, "dataset-99");
    assert.ok(!events.some((e) => e.tool_call_id === seen["Expert: Sentiment"].tool_call_id && e.type !== "pause"));
    const trendsResolved = after(seen["Expert: Trends"])[0];
    assert.deepEqual(trendsResolved.values, { source: "dataset-99" });
    assert.equal(trendsResolved.note, "newer");
    // The steering message wasn't expired by the pause.
    const mid = seen.msg.body.messages[0].message_id;
    assert.ok(events.some((e) => e.event === "human.delivered" && e.message_id === mid));
    // Timestamps stay in order across pauses (later events were shifted by the wait).
    const times = events.filter((e) => e.type === "tool_start").map((e) => Date.parse(e.started_at));
    times.forEach((t, i) => i && assert.ok(t >= times[i - 1]));

    const final = await (await fetch(`${base}/runs/hitl/final`)).json();
    assert.deepEqual(fold(events).snapshot(), final);
    assert.ok(final.nodes.every((n) => n.status === "completed"));
    assert.equal(final.nodes.find((n) => n.node_id === byName("Expert: Trends")).messages.filter((m) => m.type === "pause").length, 2);
  } finally {
    server.close();
  }
});
