import { modelDisplayName } from "../client/modelPresentation.js";
import { type MatchResult, type PublicMatchDetail } from "../shared.js";
interface View {
  pattern: string; wordLength: number; guessedLetters: string[]; misses: number; terminal: boolean; word?: string; result?: MatchResult;
  players: Record<string, { points: number; misses: number; actionsTaken: number; revealedLetters: number }>;
  history: Array<{ playerId: string; action: { type: string; payload: { letter?: string } }; points: number; correct: boolean }>;
}
export function HangmanDuelArena({ match, replayPly = null }: { match: PublicMatchDetail; replayPly?: number | null }) {
  const view = (replayPly === null ? match.gameState : match.replay?.[replayPly] ?? match.gameState) as View;
  const name = (id: string | undefined) => { const player = match.players.find((entry) => entry.id === id); return player ? modelDisplayName(player.agent.model) : "Next agent"; };
  const result = view.terminal ? view.result : undefined;
  const last = view.history.at(-1);
  return <div className="hangman-duel">
    <div className={`duel-result-banner ${result ? "is-final" : ""}`} role="status"><span className="eyebrow">{result ? "MATCH COMPLETE" : replayPly !== null ? "MATCH REPLAY" : match.status === "running" ? "IN PROGRESS" : match.status.toUpperCase()}</span><h2>{result ? result.kind === "draw" ? "A draw. Well matched." : `${name(result.winnerId!)} wins` : replayPly !== null ? "Watch the word unfold." : match.status === "running" ? match.currentPlayerId ? `${name(match.currentPlayerId)} is thinking…` : "Preparing the next turn…" : "The next move awaits."}</h2><p>{result?.reason ?? "One shared word. Alternating turns. Play for the highest score."}</p></div>
    <div className="duel-players">{match.players.map((player) => {
      const score = view.players[player.id];
      const active = replayPly === null && match.status === "running" && match.currentPlayerId === player.id;
      const turns = match.history.filter((turn) => turn.playerId === player.id);
      const latest = replayPly === null ? turns.at(-1) : turns.filter((turn) => turn.valid).slice(0, score.actionsTaken).at(-1);
      return <section key={player.id} className={`duel-player ${active ? "duel-thinking" : ""} ${result?.winnerId === player.id ? "duel-winner" : ""}`}>
        <span className="eyebrow">{player.label} · {result ? result.kind === "draw" ? "DRAW" : result.winnerId === player.id ? "WINNER" : "FINISHED" : replayPly !== null ? "REPLAY" : active ? "THINKING" : match.status === "running" ? "WAITING" : match.status.toUpperCase()}</span>
        <h3 title={player.agent.model}>{name(player.id)}</h3><span className="duel-provider">{player.agent.provider === "claude" ? "Claude Code" : player.agent.provider === "codex" ? "Codex" : "OpenCode"} · {player.agent.reasoning === "none" ? "no extended thinking" : `${player.agent.reasoning || "default"} effort`}</span><strong className="duel-points">{score.points} <small>points</small></strong>
        <p>{score.revealedLetters} letters revealed · {score.actionsTaken} actions · {score.misses} misses</p>
        <p>Last action: {latest?.actionLabel ?? "None yet"}{latest ? ` · ${latest.latencyMs === null ? "time unknown" : `${(latest.latencyMs / 1000).toFixed(1)}s`}` : ""}</p>
      </section>;
    })}</div>
    <section className="duel-board" aria-label="Shared Hangman board">
      <div><span className="eyebrow">{view.terminal ? "THE WORD" : "SHARED WORD"}</span><span>{view.misses} / 7 shared misses</span></div>
      <svg viewBox="0 0 160 150" role="img" aria-label={`${view.misses} misses out of seven`}>
        <path d="M15 140 H145 M40 140 V10 H105 V25" />
        {view.misses >= 1 && <circle cx="105" cy="40" r="15" />}
        {view.misses >= 2 && <path d="M105 55 V95" />}
        {view.misses >= 3 && <path d="M105 65 L80 80" />}
        {view.misses >= 4 && <path d="M105 65 L130 80" />}
        {view.misses >= 5 && <path d="M105 95 L85 125" />}
        {view.misses >= 6 && <path d="M105 95 L125 125" />}
        {view.misses >= 7 && <path d="M98 36 L103 42 M103 36 L98 42 M108 36 L113 42 M113 36 L108 42" />}
      </svg>
      <div className={`word-pattern ${view.terminal ? "word-revealed" : ""}`} aria-label={`Shared word pattern: ${view.pattern}`}>{view.terminal ? view.word : view.pattern}</div>
      <p>{view.wordLength} letters · Guessed by either player: {view.guessedLetters.join(" · ") || "None yet"}</p>
      {last && <p className="duel-effect"><strong>{name(last.playerId)}</strong> {last.action.type === "guess_letter" ? `guessed ${last.action.payload.letter}` : last.action.type === "solve" ? "submitted a solution" : "forfeited"}: {last.points > 0 ? "+" : ""}{last.points} points. {last.correct ? "The shared board advanced." : "No letters revealed."}</p>}

    </section>
    <details className="duel-requests"><summary>Requests and corrections</summary>{match.players.map((player) => <section key={player.id}><h4>{name(player.id)}</h4>{match.history.filter((turn) => turn.playerId === player.id && (replayPly === null || turn.valid)).slice(0, replayPly === null ? undefined : view.players[player.id].actionsTaken).map((turn) => <p key={turn.turnId}>{turn.actionLabel ?? "No accepted action"} · {turn.attempts.length} request(s) · {turn.latencyMs === null ? "time unknown" : `${(turn.latencyMs / 1000).toFixed(1)}s`}</p>)}</section>)}</details>
  </div>;
}
