# V3 — Polish + functional depth — implementation plan

> Goal: **slick, semi-minimal, maximally functional, easy to use.**

Synthesized from three critiques: `V3-CRITIQUE-CLAUDE.md`, obv-ds's reply, obv-flash's reply (both archived in conv history).

## Scope decisions (already made)

### IN — must-ship blockers (all three agreed)
1. **URL state / deep linking** — `view`, `pool`, `tag`, `sid` (single), `lanes` (swimlane CSV), `auto_add` encoded in `location.hash`. Restore on load, update on change. Share-link works.
2. **Append-only single-mode render + dedup Set** — full rebuild only when filters/search/focus changes; otherwise append. `seenIds: Set<string>` per session for O(1) dedup.
3. **Lane pill names: full text, not 4-char truncation** — drop `THIN`/`SESS`/`AGEN` etc. Pills are colored; the text needs to read. Single mode already does this; swimlane should match.
4. **Lane close × button** in lane header (top-right).
5. **Per-session cost + token rollup in sidebar + lane header** — `$0.014 · 9.3k tk` next to event count.
6. **Header breadcrumb** showing `pool=… · tag=…` always.
7. **Fix `pane-title` placeholder bleed** — use a dedicated `<span id="pane-label">` instead of `paneTitle.childNodes[0]`.
8. **Empty state polish** — friendlier copy + soft icon.
9. **Compaction + branch_nav landmark events** in extension — extension subscribes to `session_before_compact`/`session_compact` and `session_before_tree`/`session_tree`, emits new event types `compaction` and `branch_nav`. Add to `shared/types.ts`.
10. **Scroll-pause toast** — when user scrolls a lane / single timeline up, show a small floating "↓ paused — click to resume live" button at the bottom of that scrollable region.

### IN — high-value nice-to-haves
11. **`?` keyboard shortcut help overlay** in header.
12. **Copy-event-JSON button** (📋 in expanded detail).
13. **Expand all / collapse all** buttons in pane-header (single mode).
14. **Sidebar session UX**: hide raw UUID when `agent_name` set; relative timestamps (`2m ago`); subtle red dot on sessions with any error event.
15. **`latency_ms` on `assistant_message` payload** — extension measures `turn_end - turn_start` per turn, attaches to the assistant_message of that turn.
16. **Sidebar sort dropdown**: `Latest activity` (default), `Most expensive`, `Errors only`.

### OUT — deferred to v4
- Icon-based pills (text is clearer, simpler).
- Per-extension custom telemetry endpoint (already covered via `custom` event type).
- Global header stats (needs new `/stats` SQL aggregate endpoint).
- NDJSON / CSV download.
- DOM virtualization (instead, hard-cap visible to last 500 events with "show all" override — covers stress case without complexity).
- Markdown rendering in thinking blocks.
- Inline-SVG favicon (204 is fine).

## New test coverage (obv-flash)

| # | Test | What it asserts |
|---|------|------------------|
| T1 | SSE resync drop test | Spawn fleet, abort SSE 3s in, reconnect with `since_seq=<lastSeen>`, assert no duplicates + no gaps |
| T2 | DOM stress test | Headlessly inject ~2000 synthetic events via SSE, measure DOM node count + render time stays bounded (<1s p95 for new event), browser doesn't OOM |
| T3 | UI search/filter visibility | Type a query, assert non-matching `.evt-row` count drops; click chip, assert visible row count matches expected |
| T4 | URL state round-trip | Set view+pool+tag+sid in URL hash, reload, assert UI matches |

## Owners

| Block | Owner | Lines of code (estimate) |
|---|---|---|
| **UI (sections 1–14)** — single, swimlane, sidebar, breadcrumb, URL state, perf fixes, toasts, overlays | **obv-ds** | ~400 lines of `app.js` + `swimlane.js` + `index.html` deltas |
| **Extension + types** — `compaction`, `branch_nav` events, `latency_ms` field on assistant payload, types.ts additions | **obv-flash** | ~80 lines extension + ~30 lines types.ts |
| **Validator extensions T1–T4** | **obv-flash** | ~150 lines |
| **Integration, headless validation, sign-off** | **obv-claude (me)** | screenshots + e2e |

## Wire-format changes (small, additive only)

In `shared/types.ts`:

```ts
// add two new ObsEventType variants
export type ObsEventType =
  | ... // existing 14
  | "compaction"
  | "branch_nav";

export interface CompactionPayload {
  reason: "manual" | "auto";
  tokens_before: number;
  first_kept_entry_id: string;
  summary_preview: string; // truncated
}

export interface BranchNavPayload {
  from_id: string;
  to_id: string;
  has_summary: boolean;
  summary_preview?: string;
}

// extend assistant_message
export interface AssistantMessagePayload {
  ...existing fields
  latency_ms?: number;    // server-side LLM round-trip
  turn_index?: number;    // optional convenience for UI grouping
}
```

Server stores these like any other payload — no schema change required.

## Cross-review gate

After implementation:

1. **obv-ds reviews obv-flash's changes** to `shared/types.ts` + extension hooks + validator.
2. **obv-flash reviews obv-ds's UI changes** by running the extended validator + visually checking in a headed browser.
3. **I run headless Playwright** for final pixel-level verification (screenshot diff vs v2 reference).

Each cross-review posts back here with: 🟢 ship / 🟡 fix-then-ship / 🔴 block.

## Done criteria for v3

- [ ] `scripts/validate-swimlane.ts` exit-0 with new T1–T4 assertions.
- [ ] `OBS_AUTH_TOKEN=devtoken bash scripts/smoke-server.sh` still green.
- [ ] Headless screenshot of single + swimlane with all polish features visible at `artifacts/v3-*.png`.
- [ ] URL state round-trip works (refresh restores).
- [ ] Per-session cost+token shown in sidebar and lane header.
- [ ] Scroll-pause toast appears when scrolling up; click resumes auto-scroll.
- [ ] `?` overlay shows keyboard shortcuts.
- [ ] Lane close × works.
- [ ] Compaction event renders in UI when emitted.
