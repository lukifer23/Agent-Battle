import { isDeepStrictEqual } from "node:util";
import { isPlainObject, parseActionEnvelope } from "../../domain/actions.js";
import type { GameDefinition, ObservationContext, ActionValidation } from "../../domain/game.js";
import type { GameAction, GameMetric, GameObservation, MatchRecord, MatchResult } from "../../shared.js";
import { HangmanGame, hangmanActionSchema } from "./HangmanGame.js";
import { selectWord, type WordProvenance } from "./corpus.js";

type Role = "player1" | "player2";
interface Score { points: number; misses: number; actionsTaken: number; revealedLetters: number }
interface Entry { playerId: Role; action: GameAction; points: number; revealedPositions: number[]; correct: boolean }
export interface HangmanDuelState {
  ruleset: "shared-board-2";
  word: string;
  provenance: WordProvenance;
  guessedLetters: string[];
  misses: number;
  players: Record<Role, Score>;
  next: Role;
  end?: "solved" | "miss-limit" | "forfeit";
  forfeitedBy?: Role;
  entries: Entry[];
}
const legacy = new HangmanGame();
const roles = ["player1", "player2"] as const;
const opponent = (id: Role): Role => id === "player1" ? "player2" : "player1";
const blank = (): Score => ({ points: 0, misses: 0, actionsTaken: 0, revealedLetters: 0 });

/** Shared-board contest; legacy independent lanes remain registered for old records. */
export class HangmanDuelGame implements GameDefinition<HangmanDuelState> {
  readonly id = "hangman";
  readonly version = "shared-board-2";
  readonly observationVersion = "hangman-shared-observation-v3";
  readonly actionSchemaVersion = "game-action-v1";
  readonly hiddenInformation = true;
  readonly playerIds = roles;
  readonly series = { seatSensitive: true, supportsSeededChallenges: true, recommendedRepetitions: 6, defaultSeriesEnabled: true, challengeId: "shared-board-2" };
  playerLabel(id: string): string { return legacy.playerLabel(id); }
  cloneState(state: HangmanDuelState): HangmanDuelState { return structuredClone(state); }
  createState(seed?: string): HangmanDuelState {
    return { ruleset: this.version, ...selectWord(seed), guessedLetters: [], misses: 0, players: { player1: blank(), player2: blank() }, next: "player1", entries: [] };
  }
  currentPlayer(state: HangmanDuelState): Role | null { return state.end ? null : state.next; }
  isTerminal(state: HangmanDuelState): boolean { return Boolean(state.end); }
  plyCount(state: HangmanDuelState): number { return state.players.player1.actionsTaken + state.players.player2.actionsTaken; }
  private pattern(state: HangmanDuelState): string {
    return [...state.word].map((letter) => state.end === "solved" || state.guessedLetters.includes(letter) ? letter : "_").join(" ");
  }
  observe(state: HangmanDuelState, context: ObservationContext): GameObservation {
    if (this.currentPlayer(state) !== context.player.id) throw new Error("Not this player's turn.");
    const view = this.publicState(state);
    return {
      schemaVersion: this.observationVersion, gameId: this.id, matchId: context.matchId, turnId: context.turnId,
      playerId: context.player.id, playerLabel: context.player.label, sideToMove: state.next, ply: context.ply, turnIndex: context.turnIndex,
      state: { ...view, rules: {
        version: this.version, objective: "Beat the opponent's score on ONE shared board. Your guesses reveal information to both players. Turns alternate after every accepted action.",
        correctLetter: "+1 point per newly revealed position", wrongLetter: "-1 point and +1 shared miss", correctSolution: "+1 per still hidden position, plus 2 bonus points; ends the game", wrongSolution: "-2 points and +2 shared misses", lastLetter: "2 bonus points when a letter completes the word", end: "Word solved or 7 shared misses. Highest score wins; equal scores draw. A forfeiting player loses.",
      } },
      history: view.history,
      legalActions: [..."abcdefghijklmnopqrstuvwxyz"].filter((letter) => !state.guessedLetters.includes(letter)).map((letter) => ({ type: "guess_letter", payload: { letter } })),
      actionSchema: hangmanActionSchema(state.word.length), clock: { turnTimeoutMs: context.turnTimeoutMs }, status: "active",
      ...(context.feedback ? { feedback: context.feedback } : {}),
    };
  }
  validateAction(state: HangmanDuelState, id: string, raw: unknown): ActionValidation {
    if (this.currentPlayer(state) !== id) return { valid: false, reason: "Not this player's turn." };
    const action = parseActionEnvelope(raw);
    if (!action || Object.keys(action.payload).length !== 1) return { valid: false, reason: "Use exactly type and payload with one action field." };
    if (action.type === "guess_letter" && typeof action.payload.letter === "string" && /^[a-z]$/.test(action.payload.letter)) {
      return state.guessedLetters.includes(action.payload.letter) ? { valid: false, reason: "That letter was already guessed on the shared board. Choose an untried letter." } : { valid: true };
    }
    if (action.type === "solve" && typeof action.payload.word === "string" && new RegExp(`^[a-z]{${state.word.length}}$`).test(action.payload.word)) return { valid: true };
    return { valid: false, reason: "Use guess_letter with one lowercase letter, or solve with a lowercase word of the displayed length." };
  }
  applyAction(state: HangmanDuelState, id: string, raw: unknown): HangmanDuelState {
    const check = this.validateAction(state, id, raw);
    if (!check.valid) throw new Error(check.reason);
    const action = structuredClone(parseActionEnvelope(raw)!);
    const role = id as Role;
    const player = state.players[role];
    let points: number;
    let correct: boolean;
    let revealedPositions: number[] = [];
    if (action.type === "guess_letter") {
      const letter = action.payload.letter as string;
      revealedPositions = [...state.word].flatMap((character, index) => character === letter ? [index] : []);
      correct = revealedPositions.length > 0;
      points = correct ? revealedPositions.length : -1;
      state.guessedLetters.push(letter);
      if ([...state.word].every((character) => state.guessedLetters.includes(character))) { state.end = "solved"; points += 2; }
    } else {
      correct = action.payload.word === state.word;
      if (correct) {
        revealedPositions = [...state.word].flatMap((letter, index) => state.guessedLetters.includes(letter) ? [] : [index]);
        points = revealedPositions.length + 2;
        state.end = "solved";
      } else points = -2;
    }
    if (!correct) { state.misses -= points; player.misses -= points; }
    player.points += points;
    player.actionsTaken++;
    player.revealedLetters += revealedPositions.length;
    if (state.misses >= 7) state.end = "miss-limit";
    state.entries.push({ playerId: role, action, points, revealedPositions, correct });
    state.next = opponent(role);
    return state;
  }
  forfeit(state: HangmanDuelState, id: string): HangmanDuelState {
    if (this.currentPlayer(state) !== id) throw new Error("Cannot forfeit an inactive player.");
    state.forfeitedBy = id as Role; state.end = "forfeit";
    state.entries.push({ playerId: id as Role, action: { type: "lane_forfeit", payload: {} }, points: 0, revealedPositions: [], correct: false });
    return state;
  }
  result(state: HangmanDuelState): MatchResult | undefined {
    if (!state.end) return undefined;
    if (state.forfeitedBy) return this.winResult(opponent(state.forfeitedBy), "Opponent forfeited");
    const delta = state.players.player1.points - state.players.player2.points;
    const score = `${state.players.player1.points}–${state.players.player2.points}`;
    return delta ? this.winResult(delta > 0 ? "player1" : "player2", `Higher score (${score})`) : { kind: "draw", notation: "1/2-1/2", reason: `Equal score (${score})` };
  }
  winResult(id: string, reason: string): MatchResult { return legacy.winResult(id, reason); }
  serialize(state: HangmanDuelState): HangmanDuelState { return structuredClone(state); }
  deserialize(raw: unknown): HangmanDuelState {
    if (!isPlainObject(raw) || raw.ruleset !== this.version || !isPlainObject(raw.provenance) || !Array.isArray(raw.entries)) throw new Error("Invalid shared Hangman state.");
    const state = this.createState(raw.provenance.seed as string);
    for (const entry of raw.entries) {
      if (!isPlainObject(entry) || typeof entry.playerId !== "string" || !isPlainObject(entry.action)) throw new Error("Invalid Hangman action history.");
      if (entry.action.type === "lane_forfeit") this.forfeit(state, entry.playerId);
      else this.applyAction(state, entry.playerId, entry.action);
    }
    if (!isDeepStrictEqual(raw, state)) throw new Error("Hangman state differs from replay.");
    return state;
  }
  metrics(state: HangmanDuelState): GameMetric[] {
    const version = "hangman-shared-metrics-v1";
    return roles.flatMap((role) => {
      const player = state.players[role];
      const entries = state.entries.filter((entry) => entry.playerId === role);
      return [
        { key: "points", version, participantId: role, value: player.points, unit: "point" },
        { key: "pointDifferential", version, participantId: role, value: player.points - state.players[opponent(role)].points, unit: "point" },
        { key: "positionsRevealed", version, participantId: role, value: player.revealedLetters, unit: "position" },
        { key: "missesCaused", version, participantId: role, value: player.misses, unit: "miss" },
        { key: "correctGuesses", version, participantId: role, value: entries.filter((entry) => entry.action.type === "guess_letter" && entry.correct).length, unit: "guess" },
        { key: "incorrectGuesses", version, participantId: role, value: entries.filter((entry) => entry.action.type === "guess_letter" && !entry.correct).length, unit: "guess" },
        { key: "solveAttempts", version, participantId: role, value: entries.filter((entry) => entry.action.type === "solve").length, unit: "attempt" },
      ];
    });
  }

  publicState(state: HangmanDuelState) {
    return { ruleset: this.version, pattern: this.pattern(state), wordLength: state.word.length, guessedLetters: [...state.guessedLetters], misses: state.misses, missesAllowed: 7, terminal: this.isTerminal(state), currentPlayerId: this.currentPlayer(state), players: structuredClone(state.players),
      history: state.entries.map((entry) => ({ ...structuredClone(entry), action: this.publicAction(entry.action) })),
      ...(state.end ? { word: state.word, end: state.end, result: this.result(state) } : {}),
    };
  }
  publicReplay(state: HangmanDuelState): unknown[] {
    const replay = this.createState(state.provenance.seed);
    const frames = [this.publicState(replay)];
    for (const entry of state.entries) {
      if (entry.action.type === "lane_forfeit") this.forfeit(replay, entry.playerId);
      else this.applyAction(replay, entry.playerId, entry.action);
      frames.push(this.publicState(replay));
    }
    return frames;
  }
  validateRecord(record: MatchRecord, state: HangmanDuelState): string | undefined {
    let index = 0;
    for (const turn of record.history) {
      const entry = state.entries[index];
      if (!turn.valid && entry?.action.type !== "lane_forfeit") continue;
      if (!entry || entry.playerId !== turn.playerId || turn.matchId !== record.id) return "Hangman telemetry differs from action history";
      if (turn.valid) {
        if (!isDeepStrictEqual(turn.action, entry.action) || !turn.attempts.some((attempt) => attempt.status === "valid" && isDeepStrictEqual(attempt.action, entry.action))) return "Accepted Hangman action lacks matching evidence";
      } else if (turn.attempts.filter((attempt) => attempt.status === "invalid" || attempt.status === "timeout").length < record.settings.maxRetries + 1 || turn.attempts.some((attempt) => attempt.status === "valid")) return "Forfeit lacks exhausted correction evidence";
      index++;
    }
    if (index !== state.entries.length) return "Hangman action history lacks telemetry";
    const frames = this.publicReplay(state);
    let last = -1;
    for (const event of record.events) {
      if (!event.payload?.publicState) continue;
      const index = frames.findIndex((frame, i) => i > last && isDeepStrictEqual(frame, event.payload!.publicState));
      if (index < 0 || last >= 0 && index !== last + 1) return "Hangman event state differs from replay";
      last = index;
    }
    return undefined;
  }
  publicAction(action: GameAction): GameAction { return legacy.publicAction(action); }
  actionLabel(action: GameAction): string { return legacy.actionLabel(action); }
  eventProjection(state: HangmanDuelState): Record<string, unknown> { return { publicState: this.publicState(state) }; }
}
