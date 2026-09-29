import { inspectExecutionStream } from "./executionEvidence.js";
import { actionOutputSchema } from "./actionOutputSchema.js";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";
import type { AdapterCapabilities, AgentUsage, GameAction, GameObservation, PlayerConfig, Provider, ProviderInfo } from "../shared.js";
import { AgentExecutionError, AgentProtocolError, type AgentAdapter, type AgentReply, type AttemptControl } from "../domain/agent.js";
import { parseActionEnvelope } from "../domain/actions.js";
import { excerpt } from "./diagnostics.js";
import { readBoundedFile, runProcess, terminateProcessGroup } from "./processRunner.js";

interface Invocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Returns the agent response text, which for Codex comes from its output file. */
  readResponse: (stdout: string) => string;
  interpret: (root: { stdout: string; responseText: string }) => InterpreterResult;
}

interface InterpreterResult {
  action?: GameAction;
  usage: AgentUsage;
  toolCalls: number | null;
  providerError?: string;
  protocolError?: string;
  resolvedModel?: string;
  sessionId?: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  latencyMs: number;
  exitCode?: number | null;
}

const commandName: Record<Provider, string> = { codex: "codex", claude: "claude", opencode: "opencode" };
const commandDefault: Record<Provider, string> = {
  codex: "",
  claude: "",
  opencode: "",
};

function locate(command: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Keep searching PATH. */ }
  }
  return undefined;
}

async function smallCommand(executable: string, args: string[], timeoutMs = 5000): Promise<string> {
  try {
    const result = await runProcess({
      executable, args, env: process.env, cwd: os.tmpdir(), timeoutMs, outputLimitBytes: 4096,
    });
    return result.stdout.trim().slice(0, 200);
  } catch {
    return "";
  }
}

export async function detectProviders(): Promise<ProviderInfo[]> {
  return Promise.all((Object.keys(commandName) as Provider[]).map(async (provider) => {
    const executable = locate(commandName[provider]);
    const version = executable ? await smallCommand(executable, ["--version"]) : undefined;
    return {
      provider,
      installed: Boolean(executable),
      ...(executable ? { executable } : {}),
      ...(version ? { version } : {}),
      defaultModel: commandDefault[provider],
    };
  }));
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
    "BATTLE_CODEX_ARGS", "BATTLE_TEST_CONFIG", "BATTLE_TEST_ARGS"]);
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" };
}

function usageCoverage(usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }): "none" | "partial" {
  return usage.inputTokens === null && usage.outputTokens === null && usage.costUsd === null ? "none" : "partial";
}

function parseNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseAction(value: unknown): GameAction | undefined {
  if (typeof value === "string") {
    try { return parseActionEnvelope(JSON.parse(value.trim())); }
    catch { return undefined; }
  }
  return parseActionEnvelope(value);
}

function parseCodexEvents(stdout: string): { usage: AgentUsage; toolCalls: number | null; resolvedModel?: string } {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let toolCalls = 0;
  let sawEvents = false;
  let resolvedModel: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; usage?: Record<string, unknown>; item?: { type?: string }; model?: string };
      if (!event || typeof event !== "object") continue;
      sawEvents = true;
      if (typeof event.model === "string") resolvedModel = event.model;
      if (event.type === "turn.completed" && event.usage) {
        inputTokens = parseNumber(event.usage.input_tokens) ?? inputTokens;
        outputTokens = parseNumber(event.usage.output_tokens) ?? outputTokens;
      }
      if (event.type === "item.started" && event.item && /tool|command|search|mcp/i.test(event.item.type ?? "")) toolCalls += 1;
    } catch { /* JSONL can include non-event diagnostics. */ }
  }
  return { usage: { inputTokens, outputTokens, costUsd: null, coverage: usageCoverage({ inputTokens, outputTokens, costUsd: null }) }, toolCalls: sawEvents ? toolCalls : null, ...(resolvedModel ? { resolvedModel } : {}) };
}

function claudeUsage(envelope: Record<string, unknown>): AgentUsage {
  const usage = isRecord(envelope.usage) ? envelope.usage : {};
  const result: AgentUsage = {
    inputTokens: parseNumber(usage.input_tokens),
    outputTokens: parseNumber(usage.output_tokens),
    costUsd: parseNumber(envelope.total_cost_usd ?? envelope.cost_usd),
    cachedInputTokens: parseNumber(usage.cache_read_input_tokens),
    cacheWriteTokens: parseNumber(usage.cache_creation_input_tokens),
    reasoningTokens: null,
    coverage: "none",
  };
  result.coverage = usageCoverage(result);
  return result;
}

function interpretCodex(root: { stdout: string; responseText: string }): InterpreterResult {
  const metadata = parseCodexEvents(root.stdout);
  const action = tryParseAction(root.responseText);
  return {
    action,
    usage: metadata.usage,
    toolCalls: metadata.toolCalls,
    ...(metadata.resolvedModel ? { resolvedModel: metadata.resolvedModel } : {}),
    ...(action ? {} : { protocolError: "Codex response file did not contain one structured action JSON object." }),
  };
}

function interpretClaude(root: { stdout: string; responseText: string }): InterpreterResult {
  const events: Record<string, unknown>[] = [];
  for (const line of root.responseText.split(/\r?\n/)) {
    try { const event: unknown = JSON.parse(line); if (isRecord(event)) events.push(event); }
    catch { /* A missing complete envelope remains a protocol failure. */ }
  }
  const envelope = [...events].reverse().find((event) => event.type === "result") ?? (events.length === 1 ? events[0] : undefined);
  if (!envelope) return { usage: emptyUsage(), toolCalls: null, protocolError: "Claude output contained no complete result envelope." };
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  // StructuredOutput is the schema response channel, not an external information tool.
  const inventoryKnown = Array.isArray(init?.tools) && init.tools.every((tool) => tool === "StructuredOutput");
  let externalCalls = 0;
  for (const event of events) {
    if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) continue;
    for (const item of event.message.content) if (isRecord(item) && item.type === "tool_use" && item.name !== "StructuredOutput") externalCalls++;
  }
  const modelUsage = isRecord(envelope.modelUsage) ? Object.keys(envelope.modelUsage) : [];
  const resolvedModel = modelUsage.length === 1 ? modelUsage[0] : typeof envelope.model === "string" ? envelope.model : undefined;
  const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : undefined;
  const metadata = { usage: claudeUsage(envelope), toolCalls: externalCalls > 0 ? externalCalls : inventoryKnown && envelope.type === "result" ? 0 : null,
    ...(resolvedModel ? { resolvedModel } : {}), ...(sessionId ? { sessionId } : {}) };
  const subtype = typeof envelope.subtype === "string" ? envelope.subtype : undefined;
  if (envelope.is_error === true || (subtype !== undefined && /error/i.test(subtype))) {
    const reportedErrors = Array.isArray(envelope.errors) ? envelope.errors.filter((item) => typeof item === "string").join("; ") : "";
    const detail = typeof envelope.result === "string" && envelope.result ? `: ${excerpt(envelope.result, 300)}` : reportedErrors ? `: ${excerpt(reportedErrors, 500)}` : "";
    return { ...metadata, providerError: `Claude reported ${subtype ?? "an error"}${detail}` };
  }
  // Claude tool input uses a dedicated transport envelope to avoid root action-field
  // collisions. Unwrap only this exact shape; never repair malformed game actions.
  const structured = envelope.structured_output;
  const action = tryParseAction(isRecord(structured) && Object.keys(structured).length === 1 && "action" in structured ? structured.action : structured ?? envelope.result);
  return { ...metadata, action, ...(action ? {} : { protocolError: "Claude returned no structured action; expected a structured_output or JSON result field." }) };
}

function interpretOpenCode(root: { stdout: string }): InterpreterResult {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  let toolCalls = 0;
  let sawEvents = false;
  let resolvedModel: string | undefined;
  const text: string[] = [];
  for (const line of root.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; tokens?: { input?: number; output?: number }; cost?: number; text?: string; modelID?: string; providerID?: string }; text?: string; modelID?: string; providerID?: string };
      if (!event || typeof event !== "object") continue;
      sawEvents = true;
      const modelID = event.part?.modelID ?? event.modelID;
      const providerID = event.part?.providerID ?? event.providerID;
      if (modelID && providerID) resolvedModel = `${providerID}/${modelID}`;
      if (event.type === "tool_use" || event.type === "tool" || event.part?.type === "tool") toolCalls += 1;
      if (event.part?.type === "step-finish" && event.part.tokens) {
        inputTokens = parseNumber(event.part.tokens.input) ?? inputTokens;
        outputTokens = parseNumber(event.part.tokens.output) ?? outputTokens;
        costUsd = parseNumber(event.part.cost) ?? costUsd;
      }
      if (event.type === "text" || event.part?.type === "text") text.push(event.part?.text ?? event.text ?? "");
    } catch { /* Non-JSON process diagnostics are not an agent response. */ }
  }
  const action = tryParseAction(text.join("").trim());
  return {
    action,
    usage: { inputTokens, outputTokens, costUsd, coverage: usageCoverage({ inputTokens, outputTokens, costUsd }) },
    toolCalls: sawEvents ? toolCalls : null,
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(action ? {} : { protocolError: "OpenCode response did not contain one structured action JSON object." }),
  };
}

function interpretFor(provider: Provider) {
  if (provider === "codex") return interpretCodex;
  if (provider === "claude") return interpretClaude;
  return interpretOpenCode;
}

export function parseStructuredAction(output: string, provider: Provider): GameAction {
  const result = interpretFor(provider)({ stdout: output, responseText: output });
  if (result.providerError) throw new AgentExecutionError(result.providerError, false, excerpt(output));
  if (!result.action) throw new AgentProtocolError(result.protocolError ?? "Agent response was not one structured action JSON object.", excerpt(output));
  return result.action;
}

/** Native structured-output transports receive the schema as CLI arguments, not a second copy in the prompt. */
export function buildPrompt(observation: GameObservation, provider: Provider): string {
  const nativeSchema = provider === "claude" || provider === "codex";
  const body = nativeSchema ? { ...observation, actionSchema: undefined } : observation;
  const contract = nativeSchema
    ? "Return exactly one JSON object in the supplied action schema, with type and payload at the top level. The payload contains only the fields for that action, never another action envelope. Do not include prose or markdown."
    : "Return exactly one JSON object matching observation.actionSchema, with type and payload at the top level. The payload contains only the fields for that action, never another action envelope. Do not include prose or markdown.";
  return [
    "You are an agent playing a turn-based game. The controller is authoritative and validates every action.",
    "Use only the observation below. It is complete for this turn; do not assume memory from earlier turns.",
    contract,
    JSON.stringify({ observation: body }),
  ].join("\n\n");
}

abstract class CliAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly restrictions?: string;
  readonly isolationQualified: boolean = false;
  readonly capabilities: AdapterCapabilities = {
    exactModel: "unavailable", sessionIdentity: "unavailable", streamCompletion: "unavailable", toolInventory: "unavailable",
    toolUse: "unavailable", structuredOutput: "prompt", usage: "unavailable", cost: "unavailable", reasoningRequest: "unavailable",
    effectiveReasoning: "unobserved", cancellation: "observable", isolation: "unqualified",
  };
  private executable?: string;
  private versionCaptured = false;
  private cliVersionLine: string | null = null;
  private readonly activeChildren = new Set<ChildProcess>();
  get observedCliVersion(): string | null { return this.cliVersionLine; }

  constructor(readonly config: PlayerConfig) {
    this.id = `${config.provider}:${config.model || "default"}`;
  }

  async initialize(): Promise<void> {
    this.executable = locate(commandName[this.config.provider]);
    if (!this.executable) throw new AgentExecutionError(`${commandName[this.config.provider]} CLI is not available in PATH.`);
    if (!this.versionCaptured) {
      this.versionCaptured = true;
      const reported = await smallCommand(this.executable, ["--version"]);
      this.cliVersionLine = reported.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
    }
  }

  async act(observation: GameObservation, control: AttemptControl): Promise<AgentReply> {
    if (!this.executable) await this.initialize();
    const workingDirectory = mkdtempSync(join(os.tmpdir(), "agent-battle-player-"));
    try {
      const invocation = this.invocation(observation, workingDirectory);
      const response: ProcessResult = await runProcess({
        executable: this.executable!,
        args: invocation.args,
        env: invocation.env,
        cwd: workingDirectory,
        timeoutMs: observation.clock.turnTimeoutMs,
        signal: control.signal,
        returnNonzeroExit: true,
        onChild: (child) => {
          if (child) {
            this.activeChildren.add(child);
            if (typeof child.pid === "number" && child.pid > 0) control.onSpawn?.(child.pid);
          } else for (const active of this.activeChildren) if (active.exitCode !== null || active.signalCode !== null) this.activeChildren.delete(active);
        },
      });
      const responseText = invocation.readResponse(response.stdout);
      const interpreted = invocation.interpret({ stdout: response.stdout, responseText });
      const execution = inspectExecutionStream(this.config, response.stdout, this.restrictions ?? "unknown");
      // Never let the last identity observation hide a provider model switch.
      if (execution.modelIds.length > 1) interpreted.resolvedModel = undefined;
      if (!execution.streamComplete || execution.unknownEvents) interpreted.toolCalls = interpreted.toolCalls && interpreted.toolCalls > 0 ? interpreted.toolCalls : null;
      if (interpreted.providerError || response.exitCode !== undefined && response.exitCode !== 0) {
        const message = interpreted.providerError ?? `CLI exited with ${response.exitCode}. ${excerpt(response.stderr, 500)}`.trim();
        throw new AgentExecutionError(message, false, excerpt(message), excerpt(response.stderr), response.latencyMs, {
          usage: interpreted.usage, toolCalls: interpreted.toolCalls, resolvedModel: interpreted.resolvedModel, sessionId: interpreted.sessionId, execution,
        });
      }
      if (!interpreted.action) {
        throw new AgentProtocolError(
          interpreted.protocolError ?? "Agent response was not one structured action JSON object.",
          excerpt(interpreted.protocolError ?? "Invalid structured response"),
          response.latencyMs,
          excerpt(response.stderr),
          interpreted.toolCalls,
          interpreted.usage,
          interpreted.resolvedModel,
          interpreted.sessionId,
          execution,
        );
      }
      return {
        action: interpreted.action,
        execution,
        latencyMs: response.latencyMs,
        responseExcerpt: excerpt(JSON.stringify(interpreted.action)),
        stderrExcerpt: excerpt(response.stderr),
        toolCalls: interpreted.toolCalls,
        usage: interpreted.usage,
        ...(interpreted.resolvedModel ? { resolvedModel: interpreted.resolvedModel } : {}),
        ...(interpreted.sessionId ? { sessionId: interpreted.sessionId } : {}),
      };
    } catch (error) {
      if (error instanceof AgentExecutionError) {
        if (error.evidence) throw error;
        // Timeouts/cancellation/output limits may stop halfway through an assistant
        // stream. Keep the failure and timing, never persist partial reasoning text.
        throw new AgentExecutionError(error.message, error.timedOut, "Partial CLI stream withheld.", error.stderrExcerpt, error.latencyMs);
      }
      if (error instanceof AgentProtocolError) throw error;
      throw new AgentExecutionError(error instanceof Error ? error.message : "Unexpected adapter error.");
    } finally {
      for (const child of this.activeChildren) if (child.exitCode !== null || child.signalCode !== null) this.activeChildren.delete(child);
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }

  async shutdown(): Promise<void> {
    const children = [...this.activeChildren];
    this.activeChildren.clear();
    await Promise.all(children.map((child) => terminateProcessGroup(child)));
  }

  protected abstract invocation(observation: GameObservation, workingDirectory: string): Invocation;

  protected getModelArgs(): string[] {
    return this.config.model.trim() ? ["--model", this.config.model.trim()] : [];
  }
}

export class CodexCLIAdapter extends CliAgentAdapter {
  override readonly isolationQualified = false;
  override readonly capabilities: AdapterCapabilities = {
    exactModel: "unavailable", sessionIdentity: "unavailable", streamCompletion: "observable", toolInventory: "unavailable",
    toolUse: "observable", structuredOutput: "native", usage: "observable", cost: "unavailable", reasoningRequest: "requested",
    effectiveReasoning: "unobserved", cancellation: "observable", isolation: "unqualified",
  };
  override readonly restrictions = "Codex read-only sandbox, ephemeral session, approval_policy=never; reported tool calls are rejected and no tool observation is undone.";
  protected invocation(observation: GameObservation, workingDirectory: string): Invocation {
    const schemaPath = join(workingDirectory, "action-schema.json");
    const responsePath = join(workingDirectory, "action.json");
    writeFileSync(schemaPath, JSON.stringify(actionOutputSchema(observation.actionSchema)));
    const reasoning = this.config.reasoning?.trim().toLowerCase();
    const reasoningArgs = reasoning && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning)
      ? ["-c", `model_reasoning_effort=\"${reasoning}\"`]
      : [];
    return {
      args: [
        "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "-c", 'approval_policy="never"',
        "--json", "--output-schema", schemaPath, "--output-last-message", responsePath, "--cd", workingDirectory,
        ...this.getModelArgs(), ...reasoningArgs,
        buildPrompt(observation, "codex"),
      ],
      env: safeEnvironment(),
      readResponse: (stdout) => readBoundedFile(responsePath) ?? stdout,
      interpret: interpretCodex,
    };
  }
}

export class ClaudeCodeAdapter extends CliAgentAdapter {
  override readonly isolationQualified = true;
  override readonly capabilities: AdapterCapabilities = {
    exactModel: "observable", sessionIdentity: "observable", streamCompletion: "observable", toolInventory: "observable",
    toolUse: "observable", structuredOutput: "native", usage: "observable", cost: "observable", reasoningRequest: "requested",
    effectiveReasoning: "unobserved", cancellation: "observable", isolation: "qualified",
  };
  override readonly restrictions = "Claude Code print/safe mode with tools, hooks, discovered settings, MCP and slash commands disabled; no session persistence. OAuth/keychain authentication remains available; this is not OS isolation.";
  protected invocation(observation: GameObservation): Invocation {
    const reasoning = this.config.reasoning?.trim().toLowerCase();
    const effortArgs = reasoning && ["low", "medium", "high", "xhigh", "max"].includes(reasoning) ? ["--effort", reasoning] : [];
    return {
      args: [
        "--print", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify({ type: "object", additionalProperties: false, required: ["action"], properties: { action: actionOutputSchema(observation.actionSchema) } }),
        "--permission-mode", "dontAsk", "--permission-prompts", "none", "--tools", "",
        "--safe-mode", "--strict-mcp-config", "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
        "--disable-slash-commands", "--no-session-persistence",
        "--system-prompt", "You are a game-playing agent. Follow the supplied rules and observation. Maximize your game objective. Submit the requested action in the action field of StructuredOutput.",
        ...effortArgs,
        ...(this.config.model.trim() ? ["--model", this.config.model.trim()] : []),
        buildPrompt(observation, "claude"),
      ],
      // Both --bare and CLAUDE_CODE_SIMPLE suppress OAuth/keychain reads.
      // Safe mode disables customizations while retaining authentication.
      env: { ...safeEnvironment(), CLAUDE_CODE_SIMPLE: "0", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ...(reasoning === "none" ? { MAX_THINKING_TOKENS: "0" } : {}), ...(effortArgs.length ? { CLAUDE_CODE_EFFORT_LEVEL: reasoning } : {}) },
      readResponse: (stdout) => stdout,
      interpret: interpretClaude,
    };
  }
}

function openCodeRestrictedConfig(): string {
  const tools = ["read", "edit", "write", "patch", "bash", "glob", "grep", "list", "task", "webfetch", "websearch", "skill", "question", "todoread", "todowrite"];
  return JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    agent: {
      "agent-battle": {
        mode: "primary",
        tools: { "*": false, ...Object.fromEntries(tools.map((tool) => [tool, false])) },
        permission: {
          "*": "deny",
          read: "deny", edit: "deny", glob: "deny", grep: "deny", list: "deny", bash: "deny", task: "deny",
          external_directory: "deny", webfetch: "deny", websearch: "deny", lsp: "deny", skill: "deny", question: "deny",
        },
      },
    },
  });
}

export class OpenCodeAdapter extends CliAgentAdapter {
  override readonly isolationQualified = true;
  override readonly capabilities: AdapterCapabilities = {
    exactModel: "observable", sessionIdentity: "unavailable", streamCompletion: "observable", toolInventory: "unavailable",
    toolUse: "observable", structuredOutput: "prompt", usage: "observable", cost: "observable", reasoningRequest: "requested",
    effectiveReasoning: "unobserved", cancellation: "observable", isolation: "qualified",
  };
  override readonly restrictions = "OpenCode run with --pure and a per-invocation agent that denies all built-in and custom tools; not a general account/config isolation boundary.";
  protected invocation(observation: GameObservation, workingDirectory: string): Invocation {
    const env = safeEnvironment();
    env.OPENCODE_CONFIG_CONTENT = openCodeRestrictedConfig();
    const modelArgs = this.config.model.trim() ? ["--model", this.config.model.trim()] : [];
    const reasoning = this.config.reasoning?.trim();
    const variantArgs = reasoning ? ["--variant", reasoning] : [];
    return {
      args: ["run", "--format", "json", "--pure", "--agent", "agent-battle", "--dir", workingDirectory, ...modelArgs, ...variantArgs, buildPrompt(observation, "opencode")],
      env,
      readResponse: (stdout) => stdout,
      interpret: interpretOpenCode,
    };
  }
}

export function agentRegistryDefaults() {
  return {
    codex: (config: PlayerConfig) => new CodexCLIAdapter(config),
    claude: (config: PlayerConfig) => new ClaudeCodeAdapter(config),
    opencode: (config: PlayerConfig) => new OpenCodeAdapter(config),
  };
}
