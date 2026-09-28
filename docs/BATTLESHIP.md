# Battleship standard-1

Battleship is the third Agent Battle environment. It measures hidden spatial search, memory, information gain and adaptive targeting. It does not test bluffing or communication.

## Rules

Two players use a 10×10 board with canonical lowercase coordinates `a1` through `j10`. Each places Carrier (5), Battleship (4), Cruiser (3), Submarine (3), and Destroyer (2). Ships are horizontal or vertical, stay on the board, and cannot overlap. Each player submits all five ships in one atomic `place_fleet` action. Player 1 places, then Player 2 places; Player 1 fires first. Players then alternate one `fire` action each, including after hits. Repeated shots are invalid. The first player to hit every cell of the opposing fleet wins. No heuristic adjudication or random fleet placement is used.

```json
{"type":"place_fleet","payload":{"ships":[{"ship":"carrier","start":"a1","orientation":"horizontal"},{"ship":"battleship","start":"a2","orientation":"horizontal"},{"ship":"cruiser","start":"a3","orientation":"horizontal"},{"ship":"submarine","start":"a4","orientation":"horizontal"},{"ship":"destroyer","start":"a5","orientation":"horizontal"}]}}
```

```json
{"type":"fire","payload":{"coordinate":"e7"}}
```

The action envelope has exactly `type` and `payload`; each payload and ship placement has exactly its documented keys. Invalid actions get one correction request. Exhaustion follows the controller's ordinary two-player forfeit policy; provider errors, manual stops, and budget stops are unscored and do not fabricate a game result.

## Information boundaries

Private canonical state contains both fleets, every shot, turn/phase, terminal result, and accepted action history. A player's observation contains its own complete fleet and incoming shots; it sees only its own shots and their hit, miss and sunk outcomes against the opposing fleet. It never receives untouched opponent ship positions. No provider receives the local store path or another player's raw reply.

Before terminal, public HTTP, SSE, event, replay, and JSON projections show placement status, shots, hits/misses, sunk ships, turn and phase. `place_fleet` actions are redacted to `{"type":"place_fleet","payload":{}}`; private placements do not appear in public labels. At terminal the public board reveals both fleet layouts. Historical replay frames keep their original masks. The private store remains the replay authority and rejects forged fleets, shots, turns, sunk status, or terminal results by replaying accepted actions.

## Experiment measures

The objective result is win/loss. Raw secondary measurements can be derived from the action record: shots fired, hits, misses, accuracy, first hit, shots to sink each ship, turns, invalid placement/target requests, retries, latency, tokens, reported cost, and each metric's reporting coverage. No weighted intuition score is assigned. Series v2 alternates the two role assignments; strict plans require an even number of Battleship repetitions. Its fixed public challenge ID is `battleship-standard-1:10x10:5-4-3-3-2`. Models choose fleets, so repeating the same configuration does not force the same learned fleet layout.
