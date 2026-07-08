# Agent Observability Protocol

This document describes the wire protocol accepted by the Pi Observability server. Although the first emitter is the Pi extension, the protocol is intentionally agent-agnostic: Hermes or any other agent runtime can emit the same envelopes without a schema migration.

## Transport and endpoints

Agents send JSON over HTTP to the observability server:

- `POST /events` ingests one event object or an array of event objects.
- `GET /sessions`, `GET /sessions/:session_id/events`, and `GET /sessions/:session_id/stats` replay stored data.
- `GET /events/stream` streams live events as Server-Sent Events (SSE).
- `GET /health` is unauthenticated and returns server status.

The server stores the event envelope plus `payload` as JSON. Payload columns are not normalized, so compatible payload additions do not require a database migration.

## Authentication

All routes except `/health`, `/`, `/index.html`, and static assets require the token configured as `OBS_AUTH_TOKEN`.

Clients may authenticate with either:

```http
Authorization: Bearer <OBS_AUTH_TOKEN>
```

or, for browser/SSE URLs only when necessary:

```txt
?token=<OBS_AUTH_TOKEN>
```

Prefer the bearer header for ingest. Treat query tokens as copy/paste UI conveniences because URLs are commonly logged.

## Event envelope

The canonical TypeScript shape is `ObsEventEnvelope` in [`../shared/types.ts`](../shared/types.ts). Every event uses this envelope:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `event_id` | yes | string | Client-generated globally unique id. Duplicate ids are rejected/idempotent. UUIDv4 or another collision-resistant id is recommended. |
| `ts` | yes | string | Client clock timestamp in ISO-8601 UTC with milliseconds, e.g. `2026-06-11T18:00:00.000Z`. |
| `type` | yes | string | Event discriminator; see [Event types](#event-types). |
| `session_id` | yes | string | Stable id for one observed agent session/run. |
| `session_file` | no | string | Path to a transcript/session file when the source has one. Pi uses the absolute `session.jsonl` path. |
| `cwd` | yes | string | Agent working directory. If unavailable, send `""` rather than omitting it. |
| `agent_name` | no | string | Human-friendly display name. |
| `pool` | yes | string | Logical bucket for filtering fleets. Server currently defaults missing values to `default`, but emitters should always send one. |
| `tags` | yes | string[] | Flat labels for platform/profile/source filters. Server currently defaults missing values to `[]`, but emitters should always send an array. |
| `provider` | no | string | Model provider, e.g. `anthropic`, `openai`, `google`. |
| `model` | no | string | Model name/id used for the event or current turn. |
| `payload` | yes | object | Event-specific JSON payload. |
| `seq` | yes | number | Monotonic integer per `session_id`, starting at `0`. |

### Minimal example

```json
{
  "event_id": "example-session-000",
  "ts": "2026-06-11T18:00:00.000Z",
  "type": "session_start",
  "session_id": "example-session",
  "cwd": "/workspace/project",
  "agent_name": "Hermes profile smoke",
  "pool": "hermes",
  "tags": ["hermes", "linux", "profile:smoke", "source:ci"],
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "payload": { "reason": "startup" },
  "seq": 0
}
```

## Event types

Supported `type` values are:

```txt
session_start  session_shutdown  agent_start  agent_end
turn_start     turn_end          user_message assistant_message
thinking       tool_call         tool_result  model_change
compaction     branch_nav        error        custom
```

Payloads are a discriminated union in [`../shared/types.ts`](../shared/types.ts). Emitters that cannot produce a Pi-specific payload should prefer the common lifecycle/turn/message/tool subset and use `custom` for runtime-specific annotations.

Common payload conventions:

- `session_start`: `{ "reason": "startup" | "reload" | "new" | "resume" | "fork" | string }`
- `turn_start`: `{ "turn_index": number }`
- `user_message`: `{ "text": string, "images_count": number }`
- `assistant_message`: includes `text`, `thinking`, `tool_call_ids`, `stop_reason`, optional timing fields, and `usage`.
- `turn_end`: includes `turn_index` and may repeat `usage` for turn rollups.
- `tool_call`: includes `tool_call_id`, `tool_name`, JSON-safe `args`, and `args_truncated`.
- `tool_result`: includes `tool_call_id`, `tool_name`, `content_text`, `content_truncated`, `is_error`, and optional `details_summary`.
- `model_change`: captures provider/model transitions.
- `error`: `{ "message": string, "where": string }`.
- `custom`: `{ "custom_type": string, "data": unknown }`; use namespaced `custom_type` values such as `hermes.scheduler.tick`.

Usage objects, when available, should use:

```json
{
  "input": 1234,
  "output": 56,
  "cache_read": 7890,
  "cache_write": 12,
  "total_tokens": 9192,
  "cost_total": 0.0425
}
```

Use `0` for known-zero values. Omit `usage` only when usage is unknown.

## Usage aggregation and historical-query semantics

Long-term token and cost analytics are computed from stored raw events; any future rollup tables are caches that must be rebuildable from those events. The rules below define how historical queries should interpret existing `payload.usage` objects and avoid double-counting.

### Counting source of truth

- **Default authoritative source:** count usage from `assistant_message.payload.usage`. Each assistant message represents one completed model call and is the unit for token/cost totals, call counts, provider/model breakdowns, and top-N reports.
- **Do not add `turn_end` usage on top of `assistant_message` usage.** `turn_end.payload.usage` is a compatibility/session-summary rollup and may repeat the same tokens from the assistant message for that turn.
- **Compatibility fallback:** if a turn has no `assistant_message` with usage, a query may count `turn_end.payload.usage` for that turn. Mark these rows internally as fallback-derived when possible so operators can distinguish old runtimes from normal per-call accounting.
- **Fallback matching:** match `turn_end` fallback rows by exact `session_id` + numeric `payload.turn_index`. If `turn_index` is missing/non-numeric, treat that `turn_end` as session-level legacy usage only when the session has no assistant-message usage at all; otherwise leave it out of aggregate totals and count it in diagnostics.
- **Multiple assistant messages in one turn:** count each `assistant_message.payload.usage` row as a distinct model call. A `turn_end` rollup for that same `session_id` + `turn_index` remains non-authoritative and must not be added on top.
- **Mixed turn rule:** if a turn/session has both assistant-message usage and turn-end usage for the same `session_id` + `turn_index`, prefer the assistant-message rows and ignore the turn-end usage for aggregation.
- **Call/event counts:** `call_count` should count assistant-message usage rows plus fallback turn-end rows only. Other event types do not increase usage call counts.

### Token fields

- `input`: prompt/input tokens reported by the provider for the model call. Sum it for prompt-token totals.
- `output`: completion/output tokens reported by the provider. Sum it for generated-token totals.
- `cache_read`: cached-context tokens read by the provider. Track and expose separately; do not merge into `input` unless a UI explicitly labels the result as context volume.
- `cache_write`: tokens written into provider cache. Track and expose separately.
- `total_tokens`: provider-reported total when available. Historical queries should sum `total_tokens` for a `total_tokens` field, but should not assume every provider defines it identically. If `total_tokens` is missing/null, derive a compatibility total as `input + output` for billable-token-style charts and expose that it is derived when the response shape allows.
- **Context volume:** for context-pressure views only, compute `context_tokens = input + cache_read + cache_write`. Keep this separate from `total_tokens`, billable totals, and cost.

### Cost fields

- `cost_total` is the provider/emitter's total cost estimate for the model call. New emitters should report normalized USD unless they also include explicit currency/pricing metadata in a future additive schema. Current dashboard totals treat this field as USD; do not mix currencies in aggregate dashboards without a conversion policy.
- Cache read/write tokens must remain visible as their own dimensions because providers price them differently. Do not infer cache costs from token counts in historical queries unless an explicit pricing table/version is part of that query.
- Missing `cost_total` means cost is unknown, not free. For numeric sums treat missing/null as `0` and include a `cost_known_count`/`cost_missing_count`-style diagnostic where practical.

### Missing, null, and malformed usage

Historical data may predate optional fields. Query implementations should be forgiving:

- Missing `usage` object: event contributes no usage totals and no call count, except the `turn_end` fallback rule above when it does contain usage.
- Missing numeric field inside `usage`: treat as `0` for sums of that field, and as unknown for diagnostics.
- Explicit `null`, non-number, `NaN`, or negative token/cost values: do not add to totals; treat as unknown/malformed and prefer surfacing a malformed count over failing the whole query.
- Known-zero values should be emitted and stored as `0`; consumers should not confuse `0` with a missing field.

### Idempotency and duplicates

- `event_id` is the global idempotency key. Ingest rejects duplicate `event_id` values, so historical queries over the canonical events table should see only one stored copy.
- If a query processes exported JSON or another source that may contain duplicates, de-duplicate by `event_id` before aggregation.
- `(session_id, seq)` is also unique in the server store and should not be reused for a different logical event. If both keys conflict in offline data, prefer the first persisted event and count the conflict as malformed input.

### Session and run grouping

- A `session_id` is one observed agent session. Session-level usage is the sum of authoritative usage rows for that session.
- A run group is all sessions sharing the same `run:<run-id>` tag. This includes the dispatcher/root session tagged `run_root` and any subagent sessions tagged `run_child`.
- `session_start.payload.run_id`, `parent_run_id`, and related fields are detail metadata; the structured `run:<id>` tag is the query key for grouping across sessions.
- If a session has no `run:<id>` tag, treat it as an ungrouped single-session run for top-run views, using `session_id` as the fallback group key and labeling the run id as null/unknown when possible.

### Filter and bucket dimensions

Historical usage endpoints should support filtering and grouping by these dimensions when present in the event envelope/tags:

- Date range over event timestamp `ts` (`from`, `to`) and bucket size (`hour`, `day`, `week`, `month` as supported by the endpoint).
- `pool`.
- Exact tag, including `run:<id>`, `repo:<owner/name>`, `runtime:<runtime>`, `platform:<platform>`, `profile:<profile>`, and `source:<source>`.
- `agent_name`.
- `provider` and `model`, taken from the usage event envelope unless a payload explicitly overrides it in a future additive schema.
- `cwd`/repo where available; prefer `repo:<owner/name>` tags for stable cross-machine repository grouping.

### Recommended aggregate response fields

Usage summaries and time buckets should keep billable, cache, and diagnostic values distinct:

```txt
input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
total_tokens, context_tokens, cost_total,
call_count, event_count,
cost_known_count, cost_missing_count, usage_missing_count, malformed_usage_count,
total_tokens_reported_count, total_tokens_derived_count, total_tokens_missing_count
```

`event_count` may count all matched events for diagnostics, but it is not a model-call count. `call_count` is the count of rows that contributed authoritative or fallback usage.

## Batching, idempotency, and ordering

`POST /events` accepts either a single envelope or an array of envelopes. The Pi extension batches up to 50 events; other agents should keep request bodies comfortably below `MAX_REQUEST_BYTES` (`4 MiB`) and retry failed batches with the same `event_id` values.

Ordering rules:

1. `seq` is monotonic within each `session_id` and starts at `0`.
2. Do not reuse a `(session_id, seq)` for a different logical event.
3. `ts` is useful for wall-clock display, but replay ordering is based on `seq`.
4. `event_id` makes ingest idempotent. Re-sending an already stored id is reported in `rejected` and does not update the existing event.
5. Send all events for one session through one sequencing authority. If multiple processes emit for the same session, coordinate sequence assignment before ingest.

The server currently normalizes missing `pool`, `tags`, `seq`, and `cwd` for backward compatibility, but new emitters should not rely on those defaults.

## Truncation and large fields

Emitters are responsible for truncating large text/JSON fields before sending. Current shared limits are exported from [`../shared/types.ts`](../shared/types.ts):

- `MAX_TEXT_FIELD`: `32_000` bytes for long text fields.
- `MAX_ARGS_BYTES`: `16_000` bytes for tool-call args JSON.
- `MAX_RESULT_BYTES`: `32_000` bytes for tool result text.
- `MAX_REQUEST_BYTES`: `4 * 1024 * 1024` bytes server-side request body cap.

When truncating, preserve a boolean marker on the payload (`args_truncated`, `content_truncated`, `system_prompt_truncated`, etc.) and, where possible, include pre-truncation byte length plus a digest (`sha256`) so consumers can detect drift without storing full content.

## Source identity conventions

Use the envelope identity fields consistently so dashboard filters work across runtimes:

- `pool`: the broad runtime or experiment fleet (`pi`, `hermes`, `smoke`, `default`).
- `agent_name`: a human-readable role/profile name, not a unique id unless no better label exists.
- `tags`: flat strings for dimensions that may be filtered independently.

Recommended tag forms:

```txt
runtime:<runtime>        # runtime:pi, runtime:hermes
platform:<platform>      # platform:linux, platform:darwin, platform:github-actions
profile:<profile>        # profile:reviewer, profile:builder, profile:smoke
source:<source>          # source:local, source:ci, source:cron, source:scheduler
repo:<owner/name>        # repo:Zighome24/pi-agent-observability, when useful
run:<run-id>             # stable logical run joining dispatcher + subagents
run_root                 # this session established the run context
run_child                # this session inherited the run context
parent_run:<run-id>      # parent/root run id for child sessions
parent:<run-name>        # human-readable parent/root run name for child sessions
parent_session:<id>      # parent/root session id for child sessions
```

Run grouping is intentionally implemented as tags so existing `/sessions?tag=run:<id>` filters and SSE tag subscriptions can show all sessions in the run without a database migration. `session_start.payload` may also include optional `run_id`, `run_name`, `parent_run_id`, `parent_run_name`, `parent_session_id`, and `is_run_root` for detail views and future richer grouping.

### Hermes conventions

Hermes emitters should use:

- `pool: "hermes"`
- `agent_name`: the Hermes agent/profile display name, for example `Hermes reviewer` or `Hermes smoke fixture`.
- `tags`: include `hermes` for compatibility with existing fixtures, plus structured dimensions such as `runtime:hermes`, `platform:<os-or-host>`, `profile:<hermes-profile>`, and `source:<local|ci|cron|scheduler>`.

The compatibility fixture at [`../scripts/fixtures/hermes-event-batch.json`](../scripts/fixtures/hermes-event-batch.json) demonstrates the minimum accepted Hermes-shaped event batch.

### Pi conventions

Pi extension events typically use a stable Pi session id, optional `session_file`, the current `cwd`, `agent_name` from `--o-name`, `pool` from `--o-pool`, and tags from repeated `--o-tag` flags. The extension also adds `run:<id>` plus `run_root`/`run_child` tags automatically. Root sessions use `--o-run-id`, `OBS_RUN_ID`, `--o-name`, or the session id as the run id; child Pi processes inherit `OBS_PARENT_RUN_*` environment values from the root so dispatcher and subagents can be filtered together. The compatibility fixture at [`../scripts/fixtures/pi-event-batch.json`](../scripts/fixtures/pi-event-batch.json) demonstrates a Pi-shaped event batch.

## Compatibility and versioning

The current protocol version is the event shape in `shared/types.ts` plus the server version returned by `/health`. Until an explicit negotiated protocol version is introduced, compatibility is additive:

- Adding optional envelope fields is allowed.
- Adding optional payload fields is allowed.
- Adding a new event type should be treated as a minor capability increase; older UIs should ignore unknown event types or render them as generic/custom events.
- Changing required field names, changing scalar types, removing fields, or changing `seq` semantics is breaking and should require a planned migration.
- Prefer `custom` events or optional payload fields for agent-specific data before changing the shared schema.

This issue intentionally adds documentation and fixture checks only; it does not require or introduce a breaking schema migration.

## Fixture compatibility checks

Protocol fixtures live in [`../scripts/fixtures/`](../scripts/fixtures/):

- [`pi-event-batch.json`](../scripts/fixtures/pi-event-batch.json)
- [`hermes-event-batch.json`](../scripts/fixtures/hermes-event-batch.json)

Run the shape/order check with:

```bash
bun scripts/check-protocol-fixtures.ts
```

For ingest round-trip coverage, start the observability server with an isolated database and run:

```bash
bash scripts/smoke-server.sh
bash scripts/smoke-hermes-ingest.sh
```
