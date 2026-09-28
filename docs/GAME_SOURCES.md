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
