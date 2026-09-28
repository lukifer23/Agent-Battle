import { explicitModelId, type Provider } from "../shared.js";

// Suggested pinned IDs, not account entitlement discovery. Reviewed 2026-09-28:
// https://platform.claude.com/docs/en/models/overview
const suggestedModels: Record<Provider, readonly string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: [],
  opencode: [],
};

export function modelChoices(provider: Provider, recent: string[], selected: string): string[] {
  return [...new Set([...suggestedModels[provider], ...recent, selected].filter(explicitModelId))];
}

/** Display names only. Canonical requested and resolved IDs remain on the match. */
export function modelDisplayName(id: string): string {
  if (/^claude-(sonnet|haiku|opus)-/.test(id)) {
    return id.replace(/-\d{8}$/, "").split("-").map((part, index) => index < 2 ? part[0].toUpperCase() + part.slice(1) : part).join(" ").replace(/(\d) (\d)/, "$1.$2");
  }
  if (/^gpt-\d/.test(id)) return id.replace(/^gpt/, "GPT").replace(/-(astra|sol|luna|terra)$/, (_, name: string) => ` ${name[0].toUpperCase()}${name.slice(1)}`);
  return id || "CLI default";
}
