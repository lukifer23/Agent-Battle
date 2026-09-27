import type { AgentAttempt, MatchRecord } from "../shared.js";

export interface UsageTotal {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  coverage: "none" | "partial" | "full";
}

function addOptional(total: { cachedInputTokens: number; cacheWriteTokens: number; reasoningTokens: number }, usage: AgentAttempt["usage"]): boolean {
  let missing = false;
  if (typeof usage.cachedInputTokens === "number") total.cachedInputTokens += usage.cachedInputTokens; else missing = true;
  if (typeof usage.cacheWriteTokens === "number") total.cacheWriteTokens += usage.cacheWriteTokens; else missing = true;
  if (typeof usage.reasoningTokens === "number") total.reasoningTokens += usage.reasoningTokens; else missing = true;
  return missing;
}

/** Aggregates reported usage across attempts, tracking coverage instead of treating unknown as zero. */
export function aggregateUsage(attempts: AgentAttempt[]): UsageTotal {
  const total = { requests: attempts.length, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 };
  let anyData = false;
  let missing = false;
  for (const attempt of attempts) {
    const usage = attempt.usage;
    if (usage.inputTokens === null) missing = true; else { total.inputTokens += usage.inputTokens; anyData = true; }
    if (usage.outputTokens === null) missing = true; else { total.outputTokens += usage.outputTokens; anyData = true; }
    if (usage.costUsd === null) missing = true; else { total.costUsd += usage.costUsd; anyData = true; }
    if (addOptional(total, usage)) missing = true; else anyData = true;
  }
  const coverage = attempts.length === 0 ? "none" : !anyData ? "none" : missing ? "partial" : "full";
  return { ...total, coverage };
}

export function allAttempts(match: MatchRecord): AgentAttempt[] {
  const attempts = match.history.flatMap((turn) => turn.attempts);
  if (match.pendingTurn) attempts.push(...match.pendingTurn.attempts);
  return attempts;
}

export function matchRequests(match: MatchRecord): number {
  return allAttempts(match).length;
}

export function matchReportedCost(match: MatchRecord): number | null {
  const costs = allAttempts(match).map((attempt) => attempt.usage.costUsd).filter((value): value is number => value !== null);
  return costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
}
