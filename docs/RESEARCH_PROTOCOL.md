# Research protocol and implementation boundary

Agent Battle measures **performance of specified AI systems in bounded interactive environments under declared observation, action, and resource constraints**. Differences across controlled conditions may support narrower claims about information use, adaptation, or transfer. A game win, execution qualification, and a validated capability inference are three separate things.

The implemented foundation is a registered exploratory study workflow (`battle-series-3`). It retains the existing controller, game engines, provider adapters, storage, replay, and historical series formats. It does not establish an intelligence scale, human equivalence, adaptation, or a public model ranking. “Interactive general intelligence” is premature.

## Shipped research workflow

- Conditions identify both environment and ruleset, so independent and shared Hangman can appear together.
- A declaration fixes the question, primary contrast, practical effect, sample, paired challenge groups, role policy, retry policy, budgets, and stopping rule before execution.
- A canonical declaration hash and separate challenge-root commitment accompany every trial. These detect inconsistent records; they are not signed attestations or an independent preregistration service.
- Blocks and conditions use deterministic shuffled execution order. A block retains the same challenge across conditions, seat swaps, and replicates.
- Both models receive equal request and active-time limits. Research budget fields are **whole-match** limits, with half allocated to each participant, rounded down. Historical series retain their earlier budget interpretation.
- Registration does not launch providers. The saved study card provides start, pause, resume, stop, skip, export, and completed-study rerun controls.
- First attempts define the primary analysis. A permitted infrastructure rerun remains in operational totals and cannot replace a failed primary observation. Qualification failures cannot be retried into eligibility.
- All planned slots remain represented, including skipped, missing, and unqualified results. Research conditions have separate outcomes; no cross-condition intelligence average is produced.
- Store version 7 is imported once into the durable SQLite store with a backup manifest; frozen assignments are validated and old records do not receive invented execution evidence.

## Both Hangman modes belong, with different interpretations

Independent lanes are a lexical-inference control. Each agent sees its own lane and receives no benefit from opponent discoveries. Shared-board Hangman changes information externalities, strategic timing, and scoring. Neither is a strong novel-generalization probe: both use familiar language and a public corpus.

The shared-minus-independent outcome contrast is a **ruleset sensitivity** measurement. It simultaneously changes observation and reward structure. A nonzero contrast does not isolate opponent modeling, theory of mind, or strategic intelligence. Separate observation-only and scoring-only ablations would be necessary for that attribution.

Chess remains a planning/control environment with substantial prior-exposure confounds. Battleship measures search and hidden spatial inference, not deception or persuasion. Neither is part of the first registered contrast.

## First study

Use two explicit, provider-reported Claude model IDs available to the operator, with requested medium effort, or use one identical ID as a labeled same-model control. Do not infer model availability from this document. Reasoning effort is recorded as requested; effective effort is unknown unless later independently reported.

| Design field | Declaration |
| --- | --- |
| Challenge unit | 24 distinct public-corpus words, selected before outputs |
| Independent condition | 2 replicates per word, alternating which system occupies player 1 |
| Shared condition | 2 replicates per word, each with both seat assignments |
| Total | 144 matches; 24 independent challenge blocks, not 144 independent samples |
| Primary endpoint | Agent A shared outcome share minus independent outcome share |
| Outcome | Win 1, draw 0.5, loss 0 |
| Practical effect | 0.15 outcome-share difference, a provisional pilot threshold |
| Resource defaults | 64 accepted actions, 128 total requests, 60 active minutes per match; 120 seconds per request |
| Retry | At most one infrastructure rerun per slot; never substituted in the primary estimate |
| Stopping | Fixed sample; stopping early leaves missing outcomes and is disclosed |
| Inference | Exploratory paired block estimate with a deterministic 5,000-resample percentile bootstrap |

The public root is selected by the first deterministic nonce giving 24 distinct words. It is reproducible, not secret or contamination-resistant. The generic research API can use a fresh random root. Roots and per-slot seeds are withheld from public exports until completion, but secrecy is not a defense for this public pilot. Every model invocation is fresh; previous matches and terminal reveals are not inserted into later observations.

Budget roughly 1,500–5,000 requests for ordinary play, subject to behavior. The configured maximum is 18,432 requests before infrastructure reruns. Tokens, latency, and prices vary; no dollar total is promised. The reported-cost stop is a per-match accounting limit, not a guaranteed billing cap. Missing usage remains unknown. Registration and the offline baseline cost zero model requests.

Valid conclusions: these two specified systems differ in observed outcomes under these two rulesets on this suite; the uncertainty may justify a larger preregistered replication. Invalid conclusions: either model is generally more intelligent, has learned, reasons socially, matches humans, or generalizes to unfamiliar rules. A null or wide interval is not equivalence.

## Statistics and failure handling

Average seats and replicates inside each word and condition. Subtract condition means inside a word. Average those paired differences across complete words, resampling whole words for the bootstrap. Never resample individual turns or treat replicate/seat observations as independent evidence.

The complete-block estimate is conditional on successful observation. It can be selection-biased when failures differ by condition. Therefore also report bounds over **all planned blocks**, assigning each missing outcome every possible value in [0,1]. No imputation of failures as model losses, no silent deletion, no successful-retry substitution. Inferential estimates are withheld until the study is completed or stopped. Operational outcome summaries remain descriptive.

Bootstrap intervals are exploratory and can degenerate on very small or constant samples. A narrow interval alone establishes neither construct validity nor equivalence. Power the next study from observed block variability and a prespecified effect, with a fresh suite; do not keep sampling this study until significant. Reserve Elo/Bradley–Terry for sufficiently connected, role-balanced multi-opponent designs. They do not repair confounding or nontransitive matchups.

## Provider evidence standard

Research requires, on every request: a declared restricted profile, complete recognized event stream, one consistent requested/reported model identity, an explicit empty external-tool inventory, zero observed external tool calls, and a fresh provider session ID. `StructuredOutput` is treated as the response channel. Unknown, conflicting, or missing evidence fails qualification. No private reasoning is collected in this metadata.

The profile hash covers static invocation policy, model, requested reasoning, and policy versions. It deliberately excludes private observations, which could leak through hashes of low-entropy secrets. Public evidence contains bounded metadata, not arbitrary provider event payloads. The child environment uses an allowlist; inherited endpoint overrides and arbitrary customization variables are not forwarded. Supported credentials/config locations remain available for authentication. This is CLI policy evidence, not OS sandbox attestation or proof of an unmodified provider binary.

The current research UI restricts this pilot to Claude's reported inventory path. Codex and OpenCode can remain useful functional game transports without qualifying this study. Qualification is evaluated per request; installation or a successful smoke run is insufficient. CLI upgrades that introduce new events must be reviewed and tested before accepting them. Historic v1/v2 labels retain their original criteria; do not pool those outcomes with this stronger study.

Strict benchmark publication additionally requires independent profile review, pinned CLI/environment versions, clean authentication-only configuration, prompt/template review, a released suite definition, planned missingness handling, replication, and a defensible construct interpretation. The app intentionally labels this workflow **exploratory study**, even when execution checks pass.

## Offline operation

```sh
# Runs 144 deterministic games, no providers, no application data writes.
npm run --silent research -- baseline > baseline.json

# Prints a JSON body suitable for POST /api/series; does not send it.
npm run --silent research -- prepare EXACT_MODEL_A EXACT_MODEL_B > registration.json
```

The baseline compares a fixed English letter-frequency order with alphabetical order. Each policy receives only legal actions. It has no hidden-word access, lookup corpus, model, or reflection. Deterministic replicates are deliberate duplicates and do not add sample size. This is a harness control, not a competitive lexical solver.

On the initial 24-word suite the baseline completed 144 games with zero provider calls. Frequency-policy shared-minus-independent outcome share was **+0.0417**, with exploratory block-bootstrap interval **[-0.0729, +0.1563]**. This says nothing about model strength and is not evidence of equivalence. Reproduce from the command rather than treating these rounded values as a permanent benchmark.

API additions:

- `GET /api/games` includes registered versions alongside current games.
- `GET /api/research/presets` returns the pilot declaration and workload estimate.
- `POST /api/series` accepts `researchPreset: "hangman-pilot"`, or a validated `researchPlan` and optional `masterSeed`. Do not combine the preset with another plan/root.
- `GET /api/series/:id/analysis` returns raw planned rows, eligibility reasons, block contrasts, and missing-outcome bounds.
- Completed `GET /api/series/:id/export` includes the declaration, root, assignments, public trial evidence, and analysis. Existing export versions remain readable.

## Research gates and coding-agent handoff

The next work is staged by evidence, not the number of games implemented. The human study and long-horizon program remain future work; this change does not simulate having completed them.

| Priority | Work and research value | Dependencies and likely subsystems | Acceptance criteria and tests | Preserve / avoid |
| --- | --- | --- | --- | --- |
| P0, implemented foundation | Frozen condition plans, both Hangman modes, same-model controls, provider evidence, paired analysis | shared types; researchPlan/Analysis; series; schema/store; controller; UI | Round-trip commitments; paired roles; first-attempt missingness; stream conflict rejection; actual controller/store fixture; API registration without invocation | Preserve engines, replay privacy, historical series and atomic persistence; never manufacture model results |
| P0, operational validation | Run bounded provider qualification and the frozen pilot, then independently reproduce the analysis | Installed/authenticated CLI, operator resource allocation, exported artifacts | Inspect every unqualified trial and usage coverage; publish all slots; compare against baseline; no post-output seed changes | Do not reinterpret smoke tests as comparative evidence or change the registered endpoint |
| P1 | Separate lexical information efficiency from outcome scoring; matched fixed-fleet Battleship controls; procedural deduction baseline | Diagnostic metrics with versioned definitions; explicit environment variants; reviewed upstream license | Non-oracle random/heuristic baselines; legal-transition replay; ceiling/floor checks; observation-only/scoring-only ablations; demonstrate useful new signal before admission | No replacement of existing game versions; no additional application server or provider layer |
| P1 | Adaptation protocol: cold, history/reflection, matched held-out challenge, mutation, retention/transfer | Episode grouping; allowlisted memory artifact; token accounting; matched no-reflection and token-matched controls | Hidden answers never enter reflection; held-out challenge separation; cold/adaptation/transfer reported separately; include reflection cost; test leakage and negative transfer | Never infer learning merely from repeating the same answer; no chain-of-thought collection |
| P2 | Four-player Deduction Manor with ordered private disproval | Minimal action-window support; participant arrays; private projections; permissive mechanics review | All visibility pairs tested; public inability-to-disprove log; exactly one private revealed card; rule oracle and seeded replay; 4-player and seat-rotation tests | No dice/walking until shown relevant; no general-engine rewrite |
| P2 | Procedural novel-rule ladder and human reference study | Generated rules with oracle; comprehension controls; human action transport | Deterministic instructions/transitions; training/evaluation grammar splits; matched roles; prior-skill and practice accounting; repeated-person clustering | Novel must mean learnable unfamiliar structure, not arbitrary confusing prose |
| P3 | Bounded social deduction, negotiation, simulated fault diagnosis | Collected actions; phase resolution; hidden roles/payoffs; message quotas; calibrated beliefs | Balanced role/seat schedules; deterministic tie rules; simultaneous-action sealing; objective outcomes; persuasion ablations and opponent-population controls | No unlimited chat, tiny-N poker leaderboard, private reasoning requests, or latency-dominated realtime task |

A minimal future multi-party interface should add participant IDs and controller-owned action windows to the working lifecycle. The controller owns invocation, reservations, deadlines, visibility enforcement, persistence, and recovery. An environment owns legal participants, roles/factions, phases, observation content, transitions, and outcomes. Collected actions must commit privately until a declared resolution boundary. Preserve two-player adapters and saved formats until conformance tests cover both paths.

For Manor, start with four participants and no navigation. Three to six is an extension after correctness and identifiability checks. For social deduction, start experimentally with six participants (two deceivers, four uninformed), fixed public speaking slots, simultaneous sealed votes, a bounded night phase, explicit tie/no-elimination rules, and a fixed round cap. Role balance must be measured, not assumed; structured role probabilities can be scored separately from wins. Do not call faction victory a direct persuasion measure.

The adaptation design must compare experience/reflection with both fresh-start and equal-extra-token controls on matched unseen challenges. Report cold score, held-out gain, learning slope, retention, transfer/negative transfer, and gain per token/second/reported dollar. No weight updates are required, but any persistent artifact is part of the evaluated system and must be versioned.

Human references require prior-skill stratification, fixed practice, matched challenge difficulty, seat/role balance, randomized condition order, participant-level repeated-measures analysis, and explicit inclusion rules. A convenience sample is not “human performance.” Pilot variance should determine a target sample and stopping rule before recruiting the confirmatory cohort.

## Expansion and reuse decisions

Retain Chess as a control, both Hangman modes as distinct conditions, and Battleship as hidden-state search. Prioritize asymmetric deduction and procedural rule variants. Negotiation and bounded social dilemmas can add objective utility/cooperation outcomes. Social deduction is experimental until role/opponent effects and cheap rhetorical shortcuts are isolated. Deprioritize Tetris/Snake realtime control, geoguessing dominated by exposure, and NetHack-scale horizons until the cost and modality confounds are justified. Reject a giant AGI score and an endless collection of redundant games.

Reuse authoritative mechanics through narrow adapters. Agent Battle continues to own observations, privacy, provenance, providers, budgets, telemetry, series, storage, and export. Review the exact upstream revision and LICENSE before porting code. No external mechanics were copied in this implementation. Future reuse candidates and their license audits belong in a separate evidence-backed decision before any dependency is added; old README license claims alone do not authorize reuse.

Stop adding games when the suite has controlled probes for planning, lexical inference, hidden spatial inference, asymmetric deduction, social interaction, and risk/opponent response **and** a proposed new environment fails to show incremental information over that battery on held-out systems/challenges after cost adjustment. Until there is enough diverse-system data to estimate redundancy, use ablations and baseline failure modes, not an unstable correlation threshold. Prefer adaptation, novelty, human controls, and bounded non-game tasks once this gate is reached.

Thirty days: validate execution profiles and the first study, inspect missingness and cost, refine construct ablations. Ninety days: admit a novel-rule/adaptation protocol only after leakage and baseline controls; implement minimal multi-party support if Manor remains justified. Six to twelve months: independently replicated human-relative results and a bounded fault-diagnosis or changing-requirements simulator with objective recovery/cost outcomes. These are research milestones, not guaranteed feature dates.

Principal risks: construct overclaiming; contamination; scoring shortcuts; role/opponent confounding; selective missingness; dependent samples; unobserved provider customization; expensive variance; weak human sampling; benchmark-specific training. Engineering counterparts: visibility leaks; failed atomic transitions; unsafe migrations; unknown event schemas; stale session reuse; policy drift; budget overruns; misleading UI aggregation; whole-store scaling; premature engine generalization.

Defenses combine fresh held-out suites and generator families with public manifests, versioned protocols, full trial accounting, independent replication, rotating controlled variants, adversarial engine tests, and explicit known-game baselines. Private challenge roots are only one defense. A bounded non-game environment is a good long-term direction when it preserves auditable transitions and objective outcomes, not merely because it resembles work.
