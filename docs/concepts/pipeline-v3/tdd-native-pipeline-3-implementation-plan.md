# TDD-Native Pipeline-3 — Sequenced Implementation Plan

> Companion to `tdd-native-pipeline-3-design.md`. Branch: `feat/pipeline-v3`.
> Every item below was **verified against live code** and **adversarially safety-checked** by a
> multi-agent workflow (25 agents, 0 errors). The safety pass overturned the design's optimism on
> 6 of 11 items — their real "dark" status and required mitigations are captured per-card.

## Build status (2026-07-02)

**All 12 wave items' deterministic cores are shipped, tested, and dark** — 11 feature commits
(`0cb4069..81ff88b` on `feat/pipeline-v3`), 145 tests green, `tsc` 0, lint clean. Nothing changes on any
live path (legacy or P3-default) until an operator flips a flag.

| Item                                                    | Flag                      | Status                             |
| ------------------------------------------------------- | ------------------------- | ---------------------------------- |
| Flag registry (7 flags)                                 | —                         | ✅ shipped                         |
| W1.1 skills embeddings sidecar + read-gate              | `SKILLS_EMBED_RANK`       | ✅ shipped                         |
| W1.2 semantic-extract per-compile                       | `P3_SEMANTIC_COMPILE`     | ✅ shipped                         |
| W1.3 ac-cartographer (shadow fields + severity)         | `AC_CARTOGRAPHER`         | ✅ shipped                         |
| W2.1 quality verdict (P-band, additive)                 | `P3_QUALITY_GATE`         | ✅ shipped                         |
| W2.2 test-author split (RED gate + tamper, fail-open)   | `P3_TEST_AUTHOR_SPLIT`    | ✅ shipped                         |
| W3.1 skills role policy + role param                    | —                         | ✅ shipped                         |
| W3.2 graded frontier (`contract_frozen`)                | `P3_FRONTIER_MODE`        | ✅ shipped                         |
| W3.3 TESTS edge (allowlist + resolver)                  | `P3_TEST_COVER_EDGES`     | ✅ core; ⏳ graph-sync ingest pass |
| W3.4 inline frontier tick (60s→~3s)                     | —                         | ✅ shipped                         |
| W4.1 reverse impact (`queryImpact`, by-type, no rename) | (report-only)             | ✅ shipped                         |
| W4.2 graph growth split (per-story / cohort lanes)      | `P3_GRAPH_GROWTH_SPLIT`   | ✅ shipped                         |
| W4.3 learning meta-loop (instincts from TDD telemetry)  | (observe-gated)           | ✅ core; ⏳ reflector-prompt scope |
| W5.1 selective regression (pure selection core)         | `P3_SELECTIVE_REGRESSION` | ✅ core; ⏳ daemon driver wiring   |

**Remaining = integration wiring only** (the deterministic cores above are done + tested): (a) the
`graph-sync` `main()` `processTestCoverFacts` ingestion pass + the compile-time producer that writes
`test-cover-facts.json` (touches the unflagged-live `graph-sync` — needs careful review of its
session/MERGE internals); (b) the selective-regression daemon wiring (changed-files→node-ids + a Memgraph
driver handle + test-node→executor map); (c) the reflector-prompt scope change (LLM prompt: add
`skill-requirement` to `REFLECTION_TARGETS` + a scout-enqueue path). Each stays behind its flag.

## Governing law

1. **Every new _gate_ is proven deterministic and unit-tested before any new _spawn_ consumes it.**
2. **No live path changes until an operator flips a flag** — where "live path" means BOTH the default
   legacy step pipeline (`story-pipeline.ts`, `useEpicOrchestrator` defaults false) AND the P3-default
   (all flags off) state.
3. **Graph dependency edges (`TESTS`, reversed impact) land before their consumers** (selective
   regression, impact queries).

## ⚠️ The load-bearing finding from the safety pass

The design assumed most items were naturally "dark." They are **not**. Three live substrates are
**not flag-gated today** and any write into them changes default behavior:

- **`graph-sync.mjs`** runs unconditionally on every compile (legacy + P3-off). Appending a pass or
  renaming an edge type there is a live change, and an **unguarded throw aborts the rest of the sync**
  (graph integrity, snapshot, S3 backup).
- **`buildSkillsPushPrompt`** (via `agent-daemon.mjs:2684`) feeds the live DEV/TEST/API_AUTHOR steps.
  Publishing the embeddings sidecar **lights up cosine body-push on the default pipeline** → different
  generated code.
- **The reflector prompt + `runSolutioningGate`** run on the live legacy plan-close / start paths with
  no flag.

**Therefore: the dark-discipline rules (below) are mandatory, not optional.** Each risky/needs-flag item
carries its specific mitigation.

### Safety ledger

| Item                        | breaks legacy? | breaks P3-default? | Verdict       | Gating required                                                  |
| --------------------------- | -------------- | ------------------ | ------------- | ---------------------------------------------------------------- |
| `skills-role-inject`        | no             | no                 | **safe-dark** | default role = today's behavior                                  |
| `graded-frontier-wire`      | no             | no                 | **safe-dark** | `P3_FRONTIER_MODE` (exists, default kahn)                        |
| `graph-semantic-percompile` | no             | no                 | **safe-dark** | new default-off flag + try/catch                                 |
| `graph-growth-split`        | no             | no                 | **safe-dark** | new default-off flag                                             |
| `selective-regression`      | no             | no                 | **safe-dark** | new default-off flag; no-op when empty                           |
| `ac-shape-cartographer`     | **yes**        | **yes**            | needs-flag    | gate the whole normalization; shadow fields                      |
| `coverage-quality-wire`     | no             | no                 | needs-flag    | gate reviewer feedback behind flag `=on`; no P-band field exists |
| `graph-tests-edge`          | no             | **yes**            | needs-flag    | flag + per-pass try/catch in graph-sync                          |
| `learning-metaloop`         | **yes**        | no                 | needs-flag    | gate reflector-prompt change; observe/distiller ship as-is       |
| `skills-embeddings-sidecar` | **yes**        | **yes**            | needs-flag    | gate the **activation**, not just the writer                     |
| `test-author-split`         | **yes**        | no                 | **risky**     | do NOT edit `story-pipeline.ts`; flag every new behavior         |
| `graph-impact-reverse`      | **yes**        | **yes**            | **risky**     | split item; do NOT rename `DEPENDS_ON`                           |

## Dark-discipline rules (apply to every item)

- **D1 — Gate the activation, not just the producer.** Writing a file / edge that a live reader consumes
  is a behavior change even if the writer is "new." Gate where the value is _read_.
- **D2 — Per-pass try/catch on any shared live path.** Anything appended to `graph-sync.mjs` or an
  app-bootstrap step must swallow-and-continue (mirror the existing per-pass isolation), never abort the
  chain.
- **D3 — Shadow fields, never overwrite operator content.** Normalized AC prose goes to
  `normalizedText`/`normalizedGwt`/`riskTag`, never onto `text`/`given`/`when`/`then`.
- **D4 — New flag defaults OFF and inherits allowlist/rollout** (add to `pipeline-flags.mjs` `P3_FLAGS`,
  first enum value = off).
- **D5 — Parity test per gated item:** with the flag off, output is byte-identical to pre-change for a
  fixture at mvp AND production rigor.
- **D6 — Fail-open:** a throw in a new phase degrades to the legacy/previous behavior, never fails the job.

---

## Wave sequencing

| Wave   | Theme                                                | Items                                                                             |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| **W1** | Pure deterministic producers (no new spawns)         | `skills-embeddings-sidecar`, `graph-semantic-percompile`, `ac-shape-cartographer` |
| **W2** | Verdict wiring + the Test-Author spawn split         | `coverage-quality-wire`, `test-author-split`                                      |
| **W3** | Per-role skills · graded frontier · the `TESTS` edge | `skills-role-inject`, `graded-frontier-wire`, `graph-tests-edge`                  |
| **W4** | Graph impact/growth + learning meta-loop             | `graph-impact-reverse`, `graph-growth-split`, `learning-metaloop`                 |
| **W5** | Selective regression (top of the stack)              | `selective-regression`                                                            |

Dependency order (from the verified `dependsOn`): W1 items have none; `coverage-quality-wire`←`ac-shape`;
`test-author-split` gates W3's `skills-role-inject`/`graded-frontier`/`graph-tests-edge`;
`graph-impact-reverse`/`graph-growth-split`←`graph-tests-edge`+`graph-semantic`;
`selective-regression`←`graph-tests-edge`+`graph-impact-reverse`+`graph-semantic`.

---

## Wave 1 — Pure deterministic producers

### W1.1 · `skills-embeddings-sidecar` — make skill BODIES actually get pushed · M · deps: none

- **Seams:** `daemon/pipelines/app-bootstrap.mjs` `APP_BOOTSTRAP_STEPS` (insert `embed-skills` after
  `reconcile-skills-manifest` L377, before `commit-and-push` L391); `daemon/scripts/lib/voyage-embed.mjs`
  `embedBatch` (`voyage-3-large`, dim 1024, L27); reader `daemon/lib/skills-prompt.mjs`
  `loadEmbeddingsSidecar` (L211) / `buildSkillsPushPrompt` (L402).
- **Change:** new non-blocking bootstrap step walks `.claude/skills/*/SKILL.md`, embeds
  `name+desc+body-head` via `embedBatch`, writes `.claude/index.embeddings.json` (`{model,dim,count,vectors}`),
  stages it so per-story worktrees inherit it. **Must use `embedBatch`, NOT `scripts/ingest-skills.mjs --embed`**
  (that uses `voyage-3` → vectors incomparable to the query, silently poisoning ranking while passing the
  dim guard).
- **Verdict: needs-flag** (breaks legacy + P3-default — the sidecar lights up body-push on the live
  DEV/TEST/API_AUTHOR path).
- **Must-fix before landing:** (D1) gate the **read** in `buildSkillsPushPrompt`/`rankLoadoutItems` behind
  `SKILLS_EMBED_RANK=on` — writing the canonical file unconditionally _is_ the behavior change; (D2) total
  try/catch so a Voyage 429/outage never bricks the bootstrap infra job; add a **re-embed/invalidate trigger**
  when SKILL-SCOUT/installer mutate the skill set (else later-installed skills score `-Infinity` and sink);
  assert `vectors.length===1024 && model==='voyage-3-large'` in the header; A/B on one non-prod app (measure
  per-step Voyage latency/cost).
- **Test:** temp worktree + fake SKILLs + mocked `embedBatch` → asserts shape; no-key path returns
  `{skipped:true}` without throwing; round-trip model/dim == query model/dim.

### W1.2 · `graph-semantic-percompile` — cross-file CALLS/RENDERS on every compile · M · deps: none

- **Seams:** `daemon/pipelines/lib/story-compile-graph.mjs` `STORY_COMPILE_STEP_IDS` loop (L35, L161-195);
  `daemon/scripts/semantic-extract.mjs` CLI `main() --root` (L189-208); `daemon/scripts/graph-sync.mjs`
  `processSystemGraphFacts` already reads `semantic-facts.json` (L1021) — ingest is already live.
- **Change:** add a `compile-semantic` proc that runs `semantic-extract.mjs --root <workingDir>` → stdout to
  `.mycelium/semantic-facts.json` **before** `compile-sync`; the live ingest picks up real cross-file
  `CALLS`/`RENDERS`.
- **Verdict: safe-dark.** **Must-fix:** ts-morph loads the whole TS program ("Heavier") — gate behind a
  default-off flag and prefer **cohort/wave-close** invocation over literally-every-story; keep the
  swallow-all-errors contract.
- **Test:** small TS fixture → assert semantic-facts contains a known cross-file call; missing-file path is a
  no-op.

### W1.3 · `ac-shape-cartographer` — EARS/GWT normalization + risk tag + promote AC-shape gate · M · deps: none

- **Seams:** new `functions/shared/services/ac-cartographer.ts` (pure); hook in `functions/api/index.ts`
  after epics load (~L3282) before `runSolutioningGate` (L3303); promote `solutioning-gate.ts:168`
  `conditions.push(f)` → the existing `scaled(f)` helper (L82); add optional `riskTag` to
  `AcceptanceCriterion` (`epic-workflow.ts:110`).
- **Change:** normalize each non-manual AC to EARS-normative text + GWT, stamp `riskTag` (BMAD P×I);
  promote `validateAcShape` from dark-conditions to rigor-scaled (condition@mvp, error@production).
- **Verdict: needs-flag** — the safety pass caught that this is **NOT dark**: the same in-memory `epics`
  array feeds `launchPipelineWave`→`generateStoryPipeline` (the default legacy path), and populating
  `given/when/then` **silently flips the solutioning-gate BDD check** (removes a condition@mvp, removes a
  blocking error@production) even with the promotion flag off; `epicRepo` persist would **destroy
  operator-authored AC prose**.
- **Must-fix before landing:** (D3) write to **shadow fields** (`normalizedText`/`normalizedGwt`/`riskTag`),
  never overwrite `text`/`given`/`when`/`then`; gate the **whole normalization pass** (not just the gate
  promotion) behind one default-off flag; feed the gate/downstream from normalized fields only when the flag
  is on; `riskTag` stays optional + unread by legacy; (D5) parity test: flag off ⇒ `runSolutioningGate`
  verdict/blocks/conditions and persisted stories byte-identical for mvp + production fixtures.
- **Test:** cartographer output (shadow fields only); gate-parity with flag off; rigor-scaled promotion with
  flag on.

---

## Wave 2 — Verdict wiring + the spawn split

### W2.1 · `coverage-quality-wire` — quality verdict + risk-tiered reviewer · M · deps: `ac-shape-cartographer`

- **Seams:** `daemon/lib/story-completion-handler.mjs` `handleStoryCompletion` return (L53-59);
  `daemon/lib/quality-gate.mjs` `evaluateQualityGate` (L35, Wave-0); caller
  `daemon/pipelines/story-dev-pipeline.mjs:247`; daemon caller `agent-daemon.mjs:1818` (must inject
  `deps.spawnReviewer`); `.claude/agents/senior-reviewer.md`.
- **Change:** compute coverage%/pass% by P-band, feed `evaluateQualityGate`, attach `qualityVerdict`
  additively; spawn a fresh reviewer **only** for P0/P1 or `CONCERNS`, feeding `reviewerVerdicts`/`needsHuman`
  (currently unpassed). New default-off `P3_QUALITY_GATE` (`off|shadow|on`).
- **Verdict: needs-flag** (safe on legacy — daemon `.mjs` not imported there; and unreachable at P3-default
  since `runStoryDevJob` only runs when `P3_READY_FRONTIER!=off`). **Two landmines the safety pass found:**
  (1) **there is NO p0/p1 field on the AC schema** — grouping "by P-band" reads an absent field → `cov.p0=0`
  → spurious FAIL; (2) the reviewer→verdict feedback, if keyed only on "has P0/P1 AC," mutates the
  deterministic verdict's INPUTS on any P3-on canary even with `P3_QUALITY_GATE=off`.
- **Must-fix before landing:** derive `riskTag` from W1.3 (dependency reason) or fall back to `acClass`
  (e.g. presence of `advisory-security`) — never an absent field, fail-closed = skip reviewer; gate the
  reviewer spawn AND the `reviewerVerdicts`/`needsHuman` feedback strictly behind `P3_QUALITY_GATE==='on'`
  (in `shadow`, compute `qualityVerdict` but pass empty reviewer inputs → verdict byte-identical); graceful
  no-op when `deps.spawnReviewer` undefined (today's daemon caller); (D5) parity test on advisory-security +
  P0/P1 fixtures.
- **Test:** quality-gate parity already covered (Wave-0); add shadow-mode verdict-invariance test.

### W2.2 · `test-author-split` — split the single spawn into Test-Author + Implementer · L · deps: none (gates W3)

- **Seams:** `daemon/pipelines/story-dev-pipeline.mjs` implementer `spawn(claudeBin,args)` L183 +
  `buildStoryDevPrompt` L46; `daemon/lib/tdd-gates.mjs` `assertRedFirst`/`detectTestTampering` (Wave-0);
  `daemon/lib/test-binding-runner.mjs` `runStoryBindings`; `daemon/lib/completion-gate.mjs`
  `parseBindingManifest`/`applyBindings`; legacy TEST prompt at `functions/shared/pipelines/story-pipeline.ts`
  (~L419-500).
- **Change:** precede the implementer with a one-time Test-Author spawn (isolated, test-only touches, TEST
  role policy) that authors failing tests + `<BINDING>`; daemon `applyBindings` → oracle RED-first →
  `assertRedFirst` → commit `test(): RED` checkpoint → capture `ownedTestFiles`; implementer prompt trimmed
  to implement-only against committed tests; post-integrate `git diff --name-only` → `detectTestTampering`.
- **Verdict: risky** (`seamsConfirmed=false`). The safety pass flagged: **extracting the TEST prompt out of
  `story-pipeline.ts` refactors a LIVE production prompt** consumed by the default legacy pipeline
  (`index.ts:153`, endpoints 1503/3350/…); any non-byte-identical drift changes every mvp+ story's TEST
  agent.
- **Must-fix before landing:** **do NOT edit `story-pipeline.ts`** — copy the TEST prompt body into a new
  daemon-side `buildStoryTestPrompt` helper leaving the legacy file byte-for-byte untouched (or, if
  extraction is required, a separate PR with a before/after snapshot parity test on both conditional
  branches); add `P3_TEST_AUTHOR_SPLIT` (`off|on`, default off); guard **every** new behavior behind it
  (Test-Author spawn, applyBindings, RED assert, RED commit, prompt trim, tamper/revert); (D6) fail-open to
  the legacy single-spawn implementer on any infra hiccup; unit test: flag off ⇒ exactly one spawn with the
  untrimmed `buildStoryDevPrompt`, no Test-Author, no RED commit.

---

## Wave 3 — Per-role skills · graded frontier · the TESTS edge

### W3.1 · `skills-role-inject` — every P3 agent loads role-appropriate skills · M · deps: `test-author-split`

- **Seams:** `daemon/agent-daemon.mjs:2683` `SKILLS_PUSH_ROLES` (extract to a shared module);
  `daemon/pipelines/lib/story-skills-inject.mjs` `buildSkillsInjection` (L62, add `role` param);
  `daemon/pipelines/story-dev-pipeline.mjs` (~L124, call once per spawned agent).
- **Change:** add `role` to `buildSkillsInjection` — PUSH bodies when `SKILLS_PUSH_ROLES.has(role)`, else
  flat PULL; call once per spawned agent with role-appropriate `storyText` (test-author→AC/spec,
  implementer→impl prompt, reviewer→diff). Default role = today's push behavior → existing callers unchanged.
- **Verdict: safe-dark** (additive, default preserves behavior). **Test:** role→push/pull mapping; default
  arg parity.

### W3.2 · `graded-frontier-wire` — `contract_frozen` early-start (the earn-time win) · M · deps: `test-author-split`

- **Seams:** `daemon/lib/ready-frontier.mjs` (add `frontierMode` arg → `readyFrontier(nodes,{mode})`, default
  kahn = byte-identical single-arg call L47); `daemon/lib/story-dispatch-driver.mjs` `runFrontierTick` (read
  `flagMode(p3Flags,'P3_FRONTIER_MODE')`); `agent-daemon.mjs:~1708` (thread the flag);
  `story-dev-pipeline.mjs:~238` (emit `contract_frozen` = persist StoryNode to `merging` rank 4, only when
  mode≠kahn).
- **Change:** thread `P3_FRONTIER_MODE` (exists, default kahn) through dispatch; emit the contract signal at
  integrate so a dependent's test-author can start early in `contract` mode.
- **Verdict: safe-dark** (default kahn writes nothing, dispatch identical). **Test:** kahn parity;
  contract-mode unblocks a dependent at `merging` (Wave-0 frontier tests already cover the predicate).

### W3.3 · `graph-tests-edge` — the deterministic `TESTS` edge (the missing TDD edge) · M · deps: `test-author-split`, `graph-semantic-percompile`

- **Seams:** allowlist `daemon/scripts/lib/system-graph-ingest.mjs` `SYSTEM_GRAPH_EDGE_TYPES` **L20** (add
  `TESTS`); new `processTestCoverFacts` near `graph-sync.mjs:671`, mirroring the IMPORTS-only-if-both-endpoints
  block at **L915-922**; `testBinding.testRef` at `plan-spec-schema.ts:25`; reuse `ast-extract.mjs` import
  parsing.
- **Change:** for each bound AC's `testRef`, AST-resolve the test file's imports/describe targets → symbol
  nodeIds, emit a `TESTS` edge (test-file → exercised symbol) only when both endpoints exist.
- **Verdict: needs-flag** (breaks P3-default — `testBinding` exists on legacy-converted plan-specs too, and
  **`graph-sync.mjs` is not flag-gated**, so edges would appear with all P3 flags off).
- **Must-fix before landing:** (D1) gate the pass behind `P3_TEST_COVER_EDGES` (default off) checked in
  `graph-sync main()`; (D2) wrap `processTestCoverFacts` in its own try/catch (an unguarded throw aborts
  integrity + snapshot + S3 backup); MERGE-only-if-both-endpoints (never create nodes → preserves
  orphan/dead-code invariants); add a **prune step for stale `TESTS` edges** (renamed/deleted testRefs) or
  document as forward-only; fix the anchors (allowlist L20, not L44) and update the 3 tests that iterate
  `SYSTEM_GRAPH_EDGE_TYPES` (`extractor-envelope`, `doc-ingest`, `system-graph-ingest.adc`).
- **Test:** fixture test-file importing a symbol → asserts one `TESTS` edge; stale-edge prune; flag-off ⇒
  graph-sync output unchanged.

---

## Wave 4 — Graph impact/growth + learning meta-loop

### W4.1 · `graph-impact-reverse` — real reverse-dependency impact · M → **split** · deps: `graph-tests-edge`, `graph-semantic-percompile`

- **Seams:** `daemon/scripts/lib/impact-propagation.mjs` `propagateImpact` (L140) + `ALL_EDGE_TYPES` (L44,
  currently LLM set, zero callers); provenance at `graph-sync.mjs:918/938`; shard `DEPENDS_ON` at
  `system-graph-ingest.mjs:42`, `graph-sync.mjs:1174/1263`.
- **Change (SAFE slice — ship this):** repoint `propagateImpact` to the deterministic `IMPORTS|CALLS|RENDERS`
  (+`TESTS`) set, **reverse-traverse** `(changed)<-[…]-(dependent)` with `WHERE r.provenance='EXTRACTED'`;
  add `SET r.provenance='EXTRACTED'` at the deterministic edge write sites; add a read-only `queryImpact(nodeId)`
  export; invoke behind a default-off flag; fix the false docstrings (`predev-compile-pipeline.mjs:11/508`).
- **Verdict: risky — SPLIT THE ITEM.** The safety pass caught that the bundled **`DEPENDS_ON` → `DEPENDS_ON_SHARD`
  rename is unsafe**: `graph-sync.mjs` runs unconditionally, but live **readers** still query bare
  `DEPENDS_ON` (`self-reflection-pipeline.mjs:76` prune guard, `pruning-scan.mjs:133/172`,
  `generate-system-articles.mjs:196`) — renaming only the write sites makes a superseded node's shard
  dependent invisible → **wrongly tombstoned (graph data loss)**, plus a mixed historical-edge state.
- **Must-fix before landing:** **do NOT rename `DEPENDS_ON`.** Disambiguate shard vs article by an edge
  **property** (`r.scope='shard'`) or a node-kind filter in `queryImpact` — keeps every live reader untouched.
  Ship the safe slice (repoint + reverse + provenance + export + flagged invocation) now; hold any retype
  for a separate change that migrates all readers atomically + backfills historical edges.
- **Test:** `queryImpact` returns real importers/callers on a fixture graph; provenance filter excludes LLM
  edges; flag-off ⇒ no invocation.

### W4.2 · `graph-growth-split` — deterministic AST lane (per-story) + LLM article lane (cohort-close) · L · deps: `graph-tests-edge`, `graph-semantic-percompile`

- **Seams:** `daemon/pipelines/lib/story-compile-graph.mjs` `STORY_COMPILE_STEP_IDS` (L35) + loop (L161);
  `graph-sync.mjs` idempotent `MERGE` (L828-901) + "replay free" (L392); `regenAstFacts` hook precedent
  `agent-daemon.mjs:6395`.
- **Change:** per-story lane = deterministic only (diff → ast-extract → semantic-extract → structural-only
  `graph-sync` MERGEing symbols + `IMPORTS`/`CALLS`/`RENDERS`/`TESTS`), dropping the Haiku
  `compile-knowledge` from the hot path; LLM article/god-doc lane → cohort/plan-close batch. Needs a
  `graph-sync --structural-only` mode (skip Voyage article embedding per-story; full embed at cohort-close).
- **Verdict: safe-dark** (behind a default-off flag; MERGE is idempotent). **Test:** structural-only mode
  emits no article embeds; cohort-close batch does; replay idempotency.

### W4.3 · `learning-metaloop` — scope reflector + feed instincts from gate telemetry · M · deps: `test-author-split`, `coverage-quality-wire`, `graded-frontier-wire`, `ac-shape-cartographer`

- **Seams:** `daemon/hooks/posttool-observe.mjs` `buildObservation` (L13-27); `daemon/lib/instinct-distiller.mjs`
  `distill`/`describe` (L30-48); `daemon/pipelines/reflector-runner.mjs` `buildReflectorAgentPrompt` targets
  (L245-248) + `REFLECTION_TARGETS` (L268-275).
- **Change:** (a) additively capture gate telemetry (`tamper`, `redFirstFail`, `coverageGap`,
  `mutationSurvivor`, `scopeViolation`, `gateTier`) in `buildObservation` + matching distiller cases —
  **these are safe-additive and doubly-inert at default-off** (observe hook only installed when
  `P3_GATE_MODE` audit/enforce; distill not yet wired to any spawn); (b) scope the reflector prompt to
  landing targets + add a `skill-requirement` output.
- **Verdict: needs-flag** — the reflector prompt runs on the **live legacy plan-close path** (not flagged),
  and `skill-requirement` is **not in `REFLECTION_TARGETS`** so `parseReflectorOutput` silently drops it
  (dead output) and there's no scout-enqueue path.
- **Must-fix before landing:** ship the `posttool-observe`/distiller field-adds **as-is** (safe); gate the
  reflector-prompt change behind a default-off flag; if `skill-requirement` ships, **first add it to
  `REFLECTION_TARGETS` + wire an actual skill-requirement→skill-scout enqueue**, else it's a no-op.
- **Test:** `buildObservation` includes new keys when present; reflector-prompt parity flag-off;
  skill-requirement round-trips to a scout job when enabled.

---

## Wave 5 — Selective regression

### W5.1 · `selective-regression` — surgical cross-story regression (replaces the wave-merge full-suite) · M · deps: `graph-tests-edge`, `graph-impact-reverse`, `graph-semantic-percompile`

- **Seams:** `daemon/pipelines/story-dev-pipeline.mjs` post-`integrateStory` (`headSha` L238;
  `handleStoryCompletion` L247); changed files from compile-diff (`story-compile-graph.mjs:12`);
  `impact-propagation.propagateImpact` (L140); retired barrier ref `wave-merge-runner.mjs::runWaveMerge`.
- **Change:** resolve changed files → changed symbols → reverse-traverse `<-[:TESTS|CALLS|IMPORTS]-` to the
  set of **prior** stories' bound tests covering any changed symbol; run only that surgical set via
  `deps.executors`; a regression feeds the completion verdict (retry / mint regression-fix). This is the
  §3b ⚠️ safety the retired per-wave full-suite gate provided — made surgical.
- **Verdict: safe-dark** (behind a default-off flag; no-op when the covering-test set is empty). **Test:**
  fixture where story B changes a symbol covered by story A's test → only A's test runs; empty set = no-op;
  flag-off = nothing runs.

---

## Addendum — agent handoffs & dead-time (investigated 2026-07-02)

**Dead-time ledger (measured):** (a) step→step inside a job is already ~0 in BOTH pipelines — legacy
`executePipeline` is an in-process loop with in-memory `{{VAR}}` handoff (`agent-daemon.mjs:3202,3495`),
and P3's `runStoryDevJob` is sequential JS. (b) story-done → dependent dispatched: legacy paid 2–5 min
(wave cron); **P3 still pays up to 60 s** — `propagateCompletion` flips `blocked→ready` inline
(`agent-daemon.mjs:1789`) but dispatch waits for the next scan (`FRONTIER_SCAN_INTERVAL_MS=60000`,
`:1642/:9013`). (c) minted→pickup: 3 s poll (`POLL_INTERVAL`, `:286`). (d) spawn cold start ≈30 s + ~27 k
cache-creation tokens — the dominant cost; `P3_SESSION_REUSE` exists in the flag registry but is
**unimplemented** in the P3 path (the `--resume` machinery exists at `:954` / `agent-turn.mjs:57`).

**JS-orchestration reality check (our own spike, `spikes/v3-hybrid/probes/README.md:50-51`):** dynamic
workflows make the handoff control-flow ~instant, but the spawn — not the handoff — is the bottleneck:
serial 20.6 s vs workflow 104.9 s (B2); swarm 93.7 s vs serial 14.2 s (C1, "overhead dominates on easy
bugs"). The daemon's `.mjs` pipelines already ARE in-process JS orchestrators spawning the Claude CLI —
same architecture as ultracode's scripts, already integrated with DDB/events. **Do not adopt an external
workflow harness for the pipeline.** jcode's in-process session objects + socket `comm_report` handoff do
not transfer (we spawn a CLI, we don't own the provider connection); its portable lessons are
event-driven continuation, KV-cache prefix reuse, and same-role session resume.

**Decisions bound into the waves above:**

1. **W2.2 handoff spec:** Test-Author → Implementer is **intra-job, in-process** — Test-Author returns →
   daemon parses `<BINDING>` → RED oracle → `test():` commit → Implementer spawns in the same JS tick.
   In-memory + committed-files handoff; no DB round-trip. The split adds one cold start and **zero
   dead-time**.
2. **NEW W3.4 · `frontier-inline-tick` (safe-dark, S):** fire `runFrontierTick` inline immediately after
   `propagateCompletion` unblocks dependents (`agent-daemon.mjs:~1789`), keeping the 60 s scan as
   backstop. Kills the last structural gap; doubly important under `P3_FRONTIER_MODE=contract` (an
   early-start signal must not sleep a minute). P3-off unaffected (whole path frontier-gated).
3. **Isolation Law constraint on session reuse:** NEVER `--resume` the Test-Author's session for the
   Implementer — it would leak the test-author's reasoning and reintroduce circular validation. Session
   reuse is legal only **within a role** (attempt-2 resumes attempt-1; dev→compile via
   `P3_SESSION_REUSE=dev_compile`). Across the role boundary, cut cold start with a **byte-identical
   shared prompt prefix** (legacy precedent `story-pipeline.ts:799-803`) so spawn #2 pays cache-read, and
   keep the Test-Author on a cheap model.

## Open questions for the operator

1. **AC priority field.** `coverage-quality-wire`'s P-band + `graded`/risk-tiered reviewer need a priority
   signal. Add an explicit `riskTag` (from `ac-shape-cartographer`, W1.3) as the source of truth, or derive
   from `acClass`? (Recommend: `riskTag`, making W2.1 depend on W1.3 — already sequenced that way.)
2. **`graph-semantic-percompile` cadence.** Per-story (simpler, ts-morph cost each story) vs cohort/wave-close
   (cheaper, slightly staler mid-cohort)? (Recommend: cohort-close.)
3. **`DEPENDS_ON` disambiguation.** Edge property `r.scope='shard'` (recommended, zero reader migration) vs a
   future atomic rename+backfill?
4. **Flag proliferation.** New flags proposed: `SKILLS_EMBED_RANK`, `P3_QUALITY_GATE`, `P3_TEST_AUTHOR_SPLIT`,
   `P3_TEST_COVER_EDGES`, a semantic-compile flag, a graph-growth flag, a selective-regression flag, a
   reflector-scope flag. Consolidate any? (Recommend: keep separate for independent canarying; they're free.)
