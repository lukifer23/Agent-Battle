import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { makeSeries, makeSeriesV2, publicSeries, seriesExport, SeriesManager } from "../src/server/series.js";
import { validateSeriesRecord } from "../src/server/schema.js";
import { MatchController } from "../src/domain/MatchController.js";
import { AgentRegistry, type AgentReply } from "../src/domain/agent.js";
import { defaultGames } from "../src/domain/defaultGames.js";
import { projectRecord } from "../src/domain/projection.js";
import { MatchStore } from "../src/server/store.js";
import { verifiedDistinctModels, type MatchRecord, type SeriesPlan, type SeriesRecord } from "../src/shared.js";

const agents = [{ provider: "codex" as const, model: "fixture-a", name: "A" }, { provider: "codex" as const, model: "fixture-b", name: "B" }] as const;
const budgets = { maxPlies: 150, maxRequests: 100, maxWallMinutes: 30, maxReportedCostUsd: null };
const plan: SeriesPlan = { mode: "exploratory", games: [
  { gameId: "chess", gameVersion: "standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" },
  { gameId: "hangman", gameVersion: "independent-lanes-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "seeded" },
  { gameId: "battleship", gameVersion: "battleship-standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" },
] };
const ships = [
  { ship: "carrier", start: "a1", orientation: "horizontal" }, { ship: "battleship", start: "a2", orientation: "horizontal" },
  { ship: "cruiser", start: "a3", orientation: "horizontal" }, { ship: "submarine", start: "a4", orientation: "horizontal" },
  { ship: "destroyer", start: "a5", orientation: "horizontal" },
];
const targets = ships.flatMap((ship) => Array.from({ length: ({ carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 } as Record<string, number>)[ship.ship] }, (_, index) => `${String.fromCharCode(ship.start.charCodeAt(0) + index)}${ship.start.slice(1)}`));

test("v2 accepts arbitrary registered game plans, records seat imbalance, and reruns exact challenges", () => {
  assert.equal(verifiedDistinctModels({ ...agents[0], resolvedModel: "fixture-a" }, { ...agents[1], resolvedModel: "fixture-b" }), true);
  assert.equal(verifiedDistinctModels({ ...agents[0] }, { ...agents[1], resolvedModel: "fixture-b" }), false);
  const seed = "ab".repeat(32);
  const first = makeSeriesV2([...agents], 120, budgets, plan, seed);
  const again = makeSeriesV2([...agents], 120, budgets, plan, seed);
  assert.deepEqual(first.slots.map((slot) => [slot.gameId, slot.challengeId, slot.roles]), again.slots.map((slot) => [slot.gameId, slot.challengeId, slot.roles]));
  assert.equal(first.slots.length, 3);
  assert.equal(validateSeriesRecord(first).version, "battle-series-2");
  assert.equal(JSON.stringify(publicSeries(first, [])).includes(seed), false);
  assert.equal(JSON.stringify(seriesExport(first, [])).includes(seed), false);
  const altered = structuredClone(first);
  altered.slots[1].challengeId = "forged";
  assert.throws(() => validateSeriesRecord(altered));
  const strict = structuredClone(plan); strict.mode = "strict";
  assert.throws(() => makeSeriesV2([...agents], 120, budgets, strict, seed), /even repetition/);
  first.status = "completed";
  const manifest = seriesExport(first, []).reproducibility!;
  assert.equal(manifest.masterSeed, seed);
  assert.deepEqual(makeSeriesV2(manifest.agents, manifest.settings.turnTimeoutSeconds, manifest.settings.budgets, manifest.plan!, manifest.masterSeed).slots.map((slot) => slot.challengeId), first.slots.map((slot) => slot.challengeId));
});

test("series totals retain requests and failed evidence from earlier tries of a scored slot", () => {
  const oneGame: SeriesPlan = { mode: "exploratory", games: [{ gameId: "chess", gameVersion: "standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" }] };
  const series = makeSeriesV2([...agents], 120, budgets, oneGame, "ac".repeat(32));
  series.slots[0].matchIds = ["failed", "scored"];
  const attempt = (costUsd: number) => ({ attempt: 1, startedAt: "2026-01-01T00:00:00.000Z", status: "valid", latencyMs: 10,
    toolCalls: 0, usage: { inputTokens: 10, outputTokens: 5, costUsd, coverage: "partial" } });
  const failed = { id: "failed", status: "error", history: [{ playerId: "white", attempts: [attempt(0.3)] }] } as unknown as MatchRecord;
  const scored = { id: "scored", status: "finished", result: { kind: "win", winnerId: "white", notation: "1-0", reason: "checkmate" },
    players: [{ id: "white", label: "White", agent: agents[0] }, { id: "black", label: "Black", agent: agents[1] }], environment: { noToolsPlayerIds: ["white", "black"] },
    history: [{ playerId: "white", attempts: [{ ...attempt(0.2), resolvedModel: agents[0].model }] }, { playerId: "black", attempts: [{ ...attempt(0), resolvedModel: agents[1].model }] }] } as unknown as MatchRecord;
  const row = publicSeries(series, [failed, scored]).aggregate["chess:0"];
  assert.equal(row.scored, 1);
  assert.equal(row.unscored, 1);
  assert.equal(row.requests, 2);
  assert.equal(row.latencyMs, 20);
  assert.equal(row.inputTokens, 20);
  assert.equal(row.costUsd, 0.5);
  assert.deepEqual(row.coverage.costUsd, { reported: 2, total: 2 });
  const partial = structuredClone(series);
  partial.slots.push({ ...partial.slots[0], id: "pending", ordinal: 1, matchIds: [] });
  assert.equal(publicSeries(partial, [failed, scored]).aggregate["overall:0"].normalizedPerformance, null);
  const unqualified = structuredClone(scored);
  delete unqualified.history[1].attempts[0].resolvedModel;
  assert.equal(publicSeries(series, [failed, unqualified]).slots[0].status, "unscored");

});

test("failed series checkpoints leave start, pause, stop, retry and skip state unchanged", async () => {
  const oneGame: SeriesPlan = { mode: "exploratory", games: [{ gameId: "chess", gameVersion: "standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" }] };
  const series = makeSeriesV2([...agents], 120, budgets, oneGame, "ad".repeat(32));
  series.slots[0].matchIds = ["failed"];
  const failed = { id: "failed", status: "error", series: { id: series.id, slotId: series.slots[0].id, attempt: 1 } } as unknown as MatchRecord;
  const controller = { list: () => [failed], active: () => undefined } as unknown as MatchController;
  const manager = new SeriesManager([series], controller, () => { throw new Error("disk full"); });
  await assert.rejects(() => manager.start(series.id), /disk full/);
  assert.equal(series.status, "ready");
  series.status = "running";
  await assert.rejects(() => manager.pause(series.id), /disk full/);
  assert.equal(series.status, "running");
  await assert.rejects(() => manager.stop(series.id), /disk full/);
  assert.equal(series.status, "running");
  series.status = "paused";
  assert.throws(() => manager.retry(series.id), /disk full/);
  assert.equal(series.status, "paused");
  assert.throws(() => manager.skip(series.id), /disk full/);
  assert.equal(series.status, "paused");
  assert.equal(series.slots[0].skipped, false);
});

test("store version 5 backs up and loads historical battle-series-1 without rewriting its plan", () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-v1-migration-"));
  try {
    const path = join(folder, "matches.json");
    const original = makeSeries([...agents], 120, budgets, "ef".repeat(32));
    writeFileSync(path, JSON.stringify({ version: 5, matches: [], series: [original] }));
    const loaded = new MatchStore(path).load();
    assert.equal(loaded.migrated, true);
    assert.ok(loaded.backupPath && existsSync(loaded.backupPath));
    assert.deepEqual(loaded.series[0], original);
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as { version: number }).version, 7);
    assert.equal(seriesExport(loaded.series[0], []).schemaVersion, "battle-series-export-1");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("v2 fixture series completes Chess, Hangman and Battleship with private fleet replay and durable scores", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-v2-"));
  const store = new MatchStore(join(folder, "matches.json"));
  const matches: MatchRecord[] = [];
  const records: SeriesRecord[] = [];
  const registry = new AgentRegistry().register("codex", (config) => ({ id: config.model, config, isolationQualified: true, initialize: async () => undefined, shutdown: async () => undefined,
    act: async (observation): Promise<AgentReply> => {
      let action;
      if (observation.gameId === "chess") action = observation.playerId === "white" ? { type: "move", payload: { move: "e2e4" } } : { type: "resign", payload: {} };
      else if (observation.gameId === "hangman") action = observation.playerId === "player1" ? { type: "guess_letter", payload: { letter: "e" } } : { type: "solve", payload: { word: (matches.find((item) => item.id === observation.matchId)!.gameState as { word: string }).word } };
      else {
        const state = observation.state as { phase: string; ownShots: Array<{ coordinate: string }> };
        action = state.phase === "placement" ? { type: "place_fleet", payload: { ships } } : { type: "fire", payload: { coordinate: targets.find((target) => !state.ownShots.some((shot) => shot.coordinate === target)) } };
      }
      return { action, latencyMs: 1, responseExcerpt: "fixture only", stderrExcerpt: "", toolCalls: 0, resolvedModel: config.model, usage: { inputTokens: 3, outputTokens: 2, costUsd: null, coverage: "partial" } };
    } }));
  const controller = new MatchController(defaultGames, registry, matches, async () => [{ provider: "codex", installed: true, defaultModel: "fixture" }],
    (match, event) => { if (!event) store.save(matches, records); else manager.onMatchChange(match); });
  const manager = new SeriesManager(records, controller, () => store.save(matches, records));
  try {
    const series = manager.create([...agents], 120, budgets, plan, "cd".repeat(32));
    await manager.start(series.id);
    const deadline = Date.now() + 15_000;
    while (series.status !== "completed") {
      if (Date.now() > deadline) throw new Error(`Series stalled: ${series.status} ${series.error ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(matches.map((match) => match.gameId).sort(), ["battleship", "chess", "hangman"]);
    assert.ok(matches.every((match) => match.status === "finished" && defaultGames.validateRecord(match) === undefined));
    const battle = matches.find((match) => match.gameId === "battleship")!;
    const olderProjection = structuredClone(battle);
    for (const event of olderProjection.events) if (event.payload?.publicState && typeof event.payload.publicState === "object") delete (event.payload.publicState as Record<string, unknown>).metrics;
    assert.equal(defaultGames.validateRecord(olderProjection), undefined);
    const detail = projectRecord(battle);
    const preterminal = detail.replay!.slice(0, -1);
    for (const frame of preterminal) assert.equal(JSON.stringify(frame).includes("placements"), false);
    assert.equal(JSON.stringify(detail.replay!.at(-1)).includes("placements"), true);
    assert.equal(JSON.stringify(detail.history).includes('"ship":"carrier"'), false);
    assert.equal(JSON.stringify(detail.events.filter((event) => !(event.payload?.publicState as { terminal?: boolean })?.terminal)).includes("placements"), false);
    const reloaded = store.load();
    assert.equal(reloaded.series[0].version, "battle-series-2");
    assert.ok(reloaded.matches.every((match) => projectRecord(match).comparison?.eligible));
    assert.equal(projectRecord(reloaded.matches[0]).environment?.adapterVersion, "agent-battle/adapter-v6");
    const summary = publicSeries(series, matches);
    assert.ok(summary.aggregate["battleship:0"].scored === 1);
    assert.ok(summary.aggregate["overall:0"].normalizedPerformance !== null);
    const exported = seriesExport(series, matches);
    assert.equal(exported.reproducibility?.masterSeed, series.masterSeed);
  } finally { await controller.shutdown(); rmSync(folder, { recursive: true, force: true }); }
});


test("a terminal unqualified game pauses its series and remains skippable", async () => {
  const series = makeSeriesV2([...agents], 120, budgets, { mode: "exploratory", games: [plan.games[0]] }, "fa".repeat(32));
  const match = { id: "unqualified-forfeit", status: "forfeit", result: { kind: "win", winnerId: "black" }, players: [], history: [], series: { id: series.id, slotId: series.slots[0].id, attempt: 1 } } as unknown as MatchRecord;
  // An actual record always has two players; use them but no response evidence.
  match.players = [{ id: "white", label: "White", agent: agents[0] }, { id: "black", label: "Black", agent: agents[1] }];
  const controller = { list: () => [match], active: () => undefined } as unknown as MatchController;
  const manager = new SeriesManager([series], controller, () => undefined);
  await manager.start(series.id);
  assert.equal(series.status, "paused");
  assert.equal(publicSeries(series, [match]).slots[0].status, "unscored");
  manager.skip(series.id);
  assert.equal(series.slots[0].skipped, true);
  assert.equal(series.status, "completed");
  assert.equal(match.status, "forfeit", "raw result is retained without scoring it");
});
