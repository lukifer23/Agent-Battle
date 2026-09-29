# Changelog

All notable changes to this project are documented here. This project is in
early development and does not yet follow a released versioning scheme.

## Unreleased

### Experimental harness (2026-09-29)

- Require Node.js 22.13 or newer. CI runs Node 22 and 24. Startup exits when `node:sqlite` is unavailable.
- Validate durable match and series rows on load. Quarantine a malformed record or a series whose slots, agents, challenge, research assignment, or completion state disagree with the linked matches. Leave `record_json` unchanged.
- Record one legacy-import receipt per source hash. An empty or series-only import does not repeat. A later change to the original JSON is not merged.
- Project the invocation ledger from the match checkpoint. A provider process starts only after the pending attempt and its reservation are committed. Interrupted attempts stay uncertain; recovery does not invent a provider response.
- Persist series retry intent and save only the series that changed. History, events, and session identity use the SQLite indexes. `/api/state` stays a bounded snapshot. Complete durable events remain available to the events API and series export.
- Freeze a research execution profile at series start. Drift in CLI version, restrictions, adapter, or protocol is a qualification failure. Same-system controls compare provider, model, and reasoning together.
- Add read-time scorecards that separate outcome, termination, qualification, resource coverage, and versioned per-game metrics. Protocol forfeits stay scored and are labeled separately from resignation and provider failure. Research v3 primary analysis is unchanged.
- Publish `observation-contract-v4`: chess `chess-observation-v3` and Battleship `battleship-observation-2` keep a single legal-action list; independent Hangman `hangman-observation-v2` counts ply inside the current lane; Claude and Codex prompts leave `actionSchema` to the CLI schema argument.
- Record offline seat measurements for the current rules: independent identical policies draw; shared-board frequency versus alphabetical is seat-sensitive; identical Battleship fleets give the first shooter the win. These are harness controls.
- Verify 190 offline tests on this machine. No paid provider calls.

### Durable SQLite store (2026-09-29)

- Replace the whole-archive JSON rewrite with a local SQLite store in WAL mode (`node:sqlite`, no third-party dependency). A match checkpoint now touches one record instead of serializing the entire history, so checkpoint cost no longer scales with the archive.
- Import the legacy store version 7 (and supported older envelopes) into the durable store once, in a single transaction, with an immutable migration backup plus SHA-256 manifest and per-record quarantine. The original `matches.json` is never modified or deleted.
- Retain durable domain events in full. The in-memory record still projects a bounded presentation window; the durable log is complete.
- Add indexed history queries (game, game version, provider, model, status, series, result, date) behind the repository so standings and history no longer depend on the 50-summary snapshot.
- Centralize adapter/observation/action/store/schema version constants in `src/version.ts` to prevent documentation drift.
- Log snapshot publication failures instead of discarding them.
- Make the match run lifecycle explicit: `pause`/`stop` resolve only after the run loop has actually stopped, and a stop is never downgraded by a later pause.
- Add deterministic persistence fault-injection tests: interrupted import rolls back atomically and preserves the legacy source, a failed checkpoint keeps the previous durable revision, import is idempotent, and a SIGKILL after a durable match creation reloads it without duplication.
- Verify 170 tests (154 prior, plus durable-store, fault-injection and lifecycle regressions), lint, typecheck, build. `npm run benchmark -- --large` now reports the durable checkpoint beside the JSON rewrite: at 1,000 archived records the JSON write is ~458 ms median / ~601 ms p95 while the durable per-record checkpoint stays flat at ~1.6 ms.

### Registered research foundation (2026-09-28)

- Add `battle-series-3` frozen condition declarations, deterministic matched challenge blocks, seat balancing, plan/root commitments and labeled same-model controls.
- Make both Hangman rulesets selectable and add the 24-word, 144-match construct-sensitivity pilot. Registration saves a study for review before provider execution.
- Add first-attempt paired analysis, block-bootstrap intervals and all-planned-slot missing-outcome bounds. Retain infrastructure reruns separately; do not pool research conditions into an intelligence score.
- Add adapter v6 execution metadata, an environment allowlist, conservative stream/model/tool checks, and fresh-session validation across requests and matches. Historical evidence remains unchanged.
- Add store 7 research assignment validation and migration compatibility, research API/UI/export support, and offline preparation/letter-policy control commands without new runtime dependencies.
- Verify 154 tests, lint, typecheck, build, and the standard harness benchmark locally. Complete 144 offline control games with zero provider calls. No live model pilot, adaptation or multi-party implementation is claimed.
- Synchronize public documentation around implemented research behavior, historical acceptance and future research gates.

### Earlier changes

- Clear connection warnings automatically after reconnecting; keep new-match launch disabled while disconnected and preserve genuine command errors.

- Keep new-match setup above the board in every game and preserve the user's model choices when reopening it; show model-named Chess and Battleship winners.
- Include current Claude Opus, Sonnet, and Haiku suggestions even with empty match history; preserve custom IDs and reset custom-entry mode when switching CLIs.
- Require distinct explicit models for every game; reject CLI-default display placeholders and expose per-request execution evidence in the arena.
- Read Claude tool inventory, external tool events, exact model identity and session IDs from its stream. Preserve usage and identity on structured nonzero exits without retaining raw assistant streams.
- Fix reproduced Claude chess output-envelope retries and Battleship strict-validator failures caused by missing coordinate string types.
- Qualify protocol failures before series scoring and pause unqualified terminal slots for retry/skip; keep incomplete or unqualified suites out of overall performance. Export all projected series events and match provenance.
- Retain historical results while excluding records without complete per-request comparison evidence from comparative standings.

- Added shared-board competitive Hangman with alternating guesses, per-position points, completion bonuses and shared misses; preserved independent-lane records under their original ruleset.
- Made game lookup version-aware across creation, restore, projection and series; shared-board series balance seats with the same word for each role-swapped pair.
- Rebuilt Hangman setup and results with a light theme, model dropdowns and custom IDs, explicit thinking effort, visible new-match controls, and expandable diagnostics. Changing CLI replaces the previous CLI's model.
- Fixed the blank Hangman page caused by a live update arriving without a current player; added a rendering regression and verified a real browser-started cross-provider match through completion.
- Preserved Claude Code OAuth authentication while disabling invocation customizations through safe mode; added a concise Hangman prompt and casual low/disabled-thinking defaults. Missing Codex resolved identity remains unverified.
- Updated rules, architecture, protocol, contributor guidance, security boundaries, source audit and handoff documentation for the shared-board implementation and browser verification.

- Rolled back in-memory battle-series start, pause, stop, retry, and skip changes when their checkpoint fails; a failed retry no longer leaves a hidden retry marker.
- Stopped treating a terminal game with no authoritative derived result as a draw; the controller now records an unscored error.
- Fixed event pagination after event 500; the endpoint now projects the requested historical slice directly.
- Included every retried series attempt in request, latency, usage, cost, and unscored totals while keeping the final scored result attached to its slot.
- Raised fresh-match action and request defaults to 250 and 500: a legal Battleship contest can require 201 accepted actions before its terminal result.
- Applied verified distinct-model requirements to Chess and Battleship comparative standings as well as Hangman; casual game results remain in history.

- Added `battleship-standard-1`: atomic fleet placement, alternating shots, deterministic terminal result, private player observations, masked public replay, terminal fleet reveal, and replay-validated persistence.
- Added `battle-series-2` plans for registered two-player games, configurable repetitions, seat-aware strict mode, deterministic challenge schedules, normalized per-family/overall performance, completed reproducibility manifests, and UI rerun.
- Kept `battle-series-1` records and exports readable without destructive conversion; store version 6 migrates with a backup.
- Preserved real provider telemetry on strict model/tool qualification failure; conservatively charges crash-interrupted provider reservations to player time budgets.
- Rejected Hangman mirror comparisons with blank or identical requested model IDs; older and unresolved-identity results remain visible as unverified history.
- Added Battleship and series setup UI, benchmark-scale storage measurements, source audit, notices, and rules documentation.

- Added 5/10/30/60-minute and custom active-play time controls for new matches, with durable pause/restart accounting, an in-flight cutoff, and scoreboard separation by time control. Older records retain their prior creation-age limit.
- F1.1: accepted chess actions now commit canonical state, telemetry and event evidence together; retry exhaustion commits the forfeit with its invalid-attempt evidence. Serialized chess snapshots are detached, and presentation events no longer force a full-store write. Crash-boundary reload regressions pass without provider calls.
- Focused storage durability and recovery repair: transitions commit before
  publication, concurrent store ownership is atomic, unsupported roots stop
  startup, and quarantine or write failure is visible to the UI.

- Initial public baseline of the local Agent Battle chess arena: authoritative
  controller and chess.js rules engine, Codex/Claude Code/OpenCode CLI adapters,
  loopback Express API with an SSE event feed, JSON persistence, and a React
  spectator and control UI with replay and scoreboard.
- Documented product scope, run/check commands, architecture, agent protocol,
  local trust boundary, and contribution workflow.
- Strict lowercase action contract and game-agnostic state advancement.
- Single cancellable process runner with process-group cleanup and correct
  Codex/Claude/OpenCode envelope parsing.
- Explicit lifecycle transitions, saved pending-turn feedback, and spawn-free stop.
- Validated versioned store with quarantine, backup, single-writer lock, and
  graceful shutdown.
- One projector for snapshots with revisions, ordered SSE events, and a hardened
  local API.
- Resource budget settings, partial usage coverage, and requested competitor identity.
- Transport projections, paginated API history, and preliminary measurement tooling.
- Replay, board, export, and accessibility improvements.
- Added independent-lane Hangman, private word provenance, sealed early solves, deterministic scoring, replay, and public JSON records.
- Replaced match-list record spreading with an explicit summary DTO; public APIs and events project hidden state safely.
- Added durable invocation reservations, retry budget checks, private failed-write recovery candidates, and stale-snapshot rejection.
- Moved game validity behind the registry and added store version 4 for invocation identity and deadline metadata.
