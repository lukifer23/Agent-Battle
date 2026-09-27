export const PROVIDERS = ["codex", "claude", "opencode"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type MatchStatus = "ready" | "running" | "paused" | "finished" | "forfeit" | "stopped" | "error" | "interrupted";

export interface PlayerConfig {
  provider: Provider;
  model: string;
  reasoning?: string;
  name: string;
}

export interface PlayerSeat {
  id: string;
  label: string;
  agent: PlayerConfig;
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
  playerId?: string;
  payload?: Record<string, unknown>;
}

export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface AgentAttempt {
  attempt: number;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  status: "valid" | "invalid" | "timeout" | "error" | "cancelled";
  action?: GameAction;
  error?: string;
  responseExcerpt?: string;
  stderrExcerpt?: string;
  toolCalls: number | null;
  usage: AgentUsage;
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
  };
  gameState: unknown;
  history: TurnTelemetry[];
  events: MatchEvent[];
  currentPlayerId?: string;
  result?: MatchResult;
  error?: string;
}

export interface ProviderInfo {
  provider: Provider;
  installed: boolean;
  executable?: string;
  version?: string;
  defaultModel: string;
}

export interface AppState {
  providers: ProviderInfo[];
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
