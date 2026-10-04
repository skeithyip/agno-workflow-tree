// Adapts an Agno execution trace (window.FINAL_OUTPUT: flat nodes + root_ids) into the nested
// shape the tree view uses, and provides a generic replay that re-emits a node's stored events
// in timestamp order. Both the real trace and the synthetic stress dataset carry `events`, so
// one replay path serves both.
(function () {
  const ms = (iso) => (iso ? Date.parse(iso) : null);

  // Flat trace -> nested root. Each node keeps its status, model, metrics, timestamps and the
  // raw event records (messages) so the app can seed the view and replay from the same data.
  function buildWorkflowFromTrace(o) {
    const map = new Map(o.nodes.map((n) => [n.node_id, n]));
    function conv(n) {
      if (!n) return null;
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
        children: (n.children_ids || []).map((id) => conv(map.get(id))).filter(Boolean),
      };
    }
    const roots = (o.root_ids || []).map((id) => conv(map.get(id))).filter(Boolean);
    const root = roots.length === 1 ? roots[0] : { type: "workflow", name: o.workflow_id || "Workflow", children: roots, events: [] };
    root.totals = {
      cost: o.total_cost,
      duration_seconds: o.total_duration_seconds,
      input_tokens: o.total_input_tokens,
      output_tokens: o.total_output_tokens,
      trace_id: o.trace_id,
    };
    return root;
  }

  // Event timestamp used for ordering and for node start/end.
  function eventTs(ev) {
    if (ev.type === "tool_start") return ms(ev.started_at);
    return ms(ev.completed_at) || ms(ev.started_at);
  }

  const lifeName = (node, phase) => `${node.type}.${phase}`;

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
        const phase = node.status === "failed" || node.status === "error" ? "failed" : "completed";
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

  window.buildWorkflowFromTrace = buildWorkflowFromTrace;
  window.replayFromTree = replayFromTree;
})();
