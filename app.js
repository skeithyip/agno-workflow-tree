// Collapsible tree view for Agno workflow traces, with per-node events. Plain JS, no dependencies.
// Design goals (for remote browser isolation such as Menlo):
//  - children are only built when a group is first opened
//  - events are held in memory; the screen is only redrawn in batches (FLUSH_MS)
//  - the tree shows small badges; the full event timeline is drawn for the selected node only
//  - updates change existing elements in place, never re-render the tree
//
// Data: a trace is loaded by buildWorkflowFromTrace() (trace.js) into a nested root whose nodes
// carry status, timestamps, model, metrics and `events` (the raw message records). On load the
// view is seeded from that; "Replay events" re-emits those events over time through ingest().
(function () {
  const $ = (sel) => document.querySelector(sel);
  const treeEl = $("#tree");
  const panelEl = $("#panel");
  const crumbsEl = $("#crumbs");
  const statsEl = $("#stats");

  const ICON = { workflow: "◆", step: "▸", agent: "●", team: "◎", parallel: "∥", loop: "↻", condition: "?", router: "⇄" };
  const FLUSH_MS = 300;     // how often queued events are drawn
  const PANEL_LIMIT = 200;  // max timeline entries kept on screen

  let root;               // the nested workflow
  let index = new Map();  // internal id -> { node, parent }
  let byTraceId = new Map(); // trace node_id -> internal id (for live/replay events)
  let records = new Map();// internal id -> run state and entries (see newRecord)
  let entries = [];       // all timeline entries, in arrival order
  let focusId = null;     // when set, only this subtree is shown
  let selectedId = null;
  let includeChildren = false;
  let running = false;
  let seeding = false;
  let lastRenderMs = null;

  const dirty = new Set();
  let flushTimer = null;
  let eventCount = 0;
  let flushCount = 0;

  const newRecord = () => ({ status: "pending", start: null, end: null, tools: 0, toolErrors: 0, reasoning: 0, entries: [], open: {} });
  const ms = (iso) => (iso ? Date.parse(iso) : null);

  function mapStatus(s) {
    if (s === "completed" || s === "success" || s === "done") return "done";
    if (s === "failed" || s === "error" || s === "cancelled") return "failed";
    if (s === "running" || s === "in_progress") return "running";
    return "pending";
  }

  // ---------- data ----------

  function load(workflow) {
    root = workflow;
    index = new Map();
    byTraceId = new Map();
    focusId = null;
    selectedId = null;
    let n = 0;
    (function walk(node, parent) {
      node.id = "n" + n++;
      index.set(node.id, { node, parent });
      if (node.traceId) byTraceId.set(node.traceId, node.id);
      (node.children || []).forEach((c) => walk(c, node));
    })(root, null);

    resetRun();
    seedFromTrace();
    renderHeader();
    render({ openDepth: index.size > 200 ? 1 : 4 });
    showPanel(null);
    resetTrace();
  }

  function resetRun() {
    records = new Map();
    index.forEach((_, id) => records.set(id, newRecord()));
    entries = [];
    eventCount = 0;
    flushCount = 0;
  }

  // Seed the view from a finished trace: feed each node's stored events through ingest, then set
  // authoritative status and timing from the node itself.
  function seedFromTrace() {
    seeding = true;
    index.forEach(({ node }, id) => {
      (node.events || []).forEach((ev) => ingest({ ...ev, node_id: id }));
    });
    index.forEach(({ node }, id) => {
      const rec = records.get(id);
      rec.status = mapStatus(node.status);
      rec.start = ms(node.started_at);
      rec.end = ms(node.completed_at);
    });
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    dirty.clear();
    seeding = false;
  }

  function pathTo(id) {
    const path = [];
    for (let e = index.get(id); e; e = e.parent && index.get(e.parent.id)) path.unshift(e.node);
    return path;
  }

  function isUnder(id, ancestorId) {
    for (let e = index.get(id); e; e = e.parent && index.get(e.parent.id)) if (e.node.id === ancestorId) return true;
    return false;
  }

  function countDescendants(node) {
    let c = 0;
    (node.children || []).forEach((k) => { c += 1 + countDescendants(k); });
    return c;
  }

  // ---------- events in ----------

  // Which internal node an event belongs to. Replay/seed pass the internal id directly; a real
  // live stream would carry the trace node_id (or step/agent name), mapped here.
  function nodeIdFor(evt) {
    const raw = evt.node_id;
    if (raw && records.has(raw)) return raw;        // internal id
    if (raw && byTraceId.has(raw)) return byTraceId.get(raw); // trace uuid
    return undefined;
  }

  function addEntry(id, entry) {
    entry.uid = entries.length;
    entry.nodeId = id;
    entry.ver = 0;
    entries.push(entry);
    records.get(id).entries.push(entry);
    return entry;
  }

  // Single entry point for every event. Mutates memory only; drawing happens in flush().
  // Understands the trace vocabulary: type in {reasoning, tool_start, tool_end, content};
  // node lifecycle via evt.event suffix (started / completed / failed / error).
  function ingest(evt) {
    const id = nodeIdFor(evt);
    const rec = id && records.get(id);
    if (!rec) return;
    eventCount++;
    const t = evt.type;

    if (t === "reasoning") {
      // trace emits a single completed reasoning block; support live started/step too.
      if (evt.event === "reasoning.started") {
        rec.reasoning++;
        rec.open.reasoning = addEntry(id, { kind: "reasoning", steps: [], done: false, start: ms(evt.started_at), ts: ms(evt.started_at) });
      } else if (evt.event === "reasoning.step") {
        const e = rec.open.reasoning || (rec.reasoning++, rec.open.reasoning = addEntry(id, { kind: "reasoning", steps: [], done: false, ts: ms(evt.started_at) }));
        e.steps.push(evt.text || ""); e.ver++;
      } else {
        const e = rec.open.reasoning;
        if (e) { if (evt.text) e.steps.push(evt.text); e.done = true; e.end = ms(evt.completed_at); e.ver++; rec.open.reasoning = null; }
        else { rec.reasoning++; addEntry(id, { kind: "reasoning", steps: evt.text ? [evt.text] : [], done: true, start: ms(evt.started_at), end: ms(evt.completed_at), ts: ms(evt.completed_at || evt.started_at) }); }
      }
    } else if (t === "tool_start") {
      rec.tools++;
      rec.open["tool:" + evt.tool_call_id] = addEntry(id, {
        kind: "tool", name: evt.tool_name, callId: evt.tool_call_id, args: evt.tool_args, status: "running",
        start: ms(evt.started_at), ts: ms(evt.started_at),
      });
    } else if (t === "tool_end") {
      const failed = evt.event === "tool.error" || evt.status === "failure" || evt.status === "error";
      const e = rec.open["tool:" + evt.tool_call_id];
      if (e) {
        e.status = failed ? "failed" : "done";
        e.result = evt.result; e.end = ms(evt.completed_at); e.ver++;
        delete rec.open["tool:" + evt.tool_call_id];
      } else {
        addEntry(id, { kind: "tool", name: evt.tool_name, callId: evt.tool_call_id, args: null, status: failed ? "failed" : "done", result: evt.result, start: ms(evt.started_at), end: ms(evt.completed_at), ts: ms(evt.completed_at) });
      }
      if (failed) rec.toolErrors++;
    } else if (t === "content") {
      const structured = evt.content_type && evt.content_type !== "str" ? evt.data : null;
      addEntry(id, { kind: "content", text: evt.text || "", data: structured, contentType: evt.content_type, ts: ms(evt.completed_at || evt.started_at) });
    } else if (typeof evt.event === "string") {
      const suf = evt.event.split(".").pop();
      if (suf === "started") { if (rec.status === "pending") rec.status = "running"; rec.start = rec.start || ms(evt.started_at); }
      else if (suf === "error" || suf === "failed") { rec.status = "failed"; rec.end = ms(evt.completed_at) || Date.now(); if (evt.error) addEntry(id, { kind: "error", text: evt.error, ts: Date.now() }); }
      else if (suf === "completed") { if (rec.status !== "failed") rec.status = "done"; rec.end = ms(evt.completed_at) || Date.now(); rec.open = {}; }
    }

    dirty.add(id);
    if (!seeding && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  // Draw everything that changed since the last flush.
  function flush() {
    flushTimer = null;
    flushCount++;
    dirty.forEach(updateRow);
    if (view === "trace") refreshTrace(dirty);
    else if (selectedId && [...dirty].some((id) => id === selectedId || (includeChildren && isUnder(id, selectedId)))) {
      renderPanelLive();
    }
    dirty.clear();
    updateStats();
  }

  // ---------- header ----------

  function renderHeader() {
    const t = root.totals;
    if (!t) { $("#crumbs").dataset.totals = ""; return; }
  }

  // ---------- tree ----------

  function render(opts = {}) {
    const t0 = performance.now();
    const viewRoot = focusId ? index.get(focusId).node : root;
    treeEl.replaceChildren(buildNode(viewRoot, 0, opts));
    renderCrumbs();
    lastRenderMs = (performance.now() - t0).toFixed(1);
    updateStats();
  }

  function buildNode(node, depth, opts) {
    const li = document.createElement("li");
    li.setAttribute("role", "treeitem");
    const row = buildRow(node, opts);
    const kids = node.children || [];

    if (!kids.length) {
      row.classList.add("leaf");
      li.append(row);
      return li;
    }

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.append(row);
    details.append(summary);

    const fill = () => {
      if (details.dataset.built) return;
      details.dataset.built = "1";
      const ul = document.createElement("ul");
      ul.setAttribute("role", "group");
      kids.forEach((k) => ul.append(buildNode(k, depth + 1, opts)));
      details.append(ul);
    };

    const open = opts.openAll || (opts.openIds ? opts.openIds.has(node.id) : depth < (opts.openDepth ?? 1));
    if (open) { fill(); details.open = true; }
    details.addEventListener("toggle", () => { if (details.open) { fill(); updateStats(); } });

    li.append(details);
    return li;
  }

  function buildRow(node, opts) {
    const rec = records.get(node.id);
    const row = document.createElement("div");
    row.className = `node st-${rec.status}`;
    row.dataset.id = node.id;
    if (node.id === selectedId) row.classList.add("selected");
    if (opts.hits && opts.hits.has(node.id)) row.classList.add("hit");

    const meta = node.model || node.evaluator || node.selector || node.endCondition || node.mode || "";
    const kids = node.children || [];
    row.innerHTML =
      `<span class="chev">›</span><span class="dot" title="status"></span>` +
      `<span class="type t-${node.type}">${ICON[node.type] || ""} ${node.type}</span>` +
      `<span class="name"></span>` +
      (meta ? `<span class="meta"></span>` : "") +
      `<span class="badges">${badgesHtml(rec)}</span>` +
      (kids.length ? `<span class="count" title="nodes inside">${countDescendants(node)}</span>` : "");
    row.querySelector(".name").textContent = node.name;
    if (meta) row.querySelector(".meta").textContent = meta;

    if (kids.length && node !== root && node.id !== focusId) {
      const btn = document.createElement("button");
      btn.className = "focus";
      btn.textContent = "Focus";
      btn.title = "Show only this group";
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setFocus(node.id); });
      row.append(btn);
    }
    return row;
  }

  // Badges hold only numbers and fixed symbols, so innerHTML is safe here.
  function badgesHtml(rec) {
    let h = "";
    if (rec.reasoning) h += `<span class="b" title="reasoning blocks">💭</span>`;
    if (rec.tools) h += `<span class="b" title="tool calls">🔧${rec.tools}</span>`;
    if (rec.toolErrors) h += `<span class="b err" title="failed tool calls">⚠${rec.toolErrors}</span>`;
    if (rec.start && rec.end) h += `<span class="b dur">${fmtDur(rec.end - rec.start)}</span>`;
    return h;
  }

  function updateRow(id) {
    const el = treeEl.querySelector(`.node[data-id="${id}"]`); // null if not rendered yet; fine
    if (!el) return;
    const rec = records.get(id);
    el.className = el.className.replace(/st-\w+/, "st-" + rec.status);
    const html = badgesHtml(rec);
    const b = el.querySelector(".badges");
    if (b.innerHTML !== html) b.innerHTML = html;
  }

  function renderCrumbs() {
    crumbsEl.replaceChildren();
    if (!focusId) {
      const t = root.totals;
      if (t) {
        const span = document.createElement("span");
        span.className = "muted";
        span.textContent = `${root.name} · ${fmtDur((t.duration_seconds || 0) * 1000)} · $${(t.cost || 0).toFixed(2)} · ${fmtTokens((t.input_tokens || 0) + (t.output_tokens || 0))} tokens`;
        crumbsEl.append(span);
      }
      return;
    }
    pathTo(focusId).forEach((n, i, arr) => {
      if (i) crumbsEl.append(" › ");
      if (i === arr.length - 1) { crumbsEl.append(n.name); return; }
      const a = document.createElement("a");
      a.textContent = n.name;
      a.addEventListener("click", () => setFocus(n === root ? null : n.id));
      crumbsEl.append(a);
    });
  }

  function setFocus(id) {
    focusId = id;
    render({ openDepth: 2 });
    if (view === "trace") { buildSpans(); traceOpen.add(spanRoot.id); renderTrace(); }
  }

  function updateStats() {
    if (view === "trace") { updateTraceStats(); return; }
    const rendered = treeEl.querySelectorAll(".node").length;
    const els = document.getElementsByTagName("*").length;
    statsEl.textContent =
      `${index.size} nodes in workflow · ${rendered} rendered · ${els} DOM elements on page` +
      (lastRenderMs ? ` · last full render ${lastRenderMs} ms` : "") +
      ` · ${eventCount} events` + (flushCount ? ` · ${flushCount} screen updates` : "");
  }

  // ---------- details panel ----------

  let panelEls = new Map(); // entry uid -> element currently shown

  function showPanel(id) {
    treeEl.querySelectorAll(".node.selected").forEach((el) => el.classList.remove("selected"));
    selectedId = id;
    panelEls = new Map();
    if (!id) { panelEl.innerHTML = `<p class="muted">Select a node to see its details and events.</p>`; return; }
    treeEl.querySelector(`.node[data-id="${id}"]`)?.classList.add("selected");

    const node = index.get(id).node;
    const h = document.createElement("h2");
    h.textContent = node.name;
    const sub = document.createElement("p");
    sub.className = "sub";

    const info = document.createElement("details");
    info.className = "info";
    info.innerHTML = "<summary>Node info</summary>";
    info.append(infoDl(node, id));

    const head = document.createElement("div");
    head.className = "tl-head";
    head.innerHTML = `<strong>Events</strong>`;
    if (node.children && node.children.length) {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox"> Include child nodes`;
      const cb = label.querySelector("input");
      cb.checked = includeChildren;
      cb.addEventListener("change", () => { includeChildren = cb.checked; showPanel(selectedId); });
      head.append(label);
    }

    const hidden = document.createElement("p");
    hidden.className = "hidden-note muted";
    const tl = document.createElement("div");
    tl.className = "timeline";

    panelEl.replaceChildren(h, sub, info, head, hidden, tl);
    renderPanelLive();
    tl.scrollTop = 0; // start at the first event; live updates still stick to the bottom
  }

  function infoDl(node, id) {
    const dl = document.createElement("dl");
    const add = (k, v) => {
      if (v == null || v === "") return;
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    };
    add("type", node.type);
    add("model", node.model_name || node.model);
    const m = node.metrics;
    if (m) {
      if (m.duration_seconds != null) add("duration", fmtDur(m.duration_seconds * 1000));
      if (m.cost != null) add("cost", "$" + m.cost.toFixed(4));
      if (m.total_tokens != null) add("tokens", `${fmtTokens(m.input_tokens)} in / ${fmtTokens(m.output_tokens)} out`);
      if (m.time_to_first_token != null) add("time to first token", fmtDur(m.time_to_first_token * 1000));
    }
    add("started", node.started_at);
    add("completed", node.completed_at);
    add("path", pathTo(id).map((x) => x.name).join(" › "));
    add("trace id", node.traceId);
    return dl;
  }

  function renderPanelLive() {
    const rec = records.get(selectedId);
    const node = index.get(selectedId).node;
    panelEl.querySelector(".sub").innerHTML =
      `<span class="type t-${node.type}">${node.type}</span> <span class="pill st-${rec.status}"><span class="dot"></span>${rec.status}</span>` +
      (rec.start && rec.end ? ` <span class="muted">${fmtDur(rec.end - rec.start)}</span>` : "");

    let list = includeChildren ? entries.filter((e) => isUnder(e.nodeId, selectedId)) : rec.entries;
    if (includeChildren) list = list.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.uid - b.uid);
    const visible = list.slice(-PANEL_LIMIT);
    const tl = panelEl.querySelector(".timeline");
    const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 40;

    panelEl.querySelector(".hidden-note").textContent =
      list.length > visible.length ? `${list.length - visible.length} earlier events not shown` : "";

    const keep = new Set(visible.map((e) => e.uid));
    panelEls.forEach((el, uid) => { if (!keep.has(uid)) { el.remove(); panelEls.delete(uid); } });

    if (!visible.length) {
      tl.innerHTML = `<p class="muted empty">No events for this node.</p>`;
      return;
    }
    tl.querySelector(".empty")?.remove();

    let prev = null;
    for (const e of visible) {
      let el = panelEls.get(e.uid);
      if (!el) {
        el = createEntryEl(e);
        panelEls.set(e.uid, el);
        if (prev) prev.after(el); else tl.prepend(el);
      } else if (+el.dataset.ver === e.ver) { prev = el; continue; }
      patchEntryEl(el, e);
      prev = el;
    }
    if (atBottom) tl.scrollTop = tl.scrollHeight;
  }

  // Collapsible entries (reasoning, tool calls, structured output) only show a summary line
  // until opened; their body is built on first open and kept in sync while open.
  function createEntryEl(e) {
    let el;
    if (e.kind === "reasoning" || e.kind === "tool" || (e.kind === "content" && e.data)) {
      el = document.createElement("details");
      el.innerHTML = `<summary></summary><div class="ev-body"></div>`;
      el.addEventListener("toggle", () => {
        if (el.open && el.dataset.stale) fillBody(el, entries[+el.dataset.uid]);
      });
    } else {
      el = document.createElement("div");
    }
    el.className = `ev ev-${e.kind}`;
    el.dataset.uid = e.uid;
    return el;
  }

  function who(e) {
    if (e.nodeId === selectedId) return "";
    return `<span class="who">${escapeHtml(index.get(e.nodeId).node.name)}</span>`;
  }

  function patchEntryEl(el, e) {
    el.dataset.ver = e.ver;
    if (e.kind === "reasoning") {
      el.querySelector("summary").innerHTML =
        `${who(e)}💭 Reasoning <span class="muted">· ${e.steps.length} step${e.steps.length === 1 ? "" : "s"}${e.done ? "" : " …"}</span>`;
    } else if (e.kind === "tool") {
      el.classList.toggle("failed", e.status === "failed");
      const state = e.status === "running" ? `<span class="pill st-running"><span class="dot"></span>running</span>`
        : e.status === "failed" ? `<span class="pill st-failed"><span class="dot"></span>error</span>`
        : `<span class="pill st-done"><span class="dot"></span>${e.end && e.start ? fmtDur(e.end - e.start) : "done"}</span>`;
      el.querySelector("summary").innerHTML = `${who(e)}🔧 <code>${escapeHtml(e.name || "tool")}</code> ${state}`;
    } else if (e.kind === "content" && e.data) {
      el.querySelector("summary").innerHTML = `${who(e)}📦 structured output <span class="muted">· ${escapeHtml(e.contentType)}</span>`;
    } else if (e.kind === "error") {
      el.innerHTML = who(e) + `⚠ <span class="txt"></span>`;
      el.querySelector(".txt").textContent = e.text;
      return;
    } else {
      el.innerHTML = who(e) + `<span class="txt"></span>`;
      el.querySelector(".txt").textContent = e.text;
      return;
    }
    if (el.open) fillBody(el, e);
    else el.dataset.stale = "1";
  }

  function fillBody(el, e) {
    delete el.dataset.stale;
    const body = el.querySelector(".ev-body");
    if (e.kind === "reasoning") {
      for (let i = body.children.length; i < e.steps.length; i++) {
        const p = document.createElement("p");
        p.textContent = e.steps[i];
        body.append(p);
      }
    } else if (e.kind === "tool") {
      body.innerHTML = (e.args != null ? `<div class="k">args</div><pre></pre>` : "") + (e.result !== undefined ? `<div class="k">result</div><pre></pre>` : "");
      const pres = body.querySelectorAll("pre");
      let pi = 0;
      if (e.args != null) pres[pi++].textContent = fmtVal(e.args);
      if (e.result !== undefined) pres[pi].textContent = fmtVal(e.result);
    } else {
      body.innerHTML = (e.text ? `<p class="txt"></p>` : "") + `<pre></pre>`;
      if (e.text) body.querySelector(".txt").textContent = e.text;
      body.querySelector("pre").textContent = fmtVal(e.data);
    }
  }

  treeEl.addEventListener("click", (e) => {
    const row = e.target.closest(".node");
    if (!row) return;
    if (!e.target.closest(".chev")) e.preventDefault(); // click row = select; chevron = expand
    if (row.dataset.id !== selectedId) showPanel(row.dataset.id);
  });

  // ---------- trace view ----------
  // A second, tracing-style view of the same records: every node plus each tool call, reasoning
  // block and error as a span, listed as an indented tree beside a waterfall of timing bars, with
  // a detail pane (Input / Output / Metadata). The list is virtualized: rows have a fixed height
  // and only those in or near the viewport are in the DOM, so large runs stay cheap to draw.

  const ROW_H = 28;          // must match .span height in styles.css
  const OVERSCAN = 8;        // extra rows drawn above and below the viewport
  const MAX_CHARS = 20000;   // longer values are cut until "Show all" is clicked
  const LEAF_ICON = { tool: "🔧", reasoning: "💭", error: "⚠" };

  const treeViewEl = $("#treeView");
  const traceViewEl = $("#traceView");
  const spanScroll = $("#spanScroll");
  const spanCanvas = $("#spanCanvas");
  const axisEl = $("#axis");
  const spanPanel = $("#spanPanel");

  let view = "tree";
  let spans = new Map();     // span id -> span (rebuilt from records on each refresh)
  let spanRoot = null;
  let rows = [];             // spans currently shown, in display order
  let win = { t0: 0, t1: 1 };// time window the waterfall is scaled to
  let traceOpen = new Set(); // expanded span ids (node ids, so they survive rebuilds)
  let traceSel = null;
  let traceHits = null;
  let errorsOnly = false;
  let detailTab = "output";
  let fullShown = new Set(); // "spanId:tab:section" keys whose value is shown uncut

  function resetTrace() {
    traceSel = null;
    traceHits = null;
    spanRoot = null;
    spans = new Map();
    rows = [];
    fullShown = new Set();
    traceOpen = new Set();
    const depthLimit = index.size > 200 ? 1 : 4;
    (function walk(node, d) {
      if (d < depthLimit) traceOpen.add(node.id);
      (node.children || []).forEach((k) => walk(k, d + 1));
    })(root, 0);
    spanScroll.scrollTop = 0;
    if (view === "trace") renderTrace();
  }

  // Records -> span tree. Leaf ids are stable across replays (tool call id, or node + ordinal)
  // so the selection and "show all" state survive a replay.
  function buildSpans() {
    spans = new Map();
    let tMin = Infinity, tMax = -Infinity;
    const see = (t) => { if (t != null) { tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); } };

    function nodeSpan(node, depth, parent) {
      const rec = records.get(node.id);
      const s = { id: node.id, kind: "node", node, nodeId: node.id, depth, parent, name: node.name, status: rec.status, start: rec.start, end: rec.end, children: [] };
      spans.set(s.id, s);
      see(s.start); see(s.end);
      const kids = (node.children || []).map((k) => nodeSpan(k, depth + 1, s));
      const n = { tool: 0, reasoning: 0, error: 0 };
      rec.entries.forEach((e) => {
        if (!(e.kind in n)) return; // content is shown as the node's Output
        let id = e.kind === "tool" && e.callId ? "t:" + e.callId : `${node.id}:${e.kind}${n[e.kind]}`;
        n[e.kind]++;
        if (spans.has(id)) id += "#" + e.uid;
        const leaf = {
          id, kind: e.kind, entry: e, nodeId: node.id, depth: depth + 1, parent: s, children: [],
          name: e.kind === "tool" ? e.name || "tool" : e.kind === "reasoning" ? "Reasoning" : "Error",
          status: e.kind === "tool" ? e.status : e.kind === "reasoning" ? (e.done ? "done" : "running") : "failed",
          start: e.start ?? e.ts ?? null,
          end: e.end ?? (e.kind === "error" ? e.ts : null),
        };
        spans.set(id, leaf);
        see(leaf.start); see(leaf.end);
        kids.push(leaf);
      });
      kids.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
      s.children = kids;
      s.hasError = s.status === "failed" || kids.some((k) => k.hasError || k.status === "failed");
      kids.forEach((k) => { if (k.hasError === undefined) k.hasError = k.status === "failed"; });
      return s;
    }

    spanRoot = nodeSpan(focusId ? index.get(focusId).node : root, 0, null);
    const t0 = spanRoot.start ?? tMin;
    const t1 = Math.max(tMax, spanRoot.end ?? -Infinity);
    win = isFinite(t0) && isFinite(t1) && t1 > t0 ? { t0, t1 } : { t0: isFinite(t0) ? t0 : 0, t1: (isFinite(t0) ? t0 : 0) + 1 };
  }

  const isOpen = (s) => errorsOnly || traceOpen.has(s.id);

  function flattenRows() {
    rows = [];
    (function walk(s) {
      if (errorsOnly && !s.hasError) return;
      rows.push(s);
      if (s.children.length && isOpen(s)) s.children.forEach(walk);
    })(spanRoot);
  }

  function renderTrace({ rebuild = true } = {}) {
    if (rebuild || !spanRoot) buildSpans();
    flattenRows();
    spanCanvas.style.height = rows.length * ROW_H + "px";
    renderAxis();
    renderWindow();
    renderSummary();
    renderDetail();
    updateStats();
  }

  // Called from flush() while the trace view is showing.
  function refreshTrace(dirtyIds) {
    buildSpans();
    flattenRows();
    spanCanvas.style.height = rows.length * ROW_H + "px";
    renderAxis();
    renderWindow();
    renderSummary();
    const sel = traceSel && spans.get(traceSel);
    if (!traceSel || !sel || dirtyIds.has(sel.nodeId)) renderDetail();
  }

  function renderAxis() {
    const span = win.t1 - win.t0;
    axisEl.innerHTML = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => `<span style="left:${f * 100}%">${spanRoot && spanRoot.start != null ? fmtDur(f * span) || "0ms" : ""}</span>`)
      .join("");
  }

  function renderSummary() {
    let errs = 0;
    spans.forEach((s) => { if (s.status === "failed") errs++; });
    $("#traceSummary").textContent = `${spans.size} spans · ${errs} error${errs === 1 ? "" : "s"}`;
    $("#traceSummary").classList.toggle("has-err", errs > 0);
  }

  function renderWindow() {
    if (!rows.length) {
      spanCanvas.innerHTML = `<p class="muted empty">${errorsOnly ? "No errors in this run." : "Nothing to show."}</p>`;
      return;
    }
    const headH = spanScroll.firstElementChild.offsetHeight;
    const top = Math.max(0, spanScroll.scrollTop - headH);
    const a = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const b = Math.min(rows.length, Math.ceil((top + spanScroll.clientHeight) / ROW_H) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) frag.append(spanRow(rows[i], i));
    spanCanvas.replaceChildren(frag);
  }

  function spanRow(s, i) {
    const row = document.createElement("div");
    const open = s.children.length ? isOpen(s) : null;
    row.className = `span st-${s.status}` + (s.id === traceSel ? " selected" : "") + (traceHits && traceHits.has(s.id) ? " hit" : "");
    row.style.top = i * ROW_H + "px";
    row.dataset.id = s.id;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", s.depth + 1);
    row.setAttribute("aria-selected", s.id === traceSel);
    if (open !== null) row.setAttribute("aria-expanded", open);
    const dur = s.start != null && s.end != null ? fmtDur(s.end - s.start) : s.status === "running" ? "…" : "";
    row.innerHTML =
      `<div class="span-name" style="padding-left:${s.depth * 14}px">` +
        `<span class="chev${open ? " open" : ""}">${open !== null ? "›" : ""}</span><span class="dot"></span>` +
        spanTag(s) + `<span class="name"></span>` +
      `</div><div class="span-dur">${dur}</div><div class="span-bar-cell">${barHtml(s)}</div>`;
    row.querySelector(".name").textContent = s.name;
    row.title = s.name;
    return row;
  }

  function spanTag(s) {
    if (s.kind === "node") return `<span class="type t-${s.node.type}">${ICON[s.node.type] || ""} ${s.node.type}</span>`;
    return `<span class="leaf-ico" aria-label="${s.kind}">${LEAF_ICON[s.kind]}</span>`;
  }

  function barHtml(s) {
    if (s.start == null) return "";
    const span = win.t1 - win.t0;
    const end = s.end ?? (s.status === "running" ? win.t1 : s.start);
    const left = Math.min(100, Math.max(0, ((s.start - win.t0) / span) * 100));
    const width = Math.min(100 - left, Math.max(0, ((end - s.start) / span) * 100));
    const cls = s.kind === "node" ? `k-node t-${s.node.type}` : `k-${s.kind}`;
    return `<span class="wf-bar ${cls}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></span>`;
  }

  function ensureVisible(i) {
    if (i < 0) return;
    const headH = spanScroll.firstElementChild.offsetHeight;
    const rowTop = headH + i * ROW_H;
    if (rowTop < spanScroll.scrollTop + headH) spanScroll.scrollTop = rowTop - headH;
    else if (rowTop + ROW_H > spanScroll.scrollTop + spanScroll.clientHeight) spanScroll.scrollTop = rowTop + ROW_H - spanScroll.clientHeight;
    renderWindow();
  }

  function selectSpan(id, scroll) {
    traceSel = id;
    const s = spans.get(id);
    if (s) selectedId = s.nodeId; // keeps the tree view's selection in step
    spanCanvas.querySelectorAll(".span.selected").forEach((el) => { el.classList.remove("selected"); el.setAttribute("aria-selected", "false"); });
    const el = spanCanvas.querySelector(`.span[data-id="${CSS.escape(id)}"]`);
    if (el) { el.classList.add("selected"); el.setAttribute("aria-selected", "true"); }
    if (scroll) ensureVisible(rows.indexOf(s));
    renderDetail();
  }

  function step(d) {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.id === traceSel);
    const n = i < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + d));
    selectSpan(rows[n].id, true);
  }

  function toggleSpan(s, open = !traceOpen.has(s.id)) {
    if (errorsOnly || !s.children.length) return;
    if (open) traceOpen.add(s.id); else traceOpen.delete(s.id);
    renderTrace({ rebuild: false });
  }

  function openAncestors(id) {
    for (let s = spans.get(id)?.parent; s; s = s.parent) traceOpen.add(s.id);
  }

  function setAllOpen(open) {
    if (!spanRoot) buildSpans();
    traceOpen = new Set([spanRoot.id]);
    if (open) spans.forEach((s) => { if (s.kind === "node" && s.children.length) traceOpen.add(s.id); });
    renderTrace({ rebuild: false });
  }

  function searchTrace(q) {
    if (!spanRoot) buildSpans();
    traceHits = null;
    if (q) {
      traceHits = new Set();
      spans.forEach((s) => {
        if (s.name.toLowerCase().includes(q) || (s.node && (s.node.model || "").toLowerCase().includes(q))) {
          traceHits.add(s.id);
          openAncestors(s.id);
        }
      });
    }
    renderTrace({ rebuild: false });
    if (traceHits) ensureVisible(rows.findIndex((r) => traceHits.has(r.id)));
  }

  // ----- detail pane -----

  function inputOf(s) {
    if (s.kind === "tool") return s.entry.args != null ? [{ label: "Arguments", value: s.entry.args }] : [];
    return [];
  }

  function outputOf(s) {
    const e = s.entry;
    if (s.kind === "tool") return e.result !== undefined ? [{ label: s.status === "failed" ? "Error" : "Result", value: e.result }] : [];
    if (s.kind === "reasoning") return e.steps.length ? [{ label: "Reasoning", value: e.steps.join("\n\n") }] : [];
    if (s.kind === "error") return [{ label: "Error", value: e.text }];
    const out = [];
    records.get(s.nodeId).entries.forEach((c) => {
      if (c.kind === "error") out.push({ label: "Error", value: c.text });
      if (c.kind !== "content") return;
      if (c.text) out.push({ label: "Response", value: c.text });
      if (c.data) out.push({ label: `Structured output · ${c.contentType}`, value: c.data });
    });
    return out;
  }

  function emptyNote(s, tab) {
    if (tab === "input") {
      if (s.kind === "tool") return "No arguments were recorded for this call.";
      if (s.kind === "node") return `This trace doesn't record inputs for ${s.node.type} spans.`;
      return `${s.kind === "reasoning" ? "Reasoning" : "An error"} has no separate input; see Output.`;
    }
    if (s.status === "running") return "Still running…";
    return s.kind === "node" && s.children.length ? "No output recorded for this span itself; select a child span." : "No output recorded.";
  }

  function metaDl(s) {
    if (s.kind === "node") {
      const dl = infoDl(s.node, s.nodeId);
      const rec = records.get(s.nodeId);
      const add = (k, v) => { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); };
      add("status", rec.status);
      if (s.start != null) add("offset", "+" + (fmtDur(s.start - win.t0) || "0ms"));
      add("tool calls", rec.tools + (rec.toolErrors ? ` (${rec.toolErrors} failed)` : ""));
      add("reasoning blocks", rec.reasoning);
      add("child nodes", (s.node.children || []).length);
      return dl;
    }
    const dl = document.createElement("dl");
    const add = (k, v) => {
      if (v == null || v === "") return;
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    };
    const iso = (t) => (t != null ? new Date(t).toISOString() : null);
    add("kind", s.kind === "tool" ? "tool call" : s.kind);
    if (s.kind === "tool") add("tool", s.name);
    add("status", s.status);
    if (s.start != null && s.end != null) add("duration", fmtDur(s.end - s.start));
    if (s.start != null) add("offset", "+" + (fmtDur(s.start - win.t0) || "0ms"));
    add("started", iso(s.start));
    add("completed", iso(s.end));
    if (s.kind === "reasoning") add("steps", s.entry.steps.length);
    add("tool call id", s.entry.callId);
    const node = index.get(s.nodeId).node;
    add("node", `${node.name} (${node.type})`);
    if (node.model_name || node.model) add("model", node.model_name || node.model);
    add("path", pathTo(s.nodeId).map((x) => x.name).join(" › "));
    return dl;
  }

  function fillSections(body, s, tab, secs) {
    if (!secs.length) {
      const p = document.createElement("p");
      p.className = "muted empty";
      p.textContent = emptyNote(s, tab);
      body.append(p);
      return;
    }
    secs.forEach(({ label, value }, i) => {
      const k = document.createElement("div");
      k.className = "k";
      k.textContent = label;
      const pre = document.createElement("pre");
      const str = value == null ? String(value) : fmtVal(value);
      const key = `${s.id}:${tab}:${i}`;
      body.append(k, pre);
      if (str.length > MAX_CHARS && !fullShown.has(key)) {
        pre.textContent = str.slice(0, MAX_CHARS) + "…";
        const more = document.createElement("button");
        more.className = "more";
        more.dataset.full = key;
        more.textContent = `Show all (${str.length.toLocaleString()} characters)`;
        body.append(more);
      } else {
        pre.textContent = str;
      }
    });
  }

  function renderDetail() {
    const s = traceSel && spans.get(traceSel);
    if (!s) {
      delete spanPanel.dataset.sid;
      spanPanel.innerHTML = `<p class="muted">${traceSel ? "This span isn't in the current view." : "Select a span to see its input, output and metadata."}</p>`;
      return;
    }
    // Keep scroll position and keyboard focus across live redraws of the same span and tab.
    const oldBody = spanPanel.querySelector(".tab-body");
    const sameView = spanPanel.dataset.sid === s.id && spanPanel.dataset.tab === detailTab;
    const keepScroll = sameView && oldBody ? oldBody.scrollTop : 0;
    const act = document.activeElement;
    const refocus = act && spanPanel.contains(act) ? (act.dataset.nav ? `[data-nav="${act.dataset.nav}"]` : act.dataset.tab ? `[data-tab="${act.dataset.tab}"]` : null) : null;

    const idx = rows.indexOf(s);
    const secs = { input: inputOf(s), output: outputOf(s) };
    const rec = records.get(s.nodeId);
    const dur = s.start != null && s.end != null ? fmtDur(s.end - s.start) : "";
    const statusLabel = s.status === "failed" ? "error" : s.status;

    spanPanel.dataset.sid = s.id;
    spanPanel.dataset.tab = detailTab;
    spanPanel.innerHTML =
      `<div class="d-head"><h2></h2><div class="d-nav">` +
        `<button data-nav="-1" title="Previous span (↑ or k)" ${idx <= 0 ? "disabled" : ""}>‹ Prev</button>` +
        `<span class="muted">${idx >= 0 ? idx + 1 : "–"} / ${rows.length}</span>` +
        `<button data-nav="1" title="Next span (↓ or j)" ${idx >= rows.length - 1 ? "disabled" : ""}>Next ›</button>` +
      `</div></div>` +
      `<p class="sub">${spanTag(s)} <span class="pill st-${s.status}"><span class="dot"></span>${statusLabel}</span>` +
        (dur ? ` <span class="muted">${dur}</span>` : "") +
        (s.start != null ? ` <span class="muted">· starts +${fmtDur(s.start - win.t0) || "0ms"}</span>` : "") + `</p>` +
      `<div class="d-bar st-${s.status}">${barHtml(s)}</div>` +
      `<div class="tabs" role="tablist">` +
        ["input", "output", "metadata"].map((t) =>
          `<button role="tab" data-tab="${t}" aria-selected="${t === detailTab}"${t !== "metadata" && !secs[t].length ? ` class="empty-tab" title="Nothing recorded"` : ""}>${t[0].toUpperCase() + t.slice(1)}</button>`).join("") +
      `</div><div class="tab-body" role="tabpanel"></div>`;
    spanPanel.querySelector("h2").textContent = s.kind === "node" ? s.name : `${s.name} · ${index.get(s.nodeId).node.name}`;
    if (s.kind === "node" && rec.toolErrors) spanPanel.querySelector(".sub").insertAdjacentHTML("beforeend", ` <span class="b err">⚠${rec.toolErrors}</span>`);

    const body = spanPanel.querySelector(".tab-body");
    if (detailTab === "metadata") body.append(metaDl(s));
    else fillSections(body, s, detailTab, secs[detailTab]);
    body.scrollTop = keepScroll;
    if (refocus) spanPanel.querySelector(refocus + ":not(:disabled)")?.focus();
  }

  spanPanel.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.nav) step(+b.dataset.nav);
    else if (b.dataset.tab) { detailTab = b.dataset.tab; renderDetail(); }
    else if (b.dataset.full) { fullShown.add(b.dataset.full); renderDetail(); }
  });

  spanCanvas.addEventListener("click", (e) => {
    const row = e.target.closest(".span");
    if (!row) return;
    const s = spans.get(row.dataset.id);
    if (!s) return;
    if (e.target.closest(".chev") && s.children.length) { toggleSpan(s); return; }
    spanScroll.focus({ preventScroll: true });
    if (s.id !== traceSel) selectSpan(s.id);
  });
  spanCanvas.addEventListener("dblclick", (e) => {
    const s = spans.get(e.target.closest(".span")?.dataset.id);
    if (s && !e.target.closest(".chev")) toggleSpan(s);
  });

  spanScroll.addEventListener("keydown", (e) => {
    if (e.target !== spanScroll || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = rows.findIndex((r) => r.id === traceSel);
    const s = rows[i];
    switch (e.key) {
      case "ArrowDown": case "j": step(1); break;
      case "ArrowUp": case "k": step(-1); break;
      case "Home": if (rows.length) selectSpan(rows[0].id, true); break;
      case "End": if (rows.length) selectSpan(rows[rows.length - 1].id, true); break;
      case "ArrowRight":
        if (!s || !s.children.length) break;
        if (!isOpen(s)) toggleSpan(s, true);
        else if (rows[i + 1] && rows[i + 1].parent === s) selectSpan(rows[i + 1].id, true);
        break;
      case "ArrowLeft":
        if (!s) break;
        if (s.children.length && isOpen(s) && !errorsOnly) toggleSpan(s, false);
        else if (s.parent && rows.includes(s.parent)) selectSpan(s.parent.id, true);
        break;
      case "Enter": case " ": if (s) toggleSpan(s); break;
      default: return;
    }
    e.preventDefault();
  });

  let scrollRaf = 0;
  spanScroll.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderWindow(); updateStats(); });
  });
  window.addEventListener("resize", () => { if (view === "trace") renderWindow(); });

  $("#errorsOnly").addEventListener("change", (e) => {
    errorsOnly = e.target.checked;
    spanScroll.scrollTop = 0;
    renderTrace({ rebuild: false });
    ensureVisible(rows.findIndex((r) => r.id === traceSel));
  });

  function setView(v) {
    if (v === view) return;
    view = v;
    treeViewEl.hidden = v !== "tree";
    traceViewEl.hidden = v !== "trace";
    document.querySelectorAll(".seg [data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v));
    const q = $("#search").value.trim().toLowerCase();
    if (v === "trace") {
      buildSpans();
      if (selectedId && spans.get(traceSel)?.nodeId !== selectedId) traceSel = selectedId;
      if (traceSel) openAncestors(traceSel);
      if (q) searchTrace(q); else { traceHits = null; renderTrace({ rebuild: false }); }
      ensureVisible(rows.findIndex((r) => r.id === traceSel));
    } else {
      if (q) search(q);
      showPanel(selectedId && index.has(selectedId) ? selectedId : null);
      updateStats();
    }
  }
  document.querySelectorAll(".seg [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  function updateTraceStats() {
    const els = document.getElementsByTagName("*").length;
    statsEl.textContent =
      `${index.size} nodes · ${spans.size} spans · ${rows.length} rows shown · ${spanCanvas.childElementCount} rendered · ${els} DOM elements on page` +
      ` · ${eventCount} events` + (flushCount ? ` · ${flushCount} screen updates` : "");
  }

  // ---------- helpers ----------

  function fmtDur(ms) {
    if (ms == null || isNaN(ms)) return "";
    return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  }
  function fmtTokens(n) {
    if (n == null) return "0";
    return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  }
  function fmtVal(v) {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- toolbar ----------

  $("#run").addEventListener("click", async () => {
    if (running) return;
    running = true;
    $("#run").disabled = $("#dataset").disabled = true;
    resetRun();
    index.forEach((_, id) => dirty.add(id));
    flush();
    if (selectedId) showPanel(selectedId);
    await window.replayFromTree(root, ingest, { fast: index.size > 200 });
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
    running = false;
    $("#run").disabled = $("#dataset").disabled = false;
  });

  $("#expandAll").addEventListener("click", () => (view === "trace" ? setAllOpen(true) : render({ openAll: true })));
  $("#collapseAll").addEventListener("click", () => (view === "trace" ? setAllOpen(false) : render({ openDepth: 1 })));

  $("#dataset").addEventListener("change", (e) => {
    if (running) return;
    $("#search").value = "";
    load(e.target.value === "large" ? window.makeLargeWorkflow() : window.buildWorkflowFromTrace(window.FINAL_OUTPUT));
  });

  let searchTimer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = e.target.value.trim().toLowerCase();
      if (view === "trace") searchTrace(q); else search(q);
    }, 200);
  });

  function search(q) {
    if (!q) { render({ openDepth: 2 }); return; }
    focusId = null;
    const hits = new Set();
    const openIds = new Set();
    index.forEach(({ node }, id) => {
      if (node.name.toLowerCase().includes(q) || (node.model || "").toLowerCase().includes(q)) {
        hits.add(id);
        pathTo(id).slice(0, -1).forEach((a) => openIds.add(a.id));
      }
    });
    openIds.add(root.id);
    render({ openIds, hits });
    treeEl.querySelector(".node.hit")?.scrollIntoView({ block: "center" });
  }

  load(window.buildWorkflowFromTrace(window.FINAL_OUTPUT));
})();
