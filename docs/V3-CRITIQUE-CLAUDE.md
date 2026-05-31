# V3 — Claude's critique (orchestrator)

> Goal: slick, semi-minimal, maximally functional, easy to use.

## A — Critical UX issues

| # | Severity | Issue |
|---|----------|-------|
| A1 | BLOCKING | **`pane-header` cramped** in single mode: title + search + 7 chips + ticker all on one row. Wraps ugly at <1300px. Should split into 2 rows (title row + filter row) or move chips below. |
| A2 | BLOCKING | **Lane pill abbreviations cryptic** (`SESS`, `AGEN`, `ASSI`). `THIN` for thinking is meaningless. Use full words; pill is already small enough. |
| A3 | BLOCKING | **"Select a session" placeholder bleeds into title** — when a session is selected, the pane-header shows `Session: tester · gemini-3.5-flashSelect a session` (concatenated). Real cosmetic bug. |
| A4 | BLOCKING | **Empty states feel sterile.** `☐ check sessions in sidebar to open lanes` looks like a typo. Use an icon + a tip ("Pick one or more sessions on the left — they'll appear here as live columns."). |
| A5 | BLOCKING | **No discoverability for keyboard shortcuts.** j/k/G/Esc are invisible. Need a `?` overlay or footer hint. |
| A6 | NICE | Sidebar session IDs (`019e6189`) are noise when `agent_name` is set. Hide if redundant. |
| A7 | NICE | Filter chips on by default for ALL 7 types looks heavy. Subtle accent border instead of solid fill when active. |
| A8 | NICE | Search input has no clear `✕`. |
| A9 | NICE | Header `--` age ticker is unclear — what is it counting? Either label it ("idle:") or hide until populated. |

## B — Functional gaps

| # | Priority | Item |
|---|----------|------|
| B1 | HIGH | **URL state** — pool, tag, view, selectedSessionId, selectedLanes encoded in `location.hash`. Page refresh restores; share-link works. |
| B2 | HIGH | **Per-lane close button** in swimlane mode (sidebar checkbox-only is fine but slow). |
| B3 | HIGH | **Per-session cost/token rollup** in sidebar item — `1.2k tk · $0.014` next to event count. Single-glance signal of how expensive a run was. |
| B4 | MED | **Copy-event-JSON button** in expanded detail view. |
| B5 | MED | **Global header stats** in a small dropdown / hover — total sessions, events, $ cost across current filter. |
| B6 | MED | **Expand all / collapse all** in single mode (one button at the top). |
| B7 | LOW | NDJSON download per session. |
| B8 | LOW | Stop receiving events from a session ("pause this lane"). |

## C — Code / performance

| # | Priority | Item |
|---|----------|------|
| C1 | HIGH | `renderEvents()` re-renders the **entire** event list on every new event in single mode. For sessions with 500+ events the DOM thrash will be visible. Switch to append-only when filter/search/focus didn't change. |
| C2 | HIGH | Event dedup uses `STATE.events.some(e => e.event_id === evt.event_id)` — O(n) per event. Switch to a `Set<event_id>` per session. |
| C3 | MED | SSE keeps producing `ERR_INCOMPLETE_CHUNKED_ENCODING` in Chromium roughly every 12s. Diagnose: probably the response doesn't set `X-Accel-Buffering: no` or similar, and Chromium's network stack closes long-idle chunked responses. Worth a 30-min look. |
| C4 | LOW | Inline favicon SVG (32 bytes) instead of 204. Tiny win. |
| C5 | LOW | Add a global `STATE` debug helper exposed for ad-hoc inspection (already via `window.__OBS_STATE`, fine). |

## D — Visual polish

| # | Item |
|---|------|
| D1 | **Breadcrumb in header**: `pi observability · pool=integration-v2 · tag=fleet` — current context always visible. |
| D2 | **Pill consistency**: same casing (`tool call` vs `TOOL CALL`), same width prefix (or no prefix). Pick one. |
| D3 | **Tool args** in expanded detail rendered as syntax-colored JSON instead of raw `<pre>`. |
| D4 | **Per-event timestamps**: relative time (`+12ms` from previous event) helps spot stalls. |
| D5 | **Cost chip in assistant_message rows** — instead of buried in summary, render `$0.0143 · 9293tk` as a chip on the right. |
| D6 | **Lane sort**: insertion order. Could optionally sort by `started_at DESC` so newest is leftmost. |

## E — What I'd ship vs cut for v3

### Must-ship (this round)
- A1, A2, A3, A4, A5 (UX blockers)
- B1 (URL state), B2 (lane close), B3 (cost rollup)
- C1 (append-only render), C2 (dedup Set)
- D1 (breadcrumb), D2 (pill consistency)

### Nice-to-ship (if time)
- A6, A7, A8, A9
- B4, B5, B6
- C3 (SSE chunked encoding diagnosis)
- D3, D5

### Defer to v4
- B7 (NDJSON download), B8 (pause lane)
- D4 (relative timestamps)
- D6 (lane sort)
