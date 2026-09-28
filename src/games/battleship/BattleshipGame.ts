import { isDeepStrictEqual } from "node:util";
import { isPlainObject, parseActionEnvelope } from "../../domain/actions.js";
import type { ActionValidation, GameDefinition, ObservationContext } from "../../domain/game.js";
import type { GameAction, GameObservation, MatchRecord, MatchResult } from "../../shared.js";

type Role = "player1" | "player2";
type Ship = "carrier" | "battleship" | "cruiser" | "submarine" | "destroyer";
type Orientation = "horizontal" | "vertical";
type Placement = { ship: Ship; start: string; orientation: Orientation };
type Shot = { playerId: Role; coordinate: string; hit: boolean; sunk?: Ship };
type Entry = { playerId: Role; action: GameAction };
export interface BattleshipState {
  ruleset: "battleship-standard-1";
  phase: "placement" | "battle" | "terminal";
  next: Role;
  fleets: Record<Role, Placement[] | null>;
  shots: Shot[];
  entries: Entry[];
  winner?: Role;
}
const roles = ["player1", "player2"] as const;
const fleet: Record<Ship, number> = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 };
const shipNames = Object.keys(fleet) as Ship[];
const coordinates = [..."abcdefgh" + "ij"].flatMap((file) => Array.from({ length: 10 }, (_, rank) => `${file}${rank + 1}`));
const other = (role: Role): Role => role === "player1" ? "player2" : "player1";
const point = (coordinate: string): [number, number] => [coordinate.charCodeAt(0) - 97, Number(coordinate.slice(1)) - 1];
function occupied(placement: Placement): string[] {
  const [x, y] = point(placement.start);
  return Array.from({ length: fleet[placement.ship] }, (_, offset) => `${String.fromCharCode(97 + x + (placement.orientation === "horizontal" ? offset : 0))}${y + 1 + (placement.orientation === "vertical" ? offset : 0)}`);
}
function fleetError(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length !== shipNames.length) return "Place exactly the five standard ships in one action.";
  const seen = new Set<string>();
  const cells = new Set<string>();
  for (const item of raw) {
    if (!isPlainObject(item) || Object.keys(item).sort().join() !== "orientation,ship,start" || !shipNames.includes(item.ship as Ship)
      || !coordinates.includes(item.start as string) || !["horizontal", "vertical"].includes(item.orientation as string)) return "Each ship needs a known name, canonical start coordinate, and horizontal or vertical orientation.";
    if (seen.has(item.ship as string)) return "A ship was placed twice.";
    seen.add(item.ship as string);
    for (const cell of occupied(item as Placement)) {
      if (!coordinates.includes(cell)) return "A ship extends beyond the board.";
      if (cells.has(cell)) return "Ships cannot overlap.";
      cells.add(cell);
    }
  }
  return undefined;
}

export class BattleshipGame implements GameDefinition<BattleshipState> {
  readonly id = "battleship";
  readonly version = "battleship-standard-1";
  readonly observationVersion = "battleship-observation-1";
  readonly actionSchemaVersion = "game-action-v1";
  readonly playerIds = roles;
  readonly hiddenInformation = true;
  readonly series = { seatSensitive: true, supportsSeededChallenges: false, recommendedRepetitions: 6, defaultSeriesEnabled: true, challengeId: "battleship-standard-1:10x10:5-4-3-3-2" };
  playerLabel(id: string): string { if (!roles.includes(id as Role)) throw new Error("Unknown Battleship role."); return id === "player1" ? "Player 1" : "Player 2"; }
  createState(): BattleshipState { return { ruleset: this.version, phase: "placement", next: "player1", fleets: { player1: null, player2: null }, shots: [], entries: [] }; }
  cloneState(state: BattleshipState): BattleshipState { return structuredClone(state); }
  currentPlayer(state: BattleshipState): Role | null { return state.phase === "terminal" ? null : state.next; }
  plyCount(state: BattleshipState): number { return state.entries.length; }
  isTerminal(state: BattleshipState): boolean { return state.phase === "terminal"; }
  observe(state: BattleshipState, context: ObservationContext): GameObservation {
    const role = context.player.id as Role;
    if (this.currentPlayer(state) !== role) throw new Error("It is not this player's turn.");
    const ownShots = state.shots.filter((shot) => shot.playerId === role);
    const received = state.shots.filter((shot) => shot.playerId !== role);
    return { schemaVersion: this.observationVersion, gameId: this.id, matchId: context.matchId, turnId: context.turnId,
      playerId: role, playerLabel: this.playerLabel(role), sideToMove: role, ply: context.ply, turnIndex: context.turnIndex,
      state: { phase: state.phase, rules: { version: this.version, board: "10x10", coordinates: "a1 through j10", fleet,
        placement: "Place all five ships at once, horizontal or vertical, without overlap.", turn: "Players alternate one shot; a hit does not grant an extra shot.", victory: "Sink all five opposing ships." },
        ownFleet: state.fleets[role], hitsReceived: received.filter((shot) => shot.hit).map((shot) => shot.coordinate), missesReceived: received.filter((shot) => !shot.hit).map((shot) => shot.coordinate),
        ownShots, opponentPlaced: Boolean(state.fleets[other(role)]), availableTargets: coordinates.filter((cell) => !ownShots.some((shot) => shot.coordinate === cell)) },
      legalActions: state.phase === "battle" ? coordinates.filter((cell) => !ownShots.some((shot) => shot.coordinate === cell)).map((coordinate) => ({ type: "fire", payload: { coordinate } })) : [],
      actionSchema: state.phase === "placement" ? { type: "object", required: ["type", "payload"], additionalProperties: false, properties: { type: { const: "place_fleet" }, payload: { type: "object", required: ["ships"], additionalProperties: false, properties: { ships: { type: "array", minItems: 5, maxItems: 5, items: { type: "object", required: ["ship", "start", "orientation"], additionalProperties: false, properties: { ship: { enum: shipNames }, start: { pattern: "^[a-j](?:[1-9]|10)$" }, orientation: { enum: ["horizontal", "vertical"] } } } } } } } }
        : { type: "object", required: ["type", "payload"], additionalProperties: false, properties: { type: { const: "fire" }, payload: { type: "object", required: ["coordinate"], additionalProperties: false, properties: { coordinate: { pattern: "^[a-j](?:[1-9]|10)$" } } } } },
      history: state.entries.filter((entry) => entry.playerId === role).map((entry) => entry.action), clock: { turnTimeoutMs: context.turnTimeoutMs }, status: "active", ...(context.feedback ? { feedback: context.feedback } : {}) };
  }
  validateAction(state: BattleshipState, id: string, raw: unknown): ActionValidation {
    if (this.currentPlayer(state) !== id) return { valid: false, reason: "It is not this player's turn." };
    const action = parseActionEnvelope(raw);
    if (!action) return { valid: false, reason: "Use exactly type and payload." };
    if (state.phase === "placement") {
      if (action.type !== "place_fleet" || Object.keys(action.payload).join() !== "ships") return { valid: false, reason: "Submit one place_fleet action with ships." };
      const error = fleetError(action.payload.ships);
      return error ? { valid: false, reason: error } : { valid: true };
    }
    if (action.type !== "fire" || Object.keys(action.payload).join() !== "coordinate" || !coordinates.includes(action.payload.coordinate as string)) return { valid: false, reason: "Fire at one canonical coordinate from a1 through j10." };
    if (state.shots.some((shot) => shot.playerId === id && shot.coordinate === action.payload.coordinate)) return { valid: false, reason: "That coordinate was already targeted." };
    return { valid: true };
  }
  applyAction(state: BattleshipState, id: string, raw: unknown): BattleshipState {
    const check = this.validateAction(state, id, raw);
    if (!check.valid) throw new Error(check.reason);
    const action = structuredClone(parseActionEnvelope(raw)!);
    const role = id as Role;
    if (state.phase === "placement") {
      state.fleets[role] = action.payload.ships as Placement[];
      state.next = other(role);
      if (state.fleets.player1 && state.fleets.player2) state.phase = "battle";
    } else {
      const coordinate = action.payload.coordinate as string;
      const targetFleet = state.fleets[other(role)]!;
      const struck = targetFleet.find((placement) => occupied(placement).includes(coordinate));
      const shot: Shot = { playerId: role, coordinate, hit: Boolean(struck) };
      if (struck && occupied(struck).every((cell) => cell === coordinate || state.shots.some((prior) => prior.playerId === role && prior.coordinate === cell))) shot.sunk = struck.ship;
      state.shots.push(shot);
      if (targetFleet.every((placement) => occupied(placement).every((cell) => state.shots.some((prior) => prior.playerId === role && prior.coordinate === cell)))) {
        state.phase = "terminal"; state.winner = role;
      } else state.next = other(role);
    }
    state.entries.push({ playerId: role, action });
    return state;
  }
  result(state: BattleshipState): MatchResult | undefined { return state.winner ? this.winResult(state.winner, "All opposing ships sunk") : undefined; }
  winResult(id: string, reason: string): MatchResult { this.playerLabel(id); return { kind: "win", winnerId: id, notation: id === "player1" ? "1-0" : "0-1", reason }; }
  serialize(state: BattleshipState): BattleshipState { return structuredClone(state); }
  deserialize(saved: unknown): BattleshipState {
    if (!isPlainObject(saved) || saved.ruleset !== this.version || !Array.isArray(saved.entries)) throw new Error("Invalid saved Battleship state.");
    const replay = this.createState();
    for (const entry of saved.entries) {
      if (!isPlainObject(entry) || typeof entry.playerId !== "string") throw new Error("Invalid Battleship history.");
      this.applyAction(replay, entry.playerId, entry.action);
    }
    if (!isDeepStrictEqual(replay, saved)) throw new Error("Battleship state differs from replay.");
    return replay;
  }
  publicState(state: BattleshipState): Record<string, unknown> {
    const terminal = this.isTerminal(state);
    return { ruleset: this.version, phase: state.phase, next: terminal ? null : state.next, terminal, shots: structuredClone(state.shots),
      fleets: Object.fromEntries(roles.map((role) => [role, { placed: Boolean(state.fleets[role]), sunk: state.shots.filter((shot) => shot.playerId !== role && shot.sunk).map((shot) => shot.sunk),
        ...(terminal ? { placements: state.fleets[role] } : {}) }])), ...(terminal ? { result: this.result(state) } : {}) };
  }
  publicReplay(state: BattleshipState): unknown[] { const replay = this.createState(); const frames = [this.publicState(replay)]; for (const entry of state.entries) { this.applyAction(replay, entry.playerId, entry.action); frames.push(this.publicState(replay)); } return frames; }
  validateRecord(record: MatchRecord, state: BattleshipState): string | undefined {
    const accepted = record.history.filter((turn) => turn.valid);
    if (accepted.length !== state.entries.length) return "Battleship accepted action count differs from replay.";
    for (const [index, entry] of state.entries.entries()) if (accepted[index].playerId !== entry.playerId || !isDeepStrictEqual(accepted[index].action, entry.action)
      || !accepted[index].attempts.some((attempt) => attempt.status === "valid" && isDeepStrictEqual(attempt.action, entry.action))) return "Battleship action lacks matching evidence.";
    const frames = this.publicReplay(state);
    let last = -1;
    for (const event of record.events) if (event.payload?.publicState) {
      const found = frames.findIndex((frame, index) => index > last && isDeepStrictEqual(frame, event.payload!.publicState));
      if (found < 0 || last >= 0 && found !== last + 1) return "Battleship event-time state differs from replay.";
      last = found;
    }
    return undefined;
  }
  publicAction(action: GameAction): GameAction { return action.type === "fire" && coordinates.includes(action.payload.coordinate as string) ? { type: "fire", payload: { coordinate: action.payload.coordinate } } : { type: "place_fleet", payload: {} }; }
  actionLabel(action: GameAction): string { return action.type === "fire" ? `Fire ${this.publicAction(action).payload.coordinate ?? "target"}` : "Fleet placed"; }
  eventProjection(state: BattleshipState): Record<string, unknown> { return { publicState: this.publicState(state) }; }
}
