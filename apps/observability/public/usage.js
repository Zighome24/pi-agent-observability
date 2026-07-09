/** Usage dashboard view: long-range token and cost analytics. */
(function() {
const STATE = window.__OBS_STATE;
if (!STATE) return;

const $ = s => document.querySelector(s);
const fields = {
  range: $("#usage-range"), from: $("#usage-from"), to: $("#usage-to"), pool: $("#usage-pool"),
  tag: $("#usage-tag"), provider: $("#usage-provider"), model: $("#usage-model"), agent_name: $("#usage-agent"),
  sort: $("#usage-sort"), bucket: $("#usage-bucket"),
};
let loadedOnce = false;
let loadingSeq = 0;

function headers() {
  return STATE.token ? { Authorization: `Bearer ${STATE.token}` } : {};
}

function apiUrl(path, params = {}) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

function fmtInt(n) { return Math.round(Number(n || 0)).toLocaleString(); }
function fmtCost(n) { return `$${Number(n || 0).toFixed(4)}`; }
function esc(s) { return String(s ?? "unknown").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function toLocalInput(iso) { return iso ? iso.slice(0, 16) : ""; }
function fromLocalInput(v) { return v ? new Date(v).toISOString() : ""; }

function rangeBounds() {
  const now = new Date();
  if (STATE.usage.range === "all") return { from: "", to: "" };
  if (STATE.usage.range === "custom") return { from: fromLocalInput(STATE.usage.from), to: fromLocalInput(STATE.usage.to) };
  const ms = STATE.usage.range === "24h" ? 24 * 3600e3 : STATE.usage.range === "30d" ? 30 * 86400e3 : 7 * 86400e3;
  return { from: new Date(now.getTime() - ms).toISOString(), to: now.toISOString() };
}

function params() {
  const bounds = rangeBounds();
  return {
    ...bounds,
    pool: STATE.usage.pool,
    tag: STATE.usage.tag,
    provider: STATE.usage.provider,
    model: STATE.usage.model,
    agent_name: STATE.usage.agent_name,
  };
}

function syncControlsFromState() {
  for (const [k, el] of Object.entries(fields)) if (el) el.value = STATE.usage[k] ?? "";
  fields.from.disabled = STATE.usage.range !== "custom";
  fields.to.disabled = STATE.usage.range !== "custom";
}

function syncStateFromControls() {
  for (const [k, el] of Object.entries(fields)) if (el) STATE.usage[k] = el.value.trim?.() ?? el.value;
}

function cards(t = {}) {
  const data = [
    ["total tokens", fmtInt(t.total_tokens)], ["input", fmtInt(t.input_tokens)], ["output", fmtInt(t.output_tokens)],
    ["cache read", fmtInt(t.cache_read_tokens)], ["cache write", fmtInt(t.cache_write_tokens)],
    ["total cost", fmtCost(t.cost_total), "cost"], ["model calls", fmtInt(t.call_count)],
  ];
  $("#usage-cards").innerHTML = data.map(([label, value, cls]) => `<div class="usage-card ${cls || ""}"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("");
}

function table(el, items) {
  if (!items.length) { el.innerHTML = `<div class="usage-empty">No usage rows for this range/filter.</div>`; return; }
  el.innerHTML = `<table class="usage-table"><thead><tr><th>name</th><th>tokens</th><th>cost</th><th>calls</th></tr></thead><tbody>${items.map(i =>
    `<tr><td title="${esc(i.id)}">${esc(i.id || "unknown")}</td><td>${fmtInt(i.total_tokens)}</td><td>${fmtCost(i.cost_total)}</td><td>${fmtInt(i.call_count)}</td></tr>`
  ).join("")}</tbody></table>`;
}

function chart(points, metric) {
  const el = $("#usage-bars");
  if (!points.length) { el.innerHTML = `<div class="usage-empty" style="width:100%">No timeseries data.</div>`; return; }
  const byBucket = new Map();
  for (const p of points) {
    const cur = byBucket.get(p.bucket) || { id: p.bucket, total_tokens: 0, cost_total: 0, call_count: 0 };
    cur.total_tokens += Number(p.total_tokens || 0); cur.cost_total += Number(p.cost_total || 0); cur.call_count += Number(p.call_count || 0);
    byBucket.set(p.bucket, cur);
  }
  const rows = [...byBucket.values()].sort((a, b) => a.id.localeCompare(b.id));
  const max = Math.max(1, ...rows.map(r => metric === "cost" ? r.cost_total : r.total_tokens));
  el.innerHTML = rows.map(r => {
    const value = metric === "cost" ? r.cost_total : r.total_tokens;
    const h = Math.max(2, (value / max) * 100);
    return `<div class="usage-bar" style="height:${h}%" title="${esc(r.id)} · ${fmtInt(r.total_tokens)} tk · ${fmtCost(r.cost_total)} · ${fmtInt(r.call_count)} calls"></div>`;
  }).join("");
}

function aggregateModels(points) {
  const m = new Map();
  for (const p of points) {
    const id = p.group || "unknown";
    const row = m.get(id) || { id, total_tokens: 0, cost_total: 0, call_count: 0 };
    row.total_tokens += Number(p.total_tokens || 0); row.cost_total += Number(p.cost_total || 0); row.call_count += Number(p.call_count || 0);
    m.set(id, row);
  }
  const key = STATE.usage.sort === "tokens" ? "total_tokens" : "cost_total";
  return [...m.values()].sort((a, b) => b[key] - a[key] || a.id.localeCompare(b.id)).slice(0, 10);
}

async function fetchJson(path, p) {
  const res = await fetch(apiUrl(path, p), { headers: headers() });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function loadUsage() {
  const seq = ++loadingSeq;
  $("#usage-updated").textContent = "loading…";
  $("#usage-updated").className = "usage-updated";
  try {
    const p = params();
    const topParams = { ...p, limit: 10, sort: STATE.usage.sort };
    const [summary, ts, runs, agents, models] = await Promise.all([
      fetchJson("/usage/summary", p),
      fetchJson("/usage/timeseries", { ...p, bucket: STATE.usage.bucket }),
      fetchJson("/usage/top-runs", topParams),
      fetchJson("/usage/top-agents", topParams),
      fetchJson("/usage/timeseries", { ...p, bucket: STATE.usage.bucket, group_by: "model" }),
    ]);
    if (seq !== loadingSeq) return;
    cards(summary.totals);
    chart(ts.points || [], STATE.usage.sort);
    table($("#usage-top-runs"), runs.items || []);
    table($("#usage-top-agents"), agents.items || []);
    table($("#usage-top-models"), aggregateModels(models.points || []));
    $("#usage-chart-note").textContent = `${STATE.usage.bucket} buckets · ${STATE.usage.sort}`;
    $("#usage-updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $("#usage-updated").innerHTML = `<span class="usage-error">${esc(err.message)}</span>`;
    cards({}); chart([], STATE.usage.sort);
    for (const id of ["#usage-top-runs", "#usage-top-agents", "#usage-top-models"]) $(id).innerHTML = `<div class="usage-empty">Unable to load usage data.</div>`;
  }
}

function apply() {
  syncStateFromControls();
  syncControlsFromState();
  window.setView?.("usage"); // refreshes URL hash without auth token
  loadUsage();
}

function reset() {
  STATE.usage = { range: "7d", from: "", to: "", pool: "", tag: "", provider: "", model: "", agent_name: "", sort: "cost", bucket: "day" };
  syncControlsFromState();
  window.setView?.("usage");
  loadUsage();
}

$("#usage-apply")?.addEventListener("click", apply);
$("#usage-reset")?.addEventListener("click", reset);
for (const el of Object.values(fields)) el?.addEventListener("keydown", e => { if (e.key === "Enter") apply(); });
fields.range?.addEventListener("change", () => { syncStateFromControls(); syncControlsFromState(); });

window.__usageOnView = function() {
  syncControlsFromState();
  if (!loadedOnce) { loadedOnce = true; loadUsage(); }
};

syncControlsFromState();
if (STATE.view === "usage") window.__usageOnView();
})();
