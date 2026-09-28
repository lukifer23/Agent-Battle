import test from "node:test";
import assert from "node:assert/strict";
import { BattleshipGame } from "../src/games/battleship/BattleshipGame.js";

const game = new BattleshipGame();
const ships = [
  { ship: "carrier", start: "a1", orientation: "horizontal" },
  { ship: "battleship", start: "a2", orientation: "horizontal" },
  { ship: "cruiser", start: "a3", orientation: "horizontal" },
  { ship: "submarine", start: "a4", orientation: "horizontal" },
  { ship: "destroyer", start: "a5", orientation: "horizontal" },
];
const place = (value: unknown = ships) => ({ type: "place_fleet", payload: { ships: value } });
const fire = (coordinate: string) => ({ type: "fire", payload: { coordinate } });

test("fleet placement enforces complete nonoverlapping canonical layout", () => {
  const state = game.createState();
  assert.equal(game.validateAction(state, "player1", place()).valid, true);
  assert.equal(game.validateAction(state, "player2", place()).valid, false);
  assert.equal(game.validateAction(state, "player1", place(ships.slice(1))).valid, false);
  assert.equal(game.validateAction(state, "player1", place([...ships.slice(0, 4), ships[0]])).valid, false);
  assert.equal(game.validateAction(state, "player1", place([{ ...ships[0], start: "i1" }, ...ships.slice(1)])).valid, false);
  assert.equal(game.validateAction(state, "player1", place([{ ...ships[0], start: "a2" }, ...ships.slice(1)])).valid, false);
  assert.equal(game.validateAction(state, "player1", place([{ ...ships[0], orientation: "diagonal" }, ...ships.slice(1)])).valid, false);
  assert.equal(game.validateAction(state, "player1", { ...place(), extra: true }).valid, false);
});

test("shots alternate; hit, miss, sunk and terminal result derive from placements", () => {
  const state = game.createState();
  game.applyAction(state, "player1", place());
  assert.equal(game.publicState(state).fleets instanceof Object, true);
  assert.equal(JSON.stringify(game.publicState(state)).includes("a1"), false);
  game.applyAction(state, "player2", place());
  assert.equal(state.phase, "battle");
  game.applyAction(state, "player1", fire("j10"));
  assert.equal(state.shots[0].hit, false);
  assert.equal(game.validateAction(state, "player1", fire("a1")).valid, false);
  game.applyAction(state, "player2", fire("j10"));
  assert.equal(game.validateAction(state, "player1", fire("j10")).valid, false);
  const targets = ships.flatMap((ship) => Array.from({ length: ({ carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 } as Record<string, number>)[ship.ship] }, (_, index) => `${String.fromCharCode(ship.start.charCodeAt(0) + index)}${ship.start.slice(1)}`));
  for (const [index, target] of targets.entries()) {
    game.applyAction(state, "player1", fire(target));
    assert.equal(state.shots.at(-1)?.hit, true);
    if (index < targets.length - 1) game.applyAction(state, "player2", fire(index < 9 ? `j${index + 1}` : `i${index - 8}`));
  }
  assert.equal(state.phase, "terminal");
  assert.equal(game.result(state)?.winnerId, "player1");
  const metrics = (game.publicState(state).metrics as Record<string, { shotsFired: number; hits: number; shipsSunk: number; shotsToFirstHit: number; shotsToSink: Record<string, number> }>).player1;
  assert.equal(metrics.shotsFired, 18);
  assert.equal(metrics.hits, 17);
  assert.equal(metrics.shipsSunk, 5);
  assert.equal(metrics.shotsToFirstHit, 2);
  assert.equal(metrics.shotsToSink.carrier, 6);
  const frames = game.publicReplay(state);
  assert.equal(JSON.stringify(frames[0]).includes("a1"), false);
  assert.equal(JSON.stringify(frames[2]).includes("a1"), false);
  assert.equal(JSON.stringify(frames.at(-1)).includes("a1"), true);
  assert.deepEqual(game.deserialize(game.serialize(state)), state);
  const forged = game.serialize(state);
  forged.shots[0].hit = true;
  assert.throws(() => game.deserialize(forged));
});

test("a legal Battleship contest can take 201 accepted actions", () => {
  const state = game.createState();
  game.applyAction(state, "player1", place());
  game.applyAction(state, "player2", place());
  const occupied = new Set(ships.flatMap((ship) => Array.from({ length: ({ carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 } as Record<string, number>)[ship.ship] },
    (_, index) => `${String.fromCharCode(ship.start.charCodeAt(0) + index)}${ship.start.slice(1)}`)));
  const shots = [..."abcdefghij"].flatMap((file) => Array.from({ length: 10 }, (_, rank) => `${file}${rank + 1}`));
  shots.sort((a, b) => Number(occupied.has(a)) - Number(occupied.has(b)));
  for (const [index, coordinate] of shots.entries()) {
    game.applyAction(state, "player1", fire(coordinate));
    if (index < shots.length - 1) game.applyAction(state, "player2", fire(coordinate));
  }
  assert.equal(state.phase, "terminal");
  assert.equal(state.entries.length, 201);
});

test("each observation contains own fleet but no untouched opponent placement", () => {
  const state = game.createState();
  game.applyAction(state, "player1", place());
  const opposing = ships.map((ship, index) => ({ ...ship, start: `f${index + 6}` }));
  game.applyAction(state, "player2", place(opposing));
  const context = (id: "player1" | "player2") => ({ matchId: "match", turnId: "turn", player: { id, label: game.playerLabel(id), agent: { provider: "codex" as const, model: "fixture", name: "fixture" } }, ply: 3, turnIndex: 3, turnTimeoutMs: 30000 });
  const first = game.observe(state, context("player1"));
  assert.equal(JSON.stringify(first).includes('"start":"a1"'), true);
  assert.equal(JSON.stringify(first).includes('"start":"f6"'), false);
  game.applyAction(state, "player1", fire("a1"));
  const second = game.observe(state, context("player2"));
  assert.equal(JSON.stringify(second).includes('"start":"f6"'), true);
  assert.equal(JSON.stringify(second).includes('"start":"a2"'), false);
  assert.equal(JSON.stringify(second).includes("provenance"), false);
});

test("Battleship output schemas declare types for strict provider validators in both phases", () => {
  const state = game.createState();
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if ("pattern" in node) assert.equal(node.type, "string", "pattern requires an explicit string type in Claude's strict validator");
    for (const child of Object.values(node)) inspect(child);
  };
  const observe = () => game.observe(state, { matchId: "schema", turnId: "t", player: { id: "player1", label: "Player 1", agent: { provider: "claude", model: "schema-test", name: "schema-test" } }, ply: 1, turnIndex: 1, turnTimeoutMs: 1000 });
  inspect(observe().actionSchema);
  game.applyAction(state, "player1", place());
  game.applyAction(state, "player2", place());
  inspect(observe().actionSchema);
  assert.equal(game.validateAction(state, "player1", fire("j10")).valid, true);
  assert.equal(game.validateAction(state, "player1", fire(10 as unknown as string)).valid, false);
});
