# Agent Battle

## Current capabilities

Agent Battle supports authoritative Chess and independent-lane Hangman, plus a ten-slot battle series with five games of each. A series records explicit agents, model and reasoning settings, a fixed role schedule, five reproducible private Hangman challenges, linked raw matches, per-game results, and usage coverage. It pauses on unscored failures and requires an explicit retry or skip. Benchmark model and tool qualification is stricter than casual play; Codex CLI remains unqualified because its read-only tool access is not equivalent to a no-tools invocation.

Durable events carry a monotonically increasing match revision and are published only after the corresponding store commit. An accepted action commits its game state, turn history, and move/completion evidence together; a terminal action includes its result in that commit. Retry exhaustion commits the invalid turn and forfeit result together. Match creation, start/resume, pending-turn creation, retry state, pause, stop, and errors are also durable boundaries. Presentation events (`agent.ready`, `agent.thinking`, `agent.started`, `agent.response`, `move.proposed`, `turn.started`, and `agent.timeout`) stream live without a store write or durable revision. They are not replayed after reconnect; the canonical snapshot and durable events restore match state. Invocation reservations are committed before provider spawn; each retry is checked against the remaining budgets.

Agent Battle is a local-first spectator and control app for AI-versus-AI games. The backend owns game state and validates every proposed action; agents receive a private, structured turn observation and return one action. The browser is only the match control and spectator surface.

## Run it

Requirements: Node.js 20.19+ and npm. At least one supported CLI must be installed and authenticated. Codex, Claude Code, and OpenCode are supported; new matches default to Codex on both sides.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Choose **Chess** or **Hangman** in the top navigation. The **Start Chess Match** or **Start Hangman Match** button sits at the top of setup; choose an agent CLI for each player, optionally enter model and reasoning settings, then start. Time and resource limits are under the expandable settings row. Leave the model blank to use that CLI's configured default. If another match or series is active, the start area explains the blocker and links to that record. Agent Battle does not read or store CLI credentials. Model requests begin only after you start a match.

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
- Copy FEN, download PGN, and export projected match JSON. Raw provider diagnostics remain in private local persistence. The match header shows request, token, and cost totals with a coverage marker.
- Labelled form controls, an accessible scoreboard table, keyboard-operable replay, a polite position/status announcement and a reduced-motion rule.
- Codex CLI, Claude Code and OpenCode adapters. Each turn starts a fresh non-interactive CLI request with a complete observation, so the game does not rely on conversation memory.
- One correction attempt for an invalid action or timeout, then forfeiture. A crashed CLI or authentication/provider error is shown as a match error and does not award the opponent a win.
- Pause, resume, stop, process timeouts, output-size limits and saved match history. A ready, paused or interrupted match can be stopped without launching a request.
- Per-turn records include player/model, FEN, legal-action count, response action, validity, latency, retries, process output excerpts, tool-call count and token/cost usage when the CLI reports it.

Chess, Hangman, and battle series are supported. Human players, Stockfish analysis, and remote agents are not implemented.

## Billing, limits and provenance

Every match has configurable limits: maximum plies, maximum requests, game minutes, and an optional best-effort reported-cost threshold. New matches offer 5, 10, 30, 60-minute and custom game-time controls. Their game clock counts accumulated running time, pauses while paused, and survives restart; an unclosed running segment is conservatively charged through restart. The controller checks request, time, and reported-cost thresholds before each invocation and cancels an in-flight request when its game clock expires. Older saved matches without a timer ledger retain their original creation-age semantics. A budget stop is a non-game outcome rather than a fabricated win or draw. A durable reservation counts each invocation conservatively across crashes; provider-reported cost is not a hard billing cap. Keep the per-move timeout separate from the game-time control.

Each match stores requested provider/model/reasoning and provider CLI versions captured at creation. Provider parsers record resolved model identity when the CLI reports it. A scored series trial requires an exact resolved-model match and a qualified no-tools adapter; missing evidence pauses the series without a game result. Codex CLI series trials are currently blocked. Unknown cost and tokens remain unknown, with per-metric coverage counts in series results and exports.

## Data, backup and recovery

Match history and bounded provider diagnostics live in `data/matches.json`. The file is written with owner-only permissions and uses a versioned format. Supported migrations keep a backup; malformed records are quarantined with a visible warning. An unreadable or unsupported root prevents startup and remains in place. Set `AGENT_BATTLE_DATA_DIR` to use a different directory. An atomic single-writer lock prevents two app instances from sharing one store.

Before moving or deleting history, copy the whole `data/` directory. If the store cannot be read, the server refuses startup without replacing it. Inspect the original file, any `.bak` backup, and any `.quarantine-*.json` output before recovery. If a stale-lock recovery guard remains after a crash, inspect process ownership and the data before removing it manually.

Match history is kept in full rather than silently pruned. `GET /api/matches` returns paginated summaries for browsing, `GET /api/matches/:id` returns a safe public detail, and `GET /api/matches/:id/events` and `GET /api/matches/:id/attempts` expose projected events and attempts. Raw diagnostics remain in private local persistence. Set `AGENT_BATTLE_METRICS=1` to log snapshot and checkpoint sizes and timings, and run `npm run benchmark` for local projection and full-store write measurements.

## Battle series

Open **Battle series** in the top navigation, enter explicit model IDs for both competitors, and choose **Run 10-trial series**. The browser schedules five standard-start Chess games and five Hangman matches with private seeded words. Roles alternate 3–2 in each group. The series runs one match at a time, pauses on a provider, budget, storage, or qualification failure, and keeps every attempt. Use **Retry Slot** to repeat the same challenge, **Skip Slot** to leave it unscored, or **Resume** for a paused match. The series JSON export contains projected match records and per-metric usage coverage; future challenge seeds are withheld until the series completes.

The API offers `GET /api/series`, `GET /api/series/:id`, `GET /api/series/:id/export`, `POST /api/series`, and `POST /api/series/:id/{start,pause,stop,retry,skip}`. Requested model IDs are required. Exact resolved identity and tool restrictions must be verified during a trial before its actions can score. Fixture tests exercise the full ten-slot lifecycle; they do not prove any live provider model or billing claim.

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

## Hangman

Select **Hangman** in the top navigation, choose the two agents, and use **Start Hangman Match** at the top of setup. Each agent gets an independent lane with the same private word and sees only its own lane. The spectator sees both masked lanes; solved words remain sealed until both lanes finish. Each lane gets seven misses. The result favors non-forfeit, solved lanes, then fewer misses and accepted actions; failed lanes compare distinct correct letters. The winner and reason appear above the lanes when the match ends. Completed records include the result, replay, request telemetry, game-specific recent scoreboard, and safe JSON export. See [Hangman rules and privacy](docs/HANGMAN.md).

Store version 5 retains legacy Chess records and time controls and adds series manifests. Migration backs up the original store before rewriting; unknown future versions refuse startup. Private seeds, canonical state, provider excerpts, and recovery candidates stay in local data files. Public match-list summaries contain no game state. Request identities are persisted before invocation, and budgets are rechecked before every request, including corrections.
