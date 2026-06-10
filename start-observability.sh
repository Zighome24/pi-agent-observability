#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
SESSION="pi-agent-observability"
APP_DIR="$HOME/pi-agent-observability"
ENV_FILE="$APP_DIR/.env"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${OBS_HOST:=127.0.0.1}"
: "${OBS_PORT:=43190}"
: "${OBS_AUTH_TOKEN:?OBS_AUTH_TOKEN is required in $ENV_FILE}"
: "${OBS_DB_PATH:=$APP_DIR/db/obs.db}"

CMD="cd '$APP_DIR' && export PATH=\"$PATH\" && set -a && source '$ENV_FILE' && set +a && export OBS_DB_PATH='${OBS_DB_PATH}' && exec bun apps/observability/server.ts"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi

tmux new-session -d -s "$SESSION" "$CMD"

for _ in $(seq 1 50); do
  if curl -fsS "http://${OBS_HOST}:${OBS_PORT}/health" >/dev/null 2>&1; then
    echo "pi-agent-observability started in tmux session: $SESSION"
    echo "UI: http://${OBS_HOST}:${OBS_PORT}/?token=${OBS_AUTH_TOKEN}"
    echo "Health: http://${OBS_HOST}:${OBS_PORT}/health"
    exit 0
  fi
  sleep 0.2
done

echo "pi-agent-observability did not become healthy; recent logs:" >&2
tmux capture-pane -pt "$SESSION" -S -80 >&2 || true
exit 1
