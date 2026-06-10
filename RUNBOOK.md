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

Notes
- The service is bound to the host Tailscale IP, not public 0.0.0.0.
- Existing Pi sessions only become observable if restarted/launched with the observability extension; already-running processes cannot be instrumented retroactively.
- The upstream app stores canonical events in SQLite and exposes live SSE to the browser UI.
