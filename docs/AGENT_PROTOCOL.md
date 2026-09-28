# Agent turn protocol

## Boundary

The browser is never an agent tool or input source. The match controller builds a versioned observation from the authoritative game state and starts the configured adapter. The adapter supplies that observation to its CLI and returns one structured action. The game checks player identity, turn ownership and legality before it changes state.

Agents do not receive a mutable game object, a filesystem path to the game database, an HTTP endpoint for arbitrary moves, or access to the GUI. A restarted agent can play from the next full observation without earlier conversation history.

## Chess observation v2

The exact fields are defined by `GameObservation` in `src/shared.ts` and built by `ChessGame.observe()`.

```json
{
  "schemaVersion": "chess-observation-v2",
  "gameId": "chess",
  "matchId": "match UUID",
  "turnId": "unique turn UUID",
  "playerId": "white",
  "playerLabel": "White",
  "sideToMove": "white",
  "ply": 23,
  "turnIndex": 23,
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

Both the provider parser and the game boundary enforce the same strict envelope: exactly the two keys `type` and `payload`. Extra top-level keys, array or null payloads, and unknown action types are rejected. Chess move payloads must contain exactly the single key `move`, and the move string must be lowercase UCI (for example `e2e4`, `e7e8q`). Uppercase notation is rejected as a protocol error rather than normalized, so the validated value, the applied move, telemetry and replay all use the same string. Invalid actions are never repaired.

## Errors, retries and timeouts

- Per-move timeout is configurable from 30 to 600 seconds in the current UI. One attempt runner owns the deadline and process cleanup; the controller passes a cancellation signal and waits for the spawned process group to settle before starting another attempt, so a retry cannot overlap a live process.
- A malformed, illegal or timed-out action receives one retry with an explicit feedback reason and the same board position.
- Retry exhaustion records a forfeit and a winner. A crashed CLI or authentication/provider error marks the match `error` without awarding a win. A provider error envelope (for example a Claude `is_error` result) is an execution error, not a forfeit.
- Pause cancels the active attempt and preserves the current position; resume starts a fresh request for that same player. Stop ends the match. Both wait for termination and the saved checkpoint.
- Adapter output is capped at 256 KB, final response files are size-checked before reading, and streams are decoded with a UTF-8 decoder so multibyte characters split across chunks are preserved. Processes run in unique temporary working directories and are terminated as a process group, escalating to SIGKILL even when the group leader has already exited but descendants remain. A descendant that changes its own session/group is outside this boundary; Windows process-group semantics are not qualified.
- Response excerpts and stderr diagnostics are bounded and passed through a central redactor before storage. Redaction is best-effort, not a guarantee; keep diagnostics local.

## CLI adapters

- **Codex CLI:** `codex exec` with the selected model, ephemeral session, read-only sandbox, `-c approval_policy="never"`, JSONL events and a JSON Schema-constrained final action file. Optional reasoning effort is passed as `model_reasoning_effort`; accepted values depend on the selected model (the CLI default is safest when uncertain).
- **Claude Code:** `claude --print --safe-mode` with the selected model, JSON output/schema, `dontAsk`, no session persistence, no built-in tools and strict MCP config. Discovered settings are disabled and explicit settings disable hooks and auto memory. `CLAUDE_CODE_SIMPLE=0` preserves OAuth/keychain authentication: both simple mode and `--bare` disable it in Claude Code 2.1.282. Safe mode suppresses customizations without requiring a separate API key. Unsupported CLI flags fail the request rather than falling back to weaker restrictions. The adapter prefers the documented `structured_output` field and also accepts a documented JSON `result` field; an `is_error`/error-subtype envelope is reported as an execution error.
- **OpenCode:** `opencode run --format json --pure --agent agent-battle` with an isolated turn directory and a per-invocation primary agent that denies all built-in and custom tools, including MCP tools. See [OpenCode agent tool permissions](https://opencode.ai/docs/agents) for the wildcard permission behavior this relies on.

Each adapter processes its provider envelope once and reports usage and tool-call metadata from that single pass. Tool-call counts are `null` when the provider emitted no parseable event stream, rather than being assumed to be zero. Codex inherits the user configuration and can still use read-only tools/MCP; reported tool calls are rejected after the fact, which does not undo a tool's observation or external effect.

The user authenticates each CLI separately before starting a match. Agent Battle passes no API key arguments, never stores credentials and does not call model endpoints directly. Optional model/reasoning values are passed as separate CLI arguments, not shell text. Blank model fields use each CLI's own configured default.

The action schema keeps a root object and uses a nested `anyOf` for move payload versus empty resignation payload. The controller remains authoritative for the relationship between the action type and payload and rejects mismatched combinations. This format works with Codex's strict response-schema subset.

CLI processes run as the local user. Their turn directories isolate temporary action files; they are not OS-level user isolation. Codex runs with its read-only sandbox, and Claude Code/OpenCode have tool use disabled for the match agent. If a deployment needs a hard boundary around local files or credentials, run the app and CLIs under a dedicated OS account or sandbox.

The contract leaves room for a second adapter style that calls a local model/API or uses a small MCP surface (`get_game_state`, `get_legal_moves`, `make_move`, `resign`). Such an adapter must still return a generic `GameAction` and must not bypass the controller's validation/application path.

## Hangman observation and actions

Hangman observations contain only the current player's lane and lane-local counters. Actions are `{"type":"guess_letter","payload":{"letter":"s"}}` or `{"type":"solve","payload":{"word":"example"}}`. Letters must be one lowercase ASCII letter; solutions must be lowercase ASCII and the displayed word length. No extra keys or automatic repair are accepted. Repeated letters use the correction policy. Retry exhaustion forfeits only that lane. See [the rules](HANGMAN.md). Public exports redact solution payloads; private persistence retains authoritative actions.

Game observations use discriminated schemas to pair each action type with its payload. The CLI output-schema guard flattens that union into a root object for provider dialect compatibility. It checks the envelope and payload shapes; the controller then enforces the exact type/payload pairing and game legality. This does not change the direct action protocol or repair invalid responses. Paid-provider acceptance of new schemas remains part of live qualification.

## Battleship observation and actions

`battleship-observation-1` exposes the phase, exact ruleset, board/fleet rules, the player's own full fleet, hits and misses received, the player's shots with hit/miss/sunk outcomes, opponent placement status, and untargeted coordinates. It never includes the untouched opponent fleet. Placement uses one `place_fleet` action listing all five ships exactly once; fire uses one canonical lowercase coordinate. See [Battleship rules and privacy](BATTLESHIP.md) for complete examples and reveal timing. A placement submitted during battle, fire during placement, wrong-player action, repeated shot, extra key, or illegal fleet is rejected with bounded correction feedback. Private placement submissions are redacted in public telemetry and exports.

## Strict series qualification

Series requests require two different explicit requested model IDs. Each returned reply must report the exact requested resolved model and zero tool calls under a qualified no-tools adapter. A reply with unknown/wrong resolved model or observed tools marks the trial unscored and pauses the series. Its actual request count, latency, usage, tool count, and reported identity remain recorded. Provider-reported latency remains separate from conservative controller-accounted time for crash-interrupted reservations. Codex CLI's current invocation flags still do not provide qualified no-tools parity, so Codex remains casual-only for scored series. Fixture tests do not constitute a paid or live-provider qualification.

For shared-board Hangman, Claude uses a concise game system prompt. Reasoning `none` explicitly sets `MAX_THINKING_TOKENS=0`; selectable effort levels set both `--effort` and `CLAUDE_CODE_EFFORT_LEVEL` so inherited environment settings cannot silently override the selected level. Some models cannot disable thinking; this is provider-dependent. Codex JSONL is parsed for resolved identity when present; missing identity is never inferred from the requested model flag.
