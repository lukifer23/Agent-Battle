import type { ExecutionEvidence } from "../shared.js";

export function researchExecutionReasons(evidence: ExecutionEvidence | undefined, requestedModel: string): string[] {
  if (!evidence) return ["No versioned execution evidence."];
  const reasons: string[] = [];
  if (!evidence.streamComplete || evidence.unknownEvents) reasons.push("Provider event stream is incomplete or contains unrecognized events.");
  if (evidence.modelIds.length !== 1 || evidence.modelIds[0] !== requestedModel) reasons.push("Provider identity is missing, conflicting, or mismatched.");
  if (!evidence.toolInventory || evidence.toolInventory.some((tool) => tool !== "StructuredOutput")) reasons.push("No verified empty external-tool inventory.");
  return reasons;
}
