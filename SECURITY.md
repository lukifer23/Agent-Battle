# Security

## Trust boundary

Agent Battle is a single-user, loopback-only local application. It binds to
`127.0.0.1` and is not designed for remote access or multi-user deployment.

- The browser is a spectator and control surface only. It cannot submit moves.
- The controller and game definition own and validate all game state.
- Agent CLIs run as the current local user. Their temporary working directories
  isolate per-turn files; they are not operating-system user isolation.
- Provider configuration changes are scoped to each arena invocation. Agent
  Battle does not read, store, or transmit CLI credentials.
- Match history and bounded provider diagnostics are stored locally under
  `data/`, which is excluded from version control.

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
