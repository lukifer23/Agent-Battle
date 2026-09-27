import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";
import type { AgentUsage, GameAction, GameObservation, PlayerConfig, Provider, ProviderInfo } from "../shared.js";
import { AgentExecutionError, AgentProtocolError, type AgentAdapter, type AgentReply } from "../domain/agent.js";
import { parseActionEnvelope } from "../domain/actions.js";

interface Invocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  readOutput: (stdout: string) => string;
  parseUsage: (stdout: string) => AgentUsage;
  countToolCalls: (stdout: string) => number | null;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  latencyMs: number;
}

const commandName: Record<Provider, string> = { codex: "codex", claude: "claude", opencode: "opencode" };
const commandDefault: Record<Provider, string> = {
  codex: "CLI configured default",
  claude: "CLI configured default",
  opencode: "CLI configured default",
};

function locate(command: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try { accessSync(candidate, constants.X_OK); return candidate; }
    catch { /* Keep searching PATH. */ }
  }
  return undefined;
}

function smallCommand(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    let output = "";
    let outputBytes = 0;
    let hardKill: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The version process may have exited between the check and signal. */ }
    };
    const terminate = () => {
      kill("SIGTERM");
      hardKill ??= setTimeout(() => kill("SIGKILL"), 1500);
      hardKill.unref();
    };
    const timer = setTimeout(terminate, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => {
      const remaining = 4096 - outputBytes;
      if (remaining > 0) output += data.subarray(0, remaining).toString();
      outputBytes += data.length;
      if (outputBytes > 4096) terminate();
    });
    child.on("error", () => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      resolve(output.trim().slice(0, 200));
    });
  });
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
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  delete env.NODE_OPTIONS;
  return env;
}

function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|AIza[\w-]{20,})\b/g, "[redacted token]")
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[redacted]");
}

function excerpt(text: string, limit = 1200): string {
  return redact(text.trim()).slice(0, limit);
}

function parseJsonAction(value: unknown): GameAction | undefined {
  return parseActionEnvelope(value);
}

export function parseStructuredAction(output: string, provider: Provider): GameAction {
  let body = output.trim();
  if (provider === "opencode") {
    const text: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string }; text?: string };
        if (event.type === "text" || event.part?.type === "text") text.push(event.part?.text ?? event.text ?? "");
      } catch { /* Non-JSON process diagnostics are not an agent response. */ }
    }
    body = text.join("").trim();
  } else if (provider === "claude") {
    try {
      const envelope = JSON.parse(output) as { result?: unknown };
      if (typeof envelope.result === "string") body = envelope.result.trim();
    } catch { /* Preserve raw text so the strict parser reports it clearly. */ }
  }

  try {
    const action = parseJsonAction(JSON.parse(body));
    if (action) return action;
  } catch { /* A prose or malformed response is an invalid action, never repaired. */ }
  throw new AgentProtocolError("Agent response was not one structured action JSON object.", excerpt(body));
}

function emptyUsage(): AgentUsage {
  return { inputTokens: null, outputTokens: null, costUsd: null };
}

function parseNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codexMetadata(stdout: string): { usage: AgentUsage; toolCalls: number | null } {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let toolCalls = 0;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; usage?: Record<string, unknown>; item?: { type?: string } };
      if (event.type === "turn.completed" && event.usage) {
        inputTokens = parseNumber(event.usage.input_tokens);
        outputTokens = parseNumber(event.usage.output_tokens);
      }
      if (event.type === "item.started" && event.item && /tool|command|search|mcp/i.test(event.item.type ?? "")) toolCalls += 1;
    } catch { /* JSONL can include non-event diagnostics. */ }
  }
  return { usage: { inputTokens, outputTokens, costUsd: null }, toolCalls };
}

function claudeMetadata(stdout: string): { usage: AgentUsage; toolCalls: number | null } {
  try {
    const envelope = JSON.parse(stdout) as { usage?: Record<string, unknown>; total_cost_usd?: unknown; cost_usd?: unknown };
    return {
      usage: {
        inputTokens: parseNumber(envelope.usage?.input_tokens),
        outputTokens: parseNumber(envelope.usage?.output_tokens),
        costUsd: parseNumber(envelope.total_cost_usd ?? envelope.cost_usd),
      },
      toolCalls: 0,
    };
  } catch { return { usage: emptyUsage(), toolCalls: 0 }; }
}

function openCodeMetadata(stdout: string): { usage: AgentUsage; toolCalls: number | null } {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  let toolCalls = 0;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; tokens?: { input?: number; output?: number }; cost?: number } };
      if (event.type === "tool_use" || event.part?.type === "tool") toolCalls += 1;
      if (event.part?.type === "step-finish" && event.part.tokens) {
        inputTokens = parseNumber(event.part.tokens.input);
        outputTokens = parseNumber(event.part.tokens.output);
        costUsd = parseNumber(event.part.cost);
      }
    } catch { /* Ignore non-event lines in the adapter's metadata pass. */ }
  }
  return { usage: { inputTokens, outputTokens, costUsd }, toolCalls };
}

function execute(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  setChild: (child: ChildProcess, active: boolean) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    setChild(child, true);
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let tooLarge = false;
    let hardKill: NodeJS.Timeout | undefined;
    const limit = 256 * 1024;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };
    const terminate = () => {
      kill("SIGTERM");
      hardKill ??= setTimeout(() => kill("SIGKILL"), 1500);
      hardKill.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onData = (channel: "stdout" | "stderr", data: Buffer) => {
      if (tooLarge) return;
      const capturedBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      const remaining = limit - capturedBytes;
      const captured = data.subarray(0, Math.max(0, remaining)).toString();
      if (channel === "stdout") stdout += captured;
      else stderr += captured;
      if (data.length > remaining) {
        tooLarge = true;
        terminate();
      }
    };
    child.stdout?.on("data", (data: Buffer) => onData("stdout", data));
    child.stderr?.on("data", (data: Buffer) => onData("stderr", data));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      setChild(child, false);
      reject(new AgentExecutionError(`Could not start CLI: ${error.message}`, false, excerpt(stdout), excerpt(stderr), Date.now() - start));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      setChild(child, false);
      const latencyMs = Date.now() - start;
      if (timedOut) {
        reject(new AgentExecutionError(`Move timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`, true, excerpt(stdout), excerpt(stderr), latencyMs));
      } else if (tooLarge) {
        reject(new AgentExecutionError("CLI output exceeded the 256 KB limit.", false, excerpt(stdout), excerpt(stderr), latencyMs));
      } else if (code !== 0) {
        const diagnostic = excerpt(stderr, 700);
        reject(new AgentExecutionError(`CLI exited with ${code ?? signal ?? "unknown status"}.${diagnostic ? ` ${diagnostic}` : ""}`, false, excerpt(stdout), diagnostic, latencyMs));
      } else {
        resolve({ stdout, stderr, latencyMs });
      }
    });
  });
}

function buildPrompt(observation: GameObservation): string {
  return [
    "You are an agent playing a turn-based game. The controller is authoritative and validates every action.",
    "Use only the observation below. It is complete for this turn; do not assume memory from earlier turns.",
    "Return exactly one JSON object matching action_schema. Do not include prose or markdown.",
    JSON.stringify({ observation, action_schema: observation.actionSchema }),
  ].join("\n\n");
}

abstract class CliAgentAdapter implements AgentAdapter {
  readonly id: string;
  private executable?: string;
  private readonly activeChildren = new Set<ChildProcess>();

  constructor(readonly config: PlayerConfig) {
    this.id = `${config.provider}:${config.model || "default"}`;
  }

  async initialize(): Promise<void> {
    this.executable = locate(commandName[this.config.provider]);
    if (!this.executable) throw new AgentExecutionError(`${commandName[this.config.provider]} CLI is not available in PATH.`);
  }

  async act(observation: GameObservation): Promise<AgentReply> {
    if (!this.executable) await this.initialize();
    const workingDirectory = mkdtempSync(join(os.tmpdir(), "agent-battle-player-"));
    try {
      const invocation = this.invocation(observation, workingDirectory);
      const response = await execute(
        this.executable!, invocation.args, invocation.env, workingDirectory,
        observation.clock.turnTimeoutMs, (child, active) => {
          if (active) this.activeChildren.add(child);
          else this.activeChildren.delete(child);
        },
      );
      const output = invocation.readOutput(response.stdout);
      let action: GameAction;
      try { action = parseStructuredAction(output, this.config.provider); }
      catch (error) {
        if (error instanceof AgentProtocolError) {
          throw new AgentProtocolError(
            error.message,
            excerpt(output),
            response.latencyMs,
            excerpt(response.stderr),
            invocation.countToolCalls(response.stdout),
            invocation.parseUsage(response.stdout),
          );
        }
        throw error;
      }
      const metadata = invocation.parseUsage(response.stdout);
      return {
        action,
        latencyMs: response.latencyMs,
        responseExcerpt: JSON.stringify(action),
        stderrExcerpt: excerpt(response.stderr),
        toolCalls: invocation.countToolCalls(response.stdout),
        usage: metadata,
      };
    } catch (error) {
      if (error instanceof AgentExecutionError || error instanceof AgentProtocolError) throw error;
      throw new AgentExecutionError(error instanceof Error ? error.message : "Unexpected adapter error.");
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }

  async shutdown(): Promise<void> {
    const children = [...this.activeChildren];
    for (const child of children) {
      if (!child.pid) continue;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* It may have exited between the check and signal. */ }
    }
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const hardKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { /* The process group may have exited at the deadline. */ }
        }
        resolve();
      }, 1500);
      hardKill.unref();
      child.once("close", () => { clearTimeout(hardKill); resolve(); });
    })));
  }

  protected abstract invocation(observation: GameObservation, workingDirectory: string): Invocation;

  protected getModelArgs(): string[] {
    return this.config.model.trim() ? ["--model", this.config.model.trim()] : [];
  }
}

export class CodexCLIAdapter extends CliAgentAdapter {
  protected invocation(observation: GameObservation, workingDirectory: string): Invocation {
    const schemaPath = join(workingDirectory, "action-schema.json");
    const responsePath = join(workingDirectory, "action.json");
    writeFileSync(schemaPath, JSON.stringify(observation.actionSchema));
    const reasoning = this.config.reasoning?.trim().toLowerCase();
    const reasoningArgs = reasoning && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning)
      ? ["-c", `model_reasoning_effort=\"${reasoning}\"`]
      : [];
    return {
      args: [
        "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-c", 'approval_policy="never"',
        "--json", "--output-schema", schemaPath, "--output-last-message", responsePath, "--cd", workingDirectory,
        ...this.getModelArgs(), ...reasoningArgs,
        buildPrompt(observation),
      ],
      env: safeEnvironment(),
      readOutput: (stdout) => { try { return readFileSync(responsePath, "utf8"); } catch { return stdout; } },
      parseUsage: (stdout) => codexMetadata(stdout).usage,
      countToolCalls: (stdout) => codexMetadata(stdout).toolCalls,
    };
  }
}

export class ClaudeCodeAdapter extends CliAgentAdapter {
  protected invocation(observation: GameObservation): Invocation {
    const reasoning = this.config.reasoning?.trim().toLowerCase();
    const effortArgs = reasoning && ["low", "medium", "high", "xhigh", "max"].includes(reasoning) ? ["--effort", reasoning] : [];
    return {
      args: [
        "--print", "--output-format", "json", "--json-schema", JSON.stringify(observation.actionSchema),
        "--permission-mode", "dontAsk", "--permission-prompts", "none", "--tools", "",
        "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
        ...effortArgs,
        ...(this.config.model.trim() ? ["--model", this.config.model.trim()] : []),
        buildPrompt(observation),
      ],
      env: safeEnvironment(),
      readOutput: (stdout) => stdout,
      parseUsage: (stdout) => claudeMetadata(stdout).usage,
      countToolCalls: (stdout) => claudeMetadata(stdout).toolCalls,
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
  protected invocation(observation: GameObservation, workingDirectory: string): Invocation {
    const env = safeEnvironment();
    env.OPENCODE_CONFIG_CONTENT = openCodeRestrictedConfig();
    const modelArgs = this.config.model.trim() ? ["--model", this.config.model.trim()] : [];
    const reasoning = this.config.reasoning?.trim();
    const variantArgs = reasoning ? ["--variant", reasoning] : [];
    return {
      args: ["run", "--format", "json", "--pure", "--agent", "agent-battle", "--dir", workingDirectory, ...modelArgs, ...variantArgs, buildPrompt(observation)],
      env,
      readOutput: (stdout) => stdout,
      parseUsage: (stdout) => openCodeMetadata(stdout).usage,
      countToolCalls: (stdout) => openCodeMetadata(stdout).toolCalls,
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
