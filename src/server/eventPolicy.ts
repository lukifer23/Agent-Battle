import type { MatchEvent } from "../shared.js";

const lifecycleEvents = new Set([
  "match.created", "match.started", "match.resumed", "match.paused", "match.stopped", "match.finished", "agent.error",
]);

export function shouldPublishSnapshot(event: MatchEvent | undefined): boolean {
  return Boolean(event && lifecycleEvents.has(event.type));
}

/**
 * Durability is driven by explicit checkpoints (an onChange call with no event),
 * not by every streamed event. This keeps commit points deliberate and lets the
 * controller surface a failed write before requesting another move.
 */
export function shouldPersistChange(event: MatchEvent | undefined): boolean {
  return !event;
}
