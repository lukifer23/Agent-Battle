# Hangman

## Current rules: shared-board-2

New matches are direct contests on **one shared board**. Players alternate after every accepted action. Both observe the same pattern, guessed letters, shared miss count, both scores, and action outcomes with player identity. A letter guessed by either player is unavailable to both thereafter.

- Correct letter: +1 point for each newly revealed position (all repeated occurrences count).
- Incorrect letter: −1 point and one shared miss.
- Correct full solution: +1 per still-hidden position, plus a 2-point completion bonus; ends the game.
- A letter that finishes the word also earns the 2-point completion bonus.
- Incorrect full solution: −2 points and two shared misses.
- Seven or more shared misses ends the game. Highest score wins; equal scores draw.
- Exhausted invalid-action corrections forfeit the contest to the opponent. Provider failures and budget stops remain unscored.
- Before terminal play the secret/provenance and full solution submissions stay private. Both agents receive opponent letter guesses and their outcomes. The terminal frame reveals the word; earlier replay frames remain masked.

The corpus and deterministic selection below are reused. CLI requests still pass through the existing controller, adapters and persistence. For new casual Hangman matches, blank reasoning defaults to `none` for Claude (`MAX_THINKING_TOKENS=0`) and `low` for Codex; explicit choices and series configurations are preserved. Claude models that cannot disable thinking may still reason. Claude receives a concise game system prompt instead of the default coding prompt. Disabling extended thinking reduces unnecessary generation; it does not promise a network response deadline shorter than the configured timeout.

This game is seat-sensitive: strict series require even repetitions, swap roles, and use the same seeded word for each role-swapped pair. Casual one-word results are not broad model rankings.

## Saved legacy matches

Records with `independent-lanes-1` retain the following original rules, renderer, validation, replay and resume behavior. They are never reinterpreted as shared-board games. Standings do not combine the two versions. New casual matches default to `shared-board-2`.

Hangman is a two-agent competition with independent lanes. Both agents receive the same word. Player 1 acts first; the controller alternates unfinished lanes and skips a completed lane. The match completes only when both lanes have finished.

## Rules: independent-lanes-1

- A lowercase ASCII letter guess reveals every occurrence. A miss costs one miss.
- Repeating a letter is an invalid action and uses the normal correction policy.
- A correct full-word solution solves the lane. An incorrect solution costs two misses. Repeating an incorrect full solution is accepted and costs another two misses.
- Seven or more misses fails the lane. A last incorrect solution can leave eight misses; the UI shows zero remaining.
- Only accepted actions count toward the action comparison. Invalid responses remain in request telemetry.
- One correction is allowed. Exhausting it forfeits that lane; the other lane continues.
- Provider failures stop the match without a scored result. Pause, manual stop, and budget stops do not invent a winner.

The deterministic comparison is, in order:

1. A non-forfeited lane beats a forfeited lane; two forfeits draw.
2. Solved beats failed.
3. If both solved, fewer misses wins.
4. If still tied, fewer accepted actions wins.
5. If both failed, more distinct correctly guessed letters wins. Repeated positions of one letter count once.
6. Otherwise, draw.

Standings award one point per win and half a point per draw. They group competitors by game and time control. Unscored matches are excluded. The displayed standings cover the recent history window, not a lifetime tournament.

## Private state and reproducibility

The server uses the pinned MIT-licensed `@nkzw/safe-word-list` version 3.1.2. The default array is converted to lowercase, filtered to ASCII letters of length 5 through 12, deduplicated, and sorted in ASCII order. This produces 2,068 words. The SHA-256 of newline-joined words with a final newline is:

`6d2c031c2f117996772990f9a5655c5e10c9cc93b8a3b82982d89e3fafb702b3`

A private 32-byte random seed drives `hmac-sha256-counter-v1`. HMAC-SHA256 blocks use the seed as key and `hangman-word-v1:<counter>` as message. Unsigned big-endian 32-bit values are accepted below the largest multiple of corpus size less than or equal to 2^32, then reduced modulo corpus size. This avoids selection bias. Word selection never uses `Math.random`.

Canonical persistence contains the word, seed, selected index, package/filter/generator versions, corpus hash, both lanes, and the action/adjudication history. Load validates provenance and replays every accepted action and lane forfeit. Derived lane metrics and results must agree with replay. The corpus is a server dependency and is not bundled into the browser.

## Reveal boundary

- Agent observations contain only their own masked pattern, guessed letters, misses, accepted action count, own history, legal letter actions, solution schema, and request timeout.
- Player counters are lane-local. Opponent progress, guesses, masks, and miss counts are omitted.
- Browser state contains both masked lanes. A solved lane is sealed until both lanes finish. Full solution submissions are redacted from public telemetry.
- The word is revealed only once both lanes are terminal, including lane forfeits. Stops, errors, and interruptions before that point keep it private.
- Match summaries contain no game state, pending turn, history, events, diagnostic excerpts, or word provenance.
- Detail, JSON export, state, events, attempts, and SSE use public projections. There is no raw-persistence HTTP endpoint. Raw diagnostics and best-effort failed-write recovery files remain local.
- Replay frames retain their historical masking, even when the final result is available.

This is a payload boundary. It does not establish operating-system isolation against a CLI running as the same local user. Provider tool restrictions and authentication require separate qualification. Automated subprocess fixtures verify the application flow; they are not evidence of live provider quality. No paid provider runs are required by the test suite.

## UI and records

Choose Hangman in setup and configure the two agents. Both lanes show masks, guesses, misses remaining, action counts, state, and expandable request records. Completed matches reveal the word and comparison outcome. The replay slider inspects historical public states. JSON downloads use the safe detail endpoint. Play Again preserves competitors and selects a fresh private word.

## Word-list license

The corpus package is MIT licensed. Its license and notices are supplied in the dependency distribution. See [the upstream project](https://github.com/nkzw-tech/safe-word-list). Do not remove third-party copyright notices when redistributing dependencies.
