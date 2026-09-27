import type { MatchEvent } from "../shared.js";

const lifecycleEvents = new Set([
  "match.created", "match.started", "match.resumed", "match.paused", "match.stopped", "match.finished", "agent.error",
]);

export function shouldPublishSnapshot(event: MatchEvent | undefined): boolean {
  return Boolean(event && lifecycleEvents.has(event.type));
}

/**
 * The controller commits the current state and event before invoking the
 * notification callback. This predicate distinguishes that commit callback
 * (no event argument) from the subsequent streamed notification.
 */
export function shouldPersistChange(event: MatchEvent | undefined): boolean {
  return !event;
}
