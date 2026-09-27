import type { AppState } from "../shared.js";
export interface SnapshotCursor { epoch?: string; version: number; retired: Set<string> }
/** Reject old epochs, older snapshots and snapshots older than applied events. */
export function acceptSnapshot(cursor: SnapshotCursor, revisions: Map<string, number>, next: AppState): boolean {
  if (next.epoch && cursor.retired.has(next.epoch)) return false;
  if (next.epoch === cursor.epoch) {
    if ((next.stateVersion ?? 0) < cursor.version) return false;
    for (const match of [...next.recentMatches, ...(next.activeMatch ? [next.activeMatch] : [])]) {
      if ((revisions.get(match.id) ?? 0) > match.revision) return false;
    }
  } else if (cursor.epoch) cursor.retired.add(cursor.epoch);
  cursor.epoch = next.epoch;
  cursor.version = next.stateVersion ?? 0;
  revisions.clear();
  for (const match of next.recentMatches) revisions.set(match.id, match.revision);
  if (next.activeMatch) revisions.set(next.activeMatch.id, next.activeMatch.revision);
  return true;
}
