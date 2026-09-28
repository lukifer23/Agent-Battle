import { randomUUID } from "node:crypto";
import { competitorId } from "../shared.js";
import type { AgentAdapter, AgentRegistry } from "./agent.js";
import { AgentExecutionError, AgentProtocolError } from "./agent.js";
import type { ActionValidation, GameDefinition, GameRegistry } from "./game.js";
import { buildSnapshot } from "./snapshot.js";
import { projectTurn, projectEvent } from "./projection.js";
import { matchReportedCost, matchRequests } from "./usage.js";
import { beginMatchTime, endMatchTime, remainingMatchMs } from "./matchTime.js";
import type {
  AgentAttempt,
  AppState,
  GameAction,
  MatchBudgets,
  MatchEnvironment,
  MatchEvent,
  MatchRecord,
  MatchResult,
  MatchStatus,
  PlayerConfig,
  PlayerSeat,
  ProviderInfo,
  TurnTelemetry,
} from "../shared.js";

interface RunningMatch {
  control: "continue" | "pause" | "stop";
  agents: Map<string, AgentAdapter>;
  inFlight: Set<AbortController>;
  done: Promise<void>;
  generation: number;
  failure?: Error;
}

const CANCELLATION_HARD_GRACE_MS = 2500;
const ACTIVE_STATUSES: MatchStatus[] = ["ready", "running", "paused", "interrupted"];
const PRESENTATION_EVENTS = new Set(["agent.ready", "agent.thinking", "agent.started", "agent.response", "move.proposed", "turn.started", "agent.timeout"]);
class WallTimeExceededError extends Error {}

export interface CreateMatchRequest {
  gameId: string;
  gameVersion?: string;
  players: Record<string, PlayerConfig>;
  turnTimeoutSeconds: number;
  budgets?: Partial<MatchBudgets>;
  challengeSeed?: string;
  series?: { id: string; slotId: string; attempt: number };
}

// Battleship can require 201 accepted actions (two placements plus 199 shots).
// Leave room for one correction per action in the default request budget.
const DEFAULT_BUDGETS: MatchBudgets = { maxPlies: 250, maxRequests: 500, maxWallMinutes: 30, maxReportedCostUsd: null };
const ADAPTER_VERSION = "agent-battle/adapter-v5";

function clampBudget(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export class MatchController {
  private readonly runtime = new Map<string, unknown>();
  private readonly runs = new Map<string, RunningMatch>();
  private readonly records: MatchRecord[];
  private creatingMatch = false;
  private readonly durableRecords = new Map<string, MatchRecord>();
  private storageFailure?: Error;
  private recoveryCandidate?: MatchRecord;
  private readonly epoch = randomUUID();
  private stateVersion = 0;

  constructor(
    private readonly games: GameRegistry,
    private readonly agents: AgentRegistry,
    initialRecords: MatchRecord[],
    private readonly providers: () => Promise<ProviderInfo[]>,
    private readonly onChange: (record: MatchRecord, event?: MatchEvent) => void,
    private readonly onStorageFailure: (message: string) => void = () => undefined,
  ) {
    this.records = initialRecords;
    for (const record of initialRecords) this.durableRecords.set(record.id, structuredClone(record));
    let migrated = false;
    for (const match of this.records) {
      try {
        const game = this.games.get(match.gameId, match.gameVersion);
        const state = game.deserialize(match.gameState);
        if (match.status === "finished" && match.result) {
          const derived = game.isTerminal(state) ? game.result(state) : undefined;
          const matches = derived
            && derived.kind === match.result.kind
            && derived.notation === match.result.notation
            && (derived.winnerId ?? null) === (match.result.winnerId ?? null);
          if (!matches) throw new Error("Saved result does not match the replayed game position.");
        }
        if (match.status === "running") {
          for (const attempt of match.pendingTurn?.attempts ?? []) {
            if (attempt.status === "started") { attempt.status = "interrupted"; attempt.accountedMs = Math.max(0, Date.parse(attempt.deadlineAt ?? new Date().toISOString()) - Date.parse(attempt.startedAt)); attempt.phase = "controller"; }
          }
          endMatchTime(match);
          match.status = "interrupted";
          match.currentPlayerId = undefined;
          match.error = "The app restarted during this match. Its saved game state is intact; resume to ask the current player again.";
          migrated = true;
        }
        if (ACTIVE_STATUSES.includes(match.status)) this.runtime.set(match.id, state);
      } catch (error) {
        endMatchTime(match);
        match.status = "error";
        match.error = `Could not restore saved ${match.gameId || "game"} state: ${error instanceof Error ? error.message : "invalid snapshot"}`;
        migrated = true;
      }
    }
    if (migrated) this.save();
  }

  getRecoveryCandidate(): MatchRecord | undefined { return this.recoveryCandidate ? structuredClone(this.recoveryCandidate) : undefined; }

  getStorageError(): string | null { return this.storageFailure?.message ?? null; }

  private assertWritable(): void {
    if (this.storageFailure) throw this.storageFailure;
  }

  private commit(match: MatchRecord): void {
    this.assertWritable();
    try {
      this.onChange(match);
      this.durableRecords.set(match.id, structuredClone(match));
      this.stateVersion++;
    } catch (error) {
      this.recoveryCandidate = structuredClone(match);
      const message = error instanceof Error ? error.message : "storage failure";
      this.storageFailure = new Error(`Could not save match state: ${message}. The last saved position needs recovery.`);
      const durable = this.durableRecords.get(match.id);
      if (durable) {
        for (const key of Object.keys(match)) delete (match as unknown as Record<string, unknown>)[key];
        Object.assign(match, structuredClone(durable));
        endMatchTime(match);
        match.status = "error";
        match.error = this.storageFailure.message;
        match.currentPlayerId = undefined;
      }
      try { this.onStorageFailure(this.storageFailure.message); } catch { /* Reporting cannot make a failed write succeed. */ }
      throw this.storageFailure;
    }
  }

  get(id: string): MatchRecord | undefined {
    return this.records.find((match) => match.id === id);
  }

  list(): MatchRecord[] {
    return [...this.records];
  }

  active(): MatchRecord | null {
    return this.records.find((match) => ["ready", "running", "paused", "interrupted"].includes(match.status)) ?? null;
  }

  async snapshot(): Promise<AppState> {
    const providers = await this.providers();
    return { ...buildSnapshot(this.records, providers, 50, this.games), epoch: this.epoch, stateVersion: this.stateVersion };
  }

  async create(request: CreateMatchRequest): Promise<MatchRecord> {
    this.assertWritable();
    if (this.creatingMatch) throw new Error("A match is already being created.");
    this.creatingMatch = true;
    try {
      return await this.createMatch(request);
    } finally {
      this.creatingMatch = false;
    }
  }

  private async createMatch(request: CreateMatchRequest): Promise<MatchRecord> {
    const game = this.games.get(request.gameId, request.gameVersion);
    if (Object.keys(request.players).sort().join() !== [...game.playerIds].sort().join()) throw new Error("Player roles do not match the game.");
    if (game.playerIds.length !== 2) throw new Error("The current match controller requires exactly two players.");
    if (!Number.isInteger(request.turnTimeoutSeconds) || request.turnTimeoutSeconds < 30 || request.turnTimeoutSeconds > 600) {
      throw new Error("Move timeout must be between 30 and 600 seconds.");
    }
    if (this.records.some((match) => ["ready", "running", "paused", "interrupted"].includes(match.status))) {
      throw new Error("Resume or stop the current match before creating another.");
    }
    const detected = await this.providers();
    const players: [PlayerSeat, PlayerSeat] = game.playerIds.map((id) => {
      const config = request.players[id];
      if (!config) throw new Error(`Missing agent configuration for ${game.playerLabel(id)}.`);
      if (!detected.find((provider) => provider.provider === config.provider)?.installed) {
        throw new Error(`${config.provider} CLI is not installed or not available in PATH.`);
      }
      const model = config.model.trim();
      const reasoning = config.reasoning?.trim() || (game.id === "hangman" && game.version === "shared-board-2" && !request.series && config.provider !== "opencode" ? config.provider === "claude" ? "none" : "low" : "");
      if (model.length > 140 || reasoning.length > 40 || /[\r\n\0]/.test(model + reasoning)) throw new Error("Model and reasoning settings are invalid.");
      const reasoningOptions: Record<string, string[]> = {
        codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        claude: ["none", "low", "medium", "high", "xhigh", "max"],
        opencode: [],
      };
      if (reasoning && reasoningOptions[config.provider].length && !reasoningOptions[config.provider].includes(reasoning.toLowerCase())) {
        throw new Error(`${config.provider} reasoning must be one of: ${reasoningOptions[config.provider].join(", ")}.`);
      }
      return {
        id,
        label: game.playerLabel(id),
        agent: { ...config, model, reasoning, name: `${config.provider}${model ? ` · ${model}` : " · CLI default"}` },
      };
    }) as [PlayerSeat, PlayerSeat];
    const now = new Date().toISOString();
    const state = game.createState(request.challengeSeed);
    const budgets: MatchBudgets = {
      maxPlies: clampBudget(request.budgets?.maxPlies, DEFAULT_BUDGETS.maxPlies, 10_000),
      maxRequests: clampBudget(request.budgets?.maxRequests, DEFAULT_BUDGETS.maxRequests, 100_000),
      maxWallMinutes: clampBudget(request.budgets?.maxWallMinutes, DEFAULT_BUDGETS.maxWallMinutes, 10_000),
      maxReportedCostUsd: typeof request.budgets?.maxReportedCostUsd === "number" && request.budgets.maxReportedCostUsd >= 0 ? request.budgets.maxReportedCostUsd : null,
      ...(request.budgets?.maxRequestsPerPlayer ? { maxRequestsPerPlayer: clampBudget(request.budgets.maxRequestsPerPlayer, 200, 100_000) } : {}),
      ...(request.budgets?.maxActiveMinutesPerPlayer ? { maxActiveMinutesPerPlayer: clampBudget(request.budgets.maxActiveMinutesPerPlayer, 30, 10_000) } : {}),
    };
    const cliVersions: MatchEnvironment["cliVersions"] = {};
    for (const provider of detected) if (provider.version) cliVersions[provider.provider] = provider.version;
    const environment: MatchEnvironment = {
      adapterVersion: ADAPTER_VERSION,
      promptVersion: "observation-contract-v3",
      toolSchemaVersion: game.actionSchemaVersion,
      cliVersions,
    };
    const match: MatchRecord = {
      id: randomUUID(),
      gameId: game.id,
      gameVersion: game.version,
      protocolVersion: "game-action-v1",
      createdAt: now,
      updatedAt: now,
      status: "ready",
      revision: 0,
      players,
      settings: {
        turnTimeoutSeconds: request.turnTimeoutSeconds,
        maxRetries: 1,
        retryPolicy: "retry-invalid-once-then-forfeit",
        promptVersion: environment.promptVersion,
        toolSchemaVersion: game.actionSchemaVersion,
        resultPolicy: "engine-terminal-with-arena-adjudication",
        budgets,
      },
      environment,
      timeAccounting: { mode: "active-runtime-v1", elapsedMs: 0 },
      gameState: game.serialize(state),
      ...(request.series ? { series: request.series } : {}),
      history: [],
      events: [],
    };
    this.runtime.set(match.id, state);
    this.records.unshift(match);
    try {
      this.emit(match, "match.created", "Match created", { gameId: game.id, gameVersion: game.version });
    } catch (error) {
      this.records.shift();
      this.runtime.delete(match.id);
      throw new Error(`The new match could not be saved: ${error instanceof Error ? error.message : "storage failure"}. It was not added.`);
    }
    return match;
  }

  async start(id: string): Promise<MatchRecord> {
    this.assertWritable();
    const match = this.require(id);
    const existingRun = this.runs.get(id);
    if (existingRun && match.status === "running") return match;
    if (match.status === "running" || existingRun) throw new Error("This match is already running.");
    if (!["ready", "paused", "interrupted"].includes(match.status)) throw new Error("Only a ready, paused or interrupted match can be started or resumed.");
    const otherActive = this.records.find((candidate) => candidate.id !== id && ACTIVE_STATUSES.includes(candidate.status));
    if (otherActive) throw new Error("Another match is already active. Stop or finish it before resuming this match.");
    const game = this.games.get(match.gameId, match.gameVersion);
    if (!this.runtime.has(id)) this.runtime.set(id, game.deserialize(match.gameState));
    const generation = (match.runGeneration ?? 0) + 1;
    match.runGeneration = generation;
    const running: RunningMatch = { control: "continue", agents: new Map(), inFlight: new Set(), done: Promise.resolve(), generation };
    this.runs.set(id, running);
    match.status = "running";
    beginMatchTime(match);
    match.error = undefined;
    match.currentPlayerId = undefined;
    const resuming = match.history.length > 0 || Boolean(match.pendingTurn);
    const state = this.runtime.get(id);
    try {
      match.gameState = game.serialize(state);
      this.emit(match, resuming ? "match.resumed" : "match.started", resuming ? "Match resumed" : "Match started");
    } catch {
      this.runs.delete(id);
      throw this.storageFailure ?? new Error("Could not save the match start.");
    }
    running.done = this.run(id, game, running);
    void running.done.catch((error: unknown) => {
      const current = this.get(id);
      if (!current) return;
      current.status = "error";
      endMatchTime(current);
      current.error = error instanceof Error ? error.message : "Unexpected match controller failure.";
      current.currentPlayerId = undefined;
      try {
        this.emit(current, "agent.error", `Match controller failed: ${current.error}`);
      } catch (notificationError) {
        console.error("Could not report a failed match controller state.", notificationError);
      }
      console.error("Unhandled match controller failure.", error);
    });
    return match;
  }

  async pause(id: string): Promise<void> {
    this.assertWritable();
    const match = this.require(id);
    const running = this.runs.get(id);
    if (running && match.status === "running") {
      await this.cancel(id, running, "pause");
      return;
    }
    if (match.status === "paused") return;
    throw new Error(`A ${match.status} match cannot be paused.`);
  }

  async stop(id: string): Promise<void> {
    this.assertWritable();
    const match = this.require(id);
    const running = this.runs.get(id);
    if (running && match.status === "running") {
      await this.cancel(id, running, "stop");
      return;
    }
    if (["ready", "paused", "interrupted", "running"].includes(match.status)) {
      endMatchTime(match);
      match.status = "stopped";
      match.currentPlayerId = undefined;
      match.error = undefined;
      match.updatedAt = new Date().toISOString();
      this.emit(match, "match.stopped", match.pendingTurn
        ? "Match stopped before resuming. The saved position and the retained in-flight attempt are kept for the record."
        : "Match stopped before a controller was attached. The saved position is retained.");
      return;
    }
  }

  async shutdown(): Promise<void> {
    const active = this.active();
    if (active?.status === "running") {
      await this.pause(active.id);
    }
    await Promise.all([...this.runs.values()].map((running) => running.done.catch(() => undefined)));
  }

  private async cancel(id: string, running: RunningMatch, control: "pause" | "stop"): Promise<void> {
    running.control = control;
    const reason = new AgentExecutionError(
      control === "pause" ? "Match paused during an active request." : "Match stopped during an active request.",
      false,
    );
    for (const controller of running.inFlight) controller.abort(reason);
    await running.done;
    if (this.runs.get(id) === running) this.runs.delete(id);
    if (running.failure) throw running.failure;
  }

  private persistCheckpoint(match: MatchRecord, game: GameDefinition<unknown>, state: unknown): boolean {
    try {
      this.persistState(match, game, state);
      return true;
    } catch {
      return false;
    }
  }

  private require(id: string): MatchRecord {
    const match = this.get(id);
    if (!match) throw new Error("Match not found.");
    return match;
  }

  private emit(match: MatchRecord, type: string, text: string, payload?: Record<string, unknown>, playerId?: string): void {
    if (PRESENTATION_EVENTS.has(type)) {
      const event: MatchEvent = { at: new Date().toISOString(), type, text, ...(playerId ? { playerId } : {}), ...(payload ? { payload } : {}) };
      try { this.onChange(match, projectEvent(match, event, this.games)); }
      catch (error) { console.error("Could not publish a presentation event.", error); }
      return;
    }
    this.emitBatch(match, [{ type, text, payload, playerId }]);
  }

  private emitBatch(match: MatchRecord, entries: Array<{ type: string; text: string; payload?: Record<string, unknown>; playerId?: string }>): void {
    const events: MatchEvent[] = [];
    for (const { type, text, payload, playerId } of entries) {
      match.revision = (match.revision ?? 0) + 1;
      const event: MatchEvent = {
        at: new Date().toISOString(),
        type,
        text,
        sequence: match.revision,
        ...(playerId ? { playerId } : {}),
        ...(payload ? { payload } : {}),
      };
      const safeEvent = projectEvent(match, event, this.games);
      match.events.push(safeEvent);
      events.push(safeEvent);
      if (match.events.length > 500) match.events.splice(0, match.events.length - 500);
      match.updatedAt = event.at;
    }
    this.commit(match);
    for (const event of events) {
      try { this.onChange(match, projectEvent(match, event, this.games)); }
      catch (error) { console.error("Could not publish a committed match event.", error); }
    }
  }

  private save(): void {
    if (this.records[0]) this.commit(this.records[0]);
  }

  private player(match: MatchRecord, playerId: string): PlayerSeat {
    const player = match.players.find((seat) => seat.id === playerId);
    if (!player) throw new Error(`No participant found for game player ${playerId}.`);
    return player;
  }

  private async run(id: string, game: GameDefinition<unknown>, running: RunningMatch): Promise<void> {
    const match = this.require(id);
    let state = this.runtime.get(id);
    if (state === undefined) {
      endMatchTime(match);
      match.status = "error";
      match.error = "The game state is missing.";
      this.emit(match, "agent.error", match.error);
      this.runs.delete(id);
      return;
    }

    try {
      for (const seat of match.players) {
        const adapter = this.agents.create(seat.agent);
        running.agents.set(seat.id, adapter);
        try {
          await adapter.initialize();
          if (match.environment) match.environment.noToolsPlayerIds = [...(match.environment.noToolsPlayerIds ?? []).filter((id) => id !== seat.id), ...(adapter.isolationQualified ? [seat.id] : [])];
          if (match.series && !adapter.isolationQualified) throw new AgentExecutionError(`${seat.agent.provider} tool isolation is not qualified for scored series trials.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "The agent could not initialize.";
          const retryBudget = this.budgetStopReason(match, game, state);
          if (retryBudget) { this.budgetStop(match, retryBudget); return; }
          const startedAt = new Date().toISOString();
          const initializationAttempt = this.attempt(1, startedAt, "error", { error: message, phase: "initialization" });
          match.pendingTurn = {
            turnId: randomUUID(),
            turnIndex: match.history.length + 1,
            ply: game.plyCount(state) + 1,
            playerId: seat.id,
            startedAt,
            attempts: [initializationAttempt],
          };
          match.status = "error";
          endMatchTime(match);
          match.error = message;
          match.currentPlayerId = undefined;
          this.emit(match, "agent.error", `${seat.agent.name} could not initialize: ${message}`, { phase: "initialization" }, seat.id);
          this.persistCheckpoint(match, game, state);
          return;
        }
        this.emit(match, "agent.ready", `${seat.agent.name} is ready`, { provider: seat.agent.provider, model: seat.agent.model || null }, seat.id);
        if (running.control !== "continue") break;
      }
      while (running.control === "continue") {
        if (game.isTerminal(state)) {
          this.finish(match, game, state, this.requiredTerminalResult(game, state));
          return;
        }
        const budgetReason = this.budgetStopReason(match, game, state);
        if (budgetReason) { this.budgetStop(match, budgetReason); return; }
        const playerId = game.currentPlayer(state);
        if (!playerId) throw new Error("The game has no current player but is not terminal.");
        const playerBudget = this.budgetStopReason(match, game, state, playerId);
        if (playerBudget) { this.budgetStop(match, playerBudget); return; }
        match.currentPlayerId = playerId;
        const seat = this.player(match, playerId);
        const adapter = running.agents.get(playerId);
        if (!adapter) throw new Error(`Adapter for player ${playerId} was not initialized.`);
        const ply = game.plyCount(state) + 1;
        const pending = match.pendingTurn && match.pendingTurn.playerId === playerId && match.pendingTurn.ply === ply ? match.pendingTurn : undefined;
        const turnId = pending?.turnId ?? randomUUID();
        const turnIndex = pending?.turnIndex ?? match.history.length + 1;
        let feedback = pending?.feedback;
        let selectedAction: GameAction | undefined;
        const attempts: AgentAttempt[] = pending ? [...pending.attempts] : [];
        const resumeAttempt = this.nextAttemptNumber(attempts);
        match.pendingTurn = pending
          ? { ...pending, attempts }
          : { turnId, turnIndex, ply, playerId, startedAt: new Date().toISOString(), attempts };
        if (!this.persistCheckpoint(match, game, state)) return;
        const observation = game.observe(state, {
          matchId: id,
          turnId,
          player: seat,
          ply,
          turnIndex,
          turnTimeoutMs: match.settings.turnTimeoutSeconds * 1000,
        });
        const before = game.serialize(state);
        const beforeObject = before && typeof before === "object" ? before as Record<string, unknown> : {};
        const fenBefore = typeof beforeObject.fen === "string" ? beforeObject.fen : undefined;
        if (!pending) {
          this.emit(match, "turn.started", `${seat.agent.name} to act`, { turnId, turnIndex, ply, legalActionCount: observation.legalActions.length, fenBefore }, playerId);
          this.emit(match, "agent.thinking", `${seat.agent.name} is considering the observation`, { turnId }, playerId);
        } else {
          this.emit(match, "turn.started", `${seat.agent.name} resumes turn ${turnIndex}`, { turnId, turnIndex, ply, resumed: true, legalActionCount: observation.legalActions.length, fenBefore }, playerId);
        }

        for (let attemptNumber = resumeAttempt; attemptNumber <= match.settings.maxRetries + 1; attemptNumber += 1) {
          if (running.control !== "continue") break;
          const attemptBudgetReason = this.budgetStopReason(match, game, state, playerId);
          if (attemptBudgetReason) { this.budgetStop(match, attemptBudgetReason); return; }
          const startedAt = new Date().toISOString();
          const invocationId = randomUUID();
          const reservation: AgentAttempt = { attempt: attemptNumber, invocationId, startedAt, deadlineAt: new Date(Date.parse(startedAt) + Math.min(observation.clock.turnTimeoutMs, remainingMatchMs(match), this.remainingPlayerMs(match, playerId))).toISOString(), status: "started", phase: "provider", toolCalls: null, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } };
          attempts.push(reservation);
          if (!this.persistCheckpoint(match, game, state)) return;
          const finishAttempt = (completed: AgentAttempt) => Object.assign(reservation, completed, { invocationId, deadlineAt: reservation.deadlineAt });
          this.emit(match, "agent.started", `${seat.agent.name} request ${attemptNumber}`, { turnId, attempt: attemptNumber }, playerId);
          let reply: Awaited<ReturnType<typeof adapter.act>> | undefined;
          let failure: unknown;
          const control = new AbortController();
          running.inFlight.add(control);
          try {
            const attemptObservation = feedback ? { ...observation, feedback } : observation;
            reply = await this.invokeWithTimeout(adapter, attemptObservation, control, Math.min(remainingMatchMs(match), this.remainingPlayerMs(match, playerId)));
          } catch (error) { failure = error; }
          finally {
            running.inFlight.delete(control);
            await adapter.shutdown();
          }

          const evidence = reply ?? (failure instanceof AgentProtocolError ? failure : failure instanceof AgentExecutionError && failure.evidence ? { ...failure, ...failure.evidence } : undefined);
          const qualificationFailed = Boolean(match.series && (evidence || failure instanceof AgentExecutionError && failure.timedOut) && (!evidence?.resolvedModel || evidence.resolvedModel !== seat.agent.model || evidence.toolCalls !== 0));
          if (qualificationFailed) {
            failure = new AgentExecutionError(`Series model or tool qualification failed for ${seat.label}: requested ${seat.agent.model}, reported ${evidence?.resolvedModel ?? "unknown"}, tool calls ${evidence?.toolCalls ?? "unknown"}.`);
          } else if (evidence?.resolvedModel) seat.agent.resolvedModel = evidence.resolvedModel;

          if (running.control !== "continue") {
            finishAttempt(this.attempt(attemptNumber, startedAt, "cancelled", {
              phase: "controller",
              ...(failure instanceof AgentExecutionError ? { error: failure.message, responseExcerpt: failure.responseExcerpt, stderrExcerpt: failure.stderrExcerpt, latencyMs: failure.latencyMs } : {}),
              ...(reply ? { latencyMs: reply.latencyMs, responseExcerpt: reply.responseExcerpt, stderrExcerpt: reply.stderrExcerpt, toolCalls: reply.toolCalls, usage: reply.usage, resolvedModel: reply.resolvedModel, sessionId: reply.sessionId } : {}),
            }));
            break;
          }

          if (failure instanceof WallTimeExceededError) {
            finishAttempt(this.attempt(attemptNumber, startedAt, "cancelled", { phase: "controller", error: failure.message }));
            this.budgetStop(match, `maximum active time (${match.settings.budgets.maxWallMinutes} min) reached`);
            return;
          }

          if (failure instanceof AgentExecutionError && !failure.timedOut) {
            finishAttempt(this.attempt(attemptNumber, startedAt, "error", { phase: qualificationFailed ? "qualification" : "provider", error: failure.message,
              responseExcerpt: evidence?.responseExcerpt ?? failure.responseExcerpt, stderrExcerpt: evidence?.stderrExcerpt ?? failure.stderrExcerpt,
              latencyMs: evidence?.latencyMs ?? failure.latencyMs, ...(evidence ? { toolCalls: evidence.toolCalls, usage: evidence.usage, resolvedModel: evidence.resolvedModel, sessionId: evidence.sessionId } : {}) }));
            const record = this.turnRecord(match, game, seat, turnId, observation, attempts, false);
            match.history.push(record);
            match.pendingTurn = undefined;
            match.status = "error";
            endMatchTime(match);
            match.error = failure.message;
            match.currentPlayerId = undefined;
            this.emit(match, "agent.error", `${seat.agent.name} failed: ${failure.message}`, { turnId, attempt: attemptNumber }, playerId);
            this.persistCheckpoint(match, game, state);
            return;
          }

          let validation: ActionValidation = { valid: false, reason: "Agent returned no action." };
          const action = reply?.action;
          if (failure instanceof AgentProtocolError) {
            validation = { valid: false, reason: failure.message };
            this.emit(match, "agent.response", `${seat.agent.name} returned malformed action data`, {
              turnId, attempt: attemptNumber, status: "malformed", responseLength: failure.responseExcerpt.length,
            }, playerId);
            finishAttempt(this.attempt(attemptNumber, startedAt, "invalid", {
              phase: "protocol", error: failure.message, responseExcerpt: failure.responseExcerpt,
              latencyMs: failure.latencyMs, stderrExcerpt: failure.stderrExcerpt,
              toolCalls: failure.toolCalls, usage: failure.usage, resolvedModel: failure.resolvedModel, sessionId: failure.sessionId,
            }));
          } else if (failure instanceof AgentExecutionError && failure.timedOut) {
            validation = { valid: false, reason: failure.message };
            this.emit(match, "agent.response", `${seat.agent.name} request timed out`, { turnId, attempt: attemptNumber, status: "timeout" }, playerId);
            finishAttempt(this.attempt(attemptNumber, startedAt, "timeout", { phase: "provider", error: failure.message, responseExcerpt: failure.responseExcerpt, stderrExcerpt: failure.stderrExcerpt, latencyMs: failure.latencyMs }));
            this.emit(match, "agent.timeout", `${seat.agent.name} exceeded its move timeout`, { turnId, attempt: attemptNumber, timeoutMs: observation.clock.turnTimeoutMs }, playerId);
          } else if (reply && action) {
            this.emit(match, "agent.response", `${seat.agent.name} returned a structured action`, {
              turnId, attempt: attemptNumber, action, latencyMs: reply.latencyMs,
              toolCalls: reply.toolCalls, usage: reply.usage,
            }, playerId);
            this.emit(match, "move.proposed", `${seat.agent.name} proposed ${game.actionLabel(action)}`, { turnId, action }, playerId);
            validation = reply.toolCalls && reply.toolCalls > 0
              ? { valid: false, reason: `Agent made ${reply.toolCalls} external tool call(s); this arena accepts a structured action response only.` }
              : game.validateAction(state, playerId, action);
            finishAttempt(this.attempt(attemptNumber, startedAt, validation.valid ? "valid" : "invalid", {
              completedAt: new Date().toISOString(),
              latencyMs: reply.latencyMs,
              action,
              ...(validation.reason ? { error: validation.reason } : {}),
              responseExcerpt: reply.responseExcerpt,
              stderrExcerpt: reply.stderrExcerpt,
              toolCalls: reply.toolCalls,
              resolvedModel: reply.resolvedModel,
              sessionId: reply.sessionId,
              usage: reply.usage,
            }));
          } else {
            finishAttempt(this.attempt(attemptNumber, startedAt, "error", { phase: "controller", error: failure instanceof Error ? failure.message : "Unknown agent failure." }));
            match.history.push(this.turnRecord(match, game, seat, turnId, observation, attempts, false));
            match.pendingTurn = undefined;
            match.status = "error";
            endMatchTime(match);
            match.error = failure instanceof Error ? failure.message : "Unknown agent failure.";
            this.emit(match, "agent.error", match.error, { turnId }, playerId);
            this.persistCheckpoint(match, game, state);
            return;
          }

          if (validation.valid && action) {
            selectedAction = action;
            break;
          }

          feedback = validation.reason ?? "The action was invalid.";
          if (match.pendingTurn) match.pendingTurn.feedback = feedback;
          if (attemptNumber <= match.settings.maxRetries) {
            this.emitBatch(match, [
              { type: "move.rejected", text: `${seat.agent.name}: ${feedback}`, payload: { turnId, attempt: attemptNumber, action: action ?? null, error: feedback }, playerId },
              { type: "turn.retry", text: "Returning the rejection reason and same authoritative position for one retry", payload: { turnId, retry: attemptNumber }, playerId },
            ]);
          }
        }

        if (running.control !== "continue") {
          if (match.pendingTurn) match.pendingTurn.feedback = feedback;
          if (!this.persistCheckpoint(match, game, state)) return;
          break;
        }

        if (!selectedAction) {
          const record = this.turnRecord(match, game, seat, turnId, observation, attempts, false);
          match.history.push(record);
          match.pendingTurn = undefined;
          if (game.forfeit) {
            const nextState = game.forfeit(game.cloneState(state), playerId);
            const result = game.result(nextState);
            match.gameState = game.serialize(nextState);
            match.currentPlayerId = game.currentPlayer(nextState) ?? undefined;
            if (result) { match.result = result; match.status = "finished"; endMatchTime(match); }
            this.emitBatch(match, [{ type: "lane.forfeit", text: "Lane forfeited after retry exhaustion", playerId, payload: game.eventProjection(nextState) },
              ...(result ? [{ type: "match.finished", text: result.reason, payload: { result: result.notation, kind: result.kind, winnerId: result.winnerId, reason: result.reason } }] : [])]);
            state = nextState;
            this.runtime.set(id, state);
            if (result) return;
            continue;
          }
          const winnerId = match.players.find((player) => player.id !== playerId)?.id;
          if (!winnerId) throw new Error("The game did not provide an opposing player for forfeiture.");
          const result = game.winResult(winnerId, `${seat.label} forfeited after retry exhaustion: ${feedback ?? "invalid action"}`);
          match.result = result;
          match.status = "forfeit";
          endMatchTime(match);
          match.currentPlayerId = undefined;
          match.error = undefined;
          match.gameState = game.serialize(state, result);
          this.emitBatch(match, [
            { type: "move.rejected", text: `${seat.agent.name} exhausted its retry after: ${feedback ?? "no valid action"}`, payload: { turnId, retryCount: attempts.length - 1 }, playerId },
            { type: "match.finished", text: `${result.notation} · ${result.reason}`, payload: { result: result.notation, kind: result.kind, winnerId: result.winnerId ?? null, reason: result.reason, status: "forfeit" } },
          ]);
          return;
        }

        const nextState = game.applyAction(game.cloneState(state), playerId, selectedAction);
        const terminalResult = game.isTerminal(nextState) ? this.requiredTerminalResult(game, nextState) : undefined;
        const afterSnapshot = game.serialize(nextState, terminalResult);
        const record = this.turnRecord(match, game, seat, turnId, observation, attempts, true);
        record.action = selectedAction;
        record.actionLabel = game.actionLabel(selectedAction);
        const afterObject = afterSnapshot && typeof afterSnapshot === "object" ? afterSnapshot as Record<string, unknown> : {};
        if (typeof afterObject.fen === "string") record.fenAfter = afterObject.fen;
        record.latencyMs = attempts.reduce((total, attempt) => total + (attempt.latencyMs ?? 0), 0);
        record.retryCount = Math.max(0, attempts.length - 1);
        match.history.push(record);
        match.pendingTurn = undefined;
        match.currentPlayerId = game.currentPlayer(nextState) ?? undefined;
        if (terminalResult) {
          match.result = terminalResult;
          match.status = "finished";
          endMatchTime(match);
          match.currentPlayerId = undefined;
          match.error = undefined;
        }
        match.gameState = afterSnapshot;
        this.emitBatch(match, [
          { type: "move.applied", text: `${seat.agent.name} played ${record.actionLabel}`, payload: {
            turnId, ply, action: selectedAction, actionLabel: record.actionLabel,
            fenBefore, nextPlayerId: match.currentPlayerId ?? null, ...game.eventProjection(nextState),
          }, playerId },
          { type: "turn.completed", text: `${seat.agent.name} completed ply ${ply}`, payload: {
            turnId, turnIndex, ply, latencyMs: record.latencyMs, retryCount: record.retryCount,
            toolCalls: attempts.reduce((sum, attempt) => sum + (attempt.toolCalls ?? 0), 0),
            inputTokens: totalUsage(attempts, "inputTokens"), outputTokens: totalUsage(attempts, "outputTokens"),
            record: projectTurn(record),
          }, playerId },
          ...(terminalResult ? [{ type: "match.finished", text: `${terminalResult.notation} · ${terminalResult.reason}`, payload: {
            result: terminalResult.notation, kind: terminalResult.kind, winnerId: terminalResult.winnerId ?? null,
            reason: terminalResult.reason, status: "finished",
          } }] : []),
        ]);
        state = nextState;
        this.runtime.set(id, state);

        if (terminalResult) return;
      }

      if (running.control === "pause") {
        endMatchTime(match);
        match.status = "paused";
        match.currentPlayerId = undefined;
        this.emit(match, "match.paused", "Match paused at a saved turn boundary. Resume to request the current player's move again.");
      } else if (running.control === "stop") {
        endMatchTime(match);
        match.status = "stopped";
        match.currentPlayerId = undefined;
        this.emit(match, "match.stopped", "Match stopped. The current position and telemetry are saved.");
      }
      this.commit(match);
    } catch (error) {
      if (this.storageFailure) {
        running.failure = this.storageFailure;
        return;
      }
      match.status = "error";
      endMatchTime(match);
      match.error = error instanceof Error ? error.message : "Unexpected match controller failure.";
      match.currentPlayerId = undefined;
      this.emit(match, "agent.error", match.error);
      this.persistCheckpoint(match, game, state);
    } finally {
      if (!ACTIVE_STATUSES.includes(match.status)) this.runtime.delete(id);
      await Promise.all([...running.agents.values()].map((agent) => agent.shutdown()));
      if (this.runs.get(id) === running) this.runs.delete(id);
    }
  }

  private remainingPlayerMs(match: MatchRecord, playerId: string): number {
    const maximum = match.settings.budgets.maxActiveMinutesPerPlayer;
    if (!maximum) return Number.POSITIVE_INFINITY;
    const used = [...match.history, ...(match.pendingTurn ? [match.pendingTurn] : [])]
      .filter((turn) => turn.playerId === playerId).flatMap((turn) => turn.attempts)
      .reduce((total, attempt) => total + (attempt.accountedMs ?? attempt.latencyMs ?? 0), 0);
    return maximum * 60_000 - used;
  }

  private budgetStopReason(match: MatchRecord, game: GameDefinition<unknown>, state: unknown, playerId?: string): string | undefined {
    const budgets = match.settings.budgets;
    const plies = game.plyCount(state);
    if (plies >= budgets.maxPlies) return `maximum plies (${budgets.maxPlies}) reached`;
    const requests = matchRequests(match);
    if (requests >= budgets.maxRequests) return `maximum requests (${budgets.maxRequests}) reached`;
    if (playerId && budgets.maxRequestsPerPlayer && [...match.history, ...(match.pendingTurn ? [match.pendingTurn] : [])]
      .filter((turn) => turn.playerId === playerId).flatMap((turn) => turn.attempts).filter((attempt) => attempt.phase !== "initialization").length >= budgets.maxRequestsPerPlayer) return `${playerId} request limit reached`;
    if (playerId && this.remainingPlayerMs(match, playerId) <= 0) return `${playerId} active provider time limit reached`;
    if (remainingMatchMs(match) <= 0) return `maximum ${match.timeAccounting ? "active" : "wall"} time (${budgets.maxWallMinutes} min) reached`;
    if (budgets.maxReportedCostUsd !== null) {
      const cost = matchReportedCost(match);
      if (cost !== null && cost >= budgets.maxReportedCostUsd) return `reported cost threshold ($${budgets.maxReportedCostUsd}) reached`;
    }
    return undefined;
  }

  private budgetStop(match: MatchRecord, reason: string): void {
    endMatchTime(match);
    // Timer callbacks may fire one millisecond before Date.now reaches their
    // nominal deadline. A cutoff attributed to active match time has consumed
    // that full budget even when the wall-clock sample rounds down.
    if (match.timeAccounting && reason.startsWith("maximum active time")) {
      match.timeAccounting.elapsedMs = Math.max(match.timeAccounting.elapsedMs, match.settings.budgets.maxWallMinutes * 60_000);
    }
    match.status = "stopped";
    match.currentPlayerId = undefined;
    match.error = `Budget reached: ${reason}. Further requests are blocked.`;
    match.updatedAt = new Date().toISOString();
    this.emit(match, "match.stopped", `Stopped: ${match.error}`, { reason: "budget" });
  }

  private nextAttemptNumber(attempts: AgentAttempt[]): number {
    return attempts.filter((attempt) => attempt.status === "invalid" || attempt.status === "timeout").length + 1;
  }

  private attempt(attempt: number, startedAt: string, status: AgentAttempt["status"], details: Partial<AgentAttempt> = {}): AgentAttempt {
    return {
      attempt,
      startedAt,
      status,
      toolCalls: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" },
      ...details,
      completedAt: details.completedAt ?? new Date().toISOString(),
    };
  }

  private async invokeWithTimeout(
    adapter: AgentAdapter,
    observation: ReturnType<GameDefinition<unknown>["observe"]>,
    control: AbortController,
    wallRemainingMs: number,
  ): Promise<Awaited<ReturnType<AgentAdapter["act"]>>> {
    const actPromise = adapter.act(observation, { signal: control.signal });
    const wallFirst = wallRemainingMs < observation.clock.turnTimeoutMs;
    const timeoutMs = Math.max(1, Math.min(observation.clock.turnTimeoutMs, wallRemainingMs));
    const timeoutError = wallFirst
      ? new WallTimeExceededError("Active match time expired during the provider request.")
      : new AgentExecutionError(`Move timed out after ${Math.ceil(observation.clock.turnTimeoutMs / 1000)} seconds.`, true);
    let primary: NodeJS.Timeout | undefined;
    let hard: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      primary = setTimeout(() => {
        control.abort(timeoutError);
        actPromise.then(() => reject(timeoutError), () => reject(timeoutError));
      }, timeoutMs);
      hard = setTimeout(() => reject(timeoutError), timeoutMs + CANCELLATION_HARD_GRACE_MS);
    });
    try {
      return await Promise.race([actPromise, timeout]);
    } catch (error) {
      if (control.signal.aborted && control.signal.reason instanceof WallTimeExceededError) throw control.signal.reason;
      throw error;
    } finally {
      if (primary) clearTimeout(primary);
      if (hard) clearTimeout(hard);
      actPromise.catch(() => undefined);
    }
  }

  private turnRecord(
    match: MatchRecord,
    game: GameDefinition<unknown>,
    seat: PlayerSeat,
    turnId: string,
    observation: ReturnType<typeof game.observe>,
    attempts: AgentAttempt[],
    valid: boolean,
  ): TurnTelemetry {
    const fen = observation.state.fen;
    const action = attempts.at(-1)?.action;
    return {
      matchId: match.id,
      ply: observation.ply,
      turnIndex: observation.turnIndex,
      turnId,
      agentId: competitorId(seat.agent),
      model: seat.agent.resolvedModel ?? seat.agent.model,
      provider: seat.agent.provider,
      ...(seat.agent.reasoning ? { reasoning: seat.agent.reasoning } : {}),
      ...(seat.agent.resolvedModel ? { resolvedModel: seat.agent.resolvedModel } : {}),
      playerId: seat.id,
      playerLabel: seat.label,
      ...(typeof fen === "string" ? { fenBefore: fen } : {}),
      legalActionCount: observation.legalActions.length,
      ...(action ? { action } : {}),
      ...(action ? { actionLabel: game.actionLabel(action) } : {}),
      valid,
      latencyMs: attempts.reduce((total, attempt) => total + (attempt.latencyMs ?? 0), 0) || null,
      retryCount: Math.max(0, attempts.length - 1),
      attempts,
      timestamp: new Date().toISOString(),
    };
  }

  private persistState(match: MatchRecord, game: GameDefinition<unknown>, state: unknown): void {
    match.gameState = game.serialize(state);
    match.updatedAt = new Date().toISOString();
    this.commit(match);
  }

  private requiredTerminalResult(game: GameDefinition<unknown>, state: unknown): MatchResult {
    const result = game.result(state);
    if (!result) throw new Error(`${game.id} reached a terminal state without an authoritative result.`);
    return result;
  }

  private finish(match: MatchRecord, game: GameDefinition<unknown>, state: unknown, result: MatchResult, status: "finished" | "forfeit" = "finished"): void {
    endMatchTime(match);
    match.result = result;
    match.status = status;
    match.currentPlayerId = undefined;
    match.error = undefined;
    match.pendingTurn = undefined;
    match.gameState = game.serialize(state, result);
    match.updatedAt = new Date().toISOString();
    this.emit(match, "match.finished", `${result.notation} · ${result.reason}`, {
      result: result.notation, kind: result.kind, winnerId: result.winnerId ?? null, reason: result.reason, status,
    });
  }
}

function totalUsage(attempts: AgentAttempt[], key: "inputTokens" | "outputTokens"): number | null {
  const values = attempts.map((attempt) => attempt.usage[key]).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
