import type { PublicMatchDetail } from "../shared.js";

export function ExecutionEvidence({ match }: { match: PublicMatchDetail }) {
  const complete = ["finished", "forfeit", "stopped", "error"].includes(match.status);
  return <details className="identity-note">
    <summary>{match.comparison?.eligible ? "Execution checks passed" : complete ? "Unranked result" : "Game in progress"} · execution evidence</summary>
    <p>Each request starts a fresh CLI process. Both players receive the same versioned rules and action contract, with only their permitted game information. CLI reasoning settings are provider-specific. Execution checks alone do not validate a research claim.</p>
    {match.comparison?.reasons.filter((reason) => complete || reason !== "No completed game result.").map((reason) => <p key={reason}>{reason}</p>)}
    {match.players.map((player) => {
      const attempts = match.history.filter((turn) => turn.playerId === player.id).flatMap((turn) => turn.attempts);
      const sessions = new Set(attempts.map((attempt) => attempt.sessionId).filter(Boolean));
      return <section key={player.id}>
        <h4>{player.label} · {player.agent.provider}</h4>
        <p>Requested: <code>{player.agent.model || "CLI default"}</code> · Reported: <code>{player.agent.resolvedModel ?? "not provided"}</code></p>
        <p>{attempts.length} completed requests · {sessions.size} reported sessions · {attempts.filter((attempt) => attempt.toolCalls === 0).length}/{attempts.length} requests with zero external tool calls.</p>
        <details><summary>Request identities</summary>{attempts.map((attempt, index) => <p key={attempt.invocationId ?? index}><code>{attempt.invocationId ?? "legacy request"}</code><br />Model: {attempt.resolvedModel ?? "not reported"} · Session: <code>{attempt.sessionId ?? "not reported"}</code> · {attempt.status}{attempt.execution && <><br />Profile: {attempt.execution.profileId} · Stream: {attempt.execution.streamComplete && !attempt.execution.unknownEvents ? "complete / recognized" : "incomplete or unknown"} · Reasoning: requested {attempt.execution.requestedReasoning || "default"}; effective setting unverified</>}</p>)}</details>
      </section>;
    })}
    <p>Adapter: {match.environment?.adapterVersion ?? "legacy / unknown"} · Prompt: {match.environment?.promptVersion ?? "unknown"}</p>
  </details>;
}
