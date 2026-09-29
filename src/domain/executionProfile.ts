import { createHash } from "node:crypto";
import type { AgentAdapter } from "./agent.js";
import { ACTION_PROTOCOL_VERSION, ADAPTER_VERSION, OBSERVATION_PROTOCOL_VERSION } from "../version.js";
import type { AdapterCapabilities, FrozenExecutionProfile, PlayerConfig } from "../shared.js";

const unavailableCapabilities: AdapterCapabilities = {
  exactModel: "unavailable",
  sessionIdentity: "unavailable",
  streamCompletion: "unavailable",
  toolInventory: "unavailable",
  toolUse: "unavailable",
  structuredOutput: "prompt",
  usage: "unavailable",
  cost: "unavailable",
  reasoningRequest: "unavailable",
  effectiveReasoning: "unobserved",
  cancellation: "unavailable",
  isolation: "unqualified",
};

export function executionProfileDigest(restrictions: string, capabilities: AdapterCapabilities): string {
  const ordered: AdapterCapabilities = {
    exactModel: capabilities.exactModel,
    sessionIdentity: capabilities.sessionIdentity,
    streamCompletion: capabilities.streamCompletion,
    toolInventory: capabilities.toolInventory,
    toolUse: capabilities.toolUse,
    structuredOutput: capabilities.structuredOutput,
    usage: capabilities.usage,
    cost: capabilities.cost,
    reasoningRequest: capabilities.reasoningRequest,
    effectiveReasoning: capabilities.effectiveReasoning,
    cancellation: capabilities.cancellation,
    isolation: capabilities.isolation,
  };
  return createHash("sha256").update(JSON.stringify({ restrictions, capabilities: ordered })).digest("hex");
}

export function buildFrozenProfile(adapter: AgentAdapter): FrozenExecutionProfile {
  const capabilities = adapter.capabilities ?? unavailableCapabilities;
  const restrictions = adapter.restrictions ?? "unobserved";
  return {
    provider: adapter.config.provider,
    requestedModel: adapter.config.model.trim(),
    requestedReasoning: (adapter.config.reasoning ?? "").trim(),
    adapterVersion: ADAPTER_VERSION,
    observationProtocolVersion: OBSERVATION_PROTOCOL_VERSION,
    actionProtocolVersion: ACTION_PROTOCOL_VERSION,
    cliVersion: adapter.observedCliVersion ?? null,
    restrictionProfileId: `${adapter.config.provider}/restricted-cli-v1`,
    profileHash: executionProfileDigest(restrictions, capabilities),
    capabilities,
  };
}

/** Research preflight reads declared capabilities. It does not spawn a provider request. */
export function researchCapabilityRefusal(adapter: AgentAdapter): string | undefined {
  const capabilities = adapter.capabilities;
  if (!capabilities) return `${adapter.config.provider} does not declare an execution capability contract.`;
  const missing: string[] = [];
  if (capabilities.exactModel !== "observable") missing.push("exact model identity");
  if (capabilities.sessionIdentity !== "observable") missing.push("session identity");
  if (capabilities.streamCompletion !== "observable") missing.push("complete stream detection");
  if (capabilities.toolInventory !== "observable") missing.push("tool inventory");
  if (capabilities.toolUse !== "observable") missing.push("tool-use detection");
  if (capabilities.isolation !== "qualified") missing.push("no-tools qualification");
  if (!missing.length) return undefined;
  return `${adapter.config.provider} is not research-qualified: ${missing.join(", ")} are not declared observable.`;
}

export interface ObservedExecutionProfile {
  provider: PlayerConfig["provider"];
  model: string;
  reasoning?: string;
  adapterVersion: string;
  observationProtocolVersion: string;
  actionProtocolVersion: string;
  cliVersion: string | null;
  restrictions?: string;
  capabilities?: AdapterCapabilities;
}

export function executionProfileDrift(frozen: FrozenExecutionProfile, observed: ObservedExecutionProfile): string[] {
  const reasons: string[] = [];
  if (observed.provider !== frozen.provider) reasons.push(`Provider changed from ${frozen.provider} to ${observed.provider}.`);
  if (observed.model.trim() !== frozen.requestedModel) reasons.push(`Requested model changed from ${frozen.requestedModel} to ${observed.model.trim()}.`);
  if ((observed.reasoning ?? "").trim() !== frozen.requestedReasoning) reasons.push(`Requested reasoning changed from ${frozen.requestedReasoning || "(none)"} to ${(observed.reasoning ?? "").trim() || "(none)"}.`);
  if (observed.adapterVersion !== frozen.adapterVersion) reasons.push(`Adapter version changed from ${frozen.adapterVersion} to ${observed.adapterVersion}.`);
  if (observed.observationProtocolVersion !== frozen.observationProtocolVersion) reasons.push(`Observation protocol changed from ${frozen.observationProtocolVersion} to ${observed.observationProtocolVersion}.`);
  if (observed.actionProtocolVersion !== frozen.actionProtocolVersion) reasons.push(`Action protocol changed from ${frozen.actionProtocolVersion} to ${observed.actionProtocolVersion}.`);
  if ((observed.cliVersion ?? null) !== frozen.cliVersion) reasons.push(`CLI version changed from ${frozen.cliVersion ?? "unobserved"} to ${observed.cliVersion ?? "unobserved"}.`);
  const capabilities = observed.capabilities ?? unavailableCapabilities;
  const digest = executionProfileDigest(observed.restrictions ?? "unobserved", capabilities);
  if (digest !== frozen.profileHash) reasons.push("Execution restrictions or declared capabilities differ from the frozen profile.");
  return reasons;
}
