#!/usr/bin/env bun
import * as path from "node:path";
import { createDb, rebuildUsageRollups, getUsageSummary } from "../apps/observability/db.js";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const dbPath = process.env.OBS_DB_PATH ?? path.join(PROJECT_ROOT, "db", "obs.db");

const db = createDb(dbPath);
try {
  const before = getUsageSummary(db, {}).totals;
  const result = rebuildUsageRollups(db);
  const after = getUsageSummary(db, {}).totals;
  console.log(JSON.stringify({
    ok: true,
    dbPath,
    source_events: result.source_events,
    rollup_rows: result.rows,
    totals_match: JSON.stringify(before) === JSON.stringify(after),
    totals: after,
  }, null, 2));
} finally {
  db.close();
}
