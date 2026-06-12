#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createDb, prepare, rowToSession, toRow, toSessionRow } from "../apps/observability/db.js";
import type { ObsEvent } from "../shared/types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const db: Database = createDb(":memory:");
const q = prepare(db);

const base = {
  ts: "2026-06-12T12:00:00.000Z",
  type: "session_start" as const,
  cwd: "/tmp/work",
  pool: "pi-agent-workflow",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  seq: 0,
};

const root: ObsEvent = {
  ...base,
  event_id: "run-root-start",
  session_id: "root-session",
  agent_name: "pr-build-dash-90p.1",
  tags: ["beads", "pi-agent", "run:dash-90p.1", "run_root"],
  payload: {
    reason: "startup",
    run_id: "dash-90p.1",
    run_name: "pr-build-dash-90p.1",
    is_run_root: true,
  },
};

const child: ObsEvent = {
  ...base,
  event_id: "run-child-start",
  session_id: "child-session",
  agent_name: "agent-team/pr-builder",
  tags: [
    "beads",
    "pi-agent",
    "pr-builder",
    "subagent",
    "run:dash-90p.1",
    "run_child",
    "parent_run:dash-90p.1",
    "parent:pr-build-dash-90p.1",
    "parent_session:root-session",
  ],
  payload: {
    reason: "startup",
    run_id: "dash-90p.1",
    run_name: "pr-build-dash-90p.1",
    parent_run_id: "dash-90p.1",
    parent_run_name: "pr-build-dash-90p.1",
    parent_session_id: "root-session",
    is_run_root: false,
  },
};

for (const event of [root, child]) {
  q.insertEvent.run(toRow(event));
  q.upsertSession.run(toSessionRow(event));
}

const rows = q.listSessions.all({ $pool: "pi-agent-workflow", $tag: "run:dash-90p.1", $limit: 10 }) as any[];
const sessions = rows.map(rowToSession);

assert(sessions.length === 2, `expected root + child sessions for run tag, got ${sessions.length}`);
assert(sessions.some(s => s.session_id === "root-session" && s.tags.includes("run_root")), "root session missing run_root tag");
assert(sessions.some(s => s.session_id === "child-session" && s.tags.includes("run_child") && s.tags.includes("parent:pr-build-dash-90p.1")), "child session missing parent run tags");

console.log("✓ run grouping tags return dispatcher and subagent sessions together");
