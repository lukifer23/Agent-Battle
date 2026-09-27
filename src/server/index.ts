import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import { PROVIDERS, type MatchEvent, type MatchRecord, type PlayerConfig, type Provider } from "../shared.js";
import { AgentRegistry } from "../domain/agent.js";
import { MatchController } from "../domain/MatchController.js";
import { GameRegistry } from "../domain/game.js";
import { ChessGame } from "../games/chess/ChessGame.js";
import { agentRegistryDefaults, detectProviders } from "./adapters.js";
import { loadMatches, saveMatches } from "./store.js";
import { shouldPersistChange, shouldPublishSnapshot } from "./eventPolicy.js";

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT || 4173);
const storedMatches = loadMatches();
const eventClients = new Set<Response>();
const providerCache = { value: detectProviders() };

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

function stateChanged(record: MatchRecord, event?: MatchEvent): void {
  if (shouldPersistChange(event)) saveMatches(storedMatches.slice(0, 100));
  if (event) {
    const encoded = JSON.stringify({ event, matchId: record.id });
    for (const response of eventClients) response.write(`event: ${event.type}\ndata: ${encoded}\n\n`);
  }
  if (shouldPublishSnapshot(event)) {
    void providerCache.value.then((providers) => ({
      providers,
      activeMatch: storedMatches.find((match) => ["ready", "running", "paused", "interrupted"].includes(match.status)) ?? null,
      recentMatches: storedMatches.slice(0, 50),
    })).then((snapshot) => {
      const encoded = JSON.stringify(snapshot);
      for (const response of eventClients) response.write(`event: snapshot\ndata: ${encoded}\n\n`);
    });
  }
}

const games = new GameRegistry().register(new ChessGame());
const agentDefaults = agentRegistryDefaults();
const agents = new AgentRegistry()
  .register("codex", agentDefaults.codex)
  .register("claude", agentDefaults.claude)
  .register("opencode", agentDefaults.opencode);
const controller = new MatchController(games, agents, storedMatches, () => providerCache.value, stateChanged);

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response) => {
    void handler(request, response).catch((error: unknown) => {
      response.status(400).json({ error: error instanceof Error ? error.message : "Request failed." });
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

app.get("/api/state", asyncRoute(async (_request, response) => {
  response.json(await controller!.snapshot());
}));

app.get("/api/games", (_request, response) => response.json({ games: games.list() }));

app.get("/api/events", (request: Request, response: Response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  eventClients.add(response);
  void controller!.snapshot().then((snapshot) => response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 20_000);
  request.on("close", () => { clearInterval(heartbeat); eventClients.delete(response); });
});

app.post("/api/matches", asyncRoute(async (request, response) => {
  const body = request.body as Record<string, unknown>;
  const created = await controller!.create({
    gameId: typeof body.gameId === "string" ? body.gameId : "chess",
    players: {
      white: parsePlayer(body.white),
      black: parsePlayer(body.black),
    },
    turnTimeoutSeconds: Number(body.turnTimeoutSeconds ?? 120),
  });
  response.status(201).json({ match: created });
}));

app.post("/api/matches/:id/start", asyncRoute(async (request, response) => {
  const match = await controller!.start(Array.isArray(request.params.id) ? request.params.id[0] : request.params.id);
  response.json({ match });
}));

app.post("/api/matches/:id/pause", asyncRoute(async (request, response) => {
  await controller!.pause(Array.isArray(request.params.id) ? request.params.id[0] : request.params.id);
  response.json({ paused: true });
}));

app.post("/api/matches/:id/stop", asyncRoute(async (request, response) => {
  await controller!.stop(Array.isArray(request.params.id) ? request.params.id[0] : request.params.id);
  response.json({ stopping: true });
}));

app.post("/api/providers/refresh", asyncRoute(async (_request, response) => {
  providerCache.value = detectProviders();
  response.json({ providers: await providerCache.value });
}));

const webRoot = join(process.cwd(), "dist", "web");
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get("*splat", (_request, response) => response.sendFile(join(webRoot, "index.html")));
} else {
  app.get("/", (_request, response) => response.type("text").send("Agent Battle API is running. Start the Vite dev server with npm run dev."));
}

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`Agent Battle listening at http://127.0.0.1:${port}`);
});

function shutdown(): void {
  const active = controller.active();
  if (active?.status === "running") void controller.pause(active.id);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
