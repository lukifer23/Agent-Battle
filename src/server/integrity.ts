import { isDeepStrictEqual } from "node:util";
import type { AgentAttempt, MatchRecord, SeriesRecord } from "../shared.js";
import { researchMatchBudgets } from "./researchPlan.js";

const TERMINAL_SLOT = new Set(["finished", "forfeit"]);

function attemptsOf(match: MatchRecord): AgentAttempt[] {
  return [...match.history.flatMap((turn) => turn.attempts), ...(match.pendingTurn?.attempts ?? [])];
}

/** Cross-match invocation ids. The later match is the one reported. */
export function crossMatchInvocationErrors(matches: Iterable<MatchRecord>): Map<string, string> {
  const owner = new Map<string, string>();
  const errors = new Map<string, string>();
  for (const match of matches) {
    for (const attempt of attemptsOf(match)) {
      if (!attempt.invocationId) continue;
      const previous = owner.get(attempt.invocationId);
      if (previous && previous !== match.id) errors.set(match.id, `Invocation ${attempt.invocationId} is already used by match ${previous}.`);
      else owner.set(attempt.invocationId, match.id);
    }
  }
  return errors;
}

/**
 * Relational checks the legacy JSON loader applied before a series could enter
 * the live store. Returns an error string so the caller can quarantine the
 * series without rewriting its source. Independently valid matches stay.
 */
export function validateSeriesLinkage(
  series: SeriesRecord,
  matches: Map<string, MatchRecord>,
  quarantinedMatchIds: ReadonlySet<string> = new Set(),
): string | undefined {
  const seenMatches = new Set<string>();
  for (const slot of series.slots) {
    for (const [index, matchId] of slot.matchIds.entries()) {
      if (seenMatches.has(matchId)) return "Series slot reuses a match id.";
      seenMatches.add(matchId);
      if (quarantinedMatchIds.has(matchId) && !matches.has(matchId)) return "Series slot references a quarantined match.";
      const match = matches.get(matchId);
      if (!match || match.series?.id !== series.id || match.series.slotId !== slot.id || match.series.attempt !== index + 1 || match.gameId !== slot.gameId) {
        return "Series slot linkage differs from match record.";
      }
      if (slot.gameVersion && match.gameVersion !== slot.gameVersion) return "Series slot linkage differs from match record.";
      if (series.version === "battle-series-3" && (
        match.gameVersion !== slot.gameVersion
        || match.series.conditionId !== slot.conditionId
        || match.series.blockId !== slot.blockId
        || match.series.planHash !== series.planHash
        || match.settings.turnTimeoutSeconds !== series.settings.turnTimeoutSeconds
        || !isDeepStrictEqual(match.settings.budgets, researchMatchBudgets(series.settings.budgets))
      )) return "Research assignment differs from registered condition.";
      if (slot.gameId === "hangman" && (match.gameState as { provenance?: { seed?: string } }).provenance?.seed !== slot.challengeSeed) {
        return "Match challenge differs from series seed.";
      }
      for (const [role, agentIndex] of Object.entries(slot.roles)) {
        const actual = match.players.find((player) => player.id === role)?.agent;
        const expected = series.agents[agentIndex];
        if (!actual || !expected || actual.provider !== expected.provider || actual.model !== expected.model || (actual.reasoning ?? "") !== (expected.reasoning ?? "")) {
          return "Series agent assignment differs from match.";
        }
      }
    }
  }
  if (series.status === "completed" && series.slots.some((slot) => !slot.skipped && !TERMINAL_SLOT.has(matches.get(slot.matchIds.at(-1) ?? "")?.status ?? ""))) {
    return "Completed series has unfinished slots.";
  }
  return undefined;
}
