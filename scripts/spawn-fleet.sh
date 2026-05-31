#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOK="${OBS_AUTH_TOKEN:-devtoken}"
URL="${OBS_SERVER_URL:-http://127.0.0.1:43190}"
EXT="$ROOT/extension/pi-observability.ts"

run() {
  local name="$1" prompt="$2"
  ( OBS_AUTH_TOKEN="$TOK" OBS_SERVER_URL="$URL" \
    pi -e "$EXT" --o-pool integration-v2 --o-tag fleet \
       --o-name "$name" -p "$prompt" \
       > "/tmp/fleet-${name}.log" 2>&1 ) &
  echo "[$$] spawned $name (pid $!)"
}

run planner  "You must use exactly 2 separate tool calls. First, run \`echo planner-start\`. Second, run \`ls /tmp | head -5\`. Do not combine them. Briefly summarize what /tmp has."
run reviewer "You must use exactly 2 separate tool calls. First, run \`echo reviewer-start\`. Second, read $ROOT/README.md. Do not combine them. Quote the first heading."
run tester   "You must use exactly 3 separate tool calls. First, run \`echo tester-start\`. Second, run \`date\`. Third, run \`uname -a\`. Do not combine them. Output: which is more useful for testing?"

wait
echo "fleet done"

# Assert 3 sessions arrived in the pool
N=$(curl -fsS -H "Authorization: Bearer $TOK" "$URL/sessions?pool=integration-v2&tag=fleet" \
     | python3 -c "import sys,json; print(len(json.load(sys.stdin)['sessions']))")
[ "$N" -ge 3 ] || { echo "expected >=3 sessions, got $N"; exit 1; }
echo "✓ fleet produced $N sessions"
