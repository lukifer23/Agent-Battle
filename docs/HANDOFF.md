# Agent Battle handoff

## Concurrent work notice

As of 2026-09-27, the local `main` checkout is implementing the focused F1 storage repair: durable lifecycle publication, store ownership, migration validation, and recovery visibility. This work is not yet accepted. Please keep concurrent review and feature work clear of the controller, store, schema, startup storage handling, and storage regressions until the verified F1 commit is available. Invocation ledgers, budgets, metrics, client convergence, exports, and broader UI workflows remain pending follow-up work.

## Current state

Agent Battle is a local-first spectator and control app for AI-versus-AI games, with chess as the first game. The backend owns the board: agents propose actions, the controller and game definition validate and apply them, and the browser only spectates and controls. Codex, Claude Code and OpenCode are supported as CLI adapters.

The implementation has been hardened across lifecycle, provider execution, persistence, transport, measurement and the spectator UI. Test coverage is deterministic and never calls a paid provider.

## Implemented

- Strict two-key action envelope and lowercase-UCI chess validation shared by the provider parser and the game boundary; no silent action repair.
- A single cancellable process runner per attempt with one deadline, process-group termination (including after the group leader exits), bounded UTF-8 output, bounded final-file reads, and provider envelope parsing for Codex, Claude Code and OpenCode.
- Explicit lifecycle transitions: start/resume, pause, stop; stop works for a ready, paused or interrupted match without spawning, and is idempotent once terminal. A durable in-flight turn keeps retry budget and feedback across pause/restart.
- A validated, versioned store with quarantine, pre-migration backups, a single-writer lock, atomic `fsync` + rename writes, a configurable data directory, and a graceful shutdown that checkpoints and closes before exit.
- One snapshot projector for HTTP and SSE with revisions, ordered event ids, idempotent client reduction, gap recovery, and a hardened local API (Host/Origin checks, JSON errors, `/api` 404, request deadlines).
- Resource budgets (plies, requests, wall time, best-effort reported cost), usage coverage that never renders unknown as zero, and competitor identity keyed on provider, resolved-or-requested model and reasoning.
- Bounded transport projections, paginated history/detail/events/attempts endpoints, and `npm run benchmark` / `AGENT_BATTLE_METRICS` measurement.
- Spectator UI with correct replay (first/previous/next/last/return-to-current), clickable notation, board flip, last-move and check highlighting, a readable position summary, FEN/PGN/JSON export, and accessibility work (labelled controls, scoreboard table, reduced motion, polite announcements).

## Verification

The test suite covers:

- Player-specific observations and legal move lists; strict action envelope and payload validation; special moves and termination conditions; PGN/state serialization and reload.
- Adapter envelope parsing (Codex file+JSONL, Claude structured/error, OpenCode text/step), timeout and cancellation process-group cleanup, descendant reaping, output caps and diagnostic redaction.
- Controller alternation, invalid-action correction, timeout/forfeit, provider failure, non-running stop, idempotent start, durable in-flight resume, multiple-active recovery, budget stops and storage-failure handling.
- Store validation, quarantine, migration and locking; projection/transport budget; usage aggregation and competitor identity; parser/API trust checks and SSE snapshot delivery.

The automated suite uses fake CLI executables and does not make paid model requests. A structured-action preflight against the locally authenticated CLIs completed for Codex, Claude Code and OpenCode. A full live acceptance game remains the final, explicitly-pending gate; it is not simulated by fixtures.

## How to continue

1. Run `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.
2. Start `npm run dev` and open `http://127.0.0.1:5173`; confirm local CLI readiness with **Check CLIs** (availability only; sign in separately).
3. Run the pending live acceptance game with an explicit model/reasoning choice and a bounded request/time budget, then inspect the recorded PGN, FEN, result, usage coverage and process cleanup.
4. Add a browser/accessibility test suite and a same-provider plus cross-provider live matrix to the CI-adjacent checks.

## Implementation notes and known limits

- Server/domain logic lives in `src/domain`, chess in `src/games/chess`, provider processes in `src/server/adapters.ts` and `src/server/processRunner.ts`, persistence in `src/server/store.ts`, and the UI in `src/App.tsx` plus `src/styles.css`.
- The game contract is generic, but the HTTP create route, the client board projection and portions of the UI currently assume chess player ids `white`/`black` and the chess snapshot shape.
- One two-player match runs at a time. Tournaments, human play, draw offers, chess clocks, FEN/PGN import and Stockfish analysis are not implemented.
- Usage data is nullable by provider and coverage is reported; cost caps are a best-effort threshold on reported cost, not a hard billing guarantee.
- Windows process-group semantics are not qualified; the POSIX/macOS path is exercised by tests.
- Match history is kept in full on disk; the streamed event feed is a bounded recent window, not complete history.
