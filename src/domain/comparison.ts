import { distinctExplicitModels, type MatchRecord } from "../shared.js";

/** Recomputed from durable evidence, never from a displayed winner or a requested model name. */
export function comparisonEligibility(match: MatchRecord): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!match.result || !["finished", "forfeit"].includes(match.status)) reasons.push("No completed game result.");
  if (!match.players || !distinctExplicitModels(match.players[0].agent, match.players[1].agent)) reasons.push("Two distinct explicit models are required.");
  const sessions = new Map<string, string>();
  for (const player of match.players ?? []) {
    const attempts = (match.history ?? []).filter((turn) => turn.playerId === player.id).flatMap((turn) => turn.attempts).filter((attempt) => attempt.phase !== "initialization");
    if (!match.environment?.noToolsPlayerIds?.includes(player.id)) reasons.push(`${player.label}: no recorded no-tools execution policy.`);
    if (!attempts.length) reasons.push(`${player.label}: no model response was recorded.`);
    if (attempts.some((attempt) => attempt.resolvedModel !== player.agent.model)) reasons.push(`${player.label}: model identity is missing or mismatched on a request.`);
    if (attempts.some((attempt) => attempt.toolCalls !== 0)) reasons.push(`${player.label}: external tool activity is unknown or nonzero.`);
    for (const attempt of attempts) if (attempt.sessionId) {
      const owner = sessions.get(attempt.sessionId);
      if (owner && owner !== player.id) reasons.push("The two players reported a shared provider session.");
      sessions.set(attempt.sessionId, player.id);
    }
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}
