# Pi Agent Observability Local Runbook

This directory is a local install of https://github.com/disler/pi-agent-observability for the Hermes/Pi/Beads workflow.

Service
- Start: /home/ziegs/pi-agent-observability/start-observability.sh
- Stop: /home/ziegs/pi-agent-observability/stop-observability.sh
- tmux session: pi-agent-observability
- Health: http://100.121.138.61:43190/health
- UI: http://100.121.138.61:43190/?token=<OBS_AUTH_TOKEN from /home/ziegs/pi-agent-observability/.env>
- DB: /home/ziegs/pi-agent-observability/db/obs.db

Pi agent integration
- Load the observability extension in addition to the agent-team extension:
  pi -e /home/ziegs/pi-agent-observability/extension/pi-observability.ts -e /home/ziegs/pi-vs-claude-code/extensions/agent-team.ts ...
- Required env/flags for observed agents:
  OBS_SERVER_URL=http://100.121.138.61:43190
  OBS_AUTH_TOKEN=<same token as service>
  --o-pool pi-agent-workflow
  --o-tag beads,pi-agent
  --o-name <friendly-agent-or-team-name>

Usage analytics operation
- Long-term usage totals come from stored raw events in SQLite. The canonical counted event is `assistant_message` with `payload.usage`; `turn_end.payload.usage` is only a compatibility fallback for old emitters and must not be added to assistant-message usage for the same turn.
- Usage fields:
  - `input`: prompt/input tokens for the model call.
  - `output`: completion/output tokens.
  - `cache_read` / `cache_write`: provider cache tokens, tracked separately from input/output because cache pricing and context-pressure analysis differ by provider.
  - `total_tokens`: provider-reported total when available; if absent, consumers may derive `input + output` for compatibility.
  - `cost_total`: emitter/provider cost estimate, treated as USD by current dashboards. Missing cost is unknown, not free.
- Aggregation dimensions come from the event envelope and tags: `pool`, exact `tag`, `agent_name`, `provider`, `model`, and timestamp range. Use structured tags consistently:
  - `run:<id>` combines dispatcher/root and child sessions in top-run views; root sessions usually also carry `run_root`, children `run_child`.
  - `repo:<owner/name>` makes repository usage portable across machines and worktrees.
  - `runtime:<runtime>` separates Pi, Hermes, CI, scheduler, or other runtime emitters.
- All agent runtimes must emit the shared usage shape to be included in totals. For new emitters, put usage on `assistant_message.payload.usage`; only use the `turn_end` fallback for legacy compatibility.

Usage API examples
```bash
export OBS_URL="http://100.121.138.61:43190"
export OBS_AUTH_TOKEN="<same token as service>"

# Summary totals for a date range and pool.
curl -sS -H "Authorization: Bearer $OBS_AUTH_TOKEN" \
  "$OBS_URL/usage/summary?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z&pool=pi-agent-workflow"

# Daily model breakdown.
curl -sS -H "Authorization: Bearer $OBS_AUTH_TOKEN" \
  "$OBS_URL/usage/timeseries?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z&bucket=day&group_by=model"

# Most expensive logical runs, including dispatcher and subagents sharing run:<id>.
curl -sS -H "Authorization: Bearer $OBS_AUTH_TOKEN" \
  "$OBS_URL/usage/top-runs?from=2026-07-01T00:00:00Z&limit=10&sort=cost"

# Highest-token agents for this repository tag.
curl -sS -H "Authorization: Bearer $OBS_AUTH_TOKEN" \
  "$OBS_URL/usage/top-agents?from=2026-07-01T00:00:00Z&tag=repo:Zighome24/pi-agent-observability&limit=10&sort=tokens"
```

Persistence and backup
- Active database: `/home/ziegs/pi-agent-observability/db/obs.db`.
- SQLite WAL mode creates sidecar files (`obs.db-wal`, `obs.db-shm`) while the service is running. Do not copy only `obs.db` from a live service unless using SQLite's backup API.
- Preferred backup: run `cd /home/ziegs/pi-agent-observability && just backup`, or manually run `sqlite3 db/obs.db ".backup 'backups/obs_backup_<timestamp>.db'"`.
- Raw events are the source of truth for usage. If rollup tables are added later for speed, treat them as rebuildable caches and preserve the raw events database first.

Notes
- The service is bound to the host Tailscale IP, not public 0.0.0.0.
- Existing Pi sessions only become observable if restarted/launched with the observability extension; already-running processes cannot be instrumented retroactively.
- The upstream app stores canonical events in SQLite and exposes live SSE to the browser UI.
