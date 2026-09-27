# Agent Battle

Agent Battle is a local-first spectator and control app for AI-versus-AI games. Chess is the first game. The backend owns the board and validates every proposed action; agents receive a private, structured turn observation and return one action. The browser is only the match control and spectator surface.

## Run it

Requirements: Node.js 20.19+ and npm. At least one supported CLI must be installed and authenticated. Codex, Claude Code, and OpenCode are supported; new matches default to Codex on both sides.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Choose an agent CLI for each side, optionally enter a model and reasoning setting, choose the per-move timeout, and start the match. Leave the model blank to use that CLI's configured default. Agent Battle does not read or store CLI credentials. Model requests begin only after you start a match.

For a single production-style local server:

```sh
npm run build
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Both servers bind to loopback (`127.0.0.1`). Keep them local; this app is not configured for remote access.

## What works today

- Standard chess rules, legal UCI move validation, resignation, checkmate, stalemate, repetition, fifty-move and insufficient-material draws. Rules come from [chess.js](https://github.com/jhlywa/chess.js) rather than a home-grown chess engine.
- A responsive spectator board built with [react-chessboard](https://github.com/Clariity/react-chessboard), move list, replay slider, live event feed and local scoreboard.
- Codex CLI, Claude Code and OpenCode adapters. Each turn starts a fresh non-interactive CLI request with a complete observation, so the game does not rely on conversation memory.
- One correction attempt for an invalid action or timeout, then forfeiture. A crashed CLI or authentication/provider error is shown as a match error and does not award the opponent a win.
- Pause, resume, stop, process timeouts, output-size limits and saved match history. A ready, paused or interrupted match can be stopped without launching a request.
- Per-turn records include player/model, FEN, legal-action count, response action, validity, latency, retries, process output excerpts, tool-call count and token/cost usage when the CLI reports it.

The app intentionally starts as a chess arena. Other games, human players, Stockfish analysis, tournaments and remote agents are not implemented yet.

## Billing, limits and provenance

Every match has configurable limits: maximum plies, maximum requests (retries and failed attempts count), maximum wall-clock minutes, and an optional best-effort reported-cost threshold. The limits are checked between requests and stop the match with a visible "budget reached" outcome rather than a fabricated win or draw. The cost threshold uses provider-reported cost only and is not a hard billing cap; when a provider reports no cost, the request and time limits still apply.

Each turn records the requested provider/model/reasoning separately from any model the provider actually resolved, and stores the provider CLI versions captured for the match. Token and cost totals carry a coverage marker: `full` when every category was reported, `~` partial, and `n/a` when the provider reported nothing. Unknown usage is never displayed as a confident zero. The scoreboard groups competitors by provider, model and reasoning, so two runs with different settings are not merged into one row.

## Data, backup and recovery

Match history and bounded provider diagnostics live in `data/matches.json`. The file is written with owner-only permissions, uses a versioned format, and is validated on load: malformed records are quarantined and unreadable files are preserved rather than silently replaced. Set `AGENT_BATTLE_DATA_DIR` to use a different directory. A single-writer lock prevents two app instances from sharing one store.

Before moving or deleting history, copy the whole `data/` directory. If the store cannot be read, the app preserves the original file next to it and starts with an empty history; inspect the preserved file and any `.quarantine-*.json` output to recover records.

Match history is kept in full rather than silently pruned. `GET /api/matches` returns paginated summaries for browsing, `GET /api/matches/:id` returns one full record, and `GET /api/matches/:id/events` and `GET /api/matches/:id/attempts` expose the bounded event feed and per-attempt diagnostics. Set `AGENT_BATTLE_METRICS=1` to log snapshot and checkpoint sizes and timings, and run `npm run benchmark` for local projection measurements.

## Checks

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

The adapter/controller tests use fake local CLI executables and do not make paid model requests. See [the handoff](docs/HANDOFF.md) for the current acceptance boundary and the next recommended work.

## Project guide

- [Architecture](docs/ARCHITECTURE.md): module boundaries, state ownership, persistence and event flow.
- [Agent protocol](docs/AGENT_PROTOCOL.md): observation and action contract, retry behavior and CLI invocation details.
- [Handoff](docs/HANDOFF.md): what has been implemented and how another agent should continue.
