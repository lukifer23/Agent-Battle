# Agent Battle handoff

## Current state

Agent Battle has authoritative Chess (`standard-1`), both Hangman modes (`shared-board-2` and `independent-lanes-1`), and Battleship (`battleship-standard-1`). Each runs through the same two-player controller, registry, public/private projection, persistence, provider protocol, replay, and JSON export. Battleship has a dedicated responsive public arena. Series v2 schedules registered game families through a versioned plan; research v3 adds frozen condition declarations, paired blocks, same-model controls and first-attempt analysis; historical `battle-series-1` records and exports retain their ten-slot shape and validation. Persistence is a local SQLite store in WAL mode: a checkpoint writes one record rather than the whole archive, durable domain events are retained in full, and a legacy store version 7 is imported once with a backup and SHA-256 manifest. Store version 7 import backs up supported older envelopes before migration.

## Current harness acceptance (2026-09-29)

The local offline suite is **190 tests**, plus lint, typecheck, and the storage benchmark. Node.js 22.13+ is the supported runtime because the store uses built-in `node:sqlite`. Startup rejects older Node. CI is declared for Node 22 and 24. Durable rows are validated on load; a bad match or a relationally inconsistent series is quarantined and its `record_json` is left unchanged. Import is one receipt per source hash, including an empty or series-only legacy file. A changed legacy file is not merged. Provider attempts are reserved in the invocation ledger before spawn. Research series freeze an execution profile at start. Scorecards separate outcome, termination, qualification, resources, and versioned game metrics; the research v3 primary endpoint is unchanged. `observation-contract-v4` removes duplicated chess move lists and Battleship target lists. Startup validates every accepted row and keeps only active or series-linked matches resident: 1,100 stopped chess records hydrated in about 28 ms on this machine and returned no resident matches. A live-model pilot and a fresh browser pass of the spectator have not been repeated for this package.

## Research acceptance (2026-09-28)

The checks recorded then passed **154 tests**, lint, typecheck, production build and the standard storage/projection benchmark. New tests cover the 144-slot schedule, 24 distinct word blocks, commitment/assignment tampering, same-model labels, first-attempt missingness, session reuse, retry limits, real controller/store round trips, and HTTP registration without provider invocation. The full offline letter-order control completed 144 matches with zero model requests. Its small exploratory contrast is documented in the protocol and is not a model result. Research UI browser acceptance and a live-model pilot have not been performed for this package.

Research v3 is ready to register and inspect through **Battle series → RESEARCH**. Its defaults are whole-match budgets with equal participant limits. Registration is separate from start; infrastructure reruns cannot overwrite the primary observation. Store 7 backs up supported older data on migration. No production history is rewritten by the tests or offline control.

The harness freezes an execution profile when a research series starts, before any match exists, and refuses that start unless exact model, session, complete stream, tool inventory, tool-use detection, and isolation evidence are declared. Claude declares that contract. The remaining operational step is a live Claude pilot under an explicit budget, then a browser check of the spectator and research UI at desktop and narrow widths. After that, inspect failures, cost, and construct confounds before deciding which P1 ablations add information. Adaptation, human reference performance, procedural novelty and multi-party environments remain unimplemented. The [protocol and prioritized handoff](RESEARCH_PROTOCOL.md#research-gates-and-coding-agent-handoff) defines their dependencies and acceptance gates. Do not treat historical smoke runs below as research-v3 qualification.

## V2 tournament behavior

Quick: 2 Chess, 2 Hangman, 2 Battleship (exploratory). Standard: 6 Chess, 6 Hangman, 6 Battleship (strict seat balance). Custom: selected game counts with strict or exploratory mode. Roles alternate within a game family. Shared-board Hangman challenges derive from a private series root; each role-swapped pair reuses its word. Legacy lane series keep their old seed schedule. The root seed and future challenge seeds remain private until completion; the completed v2 export has a reproducibility manifest. For v2, Rerun exact configuration starts a new schedule from that manifest; research v3 reruns register for review before starting. Agent choices and provider outputs remain nondeterministic.

Per family: win 1, draw ½, loss 0; performance = points / scored possible points. Overall performance is the mean of family performance values, with explicit positive weights if configured, and is withheld until every planned trial is qualified and scored. Raw W/D/L, unscored trials, role distribution, requests, latency, token/cost totals and per-metric coverage are retained. Unscored provider/qualification/budget failures are not losses. A failed slot pauses the series for retry or skip.

## Privacy and authority

Battleship placements are canonical private state and private player observations only. Before terminal, public transport exposes shots, hit/miss/sunk outcomes, placement completion, and phase but no untouched fleet cells. Terminal reveals both fleets; historical replay frames remain masked. New Hangman contests expose the shared pattern, scores and opponent letter outcomes to both agents while hiding the secret until terminal. Legacy Hangman lanes retain their own observation boundary and seal an early solve. Saved matches without complete per-request identity and no-tools evidence for both players are marked unranked and excluded from comparative standings; their raw game result is retained. Public labels redact full-word submissions and Battleship fleet coordinates. All saved hidden-game state is replay-validated; forged derived state or results are quarantined.

Request reservations persist before spawn. Interrupted reservations conservatively charge reserved player provider time through their deadline without fabricating provider-reported latency. A real reply that fails model/tool qualification still retains its actual usage, latency, tool metadata, and reported identity.

## Verification and limits

Run `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run benchmark`. On 2026-09-29 the default benchmark, which does not pass `--large`, measured a durable checkpoint of one fat record near 1.7–1.9 ms at archive sizes 10, 50, and 100. Validating 1,100 stopped chess records took about 28 ms and left no resident matches. `npm run benchmark -- --large` adds a 10,000-record case; that case was not run for this package. The 2026-09-27 review measured a mixed Chess/Battleship JSON fixture at 339.4 MB for 1,000 records, 480 ms median / 614 ms maximum-of-five write, and 439 ms JSON parse. Those JSON figures describe the retired whole-archive rewrite. All of these numbers are synthetic and machine-specific, not a throughput guarantee. Tests use deterministic fixtures, including a three-game v2 series and HTTP/SSE privacy checks, and make no paid provider calls. A live provider qualification pass and paid usage verification remain separate acceptance gates. The recent scoreboard is bounded to the snapshot history window. History queries read SQLite. A durable checkpoint writes the changed match or series. The legacy JSON path remains only as the one-time importer. Provider isolation is CLI policy rather than OS-user isolation. Codex CLI lacks qualified no-tools parity for scored series; Historical v2 uses Claude Code/OpenCode per-invocation policies with observed identity/tool evidence. The research UI currently restricts the pilot to Claude inventory evidence and adds complete-stream and fresh-session requirements; no provider is automatically qualified by installation.

## Historical Hangman acceptance (2026-09-28, before research v3)

The UI now has provider-specific model choices from history, custom IDs, explicit thinking effort, a focused setup, a visible start/new-match flow, a primary winner/score view and a light Hangman theme. Diagnostics and qualification details are expandable. A missing-current-player live update renders a preparing state rather than blanking the page. Legacy records remain addressable by exact version.

Real cross-provider Hangman matches completed with separate Claude Code and Codex subprocesses. The redesigned browser start-to-finish check completed five accepted actions and showed the winner. Desktop, 390px mobile, model validation and replay masking were checked. Codex CLI 0.157.1 did not report its exact resolved model; those games are unranked. This is gameplay acceptance, not a model-strength or cost benchmark. Private screenshots, process evidence and match exports remain under ignored local audit/data directories.

The merged remote fixes preserve paginated historical events, all retry usage in series aggregates, 250-action/500-request defaults, fail-closed missing terminal results, and rollback of failed series control checkpoints. Re-run the checks after integration; historical test counts are not a substitute for the current result.

## Next packages

These are future candidates, not instructions to begin new implementation before completing their source audits and acceptance criteria.

**G4 — Deduction Manor:** design a hidden-evidence deduction game using [PyBro-JHU/Clue-Less](GAME_SOURCES.md) as a licensed conceptual reference. Focus on evidence, elimination, and accusation rather than dice or walking. Do not implement it in this package.

**Multi-participant controller:** generalize the historical two-seat tuple toward game-defined participant counts while preserving old records. This is a prerequisite for multi-party social deduction.

**G5 — Social Deduction:** after multi-participant support, design phased private roles, discussion, voting, belief updates and objective faction outcomes. Review source licenses again; `Jai0401/ai-mafia` remains reference-only without a verified grant, while `so-litude/wolf` has Apache-2.0 metadata. Do not implement literal Among Us movement.

See [Battleship rules](BATTLESHIP.md), [game source audit](GAME_SOURCES.md), and [architecture](ARCHITECTURE.md).


## Parity repair follow-up (2026-09-28)

Adapter v5 reads real Claude tool/session/model evidence, preserves structured nonzero-exit metadata, and uses a transport envelope that fixes reproduced chess structured-output retries. Battleship schemas now satisfy strict string validation. All game setup paths reject blank, placeholder, and duplicate model IDs. Match detail exposes execution evidence; series exports include the full projected event history and provenance. Unknown-identity protocol forfeits cannot score, and incomplete suites do not receive an overall performance percentage.

Do not restart engine-expansion work before live gameplay acceptance. Deterministic fixture tests establish invariants; real model games establish the CLI-to-controller path. Neither establishes equal provider internals or statistically meaningful rankings. Existing histories are preserved without retroactively inventing qualification evidence.

### Live repair acceptance

On 2026-09-28, Claude Code 2.1.282 ran Haiku (`claude-haiku-4-5-20251001`) against Sonnet (`claude-sonnet-5`) through the real adapters:

| Game | Accepted actions | Requests | Outcome |
| --- | ---: | ---: | --- |
| Shared Hangman | 5 | 5 | Haiku, 7–2 |
| Chess | 61 | 61 | Sonnet; Haiku resigned |
| Battleship | 108 | 111 | Sonnet; all opposing ships sunk |

Every request in these three runs recorded the exact requested model, a separate reported provider session, and zero observed external tool calls. Both seats used the same game configuration and requested `none` reasoning; this does not establish equal internal compute. Corrections in Battleship were retained. These are functional smoke tests, not a ranking study; some runs overlapped, so latency must not be compared as a benchmark.

A separate browser-started Sonnet versus Codex Astra Hangman game completed eight accepted actions, including a pause/resume, with replay and new-match navigation checked. It remains unranked because Codex lacks the required isolation/identity evidence. A real Opus request reported `claude-opus-5-5`, and Opus is now offered without prior history. Opening setup preserves the newly chosen model. Chess/Battleship setup stays above the board so New match is discoverable.

Historical parity-repair verification: 145 tests passed; lint, typecheck, production build, and the standard storage/projection benchmark passed. Live records and screenshots remain in ignored local output directories; they are not part of the public source distribution. Private review artifacts remain local; the implemented public protocol is [RESEARCH_PROTOCOL.md](RESEARCH_PROTOCOL.md).

Research foundation: `battle-series-3` now registers condition-level studies with matched blocks, both Hangman rulesets, same-model controls, stronger request evidence, and first-attempt analysis. Read [RESEARCH_PROTOCOL.md](RESEARCH_PROTOCOL.md) before expanding the suite. The 144-match offline control is implemented; live model pilot, adaptation, and multi-party work remain separate research gates.
