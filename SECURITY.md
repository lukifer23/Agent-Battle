# Security

## Trust boundary

Agent Battle is a single-user, loopback-only local application. It binds to
`127.0.0.1` and is not designed for remote access or multi-user deployment.

- The browser is a spectator and control surface only. It cannot submit moves.
- The controller and game definition own and validate all game state.
- Agent CLIs run as the current local user. Their temporary working directories
  isolate per-turn files; they are not operating-system user isolation.
- Provider configuration changes are scoped to each arena invocation. Agent
  Battle does not persist credentials or send them as CLI arguments. An allowlist
  forwards supported credential environment variables to the child CLI, which
  also retains access to its normal authentication locations.
- Match history and bounded provider diagnostics are stored locally under
  `data/`, which is excluded from version control. On Unix the data directory
  is mode `0700`. The database, its `-wal` and `-shm` files, migration backups,
  and recovery candidates are mode `0600`. A chmod failure refuses startup.
  These modes limit access to the file owner. They are not encryption, and they
  are not operating-system isolation of the agent CLI.
- Persisted rows are validated on load. A malformed match or a series whose
  slots disagree with the linked matches is quarantined. `record_json` is left
  unchanged. An interrupted provider request stays uncertain: recovery does not
  invent a response, and a later request uses a new invocation id. Possible
  duplicate billing stays visible.

## Hidden state and provider execution

Shared-board Hangman intentionally exposes opponent letter outcomes and scores, but keeps the word and seed private until terminal. Independent Hangman lanes, including new research controls, retain their separate observation boundary. Battleship hides untouched opponent fleet cells until terminal. Historical replay frames preserve their original masks, and public action labels redact full solutions and placements.

Claude Code safe mode, explicit tool/hook/settings restrictions and no session persistence retain the user's existing CLI authentication. Codex uses ephemeral requests, ignores user configuration/rules and runs read-only, but remains unqualified for no-tools scored series. CLI policy and fresh temporary directories do not provide OS-user isolation. Unknown model identity is not silently treated as verified.

## Reporting a vulnerability

Report suspected vulnerabilities through the repository's private GitHub
security advisory form:

https://github.com/lukifer23/Agent-Battle/security/advisories/new

Do not open a public issue for a security report. Include reproduction steps and
the affected version or commit. There is no guaranteed response time for this
local, single-maintainer project.

## Scope notes

- Do not test against systems or accounts you do not own.
- Provider authentication and billing are governed by each provider, not by
  Agent Battle.
- Because the app is loopback-only, some local-network browser protections may
  not apply; treat any host or origin that can reach the loopback port as
  untrusted and report gaps in control-endpoint validation.

## Research declarations and exports

Research v3 stores private challenge roots locally and publishes commitments plus projected execution metadata. Completed exports reveal reproducibility roots. The built-in pilot uses a public root: hiding it from an active UI is not protection from contamination. Declaration/profile hashes detect inconsistency but do not authenticate a provider, resist a local user rewriting records, or constitute independent preregistration.

Research qualification fails closed on unknown/incomplete streams, conflicting model/session evidence, missing external-tool inventory, and session reuse across recorded requests. Requested reasoning remains distinct from effective reasoning. Public metadata does not contain private observation hashes or assistant reasoning. Avoid exposing raw stores, diagnostics, credentials or unfinished private suites when sharing results.
