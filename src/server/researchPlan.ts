import { selectWord } from "../games/hangman/corpus.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { defaultGames } from "../domain/defaultGames.js";
import { explicitModelId, PROVIDERS, sameEvaluatedSystem, type MatchBudgets, type PlayerConfig, type ResearchPlan, type SeriesRecord, type SeriesSlot } from "../shared.js";

const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: object, expected: string[]) => Object.keys(v).sort().join() === expected.sort().join();
const boundedText = (v: unknown, max = 2000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");

/** Stable hashes describe declarations, not a claim of independently verified execution. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export function validateResearchPlan(value: unknown): ResearchPlan {
  if (!object(value) || !keys(value, ["version", "title", "question", "primaryEndpoint", "practicalEffect", "analysisVersion", "conditions", "blocks", "replicates", "schedule", "comparison", "maxSlotRetries", "exclusionPolicy", "stoppingRule"])
    || value.version !== "research-plan-1" || value.analysisVersion !== "paired-block-bootstrap-1"
    || !boundedText(value.title, 160) || !boundedText(value.question) || !boundedText(value.primaryEndpoint)
    || typeof value.practicalEffect !== "number" || !Number.isFinite(value.practicalEffect) || value.practicalEffect <= 0 || value.practicalEffect > 1
    || !Number.isSafeInteger(value.blocks) || Number(value.blocks) < 1 || Number(value.blocks) > 500
    || !Number.isSafeInteger(value.replicates) || Number(value.replicates) < 1 || Number(value.replicates) > 10
    || value.schedule !== "seeded-block-interleaved" || value.exclusionPolicy !== "report-all-planned-slots" || value.stoppingRule !== "fixed-sample"
    || !Number.isSafeInteger(value.maxSlotRetries) || Number(value.maxSlotRetries) < 0 || Number(value.maxSlotRetries) > 1
    || !Array.isArray(value.conditions) || value.conditions.length < 2 || value.conditions.length > 10) throw new Error("Invalid research plan declaration.");
  const groups = new Map<string, string>();
  for (const entry of value.conditions) {
    if (!object(entry) || !keys(entry, ["id", "label", "gameId", "gameVersion", "challengeGroup", "rolePolicy"])
      || typeof entry.id !== "string" || !identifier.test(entry.id) || !boundedText(entry.label, 160)
      || typeof entry.gameId !== "string" || typeof entry.gameVersion !== "string"
      || typeof entry.challengeGroup !== "string" || !identifier.test(entry.challengeGroup)
      || !["paired", "alternating"].includes(String(entry.rolePolicy))) throw new Error("Invalid research condition.");
    const game = defaultGames.get(entry.gameId, entry.gameVersion);
    if (game.playerIds.length !== 2 || !game.series?.defaultSeriesEnabled) throw new Error("Research v1 requires registered two-player series environments.");
    if (game.series.seatSensitive && entry.rolePolicy !== "paired") throw new Error(`${entry.id} requires paired roles.`);
    if (entry.rolePolicy === "alternating" && Number(value.blocks) * Number(value.replicates) % 2 !== 0) throw new Error("Alternating conditions require an even total number of trials.");
    const previous = groups.get(entry.challengeGroup);
    if (previous && previous !== game.id) throw new Error("A challenge group cannot pair unrelated generators.");
    groups.set(entry.challengeGroup, game.id);
  }
  const ids = value.conditions.map((entry) => (entry as Record<string, unknown>).id);
  if (new Set(ids).size !== ids.length) throw new Error("Research condition IDs must be unique.");
  if (!object(value.comparison) || !keys(value.comparison, ["kind", "conditions"])
    || !["system-comparison", "same-model-control"].includes(String(value.comparison.kind))
    || !Array.isArray(value.comparison.conditions) || value.comparison.conditions.length !== 2
    || value.comparison.conditions[0] === value.comparison.conditions[1]
    || !value.comparison.conditions.every((id) => ids.includes(id))) throw new Error("Choose two distinct registered conditions for the primary contrast.");
  const conditions = value.conditions as Record<string, unknown>[];
  const [a, b] = value.comparison.conditions.map((id) => conditions.find((entry) => entry.id === id)) as Record<string, unknown>[];
  if (a.challengeGroup !== b.challengeGroup) throw new Error("The paired primary contrast requires a common challenge group.");
  const count = Number(value.blocks) * Number(value.replicates) * value.conditions.reduce((n, entry) => n + ((entry as Record<string, unknown>).rolePolicy === "paired" ? 2 : 1), 0);
  if (count > 5000) throw new Error("Research plan exceeds 5,000 slots.");
  return structuredClone(value) as unknown as ResearchPlan;
}

export function researchChallengeSeed(root: string, group: string, block: number): string {
  return createHmac("sha256", Buffer.from(root, "hex")).update(`research-challenge-1:${group}:${block}`).digest("hex");
}

/** Research limits are totals; each participant receives half (rounded down). */
export function researchMatchBudgets(budgets: MatchBudgets): MatchBudgets {
  return { maxPlies: budgets.maxPlies, maxRequests: budgets.maxRequests, maxWallMinutes: budgets.maxWallMinutes,
    maxReportedCostUsd: budgets.maxReportedCostUsd, maxRequestsPerPlayer: Math.floor(budgets.maxRequests / 2),
    maxActiveMinutesPerPlayer: Math.floor(budgets.maxWallMinutes / 2) };
}

export function makeResearchSeries(agents: [PlayerConfig, PlayerConfig], turnTimeoutSeconds: number, budgets: MatchBudgets, input: unknown, seed = randomBytes(32).toString("hex")): SeriesRecord {
  const plan = validateResearchPlan(input);
  if (!/^[0-9a-f]{64}$/.test(seed) || !Array.isArray(agents) || agents.length !== 2
    || agents.some((a) => !a || !PROVIDERS.includes(a.provider) || typeof a.name !== "string" || a.name.length > 200 || !explicitModelId(a.model) || a.model.length > 140 || /[\r\n\0]/.test(a.model)
      || a.reasoning !== undefined && (a.reasoning.length > 40 || /[\r\n\0]/.test(a.reasoning)))
    || !Number.isSafeInteger(turnTimeoutSeconds) || turnTimeoutSeconds < 30 || turnTimeoutSeconds > 600) throw new Error("Research requires explicit system identities, a valid seed and a 30–600 second timeout.");
  if ((plan.comparison.kind === "system-comparison") === sameEvaluatedSystem(agents[0], agents[1])) throw new Error("Label the same provider, model, and reasoning as a same-model control; a different provider, model, or reasoning setting as a system comparison.");
  if (!budgets || !Number.isSafeInteger(budgets.maxPlies) || budgets.maxPlies < 1 || budgets.maxPlies > 10000
    || !Number.isSafeInteger(budgets.maxRequests) || budgets.maxRequests < 2 || budgets.maxRequests > 100000
    || !Number.isSafeInteger(budgets.maxWallMinutes) || budgets.maxWallMinutes < 2 || budgets.maxWallMinutes > 10000
    || budgets.maxReportedCostUsd !== null && (!Number.isFinite(budgets.maxReportedCostUsd) || budgets.maxReportedCostUsd < 0)) throw new Error("Invalid research resource budgets.");
  const stableAgents = agents.map((a) => ({ provider: a.provider, model: a.model.trim(), reasoning: a.reasoning?.trim() ?? "", name: a.name })) as [PlayerConfig, PlayerConfig];
  const settings = { turnTimeoutSeconds, budgets: { maxPlies: budgets.maxPlies, maxRequests: budgets.maxRequests, maxWallMinutes: budgets.maxWallMinutes, maxReportedCostUsd: budgets.maxReportedCostUsd } };
  const order = (label: string) => createHmac("sha256", Buffer.from(seed, "hex")).update(`research-order-1:${label}`).digest("hex");
  const blocks = Array.from({ length: plan.blocks }, (_, n) => n).sort((a, b) => order(`block:${a}`).localeCompare(order(`block:${b}`)));
  const slots: SeriesSlot[] = [];
  for (const block of blocks) {
    const blockSlots: SeriesSlot[] = [];
    for (let replicate = 0; replicate < plan.replicates; replicate++) for (const condition of plan.conditions) {
      const game = defaultGames.get(condition.gameId, condition.gameVersion);
      const challengeSeed = game.series!.supportsSeededChallenges ? researchChallengeSeed(seed, condition.challengeGroup, block) : undefined;
      const challengeId = challengeSeed ? digest(`${condition.challengeGroup}:${challengeSeed}`) : game.series!.challengeId;
      for (let rotation = 0; rotation < (condition.rolePolicy === "paired" ? 2 : 1); rotation++) {
        const first = (condition.rolePolicy === "paired" ? rotation : (block + replicate) % 2) as 0 | 1;
        blockSlots.push({ id: randomUUID(), ordinal: 0, gameId: game.id, gameVersion: game.version, conditionId: condition.id,
          blockId: `block-${block}`, replicate, challengeId, ...(challengeSeed ? { challengeSeed } : {}),
          roles: { [game.playerIds[0]]: first, [game.playerIds[1]]: (1 - first) as 0 | 1 }, matchIds: [], skipped: false });
      }
    }
    const slotKey = (s: SeriesSlot) => `${block}:${s.conditionId}:${s.replicate}:${Object.values(s.roles).join()}`;
    blockSlots.sort((a, b) => order(slotKey(a)).localeCompare(order(slotKey(b))));
    slots.push(...blockSlots);
  }
  slots.forEach((slot, ordinal) => { slot.ordinal = ordinal; });
  const now = new Date().toISOString();
  return { id: randomUUID(), version: "battle-series-3", researchPlan: plan, planHash: digest(canonicalJson({ plan, agents: stableAgents, settings })),
    seedCommitment: digest(seed), masterSeed: seed, agents: stableAgents, settings, slots, createdAt: now, updatedAt: now, status: "ready" };
}

export const hangmanPilotPlan: ResearchPlan = {
  version: "research-plan-1", title: "Hangman construct-sensitivity pilot",
  question: "Does information sharing and scoring change the comparison on matched words?",
  primaryEndpoint: "Agent A shared-board outcome share minus independent-lane outcome share, paired by word block.",
  practicalEffect: 0.15, analysisVersion: "paired-block-bootstrap-1", blocks: 24, replicates: 2,
  schedule: "seeded-block-interleaved", comparison: { kind: "system-comparison", conditions: ["independent", "shared"] },
  maxSlotRetries: 1, exclusionPolicy: "report-all-planned-slots", stoppingRule: "fixed-sample",
  conditions: [
    { id: "independent", label: "Independent lexical inference", gameId: "hangman", gameVersion: "independent-lanes-1", challengeGroup: "hangman-words", rolePolicy: "alternating" },
    { id: "shared", label: "Shared information and scoring", gameId: "hangman", gameVersion: "shared-board-2", challengeGroup: "hangman-words", rolePolicy: "paired" },
  ],
};

/** Public pilot suite, not a contamination-resistant benchmark. Select before any model outputs. */
export function hangmanPilotSeed(): string {
  for (let nonce = 0; nonce < 10000; nonce++) {
    const seed = digest(`agent-battle/hangman-construct-pilot-v1/2026-09-28:${nonce}`);
    const words = Array.from({ length: 24 }, (_, block) => selectWord(researchChallengeSeed(seed, "hangman-words", block)).word);
    if (new Set(words).size === words.length) return seed;
  }
  throw new Error("Could not derive a distinct-word pilot suite.");
}
