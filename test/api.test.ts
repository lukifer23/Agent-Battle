import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import { join } from "node:path";

const projectRoot = process.cwd();
const tsxBin = join(projectRoot, "node_modules", ".bin", "tsx");

interface ProbeResult { status: number; headers: Record<string, string | string[] | undefined>; body: string; }

function probe(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function waitForListening(child: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    let output = "";
    const poll = async () => {
      if (Date.now() > deadline) { reject(new Error(`server did not start; output=${output}`)); return; }
      try {
        const result = await probe(port, { path: "/api/state" });
        if (result.status === 200) { resolve(); return; }
      } catch { /* not up yet */ }
      setTimeout(poll, 150);
    };
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    void poll();
  });
}

async function startServer(): Promise<{ child: ChildProcess; port: number; folder: string }> {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-api-"));
  const port = 4400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [tsxBin, "src/server/index.ts"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), AGENT_BATTLE_DATA_DIR: folder, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForListening(child, port);
  return { child, port, folder };
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 8000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

test("the API exposes a unified snapshot and rejects untrusted hosts and origins", async () => {
  const { child, port, folder } = await startServer();
  try {
    const state = await probe(port, { path: "/api/state" });
    assert.equal(state.status, 200);
    const snapshot = JSON.parse(state.body) as { revision?: number; activeMatchId?: unknown; recentMatches?: unknown };
    assert.equal(typeof snapshot.revision, "number");
    assert.equal(snapshot.activeMatchId, null);
    assert.ok(Array.isArray(snapshot.recentMatches));

    const unknown = await probe(port, { path: "/api/not-a-route" });
    assert.equal(unknown.status, 404);
    assert.equal((JSON.parse(unknown.body) as { code?: string }).code, "not_found");

    const foreignHost = await probe(port, { method: "POST", path: "/api/providers/refresh", headers: { host: "untrusted.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(foreignHost.status, 403);
    assert.equal((JSON.parse(foreignHost.body) as { code?: string }).code, "forbidden_host");

    const foreignOrigin = await probe(port, { method: "POST", path: "/api/providers/refresh", headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(foreignOrigin.status, 403);
    assert.equal((JSON.parse(foreignOrigin.body) as { code?: string }).code, "forbidden_origin");

    const allowedOrigin = await probe(port, { method: "POST", path: "/api/providers/refresh", headers: { host: `127.0.0.1:${port}`, origin: "http://127.0.0.1:5173", "content-type": "application/json" }, body: "{}" });
    assert.equal(allowedOrigin.status, 200);

    const malformed = await probe(port, { method: "POST", path: "/api/providers/refresh", headers: { host: `127.0.0.1:${port}`, origin: "http://127.0.0.1:5173", "content-type": "application/json" }, body: "{ not json" });
    assert.equal(malformed.status, 400);
    assert.equal((JSON.parse(malformed.body) as { code?: string }).code, "invalid_json");

    const missingMatch = await probe(port, { method: "POST", path: "/api/matches/does-not-exist/stop", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(missingMatch.status, 404);
  } finally {
    await stopServer(child);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the event stream opens with a canonical snapshot event", async () => {
  const { child, port, folder } = await startServer();
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: "/api/events", headers: { accept: "text/event-stream" } }, (response) => {
        let data = "";
        response.on("data", (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes("event: snapshot")) { response.destroy(); resolve(data); }
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
      setTimeout(() => reject(new Error("no snapshot event received")), 8000).unref();
    });
    assert.match(body, /event: snapshot/);
    assert.match(body, /"revision":/);
  } finally {
    await stopServer(child);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("unsupported saved versions stop startup without rewriting the store", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-unsupported-store-"));
  const path = join(folder, "matches.json");
  const source = JSON.stringify({ version: 999, matches: [] });
  writeFileSync(path, source);
  const child = spawn(process.execPath, [tsxBin, "src/server/index.ts"], {
    cwd: projectRoot, env: { ...process.env, PORT: "0", AGENT_BATTLE_DATA_DIR: folder }, stdio: "ignore",
  });
  try {
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 1);
    assert.equal(readFileSync(path, "utf8"), source);
  } finally { child.kill("SIGKILL"); rmSync(folder, { recursive: true, force: true }); }
});

test("quarantined records produce a recovery notice in the state API", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-quarantine-api-"));
  const path = join(folder, "matches.json");
  const port = 4800 + Math.floor(Math.random() * 200);
  writeFileSync(path, JSON.stringify({ version: 3, matches: [{ id: "bad" }] }));
  const child = spawn(process.execPath, [tsxBin, "src/server/index.ts"], {
    cwd: projectRoot, env: { ...process.env, PORT: String(port), AGENT_BATTLE_DATA_DIR: folder }, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForListening(child, port);
    const response = await probe(port, { path: "/api/state" });
    const state = JSON.parse(response.body) as { storage?: { status: string; message: string } };
    assert.equal(state.storage?.status, "quarantined");
    assert.match(state.storage?.message ?? "", /quarantined/);
  } finally { await stopServer(child); rmSync(folder, { recursive: true, force: true }); }
});

test("Hangman HTTP, SSE, events, attempts, exports, persistence and subprocess completion respect reveal boundary", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-hangman-api-"));
  const { mkdirSync, chmodSync } = await import("node:fs");
  const bin = join(folder, "bin"); mkdirSync(bin);
  const fixture = join(bin, "codex");
  writeFileSync(fixture, `#!${process.execPath}\n${readFileSync(join(projectRoot, "test/fixtures/hangman-cli.cjs"), "utf8")}`); chmodSync(fixture, 0o700);
  const port = 5200 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [tsxBin, "src/server/index.ts"], { cwd: projectRoot, env: { ...process.env, PORT: String(port), AGENT_BATTLE_DATA_DIR: folder, PATH: `${bin}:/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
  const request = async (path: string, body?: unknown) => {
    const result = await probe(port, { path, ...(body ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    assert.ok(result.status < 300, result.body); return JSON.parse(result.body);
  };
  try {
    await waitForListening(child, port);
    const player = { provider: "codex", model: "fixture" };
    const secondPlayer = { provider: "codex", model: "fixture-b" };
    const mirror = await probe(port, { path: "/api/matches", method: "POST", body: JSON.stringify({ gameId: "hangman", players: { player1: player, player2: player }, turnTimeoutSeconds: 30 }), headers: { "content-type": "application/json" } });
    assert.equal(mirror.status, 400);
    assert.match(mirror.body, /two explicit, different model IDs/);
    let created;
    let word = "";
    for (let candidate = 0; candidate < 50; candidate++) {
      created = await request("/api/matches", { gameId: "hangman", players: { player1: player, player2: secondPlayer }, turnTimeoutSeconds: 30 });
      const privateStore = JSON.parse(readFileSync(join(folder, "matches.json"), "utf8"));
      word = privateStore.matches[0].gameState.word;
      // A distinctive canary avoids matching ordinary JSON keys such as status.
      if (word.length >= 9 && !JSON.stringify(created).includes(word)) break;
      await request(`/api/matches/${created.match.id}/stop`, {});
    }
    assert.equal(created.match.status, "ready");
    const id = created.match.id;
    writeFileSync(join(bin, "fixture-config.json"), JSON.stringify({ word, delayMs: 600 }));
    assert.equal(JSON.stringify(created).includes(word), false);
    assert.equal("provenance" in created.match.gameState, false);
    const started = await request(`/api/matches/${id}/start`, {});
    assert.equal(JSON.stringify(started).includes(word), false);
    for (const route of ["/api/state", "/api/matches", `/api/matches/${id}`, `/api/matches/${id}/events`, `/api/matches/${id}/attempts`]) {
      const value = await request(route); assert.equal(JSON.stringify(value).includes(word), false, route);
    }
    const stream = await fetch(`http://127.0.0.1:${port}/api/events`);
    const reader = stream.body!.getReader(); const first = await reader.read(); await reader.cancel();
    assert.equal(new TextDecoder().decode(first.value).includes(word), false);
    await new Promise((resolve) => setTimeout(resolve, 850));
    const early = await request(`/api/matches/${id}`);
    assert.equal(early.match.gameState.lanes.player1.sealed, true);
    assert.equal(JSON.stringify(early).includes(word), false);
    const pending = early.match.pendingTurn.attempts.at(-1);
    assert.equal(pending.status, "started"); assert.ok(pending.invocationId); assert.ok(pending.deadlineAt);
    await request(`/api/matches/${id}/pause`, {});
    const paused = await request(`/api/matches/${id}`);
    assert.equal(paused.match.status, "paused"); assert.equal(JSON.stringify(paused).includes(word), false);
    await request(`/api/matches/${id}/start`, {});
    let finished;
    for (let i = 0; i < 80; i++) {
      finished = await request(`/api/matches/${id}`);
      if (finished.match.status === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(finished.match.status, "finished"); assert.equal(finished.match.gameState.word, word);
    assert.equal(finished.match.result.winnerId, "player1");
    assert.ok(finished.match.replay.length >= 4);
    assert.equal(JSON.stringify(finished.match.replay.slice(0, -1)).includes(word), false);
    const historicalEvents = (await request(`/api/matches/${id}/events`)).events as Array<{ payload?: { publicState?: { terminal: boolean } } }>;
    for (const event of historicalEvents) if (event.payload?.publicState && !event.payload.publicState.terminal) {
      assert.equal(JSON.stringify(event).includes(word), false, "pre-terminal event was changed by final reveal");
    }
    const raw = JSON.parse(readFileSync(join(folder, "matches.json"), "utf8"));
    assert.equal(raw.matches[0].gameState.word, word);
    assert.equal(raw.version, 6);
    for (const event of raw.matches[0].events) {
      if (JSON.stringify(event).includes(word)) assert.equal(event.payload?.publicState?.terminal, true);
    }
    const list = await request("/api/matches");
    for (const key of ["gameState", "pendingTurn", "history", "events", "responseExcerpt", "stderrExcerpt"]) assert.equal(key in list.matches[0], false);
  } finally { await stopServer(child); rmSync(folder, { recursive: true, force: true }); }
});

test("series API persists private challenges and blocks unqualified Codex scoring", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-series-api-"));
  const { mkdirSync, chmodSync } = await import("node:fs");
  const bin = join(folder, "bin"); mkdirSync(bin);
  const fixture = join(bin, "codex");
  writeFileSync(fixture, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex fixture 1'); process.exit(0); }`); chmodSync(fixture, 0o700);
  const port = 5500 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [tsxBin, "src/server/index.ts"], { cwd: projectRoot,
    env: { ...process.env, PORT: String(port), AGENT_BATTLE_DATA_DIR: folder, PATH: `${bin}:/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
  const request = async (path: string, body?: unknown) => {
    const result = await probe(port, { path, ...(body ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return { status: result.status, value: JSON.parse(result.body) };
  };
  try {
    await waitForListening(child, port);
    const invalid = await request("/api/series", { agents: [{ provider: "codex", model: "" }, { provider: "codex", model: "fixture-b" }] });
    assert.equal(invalid.status, 400);
    const created = await request("/api/series", { agents: [{ provider: "codex", model: "fixture-a" }, { provider: "codex", model: "fixture-b" }] });
    assert.equal(created.status, 201);
    const id = created.value.series.id as string;
    const store = JSON.parse(readFileSync(join(folder, "matches.json"), "utf8"));
    const seed = store.series[0].slots.find((slot: { gameId: string }) => slot.gameId === "hangman").challengeSeed as string;
    assert.equal(JSON.stringify(created.value).includes(seed), false);
    assert.equal((await request(`/api/series/${id}/start`, {})).status, 200);
    let detail;
    for (let i = 0; i < 50; i++) {
      detail = (await request(`/api/series/${id}`)).value.series;
      if (detail.status === "paused") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(detail.status, "paused");
    assert.equal(detail.slots[0].status, "unscored");
    assert.equal(JSON.stringify((await request(`/api/series/${id}/export`)).value).includes(seed), false);
    assert.equal((await request(`/api/series/${id}/stop`, {})).status, 200);
  } finally { await stopServer(child); rmSync(folder, { recursive: true, force: true }); }
});

test("Battleship HTTP, SSE, events, attempts and replay hide fleets until terminal reveal", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-battleship-api-"));
  const { mkdirSync, chmodSync } = await import("node:fs");
  const bin = join(folder, "bin"); mkdirSync(bin);
  const fixture = join(bin, "codex");
  writeFileSync(fixture, `#!${process.execPath}\n${readFileSync(join(projectRoot, "test/fixtures/battleship-cli.cjs"), "utf8")}`); chmodSync(fixture, 0o700);
  const port = 5800 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [tsxBin, "src/server/index.ts"], { cwd: projectRoot,
    env: { ...process.env, PORT: String(port), AGENT_BATTLE_DATA_DIR: folder, PATH: `${bin}:/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
  const request = async (path: string, body?: unknown) => {
    const result = await probe(port, { path, ...(body ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    assert.ok(result.status < 300, result.body);
    return JSON.parse(result.body);
  };
  try {
    await waitForListening(child, port);
    const created = await request("/api/matches", { gameId: "battleship", players: { player1: { provider: "codex", model: "fixture-a" }, player2: { provider: "codex", model: "fixture-b" } }, turnTimeoutSeconds: 30 });
    const id = created.match.id;
    const hiddenPlacement = '"ship":"carrier","start":"a1"';
    assert.equal(JSON.stringify(created).includes(hiddenPlacement), false);
    await request(`/api/matches/${id}/start`, {});
    for (const route of ["/api/state", "/api/matches", `/api/matches/${id}`, `/api/matches/${id}/events`, `/api/matches/${id}/attempts`]) {
      assert.equal(JSON.stringify(await request(route)).includes(hiddenPlacement), false, route);
    }
    const stream = await fetch(`http://127.0.0.1:${port}/api/events`);
    const reader = stream.body!.getReader(); const first = await reader.read(); await reader.cancel();
    assert.equal(new TextDecoder().decode(first.value).includes(hiddenPlacement), false);
    let finished;
    for (let i = 0; i < 200; i++) {
      finished = await request(`/api/matches/${id}`);
      if (finished.match.status === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(finished.match.status, "finished");
    assert.equal(finished.match.result.winnerId, "player1");
    assert.equal(JSON.stringify(finished.match.gameState).includes(hiddenPlacement), true);
    assert.equal(JSON.stringify(finished.match.replay.slice(0, -1)).includes("placements"), false);
    assert.equal(JSON.stringify(finished.match.history).includes(hiddenPlacement), false);
    const events = (await request(`/api/matches/${id}/events`)).events as Array<{ payload?: { publicState?: { terminal?: boolean } } }>;
    for (const event of events) if (event.payload?.publicState && !event.payload.publicState.terminal) assert.equal(JSON.stringify(event).includes("placements"), false);
    const privateStore = JSON.parse(readFileSync(join(folder, "matches.json"), "utf8"));
    assert.equal(privateStore.matches[0].gameState.fleets.player1[0].start, "a1");
  } finally { await stopServer(child); rmSync(folder, { recursive: true, force: true }); }
});
