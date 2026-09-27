import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import { applyMatchEvent, matchEventTypes } from "./client/matchEvents.js";
import { ArrowUpRight, BoardMark, ChevronDown, RefreshCw, Trophy } from "./components/icons.js";
import type { AppState, ChessSnapshot, MatchEvent, MatchRecord, Provider } from "./shared.js";

const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const pretty: Record<Provider, string> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
const marks: Record<Provider, string> = { codex: "CX", claude: "CC", opencode: "OC" };

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

function nameFor(provider: Provider, model: string): string {
  return `${pretty[provider]}${model.trim() ? ` · ${model.trim()}` : " · CLI default"}`;
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
  if (match.status === "running") return isActiveTurn ? "THINKING" : "WAITING";
  if (match.status === "paused") return isActiveTurn ? "PAUSED" : "WAITING";
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
  const [state, setState] = useState<AppState | null>(null);
  const [providersChecked, setProvidersChecked] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [whiteProvider, setWhiteProvider] = useState<Provider>("codex");
  const [blackProvider, setBlackProvider] = useState<Provider>("codex");
  const [whiteModel, setWhiteModel] = useState("");
  const [blackModel, setBlackModel] = useState("");
  const [whiteReasoning, setWhiteReasoning] = useState("");
  const [blackReasoning, setBlackReasoning] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replayPly, setReplayPly] = useState<number | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [newMatchOpen, setNewMatchOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [pendingCommand, setPendingCommand] = useState<null | "create" | "start" | "pause" | "stop">(null);
  const revisions = useRef<Map<string, number>>(new Map());

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
    setSelectedId((current) => current ?? next.activeMatchId ?? next.recentMatches[0]?.id ?? null);
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
        setSelectedId((current) => current ?? next.activeMatchId ?? next.recentMatches[0]?.id ?? null);
      } catch (reason) {
        setError(reason instanceof Error ? `Could not read the server state: ${reason.message}` : "Could not read the server state.");
      }
    });
    for (const type of matchEventTypes) source.addEventListener(type, (message) => {
      try {
        const envelope = JSON.parse((message as MessageEvent<string>).data) as { matchId?: string; revision?: number; event?: MatchEvent };
        if (!envelope.matchId || !envelope.event) throw new Error("Event envelope is missing its match or event.");
        const matchId = envelope.matchId;
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

  const selectedMatch = useMemo(
    () => state?.recentMatches.find((match) => match.id === selectedId) ?? state?.activeMatch ?? null,
    [state, selectedId],
  );

  const boardFen = useMemo(() => {
    const snapshot = selectedMatch?.gameState as ChessSnapshot | undefined;
    if (!selectedMatch || replayPly === null) return snapshot?.fen ?? initialFen;
    if (replayPly === 0) return initialFen;
    return snapshot?.moves[replayPly - 1]?.fen ?? snapshot?.fen ?? initialFen;
  }, [selectedMatch, replayPly]);

  const standings = useMemo(() => {
    const rows = new Map<string, { name: string; wins: number; draws: number; losses: number; points: number }>();
    for (const match of state?.recentMatches ?? []) {
      if (!match.result || !["finished", "forfeit"].includes(match.status)) continue;
      for (const player of match.players) {
        const side = player.id;
        const name = nameFor(player.agent.provider, player.agent.model);
        const row = rows.get(name) ?? { name, wins: 0, draws: 0, losses: 0, points: 0 };
        const won = match.result.kind === "win" && match.result.winnerId === side;
        const drawn = match.result.kind === "draw";
        if (won) { row.wins += 1; row.points += 1; }
        else if (drawn) { row.draws += 1; row.points += 0.5; }
        else row.losses += 1;
        rows.set(name, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
  }, [state]);

  const providers = state?.providers ?? [];
  const installed = (provider: Provider) => providers.find((item) => item.provider === provider)?.installed ?? false;
  const currentIsRunning = selectedMatch?.status === "running";
  const terminalMatchSelected = Boolean(selectedMatch && ["finished", "forfeit", "stopped", "error"].includes(selectedMatch.status));
  const condenseSetup = Boolean(selectedMatch && (
    ["running", "paused", "interrupted"].includes(selectedMatch.status) || (terminalMatchSelected && !newMatchOpen)
  ));
  const canStart = Boolean(selectedMatch && ["ready", "paused", "interrupted"].includes(selectedMatch.status) && state?.activeMatch?.id === selectedMatch.id);
  const canCreate = !state?.activeMatch || !["ready", "running", "paused"].includes(state.activeMatch.status);
  const selectedSnapshot = selectedMatch?.gameState as ChessSnapshot | undefined;

  useEffect(() => {
    if (!currentIsRunning) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [currentIsRunning, selectedMatch?.currentPlayerId]);

  const currentTurnStart = selectedMatch?.events.filter((event) => event.type === "agent.started" && event.playerId === selectedMatch.currentPlayerId).at(-1)?.at;
  const currentTurnElapsed = currentIsRunning && currentTurnStart ? Math.max(0, Math.floor((now - Date.parse(currentTurnStart)) / 1000)) : 0;
  const turnSecondsLeft = Math.max(0, (selectedMatch?.settings.turnTimeoutSeconds ?? timeoutSeconds) - currentTurnElapsed);

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
  const currentTurnName = currentTurnPlayer ? nameFor(currentTurnPlayer.agent.provider, currentTurnPlayer.agent.model) : undefined;
  const isHistorical = Boolean(selectedMatch && selectedMatch.id !== state?.activeMatch?.id);
  const isReplayMatch = Boolean(isHistorical && (selectedSnapshot?.moves.length ?? 0) > 0);
  const finishedForReplay = selectedMatch && ["finished", "forfeit", "stopped", "error", "interrupted"].includes(selectedMatch.status);

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
              <span>{selectedMatch?.players.map((player) => nameFor(player.agent.provider, player.agent.model)).join(" vs ")}</span>
              <span className="active-setup-status">{selectedMatch?.result ? `${selectedMatch.result.notation} · ${selectedMatch.result.reason}` : selectedMatch?.status === "error" ? "Stopped · review match log" : selectedMatch?.currentPlayerId ? `${selectedMatch.players.find((player) => player.id === selectedMatch.currentPlayerId)?.label} to move` : "Resume when ready"}</span>
              {terminalMatchSelected && <button className="active-setup-new" onClick={() => setNewMatchOpen(true)}>NEW MATCH <ArrowUpRight className="inline-icon" /></button>}
            </div> : <>
              <div className="players-grid">
                <PlayerPicker color="white" provider={whiteProvider} model={whiteModel} reasoning={whiteReasoning} providers={providers} loading={!providersChecked}
                  onProvider={setWhiteProvider} onModel={setWhiteModel} onReasoning={setWhiteReasoning} />
                <div className="versus"><span>VS</span></div>
                <PlayerPicker color="black" provider={blackProvider} model={blackModel} reasoning={blackReasoning} providers={providers} loading={!providersChecked}
                  onProvider={setBlackProvider} onModel={setBlackModel} onReasoning={setBlackReasoning} />
              </div>
              <div className="setup-footer">
                <label className="timeout-setting">MOVE TIMEOUT <input type="number" min={30} max={600} step={30} value={timeoutSeconds}
                  onChange={(event) => setTimeoutSeconds(Math.max(30, Math.min(600, Number(event.target.value) || 30)))} /> <span>sec</span></label>
                <button className="primary-button" onClick={() => void startMatch()} disabled={busy || pendingCommand !== null || !providersChecked || !canCreate || !installed(whiteProvider) || !installed(blackProvider)}>
                  {busy || pendingCommand === "start" ? "PREPARING…" : "START MATCH"} <ArrowUpRight className="inline-icon" />
                </button>
              </div>
              {(whiteProvider === blackProvider) && <div className="inline-note">Both sides can use the same CLI with different models.</div>}
              {providersChecked && providers.some((entry) => !entry.installed) && <div className="inline-note">Install a supported CLI and sign in before choosing it. Agent Battle uses its existing login.</div>}
            </>}
            {!canCreate && state?.activeMatch && <div className="inline-note">A match is already active. <button className="link-button" onClick={() => { setSelectedId(state.activeMatch!.id); setNewMatchOpen(false); setReplayPly(null); }}>Open the current match</button> to stop it or let it finish.</div>}
            {error && <div className="error-banner" role="alert">{error}</div>}
          </section>

          <section className="board-panel panel">
            <div className="board-heading">
              <div><span className="eyebrow">02 / THE ARENA</span><h2>{isReplayMatch ? "Match replay" : selectedMatch ? "Match board" : "Live board"}</h2></div>
              <div className={`match-state ${currentIsRunning ? "is-live" : ""}`}>
                <span className="state-dot" />{selectedMatch ? selectedMatch.status.toUpperCase() : "WAITING"}
              </div>
            </div>
            {selectedMatch && <div className="player-strip">
              {selectedMatch.players.map((player) => {
                const latest = [...selectedMatch.history].reverse().find((turn) => turn.playerId === player.id);
                const completedTurn = [...selectedMatch.events].reverse().find((event) => event.type === "turn.completed" && event.playerId === player.id);
                const completedTelemetry = completedTurn?.payload;
                const active = selectedMatch.currentPlayerId === player.id;
                const inputTokens = typeof completedTelemetry?.inputTokens === "number" ? completedTelemetry.inputTokens : latest?.attempts.reduce((sum, attempt) => sum + (attempt.usage.inputTokens ?? 0), 0) ?? 0;
                const outputTokens = typeof completedTelemetry?.outputTokens === "number" ? completedTelemetry.outputTokens : latest?.attempts.reduce((sum, attempt) => sum + (attempt.usage.outputTokens ?? 0), 0) ?? 0;
                const toolCalls = typeof completedTelemetry?.toolCalls === "number" ? completedTelemetry.toolCalls : latest?.attempts.reduce((sum, attempt) => sum + (attempt.toolCalls ?? 0), 0) ?? 0;
                const latencyMs = typeof completedTelemetry?.latencyMs === "number" ? completedTelemetry.latencyMs : latest?.latencyMs;
                return <div className={`player-strip-card ${player.id === "white" ? "strip-white" : "strip-black"}`} key={player.id}>
                  <span className={`strip-piece strip-piece-${player.id}`} aria-hidden="true" />
                  <span className="strip-info"><b>{player.label} · {nameFor(player.agent.provider, player.agent.model)}</b><small>{statusForPlayer(selectedMatch, player.id, active)}</small></span>
                  <span className="strip-metric"><b>{latencyMs !== null && latencyMs !== undefined ? `${(latencyMs / 1000).toFixed(1)}s` : "—"}</b><small>LAST MOVE</small><small>{inputTokens + outputTokens ? `${inputTokens + outputTokens} tok` : "tokens n/a"} · {toolCalls} tools</small></span>
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
                  boardOrientation: "white",
                  allowDragging: false,
                  showAnimations: true,
                  animationDurationInMs: 240,
                  boardStyle: { borderRadius: "3px", width: "100%" },
                  lightSquareStyle: { backgroundColor: "#d8cfb7" },
                  darkSquareStyle: { backgroundColor: "#526c61" },
                  showNotation: false,
                }} />
              </div>
              <div className="board-rank rank-right"><span>8</span><span>7</span><span>6</span><span>5</span><span>4</span><span>3</span><span>2</span><span>1</span></div>
              <div className="board-files"><span>a</span><span>b</span><span>c</span><span>d</span><span>e</span><span>f</span><span>g</span><span>h</span></div>
            </div>
            <div className="board-caption">
              <span>{selectedMatch ? resultLine(selectedMatch) : "The board is ready for its first match."}</span>
              {selectedMatch && (
                <div className="match-actions">
                  {currentIsRunning && <button className="quiet-button" onClick={() => void pauseMatch()} disabled={pendingCommand !== null}>{pendingCommand === "pause" ? "PAUSING…" : "PAUSE"}</button>}
                  {canStart && <button className="primary-button compact" onClick={() => void resumeMatch()} disabled={pendingCommand !== null}>{selectedMatch.status === "ready" ? "START THIS MATCH" : pendingCommand === "start" ? "RESUMING…" : "RESUME MATCH"}</button>}
                  {["ready", "running", "paused", "interrupted"].includes(selectedMatch.status) && <button className="stop-button" onClick={() => void stopMatch()} disabled={pendingCommand !== null}>{pendingCommand === "stop" ? "STOPPING…" : "STOP"}</button>}
                </div>
              )}
            </div>
            {currentIsRunning && <div className="turn-indicator" role="status" aria-live="polite">
              <span><span className="live-dot" /> THINKING · {currentTurnName ?? "AGENT"}</span>
              <span className={`turn-clock ${turnSecondsLeft <= 10 ? "is-urgent" : ""}`}>{formatClock(turnSecondsLeft)} LEFT</span>
            </div>}
            {finishedForReplay && selectedMatch && (selectedSnapshot?.moves.length ?? 0) > 0 && <div className="replay-control">
              <div><span className="eyebrow">REPLAY</span><button className="quiet-button" onClick={() => setReplayOpen((open) => !open)}>{replayOpen ? "Hide" : "Review moves"}</button></div>
              {replayOpen && <><input type="range" min={0} max={selectedSnapshot?.moves.length ?? 0} value={replayPly ?? selectedSnapshot?.moves.length ?? 0}
                onChange={(event) => setReplayPly(Number(event.target.value))} /><span className="replay-step">{replayPly ?? selectedSnapshot?.moves.length ?? 0} / {selectedSnapshot?.moves.length ?? 0} ply</span></>}
            </div>}
          </section>

          <section className="history-panel panel">
            <div className="section-heading compact-heading"><div><span className="eyebrow">03 / THE RECORD</span><h2>Recent matches</h2></div><span className="setup-tag">LOCAL HISTORY</span></div>
            <div className="history-list">
              {(state?.recentMatches ?? []).length === 0 && <div className="empty-state">No matches yet. Pick two agents and let the first game begin.</div>}
              {(state?.recentMatches ?? []).map((match) => <button key={match.id} className={`history-row ${match.id === selectedMatch?.id ? "selected" : ""}`}
                onClick={() => { setSelectedId(match.id); setNewMatchOpen(false); setReplayPly(null); setReplayOpen(false); }}>
                <span className="history-date">{new Date(match.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span className="history-players"><b>{nameFor(match.players[0].agent.provider, match.players[0].agent.model)}</b><small>vs</small><b>{nameFor(match.players[1].agent.provider, match.players[1].agent.model)}</b></span>
                <span className={`history-result ${match.result ? "" : "muted"}`}>{match.result?.notation ?? match.status}</span>
                <span className="history-moves">{((match.gameState as ChessSnapshot)?.moves?.length ?? 0)} ply</span>
              </button>)}
            </div>
          </section>
        </div>

        <aside className="side-column">
          <section className="scoreboard panel">
            <div className="section-heading"><div><span className="eyebrow">HALL OF FAME</span><h2>Scoreboard</h2></div><Trophy className="trophy" /></div>
            <div className="score-header"><span>AGENT</span><span>W</span><span>D</span><span>L</span><span>PTS</span></div>
            {standings.length === 0 ? <div className="score-empty">The leaderboard starts after game one.</div> : standings.map((row, index) => <div className="score-row" key={row.name}>
              <div className="score-player"><span className={`rank-badge rank-${index + 1}`}>{String(index + 1).padStart(2, "0")}</span><span>{row.name}</span></div>
              <span>{row.wins}</span><span>{row.draws}</span><span>{row.losses}</span><strong>{row.points}</strong>
            </div>)}
            <div className="score-legend">1 point for a win · ½ for a draw</div>
          </section>

          <section className="moves-panel panel">
            <div className="section-heading"><div><span className="eyebrow">MOVE BY MOVE</span><h2>Notation</h2></div><span className="notation-chip">PGN</span></div>
            {!selectedSnapshot?.moves.length ? <div className="score-empty">Moves will appear here as the agents play.</div> : <div className="move-list">
              {Array.from({ length: Math.ceil(selectedSnapshot.moves.length / 2) }, (_, index) => {
                const white = selectedSnapshot.moves[index * 2];
                const black = selectedSnapshot.moves[index * 2 + 1];
                const activePly = replayPly ?? selectedSnapshot.moves.length;
                return <div className={`move-row ${activePly === index * 2 + 1 || activePly === index * 2 + 2 ? "move-active" : ""}`} key={white.ply}>
                  <span className="move-number">{index + 1}.</span><span>{white.san}</span><span>{black?.san ?? "·"}</span>
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
      <footer className="page-footer"><span>AGENT BATTLE <b>·</b> v0.1</span><span>LOCAL FIRST · STANDARD CHESS</span></footer>
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
  return <div className={`player-card player-${props.color}`}>
    <div className="player-card-top"><span className={`piece-disc piece-disc-${props.color}`} aria-hidden="true" /><span>{cardTitle}</span><span className={`agent-presence ${props.loading ? "checking" : providerInfo?.installed ? "available" : ""}`} title={props.loading ? "Checking CLI" : providerInfo?.installed ? "CLI found" : "CLI not found"} /></div>
    <label className="field-label">AGENT CLI</label>
    <div className="provider-field">
      <span className={`provider-mark provider-${props.provider}`}>{marks[props.provider]}</span>
      <select value={props.provider} onChange={(event) => props.onProvider(event.target.value as Provider)}>
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
      placeholder="CLI default" autoComplete="off" spellCheck={false} />
    <div className="model-hint">{props.loading ? "Checking local CLI…" : providerInfo?.version ?? (providerInfo?.installed ? "CLI ready" : "Not found on PATH")}</div>
  </div>;
}

export default App;
