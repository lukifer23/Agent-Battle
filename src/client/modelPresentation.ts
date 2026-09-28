/** Display names only. Canonical requested and resolved IDs remain on the match. */
export function modelDisplayName(id: string): string {
  if (/^claude-(sonnet|haiku|opus)-/.test(id)) {
    return id.replace(/-\d{8}$/, "").split("-").map((part, index) => index < 2 ? part[0].toUpperCase() + part.slice(1) : part).join(" ").replace(/(\d) (\d)/, "$1.$2");
  }
  if (/^gpt-\d/.test(id)) return id.replace(/^gpt/, "GPT").replace(/-(astra|sol|luna|terra)$/, (_, name: string) => ` ${name[0].toUpperCase()}${name.slice(1)}`);
  return id || "CLI default";
}
