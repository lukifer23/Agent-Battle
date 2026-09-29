import { makeResearchSeries, researchMatchBudgets } from "./researchPlan.js";
import { analyzeResearchSeries } from "./researchAnalysis.js";
import { comparisonEligibility } from "../domain/comparison.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { MatchController } from "../domain/MatchController.js";
import { aggregateUsage } from "../domain/usage.js";
import { defaultGames } from "../domain/defaultGames.js";
import { projectRecord } from "../domain/projection.js";
import { buildScorecard } from "../domain/scorecard.js";
import { distinctExplicitModels, type FrozenExecutionProfile, type MatchBudgets, type MatchRecord, type PlayerConfig, type PublicSeries, type PublicSeriesSlot, type SeriesPlan, type SeriesRecord, type SeriesSlot } from "../shared.js";

const hexSeed = /^[0-9a-f]{64}$/;
const terminal = new Set(["finished", "forfeit", "stopped", "error"]);

export interface SeriesSaveSide {
  command?: { kind: string; slotId?: string; payload?: unknown };
  consumeRetry?: { slotId: string; matchId: string };
}

export interface SeriesCommandStore {
  acceptedRetry(seriesId: string, slotId: string): boolean;
}

export interface ExecutionProfileStore {
  load(seriesId: string): FrozenExecutionProfile[];
  save(seriesId: string, profiles: FrozenExecutionProfile[]): void;
  capture(agent: PlayerConfig): Promise<FrozenExecutionProfile>;
}

export function makeSeries(agents: [PlayerConfig, PlayerConfig], turnTimeoutSeconds: number, budgets: MatchBudgets, seed = randomBytes(32).toString("hex")): SeriesRecord {
  if (!hexSeed.test(seed) || agents.some((agent) => !agent.model.trim()) || !Number.isInteger(turnTimeoutSeconds) || turnTimeoutSeconds < 30 || turnTimeoutSeconds > 600) throw new Error("Series requires a valid seed, explicit models, and a 30–600 second turn timeout.");
  if (!distinctExplicitModels(agents[0], agents[1])) throw new Error("Series comparison requires two different explicit model IDs.");
  if (![budgets.maxPlies, budgets.maxRequests, budgets.maxWallMinutes].every((value) => Number.isSafeInteger(value) && value > 0)
    || budgets.maxReportedCostUsd !== null && (!Number.isFinite(budgets.maxReportedCostUsd) || budgets.maxReportedCostUsd < 0)) throw new Error("Series budgets are invalid.");
  const now = new Date().toISOString();
  const slots: SeriesSlot[] = Array.from({ length: 10 }, (_value, ordinal) => {
    const gameId = ordinal < 5 ? "chess" : "hangman";
    const ids = gameId === "chess" ? ["white", "black"] : ["player1", "player2"];
    const first = ordinal % 5 % 2 === 0 ? 0 : 1;
    const challengeSeed = gameId === "hangman" ? createHmac("sha256", Buffer.from(seed, "hex")).update(`battle-series-1:hangman:${ordinal - 5}`).digest("hex") : undefined;
    return { id: randomUUID(), ordinal, gameId, challengeId: gameId === "chess" ? "standard-start-v1" : createHash("sha256").update(`hangman:${challengeSeed}`).digest("hex"),
      ...(challengeSeed ? { challengeSeed } : {}), roles: { [ids[0]]: first, [ids[1]]: (1 - first) as 0 | 1 }, matchIds: [], skipped: false };
  });
  return { id: randomUUID(), version: "battle-series-1", createdAt: now, updatedAt: now, status: "ready", agents, settings: { turnTimeoutSeconds, budgets }, masterSeed: seed, slots };
}

export const standardSeriesPlan: SeriesPlan = { mode: "strict", games: [
  { gameId: "chess", gameVersion: "standard-1", repetitions: 6, rolePolicy: "alternating", challengePolicy: "fixed" },
  { gameId: "hangman", gameVersion: "shared-board-2", repetitions: 6, rolePolicy: "alternating", challengePolicy: "seeded" },
  { gameId: "battleship", gameVersion: "battleship-standard-1", repetitions: 6, rolePolicy: "alternating", challengePolicy: "fixed" },
] };

export function makeSeriesV2(agents: [PlayerConfig, PlayerConfig], turnTimeoutSeconds: number, budgets: MatchBudgets, plan: SeriesPlan = standardSeriesPlan, seed = randomBytes(32).toString("hex")): SeriesRecord {
  if (!hexSeed.test(seed) || !distinctExplicitModels(agents[0], agents[1]) || !Number.isSafeInteger(turnTimeoutSeconds) || turnTimeoutSeconds < 30 || turnTimeoutSeconds > 600) throw new Error("Series requires a valid seed, distinct explicit models, and a 30–600 second turn timeout.");
  if (![budgets.maxPlies, budgets.maxRequests, budgets.maxWallMinutes].every((value) => Number.isSafeInteger(value) && value > 0)
    || budgets.maxReportedCostUsd !== null && (!Number.isFinite(budgets.maxReportedCostUsd) || budgets.maxReportedCostUsd < 0)) throw new Error("Series budgets are invalid.");
  if (Object.keys(plan).sort().join() !== "games,mode" || !["strict", "exploratory"].includes(plan.mode) || !Array.isArray(plan.games) || plan.games.length < 1 || plan.games.length > 10
    || new Set(plan.games.map((entry) => entry.gameId)).size !== plan.games.length) throw new Error("Series plan needs one to ten distinct registered games.");
  const slots: SeriesSlot[] = [];
  for (const entry of plan.games) {
    const game = defaultGames.get(entry.gameId, entry.gameVersion);
    if (!(["challengePolicy,gameId,gameVersion,repetitions,rolePolicy", "challengePolicy,gameId,gameVersion,repetitions,rolePolicy,weight"].includes(Object.keys(entry).sort().join()))
      || game.playerIds.length !== 2 || !game.series?.defaultSeriesEnabled || entry.gameVersion !== game.version || entry.rolePolicy !== "alternating"
      || entry.challengePolicy !== (game.series.supportsSeededChallenges ? "seeded" : "fixed") || !Number.isSafeInteger(entry.repetitions) || entry.repetitions < 1 || entry.repetitions > 100
      || entry.weight !== undefined && (!Number.isFinite(entry.weight) || entry.weight <= 0)) throw new Error(`Invalid series plan entry for ${entry.gameId}.`);
    if (plan.mode === "strict" && game.series.seatSensitive && entry.repetitions % 2 !== 0) throw new Error(`${entry.gameId} needs an even repetition count in strict mode.`);
    for (let index = 0; index < entry.repetitions; index++) {
      const first = index % 2 as 0 | 1;
      const challengeSeed = game.series.supportsSeededChallenges ? createHmac("sha256", Buffer.from(seed, "hex")).update(`battle-series-2:${entry.gameId}:${game.series.seatSensitive ? Math.floor(index / 2) : index}`).digest("hex") : undefined;
      const challengeId = challengeSeed ? createHash("sha256").update(`${game.id}:${game.version}:${challengeSeed}`).digest("hex") : game.series.challengeId;
      slots.push({ id: randomUUID(), ordinal: slots.length, gameId: game.id, challengeId, ...(challengeSeed ? { challengeSeed } : {}),
        roles: { [game.playerIds[0]]: first, [game.playerIds[1]]: (1 - first) as 0 | 1 }, matchIds: [], skipped: false });
    }
  }
  const now = new Date().toISOString();
  return { id: randomUUID(), version: "battle-series-2", plan: structuredClone(plan), createdAt: now, updatedAt: now, status: "ready", agents, settings: { turnTimeoutSeconds, budgets }, masterSeed: seed, slots };
}

function linkedMatch(slot: SeriesSlot, matches: MatchRecord[]): MatchRecord | undefined {
  return matches.find((match) => match.id === slot.matchIds.at(-1));
}

export function publicSeries(series: SeriesRecord, matches: MatchRecord[], includeProvenance = false): PublicSeries {
  const aggregate: PublicSeries["aggregate"] = {};
  const slots: PublicSeriesSlot[] = series.slots.map((slot) => {
    const linked = slot.matchIds.map((id) => matches.find((candidate) => candidate.id === id)).filter((candidate): candidate is MatchRecord => Boolean(candidate));
    const match = linked.at(-1);
    const status: PublicSeriesSlot["status"] = slot.skipped ? "skipped" : !match ? "pending" : comparisonEligibility(match).eligible ? "scored" : terminal.has(match.status) ? "unscored" : "running";
    if (match) for (const [agentIndex] of series.agents.entries()) {
      const key = `${slot.conditionId ?? slot.gameId}:${agentIndex}`;
      const row = aggregate[key] ?? { wins: 0, draws: 0, losses: 0, unscored: 0, scored: 0, points: 0, possiblePoints: 0, normalizedPerformance: null, roleCounts: {}, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0,
        coverage: { inputTokens: { reported: 0, total: 0 }, outputTokens: { reported: 0, total: 0 }, costUsd: { reported: 0, total: 0 }, latencyMs: { reported: 0, total: 0 } } };
      const role = Object.entries(slot.roles).find(([, index]) => index === agentIndex)?.[0];
      if (role) row.roleCounts[role] = (row.roleCounts[role] ?? 0) + 1;
      // A retry keeps the same slot and challenge, but its earlier provider
      // invocations still consumed resources and remain unscored evidence.
      const attempts = linked.flatMap((trial) => [
        ...trial.history.filter((turn) => turn.playerId === role).flatMap((turn) => turn.attempts),
        ...(trial.pendingTurn && trial.pendingTurn.playerId === role ? trial.pendingTurn.attempts : []),
      ]);
      const usage = aggregateUsage(attempts);
      row.requests += usage.requests; row.inputTokens += usage.inputTokens; row.outputTokens += usage.outputTokens; row.costUsd += usage.costUsd;
      const providerAttempts = attempts.filter((attempt) => attempt.phase !== "initialization");
      row.latencyMs += providerAttempts.reduce((sum, attempt) => sum + (attempt.latencyMs ?? 0), 0);
      for (const metric of ["inputTokens", "outputTokens", "costUsd"] as const) {
        row.coverage[metric].reported += usage.coverageByMetric[metric].reported;
        row.coverage[metric].total += usage.coverageByMetric[metric].total;
      }
      row.coverage.latencyMs.reported += providerAttempts.filter((attempt) => attempt.latencyMs !== undefined).length;
      row.coverage.latencyMs.total += providerAttempts.length;
      if (status === "scored") {
        row.scored++; row.possiblePoints++;
        if (match.result?.kind === "draw") row.draws++;
        else if (match.result?.winnerId === role) row.wins++;
        else row.losses++;
        row.points = row.wins + row.draws * 0.5;
        row.normalizedPerformance = row.points / row.possiblePoints;
      }
      row.unscored += linked.filter((trial) => terminal.has(trial.status) && !comparisonEligibility(trial).eligible).length;
      aggregate[key] = row;
    }
    return { id: slot.id, ordinal: slot.ordinal, gameId: slot.gameId, ...(slot.gameVersion ? { gameVersion: slot.gameVersion } : {}), ...(slot.conditionId ? { conditionId: slot.conditionId, blockId: slot.blockId, replicate: slot.replicate } : {}), challengeId: slot.challengeId, roles: structuredClone(slot.roles), matchIds: [...slot.matchIds], skipped: slot.skipped,
      ...(includeProvenance && series.status === "completed" && slot.challengeSeed ? { challengeSeed: slot.challengeSeed } : {}), status,
      ...(status === "unscored" && match ? { unscoredReasons: comparisonEligibility(match).reasons } : {}),
      ...(status === "scored" && match?.result ? { result: match.result } : {}),
      ...(match ? { scorecard: buildScorecard(match) } : {}) };
  });
  for (const slot of slots) if (!includeProvenance || series.status !== "completed") delete slot.challengeSeed;
  for (const agentIndex of [0, 1]) {
    const gameRows = Object.entries(aggregate).filter(([key]) => key.endsWith(`:${agentIndex}`) && !key.startsWith("overall:"));
    if (!gameRows.length) continue;
    const rows = gameRows.map(([, row]) => row);
    const scoredRows = gameRows.filter(([, row]) => row.normalizedPerformance !== null);
    const weightOf = (key: string) => series.version === "battle-series-2" ? series.plan?.games.find((entry) => entry.gameId === key.split(":")[0])?.weight ?? 1 : 1;
    aggregate[`overall:${agentIndex}`] = {
      wins: rows.reduce((sum, row) => sum + row.wins, 0), draws: rows.reduce((sum, row) => sum + row.draws, 0),
      losses: rows.reduce((sum, row) => sum + row.losses, 0), unscored: rows.reduce((sum, row) => sum + row.unscored, 0),
      scored: rows.reduce((sum, row) => sum + row.scored, 0), points: rows.reduce((sum, row) => sum + row.points, 0), possiblePoints: rows.reduce((sum, row) => sum + row.possiblePoints, 0),
      normalizedPerformance: series.version !== "battle-series-3" && scoredRows.length && slots.every((slot) => slot.status === "scored") ? scoredRows.reduce((sum, [key, row]) => sum + row.normalizedPerformance! * weightOf(key), 0) / scoredRows.reduce((sum, [key]) => sum + weightOf(key), 0) : null,
      roleCounts: Object.fromEntries([...new Set(rows.flatMap((row) => Object.keys(row.roleCounts)))].map((role) => [role, rows.reduce((sum, row) => sum + (row.roleCounts[role] ?? 0), 0)])),
      requests: rows.reduce((sum, row) => sum + row.requests, 0), inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
      latencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0),
      coverage: Object.fromEntries((["inputTokens", "outputTokens", "costUsd", "latencyMs"] as const).map((metric) => [metric, {
        reported: rows.reduce((sum, row) => sum + row.coverage[metric].reported, 0), total: rows.reduce((sum, row) => sum + row.coverage[metric].total, 0),
      }])) as PublicSeries["aggregate"][string]["coverage"],
    };
  }
  return { id: series.id, version: series.version, ...(series.plan ? { plan: series.plan } : {}), ...(series.researchPlan ? { researchPlan: structuredClone(series.researchPlan), planHash: series.planHash, seedCommitment: series.seedCommitment } : {}), createdAt: series.createdAt, updatedAt: series.updatedAt, status: series.status, agents: series.agents, settings: series.settings, slots, aggregate,
    ...(series.error ? { error: series.error } : {}) };
}

export function seriesExport(series: SeriesRecord, matches: MatchRecord[]) {
  const includeProvenance = series.status === "completed";
  return { schemaVersion: series.version === "battle-series-3" ? "battle-series-export-3" : series.version === "battle-series-2" ? "battle-series-export-2" : "battle-series-export-1", series: publicSeries(series, matches, includeProvenance),
    ...(series.researchPlan ? { analysis: analyzeResearchSeries(series, matches) } : {}),
    ...(includeProvenance && series.version !== "battle-series-1" ? { reproducibility: { version: series.version, masterSeed: series.masterSeed, ...(series.plan ? { plan: series.plan } : {}), ...(series.researchPlan ? { researchPlan: series.researchPlan, planHash: series.planHash, seedCommitment: series.seedCommitment } : {}), agents: series.agents, settings: series.settings } } : {}),
    matches: series.slots.flatMap((slot) => slot.matchIds.map((id) => matches.find((match) => match.id === id)).filter((match): match is MatchRecord => Boolean(match)).map((match) => {
      const detail = projectRecord(match, match.events.length);
      const usage = Object.fromEntries(match.players.map((seat) => [seat.id, aggregateUsage([...match.history.filter((turn) => turn.playerId === seat.id).flatMap((turn) => turn.attempts), ...(match.pendingTurn?.playerId === seat.id ? match.pendingTurn.attempts : [])])]));
      return { detail, usage };
    })) };
}

function hasScoredResult(match: MatchRecord | undefined): boolean {
  return Boolean(match && comparisonEligibility(match).eligible);
}

export class SeriesManager {
  private pumping = new Set<string>();
  private retrySlots = new Set<string>();
  constructor(private readonly series: SeriesRecord[], private readonly controller: MatchController, private readonly save: (record?: SeriesRecord, side?: SeriesSaveSide) => void, private readonly commands?: SeriesCommandStore, private readonly profiles?: ExecutionProfileStore) {
    for (const record of series) {
      let relinked = false;
      for (const slot of record.slots) {
        if (slot.matchIds.length > 0) continue;
        const linked = controller.list().filter((match) => match.series?.id === record.id && match.series.slotId === slot.id).sort((a, b) => (a.series?.attempt ?? 0) - (b.series?.attempt ?? 0));
        if (linked.length === 0) continue;
        slot.matchIds = linked.map((match) => match.id);
        relinked = true;
      }
      if (record.status === "running") { record.status = "paused"; record.error = "Server restarted. Resume the saved slot when ready."; this.save(record); }
      else if (relinked) this.save(record);
    }
  }

  list(): SeriesRecord[] { return [...this.series]; }
  get(id: string): SeriesRecord { const found = this.series.find((record) => record.id === id); if (!found) throw new Error("Series not found."); return found; }
  private checkpoint(record: SeriesRecord, update: () => void, side?: SeriesSaveSide): void {
    const previous = structuredClone(record);
    update();
    try { this.save(record, side); } catch (error) { Object.assign(record, previous); throw error; }
  }
  create(agents: [PlayerConfig, PlayerConfig], turnTimeoutSeconds: number, budgets: MatchBudgets, plan?: SeriesPlan, seed?: string, researchPlan?: unknown): SeriesRecord {
    if (plan !== undefined && researchPlan !== undefined) throw new Error("Choose a tournament plan or a research plan, not both.");
    if (this.series.some((record) => ["ready", "running", "paused"].includes(record.status))) throw new Error("Finish or stop the current series first.");
    if (this.controller.active()) throw new Error("Stop or finish the current match before creating a series.");
    const record = researchPlan !== undefined ? makeResearchSeries(agents, turnTimeoutSeconds, budgets, researchPlan, seed) : makeSeriesV2(agents, turnTimeoutSeconds, budgets, plan, seed);
    this.series.unshift(record);
    try { this.save(record); } catch (error) { this.series.shift(); throw error; }
    return record;
  }
  async start(id: string, preflight?: (agent: PlayerConfig) => string | undefined): Promise<void> {
    const record = this.get(id);
    if (!["ready", "paused"].includes(record.status)) throw new Error("Only a ready or paused series can start.");
    if (record.researchPlan && preflight) {
      for (const agent of record.agents) {
        const reason = preflight(agent);
        if (reason) throw new Error(reason);
      }
    }
    const alreadyPlayed = record.slots.some((slot) => slot.matchIds.length > 0);
    if (this.profiles && !alreadyPlayed && this.profiles.load(record.id).length === 0) {
      const frozen: FrozenExecutionProfile[] = [];
      for (const agent of record.agents) frozen.push(await this.profiles.capture(agent));
      this.profiles.save(record.id, frozen);
    }
    this.checkpoint(record, () => { record.status = "running"; record.error = undefined; record.updatedAt = new Date().toISOString(); });
    void this.pump(record);
  }
  async pause(id: string): Promise<void> {
    const record = this.get(id);
    if (record.status !== "running") throw new Error("Series is not running.");
    this.checkpoint(record, () => { record.status = "paused"; record.updatedAt = new Date().toISOString(); });
    const match = this.controller.active();
    if (match?.series?.id === id && match.status === "running") await this.controller.pause(match.id);
  }
  async stop(id: string): Promise<void> {
    const record = this.get(id);
    if (record.status === "completed") throw new Error("Completed series cannot be stopped.");
    this.checkpoint(record, () => { record.status = "stopped"; record.updatedAt = new Date().toISOString(); });
    const match = this.controller.active();
    if (match?.series?.id === id) await this.controller.stop(match.id);
  }
  retry(id: string): void {
    const record = this.get(id);
    if (record.status !== "paused") throw new Error("Pause the series before retrying.");
    const slot = record.slots.find((candidate) => !candidate.skipped && !hasScoredResult(linkedMatch(candidate, this.controller.list())));
    if (!slot || !linkedMatch(slot, this.controller.list()) || !terminal.has(linkedMatch(slot, this.controller.list())!.status)) throw new Error("Current slot has no failed match to retry.");
    if (record.researchPlan) {
      const failed = linkedMatch(slot, this.controller.list())!;
      const attempts = [...failed.history.flatMap((turn) => turn.attempts), ...(failed.pendingTurn?.attempts ?? [])];
      if (slot.matchIds.length > record.researchPlan.maxSlotRetries) throw new Error("Registered retry limit reached; retain or skip the unscored slot.");
      if (failed.status !== "error" || !attempts.some((attempt) => attempt.phase === "provider" && attempt.status === "error")
        || attempts.some((attempt) => attempt.phase === "qualification")) throw new Error("Research retries require a recorded provider infrastructure error; qualification failures require a new study.");
    }
    this.checkpoint(record, () => { record.status = "running"; record.error = undefined; record.updatedAt = new Date().toISOString(); }, { command: { kind: "retry", slotId: slot.id } });
    if (!this.commands) this.retrySlots.add(slot.id);
    void this.pump(record);
  }
  skip(id: string): void {
    const record = this.get(id);
    if (record.status !== "paused") throw new Error("Pause the series before skipping.");
    const slot = record.slots.find((candidate) => !candidate.skipped && !hasScoredResult(linkedMatch(candidate, this.controller.list())));
    if (!slot) throw new Error("No slot to skip.");
    const match = linkedMatch(slot, this.controller.list());
    if (match && !terminal.has(match.status)) throw new Error("Stop the active match before skipping.");
    this.checkpoint(record, () => { slot.skipped = true; record.status = "running"; record.error = undefined; record.updatedAt = new Date().toISOString(); });
    void this.pump(record);
  }
  onMatchChange(match: MatchRecord): void {
    if (!match.series || !terminal.has(match.status)) return;
    const record = this.series.find((item) => item.id === match.series?.id);
    if (record?.status === "running") setTimeout(() => void this.pump(record), 0);
  }
  private async pump(record: SeriesRecord): Promise<void> {
    if (this.pumping.has(record.id)) return;
    this.pumping.add(record.id);
    try {
      while (record.status === "running") {
        const slot = record.slots.find((candidate) => !candidate.skipped && !hasScoredResult(linkedMatch(candidate, this.controller.list())));
        if (!slot) { record.status = "completed"; record.updatedAt = new Date().toISOString(); this.save(record); return; }
        let match = linkedMatch(slot, this.controller.list());
        if (match && ["running", "ready"].includes(match.status)) {
          if (match.status === "ready") await this.controller.start(match.id);
          return;
        }
        if (match && ["paused", "interrupted"].includes(match.status)) { await this.controller.start(match.id); return; }
        if (match && terminal.has(match.status)) {
          const authorized = this.commands ? this.commands.acceptedRetry(record.id, slot.id) : this.retrySlots.has(slot.id);
          if (!authorized) { record.status = "paused"; record.error = `Slot ${slot.ordinal + 1} ended without a scored result.${match.error ? ` ${match.error}` : ""}`; this.save(record); return; }
        }
        const players = Object.fromEntries(Object.entries(slot.roles).map(([role, agentIndex]) => [role, record.agents[agentIndex]]));
        const requested = record.settings.budgets;
        match = await this.controller.create({ gameId: slot.gameId, gameVersion: slot.gameVersion ?? (record.version === "battle-series-1" && slot.gameId === "hangman" ? "independent-lanes-1" : record.plan?.games.find((entry) => entry.gameId === slot.gameId)?.gameVersion), players, turnTimeoutSeconds: record.settings.turnTimeoutSeconds, challengeSeed: slot.challengeSeed,
          series: { id: record.id, slotId: slot.id, attempt: slot.matchIds.length + 1, ...(slot.conditionId ? { conditionId: slot.conditionId, blockId: slot.blockId, planHash: record.planHash } : {}) }, budgets: record.researchPlan ? researchMatchBudgets(requested) : {
            maxPlies: requested.maxPlies, maxRequests: requested.maxRequests * 2 + 2, maxWallMinutes: requested.maxWallMinutes * 2 + 5,
            maxReportedCostUsd: requested.maxReportedCostUsd, maxRequestsPerPlayer: requested.maxRequests, maxActiveMinutesPerPlayer: requested.maxWallMinutes,
          } });
        const authorizedRetry = this.commands ? this.commands.acceptedRetry(record.id, slot.id) : this.retrySlots.has(slot.id);
        slot.matchIds.push(match.id); record.updatedAt = new Date().toISOString();
        this.save(record, authorizedRetry ? { consumeRetry: { slotId: slot.id, matchId: match.id } } : undefined);
        if (!this.commands) this.retrySlots.delete(slot.id);
        await this.controller.start(match.id);
        return;
      }
    } catch (error) {
      record.status = "paused"; record.error = error instanceof Error ? error.message : "Series execution failed."; record.updatedAt = new Date().toISOString();
      try { this.save(record); } catch { /* Store failure is already surfaced by the match controller. */ }
    } finally { this.pumping.delete(record.id); }
  }
}
