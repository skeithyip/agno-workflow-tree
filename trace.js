// Adapts an Agno execution trace (window.FINAL_OUTPUT: flat nodes + root_ids) into the nested
// shape the tree view uses, and provides a generic replay that re-emits a node's stored events
// in timestamp order. Both the real trace and the synthetic stress dataset carry `events`, so
// one replay path serves both.
//
// Also holds the live stream contract, shared by the browser and mock-server.js (Node):
// traceToStream() turns a finished trace into the event stream a live run would send, and
// createTraceStore() folds that stream back into the FINAL_OUTPUT shape.
(function () {
  const ms = (iso) => (iso ? Date.parse(iso) : null);

  // One flat trace node -> one view node (children filled in by the caller).
  function viewNode(n) {
    return {
      type: n.type,
      name: n.name,
      traceId: n.node_id,
      status: n.status,
      model: n.model_name || n.model || "",
      model_name: n.model_name,
      started_at: n.started_at,
      completed_at: n.completed_at,
      metrics: n.metrics || null,
      events: n.messages || [],
      children: [],
    };
  }

  // Flat trace -> nested root. Each node keeps its status, model, metrics, timestamps and the
  // raw event records (messages) so the app can seed the view and replay from the same data.
  function buildWorkflowFromTrace(o) {
    const map = new Map(o.nodes.map((n) => [n.node_id, n]));
    function conv(n) {
      if (!n) return null;
      const v = viewNode(n);
      v.children = (n.children_ids || []).map((id) => conv(map.get(id))).filter(Boolean);
      return v;
    }
    const roots = (o.root_ids || []).map((id) => conv(map.get(id))).filter(Boolean);
    const root = roots.length === 1 ? roots[0] : { type: "workflow", name: o.workflow_id || "Workflow", children: roots, events: [] };
    // A live run has no totals until it completes.
    if (o.total_duration_seconds != null || o.total_cost != null) {
      root.totals = {
        cost: o.total_cost,
        duration_seconds: o.total_duration_seconds,
        input_tokens: o.total_input_tokens,
        output_tokens: o.total_output_tokens,
        trace_id: o.trace_id,
      };
    }
    return root;
  }

  // Event timestamp used for ordering and for node start/end.
  function eventTs(ev) {
    if (ev.type === "tool_start") return ms(ev.started_at);
    return ms(ev.completed_at) || ms(ev.started_at);
  }

  const lifeName = (node, phase) => `${node.type}.${phase}`;
  const isFailed = (status) => status === "failed" || status === "error";

  // Re-emit the whole tree's events (plus synthetic node started/finished markers) over time,
  // ordered by timestamp, so the batched-update path is exercised with real data.
  // `emit` is the app's ingest(); node ids are the app's internal ids (node.id).
  async function replayFromTree(root, emit, { fast = false } = {}) {
    const items = [];
    (function walk(node) {
      const start = ms(node.started_at);
      const end = ms(node.completed_at);
      if (start != null) items.push({ ts: start, evt: { node_id: node.id, event: lifeName(node, "started"), started_at: node.started_at } });
      (node.events || []).forEach((ev) => items.push({ ts: eventTs(ev) ?? start ?? 0, evt: { ...ev, node_id: node.id } }));
      if (end != null) {
        const phase = isFailed(node.status) ? "failed" : "completed";
        items.push({ ts: end, evt: { node_id: node.id, event: lifeName(node, phase), completed_at: node.completed_at } });
      }
      (node.children || []).forEach(walk);
    })(root);

    items.sort((a, b) => a.ts - b.ts);
    const t0 = items.length ? items[0].ts : 0;
    const span = items.length ? items[items.length - 1].ts - t0 : 0;
    // Compress the whole run into ~8s (or ~2s when fast), so replay is watchable regardless of trace length.
    const target = fast ? 2000 : 8000;
    const scale = span > 0 ? target / span : 0;

    let prev = t0;
    for (const it of items) {
      const wait = Math.min(400, Math.max(0, (it.ts - prev) * scale));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      prev = it.ts;
      emit(it.evt);
    }
  }

  // ---------- live stream ----------
  //
  // Each SSE message is `id: <seq>`, `event: trace`, and one JSON object as `data:`:
  //   { seq, event: "run.started",   run: { type, metadata, trace_id, created_at, session_id, workflow_id } }
  //   { seq, event: "<type>.started", node: { node_id, parent_id?, type, name, started_at, ...other node fields } }
  //   { seq, node_id, type: "reasoning" | "tool_start" | "tool_end" | "content", ... }  // a message, as in FINAL_OUTPUT
  //   { seq, event: "<type>.completed" | "<type>.failed", node: { node_id, status, completed_at, metrics? } }
  //   { seq, event: "run.completed", run: { completed_at, total_* }, final_url? }
  // plus `event: heartbeat` with { server_time_ms } every few seconds (no id).
  //
  // Steering messages are ordinary messages of type "human" on the agent they were sent to, so
  // they end up in that node's `messages` in FINAL_OUTPUT:
  //   { seq, node_id, type: "human", event: "human.message", message_id, client_msg_id?, author?, text, mode: "steer", started_at }
  //   { seq, node_id, type: "human", event: "human.delivered" | "human.expired", message_id, completed_at }
  // "delivered" means the agent read it (at its next turn); "expired" means it finished first.
  // They are sent with POST <events url minus /events>/messages (see mock-server.js).
  //
  // An agent can pause before a tool call to ask for approval ("confirm") or input ("input"):
  //   { seq, node_id, type: "pause", event: "pause.requested", pause_id, kind, prompt, tool_call_id, tool_name, tool_args?,
  //     fields?: [{ name, type: "string", description, required, default? }], started_at }
  //   { seq, event: "<type>.paused", node: { node_id, status: "paused" } }
  //   { seq, node_id, type: "pause", event: "pause.resolved", pause_id, decision: "approved" | "rejected" | "submitted",
  //     values?, note?, resolved_by?, completed_at }
  //   { seq, event: "<type>.continued", node: { node_id, status: "running" } }
  // Answered with POST <events url minus /events>/pauses/<pause_id>; the first answer wins.
  // `seq` increases by one per event so a reconnect can resume from Last-Event-ID.

  const NODE_FINAL_FIELDS = ["status", "completed_at", "metrics"];
  const NOT_IN_START = new Set(["messages", "children_ids", "event", ...NODE_FINAL_FIELDS]);
  const RUN_START_FIELDS = ["type", "metadata", "trace_id", "created_at", "session_id", "workflow_id"];

  // Finished trace -> [{ ts, evt }] in the order a live run would send them; ts is the time (ms)
  // the event happens. `jitter` sends some nodes' started events late, after their first message
  // or child, to exercise the store's buffering.
  function traceToStream(o, { jitter = false } = {}) {
    const items = [];
    let order = 0;
    const push = (ts, evt) => items.push({ ts, order: order++, evt });
    const byId = new Map(o.nodes.map((n) => [n.node_id, n]));
    const startOf = new Map();
    const t0 = ms(o.created_at) ?? Math.min(...o.nodes.map((n) => ms(n.started_at) ?? Infinity));
    let tEnd = t0;

    o.nodes.forEach((n) => {
      // A node never starts before its parent (o.nodes lists parents first).
      const start = Math.max(ms(n.started_at) ?? t0, startOf.get(n.parent_id) ?? -Infinity);
      startOf.set(n.node_id, start);
      const node = {};
      for (const k in n) if (!NOT_IN_START.has(k)) node[k] = n[k];
      push(start, { event: lifeName(n, "started"), node });

      let last = start;
      (n.messages || []).forEach((m) => {
        last = Math.max(last, eventTs(m) ?? last); // keep each node's messages in their recorded order
        push(last, { node_id: n.node_id, ...m });
      });

      if (n.status && n.status !== "running") {
        const end = Math.max(last, ms(n.completed_at) ?? last);
        const patch = { node_id: n.node_id };
        NODE_FINAL_FIELDS.forEach((k) => { if (n[k] !== undefined) patch[k] = n[k]; });
        push(end, { event: n.event || lifeName(n, isFailed(n.status) ? "failed" : "completed"), node: patch });
        tEnd = Math.max(tEnd, end);
      }
      tEnd = Math.max(tEnd, last);
    });

    items.sort((a, b) => a.ts - b.ts || a.order - b.order);

    if (jitter) {
      o.nodes.forEach((n, i) => {
        if (!n.parent_id || i % 2 === 0 || !byId.has(n.parent_id)) return;
        const from = items.findIndex((it) => it.evt.node && it.evt.node.node_id === n.node_id && it.evt.node.type);
        const next = items.findIndex((it, j) => j > from && (it.evt.node_id === n.node_id || (it.evt.node && it.evt.node.parent_id === n.node_id)));
        if (from < 0 || next < 0) return;
        const [it] = items.splice(from, 1);
        it.ts = items[next - 1].ts;
        items.splice(next, 0, it); // lands just after the event that now arrives first
      });
    }

    const run = {};
    RUN_START_FIELDS.forEach((k) => { if (o[k] !== undefined) run[k] = o[k]; });
    const done = {};
    for (const k in o) if (k === "completed_at" || k.startsWith("total_")) done[k] = o[k];

    const out = [{ ts: t0, evt: { event: "run.started", run } }, ...items];
    if (o.completed_at) out.push({ ts: Math.max(tEnd, ms(o.completed_at)), evt: { event: "run.completed", run: done } });
    return out.map((it, i) => ({ ts: it.ts, evt: { seq: i + 1, ...it.evt } }));
  }

  // Folds stream events into the FINAL_OUTPUT shape, tolerating events that arrive before the
  // node they belong to (held until it starts) and events seen twice after a reconnect (by seq).
  // Handlers: onRun(evt), onNodeAdd(node, evt), onNodeUpdate(node, evt), onMessage(node, evt).
  function createTraceStore(handlers = {}) {
    const trace = { nodes: [], root_ids: [] };
    const byId = new Map();
    const waiting = new Map(); // node_id -> events for a node that hasn't started yet
    const orphans = new Map(); // parent_id -> started events whose parent hasn't started yet
    let lastSeq = 0;
    const hold = (map, key, evt) => { if (!map.has(key)) map.set(key, []); map.get(key).push(evt); };

    function apply(evt) {
      if (evt.seq != null) {
        if (evt.seq <= lastSeq) return false;
        lastSeq = evt.seq;
      }
      if (evt.event === "run.started" || evt.event === "run.completed") {
        Object.assign(trace, evt.run);
        handlers.onRun?.(evt);
      } else if (evt.node) {
        applyNode(evt);
      } else if (evt.node_id) {
        applyMessage(evt);
      } else {
        return false;
      }
      return true;
    }

    function applyNode(evt) {
      const id = evt.node.node_id;
      const n = byId.get(id);
      if (n) {
        Object.assign(n, evt.node);
        n.event = evt.event;
        handlers.onNodeUpdate?.(n, evt);
      } else if (!evt.node.type) {
        hold(waiting, id, evt); // a patch (e.g. completed) for a node we haven't seen start
      } else if (evt.node.parent_id && !byId.has(evt.node.parent_id)) {
        hold(orphans, evt.node.parent_id, evt);
      } else {
        addNode(evt);
      }
    }

    function addNode(evt) {
      const n = { ...evt.node, event: evt.event };
      if (!n.status) n.status = "running";
      byId.set(n.node_id, n);
      trace.nodes.push(n);
      if (n.parent_id) {
        const p = byId.get(n.parent_id);
        (p.children_ids || (p.children_ids = [])).push(n.node_id);
      } else {
        trace.root_ids.push(n.node_id);
      }
      handlers.onNodeAdd?.(n, evt);
      const held = waiting.get(n.node_id);
      waiting.delete(n.node_id);
      (held || []).forEach((e) => (e.node ? applyNode(e) : applyMessage(e)));
      const kids = orphans.get(n.node_id);
      orphans.delete(n.node_id);
      (kids || []).forEach(addNode);
    }

    function applyMessage(evt) {
      const n = byId.get(evt.node_id);
      if (!n) { hold(waiting, evt.node_id, evt); return; }
      const { seq, node_id, ...m } = evt;
      (n.messages || (n.messages = [])).push(m);
      handlers.onMessage?.(n, evt);
    }

    return {
      apply,
      snapshot: () => trace,
      node: (id) => byId.get(id),
      get lastSeq() { return lastSeq; },
      get pending() { let c = 0; waiting.forEach((l) => (c += l.length)); orphans.forEach((l) => (c += l.length)); return c; },
    };
  }

  // Copy of a trace with every `*_at` timestamp passed through mapMs and durations scaled, so
  // the mock server can replay a recorded run as if it were happening now, sped up.
  function retimeTrace(o, mapMs, durScale = 1) {
    const DUR = new Set(["duration_seconds", "time_to_first_token", "total_duration_seconds"]);
    return (function walk(v, k) {
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === "object") {
        const r = {};
        for (const kk in v) r[kk] = walk(v[kk], kk);
        return r;
      }
      if (typeof v === "string" && k && k.endsWith("_at")) {
        const t = Date.parse(v);
        return isNaN(t) ? v : new Date(mapMs(t)).toISOString();
      }
      if (typeof v === "number" && DUR.has(k)) return v * durScale;
      return v;
    })(o);
  }

  const api = { viewNode, buildWorkflowFromTrace, replayFromTree, traceToStream, createTraceStore, retimeTrace };
  if (typeof window !== "undefined") Object.assign(window, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
