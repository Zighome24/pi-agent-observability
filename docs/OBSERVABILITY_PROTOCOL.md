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
```

### Hermes conventions

Hermes emitters should use:

- `pool: "hermes"`
- `agent_name`: the Hermes agent/profile display name, for example `Hermes reviewer` or `Hermes smoke fixture`.
- `tags`: include `hermes` for compatibility with existing fixtures, plus structured dimensions such as `runtime:hermes`, `platform:<os-or-host>`, `profile:<hermes-profile>`, and `source:<local|ci|cron|scheduler>`.

The compatibility fixture at [`../scripts/fixtures/hermes-event-batch.json`](../scripts/fixtures/hermes-event-batch.json) demonstrates the minimum accepted Hermes-shaped event batch.

### Pi conventions

Pi extension events typically use a stable Pi session id, optional `session_file`, the current `cwd`, `agent_name` from `--o-name`, `pool` from `--o-pool`, and tags from repeated `--o-tag` flags. The compatibility fixture at [`../scripts/fixtures/pi-event-batch.json`](../scripts/fixtures/pi-event-batch.json) demonstrates a Pi-shaped event batch.

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
