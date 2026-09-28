# Agent Battle handoff

## Current state

Agent Battle has authoritative Chess (`standard-1`), independent-lane Hangman (`independent-lanes-1`), and Battleship (`battleship-standard-1`). Each runs through the same two-player controller, registry, public/private projection, persistence, provider protocol, replay, and JSON export. Battleship has a dedicated responsive public arena. Series v2 schedules registered game families through a versioned plan; historical `battle-series-1` records and exports retain their ten-slot shape and validation. Store version 6 backs up supported older envelopes before migration.

## Experiment behavior

Quick: 2 Chess, 2 Hangman, 2 Battleship (exploratory). Standard: 6 Chess, 5 Hangman, 6 Battleship (strict seat balance for Chess/Battleship). Custom: selected game counts with strict or exploratory mode. Roles alternate within a game family. Hangman challenges derive from a private series root and pair both agents within each match. The root seed and future challenge seeds remain private until completion; the completed v2 export has a reproducibility manifest. Rerun exact configuration starts a new schedule from that manifest. Agent choices and provider outputs remain nondeterministic.

Per family: win 1, draw ½, loss 0; performance = points / scored possible points. Overall performance is the mean of scored family performance values, with explicit positive weights if configured. Raw W/D/L, unscored trials, role distribution, requests, latency, token/cost totals and per-metric coverage are retained. Unscored provider/qualification/budget failures are not losses. A failed slot pauses the series for retry or skip.

## Privacy and authority

Battleship placements are canonical private state and private player observations only. Before terminal, public transport exposes shots, hit/miss/sunk outcomes, placement completion, and phase but no untouched fleet cells. Terminal reveals both fleets; historical replay frames remain masked. Hangman lanes retain their own observation boundary and seal an early solve. Saved Hangman matches with missing or mismatched resolved model identity are marked unverified and excluded from comparative standings; their raw game result is retained. Public labels redact full-word submissions and Battleship fleet coordinates. All saved hidden-game state is replay-validated; forged derived state or results are quarantined.

Request reservations persist before spawn. Interrupted reservations conservatively charge reserved player provider time through their deadline without fabricating provider-reported latency. A real reply that fails model/tool qualification still retains its actual usage, latency, tool metadata, and reported identity.

## Verification and limits

Run `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run benchmark`. `npm run benchmark -- --large` measures 500/1000 synthetic records locally. On the 2026-09-27 review machine the mixed Chess/Battleship fixture measured 339.4 MB at 1000 records, 480 ms median / 614 ms maximum-of-five write, and 439 ms JSON parse. These are synthetic, machine-specific measurements, not a throughput guarantee. Tests use deterministic fixtures, including a three-game v2 series and HTTP/SSE privacy checks, and make no paid provider calls. A live provider qualification pass and paid usage verification remain separate acceptance gates. The recent scoreboard is bounded to the snapshot history window, not a lifetime tournament ledger. The JSON store still rewrites in full at each durable checkpoint. Provider isolation is CLI policy rather than OS-user isolation. Codex CLI lacks qualified no-tools parity for scored series; Claude Code and OpenCode have per-invocation no-tools policies but real-model qualification still requires observed resolved identity and zero tools.

## Next packages

**G4 — Deduction Manor:** design a hidden-evidence deduction game using [PyBro-JHU/Clue-Less](GAME_SOURCES.md) as a licensed conceptual reference. Focus on evidence, elimination, and accusation rather than dice or walking. Do not implement it in this package.

**Multi-participant controller:** generalize the historical two-seat tuple toward game-defined participant counts while preserving old records. This is a prerequisite for multi-party social deduction.

**G5 — Social Deduction:** after multi-participant support, design phased private roles, discussion, voting, belief updates and objective faction outcomes. Review source licenses again; `Jai0401/ai-mafia` remains reference-only without a verified grant, while `so-litude/wolf` has Apache-2.0 metadata. Do not implement literal Among Us movement.

See [Battleship rules](BATTLESHIP.md), [game source audit](GAME_SOURCES.md), and [architecture](ARCHITECTURE.md).
