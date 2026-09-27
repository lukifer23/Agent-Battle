import { existsSync } from "node:fs";
import { MatchStore } from "../../src/server/store.js";

const [storePath, gatePath] = process.argv.slice(2);
if (!storePath || !gatePath) throw new Error("Missing lock worker paths.");
while (!existsSync(gatePath)) await new Promise((resolve) => setTimeout(resolve, 2));
const store = new MatchStore(storePath);
try {
  store.acquireOwnership();
  process.stdout.write("acquired\n");
  await new Promise((resolve) => setTimeout(resolve, 200));
  store.releaseOwnership();
} catch {
  process.stdout.write("blocked\n");
}
