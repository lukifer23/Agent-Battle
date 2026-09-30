import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { AgentExecutionError, AgentProtocolError } from "../src/domain/agent.js";
import { ClaudeCodeAdapter, CodexCLIAdapter, GrokBuildAdapter, OpenCodeAdapter, parseStructuredAction } from "../src/server/adapters.js";
import { inspectExecutionStream } from "../src/server/executionEvidence.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";

const action = { type: "move", payload: { move: "e2e4" } };
const observation = new ChessGame().observe(new ChessGame().createState(), {
  matchId: "adapter-test", turnId: "turn-1", player: { id: "white", label: "White", agent: { provider: "codex", model: "test", name: "test" } },
  ply: 1, turnIndex: 1, turnTimeoutMs: 1200,
});
const control = () => ({ signal: new AbortController().signal });

test("strict protocol parser accepts only a JSON action envelope", () => {
  assert.deepEqual(parseStructuredAction(JSON.stringify(action), "codex"), action);
  assert.deepEqual(parseStructuredAction(JSON.stringify({ result: JSON.stringify(action) }), "claude"), action);
  assert.deepEqual(parseStructuredAction(`${JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify(action) } })}\n${JSON.stringify({ type: "step_finish" })}`, "opencode"), action);
  assert.deepEqual(parseStructuredAction(JSON.stringify({ structuredOutput: action, text: "", stopReason: "end_turn", sessionId: "sess-1", modelUsage: { "grok-4.7": { inputTokens: 3, outputTokens: 1 } }, usage: { input_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 1 }, total_cost_usd: 0.01 }), "grok"), action);
  assert.throws(() => parseStructuredAction(JSON.stringify({ type: "error", message: "auth failed" }), "grok"), (error: unknown) => error instanceof AgentExecutionError && /auth failed/.test(error.message));
  assert.throws(() => parseStructuredAction(JSON.stringify({ text: "not json", stopReason: "end_turn", usage_is_incomplete: true }), "grok"), AgentProtocolError);
  assert.throws(() => parseStructuredAction("I would like to move e2 to e4.", "codex"), AgentProtocolError);
  assert.throws(() => parseStructuredAction('{"move":"e2e4"}', "codex"), AgentProtocolError);
  assert.throws(() => parseStructuredAction(`${JSON.stringify(action)} extra`, "claude"), AgentProtocolError);
});

test("Claude structured_output is preferred and an error subtype is an execution error, not a forfeit", () => {
  assert.deepEqual(parseStructuredAction(JSON.stringify({ structured_output: action, result: "" }), "claude"), action);
  assert.deepEqual(parseStructuredAction(JSON.stringify({ structured_output: null, result: JSON.stringify(action) }), "claude"), action);
  assert.throws(
    () => parseStructuredAction(JSON.stringify({ is_error: true, subtype: "error_during_execution", result: "authentication failed" }), "claude"),
    (error: unknown) => error instanceof AgentExecutionError && !error.timedOut && /authentication failed/.test(error.message),
  );
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
    const reply = await adapter.act(observation, control());
    assert.deepEqual(reply.action, action);
    assert.equal(reply.usage.inputTokens, 42);
    assert.equal(reply.usage.outputTokens, 3);
    assert.equal(reply.toolCalls, 0);
    assert.equal(adapter.isolationQualified, false);
    const args = readFileSync(join(folder, "arguments.txt"), "utf8");
    assert.match(args, /--model\ntest-model\n/);
    assert.match(args, /approval_policy="never"/);
    assert.match(args, /--ignore-user-config/);
    assert.doesNotMatch(args, /--ask-for-approval/);
    await adapter.shutdown();
  }, "valid");
});

test("Claude no-tools invocation reports resolved model and policy evidence", async () => {
  const previousPath = process.env.PATH;
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-claude-test-"));
  const executable = join(folder, "claude");
  const envelope = JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"] }) + "\n" + JSON.stringify({ type: "result", structured_output: { action }, modelUsage: { "claude-test-model": { inputTokens: 1 } }, usage: { input_tokens: 7, output_tokens: 2 } });
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'claude test'; exit 0; fi\nprintf '%s\\n' "$@" > "${folder}/args.txt"\nprintf '%s\\n' "$CLAUDE_CODE_SIMPLE" > "${folder}/simple.txt"\nprintf '%s\\n' "$MAX_THINKING_TOKENS" > "${folder}/thinking.txt"\nprintf '%s\\n' '${envelope}'\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${folder}:/bin:/usr/bin`;
  try {
    const adapter = new ClaudeCodeAdapter({ provider: "claude", model: "claude-test-model", reasoning: "none", name: "test" });
    await adapter.initialize();
    const reply = await adapter.act(observation, control());
    assert.equal(reply.resolvedModel, "claude-test-model");
    assert.equal(reply.toolCalls, 0);
    assert.equal(adapter.isolationQualified, true);
    const args = readFileSync(join(folder, "args.txt"), "utf8").split("\n");
    assert.ok(!args.includes("--bare"), "bare mode disables OAuth/keychain authentication");
    assert.equal(args[args.indexOf("--model") + 1], "claude-test-model");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]), { disableAllHooks: true, autoMemoryEnabled: false });
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
    assert.deepEqual(schema.required, ["action"]);
    assert.deepEqual(schema.properties.action.required, ["type", "payload"]);
    assert.ok(args.includes("--safe-mode"));
    assert.equal(readFileSync(join(folder, "thinking.txt"), "utf8").trim(), "0");
    assert.ok(!args.includes("--effort"), "none is implemented by disabling thinking, not an unsupported effort enum");
    assert.equal(readFileSync(join(folder, "simple.txt"), "utf8").trim(), "0", "inherited simple mode must not disable OAuth");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(args.includes("--no-session-persistence"));
    await adapter.shutdown();
  } finally { process.env.PATH = previousPath; rmSync(folder, { recursive: true, force: true }); }
});

test("agent timeout kills the CLI process group", async () => {
  await withFakeCodex(async () => {
    const adapter = new CodexCLIAdapter({ provider: "codex", model: "test-model", name: "test" });
    await adapter.initialize();
    await assert.rejects(adapter.act(observation, control()), (error: unknown) => error instanceof AgentExecutionError && error.timedOut);
  }, "timeout");
});

test("nonzero CLI exit is reported as a process failure", async () => {
  await withFakeCodex(async () => {
    const adapter = new CodexCLIAdapter({ provider: "codex", model: "test-model", name: "test" });
    await adapter.initialize();
    await assert.rejects(adapter.act(observation, control()), (error: unknown) => error instanceof AgentExecutionError && !error.timedOut && error.stderrExcerpt.includes("controlled provider failure"));
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
  const event = JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify(action), providerID: "test-provider", modelID: "test-model" } });
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'opencode test 1.0'; exit 0; fi\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > "$BATTLE_TEST_CONFIG"\nprintf '%s\\n' "$@" > "$BATTLE_TEST_ARGS"\nprintf '%s\\n' '${event}'\n`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  process.env.PATH = `${folder}:/bin:/usr/bin`;
  process.env.BATTLE_TEST_CONFIG = captureConfig;
  process.env.BATTLE_TEST_ARGS = captureArgs;
  try {
    const adapter = new OpenCodeAdapter({ provider: "opencode", model: "test-model", name: "test" });
    await adapter.initialize();
    const reply = await adapter.act(observation, control());
    assert.deepEqual(reply.action, action);
    assert.equal(reply.resolvedModel, "test-provider/test-model");
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

async function withFakeOpenCode(events: string[], body: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH;
  const previousCaptureConfig = process.env.BATTLE_TEST_CONFIG;
  const previousCaptureArgs = process.env.BATTLE_TEST_ARGS;
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-opencode-stream-"));
  const executable = join(folder, "opencode");
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'opencode test 1.0'; exit 0; fi\nprintf '%s\\n' '${events.join("\n")}'\n`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  process.env.PATH = `${folder}:/bin:/usr/bin`;
  process.env.BATTLE_TEST_CONFIG = join(folder, "config.json");
  process.env.BATTLE_TEST_ARGS = join(folder, "args.txt");
  try { await body(); }
  finally {
    process.env.PATH = previousPath;
    if (previousCaptureConfig === undefined) delete process.env.BATTLE_TEST_CONFIG;
    else process.env.BATTLE_TEST_CONFIG = previousCaptureConfig;
    if (previousCaptureArgs === undefined) delete process.env.BATTLE_TEST_ARGS;
    else process.env.BATTLE_TEST_ARGS = previousCaptureArgs;
    rmSync(folder, { recursive: true, force: true });
  }
}

test("OpenCode records one sessionID and cache tokens without copying the requested model", async () => {
  const actionText = JSON.stringify(action);
  const events = [
    JSON.stringify({ type: "step_start", sessionID: "ses_one" }),
    JSON.stringify({ type: "text", sessionID: "ses_one", part: { type: "text", text: actionText } }),
    JSON.stringify({ type: "tool_use", sessionID: "ses_one", part: { type: "tool" } }),
    JSON.stringify({ type: "tool_result", sessionID: "ses_one", part: { type: "tool-result" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_one", part: { type: "step-finish", tokens: { input: 100, output: 10, cache: { read: 20, write: 5 } }, cost: 0.001, modelID: "opencode-go/deepseek-v4.1-flash" } }),
  ];
  await withFakeOpenCode(events, async () => {
    const adapter = new OpenCodeAdapter({ provider: "opencode", model: "requested-model", name: "requested" });
    await adapter.initialize();
    const reply = await adapter.act(observation, control());
    assert.deepEqual(reply.action, action);
    assert.equal(reply.sessionId, "ses_one");
    assert.equal(reply.resolvedModel, "opencode-go/deepseek-v4.1-flash");
    assert.equal(reply.toolCalls, 1);
    assert.equal(reply.usage.inputTokens, 125);
    assert.equal(reply.usage.outputTokens, 10);
    assert.equal(reply.usage.costUsd, 0.001);
    assert.equal(reply.execution?.streamComplete, true);
    assert.equal(reply.execution?.unknownEvents, false);
    assert.deepEqual(reply.execution?.modelIds, ["opencode-go/deepseek-v4.1-flash"]);
    await adapter.shutdown();
  });
});

test("OpenCode leaves model and session unknown when the stream does not report one id", async () => {
  const events = [
    JSON.stringify({ type: "text", sessionID: "ses_a", part: { type: "text", text: JSON.stringify(action) } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_b", part: { type: "step-finish", tokens: { output: 4, cache: { read: 9 } }, cost: 0.002 } }),
  ];
  await withFakeOpenCode(events, async () => {
    const adapter = new OpenCodeAdapter({ provider: "opencode", model: "requested-model", name: "requested" });
    await adapter.initialize();
    const reply = await adapter.act(observation, control());
    assert.equal(reply.sessionId, undefined);
    assert.equal(reply.resolvedModel, undefined);
    assert.equal(reply.usage.inputTokens, null);
    assert.equal(reply.toolCalls, null);
    assert.equal(reply.execution?.unknownEvents, true);
    await adapter.shutdown();
  });
});

test("OpenCode execution evidence accepts tool_result and a slashed model id", () => {
  const config = { provider: "opencode" as const, model: "requested-model", name: "requested-model" };
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "ses_one" }),
    JSON.stringify({ type: "tool_result", sessionID: "ses_one" }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_one", part: { type: "step-finish", providerID: "opencode-go", modelID: "deepseek-v4.1-flash" } }),
  ].join("\n");
  const evidence = inspectExecutionStream(config, stdout, "test");
  assert.equal(evidence.streamComplete, true);
  assert.equal(evidence.unknownEvents, false);
  assert.deepEqual(evidence.modelIds, ["opencode-go/deepseek-v4.1-flash"]);
  const conflict = inspectExecutionStream(config, `${JSON.stringify({ type: "text", sessionID: "ses_a" })}\n${JSON.stringify({ type: "step_finish", session_id: "ses_b" })}`, "test");
  assert.equal(conflict.unknownEvents, true);
  assert.equal(conflict.streamComplete, true);
});

test("Grok adapter requests one schema-constrained headless turn and does not resume a session", async () => {
  const previousPath = process.env.PATH;
  const previousCaptureArgs = process.env.BATTLE_TEST_ARGS;
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-grok-test-"));
  const captureArgs = join(folder, "args.txt");
  const body = JSON.stringify({
    structuredOutput: action,
    stopReason: "end_turn",
    sessionId: "fresh-session",
    modelUsage: { "grok-4.7": { inputTokens: 4, outputTokens: 2 } },
    usage: { input_tokens: 4, output_tokens: 2 },
    total_cost_usd: 0.02,
  });
  writeFileSync(join(folder, "grok"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'grok test 1.0'; exit 0; fi\nprintf '%s\\n' "$@" > "$BATTLE_TEST_ARGS"\nprintf '%s\\n' '${body}'\n`);
  chmodSync(join(folder, "grok"), 0o755);
  process.env.PATH = `${folder}:/bin:/usr/bin`;
  process.env.BATTLE_TEST_ARGS = captureArgs;
  try {
    const adapter = new GrokBuildAdapter({ provider: "grok", model: "grok-4.7", reasoning: "low", name: "test" });
    await adapter.initialize();
    const reply = await adapter.act(observation, control());
    assert.deepEqual(reply.action, action);
    assert.equal(reply.resolvedModel, "grok-4.7");
    assert.equal(reply.sessionId, "fresh-session");
    assert.equal(reply.toolCalls, null);
    assert.equal(reply.usage.inputTokens, 4);
    assert.equal(reply.usage.costUsd, 0.02);
    const args = readFileSync(captureArgs, "utf8");
    assert.match(args, /--max-turns\n1/);
    assert.match(args, /--json-schema\n/);
    assert.match(args, /--disable-web-search/);
    assert.match(args, /--no-subagents/);
    assert.doesNotMatch(args, /--resume/);
    assert.match(args, /--reasoning-effort\nlow/);
    await adapter.shutdown();
  } finally {
    process.env.PATH = previousPath;
    if (previousCaptureArgs === undefined) delete process.env.BATTLE_TEST_ARGS;
    else process.env.BATTLE_TEST_ARGS = previousCaptureArgs;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Claude stream errors preserve identity and usage on nonzero exit without retaining thinking", async () => {
  const previousPath = process.env.PATH;
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-stream-error-"));
  const stream = [
    { type: "system", subtype: "init", tools: ["StructuredOutput"] },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "DO_NOT_PERSIST_REASONING" }] } },
    { type: "result", subtype: "error_max_structured_output_retries", is_error: true, session_id: "error-session", modelUsage: { "model-a": {} }, usage: { input_tokens: 25, output_tokens: 4 }, total_cost_usd: 0.02 },
  ].map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(join(folder, "claude"), `#!/bin/sh\ncat <<'STREAM'\n${stream}\nSTREAM\nexit 1\n`);
  chmodSync(join(folder, "claude"), 0o755); process.env.PATH = `${folder}:/bin:/usr/bin`;
  try {
    const adapter = new ClaudeCodeAdapter({ provider: "claude", model: "model-a", name: "test" });
    await assert.rejects(adapter.act(observation, control()), (error: unknown) => {
      assert.ok(error instanceof AgentExecutionError);
      assert.match(error.message, /error_max_structured_output_retries/);
      assert.equal(error.evidence?.resolvedModel, "model-a");
      assert.equal(error.evidence?.toolCalls, 0);
      assert.equal(error.evidence?.usage.inputTokens, 25);
      assert.equal(error.evidence?.sessionId, "error-session");
      assert.doesNotMatch(error.responseExcerpt, /DO_NOT_PERSIST_REASONING/);
      return true;
    });
    await adapter.shutdown();
  } finally { process.env.PATH = previousPath; rmSync(folder, { recursive: true, force: true }); }
});

test("Claude external tool evidence is counted and missing inventory is never guessed as zero", async () => {
  const previousPath = process.env.PATH;
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-tool-evidence-"));
  try {
    process.env.PATH = `${folder}:/bin:/usr/bin`;
    for (const [inventory, external, expected] of [[true, true, 1], [false, false, null]] as const) {
      const events = [
        ...(inventory ? [{ type: "system", subtype: "init", tools: ["StructuredOutput", "Bash"] }] : []),
        ...(external ? [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "forbidden" } }] } }] : []),
        { type: "result", structured_output: { action }, modelUsage: { "model-a": {} } },
      ];
      const executable = join(folder, "claude");
      writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo test; exit 0; fi\ncat <<'EVENTS'\n${events.map((event) => JSON.stringify(event)).join("\n")}\nEVENTS\n`);
      chmodSync(executable, 0o755);
      const adapter = new ClaudeCodeAdapter({ provider: "claude", model: "model-a", name: "test" });
      const reply = await adapter.act(observation, control());
      assert.equal(reply.toolCalls, expected);
      await adapter.shutdown();
    }
  } finally { process.env.PATH = previousPath; rmSync(folder, { recursive: true, force: true }); }
});
