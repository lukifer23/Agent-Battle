import { isDeepStrictEqual } from "node:util";
import type { GameAction, GameObservation, MatchResult, MatchRecord, PlayerSeat } from "../shared.js";

export interface ObservationContext {
  matchId: string;
  turnId: string;
  player: PlayerSeat;
  /** Board half-move number of the move about to be played (1-based). */
  ply: number;
  /** Sequential agent turn within the match (1-based). */
  turnIndex: number;
  turnTimeoutMs: number;
  feedback?: string;
}

export interface ActionValidation {
  valid: boolean;
  reason?: string;
}

export interface GameDefinition<State> {
  readonly id: string;
  readonly version: string;
  readonly observationVersion: string;
  readonly actionSchemaVersion: string;
  readonly playerIds: readonly string[];
  playerLabel(playerId: string): string;
  createState(): State;
  currentPlayer(state: State): string | null;
  /** Number of board plies already applied to the state. */
  plyCount(state: State): number;
  observe(state: State, context: ObservationContext): GameObservation;
  validateAction(state: State, playerId: string, action: unknown): ActionValidation;
  applyAction(state: State, playerId: string, action: unknown): State;
  isTerminal(state: State): boolean;
  result(state: State): MatchResult | undefined;
  winResult(winnerId: string, reason: string): MatchResult;
  serialize(state: State, result?: MatchResult): unknown;
  deserialize(saved: unknown): State;
  publicState(state: State): unknown;
  publicReplay?(state: State): unknown[];
  validateRecord?(record: MatchRecord, state: State): string | undefined;
  publicAction?(action: GameAction): GameAction;
  forfeit?(state: State, playerId: string): State;
  actionLabel(action: GameAction): string;
  eventProjection(state: State): Record<string, unknown>;
}

export class GameRegistry {
  private readonly games = new Map<string, GameDefinition<unknown>>();

  register<State>(game: GameDefinition<State>): this {
    if (this.games.has(game.id)) throw new Error(`A game named ${game.id} is already registered.`);
    this.games.set(game.id, game as unknown as GameDefinition<unknown>);
    return this;
  }

  get(gameId: string): GameDefinition<unknown> {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`Game "${gameId}" is not registered.`);
    return game;
  }

  validateRecord(record: MatchRecord): string | undefined {
    try {
      const game = this.get(record.gameId);
      if (game.version !== record.gameVersion) return "Unsupported game version";
      if (record.players.map((p) => p.id).join() !== game.playerIds.join()) return "Invalid player roles";
      const state = game.deserialize(record.gameState);
      const gameError = game.validateRecord?.(record, state);
      if (gameError) return gameError;
      const invocationIds = [...record.history.flatMap((turn) => turn.attempts), ...(record.pendingTurn?.attempts ?? [])].flatMap((a) => a.invocationId ? [a.invocationId] : []);
      if (new Set(invocationIds).size !== invocationIds.length) return "Duplicate invocation identity";

      if (record.status === "finished") {
        const result = game.result(state);
        if (!result || !isDeepStrictEqual(result, record.result)) return "Finished result differs from replay";
      }
      if (record.status === "forfeit") {
        const loser = record.history.at(-1);
        if (game.forfeit || !loser || loser.valid || !game.playerIds.includes(loser.playerId)
          || loser.attempts.filter((a) => a.status === "invalid" || a.status === "timeout").length < record.settings.maxRetries + 1
          || loser.attempts.some((a) => a.status === "valid")) return "Invalid forfeit evidence";
        const winner = game.playerIds.find((id) => id !== loser.playerId)!;
        const result = game.winResult(winner, record.result?.reason ?? "");
        if (!isDeepStrictEqual(result, record.result)) return "Invalid forfeit result";
      }
    } catch { return "Saved game failed authoritative validation"; }
    return undefined;
  }

  list(): Array<{ id: string; version: string; playerIds: string[] }> {
    return [...this.games.values()].map((game) => ({ id: game.id, version: game.version, playerIds: [...game.playerIds] }));
  }
}
