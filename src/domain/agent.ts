import type { AgentAttempt, GameAction, GameObservation, PlayerConfig } from "../shared.js";

export interface AgentReply {
  action: GameAction;
  latencyMs: number;
  responseExcerpt: string;
  stderrExcerpt: string;
  toolCalls: number | null;
  usage: AgentAttempt["usage"];
  resolvedModel?: string;
}

export interface AttemptControl {
  signal: AbortSignal;
}

export interface AgentAdapter {
  readonly id: string;
  readonly config: PlayerConfig;
  /** Describes the effective per-invocation restrictions as applied, or undefined when unknown. */
  readonly restrictions?: string;
  readonly isolationQualified?: boolean;
  initialize(): Promise<void>;
  act(observation: GameObservation, control: AttemptControl): Promise<AgentReply>;
  shutdown(): Promise<void>;
}

export type AgentFactory = (config: PlayerConfig) => AgentAdapter;

export class AgentRegistry {
  private readonly factories = new Map<string, AgentFactory>();

  register(adapterId: string, factory: AgentFactory): this {
    if (this.factories.has(adapterId)) throw new Error(`An agent adapter named ${adapterId} is already registered.`);
    this.factories.set(adapterId, factory);
    return this;
  }

  create(config: PlayerConfig): AgentAdapter {
    const factory = this.factories.get(config.provider);
    if (!factory) throw new Error(`No adapter is registered for ${config.provider}.`);
    return factory(config);
  }
}

export class AgentProtocolError extends Error {
  constructor(
    message: string,
    readonly responseExcerpt = "",
    readonly latencyMs?: number,
    readonly stderrExcerpt = "",
    readonly toolCalls: number | null = null,
    readonly usage: AgentAttempt["usage"] = { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" },
  ) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

export class AgentExecutionError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
    readonly responseExcerpt = "",
    readonly stderrExcerpt = "",
    readonly latencyMs?: number,
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}
