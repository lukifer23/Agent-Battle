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

The game contract also exposes `eventProjection(state)`. Chess returns the latest move record and current FEN so the spectator can update the board and replay one ply at a time without receiving a full match snapshot after every event.

The UI currently renders the `ChessSnapshot` projection. Adding a game does not require changing the controller or adapter protocol, but it will require a view for the new game's snapshot.

### `MatchController`

`src/domain/MatchController.ts` owns each match lifecycle:

1. Create the selected game and save its initial canonical snapshot.
2. Ask the game for its current player and an observation scoped to that player.
3. Call that player's configured adapter with the observation.
4. Enforce a deadline, parse/reject bad responses, pass validation feedback into one retry, then adjudicate a forfeit if needed.
5. Apply only a valid action, record compact FEN/action telemetry, and continue until the game reports a result.
6. Persist canonical state checkpoints and publish small activity events.

Pause cancels the in-flight request and preserves the unchanged turn, including a durable in-flight attempt record, so resume keeps the prior rejection feedback and remaining retry budget instead of restarting the turn. Stop cancels the request but marks the match stopped; stop is also a valid, spawn-free command for a ready, paused or interrupted match, and is idempotent once terminal. A `stopped` match keeps its history and has no winner. On an app restart, an interrupted match is restored from the saved game snapshot; resuming asks the current player again and continues any retained in-flight attempt. Creation is blocked while any match is ready, running, paused or interrupted; multiple legacy active records can each be stopped to recover.

### `AgentAdapter`

`src/domain/agent.ts` defines `initialize()`, `act(observation)` and `shutdown()`. `AgentRegistry` constructs adapters from the configured provider. The controller receives structured `GameAction` values, not CLI stdout or provider-specific envelopes.

`src/server/adapters.ts` implements CodexCLIAdapter, ClaudeCodeAdapter and OpenCodeAdapter. Each adapter handles command arguments, temporary working directories, provider-specific output envelopes, strict JSON parsing, usage extraction and child-process shutdown. A shared runner in `src/server/processRunner.ts` owns the per-attempt deadline, cancellation signal, bounded UTF-8 output capture, and process-group termination, so the controller cannot start a retry before the previous process tree has settled. Envelope and metadata parsing happens once per attempt; diagnostics pass through `src/server/diagnostics.ts` for bounded, best-effort redaction. Commands are passed to `spawn` as argument arrays; model strings never pass through a shell. Claude Code and OpenCode have tools disabled for the match request. Codex runs with its read-only sandbox; Codex can still use read-only CLI tools, and the controller rejects a proposed action when reported tool calls occurred. These CLI settings are not OS-user isolation: processes run as the current local user.

All agents receive a new complete observation every turn. No transcript is needed to reconstruct the current position. The current design uses push-observation / action-response; an MCP agent adapter can later use the same observation/action types without changing the game engine.

## Persistence and telemetry

`data/matches.json` (override the directory with `AGENT_BATTLE_DATA_DIR`) stores match records in a versioned envelope. The current store version is 2; legacy files that are a bare JSON array are migrated on load with a pre-migration backup. The store is validated on load:

- A root that is not an array or a versioned envelope is preserved (renamed aside), and the app refuses to silently replace it with an empty history.
- Individual records that fail runtime validation are written to a quarantine file and excluded; valid records are retained.
- Migration is idempotent and keeps a `.bak` copy; losing a valid record is never used as a recovery path.

A single-writer lock (`matches.json.lock`) is acquired at startup; a second instance with a live lock is refused, and a stale lock from a dead process is recovered. Writes use a unique temporary file with `fsync` and an atomic rename with owner-only permissions. Durability happens at explicit controller checkpoints (turn start, each attempt, accepted move, and lifecycle changes), not on every streamed event, so a failed write can end the match instead of proceeding under a false durability claim.

Each record contains:

- Game ID and game version, protocol/schema versions, participants, model/reasoning selection and timeout/retry settings.
- The serialized authoritative game state, including chess PGN and replay moves.
- An event feed and one telemetry record per agent turn, including every retry attempt, FEN before/after, and usage data. The event feed is a bounded recent window, not the complete history.
- Match result and timestamps, plus an optional durable in-flight turn (used to keep retry budget and feedback across a pause or restart).

Token counts and cost are nullable because CLIs expose different metadata. No chain-of-thought is requested or used. Successful responses are stored as canonical action JSON; malformed response excerpts and stderr diagnostics are bounded and token-redacted through `src/server/diagnostics.ts`.

New turn records store FEN checkpoints rather than repeating the full serialized game state for every ply. Older records may still contain `stateBefore`/`stateAfter`; those optional fields remain readable for compatibility. Accepted moves, rejections, errors and lifecycle changes are persisted at their state boundary.

On restore, ChessGame verifies that saved PGN, FEN, move records and resignation metadata agree. The controller additionally verifies that a stored `finished` result matches the replayed game; a mismatch marks the record `error` rather than feeding the scoreboard.

The JSON file is local and created with owner-only permissions. Back it up before moving or deleting match history.

## HTTP and real-time interface

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

The event stream sends one full `snapshot` on connection and again for match creation, start/resume, pause/stop, terminal results and agent errors. Between those boundaries it emits named domain events such as `turn.started`, `agent.started`, `agent.response`, `move.proposed`, `move.rejected`, `move.applied`, `turn.completed` and `agent.timeout`. A completed turn includes its canonical telemetry record so the client can patch its history without a snapshot, and ordinary activity does not retransmit all saved games. PGN is derived on demand rather than streamed on every event.

## Adding another game

1. Implement `GameDefinition<State>` with a canonical state and a per-player observation. Keep hidden/private state inside the game; project only player-allowed facts into `observe()`.
2. Define a generic action envelope and game-specific action schema. Validate the current player and all payload fields before applying.
3. Implement terminal/result handling and a versioned serializer/deserializer.
4. Register the game in `src/server/index.ts` and add a UI view for its serialized snapshot.
5. Add domain tests for legal/illegal actions, wrong player, player-specific observations, terminal states and persistence reload.

### Current boundaries / limits

- Two participants per match are required by the controller, but player IDs and labels come from the game definition.
- There is a per-move request timeout, not a chess clock.
- One match runs at a time in this single-user app.
- Adapters start a fresh CLI request for each move. Model/provider accounts may bill according to their own plan; the app does not estimate or cap cost yet.
- Stockfish analysis, human adapters, remote access and additional game views are future work.
