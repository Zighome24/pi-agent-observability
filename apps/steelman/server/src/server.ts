import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const APP_ROOT = path.resolve(import.meta.dir, "../..");
const PORT = Number(process.env.STEELMAN_PORT || 45210);
const HOST = process.env.STEELMAN_HOST || "127.0.0.1";
const BASE_URL = process.env.STEELMAN_APP_URL || `http://${HOST}:${PORT}`;
const INTERNAL_TOKEN = process.env.STEELMAN_INTERNAL_TOKEN || randomUUID();
const OBS_SERVER_URL = process.env.OBS_SERVER_URL || "http://127.0.0.1:43190";
const OBS_AUTH_TOKEN = process.env.OBS_AUTH_TOKEN || "";
// Default the product agent to Gemini 3.5 Flash on Google. Override via env.
const STEELMAN_MODEL = process.env.STEELMAN_AGENT_MODEL || "gemini-3.5-flash";
const STEELMAN_PROVIDER = process.env.STEELMAN_AGENT_MODEL_PROVIDER || "google";
const RUNS_DIR = path.join(APP_ROOT, "storage", "runs");
const SESSION_DIR = path.join(APP_ROOT, ".sessions");

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });

type Role = "user" | "assistant" | "system";
type ArtifactKind = "text" | "table" | "bar-chart" | "pie-chart" | "html" | "trend" | "scorecard" | "risk-map";

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  ts: string;
  pending?: boolean;
  references?: Reference[];
}

interface Artifact {
  id: string;
  ref: string;
  kind: ArtifactKind;
  title: string;
  summary?: string;
  data?: unknown;
  markdown?: string;
  html?: string;
  createdAt: string;
}

interface Reference {
  url: string;
  title: string;
  source?: string;
}

interface Run {
  id: string;
  thesis: string;
  status: "starting" | "running" | "done" | "error";
  createdAt: string;
  updatedAt: string;
  chat: ChatMessage[];
  artifacts: Artifact[];
  references: Reference[];
  // refs collected before the response they belong to has started streaming;
  // flushed onto the assistant message by appendChat. Not serialized.
  pendingRefs: Reference[];
  events: ProductEvent[];
  obsUrl: string;
  piSessionId?: string;
  error?: string;
  agent?: PiRpcAgent;
}

type ProductEvent =
  | { type: "run"; run: RunSnapshot }
  | { type: "chat"; message: ChatMessage }
  | { type: "chat_delta"; id: string; delta: string }
  | { type: "thought_delta"; delta: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "message_refs"; id: string; references: Reference[] }
  | { type: "status"; status: Run["status"]; message?: string }
  | { type: "tool"; phase: "start" | "update" | "end"; name: string; toolCallId?: string; text?: string; isError?: boolean }
  | { type: "obs"; obsUrl: string; piSessionId?: string }
  | { type: "error"; message: string };

type RunSnapshot = Omit<Run, "agent" | "events" | "pendingRefs">;

const runs = new Map<string, Run>();
const subscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();

function snapshot(run: Run): RunSnapshot {
  const { agent: _agent, events: _events, pendingRefs: _pendingRefs, ...rest } = run;
  return rest;
}

function now() { return new Date().toISOString(); }

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extraHeaders },
  });
}

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, { status, headers: { "content-type": contentType, "access-control-allow-origin": "*" } });
}

function emit(run: Run, event: ProductEvent) {
  run.updatedAt = now();
  run.events.push(event);
  if (run.events.length > 500) run.events.splice(0, run.events.length - 500);
  persistRun(run);
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const sub of subscribers.get(run.id) || []) {
    try { sub.enqueue(encoder.encode(frame)); } catch { /* closed */ }
  }
}

function setStatus(run: Run, status: Run["status"], message?: string) {
  run.status = status;
  emit(run, { type: "status", status, message });
}

function appendChat(run: Run, role: Role, textValue: string, pending = false): ChatMessage {
  const message: ChatMessage = { id: randomUUID(), role, text: textValue, ts: now(), pending };
  // Attach any references collected before this response started streaming.
  if (role === "assistant" && run.pendingRefs.length) {
    message.references = run.pendingRefs.splice(0, run.pendingRefs.length);
  }
  run.chat.push(message);
  emit(run, { type: "chat", message });
  return message;
}

function appendDelta(run: Run, id: string, delta: string) {
  const msg = run.chat.find((m) => m.id === id);
  if (msg) msg.text += delta;
  emit(run, { type: "chat_delta", id, delta });
}

function addArtifact(run: Run, incoming: Partial<Artifact>): Artifact {
  const ref = cleanRef(incoming.ref || incoming.id || incoming.title || "artifact");
  const artifact: Artifact = {
    id: `${run.id}:${ref}`,
    ref,
    kind: (incoming.kind || "text") as ArtifactKind,
    title: incoming.title || ref,
    summary: incoming.summary || "",
    data: incoming.data ?? null,
    markdown: incoming.markdown || "",
    html: incoming.html || "",
    createdAt: incoming.createdAt || now(),
  };
  const idx = run.artifacts.findIndex((a) => a.ref === ref);
  if (idx >= 0) run.artifacts[idx] = artifact;
  else run.artifacts.push(artifact);
  emit(run, { type: "artifact", artifact });
  return artifact;
}

function addReferences(run: Run, incoming: Array<Partial<Reference>>): Reference[] {
  const seen = new Set(run.references.map((r) => r.url));
  const fresh: Reference[] = [];
  for (const raw of incoming || []) {
    const url = String(raw?.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const ref: Reference = {
      url,
      title: String(raw?.title || url).slice(0, 200),
      source: raw?.source ? String(raw.source) : undefined,
    };
    run.references.push(ref);
    fresh.push(ref);
    if (run.references.length >= 40) break;
  }
  if (!fresh.length) return run.references;

  // Attach to the response currently being written. If the agent researched
  // before it started typing, no assistant message exists yet — buffer the refs
  // and appendChat flushes them onto the message when it's created.
  const current = [...run.chat].reverse().find((m) => m.role === "assistant" && m.pending);
  if (current) {
    current.references = [...(current.references || []), ...fresh];
    emit(run, { type: "message_refs", id: current.id, references: current.references });
  } else {
    run.pendingRefs.push(...fresh);
  }
  return run.references;
}

function cleanRef(value: string): string {
  return String(value).replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "artifact";
}

function persistRun(run: Run) {
  const file = path.join(RUNS_DIR, `${run.id}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot(run), null, 2));
}

function obsUrlFor(runId: string) {
  const u = new URL(OBS_SERVER_URL);
  if (OBS_AUTH_TOKEN) u.searchParams.set("token", OBS_AUTH_TOKEN);
  const view = process.env.STEELMAN_OBS_VIEW || "single";
  u.hash = new URLSearchParams({ view, pool: "product-steelman", tag: `run-${runId}` }).toString();
  return u.toString();
}

function buildPrompt(thesis: string) {
  return `Investment thesis to steelman against:\n\n${thesis}\n\nDeliver the strongest counterargument. Use research when useful. Create structured artifacts with steelman_emit_artifact and cite them in chat with @refs.`;
}

function createRun(thesis: string): Run {
  const id = randomUUID().slice(0, 12);
  const run: Run = {
    id,
    thesis,
    status: "starting",
    createdAt: now(),
    updatedAt: now(),
    chat: [],
    artifacts: [],
    references: [],
    pendingRefs: [],
    events: [],
    obsUrl: obsUrlFor(id),
  };
  runs.set(id, run);
  appendChat(run, "user", thesis);
  emit(run, { type: "run", run: snapshot(run) });
  emit(run, { type: "obs", obsUrl: run.obsUrl });
  return run;
}

async function parseJson(req: Request) {
  const txt = await req.text();
  return txt ? JSON.parse(txt) : {};
}

function startAgent(run: Run, prompt: string) {
  const agent = new PiRpcAgent(run);
  run.agent = agent;
  agent.start().then(() => agent.prompt(prompt)).catch((err) => {
    run.error = err?.message || String(err);
    appendChat(run, "system", `Agent failed to start: ${run.error}`);
    setStatus(run, "error", run.error);
  });
}

class JsonlReader {
  private buffer = "";
  constructor(private onLine: (line: string) => void) {}
  push(chunk: Buffer | string) {
    this.buffer += chunk.toString();
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this.onLine(line);
    }
  }
}

class PiRpcAgent {
  private proc?: ChildProcessWithoutNullStreams;
  private currentAssistantId?: string;
  private started = false;

  constructor(private run: Run) {}

  async start() {
    const obsExt = path.join(ROOT, "extension", "pi-observability.ts");
    const productExt = path.join(APP_ROOT, "extension", "steelman-product.ts");
    const args = [
      "--mode", "rpc",
      "--session-dir", SESSION_DIR,
      "--no-builtin-tools",
      "-e", obsExt,
      "-e", productExt,
      "--o-pool", "product-steelman",
      "--o-tag", `product,steelman,run-${this.run.id}`,
      "--o-name", `steelman-${this.run.id}`,
    ];
    if (STEELMAN_PROVIDER) args.push("--provider", STEELMAN_PROVIDER);
    if (STEELMAN_MODEL) args.push("--model", STEELMAN_MODEL);

    const env = {
      ...process.env,
      OBS_SERVER_URL,
      OBS_AUTH_TOKEN,
      STEELMAN_RUN_ID: this.run.id,
      STEELMAN_APP_URL: BASE_URL,
      STEELMAN_INTERNAL_TOKEN: INTERNAL_TOKEN,
      OBS_POOL: "product-steelman",
      OBS_TAG: `product,steelman,run-${this.run.id}`,
      OBS_NAME: `steelman-${this.run.id}`,
      // Isolate jiti caches so concurrent product-agent runs do not contend
      // while compiling the TypeScript extensions.
      JITI_CACHE: "true",
      JITI_CACHE_DIR: path.join("/tmp", `steelman-jiti-${this.run.id}`),
    };

    this.proc = spawn(process.env.STEELMAN_PI_BIN || "pi", args, { cwd: APP_ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    this.started = true;
    setStatus(this.run, "running", "Pi RPC agent started");

    const timeoutMs = Number(process.env.STEELMAN_AGENT_TIMEOUT_MS || 180_000);
    const timeout = setTimeout(() => {
      if (this.run.status === "running") {
        this.run.error = `Agent timed out after ${Math.round(timeoutMs / 1000)}s`;
        emit(this.run, { type: "error", message: this.run.error });
        setStatus(this.run, "error", this.run.error);
        this.proc?.kill("SIGTERM");
      }
    }, timeoutMs);

    const reader = new JsonlReader((line) => this.handleLine(line));
    this.proc.stdout.on("data", (d) => reader.push(d));
    this.proc.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) emit(this.run, { type: "tool", phase: "update", name: "pi-stderr", text: msg.slice(0, 2000) });
    });
    this.proc.on("error", (err) => {
      this.run.error = err.message;
      emit(this.run, { type: "error", message: err.message });
      setStatus(this.run, "error", err.message);
    });
    this.proc.on("close", (code) => {
      clearTimeout(timeout);
      if (this.run.status === "running") setStatus(this.run, code === 0 ? "done" : "error", `Pi exited with code ${code}`);
    });

    this.send({ type: "get_state", id: randomUUID() });
  }

  async prompt(message: string) {
    if (!this.started) await this.start();
    this.currentAssistantId = undefined;
    this.send({ id: randomUUID(), type: "prompt", message, streamingBehavior: "followUp" });
  }

  private send(obj: Record<string, unknown>) {
    this.proc?.stdin.write(JSON.stringify(obj) + "\n");
  }

  private handleLine(line: string) {
    let evt: any;
    try { evt = JSON.parse(line); } catch { return; }

    if (evt.type === "response" && evt.command === "get_state" && evt.data?.sessionId) {
      this.run.piSessionId = evt.data.sessionId;
      emit(this.run, { type: "obs", obsUrl: this.run.obsUrl, piSessionId: this.run.piSessionId });
      return;
    }

    if (evt.type === "extension_ui_request") return;

    if (evt.type === "agent_start") {
      setStatus(this.run, "running", "Analyzing thesis");
      return;
    }
    if (evt.type === "agent_end") {
      const msg = this.currentAssistantId ? this.run.chat.find((m) => m.id === this.currentAssistantId) : undefined;
      if (msg) msg.pending = false;
      setStatus(this.run, "done", "Steelman complete");
      return;
    }
    if (evt.type === "message_update") {
      const delta = evt.assistantMessageEvent;
      if (!delta) return;
      if (delta.type === "text_delta" && delta.delta) {
        if (!this.currentAssistantId) this.currentAssistantId = appendChat(this.run, "assistant", "", true).id;
        appendDelta(this.run, this.currentAssistantId, delta.delta);
      }
      if (delta.type === "thinking_delta" && delta.delta) {
        emit(this.run, { type: "thought_delta", delta: delta.delta });
      }
      return;
    }
    if (evt.type === "message_end" && evt.message?.role === "assistant") {
      const text = extractAssistantText(evt.message);
      if (!this.currentAssistantId && text) appendChat(this.run, "assistant", text);
      const msg = this.currentAssistantId ? this.run.chat.find((m) => m.id === this.currentAssistantId) : undefined;
      if (msg) msg.pending = false;
      return;
    }
    if (evt.type === "tool_execution_start") {
      emit(this.run, { type: "tool", phase: "start", name: evt.toolName, toolCallId: evt.toolCallId, text: JSON.stringify(evt.args || {}) });
      return;
    }
    if (evt.type === "tool_execution_update") {
      emit(this.run, { type: "tool", phase: "update", name: evt.toolName, toolCallId: evt.toolCallId, text: contentText(evt.partialResult?.content) });
      return;
    }
    if (evt.type === "tool_execution_end") {
      emit(this.run, { type: "tool", phase: "end", name: evt.toolName, toolCallId: evt.toolCallId, text: contentText(evt.result?.content), isError: !!evt.isError });
      return;
    }
    if (evt.type === "extension_error") {
      emit(this.run, { type: "error", message: evt.error || "extension error" });
    }
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function contentText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => b?.text || b?.content || "").join("\n").trim();
  return JSON.stringify(content);
}

function extractAssistantText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content.filter((b: any) => b.type === "text").map((b: any) => b.text || "").join("\n").trim();
  return "";
}

function subscribe(run: Run) {
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (!subscribers.has(run.id)) subscribers.set(run.id, new Set());
      subscribers.get(run.id)!.add(controller);
      // Snapshot is the replay: it contains full chat, artifact, status, and
      // observability-link state. Do not replay historical chat_delta events on
      // reconnect, or the browser would append duplicate text to the snapshot.
      controller.enqueue(encoder.encode(`retry: 2000\nevent: run\ndata: ${JSON.stringify({ type: "run", run: snapshot(run) })}\n\n`));
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); }
        catch { subscribers.get(run.id)?.delete(controller); }
      }, 15_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      subscribers.get(run.id)?.delete(controllerRef);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
    }});
  }

  if (url.pathname === "/health") return json({ ok: true, app: "steelman", runs: runs.size });

  if (url.pathname === "/api/runs" && method === "POST") {
    const body = await parseJson(req);
    const thesis = String(body.thesis || "").trim();
    if (!thesis) return json({ error: "thesis is required" }, 400);
    const run = createRun(thesis);
    startAgent(run, buildPrompt(thesis));
    return json({ run: snapshot(run) }, 201);
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const run = runs.get(runMatch[1]);
    if (!run) return json({ error: "run not found" }, 404);
    return json({ run: snapshot(run) });
  }

  const streamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if (streamMatch && method === "GET") {
    const run = runs.get(streamMatch[1]);
    if (!run) return json({ error: "run not found" }, 404);
    return subscribe(run);
  }

  const msgMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/messages$/);
  if (msgMatch && method === "POST") {
    const run = runs.get(msgMatch[1]);
    if (!run) return json({ error: "run not found" }, 404);
    const body = await parseJson(req);
    const message = String(body.message || "").trim();
    if (!message) return json({ error: "message is required" }, 400);
    appendChat(run, "user", message);
    setStatus(run, "running", "Queued follow-up");
    await run.agent?.prompt(message);
    return json({ run: snapshot(run) });
  }

  const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
  if (artifactMatch && method === "POST") {
    const auth = req.headers.get("authorization") || "";
    if (INTERNAL_TOKEN && auth !== `Bearer ${INTERNAL_TOKEN}`) return json({ error: "unauthorized" }, 401);
    const run = runs.get(artifactMatch[1]);
    if (!run) return json({ error: "run not found" }, 404);
    const body = await parseJson(req);
    const artifact = addArtifact(run, body);
    return json({ artifact }, 201);
  }

  const referenceMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/references$/);
  if (referenceMatch && method === "POST") {
    const auth = req.headers.get("authorization") || "";
    if (INTERNAL_TOKEN && auth !== `Bearer ${INTERNAL_TOKEN}`) return json({ error: "unauthorized" }, 401);
    const run = runs.get(referenceMatch[1]);
    if (!run) return json({ error: "run not found" }, 404);
    const body = await parseJson(req);
    const incoming = Array.isArray(body) ? body : Array.isArray(body?.references) ? body.references : [body];
    const references = addReferences(run, incoming);
    return json({ references }, 201);
  }

  return text("not found", 404);
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  // Product run streams can be quiet while the agent is thinking/researching.
  // Keep SSE connections alive rather than letting Bun's default 10s idle
  // timeout sever the UI before final artifacts/chat arrive.
  idleTimeout: 255,
  fetch: handle,
});
console.log(`Steelman server listening on http://${HOST}:${PORT}`);
console.log("Mode: pi-rpc");
console.log(`Model: ${STEELMAN_MODEL}${STEELMAN_PROVIDER ? ` (provider=${STEELMAN_PROVIDER})` : ""}`);
console.log(`Observability: ${OBS_SERVER_URL} pool=product-steelman`);
