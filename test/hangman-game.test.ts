import test from "node:test";
import assert from "node:assert/strict";
import { HangmanGame } from "../src/games/hangman/HangmanGame.js";
import { CORPUS, CORPUS_HASH, selectWord } from "../src/games/hangman/corpus.js";
const game = new HangmanGame();
const fresh = () => game.createState("00".repeat(32));
const guess = (letter: string) => ({ type: "guess_letter", payload: { letter } });
const solve = (word: string) => ({ type: "solve", payload: { word } });
const act = (s: ReturnType<typeof fresh>, action: unknown) => game.applyAction(s, game.currentPlayer(s)!, action);

test("corpus and seeded selection are stable", () => {
  assert.equal(CORPUS.length, 2068);
  assert.equal(CORPUS_HASH, "6d2c031c2f117996772990f9a5655c5e10c9cc93b8a3b82982d89e3fafb702b3");
  assert.deepEqual(selectWord("00".repeat(32)), selectWord("00".repeat(32)));
  assert.throws(() => selectWord("invalid"));
});
test("lanes reveal all occurrences independently and observations contain only own history", () => {
  const s = fresh(); const letter = s.word[0];
  act(s, guess(letter));
  const observation = game.observe(s, { matchId: "m", turnId: "t", player: { id: "player2", label: "Player 2", agent: { provider: "codex", model: "test", name: "test" } }, ply: 2, turnIndex: 2, turnTimeoutMs: 1000 });
  assert.equal(observation.ply, 1); assert.equal(observation.turnIndex, 1);
  assert.deepEqual(observation.history, []); assert.deepEqual(observation.state.guessedLetters, []);
  assert.equal(JSON.stringify(observation).includes(s.word), false);
  assert.equal(JSON.stringify(observation).includes("player1"), false);
  assert.equal(s.lanes.player1.misses, 0);
  assert.equal(game.validateAction(s, "player1", guess("a")).valid, false);
});
test("strict actions and repeated letters are rejected without mutation", () => {
  const s = fresh(); act(s, guess("a")); act(s, guess("b"));
  for (const action of [guess("a"), guess("A"), guess("ab"), { ...guess("z"), extra: true }, { type: "solve", payload: { word: s.word, extra: true } }, solve("BAD")]) {
    const before = game.serialize(s);
    assert.equal(game.validateAction(s, "player1", action).valid, false);
    assert.deepEqual(s, before);
  }
});
test("incorrect solves add two misses and seven or more ends a lane", () => {
  const s = fresh(); const wrong = "z".repeat(s.word.length);
  while (!game.isTerminal(s)) act(s, solve(wrong));
  assert.equal(s.lanes.player1.misses, 8); assert.equal(s.lanes.player2.status, "failed");
  assert.equal(game.result(s)?.kind, "draw");
});
test("early solve is sealed, completed lane skipped, terminal word revealed", () => {
  const s = fresh(); act(s, solve(s.word));
  assert.equal(JSON.stringify(game.publicState(s)).includes(s.word), false);
  act(s, guess("z")); assert.equal(game.currentPlayer(s), "player2");
  act(s, solve(s.word)); assert.equal(game.currentPlayer(s), null);
  assert.equal(game.publicState(s).word, s.word);
  assert.equal(game.result(s)?.winnerId, "player1");
});
test("all correct letters solve and stay sealed before the other lane finishes", () => {
  const s = fresh(); game.forfeit(s, "player1");
  for (const letter of new Set(s.word)) act(s, guess(letter));
  assert.equal(s.lanes.player2.status, "solved"); assert.equal(game.result(s)?.winnerId, "player2");
});
test("lane forfeits preserve the other lane and two forfeits draw", () => {
  const s = fresh(); game.forfeit(s, "player1");
  assert.equal(game.currentPlayer(s), "player2"); assert.equal(game.result(s), undefined);
  game.forfeit(s, "player2"); assert.equal(game.result(s)?.kind, "draw");
});
test("serialization is detached, private state round trips, forged derived state rejected", () => {
  const s = fresh(); act(s, guess("a")); game.forfeit(s, "player2");
  const saved = game.serialize(s); assert.deepEqual(game.deserialize(saved), s);
  saved.lanes.player1.misses++;
  assert.throws(() => game.deserialize(saved)); assert.notDeepEqual(saved, s);
  const forged = game.serialize(s); forged.provenance.index++;
  assert.throws(() => game.deserialize(forged));
});
test("public actions redact full solutions and untrusted fields", () => {
  const s = fresh();
  assert.equal(JSON.stringify(game.publicAction(solve(s.word))).includes(s.word), false);
  assert.equal(JSON.stringify(game.publicAction({ type: s.word, payload: { word: s.word } })).includes(s.word), false);
});

test("comparison policy covers every lexicographic branch", () => {
  const s = fresh();
  const set = (a: Partial<typeof s.lanes.player1>, b: Partial<typeof s.lanes.player2>) => {
    s.lanes.player1 = { guessedLetters: [], misses: 0, actionsTaken: 1, status: "solved", ...a };
    s.lanes.player2 = { guessedLetters: [], misses: 0, actionsTaken: 1, status: "solved", ...b };
    return game.result(s);
  };
  assert.equal(set({ misses: 2, actionsTaken: 1 }, { misses: 1, actionsTaken: 8 })?.winnerId, "player2");
  assert.equal(set({ actionsTaken: 3 }, { actionsTaken: 2 })?.winnerId, "player2");
  assert.equal(set({}, {})?.kind, "draw");
  assert.equal(set({ status: "failed", misses: 7 }, {})?.winnerId, "player2");
  assert.equal(set({ status: "failed", guessedLetters: [s.word[0]], misses: 7 }, { status: "failed", misses: 7 })?.winnerId, "player1");
  assert.equal(set({ status: "failed", misses: 7, actionsTaken: 4 }, { status: "failed", misses: 8, actionsTaken: 9 })?.kind, "draw");
  assert.equal(set({ status: "forfeit" }, { status: "failed", misses: 8 })?.winnerId, "player2");
});

test("replay retains historical masks and seals, revealing only the final frame", () => {
  const s = fresh(); act(s, solve(s.word)); act(s, guess("z")); act(s, solve(s.word));
  const replay = game.publicReplay(s);
  assert.equal(replay.length, 4);
  assert.equal(JSON.stringify(replay.slice(0, -1)).includes(s.word), false);
  assert.equal((replay.at(-1) as { word: string }).word, s.word);
});
