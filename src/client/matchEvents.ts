import type { AppState, ChessMoveRecord, ChessSnapshot, MatchEvent, MatchRecord, TurnTelemetry } from "../shared.js";

export const matchEventTypes = [
  "match.created", "match.started", "match.resumed", "match.paused", "match.stopped", "match.finished",
  "turn.started", "turn.completed", "turn.retry", "agent.ready", "agent.thinking", "agent.started",
  "agent.response", "agent.timeout", "agent.error", "move.proposed", "move.rejected", "move.applied",
];

/** Presentation events never advance a durable revision or replay after reconnect. */
export function applyPresentationEvent(state: AppState, matchId: string, event: MatchEvent): AppState {
  const append = (match: MatchRecord): MatchRecord => match.id === matchId
    ? { ...match, events: [...match.events, event].slice(-500) }
    : match;
  return {
    ...state,
    activeMatch: state.activeMatch ? append(state.activeMatch) : null,
    recentMatches: state.recentMatches.map(append),
  };
}

const activeStatuses = ["ready", "running", "paused", "interrupted"];

/**
 * Idempotent reducer: an event whose revision is not newer than the record's is
 * ignored, so duplicate or out-of-order delivery cannot corrupt state. Missing
 * domain events are recovered by refetching the canonical snapshot (handled by
 * the caller when a revision gap is detected).
 */
export function applyMatchEvent(state: AppState, matchId: string, event: MatchEvent, revision?: number): AppState {
  const apply = (match: MatchRecord | null): MatchRecord | null => {
    if (!match || match.id !== matchId) return match;
    const nextRevision = revision ?? event.sequence ?? (match.revision ?? 0) + 1;
    if ((match.revision ?? 0) >= nextRevision) return match;
    const payload = event.payload ?? {};
    const updated: MatchRecord = {
      ...match,
      updatedAt: event.at,
      revision: nextRevision,
      events: [...match.events, event].slice(-500),
    };
    if (event.type === "match.created") updated.status = "ready";
    if (event.type === "match.started" || event.type === "match.resumed" || event.type === "turn.started") updated.status = "running";
    if (event.type === "turn.started" && event.playerId) updated.currentPlayerId = event.playerId;
    if (event.type === "move.applied") {
      const snapshot = match.gameState as ChessSnapshot;
      const move = payload.move as ChessMoveRecord | undefined;
      const fen = typeof payload.fen === "string" ? payload.fen : snapshot.fen;
      const pgn = typeof payload.pgn === "string" ? payload.pgn : snapshot.pgn;
      updated.gameState = {
        ...snapshot,
        fen,
        pgn,
        ...(move ? { moves: [...snapshot.moves.filter((item) => item.ply !== move.ply), move].sort((left, right) => left.ply - right.ply) } : {}),
      } satisfies ChessSnapshot;
      updated.currentPlayerId = typeof payload.nextPlayerId === "string" ? payload.nextPlayerId : undefined;
    }
    if (event.type === "turn.completed") {
      const record = payload.record as TurnTelemetry | undefined;
      if (record && typeof record === "object" && !match.history.some((turn) => turn.turnId === record.turnId)) {
        updated.history = [...match.history, record];
      }
    }
    if (event.type === "match.paused" || event.type === "match.stopped") {
      updated.status = event.type === "match.paused" ? "paused" : "stopped";
      updated.currentPlayerId = undefined;
    }
    if (event.type === "agent.error") {
      updated.status = "error";
      updated.error = event.text;
      updated.currentPlayerId = undefined;
    }
    if (event.type === "match.finished") {
      const notation = typeof payload.result === "string" ? payload.result : "1/2-1/2";
      const kind = payload.kind === "draw" ? "draw" : "win";
      const winnerId = typeof payload.winnerId === "string" ? payload.winnerId : undefined;
      updated.status = payload.status === "forfeit" ? "forfeit" : "finished";
      updated.result = {
        kind,
        notation,
        reason: typeof payload.reason === "string" ? payload.reason : "Game finished",
        ...(winnerId ? { winnerId } : {}),
      };
      updated.currentPlayerId = undefined;
      updated.error = undefined;
    }
    return updated;
  };

  const recentMatches = state.recentMatches.map((match) => apply(match) ?? match);
  const activeUpdated = state.activeMatch?.id === matchId ? apply(state.activeMatch) : state.activeMatch;
  const activeMatch = activeUpdated && activeStatuses.includes(activeUpdated.status) ? activeUpdated : null;
  return {
    ...state,
    revision: Math.max(state.revision, ...recentMatches.map((match) => match.revision ?? 0)),
    activeMatch,
    activeMatchId: activeMatch?.id ?? null,
    recentMatches,
  };
}
