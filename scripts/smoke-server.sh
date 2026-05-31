#!/usr/bin/env bash
# scripts/smoke-server.sh
#
# End-to-end smoke test for the Pi Observability server. Expects the server
# to already be running on $OBS_SERVER_URL (default http://127.0.0.1:43190)
# with $OBS_AUTH_TOKEN as its bearer token.
#
# Usage:
#   OBS_AUTH_TOKEN=dev bun --cwd apps/observability start &
#   OBS_AUTH_TOKEN=dev bash scripts/smoke-server.sh
set -euo pipefail

URL="${OBS_SERVER_URL:-http://127.0.0.1:43190}"
TOK="${OBS_AUTH_TOKEN:-dev}"
H=(-H "Authorization: Bearer ${TOK}" -H "Content-Type: application/json")

fail() { echo "✗ $*" >&2; exit 1; }
ok()   { echo "✓ $*"; }

echo "→ GET /health"
curl -fsS "${URL}/health" "${H[@]}" | tee /tmp/obs_health.json
grep -q '"ok":true' /tmp/obs_health.json || fail "health response missing ok:true"
ok "/health"

SID="smoke-$(date +%s)-$$"
EID() { echo "evt-${SID}-$1"; }
TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

echo "→ POST /events (session_start)"
curl -fsS -X POST "${URL}/events" "${H[@]}" \
  -d "$(cat <<JSON
{
  "event_id":"$(EID 0)","ts":"${TS}","type":"session_start",
  "session_id":"${SID}","cwd":"/tmp/smoke","pool":"smoke","tags":["smoke"],
  "provider":"anthropic","model":"claude-sonnet-4-5",
  "payload":{"reason":"startup"},
  "seq":0
}
JSON
)" | tee /tmp/obs_ingest.json
grep -q '"ingested":1' /tmp/obs_ingest.json || fail "expected ingested:1"
ok "ingested session_start"

echo "→ POST /events (assistant_message)"
curl -fsS -X POST "${URL}/events" "${H[@]}" \
  -d "$(cat <<JSON
{
  "event_id":"$(EID 1)","ts":"${TS}","type":"assistant_message",
  "session_id":"${SID}","cwd":"/tmp/smoke","pool":"smoke","tags":["smoke"],
  "provider":"anthropic","model":"claude-sonnet-4-5",
  "payload":{"text":"hi","thinking":"","tool_call_ids":[],"stop_reason":"stop",
             "usage":{"input":10,"output":1,"cache_read":0,"cache_write":0,"total_tokens":11,"cost_total":0.0001}},
  "seq":1
}
JSON
)" | tee -a /tmp/obs_ingest.json
ok "ingested assistant_message"

echo "→ GET /sessions"
curl -fsS "${URL}/sessions?pool=smoke" "${H[@]}" | tee /tmp/obs_sessions.json
grep -q "${SID}" /tmp/obs_sessions.json || fail "session ${SID} missing from /sessions"
ok "/sessions"

echo "→ GET /sessions/${SID}/events"
curl -fsS "${URL}/sessions/${SID}/events" "${H[@]}" | tee /tmp/obs_session_events.json
grep -q '"type":"session_start"' /tmp/obs_session_events.json || fail "session_start missing on replay"
grep -q '"type":"assistant_message"' /tmp/obs_session_events.json || fail "assistant_message missing on replay"
ok "/sessions/:id/events"

echo "→ SSE /events/stream (1.5s window)"
( curl -fsS -N --max-time 1.5 "${URL}/events/stream?pool=smoke&token=${TOK}" || true ) | head -c 4096 | tee /tmp/obs_sse.txt >/dev/null
ok "/events/stream opened"

echo
echo "✓ all smoke checks passed"
