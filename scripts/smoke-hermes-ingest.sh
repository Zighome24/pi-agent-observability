#!/usr/bin/env bash
# scripts/smoke-hermes-ingest.sh
#
# End-to-end smoke test for Hermes-shaped event ingestion. Expects the
# observability server to already be running on $OBS_SERVER_URL (default
# http://127.0.0.1:43190) with $OBS_AUTH_TOKEN as its bearer token.
set -euo pipefail

URL="${OBS_SERVER_URL:-http://127.0.0.1:43190}"
TOK="${OBS_AUTH_TOKEN:-dev}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${HERMES_FIXTURE_PATH:-${ROOT}/scripts/fixtures/hermes-event-batch.json}"
SID="hermes-smoke-$(date +%s)-$$"

fail() { echo "✗ $*" >&2; exit 1; }
ok()   { echo "✓ $*"; }

[[ -f "${FIXTURE}" ]] || fail "fixture not found: ${FIXTURE}"
command -v bun >/dev/null 2>&1 || fail "bun is required for JSON assertions"

export OBS_SERVER_URL="${URL}"
export OBS_AUTH_TOKEN="${TOK}"
export HERMES_FIXTURE_PATH="${FIXTURE}"
export HERMES_SESSION_ID="${SID}"

bun --eval "$(cat <<'BUN'
const url = process.env.OBS_SERVER_URL;
const token = process.env.OBS_AUTH_TOKEN;
const fixturePath = process.env.HERMES_FIXTURE_PATH;
const sessionId = process.env.HERMES_SESSION_ID;
const expectedUsage = {
  input: 1234,
  output: 56,
  cache_read: 7890,
  cache_write: 12,
  total_tokens: 9192,
  cost_total: 0.0425,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  assert(response.ok, `${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  return body;
}

const fixture = await Bun.file(fixturePath).json();
assert(Array.isArray(fixture), "Hermes fixture must be a JSON event batch");
assert(fixture.length > 0, "Hermes fixture must contain events");
assert(fixture.every((event) => event.pool === "hermes"), "all fixture events must use pool=hermes");
assert(fixture.every((event) => Array.isArray(event.tags) && event.tags.includes("hermes")), "all fixture events must tag hermes");

const now = Date.now();
const events = fixture.map((event, index) => ({
  ...event,
  event_id: `${sessionId}-${String(index).padStart(3, "0")}-${event.type}`,
  session_id: sessionId,
  ts: new Date(now + index * 1000).toISOString(),
  seq: index,
}));

console.log(`→ POST /events (${events.length} Hermes fixture events)`);
const ingest = await request("/events", { method: "POST", body: JSON.stringify(events) });
assert(ingest.ingested === events.length, `expected ingested:${events.length}, got ${JSON.stringify(ingest)}`);
assert(Array.isArray(ingest.rejected) && ingest.rejected.length === 0, `expected no rejected events, got ${JSON.stringify(ingest.rejected)}`);
console.log("✓ ingested Hermes event batch");

console.log("→ GET /sessions?pool=hermes");
const sessions = await request("/sessions?pool=hermes");
const session = sessions.sessions?.find((candidate) => candidate.session_id === sessionId);
assert(session, `session ${sessionId} missing from /sessions?pool=hermes`);
assert(session.pool === "hermes", `expected pool hermes, got ${session.pool}`);
assert(session.tags?.includes("hermes"), `expected hermes tag, got ${JSON.stringify(session.tags)}`);
console.log("✓ Hermes session listed with pool/tag identity");

console.log(`→ GET /sessions/${sessionId}/events`);
const replay = await request(`/sessions/${encodeURIComponent(sessionId)}/events`);
assert(Array.isArray(replay.events), "events replay response missing events array");
assert(replay.events.length === events.length, `expected ${events.length} replay events, got ${replay.events.length}`);
const assistant = replay.events.find((event) => event.type === "assistant_message");
assert(assistant, "assistant_message missing on replay");
for (const [field, expected] of Object.entries(expectedUsage)) {
  const actual = assistant.payload?.usage?.[field];
  assert(actual === expected, `usage.${field} mismatch: expected ${expected}, got ${actual}`);
}
const turnEnd = replay.events.find((event) => event.type === "turn_end");
assert(turnEnd, "turn_end missing on replay");
for (const [field, expected] of Object.entries(expectedUsage)) {
  const actual = turnEnd.payload?.usage?.[field];
  assert(actual === expected, `turn_end usage.${field} mismatch: expected ${expected}, got ${actual}`);
}
console.log("✓ usage and cost fields survived /sessions/:id/events round trip");

console.log(`Hermes smoke session: ${sessionId}`);
BUN
)"

ok "all Hermes ingest smoke checks passed"
