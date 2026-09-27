import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { PROVIDERS, type MatchRecord, type PlayerConfig, type Provider } from "../shared.js";
import { AgentRegistry } from "../domain/agent.js";
import { MatchController } from "../domain/MatchController.js";
import { GameRegistry } from "../domain/game.js";
import { buildSnapshot } from "../domain/snapshot.js";
import { ChessGame } from "../games/chess/ChessGame.js";
import { agentRegistryDefaults, detectProviders } from "./adapters.js";
import { acquireStoreOwnership, loadMatches, releaseStoreOwnership, saveMatches, STORE_VERSION } from "./store.js";
import { shouldPersistChange, shouldPublishSnapshot } from "./eventPolicy.js";

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
try {
  const loaded = loadMatches();
  storedMatches = loaded.matches;
  if (loaded.migrated) {
    console.log(`Migrated saved matches to store version ${STORE_VERSION}.${loaded.backupPath ? ` Backup: ${loaded.backupPath}.` : ""}${loaded.quarantined ? ` Quarantined ${loaded.quarantined} invalid record(s).` : ""}`);
  }
} catch (error) {
  console.error(`Could not load saved matches: ${error instanceof Error ? error.message : "unknown error"}`);
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

function publishSnapshot(): void {
  void providerCache.value.then((providers) => buildSnapshot(storedMatches, providers)).then((snapshot) => {
    const encoded = JSON.stringify(snapshot);
    for (const response of eventClients) writeToClient(response, "snapshot", encoded);
  }).catch(() => undefined);
}

function stateChanged(record: MatchRecord, event?: import("../shared.js").MatchEvent): void {
  if (shouldPersistChange(event)) saveMatches(storedMatches.slice(0, 100));
  if (event) {
    const encoded = JSON.stringify({ matchId: record.id, revision: record.revision, event });
    for (const response of eventClients) writeToClient(response, event.type, encoded, `${record.id}:${event.sequence ?? record.revision}`);
  }
  if (shouldPublishSnapshot(event)) publishSnapshot();
}

const games = new GameRegistry().register(new ChessGame());
const agentDefaults = agentRegistryDefaults();
const agents = new AgentRegistry()
  .register("codex", agentDefaults.codex)
  .register("claude", agentDefaults.claude)
  .register("opencode", agentDefaults.opencode);
const controller = new MatchController(games, agents, storedMatches, () => providerCache.value, stateChanged);

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
  response.json(await controller.snapshot());
}));

app.get("/api/games", (_request, response) => response.json({ games: games.list() }));

app.get("/api/events", (request: Request, response: Response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  eventClients.add(response);
  void controller.snapshot().then((snapshot) => writeToClient(response, "snapshot", JSON.stringify(snapshot))).catch(() => undefined);
  const heartbeat = setInterval(() => writeToClient(response, "keepalive", JSON.stringify({ at: new Date().toISOString() })), 20_000);
  heartbeat.unref();
  request.on("close", () => { clearInterval(heartbeat); eventClients.delete(response); });
});

app.post("/api/matches", asyncRoute(async (request, response) => {
  const body = request.body as Record<string, unknown>;
  const rawBudgets = (body.budgets && typeof body.budgets === "object" ? body.budgets : {}) as Record<string, unknown>;
  const costLimit = rawBudgets.maxReportedCostUsd;
  const created = await controller.create({
    gameId: typeof body.gameId === "string" ? body.gameId : "chess",
    players: {
      white: parsePlayer(body.white),
      black: parsePlayer(body.black),
    },
    turnTimeoutSeconds: Number(body.turnTimeoutSeconds ?? 120),
    budgets: {
      maxPlies: Number(rawBudgets.maxPlies ?? 150),
      maxRequests: Number(rawBudgets.maxRequests ?? 200),
      maxWallMinutes: Number(rawBudgets.maxWallMinutes ?? 30),
      maxReportedCostUsd: costLimit === undefined || costLimit === null || costLimit === "" ? null : Number(costLimit),
    },
  });
  response.status(201).json({ match: created });
}));

app.post("/api/matches/:id/start", asyncRoute(async (request, response) => {
  const match = await controller.start(matchIdOf(request));
  response.json({ match });
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

const webRoot = join(process.cwd(), "dist", "web");
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
    try { await controller.shutdown(); }
    catch { /* Continue closing even if the final checkpoint fails. */ }
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
    process.exit(0);
  })();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
