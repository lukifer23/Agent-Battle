import test from "node:test";
import assert from "node:assert/strict";
import { highlightSquares, isInCheck, kingSquare, materialSummary, positionSummary, squaresOfUci } from "../src/client/chessView.js";

const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const checkFen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
const mateFen = checkFen;

test("last-move squares are extracted from a UCI move", () => {
  assert.deepEqual(squaresOfUci("e2e4"), { from: "e2", to: "e4" });
  assert.deepEqual(squaresOfUci(undefined), {});
});

test("check detection highlights the checked king", () => {
  assert.equal(isInCheck(checkFen), true);
  assert.equal(isInCheck(startFen), false);
  assert.equal(kingSquare(checkFen, "w"), "e1");
  const styles = highlightSquares(checkFen, "d8h4");
  assert.ok(styles.e1);
  assert.deepEqual(squaresOfUci("d8h4"), { from: "d8", to: "h4" });
  assert.ok(styles.d8);
  assert.ok(styles.h4);
});

test("material summary counts pieces by value", () => {
  assert.deepEqual(materialSummary(startFen), { white: 39, black: 39 });
  const down = materialSummary("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 1");
  assert.deepEqual(down, { white: 36, black: 39 });
});

test("position summary describes side, check, material and last move", () => {
  const summary = positionSummary(checkFen, "Qh4+");
  assert.match(summary, /white to move/);
  assert.match(summary, /in check/);
  assert.match(summary, /last move Qh4\+/);
  assert.match(positionSummary(mateFen), /in check/);
});
