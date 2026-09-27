import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { AgentExecutionError } from "../domain/agent.js";
import { excerpt } from "./diagnostics.js";

export interface ProcessRunOptions {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  outputLimitBytes?: number;
  signal?: AbortSignal;
  onChild?: (child: ChildProcess | null) => void;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  latencyMs: number;
}

const TERMINATION_GRACE_MS = 1500;
const GROUP_POLL_MS = 40;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals, detached: boolean): void {
  if (detached && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through to direct signal */ }
  }
  try { child.kill(signal); } catch { /* It may have exited between the check and signal. */ }
}

function groupAlive(child: ChildProcess, detached: boolean): boolean {
  if (!detached || !child.pid) return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function isDetachedPlatform(): boolean {
  return process.platform !== "win32";
}

export function isGroupAlive(child: ChildProcess): boolean {
  return groupAlive(child, isDetachedPlatform());
}

/**
 * Terminate a spawned process group, escalating even when the group leader has
 * already exited but descendants remain. Bounded by the termination grace; a
 * descendant that changes its own session/group is outside this boundary.
 */
export async function terminateProcessGroup(child: ChildProcess): Promise<void> {
  const detached = isDetachedPlatform();
  signalGroup(child, "SIGTERM", detached);
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(child, detached)) return;
    await delay(GROUP_POLL_MS);
  }
  signalGroup(child, "SIGKILL", detached);
  await delay(GROUP_POLL_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Runs one CLI attempt under a single deadline and (optionally) an abort signal.
 * Guarantees the process group is settled before the promise rejects/resolves on
 * cancellation or timeout, so the next attempt cannot overlap a live process.
 */
export function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const limit = options.outputLimitBytes ?? 256 * 1024;
    const detached = isDetachedPlatform();
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    options.onChild?.(child);
    const start = Date.now();
    const decoder = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let tooLarge = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let abortReason: unknown;
    let termination: Promise<void> | undefined;

    const terminate = (): Promise<void> => {
      termination ??= terminateProcessGroup(child);
      return termination;
    };

    const onAbort = () => {
      aborted = true;
      abortReason = options.signal?.reason;
      void terminate();
    };

    const onData = (channel: "stdout" | "stderr", data: Buffer) => {
      if (tooLarge) return;
      const room = limit - capturedBytes;
      if (room <= 0) { tooLarge = true; void terminate(); return; }
      const slice = data.length <= room ? data : data.subarray(0, room);
      capturedBytes += slice.length;
      if (channel === "stdout") stdout += decoder.stdout.write(slice);
      else stderr += decoder.stderr.write(slice);
      if (data.length > room) { tooLarge = true; void terminate(); }
    };

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; void terminate(); }, options.timeoutMs);
    child.stdout?.on("data", (data: Buffer) => onData("stdout", data));
    child.stderr?.on("data", (data: Buffer) => onData("stderr", data));

    const finalize = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (termination) await termination;
      else if (groupAlive(child, detached)) await terminate();
      options.onChild?.(null);
      stdout += decoder.stdout.end();
      stderr += decoder.stderr.end();
      const latencyMs = Date.now() - start;
      if (aborted) {
        reject(abortReason instanceof Error ? abortReason : new AgentExecutionError("Agent request was cancelled.", false, excerpt(stdout), excerpt(stderr), latencyMs));
      } else if (timedOut) {
        reject(new AgentExecutionError(`Move timed out after ${Math.ceil(options.timeoutMs / 1000)} seconds.`, true, excerpt(stdout), excerpt(stderr), latencyMs));
      } else if (tooLarge) {
        reject(new AgentExecutionError(`CLI output exceeded the ${Math.round(limit / 1024)} KB limit.`, false, excerpt(stdout), excerpt(stderr), latencyMs));
      } else if (code !== 0) {
        const diagnostic = excerpt(stderr, 700);
        reject(new AgentExecutionError(`CLI exited with ${code ?? signal ?? "unknown status"}.${diagnostic ? ` ${diagnostic}` : ""}`, false, excerpt(stdout), diagnostic, latencyMs));
      } else {
        resolve({ stdout, stderr, latencyMs });
      }
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      options.onChild?.(null);
      reject(new AgentExecutionError(`Could not start CLI: ${error.message}`, false, excerpt(stdout), excerpt(stderr), Date.now() - start));
    });
    child.on("close", (code, signal) => { void finalize(code, signal); });
  });
}

export function readBoundedFile(path: string, limit = 256 * 1024): string | undefined {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return undefined;
    if (stats.size > limit) throw new AgentExecutionError(`CLI response file exceeded the ${Math.round(limit / 1024)} KB limit.`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof AgentExecutionError) throw error;
    return undefined;
  }
}
