#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixtures = [
  { path: join(root, "scripts/fixtures/pi-event-batch.json"), expectedPool: "pi" },
  { path: join(root, "scripts/fixtures/hermes-event-batch.json"), expectedPool: "hermes" },
];

const eventTypes = new Set([
  "session_start",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "model_change",
  "thinking",
  "error",
  "custom",
  "compaction",
  "branch_nav",
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

for (const fixture of fixtures) {
  assert(existsSync(fixture.path), `fixture missing: ${fixture.path}`);
  const events = await Bun.file(fixture.path).json();
  assert(Array.isArray(events), `${fixture.path} must contain a JSON array`);
  assert(events.length > 0, `${fixture.path} must contain at least one event`);

  const seenIds = new Set<string>();
  let sessionId = "";

  events.forEach((event, index) => {
    assert(event && typeof event === "object", `${fixture.path}[${index}] must be an object`);
    assert(typeof event.event_id === "string" && event.event_id.length > 0, `${fixture.path}[${index}] missing event_id`);
    assert(!seenIds.has(event.event_id), `${fixture.path}[${index}] duplicate event_id ${event.event_id}`);
    seenIds.add(event.event_id);

    assert(typeof event.ts === "string" && !Number.isNaN(Date.parse(event.ts)), `${fixture.path}[${index}] invalid ts`);
    assert(eventTypes.has(event.type), `${fixture.path}[${index}] unsupported type ${event.type}`);
    assert(typeof event.session_id === "string" && event.session_id.length > 0, `${fixture.path}[${index}] missing session_id`);
    sessionId ||= event.session_id;
    assert(event.session_id === sessionId, `${fixture.path}[${index}] changes session_id within fixture`);
    assert(typeof event.cwd === "string", `${fixture.path}[${index}] cwd must be a string`);
    assert(event.pool === fixture.expectedPool, `${fixture.path}[${index}] expected pool=${fixture.expectedPool}, got ${event.pool}`);
    assert(Array.isArray(event.tags), `${fixture.path}[${index}] tags must be an array`);
    assert(event.tags.includes(fixture.expectedPool), `${fixture.path}[${index}] tags must include ${fixture.expectedPool}`);
    assert(event.payload && typeof event.payload === "object", `${fixture.path}[${index}] payload must be an object`);
    assert(event.seq === index, `${fixture.path}[${index}] expected seq ${index}, got ${event.seq}`);
  });

  console.log(`✓ ${fixture.path.replace(root + "/", "")} (${events.length} events, pool=${fixture.expectedPool})`);
}

console.log("✓ protocol fixture compatibility checks passed");
