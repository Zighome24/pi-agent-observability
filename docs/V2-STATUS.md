# V2 — Frontend feature-complete + Per-agent swimlanes — SHIPPED ✅

## What works end-to-end (validated in a real Chromium via Playwright)

### Single mode
- Rich per-type rendering for **all 14 event types** with colored pills (session, agent, turn, user, assistant, thinking, tool_call, tool_result, model_change, error, custom).
- Search box (substring match over summary + payload JSON).
- Filter chips for 7 main event types (multi-select, AND with search).
- Keyboard nav: `j`/`k` move focus, `Enter`/`Space` expand, `Esc` collapse, `g`/`G` jump top/bottom.
- Last-event-ago ticker in header.
- Auto-scroll with manual pause when user scrolls up.

### Swimlane mode
- View toggle in header, persisted in `localStorage`.
- Sidebar: multi-select with checkboxes; "auto-add new lanes" toggle.
- Side-by-side **vertical** lane columns (one per selected session). 6 lanes shown live; horizontal scrolls if more.
- Each lane: sticky header (agent_name · model · live-dot · age) + scrollable body of compact event rows.
- **Single SSE connection** at the page level; client routes events to the right lane by `event.session_id`.
- Backfill: when a lane is opened, fetch full history via `/sessions/:id/events`.
- Resync on SSE reconnect via the new `?since_seq=N` server endpoint.
- Auto-add: new sessions matching pool/tag filters appear as new lanes within ~1s of their first event.

### Server v2 additions
- `GET /sessions/:id/events?since_seq=N` — events with `seq > N`, ascending. Used for lane resync.
- All v1 endpoints unchanged. `scripts/smoke-server.sh` still green.

## Artifacts (Playwright headless screenshots)

| Path | What it shows |
|------|----------------|
| `artifacts/swimlane-3lanes-static.png` | 3 fleet sessions backfilled, each with 18–25 events |
| `artifacts/swimlane-6lanes-live.png`  | 6 lanes after auto-add triggered on a fresh fleet — new lanes show `0–6s ago` while old show `>10min ago` |
| `artifacts/single-mode-fleet.png`     | Single-mode rich rendering with filter chips + search + focused row + live indicator |

## Data plane validation (from `bun scripts/validate-swimlane.ts`)

```
✓ 3 fleet sessions produced (tester=25 events, planner=19, reviewer=18)
✓ All seqs monotonic from 0
✓ Each session has ≥1 tool_call and ≥1 tool_result
✓ 7 tool calls across all sessions
✓ Events from ≥3 different session_ids interleave within a 1-second SSE window
✓ since_seq returns exactly events with seq > N
```

## Bugs caught during validation + who caught them

| Bug | Where | Caught by | Fix |
|---|---|---|---|
| `const swimlaneContainer` redeclared between `app.js` and `swimlane.js` → all of swimlane.js failed to load → swimlane mode silently broken | `server/public/swimlane.js:14` | me (obv-claude) via Chromium console | Removed redundant `const` in swimlane.js — both scripts share global scope as classic `<script>` tags |
| `selectSession` (and view-toggle restore) called `fetchSessionEvents(sid)` fire-and-forget instead of capturing the return value → single-mode event view empty | `server/public/app.js:199` and `:136` | me (obv-claude) via DOM-level Playwright eval | `.then(events => { STATE.events = events; renderEvents(); })` |
| `favicon.ico` returns 500 (no static handler) | `server/server.ts` | console error noise | left as nit, not blocking |
| Filter chip click toggles state but the `.active` CSS class isn't painted on the chip | `app.js` chip click handler | me | left as cosmetic nit |

The first two are real blockers; both were applied directly because they were < 5 lines. The latter two are punted to v2.1.

## Done criteria checklist (vs SPEC-V2-UI.md)

- [x] Single-mode keyboard nav + filter chips + search work; no regressions on v1 events.
- [x] Swimlane mode shows ≥ 3 distinct columns populated live from a single SSE stream.
- [x] Playwright screenshots saved at `artifacts/`.
- [x] `scripts/smoke-server.sh` still green.
- [x] New `scripts/spawn-fleet.sh` + `scripts/validate-swimlane.ts` both green.
- [x] `since_seq` query param implemented and exercised.

## Open / deferred

- Active-chip CSS class painting (cosmetic).
- Favicon 404/204 (cosmetic).
- The `Identifier 'swimlaneContainer'` regression test (we should add a Playwright smoke that asserts `console.errors.filter(e => e.includes("SyntaxError")).length === 0` to prevent future redeclarations).

## Build credits

| Block | Owner |
|---|---|
| Spec (`docs/SPEC-V2-UI.md`), Playwright validation, two surgical bug fixes | obv-claude (me) |
| Server `since_seq` + `app.js` + `swimlane.js` UI rewrite | obv-ds |
| `scripts/spawn-fleet.sh` + `scripts/validate-swimlane.ts` | obv-flash |
