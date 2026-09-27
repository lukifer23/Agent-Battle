import type { AppState, MatchRecord, ProviderInfo } from "../shared.js";

export const ACTIVE_MATCH_STATUSES = ["ready", "running", "paused", "interrupted"] as const;

export function isActiveMatch(match: MatchRecord): boolean {
  return (ACTIVE_MATCH_STATUSES as readonly string[]).includes(match.status);
}

/**
 * The single snapshot projector used by both the HTTP state route and every SSE
 * snapshot, so transport paths cannot disagree. The active match is always
 * included in `recentMatches` and also referenced by `activeMatchId`, keeping it
 * reachable from history rather than only through a separate field.
 */
export function buildSnapshot(records: MatchRecord[], providers: ProviderInfo[], limit = 50): AppState {
  const active = records.find(isActiveMatch) ?? null;
  return {
    revision: records.reduce((maximum, match) => Math.max(maximum, match.revision ?? 0), 0),
    providers,
    activeMatchId: active?.id ?? null,
    activeMatch: active,
    recentMatches: records.slice(0, limit),
  };
}
