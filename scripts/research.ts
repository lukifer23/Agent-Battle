import { defaultGames } from "../src/domain/defaultGames.js";
import { hangmanPilotPlan, hangmanPilotSeed, makeResearchSeries } from "../src/server/researchPlan.js";
import { pairedBootstrap } from "../src/server/researchAnalysis.js";
import type { PlayerConfig } from "../src/shared.js";

const [command, modelA, modelB] = process.argv.slice(2);
const budgets = { maxPlies: 64, maxRequests: 128, maxWallMinutes: 60, maxReportedCostUsd: null };
const makeAgents = (a: string, b: string): [PlayerConfig, PlayerConfig] => [a, b].map((model, index) => ({ provider: "claude", model, name: index ? "B" : "A", reasoning: "medium" })) as [PlayerConfig, PlayerConfig];

if (command === "prepare" && modelA && modelB && process.argv.length === 5) {
  const agents = makeAgents(modelA, modelB);
  const researchPlan = { ...hangmanPilotPlan, comparison: { ...hangmanPilotPlan.comparison, kind: modelA === modelB ? "same-model-control" : "system-comparison" } };
  const series = makeResearchSeries(agents, 120, budgets, researchPlan, hangmanPilotSeed());
  // A POST body only. This command neither starts a server nor calls a provider.
  console.log(JSON.stringify({ agents, turnTimeoutSeconds: 120, budgets, researchPlan: series.researchPlan, masterSeed: series.masterSeed }, null, 2));
} else if (command === "baseline" && !modelA) {
  const series = makeResearchSeries(makeAgents("baseline-frequency", "baseline-alphabet"), 120, budgets, hangmanPilotPlan, hangmanPilotSeed());
  const orders = ["etaoinshrdlcumwfgypbvkjxqz", "abcdefghijklmnopqrstuvwxyz"];
  const rows = series.slots.map((slot) => {
    const game = defaultGames.get(slot.gameId, slot.gameVersion);
    let state = game.createState(slot.challengeSeed);
    let turns = 0;
    while (!game.isTerminal(state)) {
      if (++turns > budgets.maxPlies) throw new Error("Baseline exceeded registered action budget.");
      const playerId = game.currentPlayer(state)!;
      const agentIndex = slot.roles[playerId];
      const observation = game.observe(state, { matchId: slot.id, turnId: String(turns), player: { id: playerId, label: game.playerLabel(playerId), agent: series.agents[agentIndex] }, ply: turns, turnIndex: turns, turnTimeoutMs: 120000 });
      // The policy sees only legal actions, never the hidden word or engine state.
      const action = [...observation.legalActions!].sort((a, b) => orders[agentIndex].indexOf(String(a.payload.letter)) - orders[agentIndex].indexOf(String(b.payload.letter)))[0];
      if (!game.validateAction(state, playerId, action).valid) throw new Error("Baseline produced an invalid action.");
      state = game.applyAction(state, playerId, action);
    }
    const result = game.result(state)!;
    const roleA = Object.entries(slot.roles).find(([, index]) => index === 0)![0];
    return { blockId: slot.blockId, conditionId: slot.conditionId, replicate: slot.replicate, roles: slot.roles, challengeId: slot.challengeId,
      score: result.kind === "draw" ? 0.5 : result.winnerId === roleA ? 1 : 0, actions: turns };
  });
  const mean = (xs: number[]) => xs.reduce((sum, n) => sum + n, 0) / xs.length;
  const blocks = [...new Set(rows.map((row) => row.blockId))].map((blockId) => {
    const condition = (id: string) => mean(rows.filter((r) => r.blockId === blockId && r.conditionId === id).map((r) => r.score));
    return { blockId, difference: condition("shared") - condition("independent") };
  });
  console.log(JSON.stringify({ version: "hangman-baseline-1", claimLevel: "harness-control", providerCalls: 0,
    warning: "Fixed letter-order policies; no model-performance or capability claim. Replicates are deterministic duplicates.",
    policies: orders, planHash: series.planHash, masterSeed: series.masterSeed, matches: rows.length,
    contrast: "frequency-policy shared minus independent outcome share", estimate: mean(blocks.map((b) => b.difference)),
    confidenceInterval95: pairedBootstrap(blocks.map((b) => b.difference), `${series.planHash}:baseline`), blocks, rows }, null, 2));
} else {
  console.error("Usage: npm run research -- prepare <exact-Claude-model-A> <exact-Claude-model-B>\n       npm run research -- baseline\nOffline only. Prepare prints an API registration body; baseline runs deterministic legal-action controls.");
  process.exitCode = 1;
}
