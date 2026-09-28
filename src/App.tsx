import { acceptSnapshot, type SnapshotCursor } from "./client/snapshotOrder.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArenaRouter } from "./components/ArenaRouter.js";
import { applyMatchEvent, applyPresentationEvent, matchEventTypes } from "./client/matchEvents.js";
import { highlightSquares, positionSummary } from "./client/chessView.js";
import { aggregateUsage } from "./domain/usage.js";
import { remainingMatchMs } from "./domain/matchTime.js";
import { ArrowUpRight, BoardMark, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FlipVertical, RefreshCw, Trophy } from "./components/icons.js";
import { competitorId, competitorLabel, distinctExplicitModels, verifiedDistinctModels } from "./shared.js";
import type { AppState, ChessSnapshot, MatchEvent, PublicMatchDetail, PublicSeries, Provider, SeriesPlan } from "./shared.js";

const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const pretty: Record<Provider, string> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
const marks: Record<Provider, string> = { codex: "CX", claude: "CC", opencode: "OC" };
const reasoningOptions: Record<Provider, string[]> = {
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  opencode: [],
};
const REPLAYABLE = ["finished", "forfeit", "stopped", "error", "interrupted", "paused"];
const timePresets = [5, 10, 30, 60] as const;

interface Preferences {
  whiteProvider: Provider;
  blackProvider: Provider;
  whiteModel: string;
  blackModel: string;
  whiteReasoning: string;
  blackReasoning: string;
  timeoutSeconds: number;
}

const PREFERENCES_KEY = "agent-battle.preferences";
const VIEW_KEY = "agent-battle.view";

function loadView(): string {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    return saved || "chess";
  } catch { return "chess"; }
}

function loadPreferences(game = "chess"): Partial<Preferences> {
  try {
    const raw = window.localStorage.getItem(`${PREFERENCES_KEY}.${game}`) ?? (game === "chess" ? window.localStorage.getItem(PREFERENCES_KEY) : null);
    return raw ? JSON.parse(raw) as Partial<Preferences> : {};
  } catch { return {}; }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try { body = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error(`Unexpected ${response.status} response from the server.`); }
  }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  return body as T;
}

function coverageMark(coverage: "none" | "partial" | "full"): string {
  return coverage === "full" ? "" : coverage === "partial" ? "~" : " n/a";
}

function resultLine(match: PublicMatchDetail): string {
  if (match.result) return `${match.result.notation} · ${match.result.reason}`;
  if (match.status === "error") return "The match stopped at this position. Review the error below.";
  if (match.status === "ready") return "Ready to start";
  if (match.status === "running") return match.currentPlayerId ? `${match.players.find((player) => player.id === match.currentPlayerId)?.label ?? match.currentPlayerId} to move` : "Starting next turn";
  return match.error ?? match.status;
}

function statusForPlayer(match: PublicMatchDetail, playerId: string, isActiveTurn: boolean): string {
  if (match.gameId === "hangman") {
    const lane = (match.gameState as { lanes: Record<string, { status: string }> }).lanes[playerId];
    if (lane && lane.status !== "active") return lane.status.toUpperCase();
  }
  const latest = [...match.history].reverse().find((turn) => turn.playerId === playerId);
  if (match.status === "ready") return "READY";
  if (match.status === "running") return isActiveTurn ? "THINKING" : "WAITING";
  if (match.status === "paused" || match.status === "interrupted") return "PAUSED";
  if (match.status === "stopped") return match.error?.startsWith("Budget") ? "BUDGET STOP" : "STOPPED";
  if (latest?.attempts.at(-1)?.status === "error") return "REQUEST FAILED";
  if (match.status === "forfeit") return match.result?.winnerId === playerId ? "WINNER" : "FORFEIT";
  if (match.result?.kind === "draw") return "DRAW";
  if (match.result?.kind === "win") return match.result.winnerId === playerId ? "WINNER" : "GAME OVER";
  return match.status.toUpperCase();
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function eventLabel(match: PublicMatchDetail, event: MatchEvent): string {
  if (match.gameId !== "hangman") return event.text;
  const player = match.players.find((seat) => seat.id === event.playerId)?.label;
  const prefix = player ? `${player} · ` : "";
  if (event.type === "move.applied") {
    const action = event.payload?.action as { type?: string; payload?: { letter?: string } } | undefined;
    if (action?.type === "guess_letter" && /^[a-z]$/.test(action.payload?.letter ?? "")) return `${prefix}guessed ${action.payload!.letter}`;
    return `${prefix}${action?.type === "solve" ? "submitted a solution" : "action accepted"}`;
  }
  if (event.type === "turn.completed") return `${prefix}turn completed`;
  if (event.type === "turn.started") return `${prefix}turn started`;
  if (event.type === "move.rejected") return `${prefix}invalid action`;
  if (event.type === "agent.started") return `${prefix}request started`;
  return event.text;
}

function App() {
  const preferences = useMemo(() => loadPreferences(loadView()), []);
  const [state, setState] = useState<AppState | null>(null);
  const [providersChecked, setProvidersChecked] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => window.localStorage.getItem("agent-battle.selected"));
  const [whiteProvider, setWhiteProvider] = useState<Provider>(preferences.whiteProvider ?? "codex");
  const [blackProvider, setBlackProvider] = useState<Provider>(preferences.blackProvider ?? "codex");
  const [whiteModel, setWhiteModel] = useState(preferences.whiteModel ?? "");
  const [blackModel, setBlackModel] = useState(preferences.blackModel ?? "");
  const [whiteReasoning, setWhiteReasoning] = useState(preferences.whiteReasoning ?? "");
  const [blackReasoning, setBlackReasoning] = useState(preferences.blackReasoning ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(preferences.timeoutSeconds ?? 120);
  const [gameId, setGameId] = useState(() => loadView() === "series" ? "chess" : loadView());
  const [viewMode, setViewMode] = useState<string>(loadView);
  const [games, setGames] = useState<Array<{ id: string; label: string; version: string; playerIds: string[]; playerLabels: string[]; series?: { supportsSeededChallenges: boolean; recommendedRepetitions: number; seatSensitive: boolean } }>>([]);
  const [maxPlies, setMaxPlies] = useState(250);
  const [maxRequests, setMaxRequests] = useState(500);
  const [timePreset, setTimePreset] = useState<number | "custom">(30);
  const [customMinutes, setCustomMinutes] = useState(45);
  const maxWallMinutes = timePreset === "custom" ? customMinutes : timePreset;
  const [maxCost, setMaxCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [replayPly, setReplayPly] = useState<number | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">("white");
  const [newMatchOpen, setNewMatchOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [pendingCommand, setPendingCommand] = useState<null | "create" | "start" | "pause" | "stop">(null);
  const [detailById, setDetailById] = useState<Map<string, PublicMatchDetail>>(() => new Map());
  const [seriesList, setSeriesList] = useState<PublicSeries[]>([]);
  const [seriesPreset, setSeriesPreset] = useState<"quick" | "standard" | "custom">("quick");
  const [seriesCounts, setSeriesCounts] = useState<Record<string, number>>({ chess: 2, hangman: 2, battleship: 2 });
  const [seriesMode, setSeriesMode] = useState<"exploratory" | "strict">("exploratory");
  const lastSnapshot = useRef<SnapshotCursor>({ version: -1, retired: new Set() });
  const revisions = useRef<Map<string, number>>(new Map());
  const moveListRef = useRef<HTMLDivElement | null>(null);

  const chooseWhiteProvider = (provider: Provider) => {
    setWhiteProvider(provider);
    if (!reasoningOptions[provider].includes(whiteReasoning.toLowerCase())) setWhiteReasoning("");
  };
  const chooseBlackProvider = (provider: Provider) => {
    setBlackProvider(provider);
    if (!reasoningOptions[provider].includes(blackReasoning.toLowerCase())) setBlackReasoning("");
  };

  useEffect(() => {
    const value: Preferences = { whiteProvider, blackProvider, whiteModel, blackModel, whiteReasoning, blackReasoning, timeoutSeconds };
    try { window.localStorage.setItem(`${PREFERENCES_KEY}.${gameId}`, JSON.stringify(value)); }
    catch { /* Preferences are best-effort. */ }
  }, [gameId, whiteProvider, blackProvider, whiteModel, blackModel, whiteReasoning, blackReasoning, timeoutSeconds]);

  useEffect(() => {
    try { window.localStorage.setItem("agent-battle.selected", selectedId ?? ""); }
    catch { /* Selection persistence is best-effort. */ }
  }, [selectedId]);

  useEffect(() => {
    try { window.localStorage.setItem(VIEW_KEY, viewMode); }
    catch { /* View persistence is best-effort. */ }
  }, [viewMode]);

  const rememberSnapshot = useCallback((next: AppState) => {
    return acceptSnapshot(lastSnapshot.current, revisions.current, next);
  }, []);

  const matchForView = useCallback((next: AppState, current: string | null) => {
    const matches = [next.activeMatch, ...next.recentMatches].filter((match): match is NonNullable<typeof match> => Boolean(match));
    if (current && matches.some((match) => match.id === current && match.gameId === viewMode)) return current;
    return matches.find((match) => match.gameId === viewMode)?.id ?? null;
  }, [viewMode]);

  const refresh = useCallback(async () => {
    const next = await api<AppState>("/api/state");
    if (!rememberSnapshot(next)) return;
    setState(next);
    setProvidersChecked(true);
    setSelectedId((current) => matchForView(next, current));
  }, [rememberSnapshot, matchForView]);

  const refreshSeries = useCallback(async () => {
    const result = await api<{ series: PublicSeries[] }>("/api/series");
    setSeriesList(result.series);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshSeries().catch(() => undefined), 0);
    void api<{ games: typeof games }>("/api/games").then((result) => setGames(result.games)).catch(() => undefined);
    const interval = window.setInterval(() => void refreshSeries().catch(() => undefined), 2000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [refreshSeries]);
  const chosenGame = games.find((game) => game.id === gameId);
  const chosenRoles = chosenGame?.playerIds ?? ["white", "black"];

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnection("live");
    source.addEventListener("snapshot", (event) => {
      try {
        const next = JSON.parse((event as MessageEvent<string>).data) as AppState;
        if (!rememberSnapshot(next)) return;
        setState(next);
        setProvidersChecked(true);
        setConnection("live");
        setSelectedId((current) => matchForView(next, current));
      } catch (reason) {
        setError(reason instanceof Error ? `Could not read the server state: ${reason.message}` : "Could not read the server state.");
      }
    });
    for (const type of matchEventTypes) source.addEventListener(type, (message) => {
      try {
        const envelope = JSON.parse((message as MessageEvent<string>).data) as { matchId?: string; revision?: number; transient?: boolean; event?: MatchEvent };
        if (!envelope.matchId || !envelope.event) throw new Error("Event envelope is missing its match or event.");
        const matchId = envelope.matchId;
        if (envelope.transient) {
          setState((existing) => existing ? applyPresentationEvent(existing, matchId, envelope.event!) : existing);
          return;
        }
        const revision = envelope.revision ?? envelope.event.sequence ?? 0;
        const current = revisions.current.get(matchId);
        if (current !== undefined && revision <= current) return;
        if (current !== undefined && revision > current + 1) { void refresh().catch(() => undefined); return; }
        revisions.current.set(matchId, revision);
        setState((existing) => existing ? applyMatchEvent(existing, matchId, envelope.event!, revision) : existing);
      } catch (reason) {
        setError(reason instanceof Error ? `Could not process ${type}: ${reason.message}` : `Could not process ${type}.`);
      }
    });
    source.onerror = () => {
      setConnection((value) => (value === "live" ? "reconnecting" : "offline"));
      void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not connect to the game server."));
    };
    return () => source.close();
  }, [refresh, rememberSnapshot, matchForView]);

  const selectedMatch = useMemo(() => {
    if (!state) return null;
    if (selectedId && state.activeMatch && selectedId === state.activeMatch.id) return state.activeMatch;
    const detail = selectedId ? detailById.get(selectedId) : undefined;
    if (detail) return detail;
    return null;
  }, [state, selectedId, detailById]);

  const chooseView = (next: string, matchId?: string) => {
    setViewMode(next);
    setReplayPly(null);
    setReplayOpen(false);
    setNewMatchOpen(false);
    if (next === "series") return;
    setGameId(next);
    const saved = loadPreferences(next);
    setWhiteProvider(saved.whiteProvider ?? "codex"); setBlackProvider(saved.blackProvider ?? "codex");
    setWhiteModel(saved.whiteModel ?? ""); setBlackModel(saved.blackModel ?? "");
    setWhiteReasoning(saved.whiteReasoning ?? ""); setBlackReasoning(saved.blackReasoning ?? "");
    setTimeoutSeconds(saved.timeoutSeconds ?? 120);
    const matches = [state?.activeMatch, ...(state?.recentMatches ?? [])];
    setSelectedId(matchId ?? matches.find((match) => match?.gameId === next)?.id ?? null);
  };

  useEffect(() => {
    if (!selectedId || !state) return;
    if (selectedId === state.activeMatchId) return;
    if ((detailById.get(selectedId)?.revision ?? -1) >= (state.recentMatches.find((match) => match.id === selectedId)?.revision ?? 0)) return;
    let cancelled = false;
    void api<{ match: PublicMatchDetail }>(`/api/matches/${selectedId}`).then((result) => {
      if (!cancelled) setDetailById((current) => new Map(current).set(result.match.id, result.match));
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the selected match."));
    return () => { cancelled = true; };
  }, [selectedId, state, detailById]);

  const selectedSnapshot = selectedMatch?.gameId === "chess" ? selectedMatch.gameState as ChessSnapshot : undefined;
  const hangmanLanes = selectedMatch?.gameId === "hangman" ? (selectedMatch.gameState as { lanes: Record<string, { status: string; misses: number; actionsTaken: number; correctLetters: number }> }).lanes : null;
  const totalPlies = selectedMatch?.gameId === "chess" ? selectedSnapshot?.moves?.length ?? 0 : Math.max(0, (selectedMatch?.replay?.length ?? 1) - 1);
  const viewingPly = replayPly ?? totalPlies;
  const replayUnit = selectedMatch?.gameId === "chess" ? "Ply" : "Action";
  const displayedMove = viewingPly > 0 ? selectedSnapshot?.moves[viewingPly - 1] : undefined;

  const boardFen = useMemo(() => {
    const snapshot = selectedMatch?.gameState as ChessSnapshot | undefined;
    if (!selectedMatch) return initialFen;
    if (viewingPly === 0) return initialFen;
    return displayedMove?.fen ?? snapshot?.fen ?? initialFen;
  }, [selectedMatch, viewingPly, displayedMove]);

  const squareStyles = useMemo(() => highlightSquares(boardFen, displayedMove?.uci), [boardFen, displayedMove]);

  const moveToPly = (ply: number) => {
    const clamped = Math.max(0, Math.min(totalPlies, ply));
    setReplayPly(clamped >= totalPlies ? null : clamped);
    if (clamped < totalPlies) setReplayOpen(true);
  };

  useEffect(() => {
    if (moveListRef.current) moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
  }, [viewingPly, totalPlies]);

  const standings = useMemo(() => {
    const rows = new Map<string, { name: string; control: string; wins: number; draws: number; losses: number; points: number }>();
    for (const match of state?.recentMatches ?? []) {
      if (match.seriesId) continue;
      if (match.gameId !== (selectedMatch?.gameId ?? gameId)) continue;
      if (!verifiedDistinctModels(match.players[0].agent, match.players[1].agent)) continue;
      if (!match.result || !["finished", "forfeit"].includes(match.status)) continue;
      for (const player of match.players) {
        const side = player.id;
        const name = competitorLabel(player.agent);
        const control = `${match.timeControl.maxMinutes}m ${match.timeControl.mode} · ${match.timeControl.turnSeconds}s/turn`;
        const key = `${competitorId(player.agent)}::${control}`;
        const row = rows.get(key) ?? { name, control, wins: 0, draws: 0, losses: 0, points: 0 };
        const won = match.result.kind === "win" && match.result.winnerId === side;
        const drawn = match.result.kind === "draw";
        if (won) { row.wins += 1; row.points += 1; }
        else if (drawn) { row.draws += 1; row.points += 0.5; }
        else row.losses += 1;
        rows.set(key, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
  }, [state, selectedMatch?.gameId, gameId]);

  const providers = state?.providers ?? [];
  const storageBlocked = state?.storage?.status === "write_failed";
  const installed = (provider: Provider) => providers.find((item) => item.provider === provider)?.installed ?? false;
  const currentIsRunning = selectedMatch?.status === "running";
  const terminalMatchSelected = Boolean(selectedMatch && ["finished", "forfeit", "stopped", "error"].includes(selectedMatch.status));
  const condenseSetup = Boolean(selectedMatch && (
    ["running", "paused", "interrupted"].includes(selectedMatch.status) || (terminalMatchSelected && !newMatchOpen)
  ));
  const canStart = Boolean(!storageBlocked && selectedMatch && ["ready", "paused", "interrupted"].includes(selectedMatch.status) && state?.activeMatch?.id === selectedMatch.id);
  const canCreate = !storageBlocked && (!state?.activeMatch || !["ready", "running", "paused", "interrupted"].includes(state.activeMatch.status));
  const activeSeries = seriesList.find((series) => ["ready", "running", "paused"].includes(series.status));
  const distinctModels = distinctExplicitModels({ model: whiteModel }, { model: blackModel });
  const unqualifiedMatch = Boolean(selectedMatch && !verifiedDistinctModels(selectedMatch.players[0].agent, selectedMatch.players[1].agent));
  const startBlocker = storageBlocked ? "Saved history is unavailable. Restore storage before starting."
    : !providersChecked || !chosenGame ? "Checking games and local agent CLIs…"
    : !installed(whiteProvider) || !installed(blackProvider) ? "Install the selected agent CLI and sign in to use it."
    : !canCreate && state?.activeMatch ? `A ${state.activeMatch.gameId} match is ${state.activeMatch.status}. Finish or stop it before starting ${gameId}.`
    : activeSeries ? `A battle series is ${activeSeries.status}. Finish or stop it before starting another match.`
    : gameId === "hangman" && !distinctModels ? "Enter two explicit, different model IDs. Two CLI defaults or the same model in both lanes cannot establish distinct competitors."
    : null;
  const seriesBlocker = startBlocker ?? (!distinctModels ? "Enter two different explicit model IDs." : whiteProvider === "codex" || blackProvider === "codex" ? "Codex tool isolation is not qualified for scored series trials. Choose a qualified no-tools CLI." : null);

  useEffect(() => {
    if (!currentIsRunning) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [currentIsRunning, selectedMatch?.currentPlayerId]);

  const currentTurnStart = selectedMatch?.pendingTurn?.attempts.at(-1)?.startedAt ?? selectedMatch?.events.filter((event) => event.type === "agent.started" && event.playerId === selectedMatch.currentPlayerId).at(-1)?.at;
  const currentTurnElapsed = currentIsRunning && currentTurnStart ? Math.max(0, Math.floor((now - Date.parse(currentTurnStart)) / 1000)) : 0;
  const turnSecondsLeft = Math.max(0, (selectedMatch?.settings.turnTimeoutSeconds ?? timeoutSeconds) - currentTurnElapsed);
  const gameSecondsLeft = selectedMatch ? Math.max(0, Math.ceil(remainingMatchMs(selectedMatch, now) / 1000)) : 0;

  const startMatch = async () => {
    setPendingCommand("start"); setError("");
    try {
      const created = await api<{ match: PublicMatchDetail }>("/api/matches", {
        method: "POST",
        body: JSON.stringify({
          gameId,
          players: {
            [chosenRoles[0]]: { provider: whiteProvider, model: whiteModel, reasoning: whiteReasoning },
            [chosenRoles[1]]: { provider: blackProvider, model: blackModel, reasoning: blackReasoning },
          },
          turnTimeoutSeconds: timeoutSeconds,
          budgets: {
            maxPlies,
            maxRequests,
            maxWallMinutes,
            maxReportedCostUsd: maxCost.trim() ? Number(maxCost) : null,
          },
        }),
      });
      setSelectedId(created.match.id);
      setNewMatchOpen(false);
      setReplayPly(null);
      await refresh();
      await api(`/api/matches/${created.match.id}/start`, { method: "POST", body: "{}" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the match.");
      await refresh().catch(() => undefined);
    } finally { setPendingCommand(null); }
  };

  const createSeries = async (rerun?: { masterSeed: string; plan: SeriesPlan; agents: PublicSeries["agents"]; settings: PublicSeries["settings"] }) => {
    setPendingCommand("create"); setError("");
    try {
      const counts = seriesPreset === "quick" ? { chess: 2, hangman: 2, battleship: 2 } : seriesPreset === "standard" ? { chess: 6, hangman: 5, battleship: 6 } : seriesCounts;
      const plan: SeriesPlan = rerun?.plan ?? { mode: seriesPreset === "quick" ? "exploratory" : seriesPreset === "standard" ? "strict" : seriesMode,
        games: games.filter((game) => game.series && (counts[game.id] ?? 0) > 0).map((game) => ({ gameId: game.id, gameVersion: game.version, repetitions: counts[game.id], rolePolicy: "alternating", challengePolicy: game.series!.supportsSeededChallenges ? "seeded" : "fixed" })) };
      const created = await api<{ series: PublicSeries }>("/api/series", { method: "POST", body: JSON.stringify({
        agents: rerun?.agents ?? [{ provider: whiteProvider, model: whiteModel, reasoning: whiteReasoning }, { provider: blackProvider, model: blackModel, reasoning: blackReasoning }],
        turnTimeoutSeconds: rerun?.settings.turnTimeoutSeconds ?? timeoutSeconds,
        budgets: rerun?.settings.budgets ?? { maxPlies, maxRequests, maxWallMinutes, maxReportedCostUsd: maxCost.trim() ? Number(maxCost) : null },
        plan, ...(rerun ? { masterSeed: rerun.masterSeed } : {}),
      }) });
      await api(`/api/series/${created.series.id}/start`, { method: "POST", body: "{}" });
      await refreshSeries(); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create the series."); }
    finally { setPendingCommand(null); }
  };
  const rerunSeries = async (id: string) => {
    try {
      const exportData = await api<{ reproducibility?: { masterSeed: string; plan: SeriesPlan; agents: PublicSeries["agents"]; settings: PublicSeries["settings"] } }>(`/api/series/${id}/export`);
      if (!exportData.reproducibility) throw new Error("This series has no completed v2 reproducibility manifest.");
      await createSeries(exportData.reproducibility);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not rerun the series."); }
  };

  const seriesCommand = async (id: string, command: "start" | "pause" | "stop" | "retry" | "skip") => {
    setError("");
    try { await api(`/api/series/${id}/${command}`, { method: "POST", body: "{}" }); await refreshSeries(); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : `Could not ${command} the series.`); }
  };

  const downloadSeries = async (id: string) => {
    try { const result = await api<unknown>(`/api/series/${id}/export`); triggerDownload(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), `agent-battle-series-${id.slice(0, 8)}.json`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not export the series."); }
  };

  const stopMatch = async () => {
    if (!selectedMatch) return;
    setPendingCommand("stop"); setError("");
    try {
      await api(`/api/matches/${selectedMatch.id}/stop`, { method: "POST", body: "{}" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not stop the match.");
      await refresh().catch(() => undefined);
    } finally { setPendingCommand(null); }
  };

  const pauseMatch = async () => {
    if (!selectedMatch) return;
    setPendingCommand("pause"); setError("");
    try {
      await api(`/api/matches/${selectedMatch.id}/pause`, { method: "POST", body: "{}" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not pause the match.");
      await refresh().catch(() => undefined);
    } finally { setPendingCommand(null); }
  };

  const resumeMatch = async () => {
    if (!selectedMatch) return;
    setPendingCommand("start"); setError("");
    try {
      await api(`/api/matches/${selectedMatch.id}/start`, { method: "POST", body: "{}" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not resume the match.");
      await refresh().catch(() => undefined);
    } finally { setPendingCommand(null); }
  };

  const refreshProviders = async () => {
    setBusy(true); setError("");
    try {
      const result = await api<{ providers: AppState["providers"] }>("/api/providers/refresh", { method: "POST", body: "{}" });
      setState((current) => current ? { ...current, providers: result.providers } : current);
      setProvidersChecked(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not check local agent CLIs.");
    } finally { setBusy(false); }
  };

  const currentTurnPlayer = selectedMatch?.players.find((player) => player.id === selectedMatch.currentPlayerId);
  const currentTurnName = currentTurnPlayer ? competitorLabel(currentTurnPlayer.agent) : undefined;
  const isHistorical = Boolean(selectedMatch && selectedMatch.id !== state?.activeMatch?.id);
  const isReplayMatch = Boolean(isHistorical && totalPlies > 0);
  const canReplay = Boolean(selectedMatch && totalPlies > 0 && REPLAYABLE.includes(selectedMatch.status));

  const matchTotals = useMemo(() => {
    if (!selectedMatch) return null;
    return aggregateUsage([...selectedMatch.history.flatMap((turn) => turn.attempts), ...(selectedMatch.pendingTurn?.attempts ?? [])]);
  }, [selectedMatch]);

  const shortId = selectedMatch ? selectedMatch.id.slice(0, 8) : "";

  const copyText = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setNotice(`${label} copied.`); }
    catch { setNotice(`Could not copy ${label.toLowerCase()}.`); }
    window.setTimeout(() => setNotice(""), 2500);
  };

  const downloadJson = async () => {
    if (!selectedMatch) return;
    try {
      const result = await api<{ match: PublicMatchDetail }>(`/api/matches/${selectedMatch.id}`);
      const blob = new Blob([JSON.stringify(result.match, null, 2)], { type: "application/json" });
      triggerDownload(blob, `agent-battle-${shortId}.json`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export the match.");
    }
  };

  const downloadPgn = () => {
    if (!selectedMatch) return;
    const snapshot = selectedMatch.gameState as ChessSnapshot | undefined;
    triggerDownload(new Blob([snapshot?.pgn ?? ""], { type: "application/x-chess-pgn" }), `agent-battle-${shortId}.pgn`);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Agent Battle home">
          <BoardMark className="brand-icon" />
          <span>AGENT<span className="brand-light">BATTLE</span></span>
        </a>
        <div className="topbar-right">
          <span className={`connection-chip connection-${connection}`}>{connection === "live" ? "LIVE" : connection === "connecting" ? "CONNECTING" : connection === "reconnecting" ? "RECONNECTING" : "OFFLINE"}</span>
          <span className="local-chip"><span className={`live-dot ${connection === "live" ? "is-live" : ""}`} /> LOCAL ARENA</span>
          <button className="quiet-button" onClick={() => void refreshProviders()} disabled={busy}><RefreshCw className="button-icon" /> Check CLIs</button>
        </div>
      </header>

      <nav className="mode-nav" aria-label="Arena view">
        {games.map((game) => { const count = (state?.recentMatches ?? []).filter((match) => match.gameId === game.id).length; return <button key={game.id} type="button" aria-pressed={viewMode === game.id} onClick={() => chooseView(game.id)}>{game.label}<span>{count} {count === 1 ? "match" : "matches"}</span></button>; })}
        <button type="button" aria-pressed={viewMode === "series"} onClick={() => chooseView("series")}>Battle series<span>{seriesList.length} recorded</span></button>
      </nav>

      {state?.storage && state.storage.status !== "healthy" && <div className="error-banner" role="alert">
        <strong>{state.storage.status === "write_failed" ? "Storage unavailable — requests stopped" : "Saved history needs review"}</strong>
        <p>{state.storage.message}</p>
      </div>}

      <section className="intro is-condensed" id="top">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> {viewMode === "series" ? "REPRODUCIBLE TRIALS" : `${viewMode.toUpperCase()} ARENA`}</div>
          <h1>{viewMode === "series" ? <>Battle <em>series.</em></> : <>Play <em>{games.find((game) => game.id === viewMode)?.label ?? viewMode}.</em></>}</h1>
          <p>{viewMode === "series" ? "Balanced roles, matched challenges, recorded results." : viewMode === "hangman" ? "Two private lanes. One shared secret word." : viewMode === "battleship" ? "Two hidden fleets. One shot per turn." : "Two agents. One board. Every decision is theirs."}</p>
        </div>
        <BoardMark className="intro-mark" />
      </section>

      <section className={`arena-layout ${viewMode === "series" ? `series-layout ${seriesList.length ? "has-series" : ""}` : ""}`}>
        <div className={`arena-main ${selectedMatch && viewMode !== "series" ? "has-match" : ""}`}>
          <section className={`match-setup panel ${condenseSetup ? "is-condensed" : ""}`}>
            <div className="section-heading">
              <div><span className="eyebrow">{viewMode === "series" ? "BENCHMARK SETUP" : "MATCH SETUP"}</span><h2>{viewMode === "series" ? "Choose series agents" : condenseSetup ? "Match settings" : "Choose your players"}</h2></div>
              <span className="setup-tag">{viewMode === "series" ? "CONFIGURABLE TRIALS" : condenseSetup ? selectedMatch?.status.toUpperCase() : gameId.toUpperCase()}</span>
            </div>
            {condenseSetup && viewMode !== "series" ? <div className="active-setup-note">
              <span className="live-dot" />
              <span>{selectedMatch?.players.map((player) => competitorLabel(player.agent)).join(" vs ")}</span>
              <span className="active-setup-status">{selectedMatch?.result ? `${selectedMatch.result.notation} · ${selectedMatch.result.reason}` : selectedMatch?.status === "error" ? "Stopped · review match log" : selectedMatch?.currentPlayerId ? `${selectedMatch.players.find((player) => player.id === selectedMatch.currentPlayerId)?.label} to move` : "Resume when ready"}</span>
              {terminalMatchSelected && !selectedMatch?.series && <button className="active-setup-new" onClick={() => { setGameId(selectedMatch!.gameId); const [a, b] = selectedMatch!.players; setWhiteProvider(a.agent.provider); setWhiteModel(a.agent.model); setWhiteReasoning(a.agent.reasoning ?? ""); setBlackProvider(b.agent.provider); setBlackModel(b.agent.model); setBlackReasoning(b.agent.reasoning ?? ""); setNewMatchOpen(true); }}>PLAY AGAIN <ArrowUpRight className="inline-icon" /></button>}
            </div> : <>
              <div className="launch-strip">
                <div><strong>{viewMode === "series" ? "Run a recorded battle series" : `Ready to play ${chosenGame?.label ?? viewMode}?`}</strong><p>{viewMode === "series" ? "Choose the games and trial counts below. Each result, role, request, and model identity is recorded." : viewMode === "hangman" ? "Both agents get the same hidden word and play separate lanes. Results and actions are saved automatically." : viewMode === "battleship" ? "Each agent places a private fleet, then they alternate shots. Fleets reveal after the battle." : "The agents play from the standard starting position. Moves and results are saved automatically."}</p></div>
                {viewMode === "series" ? <button className="primary-button launch-button" onClick={() => void createSeries()} disabled={pendingCommand !== null || seriesBlocker !== null}>{pendingCommand === "create" ? "STARTING…" : "START BATTLE SERIES"} <ArrowUpRight className="inline-icon" /></button>
                  : <button className="primary-button launch-button" onClick={() => void startMatch()} disabled={busy || pendingCommand !== null || startBlocker !== null}>{pendingCommand === "start" ? "STARTING…" : `START ${viewMode.toUpperCase()} MATCH`} <ArrowUpRight className="inline-icon" /></button>}
              </div>
              {viewMode === "hangman" && <p className="game-rules-brief">Seven misses per lane. A solve beats a failed lane; then fewer misses, fewer actions, or more correct letters decide the result. The word is revealed after both lanes finish.</p>}
              {viewMode === "series" && <div className="series-plan-setup"><div className="time-presets" role="group" aria-label="Series preset">
                {(["quick", "standard", "custom"] as const).map((preset) => <button key={preset} type="button" aria-pressed={seriesPreset === preset} onClick={() => setSeriesPreset(preset)}>{preset.toUpperCase()}</button>)}
              </div><p>{seriesPreset === "quick" ? "Exploratory · 2 Chess, 2 Hangman, 2 Battleship" : seriesPreset === "standard" ? "Strict · 6 Chess, 5 matched Hangman words, 6 Battleship" : "Choose repetitions for each game. Strict mode requires even counts for seat-sensitive games."}</p>
              {seriesPreset === "custom" && <><label className="timeout-setting">MODE <select value={seriesMode} onChange={(event) => setSeriesMode(event.target.value as "strict" | "exploratory")}><option value="exploratory">Exploratory</option><option value="strict">Strict</option></select></label><div className="series-counts">{games.filter((game) => game.series).map((game) => <label className="timeout-setting" key={game.id}>{game.label.toUpperCase()} <input type="number" min={0} max={100} value={seriesCounts[game.id] ?? 0} onChange={(event) => setSeriesCounts((current) => ({ ...current, [game.id]: Math.max(0, Math.min(100, Number(event.target.value) || 0)) }))} /></label>)}</div></>}
              </div>}
              {(viewMode === "series" ? seriesBlocker : startBlocker) && <div className="launch-blocker" role="status"><strong>Cannot start yet.</strong> {viewMode === "series" ? seriesBlocker : startBlocker}{state?.activeMatch && !canCreate ? <button className="link-button" onClick={() => chooseView(state.activeMatch!.gameId as "chess" | "hangman", state.activeMatch!.id)}>Open active match</button> : activeSeries && viewMode !== "series" ? <button className="link-button" onClick={() => chooseView("series")}>Open battle series</button> : null}</div>}
              {error && <div className="error-banner" role="alert">{error}</div>}
              <div className="players-grid">
                <PlayerPicker title={(viewMode === "series" ? "AGENT A" : chosenGame?.playerLabels[0] ?? "White").toUpperCase()} color="white" provider={whiteProvider} model={whiteModel} reasoning={whiteReasoning} providers={providers} loading={!providersChecked} requiredModel={viewMode === "series"}
                  onProvider={chooseWhiteProvider} onModel={setWhiteModel} onReasoning={setWhiteReasoning} />
                <div className="versus"><span>VS</span></div>
                <PlayerPicker title={(viewMode === "series" ? "AGENT B" : chosenGame?.playerLabels[1] ?? "Black").toUpperCase()} color="black" provider={blackProvider} model={blackModel} reasoning={blackReasoning} providers={providers} loading={!providersChecked} requiredModel={viewMode === "series"}
                  onProvider={chooseBlackProvider} onModel={setBlackModel} onReasoning={setBlackReasoning} />
              </div>
              <details className="advanced-settings"><summary>Time and resource limits <span>{maxWallMinutes} min active · {timeoutSeconds} sec per request</span></summary>
              <fieldset className="time-control">
                <legend>GAME TIME · ACTIVE PLAY</legend>
                <div className="time-presets" role="group" aria-label="Game time limit">
                  {timePresets.map((minutes) => <button key={minutes} type="button" aria-pressed={timePreset === minutes}
                    onClick={() => setTimePreset(minutes)}>{minutes} MIN</button>)}
                  <button type="button" aria-pressed={timePreset === "custom"} onClick={() => setTimePreset("custom")}>CUSTOM</button>
                  {timePreset === "custom" && <label className="timeout-setting">MINUTES <input type="number" min={1} max={10000} value={customMinutes}
                    onChange={(event) => setCustomMinutes(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} /></label>}
                </div>
              </fieldset>
              <div className="setup-footer">
                <div className="budget-settings">
                  <label className="timeout-setting">MOVE TIMEOUT <input type="number" min={30} max={600} step={30} value={timeoutSeconds}
                    onChange={(event) => setTimeoutSeconds(Math.max(30, Math.min(600, Number(event.target.value) || 30)))} /> <span>sec</span></label>
                  <label className="timeout-setting">MAX ACTIONS <input type="number" min={1} max={10000} value={maxPlies}
                    onChange={(event) => setMaxPlies(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} /></label>
                  <label className="timeout-setting">MAX REQUESTS <input type="number" min={1} max={100000} value={maxRequests}
                    onChange={(event) => setMaxRequests(Math.max(1, Math.min(100000, Number(event.target.value) || 1)))} /></label>
                  <label className="timeout-setting">COST LIMIT <input type="number" min={0} step="0.01" placeholder="none" value={maxCost}
                    onChange={(event) => setMaxCost(event.target.value)} /> <span>USD</span></label>
                </div>
              </div>
              <div className="inline-note">Game time counts while the match runs, including an active provider request; pause stops its clock. Move timeout is a separate per-request limit. Short presets may stop before a game result. Cost remains a best-effort threshold on reported provider usage.</div>
              {(whiteProvider === blackProvider) && <div className="inline-note">Both sides can use the same CLI with different models.</div>}
              {providersChecked && providers.some((entry) => !entry.installed) && <div className="inline-note">Install a supported CLI and sign in before choosing it. Agent Battle uses its existing login.</div>}
              </details>
            </>}
            {viewMode === "series" && !canCreate && state?.activeMatch && <div className="inline-note">A match is already active. <button className="link-button" onClick={() => { chooseView(state.activeMatch!.gameId as "chess" | "hangman", state.activeMatch!.id); }}>Open the current match</button> to stop it or let it finish.</div>}
            {condenseSetup && viewMode !== "series" && error && <div className="error-banner" role="alert">{error}</div>}
          </section>

          {viewMode === "series" && <section className="history-panel panel series-panel" aria-label="Battle series">
            <div className="section-heading compact-heading"><div><span className="eyebrow">REPEATED TRIALS</span><h2>Battle series</h2></div><span className="setup-tag">CHESS · HANGMAN · BATTLESHIP</span></div>
            {seriesList.length === 0 ? <p className="inline-note">Choose two explicit models, then start a quick, standard, or custom experiment.</p> : seriesList.map((series) => <div className="series-card" key={series.id}>
              <div className="series-card-head"><strong>{series.agents.map((agent) => competitorLabel(agent)).join(" vs ")}</strong><span>{series.status.toUpperCase()}</span></div>
              <p className="series-progress">{series.slots.filter((slot) => slot.status === "scored").length} / {series.slots.length} scored · {series.slots.filter((slot) => slot.status === "unscored").length} unscored</p>
              {series.error && <p role="alert">{series.error}</p>}
              {(() => { const slot = series.slots.find((item) => item.status === "running" || item.status === "unscored") ?? series.slots.find((item) => item.status === "pending"); return slot ? <div className="series-current"><span>Slot {slot.ordinal + 1} · {slot.gameId} · {slot.status}</span>{slot.matchIds.length > 0 && <button className="quiet-button" onClick={() => chooseView(slot.gameId as "chess" | "hangman", slot.matchIds.at(-1))}>VIEW MATCH</button>}</div> : null; })()}
              <div className="series-actions">
                {series.status === "paused" && !series.slots.some((slot) => slot.status === "unscored") && <button className="quiet-button" onClick={() => void seriesCommand(series.id, "start")}>RESUME</button>}
                {series.status === "paused" && series.slots.some((slot) => slot.status === "unscored") && <button className="quiet-button" onClick={() => void seriesCommand(series.id, "retry")}>RETRY SLOT</button>}
                {series.status === "paused" && series.slots.some((slot) => slot.status === "unscored" || slot.status === "pending") && <button className="quiet-button" onClick={() => void seriesCommand(series.id, "skip")}>SKIP SLOT</button>}
                {series.status === "running" && <button className="quiet-button" onClick={() => void seriesCommand(series.id, "pause")}>PAUSE SERIES</button>}
                {["ready", "running", "paused"].includes(series.status) && <button className="stop-button" onClick={() => void seriesCommand(series.id, "stop")}>STOP SERIES</button>}
                <button className="quiet-button" onClick={() => void downloadSeries(series.id)}><Download className="button-icon" /> JSON</button>
                {series.status === "completed" && series.version === "battle-series-2" && <button className="quiet-button" onClick={() => void rerunSeries(series.id)} disabled={pendingCommand !== null}>RERUN EXACT CONFIGURATION</button>}
              </div>
              <details className="series-detail"><summary>Trial schedule</summary><div className="series-slots">{series.slots.map((slot) => <div key={slot.id}><span>{slot.ordinal + 1}. {slot.gameId} · {slot.challengeId.slice(0, 12)}</span><span>{slot.status}{slot.result ? ` · ${slot.result.notation}` : ""}{slot.matchIds.length > 0 && <button className="link-button" onClick={() => chooseView(slot.gameId as "chess" | "hangman", slot.matchIds.at(-1))}>Open</button>}</span></div>)}</div></details>
              <details className="series-detail"><summary>Scores and usage</summary><div className="series-results"><p>Win = 1, draw = ½, loss = 0. Each game's performance is points / scored trials; overall is the mean across scored game families. Unscored trials remain visible.</p>{Object.entries(series.aggregate).map(([key, row]) => <p key={key}><b>{key.split(":")[0]} · {series.agents[Number(key.split(":")[1])]?.model}</b> {row.wins}W {row.draws}D {row.losses}L · {row.scored} scored{row.unscored ? ` · ${row.unscored} unscored` : ""} · {row.points}/{row.possiblePoints} points ({row.normalizedPerformance === null ? "n/a" : `${(row.normalizedPerformance * 100).toFixed(1)}%`}) · roles {Object.entries(row.roleCounts).map(([role, count]) => `${role}:${count}`).join(", ")} · {row.requests} requests · {row.inputTokens + row.outputTokens} reported tokens ({row.coverage.inputTokens.reported}/{row.coverage.inputTokens.total} input, {row.coverage.outputTokens.reported}/{row.coverage.outputTokens.total} output) · ${row.costUsd.toFixed(4)} reported ({row.coverage.costUsd.reported}/{row.coverage.costUsd.total} cost) · {(row.latencyMs / 1000).toFixed(1)}s ({row.coverage.latencyMs.reported}/{row.coverage.latencyMs.total} latency)</p>)}</div></details>
            </div>)}
          </section>}

          {viewMode !== "series" && <section className="board-panel panel">
            <div className="board-heading">
              <div><span className="eyebrow">THE ARENA</span><h2>{isReplayMatch ? "Match replay" : `${chosenGame?.label ?? viewMode} arena`}</h2></div>
              {selectedMatch && <span className="game-time-badge">{selectedMatch.settings.budgets.maxWallMinutes} MIN · {selectedMatch.timeAccounting ? "ACTIVE" : "LEGACY WALL"}</span>}
              <div className={`match-state ${currentIsRunning ? "is-live" : ""}`}>
                <span className="state-dot" />{selectedMatch ? selectedMatch.status.toUpperCase() : "WAITING"}
              </div>
            </div>
            {selectedMatch?.gameId === "chess" && <div className="player-strip">
              {selectedMatch.players.map((player) => {
                const playerTurns = selectedMatch.history.filter((turn) => turn.playerId === player.id);
                const attempts = [...playerTurns.flatMap((turn) => turn.attempts), ...(selectedMatch.pendingTurn?.playerId === player.id ? selectedMatch.pendingTurn.attempts : [])];
                const usage = aggregateUsage(attempts);
                const latest = playerTurns.at(-1);
                const active = selectedMatch.currentPlayerId === player.id;
                const totalTokens = usage.inputTokens + usage.outputTokens;
                return <div className={`player-strip-card ${player.id === "white" ? "strip-white" : "strip-black"}`} key={player.id}>
                  <span className={`strip-piece strip-piece-${player.id}`} aria-hidden="true" />
                  <span className="strip-info"><b>{player.label} · {competitorLabel(player.agent)}</b><small>{statusForPlayer(selectedMatch, player.id, active)}</small></span>
                  <span className="strip-metric"><b>{latest?.latencyMs != null ? `${(latest.latencyMs / 1000).toFixed(1)}s` : "—"}</b><small>LAST MOVE</small><small>{usage.requests} req · {usage.tokensKnown ? `${totalTokens} tok${coverageMark(usage.coverage)}` : "tokens unknown"} · {attempts.some((attempt) => attempt.usage.costUsd !== null) ? `$${usage.costUsd.toFixed(4)} reported` : "cost unknown"}</small></span>
                  {active && <span className="strip-live" />}
                </div>;
              })}
            </div>}
            {selectedMatch?.status === "error" && selectedMatch.error && <div className="error-banner match-error" role="alert">
              <strong>Agent request failed</strong><p>{selectedMatch.error}</p>
            </div>}
            {unqualifiedMatch && <div className="launch-blocker" role="status"><strong>Unverified comparison.</strong> This match lacks proof that two distinct requested models actually ran. Its game result remains in history, but it does not count toward comparative standings.</div>}
            {!selectedMatch && viewMode !== "chess" ? <div className="empty-arena">Start a {viewMode} match to watch the agents play.</div> : <ArenaRouter match={selectedMatch} replayPly={replayPly} chess={{ boardFen, boardOrientation, squareStyles, summary: selectedMatch ? positionSummary(boardFen, displayedMove?.san) : "Starting position. Select or start a match." }} />}
            <div className="board-caption">
              <span>{selectedMatch ? (replayPly !== null ? `Reviewing ${replayUnit.toLowerCase()} ${replayPly} of ${totalPlies}` : resultLine(selectedMatch)) : viewMode === "hangman" ? "No Hangman match selected." : "The board is ready for its first match."}</span>
              {selectedMatch && (
                <div className="match-actions">
                  {selectedMatch.gameId === "chess" && <button className="quiet-button" onClick={() => setBoardOrientation((value) => value === "white" ? "black" : "white")} aria-label="Flip board orientation"><FlipVertical className="button-icon" /> FLIP</button>}
                  {!selectedMatch.series && currentIsRunning && <button className="quiet-button" onClick={() => void pauseMatch()} disabled={pendingCommand !== null}>{pendingCommand === "pause" ? "PAUSING…" : "PAUSE"}</button>}
                  {!selectedMatch.series && canStart && <button className="primary-button compact" onClick={() => void resumeMatch()} disabled={pendingCommand !== null}>{selectedMatch.status === "ready" ? "START THIS MATCH" : pendingCommand === "start" ? "RESUMING…" : "RESUME MATCH"}</button>}
                  {!selectedMatch.series && ["ready", "running", "paused", "interrupted"].includes(selectedMatch.status) && <button className="stop-button" onClick={() => void stopMatch()} disabled={pendingCommand !== null}>{pendingCommand === "stop" ? "STOPPING…" : "STOP"}</button>}
                </div>
              )}
            </div>
            {selectedMatch?.result && replayPly !== null && <div className="replay-note">Viewing a historical position. Final result: {selectedMatch.result.notation} · {selectedMatch.result.reason}.</div>}
            {selectedMatch && <div className="export-bar">
              <span className="export-totals">{matchTotals ? `MATCH ${matchTotals.requests} req · ${matchTotals.inputTokens + matchTotals.outputTokens} tok${coverageMark(matchTotals.coverage)} · ${!matchTotals.costKnown ? "cost unknown" : `$${matchTotals.costUsd.toFixed(4)} reported`}` : ""}</span>
              {selectedMatch.gameId === "chess" && <button className="quiet-button" onClick={() => void copyText(boardFen, "FEN")}><Copy className="button-icon" /> FEN</button>}
              {selectedMatch?.gameId === "chess" && <button className="quiet-button" onClick={downloadPgn} disabled={!totalPlies}><Download className="button-icon" /> PGN</button>}
              <button className="quiet-button" onClick={() => void downloadJson()}><Download className="button-icon" /> JSON</button>
            </div>}
            {notice && <div className="notice" role="status">{notice}</div>}
            {currentIsRunning && <div className="turn-indicator">
              <span><span className="live-dot" /> THINKING · {currentTurnName ?? "AGENT"}</span>
              <span className={`turn-clock ${gameSecondsLeft <= 60 ? "is-urgent" : ""}`}>GAME {formatClock(gameSecondsLeft)} LEFT</span>
              <span className={`turn-clock ${turnSecondsLeft <= 10 ? "is-urgent" : ""}`} aria-hidden="true">{formatClock(turnSecondsLeft)} LEFT</span>
            </div>}
            {canReplay && <div className="replay-control">
              <div className="replay-header">
                <span className="eyebrow">REPLAY</span>
                <span className="replay-step" role="status">{replayUnit} {viewingPly} of {totalPlies}</span>
                <button className="quiet-button" onClick={() => { setReplayOpen((open) => !open); setReplayPly(null); }}>{replayOpen ? "Hide and return to current" : "Review actions"}</button>
              </div>
              {replayOpen && <>
                <input type="range" aria-label="Replay position" aria-valuetext={`${replayUnit} ${viewingPly} of ${totalPlies}`} min={0} max={totalPlies} value={viewingPly}
                  onChange={(event) => moveToPly(Number(event.target.value))} />
                <div className="replay-buttons">
                  <button className="quiet-button" onClick={() => moveToPly(0)} aria-label="First position"><ChevronLeft className="button-icon" /><ChevronLeft className="button-icon" /></button>
                  <button className="quiet-button" onClick={() => moveToPly(viewingPly - 1)} aria-label="Previous position"><ChevronLeft className="button-icon" /></button>
                  <button className="quiet-button" onClick={() => moveToPly(viewingPly + 1)} aria-label="Next position"><ChevronRight className="button-icon" /></button>
                  <button className="quiet-button" onClick={() => moveToPly(totalPlies)} aria-label="Last position"><ChevronRight className="button-icon" /><ChevronRight className="button-icon" /></button>
                </div>
              </>}
            </div>}
          </section>}

          {viewMode !== "series" && <section className="history-panel panel">
            <div className="section-heading compact-heading"><div><span className="eyebrow">03 / THE RECORD</span><h2>Recent matches</h2></div><span className="setup-tag">LOCAL HISTORY</span></div>
            <div className="history-list">
              {(state?.recentMatches ?? []).filter((match) => match.gameId === viewMode).length === 0 && <div className="empty-state">No {viewMode} matches yet. Pick two agents and start a match.</div>}
              {(state?.recentMatches ?? []).filter((match) => match.gameId === viewMode).map((match) => <button key={match.id} className={`history-row ${match.id === selectedMatch?.id ? "selected" : ""}`}
                aria-current={match.id === selectedMatch?.id ? "true" : undefined}
                onClick={() => chooseView(match.gameId as "chess" | "hangman", match.id)}>
                <span className="history-date">{new Date(match.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span className="history-players"><b>{competitorLabel(match.players[0].agent)}</b><small>vs</small><b>{competitorLabel(match.players[1].agent)}</b></span>
                <span className={`history-result ${match.result ? "" : "muted"}`}>{match.result && !verifiedDistinctModels(match.players[0].agent, match.players[1].agent) ? "unverified" : match.result?.notation ?? match.status}</span>
                <span className="history-moves">{match.actionCount} actions · {match.gameId}</span>
              </button>)}
            </div>
          </section>}
        </div>

        {viewMode !== "series" && <aside className="side-column">
          <section className="scoreboard panel">
            <div className="section-heading"><div><span className="eyebrow">{hangmanLanes ? "CURRENT MATCH" : "HALL OF FAME"}</span><h2>{hangmanLanes ? "Live comparison" : `${selectedMatch?.gameId ?? gameId} scoreboard`}</h2></div><Trophy className="trophy" /></div>
            {hangmanLanes && selectedMatch && <div className="live-comparison">
              <div className="live-comparison-head"><span>LANE</span><span>STATUS</span><span>MISSES</span><span>ACTIONS</span></div>
              {selectedMatch.players.map((player) => { const lane = hangmanLanes[player.id]; return <div className="live-comparison-row" key={player.id}><strong>{player.label}</strong><span>{lane.status}</span><span>{lane.misses}/7</span><span>{lane.actionsTaken}</span></div>; })}
              <p>{selectedMatch.result ? `${selectedMatch.result.kind === "draw" ? "Draw" : `${selectedMatch.players.find((player) => player.id === selectedMatch.result?.winnerId)?.label} wins`} · ${selectedMatch.result.reason}` : "Final result is decided after both lanes finish."}</p>
            </div>}
            {hangmanLanes && <h3 className="score-subhead">Recent Hangman results</h3>}
            {standings.length === 0 ? <div className="score-empty">The leaderboard starts after game one.</div> : <table className="score-table">
              <caption className="sr-only">Scoreboard by competitor and time control across recent matches</caption>
              <thead><tr><th scope="col">AGENT</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th><th scope="col">PTS</th></tr></thead>
              <tbody>
                {standings.map((row, index) => <tr key={`${row.name}:${row.control}`}>
                  <th scope="row" className="score-player"><span className={`rank-badge rank-${index + 1}`}>{String(index + 1).padStart(2, "0")}</span><span>{row.name}<small className="score-control">{row.control}</small></span></th>
                  <td>{row.wins}</td><td>{row.draws}</td><td>{row.losses}</td><td className="score-points">{row.points}</td>
                </tr>)}
              </tbody>
            </table>}
            <div className="score-legend">1 point for a win · ½ for a draw · recent {(state?.recentMatches ?? []).filter((match) => match.gameId === viewMode).length} {viewMode} matches</div>
          </section>

          <section className="moves-panel panel">
            <div className="section-heading">
              <div><span className="eyebrow">MOVE BY MOVE</span><h2>{viewMode === "chess" ? "Notation" : "Actions"}</h2></div>
              <div className="notation-actions">
                {viewMode === "chess" && <button className="quiet-button" onClick={downloadPgn} disabled={!totalPlies}><Download className="button-icon" /> PGN</button>}
                <button className="quiet-button" onClick={() => void downloadJson()} disabled={!selectedMatch}><Download className="button-icon" /> JSON</button>
              </div>
            </div>
            {viewMode !== "chess" ? <div className="event-list">{!selectedMatch || selectedMatch.history.length === 0 ? <p>Accepted actions and corrections appear here.</p> : selectedMatch.history.map((turn, index) => <div className="event-row" key={turn.turnId}><span>{index + 1}.</span><span>{turn.playerLabel}: {turn.actionLabel ?? "Request failed"}<small> · {turn.attempts.length} request(s)</small></span></div>)}</div> : !selectedSnapshot?.moves?.length ? <div className="score-empty">Moves will appear here as the agents play.</div> : <div className="move-list" ref={moveListRef}>
              {Array.from({ length: Math.ceil(selectedSnapshot.moves.length / 2) }, (_, index) => {
                const white = selectedSnapshot.moves[index * 2];
                const black = selectedSnapshot.moves[index * 2 + 1];
                const activePly = viewingPly;
                return <div className={`move-row ${activePly === index * 2 + 1 || activePly === index * 2 + 2 ? "move-active" : ""}`} key={white.ply}>
                  <span className="move-number">{index + 1}.</span>
                  <button className="move-cell" onClick={() => moveToPly(index * 2 + 1)} aria-label={`Go to ply ${index * 2 + 1}, ${white.san}`}>{white.san}</button>
                  {black ? <button className="move-cell" onClick={() => moveToPly(index * 2 + 2)} aria-label={`Go to ply ${index * 2 + 2}, ${black.san}`}>{black.san}</button> : <span className="move-empty">·</span>}
                </div>;
              })}
            </div>}
          </section>

          <section className="log-panel panel">
            <div className="section-heading"><div><span className="eyebrow">LIVE FEED</span><h2>Match log</h2></div><span className="feed-light" /></div>
            <div className="event-list">
              {!selectedMatch?.events.length && <div className="score-empty">Game events show up here.</div>}
              {(selectedMatch?.events ?? []).slice(-7).reverse().map((event, index) => {
                const kind = event.type.includes("error") || event.type.includes("timeout") || event.type.includes("rejected") ? "error" : event.type.includes("move") ? "move" : event.type.includes("thinking") ? "thinking" : "system";
                return <div className="event-row" key={`${event.at}-${index}`}>
                <span className={`event-mark event-${kind}`}>{kind === "move" ? <ArrowUpRight className="event-icon" /> : kind === "error" ? "!" : kind === "thinking" ? "…" : "·"}</span>
                <span className="event-text">{selectedMatch ? eventLabel(selectedMatch, event) : event.text}<time>{new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></span>
              </div>;
              })}
            </div>
          </section>

          <div className="footnote"><BoardMark className="footnote-mark" /> THE AGENTS PLAY. THE ENGINE KEEPS SCORE.</div>
        </aside>}
      </section>
      <footer className="page-footer"><span>AGENT BATTLE <b>·</b> v{__APP_VERSION__}</span><span>LOCAL FIRST · CHESS + HANGMAN + BATTLESHIP</span></footer>
    </main>
  );
}

function PlayerPicker(props: {
  title?: string;
  color: "white" | "black";
  provider: Provider;
  model: string;
  reasoning: string;
  providers: AppState["providers"];
  loading: boolean;
  requiredModel?: boolean;
  onProvider: (provider: Provider) => void;
  onModel: (model: string) => void;
  onReasoning: (reasoning: string) => void;
}) {
  const cardTitle = props.title ?? (props.color === "white" ? "WHITE PLAYER" : "BLACK PLAYER");
  const providerInfo = props.providers.find((item) => item.provider === props.provider);
  const options = reasoningOptions[props.provider];
  return <div className={`player-card player-${props.color}`}>
    <div className="player-card-top"><span className={`piece-disc piece-disc-${props.color}`} aria-hidden="true" /><span>{cardTitle}</span><span className={`agent-presence ${props.loading ? "checking" : providerInfo?.installed ? "available" : ""}`} title={props.loading ? "Checking CLI" : providerInfo?.installed ? "CLI found on PATH; authentication is not verified" : "CLI not found"} /></div>
    <label className="field-label" htmlFor={`${props.color}-provider`}>AGENT CLI</label>
    <div className="provider-field">
      <span className={`provider-mark provider-${props.provider}`} aria-hidden="true">{marks[props.provider]}</span>
      <select id={`${props.color}-provider`} value={props.provider} onChange={(event) => props.onProvider(event.target.value as Provider)}>
        {(["codex", "claude", "opencode"] as Provider[]).map((provider) => {
          const info = props.providers.find((item) => item.provider === provider);
          return <option value={provider} key={provider}>{pretty[provider]}{!props.loading && info && !info.installed ? " · not installed" : ""}</option>;
        })}
      </select>
      <ChevronDown className="select-chevron" aria-hidden="true" />
    </div>
    <label className="field-label" htmlFor={`${props.color}-model`}>MODEL <span>{props.requiredModel ? "required for series" : "optional"}</span></label>
    <input id={`${props.color}-model`} className="model-input" value={props.model} onChange={(event) => props.onModel(event.target.value)}
      placeholder={props.loading ? "Checking local CLI…" : providerInfo?.defaultModel ?? "Use CLI default"} autoComplete="off" spellCheck={false} />
    <label className="field-label" htmlFor={`${props.color}-reasoning`}>REASONING <span>optional</span></label>
    <input id={`${props.color}-reasoning`} className="model-input" value={props.reasoning} onChange={(event) => props.onReasoning(event.target.value)}
      list={options.length ? `${props.color}-reasoning-options` : undefined} placeholder="CLI default" autoComplete="off" spellCheck={false} />
    {options.length > 0 && <datalist id={`${props.color}-reasoning-options`}>{options.map((option) => <option key={option} value={option} />)}</datalist>}
    <div className="model-hint">{props.loading ? "Checking local CLI…" : providerInfo?.installed ? `${providerInfo.version ?? "CLI ready"} · availability only, authentication not verified` : "Not found on PATH"}</div>
  </div>;
}

export default App;
