# Changelog

All notable changes to this project are documented here. This project is in
early development and does not yet follow a released versioning scheme.

## Unreleased

- Added 5/10/30/60-minute and custom active-play time controls for new matches, with durable pause/restart accounting, an in-flight cutoff, and scoreboard separation by time control. Older records retain their prior creation-age limit.
- F1.1: accepted chess actions now commit canonical state, telemetry and event evidence together; retry exhaustion commits the forfeit with its invalid-attempt evidence. Serialized chess snapshots are detached, and presentation events no longer force a full-store write. Crash-boundary reload regressions pass without provider calls.
- Focused storage durability and recovery repair: transitions commit before
  publication, concurrent store ownership is atomic, unsupported roots stop
  startup, and quarantine or write failure is visible to the UI.

- Initial public baseline of the local Agent Battle chess arena: authoritative
  controller and chess.js rules engine, Codex/Claude Code/OpenCode CLI adapters,
  loopback Express API with an SSE event feed, JSON persistence, and a React
  spectator and control UI with replay and scoreboard.
- Documented product scope, run/check commands, architecture, agent protocol,
  local trust boundary, and contribution workflow.
- Strict lowercase action contract and game-agnostic state advancement.
- Single cancellable process runner with process-group cleanup and correct
  Codex/Claude/OpenCode envelope parsing.
- Explicit lifecycle transitions, saved pending-turn feedback, and spawn-free stop.
- Validated versioned store with quarantine, backup, single-writer lock, and
  graceful shutdown.
- One projector for snapshots with revisions, ordered SSE events, and a hardened
  local API.
- Resource budget settings, partial usage coverage, and requested competitor identity.
- Transport projections, paginated API history, and preliminary measurement tooling.
- Replay, board, export, and accessibility improvements.
- Added independent-lane Hangman, private word provenance, sealed early solves, deterministic scoring, replay, and public JSON records.
- Replaced match-list record spreading with an explicit summary DTO; public APIs and events project hidden state safely.
- Added durable invocation reservations, retry budget checks, private failed-write recovery candidates, and stale-snapshot rejection.
- Moved game validity behind the registry and added store version 4 for invocation identity and deadline metadata.
