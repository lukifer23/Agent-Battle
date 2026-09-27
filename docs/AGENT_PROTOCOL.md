# Agent turn protocol

## Boundary

The browser is never an agent tool or input source. The match controller builds a versioned observation from the authoritative game state and starts the configured adapter. The adapter supplies that observation to its CLI and returns one structured action. The game checks player identity, turn ownership and legality before it changes state.

Agents do not receive a mutable game object, a filesystem path to the game database, an HTTP endpoint for arbitrary moves, or access to the GUI. A restarted agent can play from the next full observation without earlier conversation history.

## Chess observation v1

The exact fields are defined by `GameObservation` in `src/shared.ts` and built by `ChessGame.observe()`.

```json
{
  "schemaVersion": "chess-observation-v1",
  "gameId": "chess",
  "matchId": "match UUID",
  "turnId": "unique turn UUID",
  "playerId": "white",
  "playerLabel": "White",
  "sideToMove": "white",
  "moveNumber": 12,
  "state": {
    "fen": "current FEN",
    "side_to_move": "white",
    "move_number": 12,
    "status": "active",
    "legal_moves_uci": ["e2e4", "g1f3"]
  },
  "legalActions": [
    { "type": "move", "payload": { "move": "e2e4" } },
    { "type": "resign", "payload": {} }
  ],
  "actionSchema": {
    "type": "object",
    "required": ["type", "payload"],
    "additionalProperties": false,
    "properties": {
      "type": { "type": "string", "enum": ["move", "resign"] },
      "payload": { "anyOf": [
        { "type": "object", "required": ["move"], "additionalProperties": false, "properties": { "move": { "type": "string", "enum": ["e2e4", "g1f3"] } } },
        { "type": "object", "required": [], "additionalProperties": false, "properties": {} }
      ] }
    }
  },
  "history": [{ "ply": 1, "color": "white", "san": "e4", "uci": "e2e4" }],
  "clock": { "turnTimeoutMs": 120000 },
  "status": "active"
}
```

`history` is complete from the beginning of the game. `state.fen` and `legalActions` are authoritative for the current turn. UCI coordinate notation is used for moves, including promotion suffixes such as `e7e8q`; SAN is retained for display and PGN. This is not the UCI engine process protocol.

When retrying, the controller sends the same position and legal actions with a `feedback` field describing the rejected action. This keeps correction bounded and does not silently fix, guess or repair a move.

## Action v1

Return exactly one JSON object and no surrounding text:

```json
{"type":"move","payload":{"move":"e2e4"}}
```

Or resign:

```json
{"type":"resign","payload":{}}
```

The parser rejects prose, markdown, trailing content, missing fields and non-object payloads. The game implementation then checks that the action type, current player, payload and move are legal. Any CLI tool call is also rejected for this push-observation contract; agents should return the action directly.

## Errors, retries and timeouts

- Per-move timeout is configurable from 30 to 600 seconds in the current UI. Both the controller and CLI adapter enforce it.
- A malformed, illegal or timed-out action receives one retry with an explicit feedback reason and the same board position.
- Retry exhaustion records a forfeit and a winner. A crashed CLI or authentication/provider error marks the match `error` without awarding a win.
- Pause stops the active process and preserves the current position; resume starts a fresh request for that same player. Stop ends the match.
- Adapter output is capped at 256 KB. Processes run in unique temporary working directories and are killed as a process group on timeout or shutdown.

## CLI adapters

- **Codex CLI:** `codex exec` with the selected model, ephemeral session, read-only sandbox, `-c approval_policy="never"`, JSONL events and a JSON Schema-constrained final action file. Optional reasoning effort is passed as `model_reasoning_effort`; accepted values depend on the selected model (the CLI default is safest when uncertain).
- **Claude Code:** `claude --print` with the selected model, JSON output/schema, `dontAsk`, no session persistence, no built-in tools and strict MCP config.
- **OpenCode:** `opencode run --format json --pure --agent agent-battle` with an isolated turn directory and a per-invocation primary agent that denies all built-in and custom tools, including MCP tools. See [OpenCode agent tool permissions](https://opencode.ai/docs/agents) for the wildcard permission behavior this relies on.

The user authenticates each CLI separately before starting a match. Agent Battle passes no API key arguments, never stores credentials and does not call model endpoints directly. Optional model/reasoning values are passed as separate CLI arguments, not shell text. Blank model fields use each CLI's own configured default.

The action schema keeps a root object and uses a nested `anyOf` for move payload versus empty resignation payload. The controller remains authoritative for the relationship between the action type and payload and rejects mismatched combinations. This format works with Codex's strict response-schema subset.

CLI processes run as the local user. Their turn directories isolate temporary action files; they are not OS-level user isolation. Codex runs with its read-only sandbox, and Claude Code/OpenCode have tool use disabled for the match agent. If a deployment needs a hard boundary around local files or credentials, run the app and CLIs under a dedicated OS account or sandbox.

The contract leaves room for a second adapter style that calls a local model/API or uses a small MCP surface (`get_game_state`, `get_legal_moves`, `make_move`, `resign`). Such an adapter must still return a generic `GameAction` and must not bypass the controller's validation/application path.
