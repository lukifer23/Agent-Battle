import { competitorLabel, verifiedDistinctModels } from "../shared.js";
import type { MatchResult, PublicMatchDetail } from "../shared.js";
interface Lane { pattern: string | null; guessedLetters: string[]; misses: number; missesRemaining: number; actionsTaken: number; status: string; sealed: boolean; correctLetters: number }
interface View { wordLength: number; terminal: boolean; word?: string; result?: MatchResult; lanes: Record<string, Lane> }
export function HangmanArena({ match, replayPly = null }: { match: PublicMatchDetail; replayPly?: number | null }) {
  const step = replayPly;
  const frames = (match.replay ?? []) as View[];
  const latest = match.gameState as View;
  const view = step === null ? latest : frames[step] ?? latest;
  const result = view.terminal ? view.result ?? match.result : undefined;
  const comparable = verifiedDistinctModels(match.players[0].agent, match.players[1].agent);
  return <div className="hangman-arena">
    <div className="hangman-match-summary" role="status">
      {result ? <><strong>{result.kind === "draw" ? "Draw" : `${match.players.find((player) => player.id === result?.winnerId)?.label ?? "Winner"} wins`}</strong><span>{result.reason} · {result.notation}{!comparable ? " · model identity unverified" : ""}</span></>
        : <><strong>Same word, separate lanes</strong><span>Seven misses each. The word stays hidden until both lanes finish.</span></>}
    </div>
    <div className="hangman-lanes">{match.players.map((player) => {
      const lane = view.lanes[player.id];
      const pendingAttempts = step === null && match.pendingTurn?.playerId === player.id ? match.pendingTurn.attempts : [];
      const playerTurns = match.history.filter((turn) => turn.playerId === player.id);
      const turns = step === null ? playerTurns : playerTurns.filter((turn) => turn.valid).slice(0, lane.actionsTaken);
      if (step !== null && lane.status === "forfeit") {
        const forfeited = playerTurns.find((turn) => !turn.valid && turn.attempts.filter((attempt) => attempt.status === "invalid" || attempt.status === "timeout").length >= match.settings.maxRetries + 1);
        if (forfeited) turns.push(forfeited);
      }
      return <section className={`hangman-lane ${step === null && match.status === "running" && match.currentPlayerId === player.id ? "lane-active" : ""}`} key={player.id}>
        <header><div><h3>{player.label}</h3><small>{competitorLabel(player.agent)}</small></div><span>{step === null && match.status === "running" && lane.status === "active" ? match.currentPlayerId === player.id ? "THINKING" : "WAITING" : lane.status.toUpperCase()}</span></header>
        <svg viewBox="0 0 160 150" role="img" aria-label={`${lane.misses} misses out of seven`}>
          <path d="M15 140 H145 M40 140 V10 H105 V25" />
          {lane.misses >= 1 && <circle cx="105" cy="40" r="15" />}
          {lane.misses >= 2 && <path d="M105 55 V95" />}
          {lane.misses >= 3 && <path d="M105 65 L80 80" />}
          {lane.misses >= 4 && <path d="M105 65 L130 80" />}
          {lane.misses >= 5 && <path d="M105 95 L85 125" />}
          {lane.misses >= 6 && <path d="M105 95 L125 125" />}
          {lane.misses >= 7 && <path d="M98 36 L103 42 M103 36 L98 42 M108 36 L113 42 M113 36 L108 42" />}
        </svg>
        <div className="word-pattern" aria-label={lane.sealed ? "Solved. Word sealed until both lanes finish." : `Word pattern: ${lane.pattern}`}>{lane.sealed ? "Solved · sealed" : lane.pattern}</div>
        <p>{view.wordLength} letters · {lane.missesRemaining} misses remaining</p>
        <dl><div><dt>Actions</dt><dd>{lane.actionsTaken}</dd></div><div><dt>Misses</dt><dd>{lane.misses}</dd></div><div><dt>Correct letters</dt><dd>{lane.correctLetters}</dd></div></dl>
        <p className="guessed-letters">Guessed: {lane.guessedLetters.join(" · ") || "None yet"}</p>
        <p>Latest: {turns.at(-1)?.actionLabel ?? "Awaiting action"}</p>
        <details><summary>Requests and corrections ({turns.reduce((n, turn) => n + turn.attempts.length, pendingAttempts.length)})</summary>{turns.map((turn) => <div key={turn.turnId}>{turn.actionLabel ?? "No accepted action"}{turn.attempts.map((attempt, index) => <p key={index}>Request {attempt.attempt}: {attempt.status} · {attempt.latencyMs == null ? "Time unknown" : `${attempt.latencyMs} ms`} · {attempt.usage.costUsd == null ? "Cost unknown" : `$${attempt.usage.costUsd}`}</p>)}</div>)}{pendingAttempts.map((attempt, index) => <p key={`pending-${index}`}>Current request {attempt.attempt}: {attempt.status} · usage pending or unknown</p>)}</details>
      </section>;
    })}</div>
    {view.terminal && <div className="hangman-result" role="status"><span className="eyebrow">THE WORD</span><h3>{view.word}</h3><p>{result?.notation} · {result?.reason}</p></div>}
  </div>;
}
