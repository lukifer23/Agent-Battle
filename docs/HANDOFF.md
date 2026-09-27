# Agent Battle handoff

## Current state

This is a new local web app in an otherwise blank directory. It now has a generic match controller and game contract, a chess.js-backed chess game, an agent adapter registry, Codex/Claude Code/OpenCode CLI adapters, local JSON persistence, an SSE event feed, and a React spectator/control UI with replay and scoreboard.

V1 is set up for the first milestone: agent-versus-agent chess. Both sides can independently select Codex, Claude Code, or OpenCode, plus model IDs and reasoning settings. Each turn is a new non-interactive CLI process and receives a complete player-specific observation, so agent memory is not authoritative. The UI is a spectator/control surface; the controller and chess.js remain authoritative.

## Live acceptance run (2026-09-26)

A real local CLI match completed end to end in the browser:

- Codex CLI 0.157.1 played White against Claude Code 2.1.282 as Black, using each CLI's configured default model and `low` reasoning effort. OpenCode 1.18.30 was detected but not selected.
- The match reached 74 legal plies (37 turns per side) and ended with checkmate: Black won, `0-1`, final move `37...Rg4#`.
- The controller rejected one Codex response at ply 57 because the CLI emitted an external tool call. It applied no move from that response, returned the reason with the same authoritative position, and accepted the agent's legal action on the single retry. There were no illegal applied moves, timeouts, or provider crashes in this game.
- The completed PGN, FEN, all 74 move records, event stream, retry attempt and per-turn telemetry are present in the persisted match record in `data/matches.json`. The UI shows the final position/result, move list, scoreboard, events and replay slider; replay was checked at both ply 74 and ply 0.
- Codex reported 967,061 input and 1,239 output tokens; its CLI did not report cost. Claude Code reported 106 input and 22,564 output tokens and about $7.02 total CLI cost. Treat these as the CLI-reported usage for this match, not an independent billing statement. Average response latency was 5.9 seconds for Codex and 10.6 seconds for Claude Code.
- Three earlier zero-ply error records from live setup diagnosis remain in recent history. They preserve actual failures (unsupported Codex option, unsupported response-schema keyword, and model reasoning-effort mismatch) rather than hiding them.

The SSE path was tightened after inspecting the saved record: the UI now patches its board, moves, telemetry and result from small domain events, while full snapshots are reserved for connection and lifecycle boundaries. New per-turn telemetry keeps FEN checkpoints instead of copying the entire PGN/move state repeatedly. Older saved full snapshots remain readable.

The development server runs at `http://127.0.0.1:5173` and the Express API at `http://127.0.0.1:4173` when started locally. The model fields were blank, so the exact provider-side model aliases are not recorded; configurations are otherwise saved. This confirms the real two-provider loop and replay, while a live Codex-versus-Codex run with two separate Codex processes remains the final check for the original first milestone. The controller's same-provider alternation is covered with test adapters.

## Verification

The test suite covers:

- Player-specific observations and legal move lists.
- Legal/illegal moves and wrong-player actions.
- Checkmate, stalemate, repetition, fifty-move draw, insufficient material and resignation.
- PGN/state serialization and reload.
- Strict action JSON, Codex adapter process launch, OpenCode all-tools-denied config, process failure, timeout/process-group cleanup.
- Automatic Codex-vs-Codex checkmate flow with fake adapters, invalid action correction, controller timeout/forfeit, telemetry and persisted replay.
- Compact event projections, lifecycle-only SSE snapshots and persistence checkpoint policy.

The automated suite uses fake CLI executables and does not make paid model requests. The live Codex-vs-Claude Code run above used the locally authenticated CLI accounts and their normal usage/billing.

## How to continue

1. Run `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.
2. Start `npm run dev` and open `http://127.0.0.1:5173`.
3. Confirm local CLI readiness with **Check CLIs**. Sign in to each CLI using its own login if needed, choose providers and optional model/reasoning overrides, then start a match. A blank model field uses that CLI's configured default and model usage is incurred only after a match starts.
4. Inspect match events, action attempts, per-ply telemetry and final PGN in `data/matches.json` if an adapter behaves unexpectedly.
5. Continue hardening the real provider path and inspect telemetry costs. Preserve the controller's strict schema and legality checks when adjusting adapters.

## Implementation notes and known limits

- Server/domain logic lives in `src/domain`, chess in `src/games/chess`, provider processes in `src/server/adapters.ts`, persistence in `src/server/store.ts`, and the UI in `src/App.tsx` plus `src/styles.css`.
- The controller is game-agnostic at the interface boundary. A new game requires a `GameDefinition` implementation and its own spectator view; the current board/replay UI is chess-specific.
- The app currently runs one two-player match at a time. It supports pause/resume and stop, but not concurrent or tournament matches.
- A player can resign; normal chess game endings are derived from chess.js. Offer/accept draw is not yet a separate agent action.
- Usage data is nullable by provider. Cost caps, model catalogs, Stockfish, human input and additional game views are not implemented.
- Match records are stored in `data/matches.json`. Do not commit this file if it contains personal match logs or provider output.

## Highest-value next steps

1. Complete the live Codex-versus-Codex acceptance run with two independently configured Codex processes, then record the exact selected model IDs when available.
2. Surface match-wide token/cost/latency totals in the UI, alongside the existing latest-turn telemetry.
3. Add optional Stockfish post-game analysis as a separate evaluator whose output never enters standard agent observations.
4. Add a small human-versus-agent path using the same controller and action validation, without making the board authoritative.
