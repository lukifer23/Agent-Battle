# Agent Battle handoff

## Current state

Agent Battle supports Chess and independent-lane Hangman through an authoritative controller. Agents propose structured actions; game definitions validate them. The browser is a spectator/control client. See [Hangman](HANGMAN.md) for rules, privacy, scoring, provenance, and replay.

The Hangman package integrates the active-runtime time-control package at `355243e`. Chess role IDs and historical records are preserved. Store version 4 adds durable invocation identity/deadline metadata; migration backs up supported older envelopes. The original saved matches are not development fixtures.

## Implemented boundaries

- Explicit public summary/detail DTOs, public game projection, private serialization, and player-specific observations.
- Role-keyed match creation, registry validation, and separate game views.
- Durable request reservations, per-invocation budget checks, interruption accounting, and failed-write recovery candidates.
- Atomic accepted actions, terminal results, and lane forfeits; single-writer storage ownership and failure-aware shutdown.
- Active-time controls with pause/restart accounting and in-flight cutoff. Legacy matches preserve creation-age semantics.
- Game-specific history, scoring, replay, safe JSON export, and per-game setup preferences.

## Verification

Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. CI covers Node 20 and 22. Tests use isolated stores and deterministic subprocess fixtures without paid model requests. Coverage includes Chess regressions, Hangman rule branches and replay, secret boundaries across HTTP/SSE/events/exports/observations, lifecycle interruptions, request reservations, storage failures, and time controls.

## Remaining qualification and limits

- Live Hangman qualification against authenticated providers requires separately authorized runs. Fixture success is application-flow evidence only.
- Payload isolation does not establish OS-user/filesystem isolation. CLI tool-policy enforcement remains provider-dependent.
- Resolved model identity remains unknown unless the provider reports it through a supported parser; requested model and CLI version are recorded.
- Reported cost thresholds cannot guarantee billing limits when provider usage is unknown.
- Storage still rewrites the full JSON store at durable checkpoints; large-history persistence needs a separate measured performance package.
- The recent scoreboard is bounded to the snapshot history window. It is not a lifetime tournament record.
- If both the primary write and recovery-file write fail, the private candidate remains memory-only until process exit.
- Windows process-group semantics are not qualified. Tournaments, human play, Stockfish, and remote hosting are out of scope.

Private review ledgers and detailed local evidence are ignored and are not public repository documentation.
