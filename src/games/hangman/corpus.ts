import { createHash, createHmac, randomBytes } from "node:crypto";
import words from "@nkzw/safe-word-list";

export const CORPUS = Object.freeze([...new Set(words.map((word) => word.toLowerCase()).filter((word) => /^[a-z]{5,12}$/.test(word)))].sort());
export const CORPUS_HASH = createHash("sha256").update(`${CORPUS.join("\n")}\n`).digest("hex");
export interface WordProvenance {
  package: "@nkzw/safe-word-list";
  packageVersion: "3.1.2";
  filterVersion: "ascii-5-12-sort-v1";
  corpusHash: string;
  generator: "hmac-sha256-counter-v1";
  seed: string;
  index: number;
}

export function selectWord(seed = randomBytes(32).toString("hex")): { word: string; provenance: WordProvenance } {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("Invalid word seed.");
  const limit = Math.floor(0x100000000 / CORPUS.length) * CORPUS.length;
  for (let counter = 0; ; counter++) {
    const block = createHmac("sha256", Buffer.from(seed, "hex")).update(`hangman-word-v1:${counter}`).digest();
    for (let offset = 0; offset < block.length; offset += 4) {
      const value = block.readUInt32BE(offset);
      if (value >= limit) continue;
      const index = value % CORPUS.length;
      return { word: CORPUS[index]!, provenance: { package: "@nkzw/safe-word-list", packageVersion: "3.1.2", filterVersion: "ascii-5-12-sort-v1", corpusHash: CORPUS_HASH, generator: "hmac-sha256-counter-v1", seed, index } };
    }
  }
}
