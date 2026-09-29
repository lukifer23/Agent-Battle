import { comparisonEligibility } from "./comparison.js";
import { defaultGames } from "./defaultGames.js";
import type { GameRegistry } from "./game.js";
import { aggregateUsage, allAttempts } from "./usage.js";
import type { GameMetric, MatchRecord, MatchScorecard, TerminationClass } from "../shared.js";

function terminationOf(record: MatchRecord): { class: TerminationClass; detail?: string } {
  const detail = record.error ?? record.result?.reason;
  if (record.status === "interrupted") return { class: "interrupted", ...(detail ? { detail } : {}) };
  if (record.status === "error" && /save|storage/i.test(record.error ?? "")) return { class: "storage-failure", ...(record.error ? { detail: record.error } : {}) };
  if (record.status === "error") return { class: "provider-failure", ...(record.error ? { detail: record.error } : {}) };
  if (record.status === "stopped" && (record.error ?? "").startsWith("Budget")) return { class: "budget-stop", ...(record.error ? { detail: record.error } : {}) };
  if (record.status === "stopped") return { class: "operator-stop", ...(record.error ? { detail: record.error } : {}) };
  if (record.status === "forfeit") return { class: "protocol-forfeit", ...(record.result?.reason ? { detail: record.result.reason } : {}) };
  if (record.status === "finished" && /forfeit/i.test(record.result?.reason ?? "")) return { class: "lane-forfeit", ...(record.result?.reason ? { detail: record.result.reason } : {}) };
  if (record.status === "finished" && /resigned/i.test(record.result?.reason ?? "")) return { class: "resignation", ...(record.result?.reason ? { detail: record.result.reason } : {}) };
  if (record.status === "finished") return { class: "game-terminal", ...(record.result?.reason ? { detail: record.result.reason } : {}) };
  return { class: "unknown", ...(detail ? { detail } : {}) };
}

function metricsOf(record: MatchRecord, registry: GameRegistry): GameMetric[] {
  try {
    const game = registry.get(record.gameId, record.gameVersion);
    const state = game.deserialize(record.gameState);
    return game.metrics?.(state, record) ?? [];
  } catch {
    return [];
  }
}

/** Recomputed from the authoritative record. Not an input to the research primary endpoint. */
export function buildScorecard(record: MatchRecord, registry: GameRegistry = defaultGames): MatchScorecard {
  const usage = aggregateUsage(allAttempts(record));
  const latency = allAttempts(record).filter((attempt) => attempt.phase !== "initialization" && typeof attempt.latencyMs === "number");
  const seats: MatchScorecard["outcome"]["seats"] = {};
  for (const player of record.players ?? []) {
    if (!record.result || !["finished", "forfeit"].includes(record.status)) seats[player.id] = "unscored";
    else if (record.result.kind === "draw") seats[player.id] = "draw";
    else seats[player.id] = record.result.winnerId === player.id ? "win" : "loss";
  }
  const qualification = comparisonEligibility(record);
  return {
    version: "scorecard-v1",
    outcome: record.result && ["finished", "forfeit"].includes(record.status)
      ? { kind: record.result.kind, winnerId: record.result.winnerId ?? null, notation: record.result.notation, reason: record.result.reason, seats }
      : { kind: "unscored", winnerId: null, seats },
    termination: terminationOf(record),
    qualification: { eligible: qualification.eligible, reasons: qualification.reasons },
    resources: {
      requests: usage.requests,
      latencyMs: latency.length ? latency.reduce((sum, attempt) => sum + (attempt.latencyMs ?? 0), 0) : null,
      inputTokens: usage.coverageByMetric.inputTokens.reported ? usage.inputTokens : null,
      outputTokens: usage.coverageByMetric.outputTokens.reported ? usage.outputTokens : null,
      costUsd: usage.coverageByMetric.costUsd.reported ? usage.costUsd : null,
      coverage: usage.coverage,
    },
    metrics: metricsOf(record, registry),
  };
}
