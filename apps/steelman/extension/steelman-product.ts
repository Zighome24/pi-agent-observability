import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SYSTEM_PROMPT_FILE = "STEELMAN_AGENT_SYSTEM_PROMPT.md";

// Load the agent's system prompt from the co-located markdown file. Re-read per
// run (each product run is its own pi process) so prompt edits apply on the next
// run without a code change. Tries the module-relative path first, then a path
// relative to the product cwd, then falls back to a minimal inline prompt.
function loadSystemPrompt(): string {
  const candidates: Array<string | URL> = [
    new URL(`./${SYSTEM_PROMPT_FILE}`, import.meta.url),
    path.join(process.cwd(), "extension", SYSTEM_PROMPT_FILE),
  ];
  for (const c of candidates) {
    try {
      const text = fs.readFileSync(c as any, "utf8").trim();
      if (text) return text;
    } catch {
      // try next candidate
    }
  }
  return "You are the Investment Steelman Agent. Produce the strongest credible counterargument to the user's investment thesis. Cite sources inline with markdown links and aggressively emit supporting artifacts via steelman_emit_artifact (minimum 3, preferably one per section).";
}

const ArtifactKind = Type.Union([
  Type.Literal("text"),
  Type.Literal("table"),
  Type.Literal("bar-chart"),
  Type.Literal("pie-chart"),
  Type.Literal("html"),
  Type.Literal("trend"),
  Type.Literal("scorecard"),
  Type.Literal("risk-map"),
]);

function cleanRef(ref: string): string {
  return String(ref || "artifact")
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "artifact";
}

function runCommand(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; text: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, text: `Failed to start ${command}: ${err.message}`, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const text = (stdout || stderr || "").trim();
      resolve({ ok: code === 0, text, code });
    });
  });
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(input: string): string {
  return decodeHtml(input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizeDuckUrl(raw: string): string {
  const decoded = decodeHtml(raw);
  try {
    const withProtocol = decoded.startsWith("//") ? `https:${decoded}` : decoded;
    const url = new URL(withProtocol);
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : withProtocol;
  } catch {
    return decoded;
  }
}

async function genericWebSearch(query: string, limit: number, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; text: string; source: string; results: Array<{ title: string; url: string; snippet: string }> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query }).toString()}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; pi-steelman-agent/1.0; +https://localhost)",
        "accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>|<div[^>]+class="result__snippet"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) && results.length < limit) {
      results.push({
        title: stripHtml(match[2]),
        url: normalizeDuckUrl(match[1]),
        snippet: stripHtml(match[3]),
      });
    }

    // Some result pages omit snippets. Fall back to title+url extraction.
    if (!results.length) {
      const simple = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = simple.exec(html)) && results.length < limit) {
        results.push({ title: stripHtml(match[2]), url: normalizeDuckUrl(match[1]), snippet: "" });
      }
    }

    if (!results.length) return { ok: false, text: "Generic web search returned no parseable results.", source: "duckduckgo-html", results: [] };

    const text = [
      `Generic web search results for: ${query}`,
      "",
      ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`),
    ].join("\n");
    return { ok: true, text, source: "duckduckgo-html", results };
  } catch (err: any) {
    return { ok: false, text: `Generic web search failed: ${err?.message || String(err)}`, source: "duckduckgo-html", results: [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function postArtifact(runId: string, artifact: Record<string, unknown>) {
  const base = process.env.STEELMAN_APP_URL || "http://127.0.0.1:45210";
  const token = process.env.STEELMAN_INTERNAL_TOKEN || "";
  const url = `${base}/api/runs/${encodeURIComponent(runId)}/artifacts`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(artifact),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`artifact post failed: HTTP ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

type ResearchRef = { url: string; title: string };

// Best-effort POST of research sources to the product backend so the UI can
// render a verified "References" list. Never throw — research must not fail
// just because we couldn't ship its proof.
async function postReferences(runId: string, references: ResearchRef[]) {
  if (!runId || !references.length) return;
  const base = process.env.STEELMAN_APP_URL || "http://127.0.0.1:45210";
  const token = process.env.STEELMAN_INTERNAL_TOKEN || "";
  const url = `${base}/api/runs/${encodeURIComponent(runId)}/references`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ references }),
      signal: controller.signal,
    });
  } catch {
    // ignore — references are non-critical proof, not the research payload
  } finally {
    clearTimeout(timer);
  }
}

function dedupeRefs(refs: ResearchRef[]): ResearchRef[] {
  const seen = new Set<string>();
  const out: ResearchRef[] = [];
  for (const r of refs) {
    const url = String(r.url || "").trim().replace(/[)\].,'"]+$/, "");
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: String(r.title || url).replace(/\s+/g, " ").trim().slice(0, 180) });
    if (out.length >= 12) break;
  }
  return out;
}

// Backstop: pull bare URLs out of any text blob (markdown scrape, plain results).
function refsFromText(text: string): ResearchRef[] {
  const out: ResearchRef[] = [];
  const re = /https?:\/\/[^\s)\]<>"']+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ url: m[0], title: m[0] });
  return out;
}

// Walk Firecrawl --json output collecting {url,title} from any nested objects.
function refsFromFirecrawlJson(jsonText: string): ResearchRef[] {
  try {
    const data = JSON.parse(jsonText);
    const out: ResearchRef[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) visit(n); return; }
      const url = node.url || node.link || node.sourceURL || node.source_url;
      if (typeof url === "string") out.push({ url, title: String(node.title || node.name || node.description || url) });
      for (const k of Object.keys(node)) visit(node[k]);
    };
    visit(data);
    return out;
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const instructions = loadSystemPrompt();
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.registerTool({
    name: "steelman_research",
    label: "Research",
    description: "Research an investment thesis, ticker, market, or source. Tries Firecrawl CLI first, then falls back to generic web search.",
    promptSnippet: "Research recent investment facts with Firecrawl first and generic web search fallback",
    promptGuidelines: [
      "Use steelman_research to gather recent facts, market context, company risks, or source material before making evidence-heavy claims.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query or URL to research" }),
      limit: Type.Optional(Type.Number({ description: "Approximate number of search results to request", default: 5 })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const query = String(params.query || "").trim();
      const limit = Math.max(1, Math.min(Number(params.limit || 5), 10));
      const timeoutMs = Number(process.env.FIRECRAWL_TIMEOUT_MS || 20_000);
      const runId = process.env.STEELMAN_RUN_ID || "";
      if (!query) {
        return { content: [{ type: "text", text: "No research query provided." }], isError: true };
      }

      onUpdate?.({ content: [{ type: "text", text: `Searching with Firecrawl: ${query}` }] });

      const firecrawlBin = process.env.FIRECRAWL_BIN || "firecrawl";
      const isUrl = /^https?:\/\//i.test(query);
      const attempts = isUrl
        ? [[firecrawlBin, ["scrape", query, "--format", "markdown"]]]
        : [
            [firecrawlBin, ["search", query, "--limit", String(limit), "--json"]],
            [firecrawlBin, ["search", query, "--limit", String(limit)]],
          ];

      const firecrawlErrors: string[] = [];
      for (const [cmd, args] of attempts as [string, string[]][]) {
        const result = await runCommand(cmd, args, timeoutMs, signal);
        if (result.ok && result.text) {
          const isJson = args.includes("--json");
          const refs = dedupeRefs(
            isUrl
              ? [{ url: query, title: query }, ...refsFromText(result.text)]
              : isJson
                ? [...refsFromFirecrawlJson(result.text), ...refsFromText(result.text)]
                : refsFromText(result.text),
          );
          await postReferences(runId, refs);
          return {
            content: [{ type: "text", text: result.text.slice(0, 20_000) }],
            details: { source: "firecrawl", command: [cmd, ...args], references: refs.length, truncated: result.text.length > 20_000 },
          };
        }
        if (result.text) firecrawlErrors.push(result.text.slice(0, 500));
      }

      onUpdate?.({ content: [{ type: "text", text: `Firecrawl unavailable or empty; falling back to generic web search: ${query}` }] });
      const generic = await genericWebSearch(query, limit, Math.min(timeoutMs, 12_000), signal);
      if (generic.ok) {
        const refs = dedupeRefs([
          ...generic.results.map((r) => ({ url: r.url, title: r.title })),
          ...refsFromText(generic.text),
        ]);
        await postReferences(runId, refs);
        return {
          content: [{ type: "text", text: generic.text.slice(0, 20_000) }],
          details: {
            source: "generic-web-search",
            provider: generic.source,
            references: refs.length,
            firecrawl_attempted: true,
            firecrawl_errors: firecrawlErrors.slice(0, 2),
            truncated: generic.text.length > 20_000,
          },
        };
      }

      const fallback = `Firecrawl and generic web search were unavailable for: ${query}\n\nFirecrawl errors: ${firecrawlErrors.join(" | ") || "none"}\nGeneric fallback: ${generic.text}\n\nProceed using clearly-labeled general knowledge and explicitly state where fresh research would be needed.`;
      return {
        content: [{ type: "text", text: fallback }],
        details: { source: "fallback", query, firecrawl_errors: firecrawlErrors.slice(0, 2), generic_error: generic.text },
      };
    },
  });

  pi.registerTool({
    name: "steelman_emit_artifact",
    label: "Emit UI Artifact",
    description: "Render a structured UI artifact in the product's left panel and return a clickable @reference for chat.",
    promptSnippet: "Create UI artifacts: text, table, bar-chart, pie-chart, or html",
    promptGuidelines: [
      "Use steelman_emit_artifact whenever data, comparisons, risk weights, scenarios, or source summaries would be clearer as UI in the left pane.",
      "After steelman_emit_artifact succeeds, mention its returned @ref in your chat response exactly so users can click it.",
    ],
    parameters: Type.Object({
      ref: Type.String({ description: "Stable short reference without @, e.g. bear-drivers" }),
      kind: ArtifactKind,
      title: Type.String(),
      summary: Type.Optional(Type.String()),
      data: Type.Optional(Type.Any({ description: "Structured data. Tables: {columns, rows} or array of objects. Charts: {labels, values} or [{label,value}]." })),
      markdown: Type.Optional(Type.String()),
      html: Type.Optional(Type.String({ description: "Only for kind=html. Rendered in a sandboxed iframe." })),
    }),
    async execute(_toolCallId, params) {
      const runId = process.env.STEELMAN_RUN_ID;
      if (!runId) {
        return { content: [{ type: "text", text: "STEELMAN_RUN_ID is not configured; artifact was not emitted." }], isError: true };
      }
      const ref = cleanRef(params.ref);
      const artifact = {
        ref,
        kind: params.kind,
        title: params.title,
        summary: params.summary || "",
        data: params.data ?? null,
        markdown: params.markdown || "",
        html: params.html || "",
        createdAt: new Date().toISOString(),
      };
      await postArtifact(runId, artifact);
      return {
        content: [{ type: "text", text: `Rendered @${ref} (${params.kind}) in the product UI.` }],
        details: { ref, kind: params.kind },
      };
    },
  });
}
