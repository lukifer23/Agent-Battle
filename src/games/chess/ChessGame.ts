import { Chess, type Move } from "chess.js";
import type { ChessMoveRecord, ChessSnapshot, GameAction, GameMetric, GameObservation, MatchRecord, MatchResult, PlayerSeat } from "../../shared.js";
import type { ActionValidation, GameDefinition, ObservationContext } from "../../domain/game.js";
import { isPlainObject, parseActionEnvelope } from "../../domain/actions.js";

interface ChessRuntimeState {
  chess: Chess;
  moves: ChessMoveRecord[];
  resignation?: { playerId: string; at: string };
}

function uci(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function safeSnapshot(value: unknown): ChessSnapshot {
  if (!isPlainObject(value)) throw new Error("Saved chess state is invalid.");
  const state = value as Partial<ChessSnapshot>;
  if (typeof state.fen !== "string" || typeof state.pgn !== "string" || !Array.isArray(state.moves)) {
    throw new Error("Saved chess state is missing FEN, PGN, or move history.");
  }
  return state as ChessSnapshot;
}

const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function validateMoveRecord(value: unknown, index: number): ChessMoveRecord {
  if (!isPlainObject(value)) throw new Error(`Saved move record ${index + 1} is not an object.`);
  const move = value as Partial<ChessMoveRecord>;
  if (move.ply !== index + 1) throw new Error(`Saved move record ${index + 1} has a non-contiguous ply number.`);
  if (move.color !== "white" && move.color !== "black") throw new Error(`Saved move record ${index + 1} has an invalid color.`);
  if (typeof move.san !== "string" || move.san.length === 0) throw new Error(`Saved move record ${index + 1} is missing SAN.`);
  if (typeof move.uci !== "string" || !uciPattern.test(move.uci)) throw new Error(`Saved move record ${index + 1} has an invalid UCI move.`);
  if (typeof move.fen !== "string") throw new Error(`Saved move record ${index + 1} is missing a FEN checkpoint.`);
  if (typeof move.at !== "string" || Number.isNaN(Date.parse(move.at))) throw new Error(`Saved move record ${index + 1} has an invalid timestamp.`);
  return move as ChessMoveRecord;
}

function validateResignation(value: unknown): { playerId: string; at: string } | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error("Saved resignation metadata is invalid.");
  const { playerId, at } = value as { playerId?: unknown; at?: unknown };
  if (playerId !== "white" && playerId !== "black") throw new Error("Saved resignation names an unknown player.");
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new Error("Saved resignation has an invalid timestamp.");
  return { playerId, at };
}

export class ChessGame implements GameDefinition<ChessRuntimeState> {
  readonly id = "chess";
  readonly version = "standard-1";
  readonly observationVersion = "chess-observation-v3";
  readonly actionSchemaVersion = "game-action-v1";
  readonly playerIds = ["white", "black"] as const;
  readonly hiddenInformation = false;
  readonly series = { seatSensitive: true, supportsSeededChallenges: false, recommendedRepetitions: 6, defaultSeriesEnabled: true, challengeId: "standard-start-v1" };
  cloneState(state: ChessRuntimeState): ChessRuntimeState { return this.deserialize(this.serialize(state)); }
  publicAction(action: GameAction): GameAction { return structuredClone(action); }

  playerLabel(playerId: string): string {
    if (playerId === "white" || playerId === "black") return playerId === "white" ? "White" : "Black";
    throw new Error(`Unknown chess player ${playerId}.`);
  }

  createState(): ChessRuntimeState {
    return { chess: new Chess(), moves: [] };
  }

  currentPlayer(state: ChessRuntimeState): string | null {
    if (this.isTerminal(state)) return null;
    return state.chess.turn() === "w" ? "white" : "black";
  }

  plyCount(state: ChessRuntimeState): number {
    return state.moves.length;
  }

  legalActions(state: ChessRuntimeState, playerId: string): GameAction[] {
    if (this.currentPlayer(state) !== playerId) return [];
    return [
      ...state.chess.moves({ verbose: true }).map((move) => ({ type: "move", payload: { move: uci(move) } })),
      { type: "resign", payload: {} },
    ];
  }

  observe(state: ChessRuntimeState, context: ObservationContext): GameObservation {
    const sideToMove = this.currentPlayer(state);
    if (!sideToMove || sideToMove !== context.player.id) throw new Error("Cannot generate an observation for a player whose turn is not active.");
    const legalActions = this.legalActions(state, context.player.id);
    const moves = legalActions.filter((action) => action.type === "move").map((action) => action.payload.move as string);
    return {
      schemaVersion: this.observationVersion,
      gameId: this.id,
      matchId: context.matchId,
      turnId: context.turnId,
      playerId: context.player.id,
      playerLabel: context.player.label,
      sideToMove,
      ply: context.ply,
      turnIndex: context.turnIndex,
      state: {
        fen: state.chess.fen(),
        side_to_move: sideToMove,
        move_number: state.chess.moveNumber(),
        status: "active",
      },
      legalActions,
      actionSchema: this.schemaFor(moves),
      history: state.moves.map(({ ply, color, san, uci: move }) => ({ ply, color, san, uci: move })),
      clock: { turnTimeoutMs: context.turnTimeoutMs },
      status: "active",
      ...(context.feedback ? { feedback: context.feedback } : {}),
    };
  }

  validateAction(state: ChessRuntimeState, playerId: string, action: unknown): ActionValidation {
    if (this.currentPlayer(state) !== playerId) return { valid: false, reason: `It is not ${playerId}'s turn.` };
    const envelope = parseActionEnvelope(action);
    if (!envelope) return { valid: false, reason: "Action must be an object with exactly the fields type and payload, and payload must be an object." };
    if (envelope.type === "resign") {
      return Object.keys(envelope.payload).length === 0 ? { valid: true } : { valid: false, reason: "Resign action payload must be empty." };
    }
    if (envelope.type !== "move") return { valid: false, reason: `Unsupported chess action type "${envelope.type}".` };
    const payloadKeys = Object.keys(envelope.payload);
    if (payloadKeys.length !== 1 || payloadKeys[0] !== "move") {
      return { valid: false, reason: "Move payload must contain only a move field." };
    }
    const move = envelope.payload.move;
    if (typeof move !== "string" || !uciPattern.test(move)) {
      return { valid: false, reason: "Move must use lowercase UCI coordinate notation such as e2e4." };
    }
    if (!this.legalActions(state, playerId).some((legal) => legal.type === "move" && legal.payload.move === move)) {
      return { valid: false, reason: `Move "${move}" is illegal in the current position.` };
    }
    return { valid: true };
  }

  applyAction(state: ChessRuntimeState, playerId: string, action: unknown): ChessRuntimeState {
    const validation = this.validateAction(state, playerId, action);
    if (!validation.valid) throw new Error(validation.reason ?? "Invalid chess action.");
    const envelope = parseActionEnvelope(action)!;
    if (envelope.type === "resign") {
      state.resignation = { playerId, at: new Date().toISOString() };
      return state;
    }
    const moveText = envelope.payload.move as string;
    const from = moveText.slice(0, 2);
    const to = moveText.slice(2, 4);
    const promotion = moveText[4]?.toLowerCase();
    const played = state.chess.move({ from, to, ...(promotion ? { promotion } : {}) });
    state.moves.push({
      ply: state.moves.length + 1,
      color: played.color === "w" ? "white" : "black",
      san: played.san,
      uci: uci(played),
      fen: state.chess.fen(),
      at: new Date().toISOString(),
    });
    return state;
  }

  isTerminal(state: ChessRuntimeState): boolean {
    return Boolean(state.resignation) || state.chess.isGameOver();
  }

  result(state: ChessRuntimeState): MatchResult | undefined {
    if (state.resignation) {
      const winnerId = state.resignation.playerId === "white" ? "black" : "white";
      return { kind: "win", winnerId, notation: winnerId === "white" ? "1-0" : "0-1", reason: `${state.resignation.playerId} resigned` };
    }
    if (!state.chess.isGameOver()) return undefined;
    if (state.chess.isCheckmate()) {
      const winnerId = state.chess.turn() === "w" ? "black" : "white";
      return { kind: "win", winnerId, notation: winnerId === "white" ? "1-0" : "0-1", reason: `Checkmate — ${winnerId} wins` };
    }
    if (state.chess.isStalemate()) return { kind: "draw", notation: "1/2-1/2", reason: "Stalemate" };
    if (state.chess.isThreefoldRepetition()) return { kind: "draw", notation: "1/2-1/2", reason: "Threefold repetition" };
    if (state.chess.isDrawByFiftyMoves()) return { kind: "draw", notation: "1/2-1/2", reason: "Fifty-move rule" };
    if (state.chess.isInsufficientMaterial()) return { kind: "draw", notation: "1/2-1/2", reason: "Insufficient material" };
    return { kind: "draw", notation: "1/2-1/2", reason: "Draw" };
  }

  winResult(winnerId: string, reason: string): MatchResult {
    if (winnerId !== "white" && winnerId !== "black") throw new Error(`Unknown chess winner ${winnerId}.`);
    return { kind: "win", winnerId, notation: winnerId === "white" ? "1-0" : "0-1", reason };
  }

  serialize(state: ChessRuntimeState, result?: MatchResult): ChessSnapshot {
    if (result) state.chess.setHeader("Result", result.notation);
    return { fen: state.chess.fen(), pgn: state.chess.pgn(), moves: state.moves.map((move) => ({ ...move })), ...(state.resignation ? { resignation: { ...state.resignation } } : {}) };
  }

  publicState(state: ChessRuntimeState): ChessSnapshot { return this.serialize(state); }

  eventProjection(state: ChessRuntimeState): Record<string, unknown> {
    const latestMove = state.moves.at(-1);
    return {
      fen: state.chess.fen(),
      pgn: state.chess.pgn(),
      ...(latestMove ? { move: { ...latestMove } } : {}),
      ...(state.resignation ? { resignation: { ...state.resignation } } : {}),
    };
  }

  deserialize(saved: unknown): ChessRuntimeState {
    const snapshot = safeSnapshot(saved);
    const moves = snapshot.moves.map((move, index) => validateMoveRecord(move, index));
    const resignation = validateResignation(snapshot.resignation);
    const chess = new Chess();
    if (snapshot.pgn) {
      try { chess.loadPgn(snapshot.pgn); }
      catch (error) { throw new Error(`Saved PGN could not be parsed: ${error instanceof Error ? error.message : "invalid PGN"}`); }
    }
    if (chess.fen() !== snapshot.fen) throw new Error("Saved PGN and FEN do not describe the same chess position.");
    const replay = new Chess();
    if (moves.length !== chess.history().length) throw new Error("Saved move records do not match the PGN history length.");
    for (const [index, move] of moves.entries()) {
      const played = replay.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), ...(move.uci[4] ? { promotion: move.uci[4] } : {}) });
      if (played.san !== move.san || replay.fen() !== move.fen || uci(played) !== move.uci) {
        throw new Error(`Saved move record ${index + 1} does not match replayed chess state.`);
      }
      const expectedColor = played.color === "w" ? "white" : "black";
      if (move.color !== expectedColor) throw new Error(`Saved move record ${index + 1} has the wrong color.`);
    }
    if (replay.fen() !== snapshot.fen) throw new Error("Saved move history does not lead to the recorded FEN.");
    return { chess, moves, ...(resignation ? { resignation } : {}) };
  }

  actionLabel(action: GameAction): string {
    if (action.type === "resign") return "Resignation";
    const move = action.payload.move;
    return typeof move === "string" ? move : "Invalid move";
  }

  metrics(state: ChessRuntimeState, record: MatchRecord): GameMetric[] {
    const version = "chess-metrics-v1";
    const attempts = record.history.flatMap((turn) => turn.attempts).filter((attempt) => attempt.phase !== "initialization");
    const invalid = attempts.filter((attempt) => attempt.status === "invalid" || attempt.status === "timeout").length;
    return [
      { key: "acceptedPlies", version, value: state.moves.length, unit: "ply" },
      { key: "termination", version, value: this.result(state)?.reason ?? record.status, unit: "label" },
      { key: "invalidRate", version, value: attempts.length ? invalid / attempts.length : null, unit: "ratio" },
    ];
  }

  private schemaFor(legalMoves: string[]): Record<string, unknown> {
    const variant = (type: string, payload: Record<string, unknown>) => ({
      type: "object", required: ["type", "payload"], additionalProperties: false,
      properties: { type: { const: type }, payload },
    });
    return { type: "object", oneOf: [
      variant("move", { type: "object", required: ["move"], additionalProperties: false, properties: { move: { type: "string", enum: legalMoves } } }),
      variant("resign", { type: "object", required: [], additionalProperties: false, properties: {} }),
    ] };
  }
}

export function chessSideSeat(playerId: string, agent: PlayerSeat["agent"]): PlayerSeat {
  if (playerId !== "white" && playerId !== "black") throw new Error(`Unknown chess player ${playerId}.`);
  return { id: playerId, label: playerId === "white" ? "White" : "Black", agent };
}
