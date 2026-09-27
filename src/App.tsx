import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import { applyMatchEvent, applyPresentationEvent, matchEventTypes } from "./client/matchEvents.js";
import { highlightSquares, positionSummary } from "./client/chessView.js";
import { aggregateUsage } from "./domain/usage.js";
import { remainingMatchMs } from "./domain/matchTime.js";
import { ArrowUpRight, BoardMark, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FlipVertical, RefreshCw, Trophy } from "./components/icons.js";
import { competitorId, competitorLabel } from "./shared.js";
import type { AppState, ChessSnapshot, MatchEvent, MatchRecord, Provider } from "./shared.js";

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

function loadPreferences(): Partial<Preferences> {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
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

function resultLine(match: MatchRecord): string {
  if (match.result) return `${match.result.notation} · ${match.result.reason}`;
  if (match.status === "error") return "The match stopped at this position. Review the error below.";
  if (match.status === "ready") return "Ready to start";
  if (match.status === "running") return match.currentPlayerId ? `${match.players.find((player) => player.id === match.currentPlayerId)?.label ?? match.currentPlayerId} to move` : "Starting next turn";
  return match.error ?? match.status;
}

function statusForPlayer(match: MatchRecord, playerId: string, isActiveTurn: boolean): string {
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

function App() {
  const preferences = useMemo(() => loadPreferences(), []);
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
  const [maxPlies, setMaxPlies] = useState(150);
  const [maxRequests, setMaxRequests] = useState(200);
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
  const [detailById, setDetailById] = useState<Map<string, MatchRecord>>(() => new Map());
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
    try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); }
    catch { /* Preferences are best-effort. */ }
  }, [whiteProvider, blackProvider, whiteModel, blackModel, whiteReasoning, blackReasoning, timeoutSeconds]);

  useEffect(() => {
    try { window.localStorage.setItem("agent-battle.selected", selectedId ?? ""); }
    catch { /* Selection persistence is best-effort. */ }
  }, [selectedId]);

  const rememberSnapshot = useCallback((next: AppState) => {
    const map = revisions.current;
    map.clear();
    for (const match of next.recentMatches) map.set(match.id, match.revision ?? 0);
    if (next.activeMatch) map.set(next.activeMatch.id, next.activeMatch.revision ?? 0);
  }, []);

  const refresh = useCallback(async () => {
    const next = await api<AppState>("/api/state");
    rememberSnapshot(next);
    setState(next);
    setProvidersChecked(true);
    setSelectedId((current) => (current && (next.activeMatchId === current || next.recentMatches.some((match) => match.id === current)) ? current : next.activeMatchId ?? next.recentMatches[0]?.id ?? null));
  }, [rememberSnapshot]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnection("live");
    source.addEventListener("snapshot", (event) => {
      try {
        const next = JSON.parse((event as MessageEvent<string>).data) as AppState;
        rememberSnapshot(next);
        setState(next);
        setProvidersChecked(true);
        setConnection("live");
        setSelectedId((current) => (current && (next.activeMatchId === current || next.recentMatches.some((match) => match.id === current)) ? current : next.activeMatchId ?? next.recentMatches[0]?.id ?? null));
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
  }, [refresh, rememberSnapshot]);

  const selectedMatch = useMemo(() => {
    if (!state) return null;
    if (selectedId && state.activeMatch && selectedId === state.activeMatch.id) return state.activeMatch;
    const detail = selectedId ? detailById.get(selectedId) : undefined;
    if (detail) return detail;
    return state.activeMatch ?? state.recentMatches.find((match) => match.id === selectedId) ?? state.recentMatches[0] ?? null;
  }, [state, selectedId, detailById]);

  useEffect(() => {
    if (!selectedId || !state) return;
    if (selectedId === state.activeMatchId) return;
    if (detailById.has(selectedId)) return;
    let cancelled = false;
    void api<{ match: MatchRecord }>(`/api/matches/${selectedId}`).then((result) => {
      if (!cancelled) setDetailById((current) => new Map(current).set(result.match.id, result.match));
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the selected match."));
    return () => { cancelled = true; };
  }, [selectedId, state, detailById]);

  const selectedSnapshot = selectedMatch?.gameState as ChessSnapshot | undefined;
  const totalPlies = selectedSnapshot?.moves.length ?? 0;
  const viewingPly = replayPly ?? totalPlies;
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
      if (!match.result || !["finished", "forfeit"].includes(match.status)) continue;
      for (const player of match.players) {
        const side = player.id;
        const name = competitorLabel(player.agent);
        const control = `${match.settings.budgets.maxWallMinutes}m ${match.timeAccounting ? "active" : "legacy"} · ${match.settings.turnTimeoutSeconds}s/turn`;
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
  }, [state]);

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

  useEffect(() => {
    if (!currentIsRunning) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [currentIsRunning, selectedMatch?.currentPlayerId]);

  const currentTurnStart = selectedMatch?.events.filter((event) => event.type === "agent.started" && event.playerId === selectedMatch.currentPlayerId).at(-1)?.at;
  const currentTurnElapsed = currentIsRunning && currentTurnStart ? Math.max(0, Math.floor((now - Date.parse(currentTurnStart)) / 1000)) : 0;
  const turnSecondsLeft = Math.max(0, (selectedMatch?.settings.turnTimeoutSeconds ?? timeoutSeconds) - currentTurnElapsed);
  const gameSecondsLeft = selectedMatch ? Math.max(0, Math.ceil(remainingMatchMs(selectedMatch, now) / 1000)) : 0;

  const startMatch = async () => {
    setPendingCommand("start"); setError("");
    try {
      const created = await api<{ match: MatchRecord }>("/api/matches", {
        method: "POST",
        body: JSON.stringify({
          gameId: "chess",
          white: { provider: whiteProvider, model: whiteModel, reasoning: whiteReasoning },
          black: { provider: blackProvider, model: blackModel, reasoning: blackReasoning },
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
    return aggregateUsage(selectedMatch.history.flatMap((turn) => turn.attempts));
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
      const result = await api<{ match: MatchRecord }>(`/api/matches/${selectedMatch.id}`);
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

      {state?.storage && state.storage.status !== "healthy" && <div className="error-banner" role="alert">
        <strong>{state.storage.status === "write_failed" ? "Storage unavailable — requests stopped" : "Saved history needs review"}</strong>
        <p>{state.storage.message}</p>
      </div>}

      <section className={`intro ${condenseSetup ? "is-condensed" : ""}`} id="top">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> THE THINKING MACHINE LEAGUE</div>
          <h1>Let them <em>play.</em></h1>
          <p>Two agents. One board. Every move is theirs.</p>
        </div>
        <BoardMark className="intro-mark" />
      </section>

      <section className="arena-layout">
        <div className="arena-main">
          <section className={`match-setup panel ${condenseSetup ? "is-condensed" : ""}`}>
            <div className="section-heading">
              <div><span className="eyebrow">01 / THE MATCH</span><h2>{condenseSetup ? "Match settings" : "Choose your players"}</h2></div>
              <span className="setup-tag">{condenseSetup ? selectedMatch?.status.toUpperCase() : "CHESS · STANDARD"}</span>
            </div>
            {condenseSetup ? <div className="active-setup-note">
              <span className="live-dot" />
              <span>{selectedMatch?.players.map((player) => competitorLabel(player.agent)).join(" vs ")}</span>
              <span className="active-setup-status">{selectedMatch?.result ? `${selectedMatch.result.notation} · ${selectedMatch.result.reason}` : selectedMatch?.status === "error" ? "Stopped · review match log" : selectedMatch?.currentPlayerId ? `${selectedMatch.players.find((player) => player.id === selectedMatch.currentPlayerId)?.label} to move` : "Resume when ready"}</span>
              {terminalMatchSelected && <button className="active-setup-new" onClick={() => setNewMatchOpen(true)}>NEW MATCH <ArrowUpRight className="inline-icon" /></button>}
            </div> : <>
              <div className="players-grid">
                <PlayerPicker color="white" provider={whiteProvider} model={whiteModel} reasoning={whiteReasoning} providers={providers} loading={!providersChecked}
                  onProvider={chooseWhiteProvider} onModel={setWhiteModel} onReasoning={setWhiteReasoning} />
                <div className="versus"><span>VS</span></div>
                <PlayerPicker color="black" provider={blackProvider} model={blackModel} reasoning={blackReasoning} providers={providers} loading={!providersChecked}
                  onProvider={chooseBlackProvider} onModel={setBlackModel} onReasoning={setBlackReasoning} />
              </div>
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
                  <label className="timeout-setting">MAX PLIES <input type="number" min={1} max={10000} value={maxPlies}
                    onChange={(event) => setMaxPlies(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} /></label>
                  <label className="timeout-setting">MAX REQUESTS <input type="number" min={1} max={100000} value={maxRequests}
                    onChange={(event) => setMaxRequests(Math.max(1, Math.min(100000, Number(event.target.value) || 1)))} /></label>
                  <label className="timeout-setting">COST LIMIT <input type="number" min={0} step="0.01" placeholder="none" value={maxCost}
                    onChange={(event) => setMaxCost(event.target.value)} /> <span>USD</span></label>
                </div>
                <button className="primary-button" onClick={() => void startMatch()} disabled={busy || pendingCommand !== null || !providersChecked || !canCreate || !installed(whiteProvider) || !installed(blackProvider)}>
                  {busy || pendingCommand === "start" ? "PREPARING…" : "START MATCH"} <ArrowUpRight className="inline-icon" />
                </button>
              </div>
              <div className="inline-note">Game time counts while the match runs, including an active provider request; pause stops its clock. Move timeout is a separate per-request limit. Short presets may stop before a chess result. Cost remains a best-effort threshold on reported provider usage.</div>
              {(whiteProvider === blackProvider) && <div className="inline-note">Both sides can use the same CLI with different models.</div>}
              {providersChecked && providers.some((entry) => !entry.installed) && <div className="inline-note">Install a supported CLI and sign in before choosing it. Agent Battle uses its existing login.</div>}
            </>}
            {!canCreate && state?.activeMatch && <div className="inline-note">A match is already active. <button className="link-button" onClick={() => { setSelectedId(state.activeMatch!.id); setNewMatchOpen(false); setReplayPly(null); }}>Open the current match</button> to stop it or let it finish.</div>}
            {error && <div className="error-banner" role="alert">{error}</div>}
          </section>

          <section className="board-panel panel">
            <div className="board-heading">
              <div><span className="eyebrow">02 / THE ARENA</span><h2>{isReplayMatch ? "Match replay" : selectedMatch ? "Match board" : "Live board"}</h2></div>
              {selectedMatch && <span className="game-time-badge">{selectedMatch.settings.budgets.maxWallMinutes} MIN · {selectedMatch.timeAccounting ? "ACTIVE" : "LEGACY WALL"}</span>}
              <div className={`match-state ${currentIsRunning ? "is-live" : ""}`}>
                <span className="state-dot" />{selectedMatch ? selectedMatch.status.toUpperCase() : "WAITING"}
              </div>
            </div>
            {selectedMatch && <div className="player-strip">
              {selectedMatch.players.map((player) => {
                const playerTurns = selectedMatch.history.filter((turn) => turn.playerId === player.id);
                const attempts = playerTurns.flatMap((turn) => turn.attempts);
                const usage = aggregateUsage(attempts);
                const latest = playerTurns.at(-1);
                const active = selectedMatch.currentPlayerId === player.id;
                const totalTokens = usage.inputTokens + usage.outputTokens;
                return <div className={`player-strip-card ${player.id === "white" ? "strip-white" : "strip-black"}`} key={player.id}>
                  <span className={`strip-piece strip-piece-${player.id}`} aria-hidden="true" />
                  <span className="strip-info"><b>{player.label} · {competitorLabel(player.agent)}</b><small>{statusForPlayer(selectedMatch, player.id, active)}</small></span>
                  <span className="strip-metric"><b>{latest?.latencyMs != null ? `${(latest.latencyMs / 1000).toFixed(1)}s` : "—"}</b><small>LAST MOVE</small><small>{usage.requests} req · {totalTokens || usage.coverage === "none" ? `${totalTokens} tok${coverageMark(usage.coverage)}` : "tokens n/a"} · {usage.costUsd || usage.coverage === "none" ? `$${usage.costUsd.toFixed(4)}` : "cost n/a"}</small></span>
                  {active && <span className="strip-live" />}
                </div>;
              })}
            </div>}
            {selectedMatch?.status === "error" && selectedMatch.error && <div className="error-banner match-error" role="alert">
              <strong>Agent request failed</strong><p>{selectedMatch.error}</p>
            </div>}
            <div className="board-frame">
              <div className="board-rank rank-left"><span>8</span><span>7</span><span>6</span><span>5</span><span>4</span><span>3</span><span>2</span><span>1</span></div>
              <div className="chessboard-wrap">
                <Chessboard options={{
                  position: boardFen,
                  boardOrientation,
                  allowDragging: false,
                  showAnimations: true,
                  animationDurationInMs: 240,
                  boardStyle: { borderRadius: "3px", width: "100%" },
                  lightSquareStyle: { backgroundColor: "#d8cfb7" },
                  darkSquareStyle: { backgroundColor: "#526c61" },
                  squareStyles,
                  showNotation: false,
                }} />
              </div>
              <div className="board-rank rank-right"><span>8</span><span>7</span><span>6</span><span>5</span><span>4</span><span>3</span><span>2</span><span>1</span></div>
              <div className="board-files"><span>a</span><span>b</span><span>c</span><span>d</span><span>e</span><span>f</span><span>g</span><span>h</span></div>
            </div>
            <p className="board-summary" aria-live="polite">{selectedMatch ? positionSummary(boardFen, displayedMove?.san) : "Starting position. Select or start a match."}</p>
            <div className="board-caption">
              <span>{selectedMatch ? (replayPly !== null ? `Reviewing ply ${replayPly} of ${totalPlies}` : resultLine(selectedMatch)) : "The board is ready for its first match."}</span>
              {selectedMatch && (
                <div className="match-actions">
                  <button className="quiet-button" onClick={() => setBoardOrientation((value) => value === "white" ? "black" : "white")} aria-label="Flip board orientation"><FlipVertical className="button-icon" /> FLIP</button>
                  {currentIsRunning && <button className="quiet-button" onClick={() => void pauseMatch()} disabled={pendingCommand !== null}>{pendingCommand === "pause" ? "PAUSING…" : "PAUSE"}</button>}
                  {canStart && <button className="primary-button compact" onClick={() => void resumeMatch()} disabled={pendingCommand !== null}>{selectedMatch.status === "ready" ? "START THIS MATCH" : pendingCommand === "start" ? "RESUMING…" : "RESUME MATCH"}</button>}
                  {["ready", "running", "paused", "interrupted"].includes(selectedMatch.status) && <button className="stop-button" onClick={() => void stopMatch()} disabled={pendingCommand !== null}>{pendingCommand === "stop" ? "STOPPING…" : "STOP"}</button>}
                </div>
              )}
            </div>
            {selectedMatch?.result && replayPly !== null && <div className="replay-note">Viewing a historical position. Final result: {selectedMatch.result.notation} · {selectedMatch.result.reason}.</div>}
            {selectedMatch && <div className="export-bar">
              <span className="export-totals">{matchTotals ? `MATCH ${matchTotals.requests} req · ${matchTotals.inputTokens + matchTotals.outputTokens} tok${coverageMark(matchTotals.coverage)} · $${matchTotals.costUsd.toFixed(4)}` : ""}</span>
              <button className="quiet-button" onClick={() => void copyText(boardFen, "FEN")}><Copy className="button-icon" /> FEN</button>
              <button className="quiet-button" onClick={downloadPgn} disabled={!totalPlies}><Download className="button-icon" /> PGN</button>
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
                <span className="replay-step" role="status">Ply {viewingPly} of {totalPlies}</span>
                <button className="quiet-button" onClick={() => { setReplayOpen((open) => !open); setReplayPly(null); }}>{replayOpen ? "Hide and return to current" : "Review moves"}</button>
              </div>
              {replayOpen && <>
                <input type="range" aria-label="Replay position" aria-valuetext={`Ply ${viewingPly} of ${totalPlies}`} min={0} max={totalPlies} value={viewingPly}
                  onChange={(event) => moveToPly(Number(event.target.value))} />
                <div className="replay-buttons">
                  <button className="quiet-button" onClick={() => moveToPly(0)} aria-label="First position"><ChevronLeft className="button-icon" /><ChevronLeft className="button-icon" /></button>
                  <button className="quiet-button" onClick={() => moveToPly(viewingPly - 1)} aria-label="Previous position"><ChevronLeft className="button-icon" /></button>
                  <button className="quiet-button" onClick={() => moveToPly(viewingPly + 1)} aria-label="Next position"><ChevronRight className="button-icon" /></button>
                  <button className="quiet-button" onClick={() => moveToPly(totalPlies)} aria-label="Last position"><ChevronRight className="button-icon" /><ChevronRight className="button-icon" /></button>
                </div>
              </>}
            </div>}
          </section>

          <section className="history-panel panel">
            <div className="section-heading compact-heading"><div><span className="eyebrow">03 / THE RECORD</span><h2>Recent matches</h2></div><span className="setup-tag">LOCAL HISTORY</span></div>
            <div className="history-list">
              {(state?.recentMatches ?? []).length === 0 && <div className="empty-state">No matches yet. Pick two agents and let the first game begin.</div>}
              {(state?.recentMatches ?? []).map((match) => <button key={match.id} className={`history-row ${match.id === selectedMatch?.id ? "selected" : ""}`}
                aria-current={match.id === selectedMatch?.id ? "true" : undefined}
                onClick={() => { setSelectedId(match.id); setNewMatchOpen(false); setReplayPly(null); setReplayOpen(false); }}>
                <span className="history-date">{new Date(match.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span className="history-players"><b>{competitorLabel(match.players[0].agent)}</b><small>vs</small><b>{competitorLabel(match.players[1].agent)}</b></span>
                <span className={`history-result ${match.result ? "" : "muted"}`}>{match.result?.notation ?? match.status}</span>
                <span className="history-moves">{((match.gameState as ChessSnapshot)?.moves?.length ?? 0)} ply</span>
              </button>)}
            </div>
          </section>
        </div>

        <aside className="side-column">
          <section className="scoreboard panel">
            <div className="section-heading"><div><span className="eyebrow">HALL OF FAME</span><h2>Scoreboard</h2></div><Trophy className="trophy" /></div>
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
            <div className="score-legend">1 point for a win · ½ for a draw · recent {state?.recentMatches.length ?? 0} matches</div>
          </section>

          <section className="moves-panel panel">
            <div className="section-heading">
              <div><span className="eyebrow">MOVE BY MOVE</span><h2>Notation</h2></div>
              <div className="notation-actions">
                <button className="quiet-button" onClick={downloadPgn} disabled={!totalPlies}><Download className="button-icon" /> PGN</button>
                <button className="quiet-button" onClick={() => void downloadJson()} disabled={!selectedMatch}><Download className="button-icon" /> JSON</button>
              </div>
            </div>
            {!selectedSnapshot?.moves.length ? <div className="score-empty">Moves will appear here as the agents play.</div> : <div className="move-list" ref={moveListRef}>
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
                <span className="event-text">{event.text}<time>{new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></span>
              </div>;
              })}
            </div>
          </section>

          <div className="footnote"><BoardMark className="footnote-mark" /> THE AGENTS PLAY. THE ENGINE KEEPS SCORE.</div>
        </aside>
      </section>
      <footer className="page-footer"><span>AGENT BATTLE <b>·</b> v{__APP_VERSION__}</span><span>LOCAL FIRST · STANDARD CHESS</span></footer>
    </main>
  );
}

function PlayerPicker(props: {
  color: "white" | "black";
  provider: Provider;
  model: string;
  reasoning: string;
  providers: AppState["providers"];
  loading: boolean;
  onProvider: (provider: Provider) => void;
  onModel: (model: string) => void;
  onReasoning: (reasoning: string) => void;
}) {
  const cardTitle = props.color === "white" ? "WHITE PLAYER" : "BLACK PLAYER";
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
    <label className="field-label" htmlFor={`${props.color}-model`}>MODEL <span>optional</span></label>
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
