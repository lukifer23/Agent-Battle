import { makeResearchSeries } from "./researchPlan.js";
import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { makeSeriesV2 } from "./series.js";
import { PROVIDERS, type AgentAttempt, type AgentUsage, type MatchEnvironment, type MatchRecord, type MatchStatus, type PendingTurn, type PlayerSeat, type Provider, type TurnTelemetry } from "../shared.js";
import type { SeriesRecord } from "../shared.js";

export interface ValidationResult<T> {
  value?: T;
  error?: string;
}

export const MATCH_STATUSES: MatchStatus[] = ["ready", "running", "paused", "finished", "forfeit", "stopped", "error", "interrupted"];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDate(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value));
}

function validatePlayer(raw: unknown): ValidationResult<PlayerSeat> {
  if (!isPlainObject(raw)) return { error: "participant is not an object" };
  if (!isString(raw.id) || !raw.id) return { error: "participant id is missing" };
  if (!isString(raw.label) || !raw.label) return { error: "participant label is missing" };
  if (!isPlainObject(raw.agent)) return { error: "participant agent is missing" };
  const agent = raw.agent;
  if (!PROVIDERS.includes(agent.provider as Provider)) return { error: "participant provider is unsupported" };
  if (!isString(agent.model) || !isString(agent.name)) return { error: "participant agent fields are invalid" };
  if (agent.reasoning !== undefined && !isString(agent.reasoning)) return { error: "participant reasoning is invalid" };
  return { value: { id: raw.id, label: raw.label, agent: { provider: agent.provider as Provider, model: agent.model, name: agent.name, ...(isString(agent.reasoning) ? { reasoning: agent.reasoning } : {}), ...(isString(agent.resolvedModel) ? { resolvedModel: agent.resolvedModel } : {}) } } };
}

function validateUsage(raw: unknown): AgentUsage {
  if (!isPlainObject(raw)) return { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" };
  const inputTokens = isFiniteNumber(raw.inputTokens) && raw.inputTokens >= 0 ? raw.inputTokens : null;
  const outputTokens = isFiniteNumber(raw.outputTokens) && raw.outputTokens >= 0 ? raw.outputTokens : null;
  const costUsd = isFiniteNumber(raw.costUsd) && raw.costUsd >= 0 ? raw.costUsd : null;
  const provided = isString(raw.coverage) && ["none", "partial", "full"].includes(raw.coverage) ? (raw.coverage as AgentUsage["coverage"]) : undefined;
  const coverage = provided ?? (inputTokens === null && outputTokens === null && costUsd === null ? "none" : "partial");
  return {
    inputTokens,
    outputTokens,
    costUsd,
    ...(isFiniteNumber(raw.cachedInputTokens) && raw.cachedInputTokens >= 0 ? { cachedInputTokens: raw.cachedInputTokens } : {}),
    ...(isFiniteNumber(raw.cacheWriteTokens) && raw.cacheWriteTokens >= 0 ? { cacheWriteTokens: raw.cacheWriteTokens } : {}),
    ...(isFiniteNumber(raw.reasoningTokens) && raw.reasoningTokens >= 0 ? { reasoningTokens: raw.reasoningTokens } : {}),
    coverage,
  };
}

function validateAttempt(raw: unknown): ValidationResult<AgentAttempt> {
  if (!isPlainObject(raw)) return { error: "attempt is not an object" };
  if (!Number.isSafeInteger(raw.attempt) || (raw.attempt as number) < 1) return { error: "attempt number is invalid" };
  if (!isIsoDate(raw.startedAt)) return { error: "attempt start time is invalid" };
  if (raw.invocationId !== undefined && (!isString(raw.invocationId) || !/^[0-9a-f-]{36}$/.test(raw.invocationId))) return { error: "invocation identity is invalid" };
  if (raw.ledgerState !== undefined && raw.ledgerState !== "reserved" && raw.ledgerState !== "spawned") return { error: "invocation ledger state is invalid" };
  if (raw.ledgerDetail !== undefined && (!isPlainObject(raw.ledgerDetail) || (raw.ledgerDetail.pid !== undefined && (!Number.isSafeInteger(raw.ledgerDetail.pid) || (raw.ledgerDetail.pid as number) <= 0)))) return { error: "invocation ledger detail is invalid" };
  if (raw.deadlineAt !== undefined && !isIsoDate(raw.deadlineAt)) return { error: "invocation deadline is invalid" };
  if (raw.execution !== undefined) {
    const e = raw.execution;
    if (!isPlainObject(e) || e.version !== "execution-evidence-1" || !isString(e.profileId) || e.profileId.length > 100
      || !isString(e.profileHash) || !/^[0-9a-f]{64}$/.test(e.profileHash) || !isString(e.requestedReasoning) || e.requestedReasoning.length > 40
      || e.effectiveReasoning !== null || typeof e.streamComplete !== "boolean" || typeof e.unknownEvents !== "boolean"
      || !Array.isArray(e.modelIds) || e.modelIds.length > 100 || !e.modelIds.every((id) => isString(id) && id.length <= 200)
      || !(e.toolInventory === null || Array.isArray(e.toolInventory) && e.toolInventory.length <= 200 && e.toolInventory.every((tool) => isString(tool) && tool.length <= 200))) return { error: "Invalid execution evidence." };
  }
  const status = raw.status;
  if (!["started", "interrupted", "valid", "invalid", "timeout", "error", "cancelled"].includes(status as string)) return { error: "attempt status is unsupported" };
  if (raw.phase !== undefined && !["initialization", "provider", "protocol", "controller", "storage", "qualification"].includes(String(raw.phase))) return { error: "attempt phase is unsupported" };
  return {
    value: {
      attempt: raw.attempt as number,
      ...(isPlainObject(raw.execution) ? { execution: {
        version: "execution-evidence-1" as const, profileId: raw.execution.profileId as string, profileHash: raw.execution.profileHash as string,
        requestedReasoning: raw.execution.requestedReasoning as string, effectiveReasoning: null,
        streamComplete: raw.execution.streamComplete as boolean, unknownEvents: raw.execution.unknownEvents as boolean,
        modelIds: [...raw.execution.modelIds as string[]], toolInventory: raw.execution.toolInventory === null ? null : [...raw.execution.toolInventory as string[]],
      } } : {}),
      ...(isString(raw.invocationId) ? { invocationId: raw.invocationId } : {}),
      ...(raw.ledgerState === "reserved" || raw.ledgerState === "spawned" ? { ledgerState: raw.ledgerState } : {}),
      ...(isPlainObject(raw.ledgerDetail) && Number.isSafeInteger(raw.ledgerDetail.pid) && (raw.ledgerDetail.pid as number) > 0 ? { ledgerDetail: { pid: raw.ledgerDetail.pid as number } } : {}),
      ...(isIsoDate(raw.deadlineAt) ? { deadlineAt: raw.deadlineAt } : {}),
      startedAt: raw.startedAt,
      ...(isIsoDate(raw.completedAt) ? { completedAt: raw.completedAt } : {}),
      ...(isFiniteNumber(raw.latencyMs) ? { latencyMs: raw.latencyMs } : {}),
      ...(isFiniteNumber(raw.accountedMs) && raw.accountedMs >= 0 ? { accountedMs: raw.accountedMs } : {}),
      ...(isString(raw.resolvedModel) ? { resolvedModel: raw.resolvedModel } : {}),
      ...(isString(raw.sessionId) ? { sessionId: raw.sessionId } : {}),
      status: status as AgentAttempt["status"],
      ...(["initialization", "provider", "protocol", "controller", "storage", "qualification"].includes(String(raw.phase)) ? { phase: raw.phase as AgentAttempt["phase"] } : {}),
      ...(isString(raw.error) ? { error: raw.error } : {}),
      ...(isString(raw.responseExcerpt) ? { responseExcerpt: raw.responseExcerpt } : {}),
      ...(isString(raw.stderrExcerpt) ? { stderrExcerpt: raw.stderrExcerpt } : {}),
      ...(isPlainObject(raw.action) && isString(raw.action.type) && isPlainObject(raw.action.payload) ? { action: { type: raw.action.type, payload: raw.action.payload } } : {}),
      toolCalls: isFiniteNumber(raw.toolCalls) ? raw.toolCalls : null,
      usage: validateUsage(raw.usage),
    },
  };
}

function validateEnvironment(raw: unknown): MatchEnvironment | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (!isString(raw.adapterVersion) || !isString(raw.promptVersion) || !isString(raw.toolSchemaVersion)) return undefined;
  const cliVersions: MatchEnvironment["cliVersions"] = {};
  if (isPlainObject(raw.cliVersions)) {
    for (const provider of PROVIDERS) {
      const version = raw.cliVersions[provider];
      if (isString(version)) cliVersions[provider] = version;
    }
  }
  return { adapterVersion: raw.adapterVersion, promptVersion: raw.promptVersion, toolSchemaVersion: raw.toolSchemaVersion, cliVersions,
    ...(Array.isArray(raw.noToolsPlayerIds) ? { noToolsPlayerIds: raw.noToolsPlayerIds.filter(isString) } : {}) };
}

function validatePendingTurn(raw: unknown): ValidationResult<PendingTurn> {
  if (!isPlainObject(raw)) return { error: "pending turn is not an object" };
  if (!isString(raw.turnId) || !isString(raw.playerId)) return { error: "pending turn identity is invalid" };
  if (!Number.isSafeInteger(raw.turnIndex) || (raw.turnIndex as number) < 1 || !Number.isSafeInteger(raw.ply) || (raw.ply as number) < 1) return { error: "pending turn numbering is invalid" };
  if (!isIsoDate(raw.startedAt)) return { error: "pending turn start time is invalid" };
  if (!Array.isArray(raw.attempts)) return { error: "pending turn attempts are invalid" };
  const attempts: AgentAttempt[] = [];
  for (const [index, attempt] of raw.attempts.entries()) {
    const result = validateAttempt(attempt);
    if (result.error || !result.value) return { error: `pending turn attempt ${index + 1}: ${result.error}` };
    attempts.push(result.value);
  }
  return {
    value: {
      turnId: raw.turnId,
      turnIndex: raw.turnIndex as number,
      ply: raw.ply as number,
      playerId: raw.playerId,
      startedAt: raw.startedAt,
      ...(isString(raw.feedback) ? { feedback: raw.feedback } : {}),
      attempts,
    },
  };
}

function validateTurnTelemetry(raw: unknown, index: number): ValidationResult<TurnTelemetry> {
  if (!isPlainObject(raw)) return { error: "turn record is not an object" };
  if (!isString(raw.matchId) || !isString(raw.turnId) || !isString(raw.playerId)) return { error: "turn identity is invalid" };
  if (!Number.isSafeInteger(raw.ply) || (raw.ply as number) < 1) return { error: "turn numbering is invalid (missing ply)" };
  const turnIndex = Number.isSafeInteger(raw.turnIndex) && (raw.turnIndex as number) > 0 ? raw.turnIndex as number : index + 1;
  if (typeof raw.valid !== "boolean") return { error: "turn validity is invalid" };
  if (!Array.isArray(raw.attempts)) return { error: "turn attempts are invalid" };
  const attempts: AgentAttempt[] = [];
  for (const [index, attempt] of raw.attempts.entries()) {
    const result = validateAttempt(attempt);
    if (result.error || !result.value) return { error: `turn attempt ${index + 1}: ${result.error}` };
    attempts.push(result.value);
  }
  if (!PROVIDERS.includes(raw.provider as Provider)) return { error: "turn provider is unsupported" };
  return {
    value: {
      matchId: raw.matchId,
      ply: raw.ply as number,
      turnIndex,
      turnId: raw.turnId,
      agentId: isString(raw.agentId) ? raw.agentId : "",
      model: isString(raw.model) ? raw.model : "",
      provider: raw.provider as Provider,
      ...(isString(raw.reasoning) ? { reasoning: raw.reasoning } : {}),
      ...(isString(raw.resolvedModel) ? { resolvedModel: raw.resolvedModel } : {}),
      playerId: raw.playerId,
      playerLabel: isString(raw.playerLabel) ? raw.playerLabel : raw.playerId,
      ...(isString(raw.fenBefore) ? { fenBefore: raw.fenBefore } : {}),
      legalActionCount: isFiniteNumber(raw.legalActionCount) ? raw.legalActionCount : 0,
      ...(isPlainObject(raw.action) && isString(raw.action.type) && isPlainObject(raw.action.payload) ? { action: { type: raw.action.type, payload: raw.action.payload } } : {}),
      ...(isString(raw.actionLabel) ? { actionLabel: raw.actionLabel } : {}),
      valid: raw.valid,
      latencyMs: isFiniteNumber(raw.latencyMs) ? raw.latencyMs : null,
      retryCount: isFiniteNumber(raw.retryCount) ? raw.retryCount : 0,
      attempts,
      ...(isString(raw.fenAfter) ? { fenAfter: raw.fenAfter } : {}),
      timestamp: isIsoDate(raw.timestamp) ? raw.timestamp : new Date().toISOString(),
    },
  };
}

export function validateMatchRecord(raw: unknown): ValidationResult<MatchRecord> {
  if (!isPlainObject(raw)) return { error: "record is not an object" };
  if (!isString(raw.id) || !raw.id) return { error: "id is missing" };
  if (!isString(raw.gameId) || !raw.gameId) return { error: "gameId is missing" };
  if (!isString(raw.gameVersion) || !isString(raw.protocolVersion)) return { error: "version fields are missing" };
  if (raw.protocolVersion !== "game-action-v1") return { error: "protocol version is unsupported" };
  if (!isIsoDate(raw.createdAt) || !isIsoDate(raw.updatedAt)) return { error: "timestamps are invalid" };
  if (raw.timeAccounting !== undefined) {
    if (!isPlainObject(raw.timeAccounting) || raw.timeAccounting.mode !== "active-runtime-v1"
      || !Number.isSafeInteger(raw.timeAccounting.elapsedMs) || (raw.timeAccounting.elapsedMs as number) < 0
      || (raw.timeAccounting.runningSince !== undefined && !isIsoDate(raw.timeAccounting.runningSince))) {
      return { error: "active time accounting is invalid" };
    }
    if (raw.status !== "running" && raw.timeAccounting.runningSince !== undefined) return { error: "non-running match has an open active timer" };
  }
  if (!MATCH_STATUSES.includes(raw.status as MatchStatus)) return { error: `status "${String(raw.status)}" is unsupported` };
  if (!Array.isArray(raw.players) || raw.players.length !== 2) return { error: "exactly two participants are required" };
  const players = raw.players.map(validatePlayer);
  if (players.some((player) => player.error || !player.value)) return { error: players.find((player) => player.error)?.error ?? "participant is invalid" };
  if (!isPlainObject(raw.settings)) return { error: "settings are missing" };
  const settings = raw.settings;
  if (!Number.isSafeInteger(settings.turnTimeoutSeconds) || (settings.turnTimeoutSeconds as number) < 30 || (settings.turnTimeoutSeconds as number) > 600) return { error: "turn timeout is invalid" };
  if (!Number.isSafeInteger(settings.maxRetries) || (settings.maxRetries as number) < 0 || (settings.maxRetries as number) > 10) return { error: "max retries is invalid" };
  if (settings.budgets !== undefined) {
    if (!isPlainObject(settings.budgets)) return { error: "budgets are invalid" };
    for (const key of ["maxPlies", "maxRequests", "maxWallMinutes"] as const) {
      const value = settings.budgets[key];
      if (!Number.isSafeInteger(value) || (value as number) < 1) return { error: `${key} budget is invalid` };
    }
    const cost = settings.budgets.maxReportedCostUsd;
    if (cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return { error: "reported cost budget is invalid" };
    for (const key of ["maxRequestsPerPlayer", "maxActiveMinutesPerPlayer"] as const) {
      const value = settings.budgets[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) return { error: `${key} budget is invalid` };
    }
  }
  if (raw.gameState === undefined || raw.gameState === null) return { error: "game state is missing" };
  if (raw.series !== undefined && (!isPlainObject(raw.series) || !isString(raw.series.id) || !isString(raw.series.slotId)
    || !Number.isSafeInteger(raw.series.attempt) || (raw.series.attempt as number) < 1)) return { error: "series linkage is invalid" };
  if (isPlainObject(raw.series) && ["conditionId", "blockId", "planHash"].some((key) => raw.series && (raw.series as Record<string, unknown>)[key] !== undefined)
    && (!isString(raw.series.conditionId) || !isString(raw.series.blockId) || !isString(raw.series.planHash) || !/^[0-9a-f]{64}$/.test(raw.series.planHash))) return { error: "research linkage is invalid" };
  if (!Array.isArray(raw.history)) return { error: "history is missing" };
  const history: TurnTelemetry[] = [];
  for (const [index, turn] of raw.history.entries()) {
    const result = validateTurnTelemetry(turn, index);
    if (result.error || !result.value) return { error: `history turn ${index + 1}: ${result.error}` };
    history.push(result.value);
  }
  if (!Array.isArray(raw.events)) return { error: "events are missing" };
  const events = raw.events.flatMap((event) => {
    if (!isPlainObject(event) || !isIsoDate(event.at) || !isString(event.type) || !isString(event.text)) return [];
    return [{ at: event.at, type: event.type, text: event.text, ...(isFiniteNumber(event.sequence) ? { sequence: event.sequence } : {}), ...(isString(event.playerId) ? { playerId: event.playerId } : {}), ...(isPlainObject(event.payload) ? { payload: event.payload } : {}) }];
  });

  let result: MatchRecord["result"];
  if (raw.result !== undefined) {
    if (!isPlainObject(raw.result)) return { error: "result is invalid" };
    if (raw.result.kind !== "win" && raw.result.kind !== "draw") return { error: "result kind is invalid" };
    if (!isString(raw.result.notation) || !isString(raw.result.reason)) return { error: "result fields are invalid" };
    if (raw.result.winnerId !== undefined && !isString(raw.result.winnerId)) return { error: "result winner is invalid" };
    result = { kind: raw.result.kind, notation: raw.result.notation, reason: raw.result.reason, ...(isString(raw.result.winnerId) ? { winnerId: raw.result.winnerId } : {}) };
  }

  const playerIds = players.map((player) => player.value!.id);
  if (new Set(playerIds).size !== playerIds.length) return { error: "participant ids are duplicated" };
  const status = raw.status as MatchStatus;
  if (typeof raw.currentPlayerId === "string" && !playerIds.includes(raw.currentPlayerId)) return { error: "current player is not a participant" };
  if (result?.winnerId && !playerIds.includes(result.winnerId)) return { error: "result winner is not a participant" };
  if ((status === "finished" || status === "forfeit") && !result) return { error: `${status} match has no result` };
  if (status === "forfeit" && result?.kind !== "win") return { error: "forfeit result must be a win" };
  if (status === "forfeit" && !history.some((turn) => !turn.valid && turn.playerId !== result?.winnerId && turn.attempts.length > 0)) return { error: "forfeit has no losing attempt evidence" };
  if (status === "stopped" && result) return { error: "stopped match must not have a result" };
  if (["ready", "running", "paused", "interrupted"].includes(status) && result) return { error: `${status} match must not have a result` };

  let pendingTurn: PendingTurn | undefined;
  if (raw.pendingTurn !== undefined) {
    const pendingResult = validatePendingTurn(raw.pendingTurn);
    if (pendingResult.error || !pendingResult.value) return { error: pendingResult.error ?? "pending turn is invalid" };
    if (!playerIds.includes(pendingResult.value.playerId)) return { error: "pending turn player is not a participant" };
    pendingTurn = pendingResult.value;
  }

  const environment = validateEnvironment(raw.environment);
  if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0)) return { error: "revision is invalid" };
  if (raw.runGeneration !== undefined && (!Number.isSafeInteger(raw.runGeneration) || (raw.runGeneration as number) < 0)) return { error: "run generation is invalid" };

  return {
    value: {
      id: raw.id,
      gameId: raw.gameId,
      gameVersion: raw.gameVersion,
      protocolVersion: raw.protocolVersion,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(isPlainObject(raw.timeAccounting) ? { timeAccounting: {
        mode: "active-runtime-v1" as const,
        elapsedMs: raw.timeAccounting.elapsedMs as number,
        ...(isString(raw.timeAccounting.runningSince) ? { runningSince: raw.timeAccounting.runningSince } : {}),
      } } : {}),
      status,
      players: players.map((player) => player.value!) as [PlayerSeat, PlayerSeat],
      settings: {
        turnTimeoutSeconds: settings.turnTimeoutSeconds as number,
        maxRetries: settings.maxRetries as number,
        retryPolicy: "retry-invalid-once-then-forfeit",
        promptVersion: isString(settings.promptVersion) ? settings.promptVersion : "legacy",
        toolSchemaVersion: isString(settings.toolSchemaVersion) ? settings.toolSchemaVersion : "legacy",
        resultPolicy: "engine-terminal-with-arena-adjudication",
        budgets: {
          maxPlies: isFiniteNumber((settings.budgets as { maxPlies?: unknown } | undefined)?.maxPlies) ? (settings.budgets as { maxPlies: number }).maxPlies : 150,
          maxRequests: isFiniteNumber((settings.budgets as { maxRequests?: unknown } | undefined)?.maxRequests) ? (settings.budgets as { maxRequests: number }).maxRequests : 200,
          maxWallMinutes: isFiniteNumber((settings.budgets as { maxWallMinutes?: unknown } | undefined)?.maxWallMinutes) ? (settings.budgets as { maxWallMinutes: number }).maxWallMinutes : 30,
          maxReportedCostUsd: isFiniteNumber((settings.budgets as { maxReportedCostUsd?: unknown } | undefined)?.maxReportedCostUsd) ? (settings.budgets as { maxReportedCostUsd: number }).maxReportedCostUsd : null,
          ...(isFiniteNumber((settings.budgets as { maxRequestsPerPlayer?: unknown } | undefined)?.maxRequestsPerPlayer) ? { maxRequestsPerPlayer: (settings.budgets as { maxRequestsPerPlayer: number }).maxRequestsPerPlayer } : {}),
          ...(isFiniteNumber((settings.budgets as { maxActiveMinutesPerPlayer?: unknown } | undefined)?.maxActiveMinutesPerPlayer) ? { maxActiveMinutesPerPlayer: (settings.budgets as { maxActiveMinutesPerPlayer: number }).maxActiveMinutesPerPlayer } : {}),
        },
      },
      gameState: raw.gameState,
      history,
      events,
      revision: isFiniteNumber(raw.revision) ? raw.revision : 0,
      ...(environment ? { environment } : {}),
      ...(isString(raw.currentPlayerId) ? { currentPlayerId: raw.currentPlayerId } : {}),
      ...(result ? { result } : {}),
      ...(isString(raw.error) ? { error: raw.error } : {}),
      ...(isFiniteNumber(raw.runGeneration) ? { runGeneration: raw.runGeneration } : {}),
      ...(pendingTurn ? { pendingTurn } : {}),
      ...(isPlainObject(raw.series) && isString(raw.series.id) && isString(raw.series.slotId) && Number.isSafeInteger(raw.series.attempt) && (raw.series.attempt as number) >= 1
        ? { series: { id: raw.series.id, slotId: raw.series.slotId, attempt: raw.series.attempt as number, ...(isString(raw.series.conditionId) && isString(raw.series.blockId) && isString(raw.series.planHash) && /^[0-9a-f]{64}$/.test(raw.series.planHash) ? { conditionId: raw.series.conditionId, blockId: raw.series.blockId, planHash: raw.series.planHash } : {}) } } : {}),
    },
  };
}

export function validateSeriesRecord(raw: unknown): SeriesRecord {
  if (isPlainObject(raw) && ["battle-series-2", "battle-series-3"].includes(String(raw.version))) return validateSeriesV2(raw);
  if (!isPlainObject(raw) || raw.version !== "battle-series-1" || !isString(raw.id) || !isIsoDate(raw.createdAt) || !isIsoDate(raw.updatedAt)
    || !["ready", "running", "paused", "completed", "stopped"].includes(String(raw.status))
    || !/^[0-9a-f]{64}$/.test(String(raw.masterSeed)) || !Array.isArray(raw.agents) || raw.agents.length !== 2
    || !isPlainObject(raw.settings) || !Array.isArray(raw.slots) || raw.slots.length !== 10) throw new Error("Invalid battle series record.");
  const agents = raw.agents.map((agent) => validatePlayer({ id: "seat", label: "Seat", agent }));
  if (agents.some((agent) => !agent.value || agent.error || !agent.value.agent.model.trim())) throw new Error("Invalid series agent identity.");
  const settings = raw.settings;
  if (!Number.isSafeInteger(settings.turnTimeoutSeconds) || (settings.turnTimeoutSeconds as number) < 30 || (settings.turnTimeoutSeconds as number) > 600 || !isPlainObject(settings.budgets)) throw new Error("Invalid series settings.");
  const budgets = settings.budgets;
  if (!["maxPlies", "maxRequests", "maxWallMinutes"].every((key) => Number.isSafeInteger(budgets[key]) && (budgets[key] as number) > 0)
    || !(budgets.maxReportedCostUsd === null || isFiniteNumber(budgets.maxReportedCostUsd) && budgets.maxReportedCostUsd >= 0)) throw new Error("Invalid series budgets.");
  const slots = raw.slots.map((slot, ordinal) => {
    if (!isPlainObject(slot) || slot.ordinal !== ordinal || !isString(slot.id) || !isString(slot.challengeId)
      || slot.gameId !== (ordinal < 5 ? "chess" : "hangman") || !isPlainObject(slot.roles)
      || !Array.isArray(slot.matchIds) || !slot.matchIds.every(isString) || typeof slot.skipped !== "boolean") throw new Error("Invalid series slot.");
    const expectedRoles = ordinal < 5 ? ["white", "black"] : ["player1", "player2"];
    if (Object.keys(slot.roles).sort().join() !== [...expectedRoles].sort().join() || slot.roles[expectedRoles[0]] === slot.roles[expectedRoles[1]]
      || ![0, 1].includes(slot.roles[expectedRoles[0]] as number) || ![0, 1].includes(slot.roles[expectedRoles[1]] as number)) throw new Error("Invalid series role schedule.");
    if (slot.roles[expectedRoles[0]] !== (ordinal % 5 % 2 === 0 ? 0 : 1)) throw new Error("Series role balance differs from schedule.");
    if (ordinal >= 5 && !/^[0-9a-f]{64}$/.test(String(slot.challengeSeed))) throw new Error("Invalid series challenge seed.");
    if (ordinal < 5 && slot.challengeSeed !== undefined) throw new Error("Chess slot has a seed.");
    if (ordinal >= 5) {
      const expectedSeed = createHmac("sha256", Buffer.from(raw.masterSeed as string, "hex")).update(`battle-series-1:hangman:${ordinal - 5}`).digest("hex");
      const expectedId = createHash("sha256").update(`hangman:${expectedSeed}`).digest("hex");
      if (slot.challengeSeed !== expectedSeed || slot.challengeId !== expectedId) throw new Error("Series challenge provenance differs from seed.");
    } else if (slot.challengeId !== "standard-start-v1") throw new Error("Invalid Chess challenge ID.");
    return slot as unknown as SeriesRecord["slots"][number];
  });
  if (new Set(slots.map((slot) => slot.id)).size !== 10 || new Set(slots.flatMap((slot) => slot.matchIds)).size !== slots.flatMap((slot) => slot.matchIds).length) throw new Error("Duplicate series slot or match identity.");
  return { id: raw.id, version: "battle-series-1", createdAt: raw.createdAt, updatedAt: raw.updatedAt, status: raw.status as SeriesRecord["status"],
    agents: agents.map((agent) => agent.value!.agent) as SeriesRecord["agents"], settings: { turnTimeoutSeconds: settings.turnTimeoutSeconds as number,
      budgets: { maxPlies: budgets.maxPlies as number, maxRequests: budgets.maxRequests as number, maxWallMinutes: budgets.maxWallMinutes as number, maxReportedCostUsd: budgets.maxReportedCostUsd as number | null } },
    masterSeed: raw.masterSeed as string, slots, ...(isString(raw.error) ? { error: raw.error } : {}) };
}

function validateSeriesV2(raw: Record<string, unknown>): SeriesRecord {
  const research = raw.version === "battle-series-3";
  if (!isString(raw.id) || !isIsoDate(raw.createdAt) || !isIsoDate(raw.updatedAt)
    || !["ready", "running", "paused", "completed", "stopped"].includes(String(raw.status))
    || !/^[0-9a-f]{64}$/.test(String(raw.masterSeed)) || !Array.isArray(raw.agents) || raw.agents.length !== 2
    || !isPlainObject(raw.settings) || (research ? !isPlainObject(raw.researchPlan) || raw.plan !== undefined : !isPlainObject(raw.plan) || !Array.isArray(raw.plan.games))
    || !Array.isArray(raw.slots)) throw new Error("Invalid battle-series-2 record.");
  const agents = raw.agents.map((agent) => validatePlayer({ id: "seat", label: "Seat", agent }));
  if (agents.some((agent) => !agent.value || agent.error || !agent.value.agent.model.trim())) throw new Error("Invalid series agent identity.");
  const settings = raw.settings;
  if (!Number.isSafeInteger(settings.turnTimeoutSeconds) || (settings.turnTimeoutSeconds as number) < 30 || (settings.turnTimeoutSeconds as number) > 600 || !isPlainObject(settings.budgets)) throw new Error("Invalid series settings.");
  const budgets = settings.budgets;
  if (!["maxPlies", "maxRequests", "maxWallMinutes"].every((key) => Number.isSafeInteger(budgets[key]) && (budgets[key] as number) > 0)
    || !(budgets.maxReportedCostUsd === null || isFiniteNumber(budgets.maxReportedCostUsd) && budgets.maxReportedCostUsd >= 0)) throw new Error("Invalid series budgets.");
  const plan = raw.plan as unknown as import("../shared.js").SeriesPlan;
  const validatedAgents = agents.map((agent) => agent.value!.agent) as SeriesRecord["agents"];
  const validatedBudgets = { maxPlies: budgets.maxPlies as number, maxRequests: budgets.maxRequests as number, maxWallMinutes: budgets.maxWallMinutes as number, maxReportedCostUsd: budgets.maxReportedCostUsd as number | null };
  // Rebuild the entire deterministic schedule; only generated IDs and mutable links may differ.
  const expected = research ? makeResearchSeries(validatedAgents, settings.turnTimeoutSeconds as number, validatedBudgets, raw.researchPlan, raw.masterSeed as string) : makeSeriesV2(validatedAgents, settings.turnTimeoutSeconds as number, validatedBudgets, plan, raw.masterSeed as string);
  if (research && (raw.planHash !== expected.planHash || raw.seedCommitment !== expected.seedCommitment)) throw new Error("Research declaration commitment differs from plan.");
  if (expected.slots.length !== raw.slots.length) throw new Error("Series slot count differs from plan.");
  const slots = raw.slots.map((slot, ordinal) => {
    const reference = expected.slots[ordinal];
    if (!isPlainObject(slot) || !isString(slot.id) || slot.ordinal !== ordinal || slot.gameId !== reference.gameId
      || slot.challengeId !== reference.challengeId || slot.challengeSeed !== reference.challengeSeed
      || research && (slot.gameVersion !== reference.gameVersion || slot.conditionId !== reference.conditionId || slot.blockId !== reference.blockId || slot.replicate !== reference.replicate)
      || !isDeepStrictEqual(slot.roles, reference.roles) || !Array.isArray(slot.matchIds) || !slot.matchIds.every(isString)
      || typeof slot.skipped !== "boolean") throw new Error("Series slot differs from deterministic plan.");
    return { ...reference, id: slot.id, matchIds: slot.matchIds as string[], skipped: slot.skipped };
  });
  if (new Set(slots.map((slot) => slot.id)).size !== slots.length || new Set(slots.flatMap((slot) => slot.matchIds)).size !== slots.flatMap((slot) => slot.matchIds).length) throw new Error("Duplicate series identity.");
  return { id: raw.id as string, version: expected.version, ...(research ? { researchPlan: expected.researchPlan, planHash: expected.planHash, seedCommitment: expected.seedCommitment } : { plan }), createdAt: raw.createdAt as string, updatedAt: raw.updatedAt as string, status: raw.status as SeriesRecord["status"], agents: validatedAgents,
    settings: { turnTimeoutSeconds: settings.turnTimeoutSeconds as number, budgets: validatedBudgets }, masterSeed: raw.masterSeed as string, slots, ...(isString(raw.error) ? { error: raw.error } : {}) };
}

export function validateStoreEnvelope(root: unknown): { version: number; records: unknown[]; series: unknown[] } {
  if (Array.isArray(root)) return { version: 1, records: root, series: [] };
  if (isPlainObject(root) && Array.isArray(root.matches)) {
    const version = root.version;
    if (!Number.isSafeInteger(version) || (version as number) < 2 || (version as number) > 7) throw new Error(`Unsupported store version ${String(version)}.`);
    if ((version as number) >= 5 && !Array.isArray(root.series)) throw new Error("Series array is missing.");
    return { version: version as number, records: root.matches, series: (version as number) >= 5 ? root.series as unknown[] : [] };
  }
  throw new Error("Saved store must be an array of matches or a versioned envelope with a matches array.");
}
