import { randomUUID } from "node:crypto";
import { competitorId } from "../shared.js";
import type { AgentAdapter, AgentRegistry } from "./agent.js";
import { AgentExecutionError, AgentProtocolError } from "./agent.js";
import type { ActionValidation, GameDefinition, GameRegistry } from "./game.js";
import { buildSnapshot } from "./snapshot.js";
import { matchReportedCost, matchRequests } from "./usage.js";
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
}

const CANCELLATION_HARD_GRACE_MS = 2500;
const ACTIVE_STATUSES: MatchStatus[] = ["ready", "running", "paused", "interrupted"];

export interface CreateMatchRequest {
  gameId: string;
  players: Record<string, PlayerConfig>;
  turnTimeoutSeconds: number;
  budgets?: Partial<MatchBudgets>;
}

const DEFAULT_BUDGETS: MatchBudgets = { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null };
const ADAPTER_VERSION = "agent-battle/adapter-v2";

function clampBudget(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export class MatchController {
  private readonly runtime = new Map<string, unknown>();
  private readonly runs = new Map<string, RunningMatch>();
  private readonly records: MatchRecord[];
  private creatingMatch = false;

  constructor(
    private readonly games: GameRegistry,
    private readonly agents: AgentRegistry,
    initialRecords: MatchRecord[],
    private readonly providers: () => Promise<ProviderInfo[]>,
    private readonly onChange: (record: MatchRecord, event?: MatchEvent) => void,
  ) {
    this.records = initialRecords;
    let migrated = false;
    for (const match of this.records) {
      try {
        const game = this.games.get(match.gameId);
        const state = game.deserialize(match.gameState);
        if (match.status === "finished" && match.result) {
          const derived = game.isTerminal(state) ? game.result(state) : undefined;
          const matches = derived
            && derived.kind === match.result.kind
            && derived.notation === match.result.notation
            && (derived.winnerId ?? null) === (match.result.winnerId ?? null);
          if (!matches) throw new Error("Saved result does not match the replayed game position.");
        }
        this.runtime.set(match.id, state);
        if (match.status === "running") {
          match.status = "interrupted";
          match.currentPlayerId = undefined;
          match.error = "The app restarted during this match. Its saved game state is intact; resume to ask the current player again.";
          migrated = true;
        }
      } catch (error) {
        match.status = "error";
        match.error = `Could not restore saved ${match.gameId || "game"} state: ${error instanceof Error ? error.message : "invalid snapshot"}`;
        migrated = true;
      }
    }
    if (migrated) this.save();
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
    return buildSnapshot(this.records, await this.providers());
  }

  async create(request: CreateMatchRequest): Promise<MatchRecord> {
    if (this.creatingMatch) throw new Error("A match is already being created.");
    this.creatingMatch = true;
    try {
      return await this.createMatch(request);
    } finally {
      this.creatingMatch = false;
    }
  }

  private async createMatch(request: CreateMatchRequest): Promise<MatchRecord> {
    const game = this.games.get(request.gameId);
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
      const reasoning = config.reasoning?.trim() ?? "";
      if (model.length > 140 || reasoning.length > 40 || /[\r\n\0]/.test(model + reasoning)) throw new Error("Model and reasoning settings are invalid.");
      const reasoningOptions: Record<string, string[]> = {
        codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        claude: ["low", "medium", "high", "xhigh", "max"],
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
    const state = game.createState();
    const budgets: MatchBudgets = {
      maxPlies: clampBudget(request.budgets?.maxPlies, DEFAULT_BUDGETS.maxPlies, 10_000),
      maxRequests: clampBudget(request.budgets?.maxRequests, DEFAULT_BUDGETS.maxRequests, 100_000),
      maxWallMinutes: clampBudget(request.budgets?.maxWallMinutes, DEFAULT_BUDGETS.maxWallMinutes, 10_000),
      maxReportedCostUsd: typeof request.budgets?.maxReportedCostUsd === "number" && request.budgets.maxReportedCostUsd >= 0 ? request.budgets.maxReportedCostUsd : null,
    };
    const cliVersions: MatchEnvironment["cliVersions"] = {};
    for (const provider of detected) if (provider.version) cliVersions[provider.provider] = provider.version;
    const environment: MatchEnvironment = {
      adapterVersion: ADAPTER_VERSION,
      promptVersion: "observation-contract-v2",
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
      gameState: game.serialize(state),
      history: [],
      events: [],
    };
    this.runtime.set(match.id, state);
    this.records.unshift(match);
    try {
      this.onChange(match);
    } catch (error) {
      this.records.shift();
      this.runtime.delete(match.id);
      throw new Error(`The new match could not be saved: ${error instanceof Error ? error.message : "storage failure"}. It was not added.`);
    }
    this.emit(match, "match.created", "Match created", { gameId: game.id, gameVersion: game.version });
    return match;
  }

  async start(id: string): Promise<MatchRecord> {
    const match = this.require(id);
    const existingRun = this.runs.get(id);
    if (existingRun && match.status === "running") return match;
    if (match.status === "running" || existingRun) throw new Error("This match is already running.");
    if (!["ready", "paused", "interrupted"].includes(match.status)) throw new Error("Only a ready, paused or interrupted match can be started or resumed.");
    const otherActive = this.records.find((candidate) => candidate.id !== id && ACTIVE_STATUSES.includes(candidate.status));
    if (otherActive) throw new Error("Another match is already active. Stop or finish it before resuming this match.");
    const game = this.games.get(match.gameId);
    if (!this.runtime.has(id)) this.runtime.set(id, game.deserialize(match.gameState));
    const generation = (match.runGeneration ?? 0) + 1;
    match.runGeneration = generation;
    const running: RunningMatch = { control: "continue", agents: new Map(), inFlight: new Set(), done: Promise.resolve(), generation };
    this.runs.set(id, running);
    match.status = "running";
    match.error = undefined;
    match.currentPlayerId = undefined;
    const resuming = match.history.length > 0 || Boolean(match.pendingTurn);
    const state = this.runtime.get(id);
    if (!this.persistCheckpoint(match, game, state)) {
      this.runs.delete(id);
      return match;
    }
    this.emit(match, resuming ? "match.resumed" : "match.started", resuming ? "Match resumed" : "Match started");
    running.done = this.run(id, game, running);
    void running.done.catch((error: unknown) => {
      const current = this.get(id);
      if (!current) return;
      current.status = "error";
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
    const match = this.require(id);
    const running = this.runs.get(id);
    if (running && match.status === "running") {
      await this.cancel(id, running, "stop");
      return;
    }
    if (["ready", "paused", "interrupted", "running"].includes(match.status)) {
      match.status = "stopped";
      match.currentPlayerId = undefined;
      match.error = undefined;
      match.updatedAt = new Date().toISOString();
      this.onChange(match);
      this.emit(match, "match.stopped", match.pendingTurn
        ? "Match stopped before resuming. The saved position and the retained in-flight attempt are kept for the record."
        : "Match stopped before a controller was attached. The saved position is retained.");
      return;
    }
  }

  async shutdown(): Promise<void> {
    const active = this.active();
    if (active?.status === "running") {
      try { await this.pause(active.id); }
      catch { /* Continue shutdown even if the checkpoint fails. */ }
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
  }

  private persistCheckpoint(match: MatchRecord, game: GameDefinition<unknown>, state: unknown): boolean {
    try {
      this.persistState(match, game, state);
      return true;
    } catch (error) {
      match.status = "error";
      match.error = `Could not save match state: ${error instanceof Error ? error.message : "storage failure"}. No further move was requested.`;
      match.currentPlayerId = undefined;
      try { this.emit(match, "agent.error", match.error); }
      catch { /* Streaming is best-effort when the store is unavailable. */ }
      return false;
    }
  }

  private require(id: string): MatchRecord {
    const match = this.get(id);
    if (!match) throw new Error("Match not found.");
    return match;
  }

  private emit(match: MatchRecord, type: string, text: string, payload?: Record<string, unknown>, playerId?: string): void {
    match.revision = (match.revision ?? 0) + 1;
    const event: MatchEvent = {
      at: new Date().toISOString(),
      type,
      text,
      sequence: match.revision,
      ...(playerId ? { playerId } : {}),
      ...(payload ? { payload } : {}),
    };
    match.events.push(event);
    if (match.events.length > 500) match.events.splice(0, match.events.length - 500);
    match.updatedAt = event.at;
    this.onChange(match, event);
  }

  private save(): void {
    this.onChange(this.records[0] ?? ({} as MatchRecord));
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
        } catch (error) {
          const message = error instanceof Error ? error.message : "The agent could not initialize.";
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
          const result = game.result(state);
          this.finish(match, game, state, result ?? { kind: "draw", notation: "1/2-1/2", reason: "Game ended without a result." });
          return;
        }
        const budgetReason = this.budgetStopReason(match, game, state);
        if (budgetReason) { this.budgetStop(match, budgetReason); return; }
        const playerId = game.currentPlayer(state);
        if (!playerId) throw new Error("The game has no current player but is not terminal.");
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
          const startedAt = new Date().toISOString();
          this.emit(match, "agent.started", `${seat.agent.name} request ${attemptNumber}`, { turnId, attempt: attemptNumber }, playerId);
          let reply: Awaited<ReturnType<typeof adapter.act>> | undefined;
          let failure: unknown;
          const control = new AbortController();
          running.inFlight.add(control);
          try {
            const attemptObservation = feedback ? { ...observation, feedback } : observation;
            reply = await this.invokeWithTimeout(adapter, attemptObservation, control);
          } catch (error) { failure = error; }
          finally {
            running.inFlight.delete(control);
            await adapter.shutdown();
          }

          if (running.control !== "continue") {
            attempts.push(this.attempt(attemptNumber, startedAt, "cancelled", {
              phase: "controller",
              ...(failure instanceof AgentExecutionError ? { error: failure.message, responseExcerpt: failure.responseExcerpt, stderrExcerpt: failure.stderrExcerpt, latencyMs: failure.latencyMs } : {}),
              ...(reply ? { latencyMs: reply.latencyMs, responseExcerpt: reply.responseExcerpt, stderrExcerpt: reply.stderrExcerpt, toolCalls: reply.toolCalls, usage: reply.usage } : {}),
            }));
            break;
          }

          if (failure instanceof AgentExecutionError && !failure.timedOut) {
            attempts.push(this.attempt(attemptNumber, startedAt, "error", { phase: "provider", error: failure.message, responseExcerpt: failure.responseExcerpt, stderrExcerpt: failure.stderrExcerpt, latencyMs: failure.latencyMs }));
            const record = this.turnRecord(match, game, seat, turnId, observation, attempts, false);
            match.history.push(record);
            match.pendingTurn = undefined;
            match.status = "error";
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
            attempts.push(this.attempt(attemptNumber, startedAt, "invalid", {
              phase: "protocol", error: failure.message, responseExcerpt: failure.responseExcerpt,
              latencyMs: failure.latencyMs, stderrExcerpt: failure.stderrExcerpt,
              toolCalls: failure.toolCalls, usage: failure.usage,
            }));
          } else if (failure instanceof AgentExecutionError && failure.timedOut) {
            validation = { valid: false, reason: failure.message };
            this.emit(match, "agent.response", `${seat.agent.name} request timed out`, { turnId, attempt: attemptNumber, status: "timeout" }, playerId);
            attempts.push(this.attempt(attemptNumber, startedAt, "timeout", { phase: "provider", error: failure.message, responseExcerpt: failure.responseExcerpt, stderrExcerpt: failure.stderrExcerpt, latencyMs: failure.latencyMs }));
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
            attempts.push(this.attempt(attemptNumber, startedAt, validation.valid ? "valid" : "invalid", {
              completedAt: new Date().toISOString(),
              latencyMs: reply.latencyMs,
              action,
              ...(validation.reason ? { error: validation.reason } : {}),
              responseExcerpt: reply.responseExcerpt,
              stderrExcerpt: reply.stderrExcerpt,
              toolCalls: reply.toolCalls,
              usage: reply.usage,
            }));
          } else {
            attempts.push(this.attempt(attemptNumber, startedAt, "error", { phase: "controller", error: failure instanceof Error ? failure.message : "Unknown agent failure." }));
            match.history.push(this.turnRecord(match, game, seat, turnId, observation, attempts, false));
            match.pendingTurn = undefined;
            match.status = "error";
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
          if (!this.persistCheckpoint(match, game, state)) return;
          this.emit(match, "move.rejected", `${seat.agent.name}: ${feedback}`, { turnId, attempt: attemptNumber, action: action ?? null, error: feedback }, playerId);
          if (attemptNumber <= match.settings.maxRetries) this.emit(match, "turn.retry", "Returning the rejection reason and same authoritative position for one retry", { turnId, retry: attemptNumber }, playerId);
        }

        if (running.control !== "continue") {
          if (match.pendingTurn) match.pendingTurn.feedback = feedback;
          this.persistCheckpoint(match, game, state);
          break;
        }

        if (!selectedAction) {
          const record = this.turnRecord(match, game, seat, turnId, observation, attempts, false);
          match.history.push(record);
          match.pendingTurn = undefined;
          const winnerId = match.players.find((player) => player.id !== playerId)?.id;
          this.emit(match, "move.rejected", `${seat.agent.name} exhausted its retry after: ${feedback ?? "no valid action"}`, { turnId, retryCount: attempts.length - 1 }, playerId);
          if (!winnerId) throw new Error("The game did not provide an opposing player for forfeiture.");
          this.finish(match, game, state, game.winResult(winnerId, `${seat.label} forfeited after retry exhaustion: ${feedback ?? "invalid action"}`), "forfeit");
          return;
        }

        const after = game.applyAction(state, playerId, selectedAction);
        state = after;
        this.runtime.set(id, state);
        match.pendingTurn = undefined;
        const afterSnapshot = game.serialize(state);
        const record = this.turnRecord(match, game, seat, turnId, observation, attempts, true);
        record.action = selectedAction;
        record.actionLabel = game.actionLabel(selectedAction);
        const afterObject = afterSnapshot && typeof afterSnapshot === "object" ? afterSnapshot as Record<string, unknown> : {};
        if (typeof afterObject.fen === "string") record.fenAfter = afterObject.fen;
        record.latencyMs = attempts.reduce((total, attempt) => total + (attempt.latencyMs ?? 0), 0);
        record.retryCount = Math.max(0, attempts.length - 1);
        match.history.push(record);
        this.emit(match, "move.applied", `${seat.agent.name} played ${record.actionLabel}`, {
          turnId, ply, action: selectedAction, actionLabel: record.actionLabel,
          fenBefore, ...game.eventProjection(state),
        }, playerId);
        this.emit(match, "turn.completed", `${seat.agent.name} completed ply ${ply}`, {
          turnId, turnIndex, ply, latencyMs: record.latencyMs, retryCount: record.retryCount,
          toolCalls: attempts.reduce((sum, attempt) => sum + (attempt.toolCalls ?? 0), 0),
          inputTokens: totalUsage(attempts, "inputTokens"), outputTokens: totalUsage(attempts, "outputTokens"),
          record,
        }, playerId);
        if (!this.persistCheckpoint(match, game, state)) return;

        if (game.isTerminal(state)) {
          this.finish(match, game, state, game.result(state) ?? { kind: "draw", notation: "1/2-1/2", reason: "Game ended without a result." });
          return;
        }
      }

      if (running.control === "pause") {
        match.status = "paused";
        match.currentPlayerId = undefined;
        this.emit(match, "match.paused", "Match paused at a saved turn boundary. Resume to request the current player's move again.");
      } else if (running.control === "stop") {
        match.status = "stopped";
        match.currentPlayerId = undefined;
        this.emit(match, "match.stopped", "Match stopped. The current position and telemetry are saved.");
      }
      try { this.onChange(match); }
      catch { /* The pause/stop checkpoint is best-effort; the in-memory state is already settled. */ }
    } catch (error) {
      match.status = "error";
      match.error = error instanceof Error ? error.message : "Unexpected match controller failure.";
      match.currentPlayerId = undefined;
      match.pendingTurn = undefined;
      this.emit(match, "agent.error", match.error);
      try { this.persistState(match, game, state); }
      catch { /* A storage failure already ended the match; do not rethrow. */ }
    } finally {
      await Promise.all([...running.agents.values()].map((agent) => agent.shutdown()));
      if (this.runs.get(id) === running) this.runs.delete(id);
    }
  }

  private budgetStopReason(match: MatchRecord, game: GameDefinition<unknown>, state: unknown): string | undefined {
    const budgets = match.settings.budgets;
    const plies = game.plyCount(state);
    if (plies >= budgets.maxPlies) return `maximum plies (${budgets.maxPlies}) reached`;
    const requests = matchRequests(match);
    if (requests >= budgets.maxRequests) return `maximum requests (${budgets.maxRequests}) reached`;
    const wallMinutes = (Date.now() - Date.parse(match.createdAt)) / 60_000;
    if (wallMinutes >= budgets.maxWallMinutes) return `maximum wall time (${budgets.maxWallMinutes} min) reached`;
    if (budgets.maxReportedCostUsd !== null) {
      const cost = matchReportedCost(match);
      if (cost !== null && cost >= budgets.maxReportedCostUsd) return `reported cost threshold ($${budgets.maxReportedCostUsd}) reached`;
    }
    return undefined;
  }

  private budgetStop(match: MatchRecord, reason: string): void {
    match.status = "stopped";
    match.currentPlayerId = undefined;
    match.pendingTurn = undefined;
    match.error = `Budget reached: ${reason}. No further request was made.`;
    match.updatedAt = new Date().toISOString();
    this.emit(match, "match.stopped", `Stopped: ${match.error}`, { reason: "budget" });
    try { this.onChange(match); }
    catch { /* The in-memory stop is already settled. */ }
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
  ): Promise<Awaited<ReturnType<AgentAdapter["act"]>>> {
    const actPromise = adapter.act(observation, { signal: control.signal });
    const timeoutError = new AgentExecutionError(`Move timed out after ${Math.ceil(observation.clock.turnTimeoutMs / 1000)} seconds.`, true);
    let primary: NodeJS.Timeout | undefined;
    let hard: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      primary = setTimeout(() => {
        control.abort(timeoutError);
        actPromise.then(() => reject(timeoutError), () => reject(timeoutError));
      }, observation.clock.turnTimeoutMs);
      hard = setTimeout(() => reject(timeoutError), observation.clock.turnTimeoutMs + CANCELLATION_HARD_GRACE_MS);
    });
    try {
      return await Promise.race([actPromise, timeout]);
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
    this.onChange(match);
  }

  private finish(match: MatchRecord, game: GameDefinition<unknown>, state: unknown, result: MatchResult, status: "finished" | "forfeit" = "finished"): void {
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
    try { this.onChange(match); }
    catch { /* The result is already in memory; a failed final write is surfaced by the server. */ }
  }
}

function totalUsage(attempts: AgentAttempt[], key: "inputTokens" | "outputTokens"): number | null {
  const values = attempts.map((attempt) => attempt.usage[key]).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
