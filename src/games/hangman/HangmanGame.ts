import { isDeepStrictEqual } from "node:util";
import { parseActionEnvelope, isPlainObject } from "../../domain/actions.js";
import type { GameDefinition, ObservationContext, ActionValidation } from "../../domain/game.js";
import type { GameAction, GameObservation, MatchResult, MatchRecord } from "../../shared.js";
import { selectWord, type WordProvenance } from "./corpus.js";

export type HangmanRole = "player1" | "player2";
export interface HangmanLane {
  guessedLetters: string[];
  misses: number;
  actionsTaken: number;
  status: "active" | "solved" | "failed" | "forfeit";
}
interface Entry { playerId: HangmanRole; action: GameAction }
export interface HangmanState {
  ruleset: "independent-lanes-1";
  word: string;
  provenance: WordProvenance;
  lanes: Record<HangmanRole, HangmanLane>;
  next: HangmanRole;
  entries: Entry[];
}
const roles = ["player1", "player2"] as const;
const blank = (): HangmanLane => ({ guessedLetters: [], misses: 0, actionsTaken: 0, status: "active" });
const other = (role: HangmanRole): HangmanRole => role === "player1" ? "player2" : "player1";

export class HangmanGame implements GameDefinition<HangmanState> {
  readonly id = "hangman";
  readonly version = "independent-lanes-1";
  readonly observationVersion = "hangman-observation-v1";
  readonly actionSchemaVersion = "game-action-v1";
  readonly playerIds = roles;
  playerLabel(id: string): string {
    if (!roles.includes(id as HangmanRole)) throw new Error("Unknown Hangman role.");
    return id === "player1" ? "Player 1" : "Player 2";
  }
  createState(seed?: string): HangmanState {
    return { ruleset: this.version, ...selectWord(seed), lanes: { player1: blank(), player2: blank() }, next: "player1", entries: [] };
  }
  currentPlayer(state: HangmanState): HangmanRole | null {
    if (state.lanes[state.next].status === "active") return state.next;
    if (state.lanes[other(state.next)].status === "active") return other(state.next);
    return null;
  }
  plyCount(state: HangmanState): number { return state.lanes.player1.actionsTaken + state.lanes.player2.actionsTaken; }
  isTerminal(state: HangmanState): boolean { return this.currentPlayer(state) === null; }
  private pattern(state: HangmanState, role: HangmanRole): string {
    return [...state.word].map((letter) => state.lanes[role].guessedLetters.includes(letter) ? letter : "_").join(" ");
  }
  observe(state: HangmanState, context: ObservationContext): GameObservation {
    if (this.currentPlayer(state) !== context.player.id) throw new Error("Player lane is not active.");
    const role = context.player.id as HangmanRole;
    const lane = state.lanes[role];
    return {
      schemaVersion: this.observationVersion, gameId: this.id, matchId: context.matchId, turnId: context.turnId,
      playerId: role, playerLabel: this.playerLabel(role), sideToMove: role,
      ply: lane.actionsTaken + 1, turnIndex: lane.actionsTaken + 1,
      state: { pattern: this.pattern(state, role), wordLength: state.word.length, guessedLetters: [...lane.guessedLetters], misses: lane.misses, missesAllowed: 7, actionsTaken: lane.actionsTaken,
        rules: { version: this.version, incorrectLetterMisses: 1, incorrectSolutionMisses: 2, repeatedLetter: "invalid; one correction allowed", failureAtMisses: 7,
          objective: "Solve the word. A solved lane wins over an ordinary failed lane. Among solved lanes minimize misses, then accepted actions. Among failed lanes maximize distinct correctly guessed letters. A forfeited lane loses to a non-forfeited lane." },
      },
      history: state.entries.filter((entry) => entry.playerId === role).map((entry) => structuredClone(entry.action)),
      legalActions: [..."abcdefghijklmnopqrstuvwxyz"].filter((letter) => !lane.guessedLetters.includes(letter)).map((letter) => ({ type: "guess_letter", payload: { letter } })),
      actionSchema: { type: "object", oneOf: [
        { type: "object", additionalProperties: false, required: ["type", "payload"], properties: { type: { const: "guess_letter" }, payload: { type: "object", additionalProperties: false, required: ["letter"], properties: { letter: { type: "string", pattern: "^[a-z]$" } } } } },
        { type: "object", additionalProperties: false, required: ["type", "payload"], properties: { type: { const: "solve" }, payload: { type: "object", additionalProperties: false, required: ["word"], properties: { word: { type: "string", pattern: `^[a-z]{${state.word.length}}$` } } } } },
      ] },
      clock: { turnTimeoutMs: context.turnTimeoutMs }, status: "active",
      ...(context.feedback ? { feedback: context.feedback } : {}),
    };
  }
  validateAction(state: HangmanState, id: string, raw: unknown): ActionValidation {
    if (this.currentPlayer(state) !== id) return { valid: false, reason: "Player lane is not active." };
    const action = parseActionEnvelope(raw);
    if (!action || Object.keys(action.payload).length !== 1) return { valid: false, reason: "Use exactly type and payload with one action field." };
    if (action.type === "guess_letter" && typeof action.payload.letter === "string" && /^[a-z]$/.test(action.payload.letter)) {
      return state.lanes[id as HangmanRole].guessedLetters.includes(action.payload.letter)
        ? { valid: false, reason: "That letter has already been guessed. Choose an untried letter." } : { valid: true };
    }
    if (action.type === "solve" && typeof action.payload.word === "string" && new RegExp(`^[a-z]{${state.word.length}}$`).test(action.payload.word)) return { valid: true };
    return { valid: false, reason: "Use guess_letter with one lowercase ASCII letter, or solve with a lowercase word of the displayed length." };
  }
  applyAction(state: HangmanState, id: string, raw: unknown): HangmanState {
    const check = this.validateAction(state, id, raw);
    if (!check.valid) throw new Error(check.reason);
    const action = structuredClone(parseActionEnvelope(raw)!);
    const role = id as HangmanRole;
    const lane = state.lanes[role];
    lane.actionsTaken++;
    if (action.type === "guess_letter") {
      const letter = action.payload.letter as string;
      lane.guessedLetters.push(letter);
      if (!state.word.includes(letter)) lane.misses++;
      if ([...state.word].every((character) => lane.guessedLetters.includes(character))) lane.status = "solved";
    } else if (action.payload.word === state.word) lane.status = "solved";
    else lane.misses += 2;
    if (lane.misses >= 7) lane.status = "failed";
    state.entries.push({ playerId: role, action });
    state.next = other(role);
    return state;
  }
  forfeit(state: HangmanState, id: string): HangmanState {
    if (this.currentPlayer(state) !== id) throw new Error("Cannot forfeit an inactive lane.");
    const role = id as HangmanRole;
    state.lanes[role].status = "forfeit";
    state.entries.push({ playerId: role, action: { type: "lane_forfeit", payload: {} } });
    state.next = other(role);
    return state;
  }
  result(state: HangmanState): MatchResult | undefined {
    if (!this.isTerminal(state)) return undefined;
    const [a, b] = roles.map((role) => state.lanes[role]);
    let delta = 0;
    let reason = "Equal performance";
    if (a.status === "forfeit" || b.status === "forfeit") { delta = Number(b.status === "forfeit") - Number(a.status === "forfeit"); reason = delta ? "Opponent lane forfeited" : "Both lanes forfeited"; }
    else if ((a.status === "solved") !== (b.status === "solved")) { delta = a.status === "solved" ? 1 : -1; reason = "Solved beats unsolved"; }
    else if (a.status === "solved") {
      delta = b.misses - a.misses; reason = "Fewer misses";
      if (!delta) { delta = b.actionsTaken - a.actionsTaken; reason = "Fewer actions"; }
    } else {
      const correct = (lane: HangmanLane) => lane.guessedLetters.filter((letter) => state.word.includes(letter)).length;
      delta = correct(a) - correct(b); reason = "More distinct correct letters";
    }
    return delta ? this.winResult(delta > 0 ? "player1" : "player2", reason) : { kind: "draw", notation: "1/2-1/2", reason: "Equal performance" };
  }
  winResult(id: string, reason: string): MatchResult {
    this.playerLabel(id);
    return { kind: "win", winnerId: id, notation: id === "player1" ? "1-0" : "0-1", reason };
  }
  serialize(state: HangmanState): HangmanState { return structuredClone(state); }
  deserialize(saved: unknown): HangmanState {
    if (!isPlainObject(saved) || saved.ruleset !== this.version || typeof saved.word !== "string" || !isPlainObject(saved.provenance) || !Array.isArray(saved.entries)) throw new Error("Invalid saved Hangman state.");
    const rebuilt = this.createState(saved.provenance.seed as string);
    if (rebuilt.word !== saved.word || !isDeepStrictEqual(rebuilt.provenance, saved.provenance)) throw new Error("Invalid Hangman word provenance.");
    for (const raw of saved.entries) {
      if (!isPlainObject(raw) || typeof raw.playerId !== "string" || !isPlainObject(raw.action)) throw new Error("Invalid Hangman history.");
      if (raw.action.type === "lane_forfeit") {
        if (!isDeepStrictEqual(raw.action, { type: "lane_forfeit", payload: {} })) throw new Error("Invalid lane adjudication.");
        this.forfeit(rebuilt, raw.playerId);
      } else this.applyAction(rebuilt, raw.playerId, raw.action);
    }
    if (!isDeepStrictEqual(rebuilt, saved)) throw new Error("Hangman state differs from replay.");
    return rebuilt;
  }
  publicState(state: HangmanState): Record<string, unknown> {
    const terminal = this.isTerminal(state);
    return { ruleset: this.version, wordLength: state.word.length, missesAllowed: 7, terminal,
      ...(terminal ? { word: state.word, result: this.result(state) } : {}),
      lanes: Object.fromEntries(roles.map((role) => {
        const lane = state.lanes[role];
        return [role, { ...structuredClone(lane), pattern: lane.status === "solved" ? (terminal ? [...state.word].join(" ") : null) : this.pattern(state, role), sealed: lane.status === "solved" && !terminal, missesRemaining: Math.max(0, 7 - lane.misses), correctLetters: lane.guessedLetters.filter((letter) => state.word.includes(letter)).length }];
      })),
    };
  }
  validateRecord(record: MatchRecord, state: HangmanState): string | undefined {
    let index = 0;
    for (const turn of record.history) {
      const entry = state.entries[index];
      if (!turn.valid && entry?.action.type !== "lane_forfeit") continue;
      if (!entry || entry.playerId !== turn.playerId || turn.matchId !== record.id) return "Hangman telemetry differs from action history";
      if (turn.valid) {
        if (!isDeepStrictEqual(turn.action, entry.action) || !turn.attempts.some((attempt) => attempt.status === "valid" && isDeepStrictEqual(attempt.action, entry.action))) return "Accepted Hangman action lacks matching evidence";
      } else if (turn.attempts.filter((attempt) => attempt.status === "invalid" || attempt.status === "timeout").length < record.settings.maxRetries + 1 || turn.attempts.some((attempt) => attempt.status === "valid")) return "Lane forfeit lacks exhausted correction evidence";
      index++;
    }
    if (index !== state.entries.length) return "Hangman action history lacks telemetry";
    return undefined;
  }
  publicReplay(state: HangmanState): unknown[] {
    const replay = this.createState(state.provenance.seed);
    const frames = [this.publicState(replay)];
    for (const entry of state.entries) {
      if (entry.action.type === "lane_forfeit") this.forfeit(replay, entry.playerId);
      else this.applyAction(replay, entry.playerId, entry.action);
      frames.push(this.publicState(replay));
    }
    return frames;
  }
  publicAction(action: GameAction): GameAction {
    if (action.type === "guess_letter" && typeof action.payload.letter === "string" && /^[a-z]$/.test(action.payload.letter)) return { type: "guess_letter", payload: { letter: action.payload.letter } };
    return { type: action.type === "solve" ? "solve" : "redacted", payload: {} };
  }
  actionLabel(action: GameAction): string { return action.type === "guess_letter" ? `Guess ${this.publicAction(action).payload.letter ?? "letter"}` : "Solution submitted"; }
  eventProjection(state: HangmanState): Record<string, unknown> { return { publicState: this.publicState(state) }; }
}
