import test from "node:test";
import assert from "node:assert/strict";
import { acceptSnapshot, type SnapshotCursor } from "../src/client/snapshotOrder.js";
import type { AppState } from "../src/shared.js";
const snapshot = (epoch: string, stateVersion: number): AppState => ({ epoch, stateVersion, revision: 0, activeMatchId: null, activeMatch: null, recentMatches: [], providers: [] });
test("snapshots reject older deliveries and retired server epochs", () => {
  const cursor: SnapshotCursor = { version: -1, retired: new Set() }; const revisions = new Map<string, number>();
  assert.equal(acceptSnapshot(cursor, revisions, snapshot("a", 4)), true);
  assert.equal(acceptSnapshot(cursor, revisions, snapshot("a", 3)), false);
  assert.equal(acceptSnapshot(cursor, revisions, snapshot("b", 0)), true);
  assert.equal(acceptSnapshot(cursor, revisions, snapshot("a", 99)), false);
  assert.equal(cursor.epoch, "b");
});
test("snapshots cannot roll back a newer applied match event", () => {
  const cursor: SnapshotCursor = { epoch: "a", version: 1, retired: new Set() };
  const revisions = new Map([["match", 8]]);
  const stale = { ...snapshot("a", 2), recentMatches: [{ id: "match", revision: 7 }] } as AppState;
  assert.equal(acceptSnapshot(cursor, revisions, stale), false);
  assert.equal(revisions.get("match"), 8);
});
