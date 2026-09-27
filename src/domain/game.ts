import type { GameAction, GameObservation, MatchResult, PlayerSeat } from "../shared.js";

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

  list(): Array<{ id: string; version: string; playerIds: string[] }> {
    return [...this.games.values()].map((game) => ({ id: game.id, version: game.version, playerIds: [...game.playerIds] }));
  }
}
