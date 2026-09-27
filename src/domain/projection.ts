import type { AgentAttempt, MatchRecord, PendingTurn, TurnTelemetry } from "../shared.js";

function projectAttempt(attempt: AgentAttempt): AgentAttempt {
  return {
    attempt: attempt.attempt,
    startedAt: attempt.startedAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.latencyMs !== undefined ? { latencyMs: attempt.latencyMs } : {}),
    status: attempt.status,
    ...(attempt.phase ? { phase: attempt.phase } : {}),
    ...(attempt.action ? { action: attempt.action } : {}),
    ...(attempt.error ? { error: attempt.error } : {}),
    toolCalls: attempt.toolCalls,
    usage: attempt.usage,
  };
}

export function projectTurn(turn: TurnTelemetry): TurnTelemetry {
  return {
    matchId: turn.matchId,
    ply: turn.ply,
    turnIndex: turn.turnIndex,
    turnId: turn.turnId,
    agentId: turn.agentId,
    model: turn.model,
    provider: turn.provider,
    ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
    ...(turn.resolvedModel ? { resolvedModel: turn.resolvedModel } : {}),
    playerId: turn.playerId,
    playerLabel: turn.playerLabel,
    ...(turn.fenBefore ? { fenBefore: turn.fenBefore } : {}),
    legalActionCount: turn.legalActionCount,
    ...(turn.action ? { action: turn.action } : {}),
    ...(turn.actionLabel ? { actionLabel: turn.actionLabel } : {}),
    valid: turn.valid,
    latencyMs: turn.latencyMs,
    retryCount: turn.retryCount,
    attempts: turn.attempts.map(projectAttempt),
    ...(turn.fenAfter ? { fenAfter: turn.fenAfter } : {}),
    timestamp: turn.timestamp,
  };
}

function projectPending(pending: PendingTurn): PendingTurn {
  return { ...pending, attempts: pending.attempts.map(projectAttempt) };
}

/**
 * Produces the transport projection for a record: replay state, move list and
 * usage are retained, but bulky/legacy diagnostics (`responseExcerpt`,
 * `stderrExcerpt`, `stateBefore`, `stateAfter`) are dropped and the event feed is
 * bounded to its most recent window. Full diagnostics remain available from the
 * detail and attempts endpoints, which read the durable record.
 */
export function projectRecord(record: MatchRecord, eventLimit = 40): MatchRecord {
  return {
    ...record,
    history: record.history.map(projectTurn),
    events: record.events.slice(-eventLimit),
    ...(record.pendingTurn ? { pendingTurn: projectPending(record.pendingTurn) } : {}),
  };
}

export function summaryOf(record: MatchRecord): MatchRecord {
  return { ...record, history: [], events: [] };
}
