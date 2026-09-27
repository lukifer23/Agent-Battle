# Changelog

All notable changes to this project are documented here. This project is in
early development and does not yet follow a released versioning scheme.

## Unreleased

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
