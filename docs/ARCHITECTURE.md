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
Authoritative in-memory game state ─── Local JSON persistence
```

The controller never reads the board from the UI. The React app cannot make a move in the current version. There is no endpoint that accepts a proposed move from a browser or CLI. The only path to changing a game is `MatchController` calling `GameDefinition.validateAction` followed by `GameDefinition.applyAction`.

## Domain boundaries

### `GameDefinition<State>`

`src/domain/game.ts` defines the game plug-in contract: game identity/version, player IDs and labels, state creation, current-player selection, player-specific observations, action validation/application, terminal/result handling, serialization and deserialization. The controller holds game state as an opaque value and calls this contract. It does not import `Chess` or inspect chess moves.

`ChessGame` in `src/games/chess/ChessGame.ts` implements standard two-player chess using chess.js. Its internal state is a chess.js position, move records and optional resignation. Its observation exposes FEN, current side, the upcoming board ply and turn index, legal UCI moves, move history, allowed action schema and the turn deadline. Serialization includes FEN, PGN, per-move FENs and resignation metadata. Reload verifies that saved PGN, FEN, move records and resignation metadata agree.

The game contract also exposes `eventProjection(state)`. Chess returns the latest move record, current FEN and PGN so the spectator can update the board and replay one ply at a time without receiving a full match snapshot after every event.

The UI renders Chess, Hangman, and Battleship through `ArenaRouter`. Adding a game does not require changing the controller or adapter protocol, but it requires a safe view for that game's public snapshot. `GameRegistry.get(id, version)` resolves an exact registered ruleset; omitting version selects the current default. Creation can specify `gameVersion`; restoration, projection and series execution always use the recorded version. `GameRegistry.list()` publishes lightweight descriptors including participant count, hidden-information capability, and optional series policy.

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

`data/matches.json` (override the directory with `AGENT_BATTLE_DATA_DIR`) stores match and series records in a versioned envelope. The current store version is 6; bare JSON arrays and supported older envelopes are migrated on load with a pre-migration backup. The store is validated on load:

- An unreadable, unsupported, or future-version root remains in place and prevents server startup.
- Individual records that fail runtime validation are written to a quarantine file and excluded; valid records are retained.
- Migration is idempotent and keeps a `.bak` copy; losing a valid record is never used as a recovery path.

A single-writer lock (`matches.json.lock`) is acquired atomically at startup before data is loaded. A recovery guard serializes stale-lock reclamation; uncertain ownership fails closed. Writes use a unique temporary file with `fsync` and an atomic rename with owner-only permissions. An accepted action commits detached game state, turn telemetry, durable events/revisions, next player and any terminal result together before publication. Retry exhaustion commits invalid evidence and forfeit together. Presentation-only agent/turn activity streams without a durable revision or store write and is not replayed after reconnect. A failed write restores the last committed position in memory, stops further requests, reports a storage error, and prevents a success acknowledgement for the failed transition. The last durable running state is marked interrupted on restart.

Each record contains:

- Game ID and game version, protocol/schema versions, participants, model/reasoning selection and timeout/retry settings.
- The serialized authoritative game state, including chess PGN and replay moves.
- An event feed and one telemetry record per agent turn, including every retry attempt, FEN before/after, and usage data. The event feed is a bounded recent window, not the complete history.
- Match result and timestamps, plus an optional pending turn (used to keep saved retry feedback across a pause or restart). Invocation identity and deadline are committed before provider spawn.

Token counts and cost are nullable because CLIs expose different metadata. No chain-of-thought is requested or used. Successful responses are stored as canonical action JSON; malformed response excerpts and stderr diagnostics are bounded and token-redacted through `src/server/diagnostics.ts`.

Usage is modeled as reported categories with per-metric reported/total counts plus a compatibility coverage flag (`none`/`partial`/`full`). Unknown cost and tokens are labelled explicitly; pending provider attempts count toward totals. Initialization errors are not counted as model requests.

Each match stores an `environment` block (adapter version, prompt/schema versions, provider CLI versions captured at creation) and requested participant settings. Provider parsers populate resolved model identity when reported. Series trials require explicit requested models and exact resolved identity; unknown identity or unqualified isolation stops a slot unscored. Codex CLI currently remains unqualified for scored series trials because read-only sandboxing does not remove its tools.

Resource budgets (`maxPlies`, `maxRequests`, `maxWallMinutes`, optional `maxReportedCostUsd`) live in match settings. Series matches additionally receive equal per-player request and provider-time limits, while match-level limits are safety stops. New records include `timeAccounting` with accumulated active milliseconds and the start of any open running segment; pause and terminal transitions close that segment. On restart, an unclosed segment is conservatively charged through recovery. Records without this field retain the former creation-age rule. Request, time, and reported-cost thresholds are checked before each invocation, including retries; budget exhaustion never fabricates a game result.

### Transport projection and history

The durable store keeps full records, but transports use a projection (`src/domain/projection.ts`). Snapshots carry summaries for history (identity, participants, result, counts) and a full transport projection only for the active match; a selected historical match is fetched through `GET /api/matches/:id`. The projection drops bulky diagnostics (`responseExcerpt`, `stderrExcerpt`, legacy `stateBefore`/`stateAfter`) and bounds the streamed event window. Detail, event and attempt endpoints all project public data; full diagnostics remain in private local files.

History is not silently pruned: the store writes every retained record, summaries are paginated, and the readable event feed is explicitly a bounded recent window rather than complete history. Terminal runtime entries are not yet evicted consistently. With `AGENT_BATTLE_METRICS=1` the server logs snapshot and checkpoint sizes and durations; `npm run benchmark` measures synthetic projections and actual JSON store writes in a temporary directory. It does not qualify browser latency or every real-world history shape.

New turn records store FEN checkpoints rather than repeating the full serialized game state for every ply. Older records may still contain `stateBefore`/`stateAfter`; those optional fields remain readable for compatibility. Accepted moves, rejections, errors and lifecycle changes are persisted at their state boundary.

On restore, ChessGame verifies that saved PGN, FEN, move records and resignation metadata agree. The controller additionally verifies that a stored `finished` result matches the replayed game; a mismatch marks the record `error` rather than feeding the scoreboard.

The JSON file is local and created with owner-only permissions. Back it up before moving or deleting match history.

## HTTP and real-time interface

### Battle series

`src/server/series.ts` preserves `battle-series-1` validation for historical ten-slot records. New `battle-series-2` records carry a plan with registered game IDs, exact ruleset versions, repetitions, alternating roles, fixed/seeded challenge policy, optional family weights, and exploratory/strict mode. The registry's game policy supplies seat sensitivity, seeded-challenge support, recommended repetitions and a fixed challenge ID. The scheduler operates on slots without ordinal-based game branches. Hangman seeds derive from a random or supplied 256-bit series root through a versioned HMAC; public challenge IDs are hashes. Chess and Battleship have fixed challenge IDs and no hidden random challenge. A slot's private seed stays local until series completion. Strict mode requires even repetitions for seat-sensitive games; exploratory odd schedules expose their role split. A series and linked matches share the store and lock. Restart pauses an active series and reconciles links to avoid duplicate matches. Unscored outcomes pause the series; retry keeps failed evidence and repeats the same challenge, while skip records an unscored slot.

Series results retain per-game and role records and raw win/draw/loss counts. Win earns 1 point, draw ½, loss 0; each family reports points divided by scored possible points. Overall normalized performance is the mean of scored family values, weighted only by explicit positive plan weights. Unscored trials remain visible and are excluded from the scored denominator. Request, token, cost, and latency totals include separate coverage counts. Completed v2 exports include a reproducibility manifest with root seed, plan, agent configs and settings; earlier exports do not reveal private future seeds. Raw diagnostics remain local. This performance ratio is not an intelligence score.

The API binds to `127.0.0.1:4173`; Vite serves the UI on `127.0.0.1:5173` during development and proxies `/api` requests. All routes live under `/api`; an unknown `/api` route returns a JSON 404 and never falls through to the SPA. Request bodies are JSON-only, malformed JSON returns a JSON 400, and errors use a stable `{ error, code }` envelope with meaningful 404/409/500/503 distinctions.

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Canonical snapshot: providers, `activeMatchId`, active match and recent records |
| `GET /api/games` | Registered game IDs and player IDs |
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

`GameRegistry` validates game compatibility and authoritative saved state. The store validates the envelope and common match fields, then delegates game validity through its validator. Game definitions distinguish private `serialize`/`deserialize` from `publicState` and player-specific `observe`. Hangman additionally supplies public action redaction and masked public replay. `HangmanDuelGame` owns shared scoring and contest forfeits; `HangmanGame` preserves legacy lane-local forfeits.

`MatchSummary` is an explicit list DTO. `PublicMatchDetail` contains only projected state and telemetry. `AppState.recentMatches` uses summaries. HTTP creation/start/detail, JSON downloads, SSE, attempts, and events use the same projection boundary. Hangman and Battleship events are sanitized before durable storage as well as before transport. `ArenaRouter` selects the Chess, Hangman, or Battleship arena. Battleship placement coordinates stay private until the terminal public reveal, and earlier replay frames remain masked.

Each new request has a durable invocation UUID and deadline before process invocation. Completion updates that reservation. A restarted unfinished invocation becomes interrupted with unknown provider latency/usage; its reserved interval is conservatively charged as controller-accounted player time. Qualification failures retain actual provider latency, usage, tool count and resolved-model evidence. Historical attempts retain their original evidence without invented invocation identities. A failed write retains a private recovery candidate and stops requests; the server attempts to write that candidate to a separate private recovery file. If that write also fails, the candidate is memory-only until process exit. Snapshot epochs and state versions protect the browser against stale deliveries.

## Hangman presentation and compatibility

`HangmanDuelArena` renders `shared-board-2`; `HangmanArena` renders `independent-lanes-1`. Both consume public match/replay projections through `ArenaRouter`. `src/hangman.css` scopes the light theme to Hangman. `src/client/modelPresentation.ts` formats display names without changing canonical identity or scoring.

Setup draws model choices from saved match IDs, supports custom IDs and replaces the selected model when the CLI changes. Match controls remain controller-backed HTTP actions. Renderers must tolerate partial presentation updates: a running match can temporarily have no current player, and the UI shows a preparing state. It must not dereference a missing player or infer a winner from that transition.

Shared-board Hangman is seat-sensitive. Strict series require even repetitions and reuse the same derived word seed for each role-swapped pair. Versioned legacy series retain their original lane rules and seed schedule. Comparative standings exclude unverified model identities across all games and keep Hangman rulesets separate.
