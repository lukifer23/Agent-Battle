# Agent Battle

## Current capabilities

Agent Battle supports authoritative Chess, shared-board competitive Hangman, and hidden-information Battleship. Battle series v2 schedules any registered supported two-player game from a versioned plan, with configurable repetitions, deterministic role rotation, reproducible challenges, raw results, model provenance, and usage coverage. Existing `battle-series-1` records retain their original ten-slot layout. A series pauses on unscored failures and requires an explicit retry or skip. Strict model/tool qualification is stronger than casual play; Codex CLI remains unqualified for scored series because its read-only tool access is not equivalent to a no-tools invocation.

Research series v3 adds frozen multi-condition declarations, paired challenge blocks, both Hangman rulesets, labeled same-model controls, stricter execution evidence, and first-attempt analysis with missing-outcome bounds. Choose **RESEARCH** in Battle series to register the 144-match Hangman pilot before starting it. This is an exploratory study workflow, not a validated intelligence ranking. See [the research protocol and roadmap](docs/RESEARCH_PROTOCOL.md) for interpretation, offline controls, resource limits, and remaining research gates.

Durable events carry a monotonically increasing match revision and are published only after the corresponding store commit. An accepted action commits its game state, turn history, and move/completion evidence together; a terminal action includes its result in that commit. Retry exhaustion commits the invalid turn and forfeit result together. Match creation, start/resume, pending-turn creation, retry state, pause, stop, and errors are also durable boundaries. Presentation events (`agent.ready`, `agent.thinking`, `agent.started`, `agent.response`, `move.proposed`, `turn.started`, and `agent.timeout`) stream live without a store write or durable revision. They are not replayed after reconnect; the canonical snapshot and durable events restore match state. Invocation reservations are committed before provider spawn; each retry is checked against the remaining budgets.

Agent Battle is a local-first spectator and control app for AI-versus-AI games. The backend owns game state and validates every proposed action; agents receive a private, structured turn observation and return one action. The browser is only the match control and spectator surface.

## Run it

Requirements: Node.js 20.19+ and npm. A supported CLI must be installed and authenticated for live model games; tests and offline controls need no provider credentials. Codex, Claude Code, and OpenCode are supported; new matches default to Codex on both sides.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Choose **Chess**, **Hangman**, **Battleship**, or **Battle series** in the top navigation. Choose an agent CLI and model for each player, then use the start button below the choices. Model dropdowns contain IDs from saved matches; **Custom model ID** accepts another ID supported by your signed-in CLI. Changing CLI selects a model previously used with that CLI, or its detected default, rather than carrying over the old CLI's model. Single games and v2 series require two different explicit model IDs. Research series can register identical IDs as a labeled same-model control. Time and resource limits are under the expandable settings row. Blank models and CLI-default placeholders are rejected by the creation API. If another match or series is active, the start area explains the blocker and links to that record. Agent Battle does not read or store CLI credentials. Model requests begin only after you start a match.

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
| `AGENT_BATTLE_DATA_DIR` | Directory holding the durable database and legacy import source | `./data` |
| `AGENT_BATTLE_METRICS` | Set to `1` to log snapshot/checkpoint sizes and timings | off |

The development UI runs on `127.0.0.1:5173` and proxies `/api` to the API port. Production serves the built UI and API from the same origin and port.

## What works today

- Standard chess rules, legal UCI move validation, resignation, checkmate, stalemate, repetition, fifty-move and insufficient-material draws. Rules come from [chess.js](https://github.com/jhlywa/chess.js) rather than a home-grown chess engine.
- A responsive spectator board built with [react-chessboard](https://github.com/Clariity/react-chessboard), move list, replay slider, live event feed and local scoreboard.
- Replay with first/previous/next/last and return-to-current controls, clickable notation, board flip, last-move and check highlighting, and a readable position summary. Hiding replay returns the board to the current position instead of leaving an old one displayed as current.
- Copy FEN, download PGN, and export projected match JSON. Raw provider diagnostics remain in private local persistence. The match export bar shows request, token, and cost totals with a coverage marker.
- Labelled form controls, an accessible scoreboard table, keyboard-operable replay, a polite position/status announcement and a reduced-motion rule.
- Codex CLI, Claude Code and OpenCode adapters. Each turn starts a fresh non-interactive CLI request with a complete observation, so the game does not rely on conversation memory.
- One correction attempt for an invalid action or timeout, then forfeiture. A crashed CLI or authentication/provider error is shown as a match error and does not award the opponent a win.
- Pause, resume, stop, process timeouts, output-size limits and saved match history. A ready, paused or interrupted match can be stopped without launching a request.
- Per-turn records include player/model, chess FEN where applicable, legal-action count, response action, validity, latency, retries, process output excerpts, tool-call count and token/cost usage when the CLI reports it.

Chess, Hangman, Battleship, and battle series are supported. Human players, Stockfish analysis, and remote agents are not implemented.

## Comparing two agents

Single matches in all three games require two distinct explicit model IDs. Research series v3 additionally supports labeled same-model controls; those are kept out of casual standings. Claude setup suggests Opus 5.5, Sonnet 5, and Haiku 4.5 alongside previously used models; custom IDs remain available. Suggestions are not a claim of account access. Choosing the same CLI is valid when it runs different models: every request starts a fresh process in a separate temporary directory. The execution-evidence panel shows requested/reported model IDs, invocation IDs, provider session IDs when available, and observed external tool calls.

A winner describes the game outcome. Comparative standings additionally require both players to have responded, exact model evidence on every request, recorded no-tools policies, zero observed external tool calls, and no shared session between players. Older records without this evidence remain playable as replays and retain their results, but are unranked. Codex games remain casual/unranked because its current CLI does not establish no-tools parity. Provider reasoning settings are requests, not proof of equal internal compute.

## Billing, limits and provenance

Fresh matches default to 250 accepted actions, 500 requests and 30 active minutes. Every match has configurable limits: maximum plies, maximum requests, game minutes, and an optional best-effort reported-cost threshold. New matches offer 5, 10, 30, 60-minute and custom game-time controls. Their game clock counts accumulated running time, pauses while paused, and survives restart; an unclosed running segment is conservatively charged through restart. The controller checks request, time, and reported-cost thresholds before each invocation and cancels an in-flight request when its game clock expires. Older saved matches without a timer ledger retain their original creation-age semantics. A budget stop is a non-game outcome rather than a fabricated win or draw. A durable reservation counts each invocation conservatively across crashes; provider-reported cost is not a hard billing cap. Keep the per-move timeout separate from the game-time control.

Each match stores requested provider/model/reasoning and provider CLI versions captured at creation. Provider parsers record resolved model identity when the CLI reports it. A scored series trial requires an exact resolved-model match and a qualified no-tools adapter; missing evidence pauses the series without a game result. Codex CLI series trials are currently blocked. Unknown cost and tokens remain unknown, with per-metric coverage counts in series results and exports.

## Data, backup and recovery

Match history and bounded provider diagnostics live in `data/agent-battle.sqlite`, a local SQLite database in WAL mode. A match checkpoint writes one record instead of rewriting the whole archive, so write cost does not grow with history. Durable domain events are retained in full; the UI projects a bounded recent window. On first start the server imports a legacy `data/matches.json` (version 7 or a supported older envelope) into the database in a single transaction, after copying the original files into `data/migrations/v7-import-<timestamp>/` with a SHA-256 manifest. The legacy file is never modified or deleted; invalid records are quarantined with a visible warning. An unreadable or unsupported root prevents startup and remains in place. Set `AGENT_BATTLE_DATA_DIR` to use a different directory. An atomic single-writer lock prevents two app instances from sharing one store.

Before moving or deleting history, copy the whole `data/` directory. If the database cannot be opened, the server refuses startup without replacing it. Inspect the legacy file, the `data/migrations/` backup, and the quarantine table before recovery. If a stale-lock recovery guard remains after a crash, inspect process ownership and the data before removing it manually.

Match history is kept in full. `GET /api/matches` returns paginated summaries for browsing, `GET /api/matches/:id` returns a safe public detail, and `GET /api/matches/:id/events` and `GET /api/matches/:id/attempts` expose projected events and attempts. The durable repository exposes indexed history queries by game, game version, provider, model, status, series, result, and date. Raw diagnostics remain in the private local database. Set `AGENT_BATTLE_METRICS=1` to log snapshot and checkpoint sizes and timings, and run `npm run benchmark` for local projection and storage-write measurements (it now reports the durable per-record checkpoint beside the JSON rewrite).

## Battle series

Open **Battle series**, enter two different explicit model IDs, and choose Quick (2 each; exploratory), Standard (6 Chess, 6 Hangman, 6 Battleship), or Custom game counts. Strict mode requires even repetitions for seat-sensitive games; an odd exploratory run records its 3–2 or equivalent seat split. Roles alternate deterministically. Hangman uses one shared word per contest; role-swapped pairs reuse the same seeded word. Legacy lane-based series retain their original rules. The series runs one match at a time, pauses on provider, budget, storage, or qualification failure, and keeps every attempt. **Retry Slot** repeats the same challenge, **Skip Slot** leaves it unscored, and **Resume** continues a paused match.

Per-game points are win 1, draw ½, loss 0. Normalized performance is points divided by scored possible points. For v2, overall performance is the mean of game-family normalized values, using configured positive weights if present, and is withheld unless every planned slot is qualified and scored. Raw W/D/L, unscored counts, role distribution, requests, latency, token/cost reporting coverage, and component values remain visible. This is not an intelligence score. A completed v2 export includes the root seed, plan, agents and settings as a reproducibility manifest; **Rerun exact configuration** starts an identical schedule. The root seed and future Hangman challenge seeds stay out of public state and exports until the series completes. Model behavior may still vary between runs.

The API offers `GET /api/series`, `GET /api/series/:id`, `GET /api/series/:id/export`, `POST /api/series`, and `POST /api/series/:id/{start,pause,stop,retry,skip}`. Creation accepts `plan` and optional 64-character hex `masterSeed`; a random seed is the default. Exact resolved identity and tool restrictions must be verified during a trial before its actions can score. Fixture tests exercise v1, v2, and research v3 lifecycles; they do not prove any live provider model or billing claim.

## Registered research studies

Choose **Battle series → RESEARCH** and two explicit Claude model IDs. **REGISTER PILOT** saves the declaration without making model requests; review the saved study and use **START REGISTERED STUDY** to begin. The pilot uses 24 matched words, two replicates, independent lanes and seat-swapped shared-board contests: 144 matches in 24 challenge blocks. The current UI requires Claude's reported no-tools inventory; installation alone does not qualify a trial.

Research limits are totals per match, split equally between participants (rounded down). Defaults are 64 accepted actions, 128 requests, 60 active minutes, and 120 seconds per request. The reported-cost threshold is per match and cannot guarantee a total billing ceiling. At most one infrastructure rerun is allowed per slot; qualification failures require a new study. Primary analysis retains the first attempt even if a rerun succeeds.

Completed or stopped studies show paired block estimates, bootstrap intervals and all-planned-block missing-outcome bounds. These are exploratory ruleset comparisons, not isolated measurements of strategy or intelligence. Completed exports include exact rerun manifests; research reruns register for review before starting. Adaptation, human references, and multi-party games remain future work.

Offline commands make no provider calls and do not write to application history:

```sh
npm run --silent research -- baseline > baseline.json
npm run --silent research -- prepare EXACT_MODEL_A EXACT_MODEL_B > registration.json
```

`prepare` prints a body for `POST /api/series`; it does not submit it. `baseline` compares two fixed letter-order policies across the full pilot schedule. The research API also provides `GET /api/research/presets` and `GET /api/series/:id/analysis`. See [the protocol](docs/RESEARCH_PROTOCOL.md) before interpreting or publishing results.

## Checks

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run benchmark
```

The adapter/controller tests use fake local CLI executables and do not make paid model requests. CI runs tests, lint, typecheck and build on Node 20 and 22 on every push to `main` and every pull request, using the committed lockfile and local fixtures only. See [the handoff](docs/HANDOFF.md) for the current acceptance boundary and the next recommended work.

## Project guide

- [Architecture](docs/ARCHITECTURE.md): module boundaries, state ownership, persistence and event flow.
- [Agent protocol](docs/AGENT_PROTOCOL.md): observation and action contract, retry behavior and CLI invocation details.
- [Handoff](docs/HANDOFF.md): what has been implemented and how another agent should continue.
- [Battleship rules](docs/BATTLESHIP.md): actions, privacy, replay, and metrics.
- [Hangman rules](docs/HANGMAN.md): shared-board and independent-lane scoring, model selection and privacy.
- [Research protocol](docs/RESEARCH_PROTOCOL.md): registered pilot, evidence requirements, paired analysis, controls and research gates.
- [Contributing](CONTRIBUTING.md): local checks and the main-branch workflow.
- [Security](SECURITY.md): local trust boundary and vulnerability reporting.
- [Changelog](CHANGELOG.md): implemented changes.
- [Third-party notices](THIRD_PARTY_NOTICES.md): dependency and reuse attribution.
- [Game sources](docs/GAME_SOURCES.md): reviewed repositories, commits, licenses, and attribution decisions.

## Hangman

Select **Hangman**, choose two explicit models and a ruleset, and start. The default shared-board mode alternates agents on one board. Correct guesses reveal letters to both agents and earn points; misses lose points. A solve or seven shared misses ends the contest; highest score wins. New casual matches default to disabled Claude extended thinking or low Codex reasoning unless you explicitly select a level. Each turn launches a fresh CLI invocation and temporary working directory without a resumed conversation. For a cross-provider contest, choose Codex on one side and Claude Code on the other. The selectable `independent-lanes-1` mode gives each player a private solving lane; saved records retain their original rules and replay; standings stay separate by ruleset. A game result can be recorded without verified model metadata, but comparative standings require resolved identities matching both requests. Codex CLI currently omits that metadata from its JSONL output. See [Hangman rules and privacy](docs/HANGMAN.md).

Hangman uses a light interface with a focused setup screen, a prominent winner and score, and **New match** above the board. New match preserves competitors for review; **Start Hangman match** creates a fresh word. **Back to match** restores the current board. Pause, resume and stop controls appear above the board; replay, request details, identity qualification and comparative standings remain available below or in disclosures. Model display names are presentation labels, not identity verification.

The durable store retains Chess, Hangman, Battleship, and v1/v2/v3 series records, including the research v3 declaration, assignment validation, and execution evidence. Legacy store version 7 is imported in one transaction with a backup and SHA-256 manifest; an unknown future version refuses startup. Private seeds, canonical state, provider excerpts, and recovery candidates stay in local data. Public match-list summaries contain no game state. Request identities are persisted before invocation, and budgets are rechecked before every request, including corrections.

## Troubleshooting

- After rebuilding the production UI, refresh an existing browser tab to load the new bundle. Backend changes also require restarting the local server.
- The Hangman renderer tolerates live updates that briefly have no current player; it shows “Preparing the next turn” instead of throwing and blanking the page.
- A model dropdown is a list of previously used IDs, not a live provider catalog or availability guarantee. Check the selected CLI's supported models if a request fails.
- CLI detection checks installation and version, not authentication. Sign in using the CLI itself. Provider errors remain unscored; missing resolved model metadata leaves a completed game unranked.
