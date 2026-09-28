export const PROVIDERS = ["codex", "claude", "opencode"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type MatchStatus = "ready" | "running" | "paused" | "finished" | "forfeit" | "stopped" | "error" | "interrupted";

export interface PlayerConfig {
  provider: Provider;
  model: string;
  reasoning?: string;
  name: string;
  /** Model actually resolved by the provider, when it reports one; otherwise unknown. */
  resolvedModel?: string;
}

export interface PlayerSeat {
  id: string;
  label: string;
  agent: PlayerConfig;
}

export interface MatchBudgets {
  maxPlies: number;
  maxRequests: number;
  maxWallMinutes: number;
  maxReportedCostUsd: number | null;
  maxRequestsPerPlayer?: number;
  maxActiveMinutesPerPlayer?: number;
}

/** New matches measure execution time; older records without this field retain creation-age semantics. */
export interface MatchTimeAccounting {
  mode: "active-runtime-v1";
  elapsedMs: number;
  runningSince?: string;
}

export interface MatchEnvironment {
  adapterVersion: string;
  promptVersion: string;
  toolSchemaVersion: string;
  cliVersions: Partial<Record<Provider, string>>;
  noToolsPlayerIds?: string[];
}

export function competitorId(config: PlayerConfig): string {
  const model = config.resolvedModel?.trim() || config.model.trim() || "cli-default";
  const reasoning = config.reasoning?.trim().toLowerCase() || "default";
  return `${config.provider}::${model}::${reasoning}`;
}

/** A comparison needs two named models; CLI defaults cannot establish distinct identities. */
export function explicitModelId(model: string): boolean {
  return Boolean(model.trim()) && !/^(CLI configured default|CLI default|default)$/i.test(model.trim());
}

export function distinctExplicitModels(a: Pick<PlayerConfig, "model">, b: Pick<PlayerConfig, "model">): boolean {
  const first = a.model.trim().toLowerCase();
  const second = b.model.trim().toLowerCase();
  return explicitModelId(first) && explicitModelId(second) && first !== second;
}

export function verifiedDistinctModels(a: PlayerConfig, b: PlayerConfig): boolean {
  return distinctExplicitModels(a, b) && a.resolvedModel === a.model && b.resolvedModel === b.model;
}

export function competitorLabel(config: PlayerConfig): string {
  const model = config.resolvedModel?.trim() || config.model.trim() || "CLI default";
  const reasoning = config.reasoning?.trim();
  return `${config.provider} · ${model}${reasoning ? ` · ${reasoning}` : ""}`;
}

export interface GameAction {
  type: string;
  payload: Record<string, unknown>;
}

export interface GameObservation {
  schemaVersion: string;
  gameId: string;
  matchId: string;
  turnId: string;
  playerId: string;
  playerLabel: string;
  sideToMove: string;
  /** Board half-move number of the move about to be played (1-based). */
  ply: number;
  /** Sequential agent turn within the match (1-based), including non-moving turns. */
  turnIndex: number;
  state: Record<string, unknown>;
  legalActions: GameAction[];
  actionSchema: Record<string, unknown>;
  history: unknown[];
  clock: { turnTimeoutMs: number };
  status: "active";
  feedback?: string;
}

export interface MatchEvent {
  at: string;
  type: string;
  text: string;
  /** Monotonic match revision reached after this event; used for ordered/idempotent client application. */
  sequence?: number;
  playerId?: string;
  payload?: Record<string, unknown>;
}

export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  coverage: "none" | "partial" | "full";
}

export interface ExecutionEvidence {
  version: "execution-evidence-1";
  profileId: string;
  profileHash: string;
  requestedReasoning: string;
  /** CLI acceptance does not prove the backend used the requested setting. */
  effectiveReasoning: null;
  streamComplete: boolean;
  unknownEvents: boolean;
  modelIds: string[];
  toolInventory: string[] | null;
}

export interface AgentAttempt {
  execution?: ExecutionEvidence;
  invocationId?: string;
  deadlineAt?: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  status: "started" | "interrupted" | "valid" | "invalid" | "timeout" | "error" | "cancelled";
  phase?: "initialization" | "provider" | "protocol" | "controller" | "storage" | "qualification";
  resolvedModel?: string;
  sessionId?: string;
  /** Controller-measured provider reservation time when provider latency is unknown. */
  accountedMs?: number;
  action?: GameAction;
  error?: string;
  responseExcerpt?: string;
  stderrExcerpt?: string;
  toolCalls: number | null;
  usage: AgentUsage;
}

export interface PendingTurn {
  turnId: string;
  turnIndex: number;
  ply: number;
  playerId: string;
  startedAt: string;
  feedback?: string;
  attempts: AgentAttempt[];
}

export interface TurnTelemetry {
  matchId: string;
  /** Board half-move number this turn acted on (1-based). */
  ply: number;
  /** Sequential agent turn within the match (1-based). */
  turnIndex: number;
  turnId: string;
  agentId: string;
  model: string;
  provider: Provider;
  reasoning?: string;
  resolvedModel?: string;
  playerId: string;
  playerLabel: string;
  fenBefore?: string;
  legalActionCount: number;
  action?: GameAction;
  actionLabel?: string;
  valid: boolean;
  latencyMs: number | null;
  retryCount: number;
  attempts: AgentAttempt[];
  /** Retained only for older saved match records; new records use compact FEN checkpoints. */
  stateBefore?: unknown;
  stateAfter?: unknown;
  fenAfter?: string;
  timestamp: string;
}

export interface MatchResult {
  kind: "win" | "draw";
  winnerId?: string;
  notation: string;
  reason: string;
}

export interface MatchRecord {
  id: string;
  gameId: string;
  gameVersion: string;
  protocolVersion: string;
  createdAt: string;
  updatedAt: string;
  timeAccounting?: MatchTimeAccounting;
  status: MatchStatus;
  players: [PlayerSeat, PlayerSeat];
  settings: {
    turnTimeoutSeconds: number;
    maxRetries: number;
    retryPolicy: "retry-invalid-once-then-forfeit";
    promptVersion: string;
    toolSchemaVersion: string;
    /** "engine-terminal" uses chess.js automatic draw/termination; arena adjudication adds forfeit/stop/error outcomes. */
    resultPolicy: "engine-terminal-with-arena-adjudication";
    budgets: MatchBudgets;
  };
  gameState: unknown;
  history: TurnTelemetry[];
  events: MatchEvent[];
  environment?: MatchEnvironment;
  currentPlayerId?: string;
  result?: MatchResult;
  error?: string;
  /** Monotonic revision for this record; every event/checkpoint bumps it. */
  revision: number;
  /** Incremented on every accepted start; used to reject stale controller commands. */
  runGeneration?: number;
  /** Durable in-flight turn so a resume keeps rejection feedback and retry budget. */
  pendingTurn?: PendingTurn;
  series?: { id: string; slotId: string; attempt: number; conditionId?: string; blockId?: string; planHash?: string };
}

export interface SeriesSlot {
  id: string;
  ordinal: number;
  gameId: string;
  challengeId: string;
  /** Private until the entire series has completed. */
  challengeSeed?: string;
  roles: Record<string, 0 | 1>;
  matchIds: string[];
  skipped: boolean;
  gameVersion?: string;
  conditionId?: string;
  blockId?: string;
  replicate?: number;
}

export interface SeriesPlanEntry {
  gameId: string;
  gameVersion: string;
  repetitions: number;
  rolePolicy: "alternating";
  challengePolicy: "fixed" | "seeded";
  weight?: number;
}

export interface SeriesPlan { mode: "exploratory" | "strict"; games: SeriesPlanEntry[] }

/** Research conditions do not change the historical v1/v2 tournament contract. */
export interface ResearchCondition {
  id: string;
  label: string;
  gameId: string;
  gameVersion: string;
  /** Shared only by conditions whose generators accept the same challenge seed. */
  challengeGroup: string;
  rolePolicy: "paired" | "alternating";
}

export interface ResearchPlan {
  version: "research-plan-1";
  title: string;
  question: string;
  primaryEndpoint: string;
  practicalEffect: number;
  analysisVersion: "paired-block-bootstrap-1";
  conditions: ResearchCondition[];
  blocks: number;
  replicates: number;
  schedule: "seeded-block-interleaved";
  comparison: { kind: "system-comparison" | "same-model-control"; conditions: [string, string] };
  /** Infrastructure reruns are bounded and every original attempt remains observable. */
  maxSlotRetries: number;
  exclusionPolicy: "report-all-planned-slots";
  stoppingRule: "fixed-sample";
}

export interface SeriesRecord {
  id: string;
  version: "battle-series-1" | "battle-series-2" | "battle-series-3";
  plan?: SeriesPlan;
  researchPlan?: ResearchPlan;
  planHash?: string;
  seedCommitment?: string;
  createdAt: string;
  updatedAt: string;
  status: "ready" | "running" | "paused" | "completed" | "stopped";
  agents: [PlayerConfig, PlayerConfig];
  settings: { turnTimeoutSeconds: number; budgets: MatchBudgets };
  /** Private root for deterministic Hangman challenges. */
  masterSeed: string;
  slots: SeriesSlot[];
  error?: string;
}

export interface PublicSeriesSlot extends Omit<SeriesSlot, "challengeSeed"> {
  challengeSeed?: string;
  status: "pending" | "running" | "scored" | "unscored" | "skipped";
  result?: MatchResult;
  unscoredReasons?: string[];
}

export interface PublicSeries extends Omit<SeriesRecord, "masterSeed" | "slots"> {
  slots: PublicSeriesSlot[];
  aggregate: Record<string, { wins: number; draws: number; losses: number; unscored: number; scored: number; points: number; possiblePoints: number; normalizedPerformance: number | null; roleCounts: Record<string, number>; requests: number; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number;
    coverage: Record<"inputTokens" | "outputTokens" | "costUsd" | "latencyMs", { reported: number; total: number }> }>;
}

/** Allowlisted list DTO. Canonical state and diagnostics never belong here. */
export interface MatchSummary {
  id: string;
  gameId: string;
  gameVersion: string;
  protocolVersion: string;
  createdAt: string;
  updatedAt: string;
  status: MatchStatus;
  players: [PlayerSeat, PlayerSeat];
  revision: number;
  actionCount: number;
  timeControl: { maxMinutes: number; turnSeconds: number; mode: "active" | "legacy" };
  result?: MatchResult;
  seriesId?: string;
  comparison?: { eligible: boolean; reasons: string[] };
}
export interface PublicMatchDetail extends MatchSummary {
  environment?: MatchEnvironment;
  timeAccounting?: MatchTimeAccounting;
  replay?: unknown[];
  gameState: unknown;
  settings: MatchRecord["settings"];
  history: TurnTelemetry[];
  events: MatchEvent[];
  currentPlayerId?: string;
  error?: string;
  pendingTurn?: PendingTurn;
  series?: MatchRecord["series"];
}

export interface ProviderInfo {
  provider: Provider;
  installed: boolean;
  executable?: string;
  version?: string;
  defaultModel: string;
}

export interface AppState {
  epoch?: string;
  stateVersion?: number;
  /** Monotonic snapshot revision: the maximum record revision included. */
  revision: number;
  providers: ProviderInfo[];
  activeMatchId: string | null;
  activeMatch: PublicMatchDetail | null;
  recentMatches: MatchSummary[];
  storage?: { status: "healthy" | "quarantined" | "write_failed"; message: string };
}

export interface ChessMoveRecord {
  ply: number;
  color: "white" | "black";
  san: string;
  uci: string;
  fen: string;
  at: string;
}

export interface ChessSnapshot {
  fen: string;
  pgn: string;
  moves: ChessMoveRecord[];
  resignation?: { playerId: string; at: string };
}
