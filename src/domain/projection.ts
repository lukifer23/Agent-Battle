import { defaultGames } from "./defaultGames.js";
import type { AgentAttempt, MatchRecord, PendingTurn, TurnTelemetry, PublicMatchDetail, MatchSummary, MatchEvent } from "../shared.js";

function projectAttempt(attempt: AgentAttempt): AgentAttempt {
  return {
    attempt: attempt.attempt,
    ...(attempt.invocationId ? { invocationId: attempt.invocationId } : {}),
    ...(attempt.deadlineAt ? { deadlineAt: attempt.deadlineAt } : {}),
    startedAt: attempt.startedAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.latencyMs !== undefined ? { latencyMs: attempt.latencyMs } : {}),
    ...(attempt.accountedMs !== undefined ? { accountedMs: attempt.accountedMs } : {}),
    ...(attempt.resolvedModel ? { resolvedModel: attempt.resolvedModel } : {}),
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
export function projectRecord(record: MatchRecord, eventLimit = 40, registry = defaultGames): PublicMatchDetail {
  const game = registry.get(record.gameId);
  const hidden = game.hiddenInformation;
  const turn = (value: TurnTelemetry): TurnTelemetry => {
    const safe = projectTurn(value);
    if (!hidden) return safe;
    safe.action = safe.valid && safe.action ? game.publicAction(safe.action) : undefined;
    safe.actionLabel = safe.action ? game.actionLabel(safe.action) : undefined;
    safe.attempts = safe.attempts.map((attempt) => ({ ...attempt, action: attempt.action ? game.publicAction(attempt.action) : undefined, error: attempt.error ? "Action rejected or request failed; private diagnostics retained locally." : undefined }));
    return safe;
  };
  const pending = record.pendingTurn ? projectPending(record.pendingTurn) : undefined;
  if (pending && hidden) {
    pending.feedback = undefined;
    pending.attempts = pending.attempts.map((attempt) => ({ ...attempt, action: attempt.action ? game.publicAction(attempt.action) : undefined, error: attempt.error ? "Request failed" : undefined }));
  }
  return {
    ...summaryOf(record),
    settings: structuredClone(record.settings),
    ...(record.timeAccounting ? { timeAccounting: { ...record.timeAccounting } } : {}),
    gameState: game.publicState(game.deserialize(record.gameState)),
    ...(game.publicReplay ? { replay: game.publicReplay(game.deserialize(record.gameState)) } : {}),
    history: record.history.map(turn),
    events: record.events.slice(-eventLimit).map((event) => projectEvent(record, event, registry)),
    ...(pending ? { pendingTurn: pending } : {}),
    ...(record.currentPlayerId ? { currentPlayerId: record.currentPlayerId } : {}),
    ...(record.error ? { error: hidden ? "Match interrupted. Review private local diagnostics for details." : record.error } : {}),
    ...(record.series ? { series: { ...record.series } } : {}),
  };
}

export function projectEvent(record: MatchRecord, event: MatchEvent, registry = defaultGames): MatchEvent {
  const game = registry.get(record.gameId);
  if (!game.hiddenInformation) {
    const payload: Record<string, unknown> = {};
    for (const key of ["turnId", "turnIndex", "ply", "attempt", "retry", "retryCount", "latencyMs", "legalActionCount", "fenBefore", "fen", "pgn", "move", "resignation", "action", "actionLabel", "nextPlayerId", "result", "kind", "winnerId", "reason", "status", "timeoutMs", "toolCalls", "inputTokens", "outputTokens", "usage"]) {
      if (event.payload?.[key] !== undefined) payload[key] = structuredClone(event.payload[key]);
    }
    if (event.payload?.record) payload.record = projectTurn(event.payload.record as TurnTelemetry);
    return { at: event.at, type: event.type, text: event.text, ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), ...(event.playerId ? { playerId: event.playerId } : {}), ...(event.payload ? { payload } : {}) };
  }
  // Hidden games publish an explicit event envelope. Raw provider text, actions,
  // arbitrary error strings, and nested telemetry must never enter durable events.
  const payload = event.payload ?? {};
  const safe: Record<string, unknown> = {};
  for (const key of ["ply", "turnIndex", "attempt", "retry", "latencyMs", "retryCount", "timeoutMs"]) {
    if (typeof payload[key] === "number") safe[key] = payload[key];
  }
  if (typeof payload.turnId === "string") safe.turnId = payload.turnId;
  // Durable hidden-game events already carry their event-time public projection.
  // Rebuilding from the current record would reveal the terminal word in earlier events.
  if (payload.publicState) safe.publicState = structuredClone(payload.publicState);
  if (payload.action && typeof payload.action === "object") safe.action = game.publicAction(payload.action as import("../shared.js").GameAction);
  return { at: event.at, type: event.type, text: event.type.replaceAll(".", " "), ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), ...(event.playerId ? { playerId: event.playerId } : {}), payload: safe };
}

export function summaryOf(record: MatchRecord): MatchSummary {
  return { id: record.id, gameId: record.gameId, gameVersion: record.gameVersion, protocolVersion: record.protocolVersion,
    createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.status,
    players: record.players.map((p) => ({ id: p.id, label: p.label, agent: { provider: p.agent.provider, model: p.agent.model, name: p.agent.name, ...(p.agent.reasoning ? { reasoning: p.agent.reasoning } : {}), ...(p.agent.resolvedModel ? { resolvedModel: p.agent.resolvedModel } : {}) } })) as MatchRecord["players"],
    timeControl: { maxMinutes: record.settings.budgets.maxWallMinutes, turnSeconds: record.settings.turnTimeoutSeconds, mode: record.timeAccounting ? "active" : "legacy" },
    revision: record.revision, actionCount: record.history.filter((t) => t.valid).length,
    ...(record.result ? { result: { kind: record.result.kind, notation: record.result.notation, reason: record.result.reason, ...(record.result.winnerId ? { winnerId: record.result.winnerId } : {}) } } : {}),
    ...(record.series ? { seriesId: record.series.id } : {}),
  };
}
