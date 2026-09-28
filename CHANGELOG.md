# Changelog

All notable changes to this project are documented here. This project is in
early development and does not yet follow a released versioning scheme.

## Unreleased

- Fixed event pagination after event 500; the endpoint now projects the requested historical slice directly.
- Included every retried series attempt in request, latency, usage, cost, and unscored totals while keeping the final scored result attached to its slot.
- Raised fresh-match action and request defaults to 250 and 500: a legal Battleship contest can require 201 accepted actions before its terminal result.

- Added `battleship-standard-1`: atomic fleet placement, alternating shots, deterministic terminal result, private player observations, masked public replay, terminal fleet reveal, and replay-validated persistence.
- Added `battle-series-2` plans for registered two-player games, configurable repetitions, seat-aware strict mode, deterministic challenge schedules, normalized per-family/overall performance, completed reproducibility manifests, and UI rerun.
- Kept `battle-series-1` records and exports readable without destructive conversion; store version 6 migrates with a backup.
- Preserved real provider telemetry on strict model/tool qualification failure; conservatively charges crash-interrupted provider reservations to player time budgets.
- Rejected Hangman mirror comparisons with blank or identical requested model IDs; older and unresolved-identity results remain visible as unverified history.
- Added Battleship and series setup UI, benchmark-scale storage measurements, source audit, notices, and rules documentation.

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
