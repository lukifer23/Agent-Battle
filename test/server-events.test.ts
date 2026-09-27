import test from "node:test";
import assert from "node:assert/strict";
import { shouldPersistChange, shouldPublishSnapshot } from "../src/server/eventPolicy.js";
import type { MatchEvent } from "../src/shared.js";

function event(type: string): MatchEvent {
  return { at: "2026-01-01T00:00:00.000Z", type, text: type };
}

test("full SSE snapshots are limited to match lifecycle events", () => {
  assert.equal(shouldPublishSnapshot(undefined), false);
  assert.equal(shouldPublishSnapshot(event("agent.thinking")), false);
  assert.equal(shouldPublishSnapshot(event("turn.completed")), false);
  assert.equal(shouldPublishSnapshot(event("move.applied")), false);
  assert.equal(shouldPublishSnapshot(event("match.started")), true);
  assert.equal(shouldPublishSnapshot(event("match.finished")), true);
});

test("persistence checkpoints retain accepted state, retries, and lifecycle changes", () => {
  assert.equal(shouldPersistChange(undefined), true);
  assert.equal(shouldPersistChange(event("agent.started")), false);
  assert.equal(shouldPersistChange(event("turn.completed")), false);
  assert.equal(shouldPersistChange(event("move.applied")), false);
  assert.equal(shouldPersistChange(event("move.rejected")), true);
  assert.equal(shouldPersistChange(event("agent.error")), true);
});
