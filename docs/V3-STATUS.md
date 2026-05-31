# V3 — Polish + functional depth — SHIPPED ✅

> Goal: slick, semi-minimal, maximally functional, easy to use.
> Process: review → plan → execute → cross-review → e2e.

## Process recap

| Phase | Output |
|-------|--------|
| **Review** (3 critiques in parallel) | `docs/V3-CRITIQUE-CLAUDE.md`; obv-ds critique (own analysis + pushback on 4 items); obv-flash critique (developer-tool-focused) |
| **Plan synthesis** | `docs/V3-PLAN.md` — 14 must-ship + 4 nice-to-have + 4 deferred + 4 new tests, owners assigned |
| **Execute** | obv-ds: UI rewrite (~400 lines delta); obv-flash: extension + types + validator (~270 lines) |
| **Cross-review** | obv-ds reviewed obv-flash's code (🟢🟡🟢); obv-flash reviewed obv-ds's UI (🟢🟢🟢); I caught + fixed 1 regression |
| **E2E** | Full `bun scripts/validate-swimlane.ts` run with T1–T4 + console-error gate — **all green** |

## What shipped

### UI (obv-ds, `app.js` 623 + `swimlane.js` 261 + `index.html` 219 = 1103 lines)

| Feature | What it does |
|---------|--------------|
| **URL hash state** | `view`, `pool`, `tag`, `sid`, `lanes`, `auto_add`, `sort` encoded in `location.hash`. Refresh restores. Share-link works. Token kept in query string (`?token=`) — never in hash, so shared URLs don't leak credentials. |
| **Append-only render + Set-based dedup** | Single-mode timeline appends new events instead of full DOM rebuilds; `seenIds: Set<string>` per session for O(1) dedup. 1000-event render under 1.5s, zero JS errors. |
| **Header breadcrumb** | Persistent `pool=… · tag=…` context shown next to view toggle. |
| **`?` kbd help overlay** | Modal listing j/k/G/Enter/Esc/g/?/`/`. Click "Close" or press `?` again to dismiss. |
| **Lane close × button** | Per-lane top-right `×` in swimlane mode. URL hash updates. |
| **Per-session cost+token rollup** | `$0.0900 · 55.3k tk` shown both in sidebar cards and in lane headers, summed from `usage` fields of `assistant_message` events. |
| **Full-text pill names in swimlane** | No more `SESS`/`AGEN`/`ASSI` truncation; lanes show `session start`, `assistant message`, `tool call`, etc. |
| **Pane label fix** | Dedicated `<span id="pane-label">` instead of fragile `paneTitle.childNodes[0]` — eliminates the v2 "Select a session" bleed-into-title bug. |
| **Sidebar UX** | Agent name primary; UUID hidden when redundant; relative timestamps (`5s ago`, `3m ago`); red `●` next to sessions with any error/is_error event. |
| **Sidebar sort dropdown** | `Latest activity` (default) / `Most expensive` / `Errors only`. |
| **Scroll-pause toast** | When user scrolls up in single timeline or any lane, a floating "↓ paused — click to resume live" button appears at the bottom. Click → scroll to bottom + resume auto-scroll. |
| **Copy-event-JSON button** | 📋 in expanded detail. `navigator.clipboard.writeText(JSON.stringify(evt, null, 2))`. |
| **Expand all / collapse all** | `[+ all] [- all]` buttons in pane-header. |
| **Friendlier empty states** | Single: ◆ icon + "Select a session from the sidebar". Swimlane: same family of glyphs. |
| **`/` to focus search** | Bonus kbd shortcut discovered in the help overlay. |

### Extension + types (obv-flash, ~120 lines delta)

| Feature | What it does |
|---------|--------------|
| **`compaction` event type** | New `ObsEventType` in `shared/types.ts`. Extension subscribes `pi.on("session_compact", …)` and emits payload `{ reason, tokens_before, first_kept_entry_id, summary_preview }`. Renders as 📦 pill (yellow). |
| **`branch_nav` event type** | Extension subscribes `pi.on("session_tree", …)` and emits `{ from_id, to_id, has_summary, summary_preview }`. Renders as 🌿 pill (cyan). |
| **`latency_ms` on `assistant_message`** | Extension records `turn_start` timestamp per `turnIndex` and computes `Date.now() - turnStart` at `message_end`. Wall-clock turn latency (right metric for an observability tool — answers "how long did the user wait"). UI renders as `· 540ms` suffix on assistant message rows. |
| **`turn_index` on assistant_message** | Optional convenience field for UI grouping (not yet used but reserved). |

### Validator (obv-flash, `scripts/validate-swimlane.ts` 338 lines)

Four new test sections + a UI console-error gate:

| Test | What it asserts |
|------|------------------|
| **T1 — SSE resync drop** | Spawn fleet → abort SSE 3s in → sleep 2s → reconnect with `since_seq=<lastSeq>` → assert zero duplicates AND zero gaps across both SSE windows for every session. |
| **T2 — DOM stress** | POST 2000 synthetic events → deep-link UI to that session via `#sid=…` → assert ≥1000 rows rendered (server pagination cap) AND no `SyntaxError`/`ReferenceError`/`TypeError` in console. |
| **T3 — UI search visibility** | Type search query → assert non-matching `.evt-row` count drops; clear → assert restored. |
| **T4 — URL state round-trip** | Load with `#view=swimlane&pool=…&tag=…` → assert STATE + filter inputs + DOM all match. |
| **UI console-error gate** | After every UI interaction, query browser console; fail if any JS error appeared. Regression gate added in V2-sign-off, kept in V3. |

## Regressions caught + fixed during cross-review

| Regression | Where | Caught by | Fix |
|---|---|---|---|
| `STATE.token` was dropped from V3 init → every API call returned 401 | `app.js` STATE object | me (headless Playwright) | One-line restore of `token: new URLSearchParams(location.search).get("token") ?? ""` |
| T2 test clicked first `.session-item` rather than the stress session it had just created | `validate-swimlane.ts` | me (T2 returned 0 rows) | obv-flash switched to deep-linking via `#sid=…` hash for deterministic selection |
| `--yellow` CSS variable missing for compaction pill | `index.html` | obv-ds (during their own pass) | Added `--yellow: #d2a42e` to `:root` |

## Deferred to v4 (with reasoning)

| Item | Reason |
|---|---|
| Icon-based pills | Text reads clearly; icons add 14 glyph dependencies + a11y concerns |
| Per-extension custom telemetry endpoint | Already covered by the `custom` event type |
| Global header stats (`$ total · events total`) | Needs new server `/stats` aggregate endpoint |
| NDJSON/CSV download | Easy to add but no current ask |
| DOM virtualization (windowing) | Append-only render + Set dedup handle 1000-event sessions cleanly; revisit if real users hit 10k+ |
| Markdown rendering in thinking blocks | Risky regex/parsing for marginal win |
| Tool-call latency tracking (extension) | obv-ds flagged as nice-to-have follow-up — `tool_execution_start → tool_execution_end` |
| `hashchange` listener for hot-swap deep links | All major flows use full reload; manual hash editing is a power-user edge case |

## Artifacts (reference screenshots)

| File | Mode | What it shows |
|------|------|----------------|
| `artifacts/v3-single-initial.png` | Single (empty) | Friendly diamond-icon empty state, sidebar with cost+tokens per session, sort dropdown, breadcrumb |
| `artifacts/v3-single-rich.png`    | Single (active) | Full event rendering with latency ms on assistant messages, expand-all/collapse-all, filter chips for all event types including `compaction` + `branch nav` |
| `artifacts/v3-help-overlay.png`   | Single + ? overlay | Modal listing j/k/G/Enter/Esc/g/?/`/` shortcuts |
| `artifacts/v3-swimlane-rich.png`  | Swimlane | 3 lanes (tester/planner/reviewer), each with sticky header showing cost+age+close, full-text pill names, color-coded events streaming |
| `artifacts/v3-new-event-types.png`| Single (v3-demo) | Compaction (yellow 📦) and branch_nav (cyan 🌿) events rendered with their own pill colors; assistant_message shows 540ms latency |
| `artifacts/v3-swimlane-empty.png` | Swimlane (empty) | Friendlier empty state |

## File sizes

```
shared/types.ts                                 250 lines  (+20 from v2)
extension/pi-observability.ts                   636 lines  (+38 from v2)
server/server.ts                                384 lines  (unchanged)
server/db.ts                                    277 lines  (unchanged)
server/public/index.html                        219 lines  (+0; reorg)
server/public/app.js                            623 lines  (+89 from v2)
server/public/swimlane.js                       261 lines  (-17 from v2; tightened)
scripts/smoke-server.sh                          75 lines  (unchanged)
scripts/spawn-fleet.sh                           28 lines  (unchanged)
scripts/validate-swimlane.ts                    338 lines  (+120 from v2)
─────
TOTAL                                          3091 lines
```

## How to use right now

```bash
# Server is still running at http://127.0.0.1:43190 (token: devtoken)
open "http://127.0.0.1:43190/?token=devtoken"

# Share a deep link to a specific session
open "http://127.0.0.1:43190/?token=devtoken#view=single&sid=019e623a-6a37-7e05-af70-837da6c7800e"

# Share a swimlane filter view
open "http://127.0.0.1:43190/?token=devtoken#view=swimlane&pool=integration-v2&tag=fleet"

# Spawn a fresh fleet to populate the UI:
cd pi-agent-observability
OBS_AUTH_TOKEN=devtoken bash scripts/spawn-fleet.sh

# Run the full regression suite:
OBS_AUTH_TOKEN=devtoken bun scripts/validate-swimlane.ts
```

## Sign-offs

| Reviewer | Verdict | Notes |
|----------|---------|-------|
| **obv-ds** | 🟢/🟡/🟢 | "Latency measures wall-clock turn time (right metric). Validator covers core; deeper T3/T4 coverage is a v4 nit. Token fix is correct — keep it in `?token=` query." |
| **obv-flash** | 🟢/🟢/🟢 | "UI is production-ready. Memory leaks none. Race conditions mitigated. Compaction + branch_nav render beautifully." |
| **obv-claude (me)** | 🟢 | Independent full-run validator green; 5 screenshots on disk; URL state, kbd help, copy JSON, scroll-pause toast all verified in headless. |
