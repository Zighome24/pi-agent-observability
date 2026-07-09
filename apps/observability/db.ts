/**
 * db.ts — SQLite schema + prepared queries for Pi Observability server.
 *
 * Schema matches SPEC.md §Storage exactly, plus the (session_id, seq) UNIQUE
 * constraint required by the wire contract.
 */

import { Database } from "bun:sqlite";
import type {
  ObsEvent,
  SessionSummary,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
  UsageTopResponse,
} from "../../shared/types.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

const USAGE_ROLLUPS_DAILY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS usage_rollups_daily (
  bucket       TEXT NOT NULL,
  pool         TEXT NOT NULL DEFAULT 'default',
  agent_name   TEXT NOT NULL DEFAULT '',
  provider     TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  run_id       TEXT NOT NULL DEFAULT '',
  repo         TEXT NOT NULL DEFAULT '',
  session_id   TEXT NOT NULL DEFAULT '',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total   REAL NOT NULL DEFAULT 0,
  call_count   INTEGER NOT NULL DEFAULT 0,
  event_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, pool, agent_name, provider, model, run_id, repo, session_id, tags_json)
);
`;

const USAGE_ROLLUPS_DAILY_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_usage_rollups_daily_bucket ON usage_rollups_daily(bucket)",
  "CREATE INDEX IF NOT EXISTS idx_usage_rollups_daily_pool ON usage_rollups_daily(pool)",
  "CREATE INDEX IF NOT EXISTS idx_usage_rollups_daily_model ON usage_rollups_daily(provider, model)",
  "CREATE INDEX IF NOT EXISTS idx_usage_rollups_daily_run ON usage_rollups_daily(run_id)",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  pool         TEXT NOT NULL DEFAULT 'default',
  agent_name   TEXT,
  cwd          TEXT,
  session_file TEXT,
  provider     TEXT,
  model        TEXT,
  first_ts     TEXT NOT NULL,
  last_ts      TEXT NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  tags_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  pool         TEXT NOT NULL DEFAULT 'default',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  provider     TEXT,
  model        TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_pool ON events(pool);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

${USAGE_ROLLUPS_DAILY_TABLE_SQL}
${USAGE_ROLLUPS_DAILY_INDEX_SQL.join(";\n")};

CREATE TABLE IF NOT EXISTS usage_rollup_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreparedQueries {
  insertEvent: ReturnType<Database["query"]>;
  upsertSession: ReturnType<Database["query"]>;
  upsertSessionNoBump: ReturnType<Database["query"]>;
  listSessions: ReturnType<Database["query"]>;
  getSessionEvents: ReturnType<Database["query"]>;
  getSessionContext: ReturnType<Database["query"]>;
  getSessionEventsSince: ReturnType<Database["query"]>;
  getSessionStats: ReturnType<Database["query"]>;
  countTotals: ReturnType<Database["query"]>;
  upsertUsageRollupDaily: ReturnType<Database["query"]>;
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function createDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA);
  migrateUsageRollupsDailySchema(db);
  return db;
}

function migrateUsageRollupsDailySchema(db: Database): void {
  const rollupColumns = db.query("PRAGMA table_info(usage_rollups_daily)").all() as Array<{ name: string; pk: number }>;
  const sessionColumn = rollupColumns.find((column) => column.name === "session_id");
  if (sessionColumn?.pk) return;

  const sessionSelect = sessionColumn ? "COALESCE(session_id, '')" : "''";
  const sessionGroup = sessionColumn ? "session_id" : "''";

  db.transaction(() => {
    db.run("ALTER TABLE usage_rollups_daily RENAME TO usage_rollups_daily_old");
    for (const indexSql of USAGE_ROLLUPS_DAILY_INDEX_SQL) {
      const indexName = indexSql.match(/idx_usage_rollups_daily_[a-z_]+/)?.[0];
      if (indexName) db.run(`DROP INDEX IF EXISTS ${indexName}`);
    }
    db.run(USAGE_ROLLUPS_DAILY_TABLE_SQL);
    db.run(`
      INSERT INTO usage_rollups_daily
        (bucket, pool, agent_name, provider, model, run_id, repo, session_id, tags_json,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total, call_count, event_count)
      SELECT
        bucket, pool, agent_name, provider, model, run_id, repo,
        ${sessionSelect} AS session_id,
        tags_json,
        SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
        SUM(total_tokens), SUM(cost_total), SUM(call_count), SUM(event_count)
      FROM usage_rollups_daily_old
      GROUP BY bucket, pool, agent_name, provider, model, run_id, repo, ${sessionGroup}, tags_json
    `);
    db.run("DROP TABLE usage_rollups_daily_old");
    for (const indexSql of USAGE_ROLLUPS_DAILY_INDEX_SQL) db.run(indexSql);
  })();
}

export function prepare(db: Database): PreparedQueries {
  // ── Insert event (idempotent) ───────────────────────────────────────────
  const insertEvent = db.query(`
    INSERT OR IGNORE INTO events
      (event_id, session_id, seq, ts, type, pool, tags_json, payload_json, provider, model)
    VALUES
      ($event_id, $session_id, $seq, $ts, $type, $pool, $tags_json, $payload_json, $provider, $model)
  `);

  // ── Upsert session (bumps event_count) ──────────────────────────────────
  //
  // COALESCE logic: don't overwrite non-null existing fields with null
  // incoming values. Tags are merged via UNION to accumulate unique tags.
  const upsertSession = db.query(`
    INSERT INTO sessions
      (session_id, pool, agent_name, cwd, session_file, provider, model, first_ts, last_ts, event_count, tags_json)
    VALUES
      ($session_id, $pool, $agent_name, $cwd, $session_file, $provider, $model, $ts, $ts, 1, $tags_json)
    ON CONFLICT(session_id) DO UPDATE SET
      pool         = COALESCE(excluded.pool,         sessions.pool),
      agent_name   = COALESCE(excluded.agent_name,   sessions.agent_name),
      cwd          = COALESCE(excluded.cwd,          sessions.cwd),
      session_file = COALESCE(excluded.session_file, sessions.session_file),
      provider     = COALESCE(excluded.provider,     sessions.provider),
      model        = COALESCE(excluded.model,        sessions.model),
      first_ts     = COALESCE(sessions.first_ts,     excluded.last_ts),
      last_ts      = MAX(excluded.last_ts,           sessions.last_ts),
      event_count  = sessions.event_count + 1,
      tags_json    = (
        SELECT json_group_array(DISTINCT value)
        FROM (
          SELECT value FROM json_each(sessions.tags_json)
          UNION
          SELECT value FROM json_each(excluded.tags_json)
        )
      )
  `);

  // ── Upsert session without bumping event_count (duplicate events) ──────
  const upsertSessionNoBump = db.query(`
    INSERT INTO sessions
      (session_id, pool, agent_name, cwd, session_file, provider, model, first_ts, last_ts, event_count, tags_json)
    VALUES
      ($session_id, $pool, $agent_name, $cwd, $session_file, $provider, $model, $ts, $ts, 1, $tags_json)
    ON CONFLICT(session_id) DO UPDATE SET
      pool         = COALESCE(excluded.pool,         sessions.pool),
      agent_name   = COALESCE(excluded.agent_name,   sessions.agent_name),
      cwd          = COALESCE(excluded.cwd,          sessions.cwd),
      session_file = COALESCE(excluded.session_file, sessions.session_file),
      provider     = COALESCE(excluded.provider,     sessions.provider),
      model        = COALESCE(excluded.model,        sessions.model),
      first_ts     = COALESCE(sessions.first_ts,     excluded.last_ts),
      last_ts      = MAX(excluded.last_ts,           sessions.last_ts),
      tags_json    = (
        SELECT json_group_array(DISTINCT value)
        FROM (
          SELECT value FROM json_each(sessions.tags_json)
          UNION
          SELECT value FROM json_each(excluded.tags_json)
        )
      )
  `);

  // ── List sessions (with optional pool/tag/since/limit filters) ──────────
  const listSessions = db.query(`
    SELECT
      session_id, pool,
      COALESCE(agent_name, '') AS agent_name,
      COALESCE(cwd, '') AS cwd,
      COALESCE(session_file, '') AS session_file,
      COALESCE(provider, '') AS provider,
      COALESCE(model, '') AS model,
      first_ts, last_ts, event_count,
      tags_json
    FROM sessions
    WHERE ($pool = '' OR pool = $pool)
      AND ($tag = '' OR EXISTS (
        SELECT 1 FROM json_each(tags_json) WHERE value = $tag
      ))
      AND (COALESCE($source, '') = '' OR EXISTS (
        SELECT 1 FROM json_each(tags_json) WHERE value = ('source:' || $source)
      ))

    ORDER BY last_ts DESC
    LIMIT $limit
  `);

  // ── Get events for a session (backward pagination) ─────────────────────
  // before_seq: return events with seq < before_seq ordered DESC.
  // When before_seq IS NULL, return latest events up to $limit.
  const getSessionEvents = db.query(`
    SELECT
      event_id, session_id, seq, ts, type, pool, tags_json, payload_json, provider, model
    FROM events
    WHERE session_id = $session_id
      AND ($type = '' OR type = $type)
      AND ($before_seq IS NULL OR seq < $before_seq)
    ORDER BY seq DESC
    LIMIT $limit
  `);

  // ── Get events since seq (forward resync) ──────────────────────────────
  // since_seq: return events with seq > since_seq ordered ASC.
  const getSessionEventsSince = db.query(`
    SELECT
      event_id, session_id, seq, ts, type, pool, tags_json, payload_json, provider, model
    FROM events
    WHERE session_id = $session_id
      AND seq > $since_seq
      AND ($type = '' OR type = $type)
    ORDER BY seq ASC
    LIMIT $limit
  `);

  // ── Session stats (cost, tokens, errors) ──────────────────────────────
  const getSessionStats = db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.total_tokens') ELSE 0 END), 0) AS total_tokens,
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.input') ELSE 0 END), 0)        AS input_tokens,
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.output') ELSE 0 END), 0)       AS output_tokens,
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.cost_total') ELSE 0 END), 0)   AS total_cost,
      COALESCE(SUM(CASE WHEN type = 'error' THEN 1 ELSE 0 END), 0) AS error_count
    FROM events
    WHERE session_id = $session_id
  `);

  // ── Latest assistant_message context size ───────────────────────
  // latest_input ≈ "context tokens used right now" — the full prefix sent to
  // the model on the most recent turn, used as the numerator for the context
  // utilization bar.
  //
  // Formula: usage.input + usage.cache_read + usage.cache_write.
  //
  // This matches pi's own terminal context bar. Verified against a live
  // gemini-3.5-flash session: input=2832, cache_read=98125, cache_write=0,
  // window=1_000_000 → (2832+98125+0)/1_000_000 = 10.1% — exactly what pi
  // terminal showed. The earlier "input only" formula returned ~0.3% here
  // because Gemini caches almost the entire conversation prefix, so most of
  // the in-context tokens move into cache_read after turn 1.
  //
  // For uncached providers (e.g. deepseek), cache_read/cache_write are 0 so
  // the sum collapses to input — preserving the previously-verified
  // deepseek-v4-flash 9% match.
  //
  // The dedicated `cache r` / `cache w` subnav pills still show the cache
  // volume independently for cost-attribution analysis.
  const getSessionContext = db.query(`
    SELECT
      (COALESCE(json_extract(payload_json, '$.usage.input'),       0)
     + COALESCE(json_extract(payload_json, '$.usage.cache_read'),  0)
     + COALESCE(json_extract(payload_json, '$.usage.cache_write'), 0)) AS latest_input,
      ts AS latest_ts
    FROM events
    WHERE session_id = $session_id
      AND type = 'assistant_message'
      AND json_extract(payload_json, '$.usage.input') IS NOT NULL
    ORDER BY seq DESC
    LIMIT 1
  `);

  // ── Totals for /health ──────────────────────────────────────────────────
  const countTotals = db.query(`
    SELECT
      (SELECT COUNT(*) FROM events) AS events_total,
      (SELECT COUNT(*) FROM sessions) AS sessions_total
  `);

  // ── Incremental usage rollup update for newly inserted usage events ─────
  const upsertUsageRollupDaily = db.query(`
    INSERT INTO usage_rollups_daily
      (bucket, pool, agent_name, provider, model, run_id, repo, session_id, tags_json,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total, call_count, event_count)
    SELECT
      substr(e.ts, 1, 10) AS bucket,
      e.pool,
      COALESCE(s.agent_name, '') AS agent_name,
      COALESCE(e.provider, s.provider, '') AS provider,
      COALESCE(e.model, s.model, '') AS model,
      COALESCE((SELECT substr(value, 5) FROM json_each(e.tags_json) WHERE value LIKE 'run:%' LIMIT 1), '') AS run_id,
      COALESCE((SELECT substr(value, 6) FROM json_each(e.tags_json) WHERE value LIKE 'repo:%' LIMIT 1), '') AS repo,
      e.session_id,
      e.tags_json,
      COALESCE(json_extract(e.payload_json, '$.usage.input'), 0) AS input_tokens,
      COALESCE(json_extract(e.payload_json, '$.usage.output'), 0) AS output_tokens,
      COALESCE(json_extract(e.payload_json, '$.usage.cache_read'), 0) AS cache_read_tokens,
      COALESCE(json_extract(e.payload_json, '$.usage.cache_write'), 0) AS cache_write_tokens,
      CASE
        WHEN COALESCE(json_extract(e.payload_json, '$.usage.total_tokens'), 0) > 0 THEN json_extract(e.payload_json, '$.usage.total_tokens')
        ELSE COALESCE(json_extract(e.payload_json, '$.usage.input'), 0)
          + COALESCE(json_extract(e.payload_json, '$.usage.output'), 0)
      END AS total_tokens,
      COALESCE(json_extract(e.payload_json, '$.usage.cost_total'), 0) AS cost_total,
      1 AS call_count,
      1 AS event_count
    FROM events e
    LEFT JOIN sessions s ON s.session_id = e.session_id
    WHERE e.event_id = $event_id
      AND e.type = 'assistant_message'
      AND json_type(e.payload_json, '$.usage') IS NOT NULL
    ON CONFLICT(bucket, pool, agent_name, provider, model, run_id, repo, session_id, tags_json) DO UPDATE SET
      input_tokens = usage_rollups_daily.input_tokens + excluded.input_tokens,
      output_tokens = usage_rollups_daily.output_tokens + excluded.output_tokens,
      cache_read_tokens = usage_rollups_daily.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = usage_rollups_daily.cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = usage_rollups_daily.total_tokens + excluded.total_tokens,
      cost_total = usage_rollups_daily.cost_total + excluded.cost_total,
      call_count = usage_rollups_daily.call_count + excluded.call_count,
      event_count = usage_rollups_daily.event_count + excluded.event_count
  `);

  return {
    insertEvent,
    upsertSession,
    upsertSessionNoBump,
    listSessions,
    getSessionEvents,
    getSessionEventsSince,
    getSessionStats,
    getSessionContext,
    countTotals,
    upsertUsageRollupDaily,
  };
}

// ─── Usage analytics ───────────────────────────────────────────────────────

type UsageSort = "cost" | "tokens";
type UsageBucket = "day" | "week" | "month";
type UsageGroupBy = "pool" | "model" | "agent" | "run" | "repo";

export interface UsageFilters {
  from?: string;
  to?: string;
  pool?: string;
  tag?: string;
  agent_name?: string;
  provider?: string;
  model?: string;
}

export interface UsageTimeseriesOptions extends UsageFilters {
  bucket: UsageBucket;
  group_by?: UsageGroupBy;
}

export interface UsageTopOptions extends UsageFilters {
  limit: number;
  sort: UsageSort;
}

const USAGE_SOURCE_SQL = `
  FROM events e
  LEFT JOIN sessions s ON s.session_id = e.session_id
  WHERE e.type = 'assistant_message'
    AND json_type(e.payload_json, '$.usage') IS NOT NULL
    AND ($from = '' OR e.ts >= $from)
    AND ($to = '' OR e.ts <= $to)
    AND ($pool = '' OR e.pool = $pool)
    AND ($tag = '' OR EXISTS (SELECT 1 FROM json_each(e.tags_json) WHERE value = $tag))
    AND ($agent_name = '' OR COALESCE(s.agent_name, '') = $agent_name)
    AND ($provider = '' OR COALESCE(e.provider, s.provider, '') = $provider)
    AND ($model = '' OR COALESCE(e.model, s.model, '') = $model)
`;

const USAGE_TOTALS_SQL = `
  COALESCE(SUM(COALESCE(json_extract(e.payload_json, '$.usage.input'), 0)), 0) AS input_tokens,
  COALESCE(SUM(COALESCE(json_extract(e.payload_json, '$.usage.output'), 0)), 0) AS output_tokens,
  COALESCE(SUM(COALESCE(json_extract(e.payload_json, '$.usage.cache_read'), 0)), 0) AS cache_read_tokens,
  COALESCE(SUM(COALESCE(json_extract(e.payload_json, '$.usage.cache_write'), 0)), 0) AS cache_write_tokens,
  COALESCE(SUM(
    CASE
      WHEN COALESCE(json_extract(e.payload_json, '$.usage.total_tokens'), 0) > 0 THEN json_extract(e.payload_json, '$.usage.total_tokens')
      ELSE COALESCE(json_extract(e.payload_json, '$.usage.input'), 0)
        + COALESCE(json_extract(e.payload_json, '$.usage.output'), 0)
    END
  ), 0) AS total_tokens,
  COALESCE(SUM(COALESCE(json_extract(e.payload_json, '$.usage.cost_total'), 0)), 0) AS cost_total,
  COUNT(*) AS call_count,
  COUNT(*) AS event_count
`;

function usageParams(filters: UsageFilters): Record<string, string> {
  return {
    $from: filters.from ?? "",
    $to: filters.to ?? "",
    $pool: filters.pool ?? "",
    $tag: filters.tag ?? "",
    $agent_name: filters.agent_name ?? "",
    $provider: filters.provider ?? "",
    $model: filters.model ?? "",
  };
}

function tagValueExpr(prefix: string): string {
  return `(SELECT substr(value, ${prefix.length + 1}) FROM json_each(e.tags_json) WHERE value LIKE '${prefix}%' LIMIT 1)`;
}

function totals(row: any) {
  return {
    input_tokens: Number(row?.input_tokens ?? 0),
    output_tokens: Number(row?.output_tokens ?? 0),
    cache_read_tokens: Number(row?.cache_read_tokens ?? 0),
    cache_write_tokens: Number(row?.cache_write_tokens ?? 0),
    total_tokens: Number(row?.total_tokens ?? 0),
    cost_total: Number(row?.cost_total ?? 0),
    call_count: Number(row?.call_count ?? 0),
    event_count: Number(row?.event_count ?? 0),
  };
}

function hasCompleteUsageRollups(db: Database): boolean {
  const row = db.query("SELECT value FROM usage_rollup_meta WHERE key = 'complete'").get() as any;
  return row?.value === "true";
}

function isFullDayAlignedRange(filters: UsageFilters): boolean {
  return isStartOfDay(filters.from) && isEndOfDay(filters.to);
}

function isStartOfDay(value?: string): boolean {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value);
}

function isEndOfDay(value?: string): boolean {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}T23:59:59(?:\.999)?Z$/.test(value);
}

function shouldUseUsageRollups(db: Database, filters: UsageFilters): boolean {
  return hasCompleteUsageRollups(db) && isFullDayAlignedRange(filters);
}

const ROLLUP_SOURCE_SQL = `
  FROM usage_rollups_daily r
  WHERE ($from = '' OR r.bucket >= substr($from, 1, 10))
    AND ($to = '' OR r.bucket <= substr($to, 1, 10))
    AND ($pool = '' OR r.pool = $pool)
    AND ($tag = '' OR EXISTS (SELECT 1 FROM json_each(r.tags_json) WHERE value = $tag))
    AND ($agent_name = '' OR r.agent_name = $agent_name)
    AND ($provider = '' OR r.provider = $provider)
    AND ($model = '' OR r.model = $model)
`;

const ROLLUP_TOTALS_SQL = `
  COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(r.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(r.total_tokens), 0) AS total_tokens,
  COALESCE(SUM(r.cost_total), 0) AS cost_total,
  COALESCE(SUM(r.call_count), 0) AS call_count,
  COALESCE(SUM(r.event_count), 0) AS event_count
`;


export function rebuildUsageRollups(db: Database): { rows: number; source_events: number } {
  const result = db.transaction(() => {
    db.run("DELETE FROM usage_rollups_daily");
    db.run("DELETE FROM usage_rollup_meta WHERE key IN ('complete', 'rebuilt_at')");
    const insert = db.run(`
      INSERT INTO usage_rollups_daily
        (bucket, pool, agent_name, provider, model, run_id, repo, session_id, tags_json,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total, call_count, event_count)
      SELECT
        substr(e.ts, 1, 10) AS bucket,
        e.pool,
        COALESCE(s.agent_name, '') AS agent_name,
        COALESCE(e.provider, s.provider, '') AS provider,
        COALESCE(e.model, s.model, '') AS model,
        COALESCE((SELECT substr(value, 5) FROM json_each(e.tags_json) WHERE value LIKE 'run:%' LIMIT 1), '') AS run_id,
        COALESCE((SELECT substr(value, 6) FROM json_each(e.tags_json) WHERE value LIKE 'repo:%' LIMIT 1), '') AS repo,
        e.session_id,
        e.tags_json,
        SUM(COALESCE(json_extract(e.payload_json, '$.usage.input'), 0)) AS input_tokens,
        SUM(COALESCE(json_extract(e.payload_json, '$.usage.output'), 0)) AS output_tokens,
        SUM(COALESCE(json_extract(e.payload_json, '$.usage.cache_read'), 0)) AS cache_read_tokens,
        SUM(COALESCE(json_extract(e.payload_json, '$.usage.cache_write'), 0)) AS cache_write_tokens,
        SUM(CASE
          WHEN COALESCE(json_extract(e.payload_json, '$.usage.total_tokens'), 0) > 0 THEN json_extract(e.payload_json, '$.usage.total_tokens')
          ELSE COALESCE(json_extract(e.payload_json, '$.usage.input'), 0)
            + COALESCE(json_extract(e.payload_json, '$.usage.output'), 0)
        END) AS total_tokens,
        SUM(COALESCE(json_extract(e.payload_json, '$.usage.cost_total'), 0)) AS cost_total,
        COUNT(*) AS call_count,
        COUNT(*) AS event_count
      FROM events e
      LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.type = 'assistant_message'
        AND json_type(e.payload_json, '$.usage') IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
    `);
    db.query("INSERT INTO usage_rollup_meta (key, value) VALUES ('complete', 'true'), ('rebuilt_at', datetime('now'))").run();
    const count = db.query("SELECT COUNT(*) AS count FROM events WHERE type = 'assistant_message' AND json_type(payload_json, '$.usage') IS NOT NULL").get() as any;
    return { rows: insert.changes, source_events: Number(count?.count ?? 0) };
  })();
  return result;
}

export function getUsageSummary(db: Database, filters: UsageFilters): UsageSummaryResponse {
  if (shouldUseUsageRollups(db, filters)) {
    const row = db.query(`SELECT ${ROLLUP_TOTALS_SQL} ${ROLLUP_SOURCE_SQL}`).get(usageParams(filters)) as any;
    return { totals: totals(row), source: "rollups" };
  }
  const row = db.query(`SELECT ${USAGE_TOTALS_SQL} ${USAGE_SOURCE_SQL}`).get(usageParams(filters)) as any;
  return { totals: totals(row), source: "raw" };
}

export function getUsageTimeseries(db: Database, options: UsageTimeseriesOptions): UsageTimeseriesResponse {
  const useRollups = shouldUseUsageRollups(db, options);
  const bucketExpr = useRollups
    ? (options.bucket === "month" ? "substr(r.bucket, 1, 7)" : options.bucket === "week" ? "strftime('%Y-W%W', r.bucket)" : "r.bucket")
    : (options.bucket === "month"
      ? "substr(e.ts, 1, 7)"
      : options.bucket === "week"
        ? "strftime('%Y-W%W', e.ts)"
        : "substr(e.ts, 1, 10)");
  const rawGroupExprs: Record<UsageGroupBy, string> = {
    pool: "e.pool",
    model: "COALESCE(e.model, s.model, 'unknown')",
    agent: "COALESCE(s.agent_name, 'unknown')",
    run: `COALESCE(${tagValueExpr("run:")}, 'unknown')`,
    repo: `COALESCE(${tagValueExpr("repo:")}, 'unknown')`,
  };
  const rollupGroupExprs: Record<UsageGroupBy, string> = {
    pool: "r.pool",
    model: "COALESCE(NULLIF(r.model, ''), 'unknown')",
    agent: "COALESCE(NULLIF(r.agent_name, ''), 'unknown')",
    run: "COALESCE(NULLIF(r.run_id, ''), 'unknown')",
    repo: "COALESCE(NULLIF(r.repo, ''), 'unknown')",
  };
  const groupExpr = options.group_by ? (useRollups ? rollupGroupExprs[options.group_by] : rawGroupExprs[options.group_by]) : "'all'";
  const rows = db.query(`
    SELECT ${bucketExpr} AS bucket, ${groupExpr} AS group_value, ${useRollups ? ROLLUP_TOTALS_SQL : USAGE_TOTALS_SQL}
    ${useRollups ? ROLLUP_SOURCE_SQL : USAGE_SOURCE_SQL}
    GROUP BY bucket, group_value
    ORDER BY bucket ASC, cost_total DESC, total_tokens DESC
  `).all(usageParams(options)) as any[];
  return {
    bucket: options.bucket,
    group_by: options.group_by,
    points: rows.map((row) => ({ bucket: row.bucket, group: row.group_value, ...totals(row) })),
    source: useRollups ? "rollups" : "raw",
  };
}

function getUsageTop(db: Database, filters: UsageTopOptions, dimension: "run" | "agent"): UsageTopResponse {
  const useRollups = shouldUseUsageRollups(db, filters);
  const groupExpr = useRollups
    ? (dimension === "run" ? "COALESCE(NULLIF(r.run_id, ''), r.session_id)" : "COALESCE(NULLIF(r.agent_name, ''), 'unknown')")
    : (dimension === "run" ? `COALESCE(${tagValueExpr("run:")}, e.session_id)` : "COALESCE(s.agent_name, 'unknown')");
  const orderExpr = filters.sort === "cost" ? "cost_total" : "total_tokens";
  const rows = db.query(`
    SELECT ${groupExpr} AS id, ${useRollups ? ROLLUP_TOTALS_SQL : USAGE_TOTALS_SQL}
    ${useRollups ? ROLLUP_SOURCE_SQL : USAGE_SOURCE_SQL}
    GROUP BY id
    ORDER BY ${orderExpr} DESC, id ASC
    LIMIT $limit
  `).all({ ...usageParams(filters), $limit: filters.limit }) as any[];
  return {
    dimension,
    sort: filters.sort,
    items: rows.map((row) => ({ id: row.id, ...totals(row) })),
    source: useRollups ? "rollups" : "raw",
  };
}

export function getUsageTopRuns(db: Database, filters: UsageTopOptions): UsageTopResponse {
  return getUsageTop(db, filters, "run");
}

export function getUsageTopAgents(db: Database, filters: UsageTopOptions): UsageTopResponse {
  return getUsageTop(db, filters, "agent");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function toRow(e: ObsEvent): Record<string, unknown> {
  return {
    $event_id: e.event_id,
    $session_id: e.session_id,
    $seq: e.seq,
    $ts: e.ts,
    $type: e.type,
    $pool: e.pool ?? "default",
    $tags_json: JSON.stringify(e.tags ?? []),
    $payload_json: JSON.stringify(e.payload ?? {}),
    $provider: e.provider ?? null,
    $model: e.model ?? null,
  };
}

export function toSessionRow(e: ObsEvent): Record<string, unknown> {
  return {
    $session_id: e.session_id,
    $pool: e.pool ?? "default",
    $agent_name: e.agent_name ?? null,
    $cwd: e.cwd ?? null,
    $session_file: e.session_file ?? null,
    $provider: e.provider ?? null,
    $model: e.model ?? null,
    $ts: e.ts,
    $tags_json: JSON.stringify(e.tags ?? []),
  };
}

export function rowToSession(row: any): SessionSummary {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags_json ?? "[]");
  } catch {
    tags = [];
  }
  return {
    session_id: row.session_id,
    pool: row.pool,
    agent_name: row.agent_name || undefined,
    cwd: row.cwd || undefined,
    session_file: row.session_file || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    first_ts: row.first_ts,
    last_ts: row.last_ts,
    event_count: row.event_count,
    tags,
  };
}

export function rowToEvent(row: any): ObsEvent {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags_json ?? "[]");
  } catch {
    tags = [];
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json ?? "{}");
  } catch {
    payload = {};
  }
  return {
    event_id: row.event_id,
    ts: row.ts,
    type: row.type,
    session_id: row.session_id,
    cwd: row.cwd ?? "",
    pool: row.pool,
    tags,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    payload,
    seq: row.seq,
  } as ObsEvent;
}
