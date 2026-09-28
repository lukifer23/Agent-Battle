import { hangmanPilotPlan, hangmanPilotSeed } from "./researchPlan.js";
import { analyzeResearchSeries } from "./researchAnalysis.js";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { PROVIDERS, distinctExplicitModels, type MatchRecord, type PlayerConfig, type Provider, type SeriesRecord } from "../shared.js";
import { AgentRegistry } from "../domain/agent.js";
import { MatchController } from "../domain/MatchController.js";
import { defaultGames } from "../domain/defaultGames.js";
import { summaryOf, projectRecord, projectEvent } from "../domain/projection.js";
import { agentRegistryDefaults, detectProviders } from "./adapters.js";
import { acquireStoreOwnership, loadMatches, releaseStoreOwnership, saveMatches, STORE_VERSION } from "./store.js";
import { shouldPersistChange, shouldPublishSnapshot } from "./eventPolicy.js";
import { SeriesManager, publicSeries, seriesExport } from "./series.js";

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT || 4173);

try {
  acquireStoreOwnership();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not acquire the match store lock.");
  process.exit(1);
}

let storedMatches: MatchRecord[] = [];
let storedSeries: SeriesRecord[] = [];
let storageWarning: string | null = null;
try {
  const loaded = loadMatches();
  storedMatches = loaded.matches;
  storedSeries = loaded.series;
  storageWarning = loaded.recoveryWarning ?? null;
  if (loaded.migrated) {
    console.log(`Migrated saved matches to store version ${STORE_VERSION}.${loaded.backupPath ? ` Backup: ${loaded.backupPath}.` : ""}${loaded.quarantined ? ` Quarantined ${loaded.quarantined} invalid record(s).` : ""}`);
  }
} catch (error) {
  console.error(`Could not load saved matches: ${error instanceof Error ? error.message : "unknown error"}`);
  releaseStoreOwnership();
  process.exit(1);
}

const eventClients = new Set<Response>();
const providerCache = { value: detectProviders() };
let shuttingDown = false;

const allowedHostnames = new Set(["127.0.0.1", "localhost", "::1"]);
const allowedOrigins = new Set([port, 5173].flatMap((value) => [`http://127.0.0.1:${value}`, `http://localhost:${value}`]));

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((request, response, next) => {
  if (shuttingDown && request.path.startsWith("/api")) {
    response.status(503).json({ error: "The server is shutting down.", code: "shutting_down" });
    return;
  }
  const host = hostnameOf(request.headers.host);
  if (host && !allowedHostnames.has(host)) {
    response.status(403).json({ error: "Unexpected Host header.", code: "forbidden_host" });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: "Cross-site control requests are not allowed.", code: "forbidden_origin" });
      return;
    }
  }
  next();
});

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try { return new URL(`http://${host}`).hostname; }
  catch { return undefined; }
}

function writeToClient(response: Response, event: string, data: string, id?: string): void {
  if (response.writableEnded) return;
  try {
    if (typeof response.writableLength === "number" && response.writableLength > 1_000_000) {
      eventClients.delete(response);
      response.end();
      return;
    }
    if (id) response.write(`id: ${id}\n`);
    response.write(`event: ${event}\ndata: ${data}\n\n`);
  } catch {
    eventClients.delete(response);
    try { response.end(); } catch { /* The client is already gone. */ }
  }
}

const metricsEnabled = process.env.AGENT_BATTLE_METRICS === "1";

function logMetric(name: string, fields: Record<string, number | string>): void {
  if (!metricsEnabled) return;
  console.log(`[metrics] ${name} ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ")}`);
}

function withStorage(snapshot: import("../shared.js").AppState): import("../shared.js").AppState {
  const failure = controller.getStorageError();
  if (failure) return { ...snapshot, storage: { status: "write_failed", message: failure } };
  if (storageWarning) return { ...snapshot, storage: { status: "quarantined", message: storageWarning } };
  return { ...snapshot, storage: { status: "healthy", message: "" } };
}

function publishSnapshot(): void {
  const started = Date.now();
  void controller.snapshot().then(withStorage).then((snapshot) => {
    const encoded = JSON.stringify(snapshot);
    logMetric("snapshot", { bytes: Buffer.byteLength(encoded), matches: snapshot.recentMatches.length, ms: Date.now() - started });
    for (const response of eventClients) writeToClient(response, "snapshot", encoded);
  }).catch(() => undefined);
}

function stateChanged(record: MatchRecord, event?: import("../shared.js").MatchEvent): void {
  if (shouldPersistChange(event)) {
    const started = Date.now();
    saveMatches(storedMatches, storedSeries);
    logMetric("checkpoint", { matches: storedMatches.length, ms: Date.now() - started });
  }
  if (event) {
    const encoded = JSON.stringify({ matchId: record.id, ...(event.sequence === undefined ? { transient: true } : { revision: event.sequence }), event });
    logMetric("event", { type: event.type, bytes: Buffer.byteLength(encoded) });
    for (const response of eventClients) writeToClient(response, event.type, encoded, event.sequence === undefined ? undefined : `${record.id}:${event.sequence}`);
  }
  if (shouldPublishSnapshot(event) || record.gameId === "hangman" || event?.type === "agent.started") publishSnapshot();
  if (event) seriesManager?.onMatchChange(record);
}

const games = defaultGames;
const agentDefaults = agentRegistryDefaults();
const agents = new AgentRegistry()
  .register("codex", agentDefaults.codex)
  .register("claude", agentDefaults.claude)
  .register("opencode", agentDefaults.opencode);
let controller: MatchController;
let seriesManager: SeriesManager | undefined;
try {
  controller = new MatchController(games, agents, storedMatches, () => providerCache.value, stateChanged, () => {
    const candidate = controller.getRecoveryCandidate();
    if (candidate) {
      try { writeFileSync(join(process.env.AGENT_BATTLE_DATA_DIR ?? join(process.cwd(), "data"), `unsaved-recovery-${candidate.id}-${Date.now()}.json`), JSON.stringify(candidate), { mode: 0o600, flag: "wx" }); }
      catch { console.error("Unable to persist the private recovery candidate; it remains in memory until shutdown."); }
    }
    publishSnapshot();
  });
  seriesManager = new SeriesManager(storedSeries, controller, () => saveMatches(storedMatches, storedSeries));
} catch (error) {
  console.error("Could not restore saved matches.", error);
  releaseStoreOwnership();
  process.exit(1);
}

function errorResponse(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : "Request failed.";
  if (/not found/i.test(message)) return { status: 404, code: "not_found", message };
  if (/already active|already running|already being created|cannot be paused|not ready to start|resume or stop|only a ready/i.test(message)) return { status: 409, code: "conflict", message };
  if (/could not (be )?sav|storage|disk/i.test(message)) return { status: 503, code: "storage_error", message };
  return { status: 400, code: "invalid_request", message };
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response) => {
    void handler(request, response).catch((error: unknown) => {
      const mapped = errorResponse(error);
      response.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    });
  };
}

function parsePlayer(raw: unknown): PlayerConfig {
  if (!raw || typeof raw !== "object") throw new Error("Player configuration is missing.");
  const value = raw as Record<string, unknown>;
  if (!PROVIDERS.includes(value.provider as Provider)) throw new Error("Unsupported agent CLI.");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const reasoning = typeof value.reasoning === "string" ? value.reasoning.trim() : "";
  if (/[\r\n\0]/.test(model + reasoning)) throw new Error("Model settings cannot contain newlines.");
  if (model.length > 140 || reasoning.length > 40) throw new Error("Model must be at most 140 characters and reasoning at most 40 characters.");
  const provider = value.provider as Provider;
  return {
    provider,
    model,
    reasoning,
    name: `${provider}${model ? ` · ${model}` : " · CLI default"}`,
  };
}

function matchIdOf(request: Request): string {
  const value = request.params.id;
  return Array.isArray(value) ? value[0] : value;
}

app.get("/api/state", asyncRoute(async (_request, response) => {
  response.json(withStorage(await controller.snapshot()));
}));

function pageParams(request: Request): { limit: number; offset: number } {
  const rawLimit = Number(request.query.limit ?? 50);
  const rawOffset = Number(request.query.offset ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.min(1_000_000, Math.max(0, Math.floor(rawOffset))) : 0;
  return { limit, offset };
}

app.get("/api/matches", (request, response) => {
  const { limit, offset } = pageParams(request);
  response.json({
    total: storedMatches.length,
    offset,
    limit,
    matches: storedMatches.slice(offset, offset + limit).map(summaryOf),
  });
});

app.get("/api/matches/:id", (request, response) => {
  const match = controller.get(matchIdOf(request));
  if (!match) { response.status(404).json({ error: "Match not found.", code: "not_found" }); return; }
  response.json({ match: projectRecord(match, 500) });
});

app.get("/api/matches/:id/events", (request, response) => {
  const match = controller.get(matchIdOf(request));
  if (!match) { response.status(404).json({ error: "Match not found.", code: "not_found" }); return; }
  const { limit, offset } = pageParams(request);
  response.json({ total: match.events.length, offset, limit, events: match.events.slice(offset, offset + limit).map((event) => projectEvent(match, event)) });
});

app.get("/api/matches/:id/attempts", (request, response) => {
  const match = controller.get(matchIdOf(request));
  if (!match) { response.status(404).json({ error: "Match not found.", code: "not_found" }); return; }
  const { limit, offset } = pageParams(request);
  const publicMatch = projectRecord(match);
  const attempts = [...publicMatch.history, ...(publicMatch.pendingTurn ? [publicMatch.pendingTurn] : [])].flatMap((turn) => turn.attempts.map((attempt) => ({ turnId: turn.turnId, ply: turn.ply, turnIndex: turn.turnIndex, playerId: turn.playerId, ...attempt })));
  response.json({ total: attempts.length, offset, limit, attempts: attempts.slice(offset, offset + limit) });
});

app.get("/api/games", (_request, response) => response.json({ games: games.list(), versions: games.listVersions() }));
app.get("/api/research/presets", (_request, response) => response.json({ presets: [{ id: "hangman-pilot", plan: hangmanPilotPlan, expectedMatches: 144, expectedRequests: [1500, 5000] }] }));
app.get("/api/series/:id/analysis", (request, response) => {
  try { response.json(analyzeResearchSeries(seriesManager!.get(matchIdOf(request)), storedMatches)); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : "Analysis unavailable.", code: "analysis_unavailable" }); }
});

app.get("/api/series", (_request, response) => response.json({ series: seriesManager!.list().map((record) => publicSeries(record, storedMatches)) }));
app.get("/api/series/:id", (request, response) => {
  try { response.json({ series: publicSeries(seriesManager!.get(matchIdOf(request)), storedMatches) }); }
  catch { response.status(404).json({ error: "Series not found.", code: "not_found" }); }
});
app.get("/api/series/:id/export", (request, response) => {
  try { response.json(seriesExport(seriesManager!.get(matchIdOf(request)), storedMatches)); }
  catch { response.status(404).json({ error: "Series not found.", code: "not_found" }); }
});
app.post("/api/series", asyncRoute(async (request, response) => {
  const body = request.body as Record<string, unknown>;
  if (!Array.isArray(body.agents) || body.agents.length !== 2) throw new Error("Series requires two agents.");
  const parsed = body.agents.map(parsePlayer);
  if (parsed.some((agent) => !agent.model.trim())) throw new Error("Series requires explicit model IDs for both agents.");
  const detected = await providerCache.value;
  for (const agent of parsed) if (!detected.some((provider) => provider.provider === agent.provider && provider.installed)) throw new Error(`${agent.provider} CLI is unavailable.`);
  const raw = body.budgets && typeof body.budgets === "object" ? body.budgets as Record<string, unknown> : {};
  const budgets = { maxPlies: Number(raw.maxPlies ?? 250), maxRequests: Number(raw.maxRequests ?? 500), maxWallMinutes: Number(raw.maxWallMinutes ?? 30),
    maxReportedCostUsd: raw.maxReportedCostUsd === undefined || raw.maxReportedCostUsd === null || raw.maxReportedCostUsd === "" ? null : Number(raw.maxReportedCostUsd) };
  const plan = body.plan as import("../shared.js").SeriesPlan | undefined;
  if (body.researchPreset !== undefined && body.researchPreset !== "hangman-pilot") throw new Error("Unknown research preset.");
  if (body.researchPreset && (body.plan || body.researchPlan || body.masterSeed)) throw new Error("A preset cannot be combined with another plan or root.");
  const researchPlan = body.researchPreset ? { ...structuredClone(hangmanPilotPlan), comparison: { ...hangmanPilotPlan.comparison, kind: distinctExplicitModels(parsed[0], parsed[1]) ? "system-comparison" : "same-model-control" } } : body.researchPlan;
  const seed = body.researchPreset ? hangmanPilotSeed() : typeof body.masterSeed === "string" ? body.masterSeed : undefined;
  const created = seriesManager!.create(parsed as [PlayerConfig, PlayerConfig], Number(body.turnTimeoutSeconds ?? 120), budgets, plan, seed, researchPlan);
  response.status(201).json({ series: publicSeries(created, storedMatches) });
}));
for (const command of ["start", "pause", "stop", "retry", "skip"] as const) {
  app.post(`/api/series/:id/${command}`, asyncRoute(async (request, response) => {
    const id = matchIdOf(request);
    if (command === "start") await seriesManager!.start(id);
    else if (command === "pause") await seriesManager!.pause(id);
    else if (command === "stop") await seriesManager!.stop(id);
    else if (command === "retry") seriesManager!.retry(id);
    else seriesManager!.skip(id);
    response.json({ series: publicSeries(seriesManager!.get(id), storedMatches) });
  }));
}

app.get("/api/events", (request: Request, response: Response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  eventClients.add(response);
  void controller.snapshot().then((snapshot) => writeToClient(response, "snapshot", JSON.stringify(withStorage(snapshot)))).catch(() => undefined);
  const heartbeat = setInterval(() => writeToClient(response, "keepalive", JSON.stringify({ at: new Date().toISOString() })), 20_000);
  heartbeat.unref();
  request.on("close", () => { clearInterval(heartbeat); eventClients.delete(response); });
});

app.post("/api/matches", asyncRoute(async (request, response) => {
  if (seriesManager!.list().some((record) => ["ready", "running", "paused"].includes(record.status))) throw new Error("Finish or stop the current series before creating a casual match.");
  const body = request.body as Record<string, unknown>;
  const rawBudgets = (body.budgets && typeof body.budgets === "object" ? body.budgets : {}) as Record<string, unknown>;
  const costLimit = rawBudgets.maxReportedCostUsd;
  const gameId = typeof body.gameId === "string" ? body.gameId : "chess";
  const game = games.get(gameId, typeof body.gameVersion === "string" ? body.gameVersion : undefined);
  if (body.players && (body.white || body.black)) throw new Error("Do not mix player formats.");
  const rawPlayers = body.players ?? (gameId === "chess" ? { white: body.white, black: body.black } : undefined);
  if (!rawPlayers || typeof rawPlayers !== "object" || Object.keys(rawPlayers).sort().join() !== [...game.playerIds].sort().join()) throw new Error("Player roles do not match the game.");
  const players = Object.fromEntries(game.playerIds.map((id) => [id, parsePlayer((rawPlayers as Record<string, unknown>)[id])]));
  if (!distinctExplicitModels(players[game.playerIds[0]], players[game.playerIds[1]])) {
    throw new Error("A comparison requires two explicit, different model IDs. CLI defaults and mirror models cannot establish distinct competitors.");
  }
  const created = await controller.create({
    gameId, gameVersion: game.version,
    players,
    turnTimeoutSeconds: Number(body.turnTimeoutSeconds ?? 120),
    budgets: {
      maxPlies: Number(rawBudgets.maxPlies ?? 250),
      maxRequests: Number(rawBudgets.maxRequests ?? 500),
      maxWallMinutes: Number(rawBudgets.maxWallMinutes ?? 30),
      maxReportedCostUsd: costLimit === undefined || costLimit === null || costLimit === "" ? null : Number(costLimit),
    },
  });
  response.status(201).json({ match: projectRecord(created) });
}));

app.post("/api/matches/:id/start", asyncRoute(async (request, response) => {
  const match = await controller.start(matchIdOf(request));
  response.json({ match: projectRecord(match, 500) });
}));

app.post("/api/matches/:id/pause", asyncRoute(async (request, response) => {
  await controller.pause(matchIdOf(request));
  response.json({ paused: true });
}));

app.post("/api/matches/:id/stop", asyncRoute(async (request, response) => {
  await controller.stop(matchIdOf(request));
  response.json({ stopped: true });
}));

app.post("/api/providers/refresh", asyncRoute(async (_request, response) => {
  providerCache.value = detectProviders();
  response.json({ providers: await providerCache.value });
}));

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "Unknown API route.", code: "not_found" });
});

const webRoot = fileURLToPath(new URL("../../dist/web", import.meta.url));
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get("*splat", (_request, response) => response.sendFile(join(webRoot, "index.html")));
} else {
  app.get("/", (_request, response) => response.type("text").send("Agent Battle API is running. Start the Vite dev server with npm run dev."));
}

app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
  if (response.headersSent) { next(error); return; }
  if (error instanceof SyntaxError || (error as { type?: string })?.type === "entity.parse.failed") {
    response.status(400).json({ error: "Request body is not valid JSON.", code: "invalid_json" });
    return;
  }
  console.error("Unhandled API error.", error);
  response.status(500).json({ error: "Internal server error.", code: "internal_error" });
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`Agent Battle listening at http://127.0.0.1:${port}`);
});

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const budget = setTimeout(() => process.exit(1), 10_000);
  budget.unref();
  void (async () => {
    let failed = false;
    try { await controller.shutdown(); }
    catch (error) { failed = true; console.error("Shutdown checkpoint failed.", error); }
    for (const client of [...eventClients]) {
      try { client.end(); } catch { /* The client may already be gone. */ }
    }
    eventClients.clear();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      const fallback = setTimeout(resolve, 2000);
      fallback.unref();
    });
    releaseStoreOwnership();
    clearTimeout(budget);
    process.exit(failed || controller.getStorageError() ? 1 : 0);
  })();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
