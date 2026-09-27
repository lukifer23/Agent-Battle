import type { MatchEvent } from "../shared.js";

const lifecycleEvents = new Set([
  "match.created", "match.started", "match.resumed", "match.paused", "match.stopped", "match.finished", "agent.error",
]);

export function shouldPublishSnapshot(event: MatchEvent | undefined): boolean {
  return Boolean(event && lifecycleEvents.has(event.type));
}

export function shouldPersistChange(event: MatchEvent | undefined): boolean {
  return !event || lifecycleEvents.has(event.type) || event.type === "move.rejected";
}
