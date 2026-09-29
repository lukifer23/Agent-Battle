# Battleship standard-1

Battleship is the third Agent Battle environment. It supports probes of hidden spatial search, information gathering and targeting. Complete observations supply prior shots, so success alone does not establish unaided memory or learning across episodes. It does not test bluffing or communication.

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

Private canonical state contains both fleets, every shot, turn/phase, terminal result, and accepted action history. A player's observation (`battleship-observation-2`) contains its own complete fleet and incoming shots; it sees only its own shots and their hit, miss and sunk outcomes against the opposing fleet. Remaining targets are that observation's legal-action list. It never receives untouched opponent ship positions. No provider receives the local store path or another player's raw reply.

Before terminal, public HTTP, SSE, event, replay, and JSON projections show placement status, shots, hits/misses, sunk ships, turn and phase. `place_fleet` actions are redacted to `{"type":"place_fleet","payload":{}}`; private placements do not appear in public labels. At terminal the public board reveals both fleet layouts. Historical replay frames keep their original masks. The private store remains the replay authority and rejects forged fleets, shots, turns, sunk status, or terminal results by replaying accepted actions.

## Experiment measures

The objective result is win/loss. Public state summarizes each player's accepted shots fired, hits, misses, accuracy, first-hit shot number, sunk ships, and shot number when each ship sank; these are derived from the public shot record. A read-time scorecard (`battleship-metrics-v1`) reports those versioned measurements. It is not a new ruleset and is not part of the research v3 primary endpoint. Invalid placement/target requests, retries, latency, tokens, reported cost, and each metric's reporting coverage remain in match telemetry. No weighted intuition score is assigned. A protocol forfeit is a scored win for the opponent and is labeled separately from a provider or storage failure, which stays unscored. Series v2 alternates the two role assignments; strict plans require an even number of Battleship repetitions. Its fixed public challenge ID is `battleship-standard-1:10x10:5-4-3-3-2`. Models choose fleets, so repeating the same configuration does not force the same learned fleet layout.

## Arena limits and model identity

Fresh-match defaults allow 250 accepted actions and 500 requests: complete placement plus alternating shots can require 201 accepted actions. Lower custom budgets may stop a legal game without a winner. Casual results remain in history, but comparative standings require two distinct requested models with matching reported identities. See [the shared protocol](AGENT_PROTOCOL.md) and [run instructions](../README.md).

## Research status

Battleship remains available in casual games and v2 series; it is not a condition in the Hangman research preset. Fleet placement and search are coupled because opponents choose fleets. A future search-specific diagnostic should hold fleets fixed and match target layouts across systems before attributing differences to inference. Seat balance alone does not remove opponent-layout effects. An offline control placed identical fleets on `a1` through `a5`, horizontal, and fired in scan order. Over 24 seeds the first seat won every game (first-seat share 1). That measurement is a seat control in [the research protocol](RESEARCH_PROTOCOL.md). It is not a registered ruleset and not a strength baseline. Research v3 can declare registered two-player conditions, but a fixed challenge ID is not evidence of independent challenge samples.
