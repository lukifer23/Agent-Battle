import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { AgentExecutionError, AgentProtocolError } from "../src/domain/agent.js";
import { CodexCLIAdapter, OpenCodeAdapter, parseStructuredAction } from "../src/server/adapters.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";

const action = { type: "move", payload: { move: "e2e4" } };
const observation = new ChessGame().observe(new ChessGame().createState(), {
  matchId: "adapter-test", turnId: "turn-1", player: { id: "white", label: "White", agent: { provider: "codex", model: "test", name: "test" } },
  moveNumber: 1, turnTimeoutMs: 1200,
});

test("strict protocol parser accepts only a JSON action envelope", () => {
  assert.deepEqual(parseStructuredAction(JSON.stringify(action), "codex"), action);
  assert.deepEqual(parseStructuredAction(JSON.stringify({ result: JSON.stringify(action) }), "claude"), action);
  assert.deepEqual(parseStructuredAction(`${JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify(action) } })}\n${JSON.stringify({ type: "step_finish" })}`, "opencode"), action);
  assert.throws(() => parseStructuredAction("I would like to move e2 to e4.", "codex"), AgentProtocolError);
  assert.throws(() => parseStructuredAction('{"move":"e2e4"}', "codex"), AgentProtocolError);
  assert.throws(() => parseStructuredAction(`${JSON.stringify(action)} extra`, "claude"), AgentProtocolError);
});

async function withFakeCodex(body: (folder: string) => Promise<void>, mode: "valid" | "timeout" | "fail"): Promise<void> {
  const previousPath = process.env.PATH;
  const previousCaptureArgs = process.env.BATTLE_CODEX_ARGS;
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-test-"));
  const executable = join(folder, "codex");
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex test 1.0'; exit 0; fi\nprintf '%s\\n' "$@" > "$BATTLE_CODEX_ARGS"\nMODE='${mode}'\nif [ "$MODE" = 'timeout' ]; then sleep 20; exit 0; fi\nif [ "$MODE" = 'fail' ]; then echo 'controlled provider failure' >&2; exit 17; fi\nOUT=''\nPREV=''\nfor ARG in "$@"; do if [ "$PREV" = '--output-last-message' ]; then OUT="$ARG"; break; fi; PREV="$ARG"; done\nprintf '%s' '${JSON.stringify(action)}' > "$OUT"\necho '{"type":"turn.completed","usage":{"input_tokens":42,"output_tokens":3}}'\n`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  process.env.PATH = `${folder}:/bin:/usr/bin`;
  process.env.BATTLE_CODEX_ARGS = join(folder, "arguments.txt");
  try { await body(folder); }
  finally {
    process.env.PATH = previousPath;
    if (previousCaptureArgs === undefined) delete process.env.BATTLE_CODEX_ARGS;
    else process.env.BATTLE_CODEX_ARGS = previousCaptureArgs;
    rmSync(folder, { recursive: true, force: true });
  }
}

test("Codex CLI adapter uses supported headless policy options and reads a structured response", async () => {
  await withFakeCodex(async (folder) => {
    const adapter = new CodexCLIAdapter({ provider: "codex", model: "test-model", name: "test" });
    await adapter.initialize();
    const reply = await adapter.act(observation);
    assert.deepEqual(reply.action, action);
    assert.equal(reply.usage.inputTokens, 42);
    assert.equal(reply.usage.outputTokens, 3);
    assert.equal(reply.toolCalls, 0);
    const args = readFileSync(join(folder, "arguments.txt"), "utf8");
    assert.match(args, /approval_policy="never"/);
    assert.doesNotMatch(args, /--ask-for-approval/);
    await adapter.shutdown();
  }, "valid");
});

test("agent timeout kills the CLI process group", async () => {
  await withFakeCodex(async () => {
    const adapter = new CodexCLIAdapter({ provider: "codex", model: "test-model", name: "test" });
    await adapter.initialize();
    await assert.rejects(adapter.act(observation), (error: unknown) => error instanceof AgentExecutionError && error.timedOut);
  }, "timeout");
});

test("nonzero CLI exit is reported as a process failure", async () => {
  await withFakeCodex(async () => {
    const adapter = new CodexCLIAdapter({ provider: "codex", model: "test-model", name: "test" });
    await adapter.initialize();
    await assert.rejects(adapter.act(observation), (error: unknown) => error instanceof AgentExecutionError && !error.timedOut && error.stderrExcerpt.includes("controlled provider failure"));
  }, "fail");
});

test("OpenCode adapter selects a dedicated no-tools agent even when user config has other tools", async () => {
  const previousPath = process.env.PATH;
  const previousCaptureConfig = process.env.BATTLE_TEST_CONFIG;
  const previousCaptureArgs = process.env.BATTLE_TEST_ARGS;
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-opencode-test-"));
  const executable = join(folder, "opencode");
  const captureConfig = join(folder, "config.json");
  const captureArgs = join(folder, "args.txt");
  const event = JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify(action) } });
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'opencode test 1.0'; exit 0; fi\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > "$BATTLE_TEST_CONFIG"\nprintf '%s\\n' "$@" > "$BATTLE_TEST_ARGS"\nprintf '%s\\n' '${event}'\n`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  process.env.PATH = `${folder}:/bin:/usr/bin`;
  process.env.BATTLE_TEST_CONFIG = captureConfig;
  process.env.BATTLE_TEST_ARGS = captureArgs;
  try {
    const adapter = new OpenCodeAdapter({ provider: "opencode", model: "test-model", name: "test" });
    await adapter.initialize();
    const reply = await adapter.act(observation);
    assert.deepEqual(reply.action, action);
    const config = JSON.parse(readFileSync(captureConfig, "utf8")) as {
      agent: Record<string, { tools: Record<string, boolean>; permission: Record<string, string> }>;
    };
    assert.equal(config.agent["agent-battle"]?.tools["*"], false);
    assert.equal(config.agent["agent-battle"]?.permission["*"], "deny");
    const args = readFileSync(captureArgs, "utf8").trim().split(/\r?\n/);
    const agentIndex = args.indexOf("--agent");
    assert.ok(agentIndex >= 0);
    assert.equal(args[agentIndex + 1], "agent-battle");
    await adapter.shutdown();
  } finally {
    process.env.PATH = previousPath;
    if (previousCaptureConfig === undefined) delete process.env.BATTLE_TEST_CONFIG;
    else process.env.BATTLE_TEST_CONFIG = previousCaptureConfig;
    if (previousCaptureArgs === undefined) delete process.env.BATTLE_TEST_ARGS;
    else process.env.BATTLE_TEST_ARGS = previousCaptureArgs;
    rmSync(folder, { recursive: true, force: true });
  }
});
