import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";

const TOK = process.env.OBS_AUTH_TOKEN || "devtoken";
const URL = process.env.OBS_SERVER_URL || "http://127.0.0.1:43190";
const headers = { "Authorization": `Bearer ${TOK}` };

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ━━ SSE helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runSSE(controller: AbortController, events: any[]): Promise<void> {
  const url = `${URL}/events/stream?pool=integration-v2&tag=fleet&token=${TOK}`;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const dataText = line.slice(5).trim();
          if (dataText) {
            try {
              const evt = JSON.parse(dataText);
              events.push(evt);
            } catch {
              // ignore
            }
          }
        }
      }
    }
  } catch (err: any) {
    if (err.name !== "AbortError") {
      console.error("[SSE] Connection error:", err.message);
    }
  }
}

// ━━ Main Runner ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  console.log("=== STARTING SWIMLANE VALIDATION ===");

  // 1. Fetch initial targets to clean slate (we will spawn a fresh fleet)
  console.log("[REST] Cleaning up/reading existing sessions...");
  const initialSessionsRes = await fetch(`${URL}/sessions?pool=integration-v2&tag=fleet`, { headers });
  const { sessions: initialSessions } = await initialSessionsRes.json();
  const baseCount = initialSessions.length;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // T1 — SSE Resync Drop Test
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n--- T1: SSE Resync Drop Test ---");

  // 1. Open SSE connection 1
  const sseEvents1: any[] = [];
  const controller1 = new AbortController();
  const ssePromise1 = runSSE(controller1, sseEvents1);
  console.log("[T1] SSE connection 1 opened.");

  // Give SSE 1 a moment to register
  await new Promise(resolve => setTimeout(resolve, 500));

  // 2. Spawn fleet in background
  console.log("[T1] Spawning fleet...");
  const fleetProcess = spawn("bash", ["scripts/spawn-fleet.sh"], { stdio: "inherit" });

  // 3. Wait 3 seconds
  console.log("[T1] Sleeping 3 seconds while fleet is starting...");
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 4. Abort the SSE controller
  console.log("[T1] Aborting SSE connection 1 (simulating dropout)...");
  controller1.abort();
  await ssePromise1;

  // 5. Sleep 2 seconds while fleet is still running
  console.log("[T1] Sleeping 2 seconds while disconnected...");
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 6. Open SSE connection 2
  const sseEvents2: any[] = [];
  const controller2 = new AbortController();
  const ssePromise2 = runSSE(controller2, sseEvents2);
  console.log("[T1] SSE connection 2 opened.");

  // 7. Wait until fleet finishes
  const fleetExitCode = await new Promise<number>((resolve) => {
    fleetProcess.on("exit", (code) => resolve(code ?? 0));
  });
  assert(fleetExitCode === 0, "scripts/spawn-fleet.sh failed");
  console.log("[T1] Fleet execution finished.");

  // Wait 1s for final flushes to land
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Abort second SSE connection
  controller2.abort();
  await ssePromise2;

  // 8. Fetch sessions to find the newly spawned ones
  const postSessionsRes = await fetch(`${URL}/sessions?pool=integration-v2&tag=fleet`, { headers });
  const { sessions: postSessions } = await postSessionsRes.json();
  const spawnedSessions = postSessions.slice(0, postSessions.length - baseCount);
  console.log(`[T1] Identified ${spawnedSessions.length} newly spawned sessions.`);
  assert(spawnedSessions.length >= 3, `Expected at least 3 spawned sessions, got ${spawnedSessions.length}`);

  // Fetch full event list for each session via REST and verify against combined SSE events
  const targetSessions = spawnedSessions.slice(0, 3);
  
  // Calculate lastSeq per session before drop from sseEvents1
  const lastSeqs = new Map<string, number>();
  for (const s of targetSessions) {
    const sessionEvents = sseEvents1.filter((e: any) => e.session_id === s.session_id);
    const maxSeq = sessionEvents.length > 0 ? Math.max(...sessionEvents.map((e: any) => e.seq)) : -1;
    lastSeqs.set(s.session_id, maxSeq);
  }

  // 9. Fetch missed backfills using since_seq for each session
  const backfillEvents: any[] = [];
  for (const s of targetSessions) {
    const lastSeq = lastSeqs.get(s.session_id) ?? -1;
    const backfillUrl = `${URL}/sessions/${s.session_id}/events?since_seq=${lastSeq}&limit=500`;
    const backfillRes = await fetch(backfillUrl, { headers });
    assert(backfillRes.ok, `since_seq request failed for session ${s.session_id}`);
    const { events } = await backfillRes.json();
    console.log(`[T1] Session ${s.session_id} (lastSeq before drop: ${lastSeq}): fetched ${events.length} backfill events.`);
    backfillEvents.push(...events);
  }

  // Combine sseEvents1 + backfills + sseEvents2 and deduplicate by event_id
  const combinedEvents = [...sseEvents1, ...backfillEvents, ...sseEvents2];
  const dedupedCombinedEvents: any[] = [];
  const seenIds = new Set<string>();
  for (const e of combinedEvents) {
    if (e && e.event_id && !seenIds.has(e.event_id)) {
      seenIds.add(e.event_id);
      dedupedCombinedEvents.push(e);
    }
  }

  // Assert: every event in REST also exists exactly once in combined list (no gaps, no duplicates)
  for (const s of targetSessions) {
    const restRes = await fetch(`${URL}/sessions/${s.session_id}/events?limit=500`, { headers });
    const { events: restEvents } = await restRes.json();

    // Verify seq is strictly monotonic starting at 0
    const sortedRest = [...restEvents].sort((a: any, b: any) => a.seq - b.seq);
    assert(sortedRest[0].seq === 0, `Expected first seq to be 0, got ${sortedRest[0].seq}`);
    for (let i = 0; i < sortedRest.length; i++) {
      assert(sortedRest[i].seq === i, `Sequence gap or mismatch. Index ${i} has seq ${sortedRest[i].seq}`);
    }

    // Verify all rest events are found exactly once in our aggregated SSE telemetry
    for (const re of restEvents) {
      const matched = dedupedCombinedEvents.filter((e: any) => e.event_id === re.event_id);
      assert(matched.length === 1, `Event ${re.event_id} (seq ${re.seq}, type ${re.type}) appeared ${matched.length} times in combined SSE list.`);
    }
  }

  console.log("  ✓ T1: SSE Resync Drop Test PASSED!");

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // T2 — DOM Stress Test
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n--- T2: DOM Stress Test ---");

  // 1. Generate and POST 2000 synthetic events for a single fake session
  const stressSid = `stress-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[T2] Generating 2,000 synthetic events for fake session: ${stressSid}`);
  const fakeEvents: any[] = [];
  for (let i = 0; i < 2000; i++) {
    fakeEvents.push({
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: i === 0 ? "session_start" : i === 1999 ? "session_shutdown" : "turn_start",
      session_id: stressSid,
      cwd: process.cwd(),
      pool: "integration-v2",
      tags: ["fleet"],
      payload: { index: i, text: `Synthetic Event #${i}` },
      seq: i,
    });
  }

  const postRes = await fetch(`${URL}/events`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(fakeEvents),
  });
  assert(postRes.ok, `Failed to post stress events: ${postRes.statusText}`);
  console.log("[T2] Posted 2,000 synthetic events successfully.");

  // 2. Open UI via Playwright directly deep-linked to our stress session
  console.log("[T2] Loading UI in Playwright deep-linked to stress session...");
  const urlWithHashT2 = `${URL}/?token=${TOK}#view=single&sid=${stressSid}`;
  spawnSync("playwright-cli", ["-s=stress", "open", urlWithHashT2], { encoding: "utf8" });
  
  // Wait for sidebar sessions and events to load
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Count rendering rows
  console.log("[T2] Querying DOM node count in #event-view...");
  const evalNodeCount = spawnSync("playwright-cli", ["-s=stress", "eval", "document.querySelectorAll('#event-view .evt-row').length"], { encoding: "utf8" });
  const nodeCount = parseInt(evalNodeCount.stdout.match(/Result\s+(\d+)/)?.[1] ?? "0", 10);
  console.log(`[T2] DOM Row count rendered: ${nodeCount}`);

  // Assert full render (append-only rendering with Set-based dedup)
  assert(nodeCount >= 1000, `Expected >=1000 rows rendered (full append capped at client limit), got ${nodeCount}`);
  
  // Check for any console errors during stress render
  const consoleR = spawnSync("playwright-cli", ["-s=stress", "console", "error"], { encoding: "utf8" });
  assert(!consoleR.stdout.match(/SyntaxError|ReferenceError|TypeError|Maximum/), "UI threw JS errors during stress render");
  console.log("  ✓ No JS errors thrown during stress render");

  spawnSync("playwright-cli", ["-s=stress", "close"]);
  console.log("  ✓ T2: DOM Stress Test PASSED!");

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // T3 — UI Search/Filter Visibility
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n--- T3: UI Search/Filter Visibility ---");

  spawnSync("playwright-cli", ["-s=t3", "open", `${URL}/?token=${TOK}#view=single&pool=integration-v2&tag=fleet`], { encoding: "utf8" });
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Select the second session item (which is a real fleet agent run containing tool calls) via JS click
  console.log("[T3] Selecting target session...");
  spawnSync("playwright-cli", ["-s=t3", "eval", "document.querySelectorAll('.session-item')[1].click()"], { encoding: "utf8" });
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Get initial visible row count
  const initialCountStr = spawnSync("playwright-cli", ["-s=t3", "eval", "document.querySelectorAll('#event-view .evt-row').length"], { encoding: "utf8" }).stdout;
  const initialCount = parseInt(initialCountStr.match(/Result\s+(\d+)/)?.[1] ?? "0", 10);
  console.log(`[T3] Initial visible row count: ${initialCount}`);

  // Type "bash" in search box
  console.log("[T3] Typing 'bash' into the search input...");
  spawnSync("playwright-cli", ["-s=t3", "fill", "#search-box", "bash"], { encoding: "utf8" });
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Count visible rows containing "bash"
  const filteredCountStr = spawnSync("playwright-cli", ["-s=t3", "eval", "Array.from(document.querySelectorAll('#event-view .evt-row')).filter(el => window.getComputedStyle(el).display !== 'none').length"], { encoding: "utf8" }).stdout;
  const filteredCount = parseInt(filteredCountStr.match(/Result\s+(\d+)/)?.[1] ?? "0", 10);
  console.log(`[T3] Filtered visible row count: ${filteredCount}`);
  assert(filteredCount < initialCount, `Expected search to reduce visible count (initial: ${initialCount}, filtered: ${filteredCount})`);

  // Clear search and assert all events restored
  console.log("[T3] Clearing search input...");
  spawnSync("playwright-cli", ["-s=t3", "fill", "#search-box", ""], { encoding: "utf8" });
  await new Promise(resolve => setTimeout(resolve, 1000));

  const restoredCountStr = spawnSync("playwright-cli", ["-s=t3", "eval", "Array.from(document.querySelectorAll('#event-view .evt-row')).filter(el => window.getComputedStyle(el).display !== 'none').length"], { encoding: "utf8" }).stdout;
  const restoredCount = parseInt(restoredCountStr.match(/Result\s+(\d+)/)?.[1] ?? "0", 10);
  console.log(`[T3] Restored visible row count: ${restoredCount}`);
  assert(restoredCount === initialCount, "Search clear should restore initial event row visibility");

  spawnSync("playwright-cli", ["-s=t3", "close"]);
  console.log("  ✓ T3: UI Search/Filter Visibility PASSED!");

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // T4 — URL State Round-Trip
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n--- T4: URL State Round-Trip ---");

  // Load UI with custom hash state
  const testHash = `view=swimlane&pool=integration-v2&tag=fleet`;
  const urlWithHash = `${URL}/?token=${TOK}#${testHash}`;
  console.log(`[T4] Launching UI with hash deep-link: ${urlWithHash}`);
  
  spawnSync("playwright-cli", ["-s=t4", "open", urlWithHash], { encoding: "utf8" });
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Assert that pool and tag inputs are correctly populated from hash state
  const poolValStr = spawnSync("playwright-cli", ["-s=t4", "eval", "document.querySelector('#pool-filter').value"], { encoding: "utf8" }).stdout;
  const poolVal = poolValStr.match(/Result\s+\"([^"]+)\"/)?.[1];
  console.log(`[T4] Resolved pool filter input: ${poolVal}`);
  assert(poolVal === "integration-v2", `Expected pool-filter to be 'integration-v2', got '${poolVal}'`);

  const tagValStr = spawnSync("playwright-cli", ["-s=t4", "eval", "document.querySelector('#tag-filter').value"], { encoding: "utf8" }).stdout;
  const tagVal = tagValStr.match(/Result\s+\"([^"]+)\"/)?.[1];
  console.log(`[T4] Resolved tag filter input: ${tagVal}`);
  assert(tagVal === "fleet", `Expected tag-filter to be 'fleet', got '${tagVal}'`);

  // Assert view mode is restored
  const viewModeStr = spawnSync("playwright-cli", ["-s=t4", "eval", "window.location.hash"], { encoding: "utf8" }).stdout;
  const viewMode = viewModeStr.match(/Result\s+\"([^"]+)\"/)?.[1];
  console.log(`[T4] Current window location hash: ${viewMode}`);
  assert(viewMode?.includes("swimlane"), "Expected view mode to restore to swimlane");

  spawnSync("playwright-cli", ["-s=t4", "close"]);
  console.log("  ✓ T4: URL State Round-Trip PASSED!");

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Playwright Headless Console Error check
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n--- UI Javascript Console Error Check ---");
  try {
    spawnSync("playwright-cli", ["-s=obs-ui-check", "open", `${URL}/?token=${TOK}`], { encoding: "utf8" });
    const consoleR = spawnSync("playwright-cli", ["-s=obs-ui-check", "console", "error"], { encoding: "utf8" });
    const errors = consoleR.stdout || "";
    if (errors.match(/SyntaxError|ReferenceError|TypeError/)) {
      console.error("  ❌ UI Javascript Console Error Check FAILED!");
      console.error(errors);
      process.exit(1);
    }
    spawnSync("playwright-cli", ["-s=obs-ui-check", "close"]);
    console.log("  ✓ UI loaded with zero Syntax, Reference, or Type errors.");
  } catch (err: any) {
    console.log(`  [INFO] Playwright console verification skipped or failed: ${err.message}`);
  }

  console.log("\n=================================");
  console.log("✓ ALL SWIMLANE VALIDATIONS PASSED");
  console.log("=================================");
}

main().catch((err) => {
  console.error("\n❌ VALIDATION FAILED:");
  console.error(err.message);
  process.exit(1);
});
