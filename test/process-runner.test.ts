import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { AgentExecutionError } from "../src/domain/agent.js";
import { redact, excerpt } from "../src/server/diagnostics.js";
import { runProcess } from "../src/server/processRunner.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function withScript(build: (pidFile: string) => string): { folder: string; executable: string; pidFile: string; cleanup: () => void } {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-runner-"));
  const executable = join(folder, "cli");
  const pidFile = join(folder, "descendant.pid");
  writeFileSync(executable, build(pidFile));
  chmodSync(executable, 0o755);
  return { folder, executable, pidFile, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("runProcess terminates a group that ignores SIGTERM and reaps descendants", async () => {
  const { folder, executable, pidFile, cleanup } = withScript(
    (pidFile) => `#!/bin/sh\n( trap '' TERM; exec sleep 30 ) &\necho "$!" > "${pidFile}"\nsleep 30\n`,
  );
  try {
    await assert.rejects(
      runProcess({ executable, args: [], env: process.env, cwd: folder, timeoutMs: 400 }),
      (error: unknown) => error instanceof AgentExecutionError && error.timedOut,
    );
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await delay(150);
    assert.equal(alive(pid), false, `descendant ${pid} should have been reaped`);
  } finally { cleanup(); }
});

test("runProcess aborts promptly on a cancellation signal", async () => {
  const { folder, executable, cleanup } = withScript(() => "#!/bin/sh\nsleep 30\n");
  const controller = new AbortController();
  const pending = runProcess({ executable, args: [], env: process.env, cwd: folder, timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(new AgentExecutionError("cancelled by controller", false)), 150);
  try {
    await assert.rejects(pending, (error: unknown) => error instanceof Error && /cancelled by controller/.test(error.message));
  } finally { cleanup(); }
});

test("runProcess caps combined stdout and stderr", async () => {
  const { folder, executable, cleanup } = withScript(() => "#!/bin/sh\ndd if=/dev/zero bs=1024 count=300 2>/dev/null | tr '\\0' 'a'\n");
  try {
    await assert.rejects(
      runProcess({ executable, args: [], env: process.env, cwd: folder, timeoutMs: 5000, outputLimitBytes: 2048 }),
      (error: unknown) => error instanceof AgentExecutionError && !error.timedOut && /limit/i.test(error.message),
    );
  } finally { cleanup(); }
});

test("diagnostics redact common credential shapes", () => {
  assert.doesNotMatch(redact("token sk-abcdefghijklmnop"), /sk-abcdefghijklmnop/);
  assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /\[redacted\]/);
  assert.doesNotMatch(redact('api_key: "supersecretvalue"'), /supersecretvalue/);
  assert.doesNotMatch(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"), /MIIabc/);
  assert.equal(excerpt("  hello  "), "hello");
});
