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
const fixturePath = join(import.meta.dir, "fixtures", "usage-event-batch.json");

const expected = {
  totals: {
    total_tokens: 490,
    input_tokens: 320,
    output_tokens: 140,
    cache_read_tokens: 110,
    cache_write_tokens: 70,
    cost_total: 2.0,
    call_count: 5,
    event_count: 5,
  },
  filters: {
    poolAlphaTokens: 460,
    runR1Tokens: 460,
    repoBTokens: 30,
    providerQTokens: 30,
    modelM2Tokens: 300,
    childAgentTokens: 300,
    jan2Tokens: 30,
    partialFromTokens: 330,
    partialToTokens: 475,
  },
  groups: {
    runR1Tokens: 460,
    runR2CacheRead: 100,
    runR2CacheWrite: 50,
    dayPoolPointCount: 3,
    liveAfterBackfillTokens: 505,
  },
};

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

function assertUsageTotals(actual: any, totals: typeof expected.totals, label: string) {
  assertEqual(actual.total_tokens, totals.total_tokens, `${label} total tokens`);
  assertEqual(actual.input_tokens, totals.input_tokens, `${label} input tokens`);
  assertEqual(actual.output_tokens, totals.output_tokens, `${label} output tokens`);
  assertEqual(actual.cache_read_tokens, totals.cache_read_tokens, `${label} cache read`);
  assertEqual(actual.cache_write_tokens, totals.cache_write_tokens, `${label} cache write`);
  assertClose(actual.cost_total, totals.cost_total, `${label} cost_total`);
  assertEqual(actual.call_count, totals.call_count, `${label} call count`);
  assertEqual(actual.event_count, totals.event_count, `${label} event count`);
}

function itemById(response: any, id: string) {
  const item = response.items.find((entry: any) => entry.id === id);
  if (!item) throw new Error(`${response.dimension} item not found: ${id}`);
  return item;
}

function pointBy(response: any, match: Record<string, unknown>) {
  const point = response.points.find((entry: any) => Object.entries(match).every(([key, value]) => entry[key] === value));
  if (!point) throw new Error(`timeseries point not found: ${JSON.stringify(match)}`);
  return point;
}

function validateUsageFixture(events: any[]) {
  assertEqual(Array.isArray(events), true, "usage fixture is an array");
  const ids = new Set<string>();
  const sessionsByRun = new Map<string, Set<string>>();
  let assistantUsageEvents = 0;

  for (const [index, entry] of events.entries()) {
    const label = `fixture event ${index}`;
    assertEqual(typeof entry.event_id, "string", `${label} has event_id`);
    assertEqual(ids.has(entry.event_id), false, `${label} event_id is unique`);
    ids.add(entry.event_id);
    assertEqual(Number.isNaN(Date.parse(entry.ts)), false, `${label} has ISO timestamp`);
    assertEqual(typeof entry.type, "string", `${label} has type`);
    assertEqual(typeof entry.session_id, "string", `${label} has session_id`);
    assertEqual(typeof entry.payload, "object", `${label} has payload`);
    assertEqual(Array.isArray(entry.tags), true, `${label} tags are an array`);

    for (const tag of entry.tags) {
      if (typeof tag === "string" && tag.startsWith("run:")) {
        const sessions = sessionsByRun.get(tag) ?? new Set<string>();
        sessions.add(entry.session_id);
        sessionsByRun.set(tag, sessions);
      }
    }

    const usage = entry.payload?.usage;
    if (entry.type === "assistant_message" && usage !== undefined) assistantUsageEvents++;
    if (usage !== undefined) {
      assertEqual(typeof usage, "object", `${label} usage is an object`);
      for (const key of ["input", "output", "cache_read", "cache_write", "total_tokens", "cost_total"] as const) {
        if (usage[key] !== undefined) {
          assertEqual(typeof usage[key], "number", `${label} usage.${key} is numeric`);
          assertEqual(Number.isFinite(usage[key]), true, `${label} usage.${key} is finite`);
          assertEqual(usage[key] >= 0, true, `${label} usage.${key} is non-negative`);
        }
      }
    }
  }

  assertEqual(assistantUsageEvents, expected.totals.event_count, "fixture assistant usage event count matches expected totals");
  assertEqual((sessionsByRun.get("run:r1")?.size ?? 0) > 1, true, "fixture covers multi-session run aggregation");
}

try {
  await waitForServer();

  const unauthorized = await fetch(`${base}/usage/summary`);
  assertEqual(unauthorized.status, 401, "usage endpoints require auth");

  const events = await Bun.file(fixturePath).json();
  validateUsageFixture(events);
  const ingest = await fetch(`${base}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(events),
  });
  if (!ingest.ok) throw new Error(`ingest failed: ${ingest.status} ${await ingest.text()}`);

  const ingestBody = await ingest.json();
  assertEqual(ingestBody.ingested, events.length, "fixture ingest count");

  const summary = await getJson("/usage/summary");
  assertEqual(summary.source, "raw", "usage falls back to raw events before rollup backfill");
  assertUsageTotals(summary.totals, expected.totals, "summary");
  assertEqual(Object.prototype.hasOwnProperty.call(summary.totals, "total_cost"), false, "usage totals use UI-compatible cost_total field");

  assertEqual((await getJson("/usage/summary?pool=alpha")).totals.total_tokens, expected.filters.poolAlphaTokens, "pool filter");
  assertEqual((await getJson("/usage/summary?tag=run:r1")).totals.total_tokens, expected.filters.runR1Tokens, "tag/run filter");
  assertEqual((await getJson("/usage/summary?tag=repo:repoB")).totals.total_tokens, expected.filters.repoBTokens, "tag/repo filter");
  assertEqual((await getJson("/usage/summary?provider=q")).totals.total_tokens, expected.filters.providerQTokens, "provider filter");
  assertEqual((await getJson("/usage/summary?model=m2")).totals.total_tokens, expected.filters.modelM2Tokens, "model filter");
  assertEqual((await getJson("/usage/summary?agent_name=child")).totals.total_tokens, expected.filters.childAgentTokens, "agent filter");
  assertEqual((await getJson("/usage/summary?from=2026-01-02T00:00:00.000Z&to=2026-01-02T23:59:59.999Z")).totals.total_tokens, expected.filters.jan2Tokens, "date range filter");
  const rawPartialFrom = await getJson("/usage/summary?from=2026-01-01T00:30:00.000Z");
  assertEqual(rawPartialFrom.source, "raw", "partial from initially uses raw");
  assertEqual(rawPartialFrom.totals.total_tokens, expected.filters.partialFromTokens, "partial from raw timestamp precision");
  const rawPartialTo = await getJson("/usage/summary?to=2026-01-02T00:30:00.000Z");
  assertEqual(rawPartialTo.totals.total_tokens, expected.filters.partialToTokens, "partial to raw timestamp precision");

  const runs = await getJson("/usage/top-runs?sort=tokens&limit=2");
  assertEqual(runs.dimension, "run", "top-runs response dimension");
  assertEqual(runs.sort, "tokens", "top-runs response sort");
  assertEqual(runs.items.map((entry: any) => entry.id).join(","), "r1,r2", "top-runs ordered by token total");
  assertEqual(itemById(runs, "r1").total_tokens, expected.groups.runR1Tokens, "top-runs groups multiple sessions by run tag");
  assertEqual(itemById(runs, "r2").cache_read_tokens, expected.groups.runR2CacheRead, "top-runs preserves cache read totals separately");
  assertEqual(itemById(runs, "r2").cache_write_tokens, expected.groups.runR2CacheWrite, "top-runs preserves cache write totals separately");
  assertEqual(itemById(await getJson("/usage/top-runs?sort=tokens&limit=2&provider=q"), "r2").total_tokens, expected.filters.providerQTokens, "top-runs provider filter");

  const agents = await getJson("/usage/top-agents?sort=cost&limit=4");
  assertEqual(agents.dimension, "agent", "top-agents response dimension");
  assertEqual(agents.items.map((entry: any) => entry.id).join(","), "child,dispatcher,worker,unknown", "top-agents ordered by cost");
  assertEqual(itemById(agents, "unknown").total_tokens, 0, "missing agent_name groups as unknown and missing usage fields are zero");

  const series = await getJson("/usage/timeseries?bucket=day&group_by=pool");
  assertEqual(series.bucket, "day", "timeseries echoes day bucket");
  assertEqual(series.group_by, "pool", "timeseries echoes group_by");
  assertEqual(series.points.length, expected.groups.dayPoolPointCount, "timeseries day/pool point count includes empty usage day");
  assertEqual(pointBy(series, { bucket: "2026-01-01", group: "alpha" }).total_tokens, expected.filters.poolAlphaTokens, "timeseries day total");
  assertEqual(pointBy(await getJson("/usage/timeseries?bucket=day&group_by=pool&pool=beta"), { bucket: "2026-01-02", group: "beta" }).total_tokens, expected.filters.repoBTokens, "timeseries pool filter");

  const weeks = await getJson("/usage/timeseries?bucket=week&group_by=repo");
  assertEqual(weeks.bucket, "week", "timeseries echoes week bucket");
  assertEqual(pointBy(weeks, { group: "repoA" }).total_tokens, expected.filters.runR1Tokens, "repo grouping extracts repo tag");

  const months = await getJson("/usage/timeseries?bucket=month&group_by=model");
  assertEqual(months.bucket, "month", "timeseries echoes month bucket");
  assertEqual(pointBy(months, { group: "unknown" }).total_tokens, 0, "missing model groups as unknown for UI table compatibility");

  const backfill1 = Bun.spawnSync(["bun", "scripts/backfill-usage-rollups.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OBS_DB_PATH: dbPath },
  });
  if (!backfill1.success) throw new Error(`backfill failed: ${backfill1.stderr.toString()}`);
  const rollupSummary = await getJson("/usage/summary");
  assertEqual(rollupSummary.source, "rollups", "usage reads rollups after backfill");
  assertUsageTotals(rollupSummary.totals, expected.totals, "rollup summary");
  const rollupFullDay = await getJson("/usage/summary?from=2026-01-02T00:00:00.000Z&to=2026-01-02T23:59:59.999Z");
  assertEqual(rollupFullDay.source, "rollups", "full-day-aligned range can use rollups");
  assertEqual(rollupFullDay.totals.total_tokens, expected.filters.jan2Tokens, "full-day rollup range matches raw semantics");
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
  assertEqual(rollupSummary2.totals.total_tokens, expected.totals.total_tokens, "repeat backfill does not double-count");

  const liveAfterBackfill = event({ event_id: "usage-fixture-007-live", session_id: "usage-live", agent_name: "worker", ts: "2026-01-03T00:00:00.000Z", usage: { input: 7, output: 8, total_tokens: 15, cost_total: 0.3 } });
  const liveIngest = await fetch(`${base}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(liveAfterBackfill),
  });
  if (!liveIngest.ok) throw new Error(`post-backfill ingest failed: ${liveIngest.status} ${await liveIngest.text()}`);
  const liveRollupSummary = await getJson("/usage/summary");
  assertEqual(liveRollupSummary.source, "rollups", "post-backfill usage still reads rollups");
  assertEqual(liveRollupSummary.totals.total_tokens, expected.groups.liveAfterBackfillTokens, "ingest path updates rollups for new events");

  const invalidSort = await fetch(`${base}/usage/top-runs?sort=bogus`, { headers: { authorization: `Bearer ${token}` } });
  assertEqual(invalidSort.status, 400, "invalid usage sort is rejected");
  const invalidLimit = await fetch(`${base}/usage/top-agents?limit=0`, { headers: { authorization: `Bearer ${token}` } });
  assertEqual(invalidLimit.status, 400, "invalid usage limit is rejected");
  const invalidBucket = await fetch(`${base}/usage/timeseries?bucket=hour`, { headers: { authorization: `Bearer ${token}` } });
  assertEqual(invalidBucket.status, 400, "invalid usage bucket is rejected");

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

  console.log("usage API fixture smoke passed");
} finally {
  proc.kill();
  await proc.exited.catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
