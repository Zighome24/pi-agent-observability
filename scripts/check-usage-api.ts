#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = "usage-test-token";
const port = 43291 + Math.floor(Math.random() * 1000);
const dir = mkdtempSync(join(tmpdir(), "pi-usage-api-"));
const dbPath = join(dir, "obs.db");
const base = `http://127.0.0.1:${port}`;

const proc = Bun.spawn(["bun", "server.ts"], {
  cwd: join(import.meta.dir, "..", "apps", "observability"),
  env: { ...process.env, OBS_AUTH_TOKEN: token, OBS_HOST: "127.0.0.1", OBS_PORT: String(port), OBS_DB_PATH: dbPath },
  stdout: "pipe",
  stderr: "pipe",
});

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not become healthy");
}

function event(overrides: Record<string, any>) {
  return {
    event_id: overrides.event_id,
    ts: overrides.ts ?? "2026-01-01T00:00:00.000Z",
    type: overrides.type ?? "assistant_message",
    session_id: overrides.session_id,
    cwd: "/repo",
    agent_name: overrides.agent_name,
    pool: overrides.pool ?? "alpha",
    tags: overrides.tags ?? [],
    provider: overrides.provider ?? "p",
    model: overrides.model ?? "m1",
    payload: overrides.payload ?? { text: "ok", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: overrides.usage },
    seq: overrides.seq ?? 0,
  };
}

async function getJson(path: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual: number, expected: number, label: string) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

try {
  await waitForServer();

  const unauthorized = await fetch(`${base}/usage/summary`);
  assertEqual(unauthorized.status, 401, "usage endpoints require auth");

  const events = [
    event({ event_id: "a1", session_id: "s1", agent_name: "dispatcher", tags: ["run:r1", "repo:repoA", "runtime:bun"], usage: { input: 100, output: 50, cache_read: 10, cache_write: 0, total_tokens: 160, cost_total: 0.5 } }),
    event({ event_id: "t1", type: "turn_end", session_id: "s1", agent_name: "dispatcher", tags: ["run:r1", "repo:repoA"], payload: { turn_index: 0, usage: { input: 100, output: 50, total_tokens: 150, cost_total: 99 } }, seq: 1 }),
    event({ event_id: "a2", session_id: "s2", agent_name: "child", tags: ["run:r1", "repo:repoA"], model: "m2", usage: { input: 200, output: 80, cache_read: 0, cache_write: 20, total_tokens: 300, cost_total: 1.2 } }),
    event({ event_id: "a3", session_id: "s3", agent_name: "worker", pool: "beta", tags: ["run:r2", "repo:repoB"], provider: "q", model: "m1", ts: "2026-01-02T00:00:00.000Z", usage: { input: 10, output: 5, total_tokens: 15, cost_total: 0.1 } }),
  ];

  const ingest = await fetch(`${base}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(events),
  });
  if (!ingest.ok) throw new Error(`ingest failed: ${ingest.status} ${await ingest.text()}`);

  const summary = await getJson("/usage/summary");
  assertEqual(summary.totals.total_tokens, 475, "summary total tokens excludes turn_end");
  assertEqual(summary.totals.input_tokens, 310, "summary input tokens");
  assertEqual(summary.totals.output_tokens, 135, "summary output tokens");
  assertEqual(summary.totals.cache_read_tokens, 10, "summary cache read");
  assertEqual(summary.totals.cache_write_tokens, 20, "summary cache write");
  assertClose(summary.totals.total_cost, 1.8, "summary cost");
  assertEqual(summary.totals.call_count, 3, "summary call count");

  assertEqual((await getJson("/usage/summary?pool=alpha")).totals.total_tokens, 460, "pool filter");
  assertEqual((await getJson("/usage/summary?tag=run:r1")).totals.total_tokens, 460, "tag filter");
  assertEqual((await getJson("/usage/summary?provider=q")).totals.total_tokens, 15, "provider filter");
  assertEqual((await getJson("/usage/summary?model=m2")).totals.total_tokens, 300, "model filter");
  assertEqual((await getJson("/usage/summary?agent_name=child")).totals.total_tokens, 300, "agent filter");
  assertEqual((await getJson("/usage/summary?from=2026-01-02T00:00:00.000Z")).totals.total_tokens, 15, "from filter");

  const runs = await getJson("/usage/top-runs?sort=tokens&limit=1");
  assertEqual(runs.items[0].id, "r1", "top-runs groups run tag");
  assertEqual(runs.items[0].total_tokens, 460, "top-runs total");

  const agents = await getJson("/usage/top-agents?sort=cost&limit=1");
  assertEqual(agents.items[0].id, "child", "top-agents sorted by cost");

  const series = await getJson("/usage/timeseries?bucket=day&group_by=pool");
  assertEqual(series.points.length, 2, "timeseries day/pool point count");
  assertEqual(series.points[0].bucket, "2026-01-01", "timeseries day bucket");
  assertEqual(series.points[0].group, "alpha", "timeseries group");
  assertEqual(series.points[0].total_tokens, 460, "timeseries total");

  console.log("usage API smoke passed");
} finally {
  proc.kill();
  await proc.exited.catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
