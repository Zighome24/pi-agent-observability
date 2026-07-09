# Usage rollups runbook

Usage APIs read raw `events.payload_json` until a complete rollup backfill has been recorded. After that, `/usage/summary`, `/usage/timeseries`, `/usage/top-runs`, and `/usage/top-agents` read `usage_rollups_daily` and continue to fall back to raw events on fresh databases with no backfill marker.

## Backfill or rebuild

```bash
OBS_DB_PATH=db/obs.db bun scripts/backfill-usage-rollups.ts
```

The script is idempotent: it rebuilds `usage_rollups_daily` inside one SQLite transaction from raw `assistant_message` usage events, then marks `usage_rollup_meta.complete=true`. Running it repeatedly replaces rollups instead of adding to them, so totals do not double-count.

## Live server safety

The server can stay up while the script runs; SQLite WAL plus a single transaction keeps readers on either the old raw/rollup view or the completed new rollup. For the lowest-risk maintenance window on a large DB, restart the server after the backfill completes so all processes observe the same schema and metadata.

Raw events remain the source of truth. If rollups ever look wrong, delete/rebuild them with the same command above.
