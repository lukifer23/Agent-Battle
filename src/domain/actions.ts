import type { GameAction } from "../shared.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strictly validates the two-key action envelope used at the authoritative
 * boundary: exactly `type` and `payload`, where `type` is a non-empty string and
 * `payload` is a plain object. Extra top-level keys, arrays, nulls and
 * non-object payloads are rejected. Action-variant payload keys are validated by
 * each game definition.
 */
export function parseActionEnvelope(value: unknown): GameAction | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("payload")) return undefined;
  if (typeof value.type !== "string" || value.type.length === 0) return undefined;
  if (!isPlainObject(value.payload)) return undefined;
  return { type: value.type, payload: value.payload };
}
