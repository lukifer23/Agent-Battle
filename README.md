# Agent Battle

## Current repair work

The focused persistence and recovery repair (F1, 2026-09-27) covers commit-before-publication for match transitions, exclusive store ownership, supported-version migrations, validation, and visible recovery errors. F1.1 closes the accepted-move and retry-forfeit crash windows, detaches serialized chess snapshots, and separates presentation events from durable transitions. Agents working on review or features should coordinate changes to the controller, store, schema, or startup storage handling against F1.1 commit `6e4059d4a1e03000c85c9f24a7cf7c621772b037`. Request budgets, invocation accounting, client convergence, exports, and broader UI work remain separate follow-up packages.

Durable events carry a monotonically increasing match revision and are published only after the corresponding store commit. An accepted action commits its game state, turn history, and move/completion evidence together; a terminal action includes its result in that commit. Retry exhaustion commits the invalid turn and forfeit result together. Match creation, start/resume, pending-turn creation, retry state, pause, stop, and errors are also durable boundaries. Presentation events (`agent.ready`, `agent.thinking`, `agent.started`, `agent.response`, `move.proposed`, `turn.started`, and `agent.timeout`) stream live without a store write or durable revision. They are not replayed after reconnect; the canonical snapshot and durable events restore match state. Provider invocation reservation and per-invocation budgets remain F2 work.

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

Run commands from the project root. The built UI is resolved relative to the server file, but the data directory defaults to `./data` under the current working directory unless you set the options below.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | API server port | `4173` |
| `AGENT_BATTLE_API_PORT` | API port the Vite dev proxy targets | `PORT` or `4173` |
| `AGENT_BATTLE_DATA_DIR` | Directory holding `matches.json` | `./data` |
| `AGENT_BATTLE_METRICS` | Set to `1` to log snapshot/checkpoint sizes and timings | off |

The development UI runs on `127.0.0.1:5173` and proxies `/api` to the API port. Production serves the built UI and API from the same origin and port.

## What works today

- Standard chess rules, legal UCI move validation, resignation, checkmate, stalemate, repetition, fifty-move and insufficient-material draws. Rules come from [chess.js](https://github.com/jhlywa/chess.js) rather than a home-grown chess engine.
- A responsive spectator board built with [react-chessboard](https://github.com/Clariity/react-chessboard), move list, replay slider, live event feed and local scoreboard.
- Replay with first/previous/next/last and return-to-current controls, clickable notation, board flip, last-move and check highlighting, and a readable position summary. Hiding replay returns the board to the current position instead of leaving an old one displayed as current.
- Copy FEN, download PGN and export match JSON. JSON detail currently includes diagnostic excerpts and should be kept private; a safe export contract remains follow-up work. The match header shows request, token and cost totals with a coverage marker.
- Labelled form controls, an accessible scoreboard table, keyboard-operable replay, a polite position/status announcement and a reduced-motion rule.
- Codex CLI, Claude Code and OpenCode adapters. Each turn starts a fresh non-interactive CLI request with a complete observation, so the game does not rely on conversation memory.
- One correction attempt for an invalid action or timeout, then forfeiture. A crashed CLI or authentication/provider error is shown as a match error and does not award the opponent a win.
- Pause, resume, stop, process timeouts, output-size limits and saved match history. A ready, paused or interrupted match can be stopped without launching a request.
- Per-turn records include player/model, FEN, legal-action count, response action, validity, latency, retries, process output excerpts, tool-call count and token/cost usage when the CLI reports it.

The app intentionally starts as a chess arena. Other games, human players, Stockfish analysis, tournaments and remote agents are not implemented yet.

## Billing, limits and provenance

Every match has configurable limits: maximum plies, maximum requests, maximum wall-clock minutes, and an optional best-effort reported-cost threshold. The current controller checks them between turns; a retry can cross a request, time, or reported-cost threshold before the next check. Per-invocation enforcement is pending. A budget stop is a non-game outcome rather than a fabricated win or draw. Provider-reported cost is not a hard billing cap.

Each match stores requested provider/model/reasoning and provider CLI versions captured at creation. Resolved model identity is not yet populated by the provider parsers. Usage coverage and aggregation need further repair: missing cost can appear as zero in the match header, and pending attempts are omitted from some totals. Treat cost displays as incomplete until that follow-up lands.

## Data, backup and recovery

Match history and bounded provider diagnostics live in `data/matches.json`. The file is written with owner-only permissions and uses a versioned format. Supported migrations keep a backup; malformed records are quarantined with a visible warning. An unreadable or unsupported root prevents startup and remains in place. Set `AGENT_BATTLE_DATA_DIR` to use a different directory. An atomic single-writer lock prevents two app instances from sharing one store.

Before moving or deleting history, copy the whole `data/` directory. If the store cannot be read, the server refuses startup without replacing it. Inspect the original file, any `.bak` backup, and any `.quarantine-*.json` output before recovery. If a stale-lock recovery guard remains after a crash, inspect process ownership and the data before removing it manually.

Match history is kept in full rather than silently pruned. `GET /api/matches` returns paginated summaries for browsing, `GET /api/matches/:id` returns one full record, and `GET /api/matches/:id/events` and `GET /api/matches/:id/attempts` expose the bounded event feed and per-attempt diagnostics. Set `AGENT_BATTLE_METRICS=1` to log snapshot and checkpoint sizes and timings, and run `npm run benchmark` for local projection measurements.

## Checks

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run benchmark
```

The adapter/controller tests use fake local CLI executables and do not make paid model requests. CI runs these checks on Node 20 and 22 on every push to `main` and every pull request, using the committed lockfile and local fixtures only. See [the handoff](docs/HANDOFF.md) for the current acceptance boundary and the next recommended work.

## Project guide

- [Architecture](docs/ARCHITECTURE.md): module boundaries, state ownership, persistence and event flow.
- [Agent protocol](docs/AGENT_PROTOCOL.md): observation and action contract, retry behavior and CLI invocation details.
- [Handoff](docs/HANDOFF.md): what has been implemented and how another agent should continue.
