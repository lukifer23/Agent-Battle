# Agent Battle handoff

## Concurrent work notice

The local implementation lane is now working on a bounded time-control follow-up: 5/10/30/60-minute and custom setup presets, durable accumulated active-runtime accounting across pause/restart, a wall-time cutoff during an in-flight request, and distinct time-control results. Coordinate edits to `MatchController`, match/schema timing fields, `App.tsx`, and timing tests against this work. The existing live playtest server is intentionally left running until its match finishes; new builds will use a separate isolated store and port.

As of 2026-09-27, F1 and F1.1 are on `main` through `6e4059d4a1e03000c85c9f24a7cf7c621772b037`. F1.1 makes accepted actions and retry-exhaustion forfeits atomic durable transitions, detaches chess snapshots, and streams presentation events without a store write. Concurrent agents should base changes to the controller, store, schema, startup storage handling, and storage regressions on that commit. Invocation ledgers, per-invocation budgets, usage/provenance, safe public/private contracts, game-neutral infrastructure and UI, and provider qualification remain pending follow-up work.

## Current state

Agent Battle is a local-first spectator and control app for AI-versus-AI games, with chess as the first game. The backend owns the board: agents propose actions, the controller and game definition validate and apply them, and the browser only spectates and controls. Codex, Claude Code and OpenCode are supported as CLI adapters.

The implementation has been hardened across lifecycle, provider execution, persistence, transport, measurement and the spectator UI. Test coverage is deterministic and never calls a paid provider.

## Implemented

- Strict two-key action envelope and lowercase-UCI chess validation shared by the provider parser and the game boundary; no silent action repair.
- A single cancellable process runner per attempt with one deadline, process-group termination (including after the group leader exits), bounded UTF-8 output, bounded final-file reads, and provider envelope parsing for Codex, Claude Code and OpenCode.
- Explicit lifecycle transitions: start/resume, pause, stop; stop works for a ready, paused or interrupted match without spawning, and is idempotent once terminal. Saved pending-turn feedback supports resume, but invocation starts still need a durable ledger.
- A validated, versioned store with quarantine, pre-migration backups, atomic single-writer ownership, `fsync` + rename writes, a configurable data directory, and failure-aware shutdown. Unsupported roots stop startup; storage failures stop requests and are reported rather than acknowledged as saved.
- Accepted moves save detached canonical game state, turn telemetry, events, revision, next player, and any terminal result in one commit. Retry exhaustion saves invalid-attempt evidence and its forfeit together. Presentation-only SSE activity is transient and does not trigger a full-store write.
- One snapshot projector for HTTP and SSE with revisions, ordered event ids, idempotent client reduction, gap recovery, and a hardened local API (Host/Origin checks, JSON errors, `/api` 404, request deadlines).
- Resource budget settings and checks between turns. Per-invocation budget enforcement, complete usage coverage, and observed resolved-model identity remain pending.
- Bounded transport projections, paginated history/detail/events/attempts endpoints, and `npm run benchmark` / `AGENT_BATTLE_METRICS` measurement.
- Spectator UI with correct replay (first/previous/next/last/return-to-current), clickable notation, board flip, last-move and check highlighting, a readable position summary, FEN/PGN/JSON export, and accessibility work (labelled controls, scoreboard table, reduced motion, polite announcements).

## Verification

The test suite covers:

- Player-specific observations and legal move lists; strict action envelope and payload validation; special moves and termination conditions; PGN/state serialization and reload.
- Adapter envelope parsing (Codex file+JSONL, Claude structured/error, OpenCode text/step), timeout and cancellation process-group cleanup, descendant reaping, output caps and diagnostic redaction.
- Controller alternation, invalid-action correction, timeout/forfeit, provider failure, non-running stop, idempotent start, pending-turn resume, multiple-active recovery, budget stops, and fault-injected move/result/retry/pause/stop/shutdown writes.
- Store validation, quarantine, supported migration, cross-process lock competition and API recovery notices; parser/API trust checks and SSE snapshot delivery.
- Accepted-move and retry-forfeit crash-boundary reloads, detached chess serialization, and presentation-event revision behavior.

F1.1 passed 78 local tests, lint, typecheck, build, and [Node 20/22 CI](https://github.com/lukifer23/Agent-Battle/actions/runs/36354254832). The original five-match store was not modified.

The automated suite uses fake CLI executables and does not make paid model requests. A structured-action preflight against the locally authenticated CLIs completed for Codex, Claude Code and OpenCode. A full live acceptance game remains the final, explicitly-pending gate; it is not simulated by fixtures.

## How to continue

1. Run `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.
2. Start `npm run dev` and open `http://127.0.0.1:5173`; confirm local CLI readiness with **Check CLIs** (availability only; sign in separately).
3. Review F1.1, then implement the F2 invocation ledger, per-invocation budgets, usage coverage and model provenance before paid-game qualification.
4. Separate private game state, public transport and player observation; remove chess validation from generic storage; complete game-neutral setup/view boundaries and the original spectator acceptance work before adding another game. Arrange the bounded live acceptance matrix as a separate user-authorized gate.

## Implementation notes and known limits

- Server/domain logic lives in `src/domain`, chess in `src/games/chess`, provider processes in `src/server/adapters.ts` and `src/server/processRunner.ts`, persistence in `src/server/store.ts`, and the UI in `src/App.tsx` plus `src/styles.css`.
- The game contract is generic, but the HTTP create route, the client board projection and portions of the UI currently assume chess player ids `white`/`black` and the chess snapshot shape.
- One two-player match runs at a time. Tournaments, human play, draw offers, chess clocks, FEN/PGN import and Stockfish analysis are not implemented.
- Usage data is nullable by provider and coverage is reported; cost caps are a best-effort threshold on reported cost, not a hard billing guarantee.
- Unknown cost can still render as zero and pending attempts can be missing from aggregates. Resolved model identity is not yet populated by the adapters.
- Windows process-group semantics are not qualified; the POSIX/macOS path is exercised by tests.
- Match history is kept in full on disk; the streamed event feed is a bounded recent window, not complete history.
