import { isDeepStrictEqual } from "node:util";
import { researchMatchBudgets } from "./researchPlan.js";
import { createHash } from "node:crypto";
import { comparisonEligibility } from "../domain/comparison.js";
import type { MatchRecord, SeriesRecord } from "../shared.js";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Resample complete challenge blocks; never treat turns, seats or replicates as independent. */
export function pairedBootstrap(values: number[], seed: string, samples = 5000): [number, number] | null {
  if (values.length < 2) return null;
  if (values.some((v) => !Number.isFinite(v)) || !Number.isSafeInteger(samples) || samples < 100 || samples > 100000) throw new Error("Invalid bootstrap input.");
  let counter = 0;
  const limit = Math.floor(2 ** 32 / values.length) * values.length;
  const index = () => {
    let n: number;
    do { n = createHash("sha256").update(`${seed}:${counter++}`).digest().readUInt32BE(); } while (n >= limit);
    return n % values.length;
  };
  const distribution = Array.from({ length: samples }, () => mean(values.map(() => values[index()]))).sort((a, b) => a - b);
  const quantile = (p: number) => {
    const at = (distribution.length - 1) * p, low = Math.floor(at), fraction = at - low;
    return distribution[low] * (1 - fraction) + distribution[Math.ceil(at)] * fraction;
  };
  return [quantile(0.025), quantile(0.975)];
}

export function analyzeResearchSeries(series: SeriesRecord, matches: MatchRecord[]) {
  const plan = series.researchPlan;
  if (!plan || series.version !== "battle-series-3") throw new Error("A registered research series is required.");
  const linkedIds = new Set(series.slots.flatMap((slot) => slot.matchIds));
  const studyMatches = matches.filter((match) => linkedIds.has(match.id));
  const byId = new Map(studyMatches.map((match) => [match.id, match]));
  const sessionCounts = new Map<string, number>();
  for (const match of studyMatches) for (const attempt of [...match.history.flatMap((turn) => turn.attempts), ...(match.pendingTurn?.attempts ?? [])]) {
    if (attempt.sessionId) sessionCounts.set(attempt.sessionId, (sessionCounts.get(attempt.sessionId) ?? 0) + 1);
  }
  const rows = series.slots.map((slot) => {
    // A successful rerun must not erase a failed first observation from the primary analysis.
    const match = byId.get(slot.matchIds[0]);
    const expectedAgents = Object.entries(slot.roles).every(([role, index]) => {
      const actual = match?.players.find((p) => p.id === role)?.agent;
      const expected = series.agents[index];
      return actual?.model === expected.model && actual?.provider === expected.provider && (actual?.reasoning ?? "") === (expected.reasoning ?? "");
    });
    const linked = !!match && match.series?.id === series.id && match.series.slotId === slot.id && match.series.conditionId === slot.conditionId
      && match.series.blockId === slot.blockId && match.series.planHash === series.planHash && match.gameId === slot.gameId && match.gameVersion === slot.gameVersion && expectedAgents
      && match.settings?.turnTimeoutSeconds === series.settings.turnTimeoutSeconds && isDeepStrictEqual(match.settings?.budgets, researchMatchBudgets(series.settings.budgets));
    const eligibility = match && linked ? comparisonEligibility(match) : { eligible: false, reasons: [match ? "Match differs from registered assignment." : "No first attempt recorded."] };
    if (match && match.history.flatMap((turn) => turn.attempts).some((attempt) => attempt.sessionId && (sessionCounts.get(attempt.sessionId) ?? 0) > 1)) {
      eligibility.eligible = false;
      eligibility.reasons.push("Provider session identity was reused across recorded requests.");
    }
    const roleA = Object.entries(slot.roles).find(([, index]) => index === 0)?.[0];
    const score = eligibility.eligible && match?.result ? match.result.kind === "draw" ? 0.5 : match.result.winnerId === roleA ? 1 : 0 : null;
    return { slotId: slot.id, conditionId: slot.conditionId!, blockId: slot.blockId!, replicate: slot.replicate!, gameId: slot.gameId,
      gameVersion: slot.gameVersion!, challengeId: slot.challengeId, roles: { ...slot.roles }, skipped: slot.skipped,
      firstMatchId: match?.id ?? null, firstStatus: match?.status ?? "pending", matchIds: [...slot.matchIds], score,
      eligible: eligibility.eligible, reasons: eligibility.reasons, acceptedActions: match?.history.filter((turn) => turn.valid).length ?? 0,
      requests: match ? [...match.history.flatMap((turn) => turn.attempts), ...(match.pendingTurn?.attempts ?? [])].filter((a) => a.phase !== "initialization").length : 0 };
  });
  const [control, treatment] = plan.comparison.conditions;
  const blocks = [...new Set(rows.map((row) => row.blockId))].sort().map((blockId) => {
    const stats = (conditionId: string) => {
      const scores = rows.filter((row) => row.blockId === blockId && row.conditionId === conditionId).map((row) => row.score);
      const observed = scores.filter((v): v is number => v !== null);
      return { complete: observed.length === scores.length, value: observed.length === scores.length ? mean(observed) : null,
        lower: mean(scores.map((v) => v ?? 0)), upper: mean(scores.map((v) => v ?? 1)) };
    };
    const a = stats(control), b = stats(treatment);
    return { blockId, control: a.value, treatment: b.value, difference: a.complete && b.complete ? b.value! - a.value! : null,
      lower: b.lower - a.upper, upper: b.upper - a.lower };
  });
  const complete = blocks.flatMap((b) => b.difference === null ? [] : [b.difference]);
  const ready = ["completed", "stopped"].includes(series.status);
  const interval = ready ? pairedBootstrap(complete, `${series.planHash}:paired-block-bootstrap-1`) : null;
  return {
    version: "paired-block-bootstrap-1", claimLevel: "exploratory-study", declaredPlanHash: series.planHash,
    execution: { qualifiedFirstAttempts: rows.filter((r) => r.eligible).length, plannedSlots: rows.length },
    study: { registeredDeclaration: true, independentlyReviewed: false, complete: complete.length === plan.blocks, status: series.status },
    primary: { contrast: `${treatment} minus ${control}`, participant: "agent-0", attemptPolicy: "first-attempt",
      plannedBlocks: plan.blocks, completeBlocks: complete.length, missingBlocks: plan.blocks - complete.length,
      estimate: ready && complete.length ? mean(complete) : null, confidenceInterval95: interval,
      missingOutcomeBounds: ready ? [mean(blocks.map((b) => b.lower)), mean(blocks.map((b) => b.upper))] : null,
      bootstrapSamples: interval ? 5000 : 0, practicalEffect: plan.practicalEffect,
      caveat: "Exploratory conditional estimate on complete blocks; missing-outcome bounds cover all planned blocks. A narrow bootstrap interval is not proof of equivalence or construct validity." },
    conditions: plan.conditions.map((condition) => {
      const items = rows.filter((row) => row.conditionId === condition.id);
      const scores = items.flatMap((row) => row.score === null ? [] : [row.score]);
      return { id: condition.id, label: condition.label, gameId: condition.gameId, gameVersion: condition.gameVersion,
        planned: items.length, scored: scores.length, missing: items.length - scores.length, outcomeShare: scores.length ? mean(scores) : null };
    }),
    blocks, rows,
  };
}
