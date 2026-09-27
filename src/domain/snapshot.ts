import type { AppState, MatchRecord, ProviderInfo } from "../shared.js";
import { projectRecord, summaryOf } from "./projection.js";

export const ACTIVE_MATCH_STATUSES = ["ready", "running", "paused", "interrupted"] as const;

export function isActiveMatch(match: MatchRecord): boolean {
  return (ACTIVE_MATCH_STATUSES as readonly string[]).includes(match.status);
}

/**
 * The single snapshot projector used by both the HTTP state route and every SSE
 * snapshot, so transport paths cannot disagree. History records are summaries
 * (no per-attempt bodies); the active match is sent as a full transport
 * projection and is also referenced by `activeMatchId` so it stays reachable
 * from the list. A selected historical match is fetched on demand from
 * `GET /api/matches/:id`. This keeps the initial payload from scaling with every
 * historical attempt.
 */
export function buildSnapshot(records: MatchRecord[], providers: ProviderInfo[], limit = 50): AppState {
  const active = records.find(isActiveMatch) ?? null;
  return {
    revision: records.reduce((maximum, match) => Math.max(maximum, match.revision ?? 0), 0),
    providers,
    activeMatchId: active?.id ?? null,
    activeMatch: active ? projectRecord(active) : null,
    recentMatches: records.slice(0, limit).map(summaryOf),
  };
}
