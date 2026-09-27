import test from "node:test";
import assert from "node:assert/strict";
import { beginMatchTime, elapsedMatchMs, endMatchTime, remainingMatchMs } from "../src/domain/matchTime.js";
import type { MatchRecord } from "../src/shared.js";

function timedMatch(): MatchRecord {
  return {
    createdAt: "2020-01-01T00:00:00.000Z",
    settings: { budgets: { maxWallMinutes: 5 } },
    timeAccounting: { mode: "active-runtime-v1", elapsedMs: 30_000 },
  } as MatchRecord;
}

test("active match time excludes ready and paused periods and survives a resumed segment", () => {
  const match = timedMatch();
  assert.equal(remainingMatchMs(match, 10_000), 270_000);
  beginMatchTime(match, 10_000);
  assert.equal(elapsedMatchMs(match, 25_000), 45_000);
  endMatchTime(match, 25_000);
  assert.equal(elapsedMatchMs(match, 100_000), 45_000);
  beginMatchTime(match, 100_000);
  endMatchTime(match, 105_000);
  assert.equal(match.timeAccounting?.elapsedMs, 50_000);
});

test("legacy records retain creation-age semantics", () => {
  const match = timedMatch();
  match.timeAccounting = undefined;
  assert.equal(elapsedMatchMs(match, Date.parse(match.createdAt) + 12_000), 12_000);
});
