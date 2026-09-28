# Game source audit

Reviewed on 2026-09-27 against each upstream default-branch commit and GitHub license metadata. Agent Battle's Battleship rules and tests were written for this repository; **no third-party game source, tests, assets, or UI were copied or ported**. These projects informed the rules and future integration notes only. A repository README's license statement alone was not treated as a license grant.

| Repository | Reviewed commit | Verified license | Use | Notes |
| --- | --- | --- | --- | --- |
| [AnthonyMazzie/Battleship](https://github.com/AnthonyMazzie/Battleship) | `c8eb40315bd3e92eadf93a415c43f5849f2980e5` | MIT | Concepts only | Reviewed `context/GameContext.tsx`, `src/app/components/Utility.ts`, types and tests for conventional 10×10 fleet, attacks, sunk ships and win condition. Agent Battle uses a single atomic placement action and private benchmark projection instead of its Next.js app. |
| [scc416/battleship](https://github.com/scc416/battleship) | `add5b7a9cc47f00d436dc91955735408978a4ca6` | MIT | Concepts only | Two-player hidden boards and turn phases; no Socket.IO code used. |
| [PyBro-JHU/Clue-Less](https://github.com/PyBro-JHU/Clue-Less) | `da1aeeaaca67c5dab984bd04d1f487d84e969332` | Apache-2.0 | Future G4 reference only | Model/game-engine/test structure. No Clue-like game implemented here. |
| [amenhany/cluedo-game](https://github.com/amenhany/cluedo-game) | `a4a72d64e7a8411d37c543cc998bfcb5312ca637` | No explicit license verified | Reference only | No code, tests, or assets may be copied without a verified grant. |
| [Jai0401/ai-mafia](https://github.com/Jai0401/ai-mafia) | `491e5aba0fbcf3bfab186d9286888442e0b3df9f` | No explicit license file verified | Future social deduction research only | README mentions MIT, but the grant was not confirmed. No source used. |
| [so-litude/wolf](https://github.com/so-litude/wolf) | `2092bd1e7303592518a2fa790b41774251d7d89f` | Apache-2.0 | Future social deduction research only | Phase and spectator concepts; no source used. |
| [hannahrobot/amongus-tutorial](https://github.com/hannahrobot/amongus-tutorial) | `557210f8c1be61e0fcec41d50b6a5cc9d92fe512` | MIT | Reference only | Literal movement is outside the planned social deduction benchmark. |

The Agent Battle Battleship implementation differs from typical recreational versions in its explicit structured action schema, one-call complete fleet placement, no extra turn on a hit, no random fleet placement, event-time masked replay, and strict series model/tool qualification. Source status should be rechecked before any future material port.


## Hangman shared-board update (2026-09-28 UTC)

| Candidate | Exact version | License / language | Maturity, tests, architecture | Reuse decision and risk |
| --- | --- | --- | --- | --- |
| [safe-word-list](https://github.com/nkzw-tech/safe-word-list) | npm `@nkzw/safe-word-list@3.1.2` (existing pinned dependency) | MIT / JS data | Existing corpus filter, hash and deterministic-selection tests in Agent Battle | **A: depend now**, unchanged. Reuse corpus and existing selection; no new server or provider layer. |
| [argonlaser/hangman-game](https://github.com/argonlaser/hangman-game/tree/2e6b35b7ce16e46b35ad4ed65cabc94710ad2bdf) | `2e6b35b7ce16e46b35ad4ed65cabc94710ad2bdf`, package 1.0.6 | MIT (LICENSE at pinned commit verified) / JavaScript | Last repository push 2017-10-04; Mocha/Chai tests and CI config present (not run). CLI UI, Hangman class, local high-score store, word data; legacy dependency versions. | **C: reference only.** Letter/mask rules are available, but it is single-player and does not supply shared-score adversarial rules, private projections or durable versioned replay. Importing its CLI/high-score authority would overlap the arena. No code, tests or word assets copied. |

The smallest useful units already in Agent Battle are reused: the pinned corpus, deterministic generator, structured action envelope/schema, redaction/labels, controller, adapters, replay contract and store. The new code is the shared-board scoring/observation rule variant and its renderer. No outside app stack or new dependency was imported. Expected integration scope: a ruleset adapter plus version-aware lookup and UI, not a second match framework. Primary risk is replay/series compatibility; legacy versions stay explicitly addressable and new tests cover shared observations, scoring, forged state, old-version lookup and role balance.

## Reuse map scope and outstanding research

The tables above document reviewed candidates, not a completed audit of every future environment. **A** means use/adapt now, **B** means a strong future candidate pending integration qualification, **C** means reference only, and **D** means reject for the proposed use. A repository being public is not a license grant.

For the current Hangman update, the corpus and arena controller, provider, replay and persistence mechanisms already existed; original work is limited to the shared-board rule variant, exact-version routing and its interface. The interface refresh introduces no external application stack or new dependency. Legacy replay compatibility and provider-reported identity remain the primary integration risks.

Poker, Mastermind, Liar's Dice, 20 Questions, Tetris, Snake, geography, negotiation and procedural environments still require their dedicated source audits before roadmap commitments. OpenSpiel, Ludii, PettingZoo, boardgame.io, TextWorld, MiniGrid and Melting Pot have not been qualified by this Hangman change. Future reviews must record repository URL, exact version, LICENSE/COPYING/NOTICE evidence, language, activity, tests, architecture, reusable unit, unsuitable pieces, effort and integration risk. Distinguish code/test ports from conceptual references and avoid importing a second server, store, controller or provider abstraction merely to access mechanics.

## Research-series foundation (2026-09-28)

This change reuses Agent Battle's existing two Hangman engines and `@nkzw/safe-word-list@3.1.2`. The block scheduler, declaration validator, metadata checks, bootstrap analysis and fixed letter-order control are original code; no external engine or application architecture is imported and no dependency is added. Existing license findings above remain dated to their reviewed revisions, not asserted as current upstream status.

The implemented first study tests ruleset sensitivity before admitting more environments. Broader frameworks and future deduction/social mechanics remain integration candidates, not approved dependencies. Before a port, verify the exact LICENSE/NOTICE and revision, run upstream tests where feasible, and document the smallest reusable mechanics unit. Agent Battle retains observations, privacy, provider invocation, telemetry, persistence and experiment ownership. See [research gates and handoff](RESEARCH_PROTOCOL.md#research-gates-and-coding-agent-handoff).
