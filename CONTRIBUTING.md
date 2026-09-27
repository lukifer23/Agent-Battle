# Contributing

Agent Battle is a local-first project. Contributions are made directly on the
`main` branch; there is no feature-branch or pull-request workflow.

## Before you start

- Node.js 20.19 or newer and npm are required.
- At least one supported agent CLI (Codex, Claude Code, OpenCode) must be
  installed and authenticated to run a real match. Tests do not require any CLI
  and never make paid model requests.

## Local checks

Run all of these before committing:

```sh
npm ci
npm test
npm run lint
npm run typecheck
npm run build
```

The test suite uses deterministic local fixtures and fake CLI executables. It
must not invoke authenticated model providers.

## Guidelines

- Keep the backend authoritative: agents propose actions, the controller and
  game definition validate and apply them, and the browser only spectates and
  controls.
- Preserve strict action validation, nullable usage fields, and real provider
  paths. Do not add production stubs, fake agents, fabricated metrics, or silent
  fallback moves.
- Configuration changes for providers must be scoped to each arena invocation.
  Do not change global CLI defaults, credentials, or user plugins.
- Use plain text and SVG. Do not add emojis to code, comments, documentation, or
  commit messages.
- Never commit credentials, the local `data/` directory, or private diagnostics.

## Commit style

Write short, factual, imperative commit messages on `main`. Do not force-push.
