import type { AppState, ChessMoveRecord, ChessSnapshot, MatchEvent, MatchRecord } from "../shared.js";

export const matchEventTypes = [
  "match.created", "match.started", "match.resumed", "match.paused", "match.stopped", "match.finished",
  "turn.started", "turn.completed", "turn.retry", "agent.ready", "agent.thinking", "agent.started",
  "agent.response", "agent.timeout", "agent.error", "move.proposed", "move.rejected", "move.applied",
];

export function applyMatchEvent(state: AppState, matchId: string, event: MatchEvent): AppState {
  const apply = (match: MatchRecord | null): MatchRecord | null => {
    if (!match || match.id !== matchId) return match;
    const payload = event.payload ?? {};
    const updated: MatchRecord = {
      ...match,
      updatedAt: event.at,
      events: [...match.events, event].slice(-500),
    };
    if (event.type === "match.created") updated.status = "ready";
    if (event.type === "match.started" || event.type === "match.resumed" || event.type === "turn.started") updated.status = "running";
    if (event.type === "turn.started" && event.playerId) updated.currentPlayerId = event.playerId;
    if (event.type === "move.applied") {
      const snapshot = match.gameState as ChessSnapshot;
      const move = payload.move as ChessMoveRecord | undefined;
      const fen = typeof payload.fen === "string" ? payload.fen : snapshot.fen;
      updated.gameState = {
        ...snapshot,
        fen,
        ...(move ? { moves: [...snapshot.moves.filter((item) => item.ply !== move.ply), move].sort((left, right) => left.ply - right.ply) } : {}),
      } satisfies ChessSnapshot;
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
  const activeMatch = activeUpdated && ["ready", "running", "paused", "interrupted"].includes(activeUpdated.status) ? activeUpdated : null;
  return { ...state, activeMatch, recentMatches };
}
