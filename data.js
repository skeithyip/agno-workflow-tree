// Synthetic stress dataset, in the same shape as a trace built by buildWorkflowFromTrace:
// nested nodes carrying status, timestamps, model and `events` (reasoning / tool_start /
// tool_end / content) with ISO timestamps, so it drives the same seed and replay paths.
window.makeLargeWorkflow = function (steps = 60, agentsPerStep = 4, subAgents = 3) {
  let clock = Date.parse("2026-02-19T03:00:00Z");
  const tick = (sec) => new Date((clock += sec * 1000)).toISOString();
  let call = 0;

  function agentEvents() {
    const s0 = tick(0.1);
    const evs = [{ type: "reasoning", event: "reasoning.completed", text: "Assessing the task and deciding which tools to run.", started_at: s0, completed_at: tick(0.4) }];
    const n = 1 + (call % 2);
    for (let i = 0; i < n; i++) {
      const id = "call_" + ++call;
      const name = ["list_categories", "http_get", "browser_navigate", "grep"][call % 4];
      const st = tick(0.1);
      evs.push({ type: "tool_start", event: "tool.started", tool_call_id: id, tool_name: name, tool_args: { args: { target: "example" }, purpose: "stress test" }, started_at: st });
      const fail = call % 17 === 0;
      evs.push({ type: "tool_end", event: fail ? "tool.error" : "tool.completed", tool_call_id: id, tool_name: name, status: fail ? "failure" : "success", result: fail ? "error: denied" : "ok: 7 results", started_at: st, completed_at: tick(0.5) });
    }
    evs.push({ type: "content", event: "content.completed", text: "Summary of findings for this agent.", content_type: "str", started_at: tick(0.1), completed_at: tick(0.3) });
    return evs;
  }

  function agentNode(name, sub) {
    const start = tick(0.05);
    const events = agentEvents();
    const children = [];
    for (let b = 1; b <= sub; b++) children.push(agentNode(`${name}.${b}`, 0));
    return { type: "agent", name, status: "completed", model: "claude-sonnet-5-5", started_at: start, completed_at: tick(0.2), events, children };
  }

  const children = [];
  for (let s = 1; s <= steps; s++) {
    const start = tick(0.05);
    const agents = [];
    for (let a = 1; a <= agentsPerStep; a++) agents.push(agentNode(`Agent ${s}.${a}`, subAgents));
    const step = { type: "step", name: `Step ${s}`, status: "completed", started_at: start, completed_at: tick(0.1), events: [], children: agents };
    children.push(s % 10 === 0
      ? { type: "parallel", name: `Parallel block ${s / 10}`, status: "completed", started_at: start, completed_at: tick(0.1), events: [], children: [step] }
      : step);
  }
  return {
    type: "workflow", name: `Synthetic stress (${steps} steps)`, status: "completed",
    started_at: "2026-02-19T03:00:00Z", completed_at: tick(0), events: [], children,
  };
};
