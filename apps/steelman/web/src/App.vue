<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { renderMarkdown } from "./markdown";

type Status = "idle" | "starting" | "running" | "done" | "error";
type Role = "user" | "assistant" | "system";
type ArtifactKind = "text" | "table" | "bar-chart" | "pie-chart" | "html" | "trend" | "scorecard" | "risk-map";

interface Reference { url: string; title: string; source?: string }
interface ChatMessage { id: string; role: Role; text: string; ts: string; pending?: boolean; references?: Reference[] }
interface Artifact { id: string; ref: string; kind: ArtifactKind; title: string; summary?: string; data?: any; markdown?: string; html?: string; createdAt: string }
interface RunSnapshot { id: string; thesis: string; status: Status; chat: ChatMessage[]; artifacts: Artifact[]; obsUrl: string; piSessionId?: string; error?: string }

const starter = `Bull thesis: Apple is an underappreciated AI distribution winner. The installed base, silicon, privacy posture, and services ecosystem mean on-device AI will accelerate upgrades and services ARPU while margins stay resilient. How valuable was the mac mini "claw" trend to apple?`;
const thesis = ref(starter);
const followup = ref("");
const run = ref<RunSnapshot | null>(null);
const status = ref<Status>("idle");
const selectedRef = ref<string | null>(null);
const error = ref("");
const busy = computed(() => status.value === "starting" || status.value === "running");
// True while an assistant reply is actively streaming tokens. Used to show the
// "working" indicator only during the research/think phase before text arrives.
const streaming = computed(() => (run.value?.chat ?? []).some((m) => m.role === "assistant" && m.pending));
const chatScroller = ref<HTMLElement | null>(null);
let es: EventSource | null = null;

const artifacts = computed(() => run.value?.artifacts ?? []);

// Display label for a chat author: the agent is branded "Steelman", not "assistant".
function roleLabel(role: Role) {
  return role === "assistant" ? "steelman" : role;
}
const selectedArtifact = computed(() => {
  if (!artifacts.value.length) return null;
  return artifacts.value.find((a) => a.ref === selectedRef.value) ?? artifacts.value[artifacts.value.length - 1];
});

async function startRun() {
  const text = thesis.value.trim();
  if (!text || busy.value) return;
  closeStream();
  error.value = "";
  selectedRef.value = null;
  status.value = "starting";
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thesis: text }),
  });
  if (!res.ok) {
    error.value = await res.text();
    status.value = "error";
    return;
  }
  const data = await res.json();
  run.value = data.run;
  status.value = data.run.status;
  openStream(data.run.id);
}

async function sendFollowup() {
  const text = followup.value.trim();
  if (!text || !run.value || busy.value) return;
  followup.value = "";
  status.value = "running";
  const res = await fetch(`/api/runs/${run.value.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
  if (!res.ok) error.value = await res.text();
}

function openStream(id: string) {
  es = new EventSource(`/api/runs/${id}/stream`);
  es.addEventListener("run", (msg) => {
    const evt = JSON.parse((msg as MessageEvent).data);
    run.value = evt.run;
    status.value = evt.run.status;
    if (!selectedRef.value && evt.run.artifacts?.length) selectedRef.value = evt.run.artifacts.at(-1).ref;
  });
  es.addEventListener("status", (msg) => {
    const evt = JSON.parse((msg as MessageEvent).data);
    status.value = evt.status;
    if (run.value) {
      run.value.status = evt.status;
      if (evt.status === "done" || evt.status === "error") {
        run.value.chat.forEach((m) => { m.pending = false; });
      }
    }
  });
  es.addEventListener("chat", (msg) => {
    const evt = JSON.parse((msg as MessageEvent).data);
    if (!run.value) return;
    const exists = run.value.chat.some((m) => m.id === evt.message.id);
    if (!exists) run.value.chat.push(evt.message);
    scrollChat();
  });
  es.addEventListener("chat_delta", (msg) => {
    const evt = JSON.parse((msg as MessageEvent).data);
    if (!run.value) return;
    const m = run.value.chat.find((x) => x.id === evt.id);
    if (m) m.text += evt.delta;
    scrollChat();
  });
  es.addEventListener("artifact", (msg) => {
    const evt = JSON.parse((msg as MessageEvent).data);
    if (!run.value) return;
    const idx = run.value.artifacts.findIndex((a) => a.ref === evt.artifact.ref);
    if (idx >= 0) run.value.artifacts[idx] = evt.artifact;
    else run.value.artifacts.push(evt.artifact);
    selectedRef.value = evt.artifact.ref;
  });
  es.addEventListener("message_refs", (msg) => {
    const evt = JSON.parse((msg as MessageEvent).data);
    const m = run.value?.chat.find((x) => x.id === evt.id);
    if (m) m.references = evt.references;
  });
  es.addEventListener("error", (msg) => {
    try { error.value = JSON.parse((msg as MessageEvent).data).message || "stream error"; }
    catch { error.value = "stream error"; }
  });
}

function closeStream() { es?.close(); es = null; }
onBeforeUnmount(closeStream);

function scrollChat() {
  nextTick(() => {
    if (chatScroller.value) chatScroller.value.scrollTop = chatScroller.value.scrollHeight;
  });
}

function selectArtifact(refName: string) {
  selectedRef.value = refName.replace(/^@/, "");
}

// Delegated click handler for @ref buttons inside rendered markdown.
function onRefClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest("button.ref") as HTMLElement | null;
  if (btn?.dataset.ref) selectArtifact(btn.dataset.ref);
}

function rowsForTable(data: any): { columns: string[]; rows: any[][] } {
  if (data?.columns && data?.rows) return data;
  if (Array.isArray(data) && data.length && typeof data[0] === "object") {
    const columns = Object.keys(data[0]);
    return { columns, rows: data.map((r) => columns.map((c) => r[c])) };
  }
  return { columns: ["Value"], rows: [[JSON.stringify(data ?? {}, null, 2)]] };
}

function chartItems(data: any): Array<{ label: string; value: number }> {
  if (Array.isArray(data)) return data.map((d) => ({ label: String(d.label ?? d.name ?? "?"), value: Number(d.value ?? d.y ?? 0) }));
  if (data?.labels && data?.values) return data.labels.map((l: string, i: number) => ({ label: String(l), value: Number(data.values[i] ?? 0) }));
  return [];
}

function pieSlices(data: any) {
  const items = chartItems(data).filter((i) => i.value > 0);
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  let acc = 0;
  return items.map((item, idx) => {
    const start = acc / total;
    acc += item.value;
    const end = acc / total;
    return { ...item, color: colors[idx % colors.length], dash: `${(end - start) * 100} ${100 - ((end - start) * 100)}`, offset: 25 - start * 100 };
  });
}

const colors = ["#88f7d0", "#7aa7ff", "#f6c177", "#f38ba8", "#c4a7e7", "#94e2d5"];
function pct(v: number, total: number) { return `${Math.round((v / (total || 1)) * 100)}%`; }
function maxValue(items: Array<{ value: number }>) { return Math.max(1, ...items.map((i) => i.value)); }

const trendPoints = computed(() => {
  const items = chartItems(selectedArtifact.value?.data);
  if (!items.length) return [];
  const N = items.length;
  const values = items.map(i => i.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  
  return items.map((item, idx) => {
    // Width of graph area is 420 (from x=40 to x=460)
    const x = N > 1 ? 40 + idx * (420 / (N - 1)) : 250;
    // Height of graph area is 120 (from y=40 to y=160)
    const y = N > 1 ? 160 - ((item.value - minVal) / range) * 120 : 100;
    return { x, y, label: item.label, rawVal: item.value };
  });
});

const trendLinePath = computed(() => {
  const pts = trendPoints.value;
  if (!pts.length) return "";
  return pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(" ");
});

const trendAreaPath = computed(() => {
  const pts = trendPoints.value;
  if (pts.length < 2) return "";
  const first = pts[0];
  const last = pts[pts.length - 1];
  const line = pts.map((p) => `L ${p.x} ${p.y}`).join(" ");
  return `M ${first.x} 160 L ${first.x} ${first.y} ${line} L ${last.x} 160 Z`;
});

function scorecardItems(data: any): Array<{ metric: string; value: string; signal: 'positive' | 'neutral' | 'negative'; label?: string }> {
  if (Array.isArray(data)) {
    return data.map((d) => ({
      metric: String(d.metric ?? d.name ?? "?"),
      value: String(d.value ?? d.val ?? ""),
      signal: String(d.signal ?? "neutral").toLowerCase() as 'positive' | 'neutral' | 'negative',
      label: d.label ? String(d.label) : undefined
    }));
  }
  if (data && typeof data === "object") {
    return Object.entries(data).map(([key, val]: [string, any]) => ({
      metric: key,
      value: typeof val === "object" ? String(val.value ?? "") : String(val),
      signal: typeof val === "object" ? String(val.signal ?? "neutral").toLowerCase() as 'positive' | 'neutral' | 'negative' : "neutral",
      label: typeof val === "object" && val.label ? String(val.label) : undefined
    }));
  }
  return [];
}

function valueForLevel(level: any): number {
  const s = String(level).toLowerCase().trim();
  if (s === "high" || s === "3") return 2;
  if (s === "medium" || s === "med" || s === "2") return 1;
  return 0; // "low" or "1"
}

function labelForValue(val: number): string {
  if (val === 2) return "High";
  if (val === 1) return "Medium";
  return "Low";
}

function cellRiskClass(row: number, col: number): string {
  const score = row + col;
  if (score >= 3) return "risk-high";
  if (score >= 1) return "risk-med";
  return "risk-low";
}

function riskMapItems(data: any): Array<{ risk: string; likelihood: string; impact: string; description?: string; index: number }> {
  if (!Array.isArray(data)) return [];
  return data.map((d, idx) => ({
    risk: String(d.risk ?? d.title ?? d.name ?? "?"),
    likelihood: String(d.likelihood ?? "medium").toLowerCase(),
    impact: String(d.impact ?? "medium").toLowerCase(),
    description: d.description ? String(d.description) : undefined,
    index: idx
  }));
}

function risksAt(row: number, col: number) {
  return riskMapItems(selectedArtifact.value?.data).filter(item => {
    return valueForLevel(item.likelihood) === col && valueForLevel(item.impact) === row;
  });
}

function capitalize(s: string) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
</script>

<template>
  <main class="shell">
    <section class="artifact-pane">
      <header class="topbar">
        <div>
          <p class="eyebrow">Product Pi Agent Demo</p>
          <h1>Investment Steelman</h1>
        </div>
      </header>

      <div v-if="!run" class="empty-left">
        <div class="orb">◆</div>
        <h2>Your counter-thesis, visualized</h2>
        <p>Enter an investment thesis and we'll build the strongest case against it — charts, tables, and key takeaways appear here.</p>
      </div>

      <template v-else>
        <div class="run-strip">
          <span :class="['status', status]">{{ status }}</span>
          <span v-if="run.piSessionId">pi {{ run.piSessionId.slice(0, 8) }}</span>
        </div>

        <div class="artifact-tabs" v-if="artifacts.length">
          <button v-for="artifact in artifacts" :key="artifact.id" :class="{ active: selectedArtifact?.ref === artifact.ref }" @click="selectArtifact(artifact.ref)">
            @{{ artifact.ref }}
          </button>
        </div>

        <div v-if="selectedArtifact" class="artifact-card">
          <div class="artifact-head">
            <div>
              <code class="artifact-tag">@{{ selectedArtifact.ref }}</code>
              <h2>{{ selectedArtifact.title }}</h2>
              <p v-if="selectedArtifact.summary" class="summary">{{ selectedArtifact.summary }}</p>
            </div>
          </div>

          <div v-if="selectedArtifact.kind === 'table'" class="table-wrap">
            <table>
              <thead><tr><th v-for="c in rowsForTable(selectedArtifact.data).columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in rowsForTable(selectedArtifact.data).rows" :key="i">
                  <td v-for="(cell, j) in r" :key="j">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else-if="selectedArtifact.kind === 'bar-chart'" class="bar-chart">
            <div v-for="(item, i) in chartItems(selectedArtifact.data)" :key="item.label" class="bar-row">
              <span>{{ item.label }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(item.value / maxValue(chartItems(selectedArtifact.data))) * 100}%`, background: colors[i % colors.length] }"></div></div>
              <b>{{ item.value }}</b>
            </div>
          </div>

          <div v-else-if="selectedArtifact.kind === 'pie-chart'" class="pie-layout">
            <svg viewBox="0 0 42 42" class="pie">
              <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="#1d2433" stroke-width="10"></circle>
              <circle v-for="slice in pieSlices(selectedArtifact.data)" :key="slice.label" cx="21" cy="21" r="15.915" fill="transparent" :stroke="slice.color" stroke-width="10" :stroke-dasharray="slice.dash" :stroke-dashoffset="slice.offset"></circle>
            </svg>
            <div class="legend">
              <div v-for="slice in pieSlices(selectedArtifact.data)" :key="slice.label"><i :style="{ background: slice.color }"></i>{{ slice.label }} <b>{{ pct(slice.value, chartItems(selectedArtifact.data).reduce((s, x) => s + x.value, 0)) }}</b></div>
            </div>
          </div>

          <div v-else-if="selectedArtifact.kind === 'trend'" class="trend-layout">
            <div class="trend-chart-container">
              <svg viewBox="0 0 500 220" class="trend-svg" width="100%">
                <defs>
                  <linearGradient id="trend-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.25"></stop>
                    <stop offset="100%" stop-color="var(--blue)" stop-opacity="0.0"></stop>
                  </linearGradient>
                </defs>
                <!-- Horizontal gridlines -->
                <line x1="40" y1="40" x2="460" y2="40" stroke="var(--line)" stroke-dasharray="4 4" />
                <line x1="40" y1="100" x2="460" y2="100" stroke="var(--line)" stroke-dasharray="4 4" />
                <line x1="40" y1="160" x2="460" y2="160" stroke="var(--line)" stroke-dasharray="4 4" />
                
                <!-- Area under the line -->
                <path v-if="trendPoints.length > 1" :d="trendAreaPath" fill="url(#trend-grad)"></path>
                
                <!-- Trend Line -->
                <path v-if="trendPoints.length > 1" :d="trendLinePath" fill="none" stroke="var(--blue)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
                
                <!-- Dots & Values -->
                <g v-for="(p, i) in trendPoints" :key="i">
                  <circle :cx="p.x" :cy="p.y" r="5" fill="#0d111b" stroke="var(--blue)" stroke-width="2.5"></circle>
                  <text :x="p.x" :y="p.y - 12" text-anchor="middle" font-size="11" font-weight="bold" fill="var(--text)">{{ p.rawVal }}</text>
                  <text :x="p.x" y="195" text-anchor="middle" font-size="10" fill="var(--muted)">{{ p.label }}</text>
                </g>
              </svg>
            </div>
          </div>

          <div v-else-if="selectedArtifact.kind === 'scorecard'" class="scorecard-grid">
            <div v-for="item in scorecardItems(selectedArtifact.data)" :key="item.metric" :class="['scorecard-card', item.signal]">
              <div class="scorecard-meta">
                <span class="scorecard-metric">{{ item.metric }}</span>
                <span :class="['signal-badge', item.signal]">{{ item.signal }}</span>
              </div>
              <div class="scorecard-value">{{ item.value }}</div>
              <p v-if="item.label" class="scorecard-label">{{ item.label }}</p>
            </div>
          </div>

          <div v-else-if="selectedArtifact.kind === 'risk-map'" class="risk-map-layout">
            <div class="risk-matrix-container">
              <div class="y-axis-label">Impact</div>
              <div class="matrix-and-x">
                <div class="risk-matrix">
                  <div v-for="row in [2, 1, 0]" :key="row" class="matrix-row">
                    <div class="row-header">{{ labelForValue(row) }}</div>
                    <div v-for="col in [0, 1, 2]" :key="col" :class="['matrix-cell', cellRiskClass(row, col)]">
                      <!-- Plot dots here if any risk falls into this coordinate -->
                      <div class="dots-container">
                        <span v-for="risk in risksAt(row, col)" :key="risk.index" class="risk-dot" :title="risk.risk">
                          {{ risk.index + 1 }}
                        </span>
                      </div>
                    </div>
                  </div>
                  <!-- X-axis headers -->
                  <div class="matrix-row x-headers">
                    <div class="row-header empty"></div>
                    <div class="col-header">Low</div>
                    <div class="col-header">Medium</div>
                    <div class="col-header">High</div>
                  </div>
                </div>
                <div class="x-axis-label">Likelihood</div>
              </div>
            </div>
            
            <!-- List of risk details below the matrix -->
            <div class="risk-list">
              <h3>Risk Catalog</h3>
              <ol class="risk-items">
                <li v-for="(item, idx) in riskMapItems(selectedArtifact.data)" :key="idx">
                  <div class="risk-item-head">
                    <span class="risk-badge-number">{{ idx + 1 }}</span>
                    <strong class="risk-title">{{ item.risk }}</strong>
                    <span class="risk-coords">
                      L: {{ capitalize(item.likelihood) }} | I: {{ capitalize(item.impact) }}
                    </span>
                  </div>
                  <p v-if="item.description" class="risk-desc">{{ item.description }}</p>
                </li>
              </ol>
            </div>
          </div>

          <iframe v-else-if="selectedArtifact.kind === 'html'" class="html-frame" sandbox="" :srcdoc="selectedArtifact.html || ''"></iframe>
          <pre v-else class="text-artifact">{{ selectedArtifact.markdown || selectedArtifact.summary || JSON.stringify(selectedArtifact.data, null, 2) }}</pre>
        </div>

        <div v-else class="empty-left small">
          <div class="orb">◇</div>
          <h2>Building your analysis…</h2>
          <p>Charts and tables will appear here as the counter-thesis takes shape.</p>
        </div>
      </template>
    </section>

    <section class="chat-pane">
      <div class="chat-scroll" ref="chatScroller">
        <div class="intro">
          <p class="eyebrow">Counter-thesis chat</p>
          <h2>Give the agent an investment thesis.</h2>
          <p>The strongest counter-case streams here, with supporting charts and tables on the left.</p>
        </div>

        <div v-if="error" class="error">{{ error }}</div>

        <article v-for="message in run?.chat ?? []" :key="message.id" :class="['msg', message.role]">
          <div class="role">{{ roleLabel(message.role) }}</div>
          <div class="bubble">
            <p v-if="message.role === 'user'" class="plain">{{ message.text }}</p>
            <div v-else class="md" v-html="renderMarkdown(message.text)" @click="onRefClick"></div>
            <span v-if="message.pending" class="cursor">▋</span>
          </div>
          <details v-if="message.references && message.references.length" class="references">
            <summary>{{ message.references.length }} references</summary>
            <ol>
              <li v-for="ref in message.references" :key="ref.url">
                <a :href="ref.url" target="_blank" rel="noopener noreferrer">{{ ref.title }}</a>
              </li>
            </ol>
          </details>
        </article>

        <div v-if="busy && !streaming" class="working">
          <span class="dots"><i></i><i></i><i></i></span>
          Steelman is analyzing the thesis…
        </div>
      </div>

      <form v-if="!run" class="composer thesis" @submit.prevent="startRun">
        <textarea v-model="thesis" rows="7" placeholder="Enter a bull or bear thesis…"></textarea>
        <button :disabled="busy">Start steelman</button>
      </form>

      <form v-else class="composer" @submit.prevent="sendFollowup">
        <input v-model="followup" :disabled="busy" placeholder="Ask a follow-up… e.g. what data would falsify this bear case?" />
        <button :disabled="busy || !followup.trim()">Send</button>
      </form>
    </section>
  </main>
</template>
