#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDb } from "../apps/observability/db.js";

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
    event({ event_id: "a4", session_id: "s4", agent_name: "worker", pool: "beta", tags: ["run:r2", "repo:repoB"], provider: "q", model: "m1", ts: "2026-01-02T01:00:00.000Z", usage: { input: 10, output: 5, cache_read: 100, cache_write: 50, total_tokens: 0, cost_total: 0.2 } }),
  ];

  const ingest = await fetch(`${base}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(events),
  });
  if (!ingest.ok) throw new Error(`ingest failed: ${ingest.status} ${await ingest.text()}`);

  const summary = await getJson("/usage/summary");
  assertEqual(summary.source, "raw", "usage falls back to raw events before rollup backfill");
  assertEqual(summary.totals.total_tokens, 490, "summary total tokens excludes turn_end");
  assertEqual(summary.totals.input_tokens, 320, "summary input tokens");
  assertEqual(summary.totals.output_tokens, 140, "summary output tokens");
  assertEqual(summary.totals.cache_read_tokens, 110, "summary cache read");
  assertEqual(summary.totals.cache_write_tokens, 70, "summary cache write");
  assertClose(summary.totals.cost_total, 2.0, "summary cost_total");
  assertEqual(Object.prototype.hasOwnProperty.call(summary.totals, "total_cost"), false, "usage totals use cost_total field");
  assertEqual(summary.totals.call_count, 4, "summary call count");

  assertEqual((await getJson("/usage/summary?pool=alpha")).totals.total_tokens, 460, "pool filter");
  assertEqual((await getJson("/usage/summary?tag=run:r1")).totals.total_tokens, 460, "tag filter");
  assertEqual((await getJson("/usage/summary?provider=q")).totals.total_tokens, 30, "provider filter derives zero total_tokens from input+output only");
  assertEqual((await getJson("/usage/summary?model=m2")).totals.total_tokens, 300, "model filter");
  assertEqual((await getJson("/usage/summary?agent_name=child")).totals.total_tokens, 300, "agent filter");
  assertEqual((await getJson("/usage/summary?from=2026-01-02T00:00:00.000Z")).totals.total_tokens, 30, "from filter");
  const rawPartialFrom = await getJson("/usage/summary?from=2026-01-01T00:30:00.000Z");
  assertEqual(rawPartialFrom.source, "raw", "partial from initially uses raw");
  assertEqual(rawPartialFrom.totals.total_tokens, 30, "partial from raw timestamp precision");
  const rawPartialTo = await getJson("/usage/summary?to=2026-01-02T00:30:00.000Z");
  assertEqual(rawPartialTo.totals.total_tokens, 475, "partial to raw timestamp precision");

  const runs = await getJson("/usage/top-runs?sort=tokens&limit=1");
  assertEqual(runs.items[0].id, "r1", "top-runs groups run tag");
  assertEqual(runs.items[0].total_tokens, 460, "top-runs total");

  const agents = await getJson("/usage/top-agents?sort=cost&limit=1");
  assertEqual(agents.items[0].id, "child", "top-agents sorted by cost");

  const backfill1 = Bun.spawnSync(["bun", "scripts/backfill-usage-rollups.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OBS_DB_PATH: dbPath },
  });
  if (!backfill1.success) throw new Error(`backfill failed: ${backfill1.stderr.toString()}`);
  const rollupSummary = await getJson("/usage/summary");
  assertEqual(rollupSummary.source, "rollups", "usage reads rollups after backfill");
  assertEqual(rollupSummary.totals.total_tokens, summary.totals.total_tokens, "rollup summary matches raw total tokens");
  assertClose(rollupSummary.totals.cost_total, summary.totals.cost_total, "rollup summary matches raw cost");
  const rollupFullDay = await getJson("/usage/summary?from=2026-01-02T00:00:00.000Z&to=2026-01-02T23:59:59.999Z");
  assertEqual(rollupFullDay.source, "rollups", "full-day-aligned range can use rollups");
  assertEqual(rollupFullDay.totals.total_tokens, 30, "full-day rollup range matches raw semantics");
  const fallbackPartialFrom = await getJson("/usage/summary?from=2026-01-01T00:30:00.000Z");
  assertEqual(fallbackPartialFrom.source, "raw", "partial from falls back to raw after backfill");
  assertEqual(fallbackPartialFrom.totals.total_tokens, rawPartialFrom.totals.total_tokens, "partial from raw/rollup parity");
  const fallbackPartialTo = await getJson("/usage/summary?to=2026-01-02T00:30:00.000Z");
  assertEqual(fallbackPartialTo.source, "raw", "partial to falls back to raw after backfill");
  assertEqual(fallbackPartialTo.totals.total_tokens, rawPartialTo.totals.total_tokens, "partial to raw/rollup parity");

  const backfill2 = Bun.spawnSync(["bun", "scripts/backfill-usage-rollups.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OBS_DB_PATH: dbPath },
  });
  if (!backfill2.success) throw new Error(`second backfill failed: ${backfill2.stderr.toString()}`);
  const rollupSummary2 = await getJson("/usage/summary");
  assertEqual(rollupSummary2.totals.total_tokens, summary.totals.total_tokens, "repeat backfill does not double-count");

  const liveAfterBackfill = event({ event_id: "a5", session_id: "s5", agent_name: "worker", ts: "2026-01-03T00:00:00.000Z", usage: { input: 7, output: 8, total_tokens: 15, cost_total: 0.3 } });
  const liveIngest = await fetch(`${base}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(liveAfterBackfill),
  });
  if (!liveIngest.ok) throw new Error(`post-backfill ingest failed: ${liveIngest.status} ${await liveIngest.text()}`);
  const liveRollupSummary = await getJson("/usage/summary");
  assertEqual(liveRollupSummary.source, "rollups", "post-backfill usage still reads rollups");
  assertEqual(liveRollupSummary.totals.total_tokens, 505, "ingest path updates rollups for new events");

  const invalidSort = await fetch(`${base}/usage/top-runs?sort=bogus`, { headers: { authorization: `Bearer ${token}` } });
  assertEqual(invalidSort.status, 400, "invalid usage sort is rejected");
  const invalidLimit = await fetch(`${base}/usage/top-agents?limit=0`, { headers: { authorization: `Bearer ${token}` } });
  assertEqual(invalidLimit.status, 400, "invalid usage limit is rejected");

  const series = await getJson("/usage/timeseries?bucket=day&group_by=pool");
  assertEqual(series.points.length, 3, "timeseries day/pool point count");
  assertEqual(series.points[0].bucket, "2026-01-01", "timeseries day bucket");
  assertEqual(series.points[0].group, "alpha", "timeseries group");
  assertEqual(series.points[0].total_tokens, 460, "timeseries total");

  const oldDbPath = join(dir, "old-rollup.db");
  const oldDb = new Database(oldDbPath);
  oldDb.run(`
    CREATE TABLE usage_rollups_daily (
      bucket TEXT NOT NULL, pool TEXT NOT NULL DEFAULT 'default', agent_name TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]', input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, cost_total REAL NOT NULL DEFAULT 0, call_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bucket, pool, agent_name, provider, model, run_id, repo, tags_json)
    )
  `);
  oldDb.run("INSERT INTO usage_rollups_daily (bucket, pool, total_tokens, call_count, event_count) VALUES ('2026-01-01', 'alpha', 10, 1, 1)");
  oldDb.close();
  const migrated = createDb(oldDbPath);
  const pk = migrated.query("PRAGMA table_info(usage_rollups_daily)").all() as Array<{ name: string; pk: number }>;
  assertEqual(pk.some((column) => column.name === "session_id" && column.pk > 0), true, "migration adds session_id to rollup primary key");
  migrated.query(`
    INSERT INTO usage_rollups_daily (bucket, pool, agent_name, provider, model, run_id, repo, session_id, tags_json, total_tokens, call_count, event_count)
    VALUES ('2026-01-01', 'alpha', '', '', '', '', '', 's1', '[]', 5, 1, 1)
    ON CONFLICT(bucket, pool, agent_name, provider, model, run_id, repo, session_id, tags_json) DO UPDATE SET total_tokens = usage_rollups_daily.total_tokens + excluded.total_tokens
  `).run();
  migrated.close();

  console.log("usage API smoke passed");
} finally {
  proc.kill();
  await proc.exited.catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
