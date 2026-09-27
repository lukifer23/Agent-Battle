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
}

export interface MatchEnvironment {
  adapterVersion: string;
  promptVersion: string;
  toolSchemaVersion: string;
  cliVersions: Partial<Record<Provider, string>>;
}

export function competitorId(config: PlayerConfig): string {
  const model = config.resolvedModel?.trim() || config.model.trim() || "cli-default";
  const reasoning = config.reasoning?.trim().toLowerCase() || "default";
  return `${config.provider}::${model}::${reasoning}`;
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

export interface AgentAttempt {
  attempt: number;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  status: "valid" | "invalid" | "timeout" | "error" | "cancelled";
  phase?: "initialization" | "provider" | "protocol" | "controller" | "storage";
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
}

export interface ProviderInfo {
  provider: Provider;
  installed: boolean;
  executable?: string;
  version?: string;
  defaultModel: string;
}

export interface AppState {
  /** Monotonic snapshot revision: the maximum record revision included. */
  revision: number;
  providers: ProviderInfo[];
  activeMatchId: string | null;
  activeMatch: MatchRecord | null;
  recentMatches: MatchRecord[];
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
