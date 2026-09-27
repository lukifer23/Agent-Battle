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
