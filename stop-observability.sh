#!/usr/bin/env bash
set -euo pipefail
SESSION="pi-agent-observability"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "Stopped $SESSION"
else
  echo "$SESSION is not running"
fi
