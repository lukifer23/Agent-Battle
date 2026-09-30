import { createHash } from "node:crypto";
import type { ExecutionEvidence, PlayerConfig } from "../shared.js";
import { OBSERVATION_PROTOCOL_VERSION } from "../version.js";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const knownTypes = {
  claude: new Set(["system", "assistant", "user", "result", "rate_limit_event"]),
  codex: new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"]),
  opencode: new Set(["step_start", "step_finish", "text", "reasoning", "tool_use", "tool_result", "error"]),
  grok: new Set(["text", "thought", "tool_call", "tool_call_update", "usage", "plan", "available_commands", "end", "error"]),
};

/** Inspect metadata only. Never retain provider thinking or arbitrary event payloads. */
export function inspectExecutionStream(config: PlayerConfig, stdout: string, restrictions: string): ExecutionEvidence {
  const events: Record<string, unknown>[] = [];
  let unknownEvents = false;
  for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
    try {
      const event: unknown = JSON.parse(line);
      if (!object(event) || typeof event.type !== "string" || !knownTypes[config.provider].has(event.type)) unknownEvents = true;
      if (object(event)) events.push(event);
    } catch { unknownEvents = true; }
  }
  const modelIds = new Set<string>();
  const sessionIds = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.length <= 200) modelIds.add(v); };
  const rememberSession = (value: unknown) => { if (typeof value === "string" && value.length > 0) sessionIds.add(value); };
  for (const event of events) {
    rememberSession(event.session_id);
    rememberSession(event.sessionID);
    if (object(event.part)) {
      rememberSession(event.part.session_id);
      rememberSession(event.part.sessionID);
    }
    if (config.provider === "claude") {
      if (event.type === "system" && event.subtype !== "init") unknownEvents = true;
      if (object(event.message) && Array.isArray(event.message.content)) {
        const knownBlocks = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result"]);
        if (event.message.content.some((block) => !object(block) || !knownBlocks.has(String(block.type)))) unknownEvents = true;
      }
      if (event.type === "system" && event.subtype === "init") add(event.model);
      if (object(event.message)) add(event.message.model);
      if (object(event.modelUsage)) Object.keys(event.modelUsage).forEach(add);
      if (event.type === "result") add(event.model);
    } else if (config.provider === "codex") add(event.model);
    else if (config.provider === "grok") {
      if (object(event.modelUsage)) Object.keys(event.modelUsage).forEach(add);
      add(event.model);
    } else {
      const part = object(event.part) ? event.part : event;
      if (typeof part.providerID === "string" && typeof part.modelID === "string") add(`${part.providerID}/${part.modelID}`);
      else if (typeof part.modelID === "string" && part.modelID.includes("/")) add(part.modelID);
    }
  }
  if (sessionIds.size > 1) unknownEvents = true;
  const init = events.filter((e) => e.type === "system" && e.subtype === "init");
  const inventory = config.provider === "claude" && init.length === 1 && Array.isArray(init[0].tools) && init[0].tools.every((v) => typeof v === "string") ? init[0].tools as string[] : null;
  const endType = config.provider === "claude" ? "result" : config.provider === "codex" ? "turn.completed" : config.provider === "grok" ? "end" : "step_finish";
  const streamComplete = events.length > 0 && events.at(-1)?.type === endType && events.filter((e) => e.type === endType).length === 1;
  const profileId = `${config.provider}/restricted-cli-v1`;
  // Only static policy/configuration is hashed: low-entropy private observations must not leak through public hashes.
  const profileHash = createHash("sha256").update(JSON.stringify({ profileId, restrictions, model: config.model, reasoning: config.reasoning ?? "", promptVersion: OBSERVATION_PROTOCOL_VERSION, environment: "allowlist-v1" })).digest("hex");
  return { version: "execution-evidence-1", profileId, profileHash, requestedReasoning: config.reasoning ?? "", effectiveReasoning: null,
    streamComplete, unknownEvents, modelIds: [...modelIds].sort(), toolInventory: inventory };
}
