# Architecture

## Runtime shape

```text
React spectator/control UI
        │ HTTP controls + initial/lifecycle snapshots + small named SSE events
        ▼
Express local API
        │
        ▼
MatchController ─── AgentRegistry ─── AgentAdapter instances
        │                                  │
        ▼                                  ▼
GameDefinition                         Codex / Claude Code / OpenCode CLI
        │
        ▼
Authoritative in-memory game state ─── SQLite WAL store (node:sqlite)
```

The controller never reads the board from the UI. The React app cannot make a move in the current version. There is no endpoint that accepts a proposed move from a browser or CLI. The only path to changing a game is `MatchController` calling `GameDefinition.validateAction` followed by `GameDefinition.applyAction`.

## Domain boundaries

### `GameDefinition<State>`

`src/domain/game.ts` defines the game plug-in contract: game identity/version, player IDs and labels, state creation, current-player selection, player-specific observations, action validation/application, terminal/result handling, serialization and deserialization. The controller holds game state as an opaque value and calls this contract. It does not import `Chess` or inspect chess moves.

`ChessGame` in `src/games/chess/ChessGame.ts` implements standard two-player chess using chess.js. Its internal state is a chess.js position, move records and optional resignation. Observation `chess-observation-v3` exposes FEN, current side, the upcoming board ply and turn index, move history, the turn deadline, and one legal-action list. `legalActions` is that list. The transport schema still enumerates legal UCI moves for providers that need a schema. Serialization includes FEN, PGN, per-move FENs and resignation metadata. Reload verifies that saved PGN, FEN, move records and resignation metadata agree. Optional `metrics()` returns versioned game measurements. The engine does not depend on the UI.

The game contract also exposes `eventProjection(state)`. Chess returns the latest move record, current FEN and PGN so the spectator can update the board and replay one ply at a time without receiving a full match snapshot after every event.

The UI renders Chess, Hangman, and Battleship through `ArenaRouter`. Adding a game does not require changing the controller or adapter protocol, but it requires a safe view for that game's public snapshot. `GameRegistry.get(id, version)` resolves an exact registered ruleset; omitting version selects the current default. Creation can specify `gameVersion`; restoration, projection and series execution always use the recorded version. `GameRegistry.list()` publishes lightweight descriptors including participant count, hidden-information capability, and optional series policy. `listVersions()` exposes all registered versions and which is current.

### `MatchController`

`src/domain/MatchController.ts` owns each match lifecycle:

1. Create the selected game and save its initial canonical snapshot.
2. Ask the game for its current player and an observation scoped to that player.
3. Call that player's configured adapter with the observation.
4. Enforce a deadline, parse/reject bad responses, pass validation feedback into one retry, then adjudicate a forfeit if needed.
5. Apply only a valid action, record compact FEN/action telemetry, and continue until the game reports a result.
6. Persist canonical state checkpoints and publish small activity events.

Pause cancels the in-flight request and preserves the unchanged turn and any saved rejection feedback, so resume can continue a recorded retry state. A unique invocation ID and deadline are committed before provider spawn. Stop cancels the request but marks the match stopped; stop is also a valid, spawn-free command for a ready, paused or interrupted match, and is idempotent once terminal. A `stopped` match keeps its history and has no winner. On an app restart, an interrupted match is restored from the saved game snapshot. Creation is blocked while any match is ready, running, paused or interrupted; multiple legacy active records can each be stopped to recover.

### `AgentAdapter`

`src/domain/agent.ts` defines `initialize()`, `act(observation)` and `shutdown()`. `AgentRegistry` constructs adapters from the configured provider. The controller receives structured `GameAction` values, not CLI stdout or provider-specific envelopes.

`src/server/adapters.ts` implements CodexCLIAdapter, ClaudeCodeAdapter and OpenCodeAdapter. Each adapter handles command arguments, temporary working directories, provider-specific output envelopes, strict JSON parsing, usage extraction and child-process shutdown. A shared runner in `src/server/processRunner.ts` owns the per-attempt deadline, cancellation signal, bounded UTF-8 output capture, and process-group termination, so the controller cannot start a retry before the previous process tree has settled. Envelope and metadata parsing happens once per attempt; diagnostics pass through `src/server/diagnostics.ts` for bounded, best-effort redaction. Commands are passed to `spawn` as argument arrays; model strings never pass through a shell. Claude Code and OpenCode have tools disabled for the match request. Codex runs with its read-only sandbox; Codex can still use read-only CLI tools, and the controller rejects a proposed action when reported tool calls occurred. These CLI settings are not OS-user isolation: processes run as the current local user.

All agents receive a new complete observation every turn. No transcript is needed to reconstruct the current position. The current design uses push-observation / action-response; an MCP agent adapter can later use the same observation/action types without changing the game engine.

## Persistence and telemetry

`data/agent-battle.sqlite` (override the directory with `AGENT_BATTLE_DATA_DIR`) is a local SQLite database in WAL mode, opened through Node's built-in `node:sqlite`. The supported runtime is Node.js 22.13 or newer; `src/server/main.ts` checks that before loading the server. A checkpoint upserts one match, or one series, and its derived rows inside a transaction. Durable domain events are appended and retained in full. `record_json` is the canonical record and is validated on load; scalar columns, participants, events, invocations, sessions, and execution profiles are indexed projections. `src/version.ts` is the source of truth for schema, adapter, observation, action, and protocol versions. The current database schema is 2. The current observation contract is `observation-contract-v4`.

Opening distinguishes four cases. A missing file is created at schema 2. Schema 2 is opened read-write. Schema 1 is migrated forward in one transaction without rewriting `record_json`. Any other version, including a newer schema, is probed read-only and left unchanged, including no new WAL or SHM file. On Unix the data directory is mode `0700` and the database, `-wal`, `-shm`, and migration backup files are mode `0600` after open and after a checkpoint. A chmod failure refuses startup. These modes are the enforced owner-only permissions; they are not encryption.

On first start the server imports a legacy `data/matches.json` (bare array or a supported versioned envelope up to 7) in one transaction. It copies the original files into `data/migrations/v7-import-<timestamp>/` with a SHA-256 manifest and never modifies or deletes them. A `legacy_imports` receipt records the source path, SHA-256, store version, completion state, manifest path, and timestamp. The same hash is skipped on later startups, including an empty or series-only source. A changed source file is not merged over the database. Invalid matches are quarantined. `src/server/integrity.ts` then checks series slots against those matches: missing or quarantined matches, wrong series, slot, attempt, game, agent, Hangman seed, research assignment, or a completed series with an unfinished slot quarantine the series and leave independently valid matches in place. `record_json` is not rewritten. Startup continues with a storage warning. Unreadable SQL or a future schema still aborts startup.

A single-writer lock (`data/matches.json.lock`) is acquired atomically at startup before the database is opened. A recovery guard serializes stale-lock reclamation; uncertain ownership fails closed. Each durable checkpoint is a SQLite transaction with `synchronous = FULL`, so a committed transition survives an app crash and a host power loss. The match attempt is the invocation authority. The `invocations` table is written in that same transaction. A provider process starts only after the pending attempt is committed with ledger state `reserved`. After the child exists, a second checkpoint records `spawned` and the pid. Terminal states are `completed`, `failed`, `timed_out`, `cancelled`, and `interrupted`. A crash after the request leaves the process can leave the row `reserved` or `spawned`; recovery marks that uncertainty and does not invent a provider response. A later request uses a new invocation id. Possible duplicate provider billing stays visible. Retry exhaustion commits invalid evidence and forfeit together. Presentation-only agent/turn activity streams without a durable revision and is not replayed after reconnect. A failed transaction rolls back; the controller restores the last committed position in memory, stops further requests, reports a storage error, and prevents a success acknowledgement for the failed transition. Every match the restore pass changes to interrupted or error is saved. The in-memory event window is the last 500 events; `match_events` keeps the complete log, and the events API and series export read that log through the safe projection.

Startup validates every accepted row, then keeps a working set: matches in `ready`, `running`, `paused`, or `interrupted`, non-terminal series, and the matches those series link. Completed history stays in SQLite. Matches created during the process remain in the controller after they finish. Session identity for a live turn is an indexed lookup, and research analysis counts a session only among matches linked to that study.

Each record contains:

- Game ID and game version, protocol/schema versions, participants, model/reasoning selection and timeout/retry settings.
- The serialized authoritative game state, including chess PGN and replay moves.
- An event feed and one telemetry record per agent turn, including every retry attempt, FEN before/after, and usage data. The in-memory event feed is the last 500 events. The durable event log is complete.
- Match result and timestamps, plus an optional pending turn (used to keep saved retry feedback across a pause or restart). Invocation identity and deadline are committed before provider spawn.

Token counts and cost are nullable because CLIs expose different metadata. No chain-of-thought is requested or used. Successful responses are stored as canonical action JSON; malformed response excerpts and stderr diagnostics are bounded and token-redacted through `src/server/diagnostics.ts`.

Usage is modeled as reported categories with per-metric reported/total counts plus a compatibility coverage flag (`none`/`partial`/`full`). Unknown cost and tokens are labelled explicitly; pending provider attempts count toward totals. Initialization errors are not counted as model requests.

Each match stores an `environment` block (adapter version, prompt/schema versions, provider CLI versions captured at creation) and requested participant settings. Provider parsers populate resolved model identity when reported. Series trials require explicit requested models and exact resolved identity; unknown identity or unqualified isolation stops a slot unscored. Codex CLI currently remains unqualified for scored series trials because read-only sandboxing does not remove its tools.

Resource budgets (`maxPlies`, `maxRequests`, `maxWallMinutes`, optional `maxReportedCostUsd`) live in match settings. Series matches additionally receive equal per-player request and provider-time limits, while match-level limits are safety stops. New records include `timeAccounting` with accumulated active milliseconds and the start of any open running segment; pause and terminal transitions close that segment. On restart, an unclosed segment is conservatively charged through recovery. Records without this field retain the former creation-age rule. Request, time, and reported-cost thresholds are checked before each invocation, including retries; budget exhaustion never fabricates a game result.

### Transport projection and history

The durable store keeps full records, but transports use a projection (`src/domain/projection.ts`). Snapshots carry summaries for history (identity, participants, result, counts) and a full transport projection only for the active match; a selected historical match is fetched through `GET /api/matches/:id`. The projection drops bulky diagnostics (`responseExcerpt`, `stderrExcerpt`, legacy `stateBefore`/`stateAfter`) and bounds the streamed event window. Detail, event and attempt endpoints all project public data; full diagnostics remain in private local files.

History is not silently pruned: SQLite keeps every accepted record, summaries are paginated from indexed queries, and the UI event feed is the recent window. `GET /api/matches/:id/events` and series export can read the complete durable log through the safe projection. With `AGENT_BATTLE_METRICS=1` the server logs snapshot and checkpoint sizes and durations. `npm run benchmark` measures projections, the legacy JSON rewrite, the durable per-record checkpoint, startup validation, history pagination, session lookup, series save, and observation prompt sizes. `npm run benchmark -- --large` adds the 10,000-record case. It does not qualify browser latency or every real-world history shape. On 2026-09-29, 1,100 stopped chess records validated in about 28 ms and left no resident matches; a durable checkpoint of one fat record stayed near 2 ms beside a 100-record archive.

New turn records store FEN checkpoints rather than repeating the full serialized game state for every ply. Older records may still contain `stateBefore`/`stateAfter`; those optional fields remain readable for compatibility. Accepted moves, rejections, errors and lifecycle changes are persisted at their state boundary.

On restore, ChessGame verifies that saved PGN, FEN, move records and resignation metadata agree. The controller additionally verifies that a stored `finished` result matches the replayed game; a mismatch marks the record `error` rather than feeding the scoreboard.

Back up the whole `data/` directory before moving or deleting match history. The legacy JSON file remains the import source and is not the live store.

## HTTP and real-time interface

### Battle series

`src/server/series.ts` preserves `battle-series-1` validation for historical ten-slot records. New `battle-series-2` records carry a plan with registered game IDs, exact ruleset versions, repetitions, alternating roles, fixed/seeded challenge policy, optional family weights, and exploratory/strict mode. The registry's game policy supplies seat sensitivity, seeded-challenge support, recommended repetitions and a fixed challenge ID. The scheduler operates on slots without ordinal-based game branches. Hangman seeds derive from a random or supplied 256-bit series root through a versioned HMAC; public challenge IDs are hashes. Chess and Battleship have fixed challenge IDs and no hidden random challenge. A slot's private seed stays local until series completion. Strict mode requires even repetitions for seat-sensitive games; exploratory odd schedules expose their role split. A series and linked matches share the store and lock. Restart pauses an active series and does not spawn a provider by itself. The scheduler stays sequential: one match at a time. Retry authorization is a durable scheduler command written before the next match is created, and it is consumed when that match is created. Skip is stored on the slot. A completed slot is not played again. Research analysis still uses the first attempt; an infrastructure rerun does not replace it. A series checkpoint writes that series and its derived rows. Unscored outcomes pause the series. Qualification failures cannot be retried into the primary observation.

Series results retain per-game and role records and raw win/draw/loss counts. Win earns 1 point, draw ½, loss 0; each family reports points divided by scored possible points. For v2, overall normalized performance is the mean of family values, weighted only by explicit positive plan weights, and is withheld unless every planned slot is qualified and scored. Unscored trials remain visible and are excluded from the scored denominator. Request, token, cost, and latency totals include separate coverage counts. Completed v2 exports include a reproducibility manifest with root seed, plan, agent configs and settings; earlier exports do not reveal private future seeds. Raw diagnostics remain local. This performance ratio is not an intelligence score.

The API binds to `127.0.0.1:4173`; Vite serves the UI on `127.0.0.1:5173` during development and proxies `/api` requests. All routes live under `/api`; an unknown `/api` route returns a JSON 404 and never falls through to the SPA. Request bodies are JSON-only, malformed JSON returns a JSON 400, and errors use a stable `{ error, code }` envelope with meaningful 404/409/500/503 distinctions.

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Canonical snapshot: providers, `activeMatchId`, active match and recent records |
| `GET /api/games` | Current game descriptors and all registered ruleset versions |
| `GET /api/research/presets` | Research pilot declaration and workload estimate |
| `GET /api/series` / `GET /api/series/:id` | Public schedules and operational results |
| `GET /api/series/:id/analysis` | Research first-attempt rows, paired contrasts and missingness bounds |
| `GET /api/series/:id/export` | Projected evidence and completed reproducibility manifest |
| `POST /api/series` | Register a v2 plan or v3 research declaration/preset |
| `POST /api/series/:id/{start,pause,stop,retry,skip}` | Durable series controls |
| `GET /api/events` | Server-Sent Events for named domain events and state snapshots |
| `POST /api/matches` | Create a match from two player configs |
| `POST /api/matches/:id/start` | Start or resume a ready, paused or interrupted match |
| `POST /api/matches/:id/pause` | Cancel the active turn and preserve the position |
| `POST /api/matches/:id/stop` | Stop the match, or stop a ready/paused/interrupted match without spawning |
| `POST /api/providers/refresh` | Re-check local CLI executables and versions |

`GET /api/state` and the SSE `snapshot` event are produced by the same projector (`src/domain/snapshot.ts`), so the two paths cannot disagree. The active match is included both as `activeMatch` and within `recentMatches`; `activeMatchId` keeps it reachable from history. Each snapshot carries a monotonic `revision` (the maximum record revision included) and each streamed event carries its match `sequence`, emitted as the SSE `id`. The client reducer ignores duplicate or stale events and refetches the snapshot on a detected revision gap.

Local-host requests are required: a `Host` header outside loopback is rejected, and state-changing requests with a cross-site `Origin` are rejected. Requests with no `Origin` (local CLI clients) are allowed. The event stream detects and drops a client whose socket buffer grows past a bound rather than buffering without limit.

The event stream sends one full `snapshot` on connection and again for match creation, start/resume, pause/stop, terminal results and agent errors. Between those boundaries it emits named domain events such as `turn.started`, `agent.started`, `agent.response`, `move.proposed`, `move.rejected`, `move.applied`, `turn.completed` and `agent.timeout`. Presentation events have no durable sequence or SSE ID and do not advance the client revision. A completed turn includes its canonical telemetry record so the client can patch its history without a snapshot; a chess move includes current PGN and next-player identity. Ordinary activity does not retransmit all saved games.

## Adding another game

The game registry supplies role IDs, labels, hidden-information behavior, runtime cloning, public projection, and optional series capability. The series scheduler consumes this contract for Chess, Hangman, and Battleship; a future two-player game adds its own view and challenge policy.

1. Implement `GameDefinition<State>` with a canonical state and a per-player observation. Keep hidden/private state inside the game; project only player-allowed facts into `observe()`.
2. Define a generic action envelope and game-specific action schema. Validate the current player and all payload fields before applying.
3. Implement terminal/result handling and a versioned serializer/deserializer, plus `plyCount(state)`.
4. Add a safe public projection, game descriptor and UI view, then register the game in `src/domain/defaultGames.ts`.
5. Add domain tests for legal/illegal actions, wrong player, player-specific observations, terminal states and persistence reload.

Before implementing a new game or major subsystem, audit existing open-source mechanics and record pinned versions, licenses and integration decisions in [Game sources](GAME_SOURCES.md). Prefer a small reusable unit over another controller, persistence layer or provider stack.

Match creation accepts a role-keyed `players` map. Legacy `white`/`black` request fields remain accepted for Chess only; mixed formats are rejected. `ArenaRouter` selects game views. Storage delegates game validity to the registry.

### Current boundaries / limits

- Two participants per match are required by the controller, but player IDs and labels come from the game definition.
- There is a per-request timeout and an active-match runtime budget, not an official chess clock.
- One match runs at a time in this single-user app.
- Adapters start a fresh CLI request for each move. Model/provider accounts may bill according to their own plan; the optional threshold uses reported cost and cannot guarantee a billing cap when usage is missing.
- Stockfish analysis, human adapters, and remote access are future work.

## Multi-game projection boundary

`GameRegistry` validates game compatibility and authoritative saved state. The store validates the envelope and common match fields, then delegates game validity through its validator. Game definitions distinguish private `serialize`/`deserialize` from `publicState` and player-specific `observe`. Hangman additionally supplies public action redaction and masked public replay. `HangmanDuelGame` owns shared scoring and contest forfeits; `HangmanGame` owns independent-lane rules and lane-local forfeits for new and historical matches.

`MatchSummary` is an explicit list DTO. `PublicMatchDetail` contains only projected state and telemetry. `AppState.recentMatches` uses summaries. HTTP creation/start/detail, JSON downloads, SSE, attempts, and events use the same projection boundary. Hangman and Battleship events are sanitized before durable storage as well as before transport. `ArenaRouter` selects the Chess, Hangman, or Battleship arena. Battleship placement coordinates stay private until the terminal public reveal, and earlier replay frames remain masked.

Each new request has a durable invocation UUID and deadline before process invocation. Completion updates that reservation. A restarted unfinished invocation becomes interrupted with unknown provider latency/usage; its reserved interval is conservatively charged as controller-accounted player time. Qualification failures retain actual provider latency, usage, tool count and resolved-model evidence. Historical attempts retain their original evidence without invented invocation identities. A failed write retains a private recovery candidate and stops requests; the server attempts to write that candidate to a separate private recovery file. If that write also fails, the candidate is memory-only until process exit. Snapshot epochs and state versions protect the browser against stale deliveries.

## Hangman presentation and compatibility

`HangmanDuelArena` renders `shared-board-2`; `HangmanArena` renders `independent-lanes-1`. Both consume public match/replay projections through `ArenaRouter`. `src/hangman.css` scopes the light theme to Hangman. `src/client/modelPresentation.ts` formats display names without changing canonical identity or scoring.

Setup draws model choices from saved match IDs, supports custom IDs and replaces the selected model when the CLI changes. Match controls remain controller-backed HTTP actions. Renderers must tolerate partial presentation updates: a running match can temporarily have no current player, and the UI shows a preparing state. It must not dereference a missing player or infer a winner from that transition.

Shared-board observations use `hangman-shared-observation-v3` and keep the global ply, because it is the shared turn count. Independent-lane observations use `hangman-observation-v2`; `ply` and `turnIndex` count that lane's own actions. Battleship observations use `battleship-observation-2`; remaining targets are `legalActions`. Claude and Codex prompts leave `actionSchema` to the CLI schema argument. OpenCode's prompt includes it. Shared-board Hangman is seat-sensitive. Strict series require even repetitions and reuse the same derived word seed for each role-swapped pair. Versioned legacy series retain their original lane rules and seed schedule. Comparative standings exclude unverified model identities across all games and keep Hangman rulesets separate.

## Research series v3

`researchPlan.ts` validates exact declaration fields and registered two-player rulesets, constructs block-interleaved schedules with HMAC ordering, pairs challenge seeds across conditions, and hashes the canonical plan/agents/settings. A same-model control requires the same evaluated system: provider, requested model, and requested reasoning. A system comparison requires those keys to differ. Resolved-model equality remains a separate per-attempt check. `researchMatchBudgets` interprets declared limits as whole-match totals with equal participant allocations. `schema.ts` reconstructs the schedule on load and rejects altered commitments or assignments. `integrity.ts` checks match linkage, ruleset, participants, challenge, and resource settings for both the legacy importer and the SQLite load. Store 7 preserves supported historical formats rather than rewriting them into research plans.

The existing `SeriesManager` owns registration, checkpoints, scheduling, restart recovery and controls. V3 slots add condition, block, replicate and ruleset identifiers. Every research match links to its declaration hash. At start, before any match exists, the series freezes one execution profile per agent: provider, requested model and reasoning, adapter version, observation and action protocol versions, the CLI `--version` line, restriction profile id, and a digest of the restriction text plus declared capabilities. Later scored attempts that drift are qualification failures and the series pauses. Casual matches and series that already have matches do not receive a fabricated profile. Research preflight refuses a start unless the adapter declares exact model, session, complete stream, tool inventory, tool-use detection, and isolation evidence. Claude declares that contract. Codex, OpenCode, and Grok do not, so they remain outside this pilot. The research UI registers without starting and exposes both Hangman modes. Generic plans support existing registered two-player games; multi-party phases are not implemented.

`src/domain/scorecard.ts` builds a read-time scorecard with five layers: game outcome, versioned game metrics, termination class, execution qualification, and resource coverage. Unknown tokens, cost, and effective reasoning stay null. A protocol forfeit remains a scored win for the opponent and is labeled `protocol-forfeit`. A provider or storage failure stays unscored. Research v3 primary analysis does not read the scorecard. The frozen primary endpoint remains first-attempt paired-block win share, missing-outcome bounds, and `paired-block-bootstrap-1`.

`researchAnalysis.ts` evaluates the first match attached to each planned slot, rechecks assignment and execution evidence, and excludes reused provider sessions. Seats and replicates are averaged within challenge blocks. Completed/stopped studies expose the paired contrast, deterministic 5,000-sample block bootstrap and all-planned-block missing-outcome bounds. Inferential estimates are withheld while running. Operational totals include reruns; successful reruns do not replace primary observations. There is no overall research intelligence score.

`executionEvidence.ts` in the server extracts bounded metadata from provider streams; its domain counterpart defines research eligibility reasons. The controller records evidence on success and failure and rejects unqualified responses before scoring. Hashes exclude private observations. Public exports omit future roots until completion; the built-in pilot root is public by construction and provides no contamination defense. The UI/analysis labels this an exploratory study. See [RESEARCH_PROTOCOL.md](RESEARCH_PROTOCOL.md) for interpretation and remaining gates.
