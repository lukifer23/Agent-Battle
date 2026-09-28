# Agent Battle handoff

## Current state

Agent Battle supports Chess, independent-lane Hangman, and a durable ten-slot battle series through an authoritative controller. Agents propose structured actions; game definitions validate them. The browser is a spectator/control client. See [Hangman](HANGMAN.md) for rules, privacy, scoring, provenance, and replay.

Store version 5 adds versioned series manifests while retaining Chess and Hangman records. Migration backs up supported older envelopes. The original saved matches are not development fixtures.

## Implemented boundaries

- Explicit public summary/detail DTOs, public game projection, private serialization, and player-specific observations.
- Role-keyed match creation, registry validation, and separate game views.
- Durable request reservations, per-invocation budget checks, interruption accounting, and failed-write recovery candidates.
- Atomic accepted actions, terminal results, and lane forfeits; single-writer storage ownership and failure-aware shutdown.
- Active-time controls with pause/restart accounting and in-flight cutoff. Legacy matches preserve creation-age semantics.
- Top-level Chess/Hangman/series navigation, a prominent match start action with specific blocker text, expandable time/resource settings, game-specific history and recent scoring, replay, safe JSON export, and per-game setup preferences.
- Event-time Hangman projections, explicit hidden-information capability, per-player series budgets, fixed private challenge IDs, series scheduling, and per-metric usage coverage.

## Verification

Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. CI covers Node 20 and 22. Tests use isolated stores and deterministic subprocess fixtures without paid model requests. Coverage includes Chess regressions, Hangman rule branches and replay, secret boundaries across HTTP/SSE/events/exports/observations, lifecycle interruptions, request reservations, storage failures, and time controls.

## Remaining qualification and limits

- Live Hangman and series qualification against authenticated providers remains unverified. Fixture success is application-flow evidence only.
- Payload isolation does not establish OS-user/filesystem isolation. CLI tool-policy enforcement remains provider-dependent.
- Resolved model identity remains unknown unless the provider reports it through a supported parser. A series slot cannot score without exact model identity and qualified no-tools isolation. Codex CLI is unqualified for series scoring.
- Reported cost thresholds cannot guarantee billing limits when provider usage is unknown.
- Storage still rewrites the full JSON store at durable checkpoints. `npm run benchmark` now measures actual writes in a temporary directory; the synthetic 100-record fixture was roughly 36.6 MB and had a 53 ms median write on the review machine.
- The recent scoreboard is bounded to the snapshot history window. It is not a lifetime tournament record.
- If both the primary write and recovery-file write fail, the private candidate remains memory-only until process exit.
- Windows process-group semantics are not qualified. Tournaments, human play, Stockfish, and remote hosting are out of scope.

Private review ledgers and detailed local evidence are ignored and are not public repository documentation.
