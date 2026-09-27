import { PROVIDERS, type AgentAttempt, type AgentUsage, type MatchEnvironment, type MatchRecord, type MatchStatus, type PendingTurn, type PlayerSeat, type Provider, type TurnTelemetry } from "../shared.js";

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
  if (!isFiniteNumber(raw.attempt) || raw.attempt < 1) return { error: "attempt number is invalid" };
  if (!isIsoDate(raw.startedAt)) return { error: "attempt start time is invalid" };
  const status = raw.status;
  if (!["valid", "invalid", "timeout", "error", "cancelled"].includes(status as string)) return { error: "attempt status is unsupported" };
  return {
    value: {
      attempt: raw.attempt,
      startedAt: raw.startedAt,
      ...(isIsoDate(raw.completedAt) ? { completedAt: raw.completedAt } : {}),
      ...(isFiniteNumber(raw.latencyMs) ? { latencyMs: raw.latencyMs } : {}),
      status: status as AgentAttempt["status"],
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
  return { adapterVersion: raw.adapterVersion, promptVersion: raw.promptVersion, toolSchemaVersion: raw.toolSchemaVersion, cliVersions };
}

function validatePendingTurn(raw: unknown): ValidationResult<PendingTurn> {
  if (!isPlainObject(raw)) return { error: "pending turn is not an object" };
  if (!isString(raw.turnId) || !isString(raw.playerId)) return { error: "pending turn identity is invalid" };
  if (!isFiniteNumber(raw.turnIndex) || !isFiniteNumber(raw.ply)) return { error: "pending turn numbering is invalid" };
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
      turnIndex: raw.turnIndex,
      ply: raw.ply,
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
  if (!isFiniteNumber(raw.ply)) return { error: "turn numbering is invalid (missing ply)" };
  const turnIndex = isFiniteNumber(raw.turnIndex) ? raw.turnIndex : index + 1;
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
      ply: raw.ply,
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
  if (!isIsoDate(raw.createdAt) || !isIsoDate(raw.updatedAt)) return { error: "timestamps are invalid" };
  if (!MATCH_STATUSES.includes(raw.status as MatchStatus)) return { error: `status "${String(raw.status)}" is unsupported` };
  if (!Array.isArray(raw.players) || raw.players.length !== 2) return { error: "exactly two participants are required" };
  const players = raw.players.map(validatePlayer);
  if (players.some((player) => player.error || !player.value)) return { error: players.find((player) => player.error)?.error ?? "participant is invalid" };
  if (!isPlainObject(raw.settings)) return { error: "settings are missing" };
  const settings = raw.settings;
  if (!isFiniteNumber(settings.turnTimeoutSeconds) || settings.turnTimeoutSeconds <= 0) return { error: "turn timeout is invalid" };
  if (!isFiniteNumber(settings.maxRetries) || settings.maxRetries < 0) return { error: "max retries is invalid" };
  if (raw.gameState === undefined || raw.gameState === null) return { error: "game state is missing" };
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
  const status = raw.status as MatchStatus;
  if (typeof raw.currentPlayerId === "string" && !playerIds.includes(raw.currentPlayerId)) return { error: "current player is not a participant" };
  if (result?.winnerId && !playerIds.includes(result.winnerId)) return { error: "result winner is not a participant" };
  if ((status === "finished" || status === "forfeit") && !result) return { error: `${status} match has no result` };
  if (status === "forfeit" && result?.kind !== "win") return { error: "forfeit result must be a win" };
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

  return {
    value: {
      id: raw.id,
      gameId: raw.gameId,
      gameVersion: raw.gameVersion,
      protocolVersion: raw.protocolVersion,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      status,
      players: players.map((player) => player.value!) as [PlayerSeat, PlayerSeat],
      settings: {
        turnTimeoutSeconds: settings.turnTimeoutSeconds,
        maxRetries: settings.maxRetries,
        retryPolicy: "retry-invalid-once-then-forfeit",
        promptVersion: isString(settings.promptVersion) ? settings.promptVersion : "legacy",
        toolSchemaVersion: isString(settings.toolSchemaVersion) ? settings.toolSchemaVersion : "legacy",
        resultPolicy: "engine-terminal-with-arena-adjudication",
        budgets: {
          maxPlies: isFiniteNumber((settings.budgets as { maxPlies?: unknown } | undefined)?.maxPlies) ? (settings.budgets as { maxPlies: number }).maxPlies : 150,
          maxRequests: isFiniteNumber((settings.budgets as { maxRequests?: unknown } | undefined)?.maxRequests) ? (settings.budgets as { maxRequests: number }).maxRequests : 200,
          maxWallMinutes: isFiniteNumber((settings.budgets as { maxWallMinutes?: unknown } | undefined)?.maxWallMinutes) ? (settings.budgets as { maxWallMinutes: number }).maxWallMinutes : 30,
          maxReportedCostUsd: isFiniteNumber((settings.budgets as { maxReportedCostUsd?: unknown } | undefined)?.maxReportedCostUsd) ? (settings.budgets as { maxReportedCostUsd: number }).maxReportedCostUsd : null,
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
    },
  };
}

export function validateStoreEnvelope(root: unknown): { version: number; records: unknown[] } {
  if (Array.isArray(root)) return { version: 1, records: root };
  if (isPlainObject(root) && Array.isArray(root.matches)) {
    const version = isFiniteNumber(root.version) ? root.version : 1;
    return { version, records: root.matches };
  }
  throw new Error("Saved store must be an array of matches or a versioned envelope with a matches array.");
}
