# Contributing

Agent Battle is a local-first project. Changes are proposed on a short-lived
branch and merged to `main` through a pull request; the CI workflow runs tests,
lint, typecheck and build on Node 22 and 24 for every pull request. Do not
force-push shared branches.

## Before you start

- Node.js 22.13 or newer and npm are required. Node 20 cannot load `node:sqlite`.
- At least one supported agent CLI (Codex, Claude Code, OpenCode, or Grok Build) must be
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
npm run benchmark
npm run --silent research -- baseline > /tmp/agent-battle-baseline.json
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

## Game and UI changes

- Keep old rulesets registered by exact version. Test restored records and replay before changing a game's default.
- Test player observations and public projections structurally; random words can coincidentally occur in unrelated labels or identifiers.
- For Hangman, cover shared opponent effects, scoring, terminal and historical masks, provider routing, and live updates without a current player.
- Browser-check setup, model changes, start, live play, completion and replay at desktop and mobile sizes. Real-provider checks require authenticated CLIs and can incur charges; keep them separate from automated tests.
- Research reusable open-source mechanics before adding a major subsystem. Record exact versions and verified licenses in `docs/GAME_SOURCES.md`; preserve attribution in `THIRD_PARTY_NOTICES.md` when copying or distributing third-party work.
- Keep screenshots, process evidence, private plans and real match exports in ignored local directories. Public handoffs should summarize evidence without publishing raw diagnostics.

## Commit style

Write short, factual, imperative commit messages on `main`. Do not force-push.

## Research changes

Read [the research protocol](docs/RESEARCH_PROTOCOL.md) before adding environments or scores. Preserve exact ruleset lookup, frozen declarations, deterministic role/challenge assignments, first-attempt analysis, all planned rows, unknown usage, and the research v3 primary endpoint: first-attempt paired-block win share, missing-outcome bounds, and `paired-block-bootstrap-1`. New metrics stay additive. Tests must cover malformed commitments, assignment drift, missing evidence, session reuse, retry selection and private projections. Do not silently change an existing generator, analysis version, scoring rule, or the primary endpoint.

An evaluated system is the provider, requested model, and requested reasoning together. A same-model control requires equal keys. A system comparison requires unequal keys. Research series freeze one execution profile per agent at start, before any match exists. Later drift in CLI version, restrictions, adapter, observation protocol, or action protocol is a qualification failure and pauses the series. Current prompts use `observation-contract-v4`. Historical fixtures may still store an older prompt version as saved data.

Keep game outcomes, execution qualification and scientific interpretation separate. A fixture agent or offline control must be labeled as such and cannot populate a live-model ranking. Research v3 permits an explicit same-model control without weakening casual-match validation. Include reflection/learning only under a future versioned protocol with leakage and matched-control tests.

Update README, rules/protocol/architecture docs, changelog and handoff together when contracts change. Keep historical acceptance evidence dated, and report only checks actually run for the new change. An offline baseline is not a paid-provider qualification test.
