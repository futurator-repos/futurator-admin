# Pipeline-3 Development Plan — Futurator-Admin

**Status:** Lead-architect synthesis (single source of truth). Supersedes the five workstream drafts and three context reports it was assembled from.
**Branch:** `feat/pipeline-v3`
**Scope:** The agent build pipeline run by `daemon/agent-daemon.mjs` — epic → solutioning-gate → plan decomposition → parallel story waves (dev/review/compile) → wave-merge → visual-QA → reflector — moving toward (a) a spec-driven "Mycelium" graph substrate for CONCEPT/SPEC and (b) a provider-agnostic (OpenCode) seam later.

---

## 1. Executive summary

**Thesis.** Pipeline-3 collapses the current cron-cadence, epic→wave→story→AC pipeline onto **one deterministic graph**. The unit is a **StoryNode** carrying test-bound acceptance criteria and three edge classes that each do double duty: `depends_on` **schedules** (Kahn ready-frontier dispatch), `touches` **isolates and gates scope** (worktree grouping + live PreToolUse allow-list + merge-conflict prediction), and `testBinding.status` **gates completion** (all bound ACs `passing` ⇒ story `done`, replacing subjective reviewer rounds). Determinism is the differentiator: every dispatch, scope, completion, cost, and promotion decision is a pure function over the graph; LLM judgment is demoted to advisory everywhere it touches the success path. We port mechanisms from three pattern-donor repos (jcode, ponytail, ecc) into the Node daemon — never as dependencies — and stay on the Max subscription, with model routing and multi-provider failover as throughput/overflow levers, not per-token cost moves.

**Keystone-first sequence.** Two spikes are already built and green and anchor the plan:

- `spikes/pretool-gate/pretool-gate.mjs` — the **live PreToolUse gate** (ecc composite risk-score + GateGuard fact-force + reused `detectScopeViolations`), fail-open, off/audit/enforce modes, 8 tests. This is the in-turn interceptor that replaces `bypassPermissions` + post-hoc-only gating — the #1 move all four prior analyses converged on.
- `spikes/ponytail/inject-lazy.mjs` — **AC-aware laziness injection** ("minimum code to pass bound AC"), benchmarked −54% LOC / −20% cost / −27% time, 2-line wire-in.

From those, the build order climbs the dependency chain, each step shipped behind a flag, audited or shadowed before it is allowed to act:

1. **Phase 1 (low-effort, reversible, observe-first):** promote the gate to live `audit` on one canary epic; wire ponytail laziness at the spawn site; fix the ~10× cost under-report with the harness-cost bridge (observe, then enforce a hard ceiling); add WITHIN-Max model routing.
2. **Phase 2 (the SDD pivot):** the Mycelium→dev `plan_spec` handoff contract + the `plan-spec-graph` table + `ready-frontier` continuous Kahn dispatch (kills 2–5 min inter-wave dead time) + the bound-AC completion gate (kills reviewer triple-fails). MVP graph = story + bound AC + `depends_on` + `touches`; the 12-edge governance registry is deferred.
3. **Phase 3 (structural throughput):** worktree lock-SHA dep-cache + `git merge-tree` conflict prediction + merge-queue (kills ~47% compile thrash, the index.md write race, and host saturation **without lowering concurrency**) + session reuse/compaction (gated on the reviewer-independence question).
4. **Phase 4 (learning & portability):** close the IAM-blocked reflector deterministically as an instinct ledger; local ONNX top-k retrieval behind a host fix; the one-canonical-policy → per-harness adapter OpenCode seam.
5. **Phase 5 (quality meta, deferred):** GAN evaluator, council, scorecards, harness matrix.

The whole thing coexists with today's daemon: one binary, two behaviors, selected per-job by an env-driven flag registry, with the legacy path as the always-available fallback. No legacy code is deleted until its replacement runs `on` at 100% for two weeks with green A/B metrics. **No big-bang.**

---

## 2. Current pipeline → pipeline-3 target

The current pipeline flattens an epic into waves and dispatches a fixed batch per wave; the next wave fires on a cron/WaveCompletionCheck barrier, "done" is a subjective reviewer verdict, scope is enforced only post-hoc on the diff, and cost is read from `finalResult.total_cost_usd` (under-reporting ~10×). Verified change sites:

| Concern                      | Current file(s)                                                                                                        | Pipeline-3 disposition                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan/epic/wave decomposition | `functions/shared/pipelines/*`, `plan-reducer.ts`, `wave-reducer.ts`, `pipeline-launcher.ts`                           | Plan row **kept**; epic demoted to a `cohort` label; wave reducers **replaced** by `ready-frontier`.                                         |
| Story schema / ACs           | `functions/shared/types/epic-workflow.ts`, `plan-output-schema.ts` (`acceptanceCriterionSchema`, `storyOutputSchema`)  | **Extended** with `testBinding` + `acClass`; `dependsOn` widened to global cross-epic ids; `touchPoints`→`touches` promoted to a gate input. |
| Dispatch loop                | `daemon/agent-daemon.mjs` (poll dispatch ~L8436–8482, RUNNING write ~L3035)                                            | Frontier filter + **atomic conditional-write claim**.                                                                                        |
| Spawn                        | `daemon/pipelines/epic-dev-pipeline.mjs` (args ~L255, `bypassPermissions` ~L260, `session_id` ~L407)                   | Gate hook + lazyArgs + model + worktree cwd + instinct injection.                                                                            |
| Compile                      | `daemon/pipelines/compile-pipeline.mjs`                                                                                | Per-worktree fast typecheck; authoritative build consolidated to the integrator.                                                             |
| Merge                        | `daemon/lib/wave-merge.mjs`, `wave-merge-runner.mjs`, `job-router.mjs` (L87)                                           | `git merge-tree` predict-gate + merge-queue + atomic frontier unblock.                                                                       |
| Review/completion            | `daemon/pipelines/lib/review-criteria-parser.mjs`, `done-detector.mjs`                                                 | Deterministic `completion-gate` over `testBinding.status`; reviewer advisory-only.                                                           |
| Cost                         | `daemon/lib/cost-meter.mjs`, `cost-engine.mjs`, `plan-budget.mjs`, `agent-daemon.mjs` (`enforceWaveBudgetGate` ~L5521) | Immutable `CostTracker` + harness-cost bridge + hard mid-turn ceiling + model routing.                                                       |
| Gating                       | `daemon/lib/prework-gate.mjs`, `gate-registry.mjs`; `daemon/pipelines/lib/scope-violation-detector.mjs`                | Three-layer defense-in-depth; live gate is the new middle layer.                                                                             |
| Reflector                    | `daemon/pipelines/reflector-runner.mjs`, `reflector-apply.mjs`, `daemon/lib/reflection-apply-poller.mjs`               | Deterministic instinct capture → Mycelium nodes (sidesteps IAM).                                                                             |
| Context/session              | `daemon/lib/compactor.mjs`, `session-pool.mjs`, `session-warmth.mjs`, `node-modules-store.mjs`                         | Finish stubs; session-thread reuse; content-hash + ONNX retrieval.                                                                           |

**Disk reality:** much of the "to-build" infra already exists in stub/partial form (`compactor.mjs`, `session-pool.mjs`, `story-worktree.mjs`, `cost-engine.mjs`, `metrics-csv.mjs`, `seam-mount-check.mjs`). Pipeline-3 is mostly **upgrade-in-place + flag-gate**, not greenfield.

---

## 3. The Mycelium→dev handoff contract

The CONCEPT/SPEC stage (Mycelium) converges a `plan_spec` and lands it as StoryNode rows. The contract is the single chokepoint between concept and dev; the dev stage stops consuming a flattened epic plan and starts pulling **one StoryNode at a time, the instant its `depends_on` closure is satisfied.**

**New files:** `functions/shared/types/plan-spec.ts` (TS source), `functions/shared/schemas/plan-spec-schema.ts` (Zod wire validator, `.safeParse` per project convention). The validator **extends** the existing `acceptanceCriterionSchema`/`storyOutputSchema` rather than forking them, so legacy PM output and Mycelium output share one validator.

```ts
testBinding   = { status: 'unbound'|'bound'|'passing'|'failing',
                  testRef?, testKind?: 'unit'|'integration'|'browser'|'manual',
                  lastRunSha?, lastRunAt?, detail? }            // ONE net-new field on the AC
boundAC       = acceptanceCriterion + { testBinding, acClass, validatesUjId? }
acClass       = 'deterministic' | 'advisory-taste' | 'advisory-security'   // only -security can block
specShardRef  = { shardId, s3Uri, contentHash /* SHA-256: cache key + drift detector */, section? }
storyNode     = { storyId /* GLOBAL Mycelium-stable */, cohort{epicId,epicTitle,requirementRefs},
                  title, intent, acceptanceCriteria: boundAC[] (≥1),
                  depends_on: storyId[]  /* gates dispatch */,
                  touches: glob[] (≥1)   /* gates scope + isolation + conflict grouping */,
                  forbiddenAreas: glob[] /* hard-deny; derived set computed at dispatch */,
                  specShardRef, complexity: trivial|standard|complex|architectural,
                  verifyIntent? }
planSpec      = { schemaVersion: 'plan-spec/1', planId, appId, planSlug, rigor,
                  convergedAt, myceliumPlanSpecId, stories: storyNode[] (≥1) }
```

**Contract guarantees, asserted at ingest (never half-ingested):** (1) global stable `storyId`s; (2) `depends_on` resolves within the spec and forms a **DAG** — a cycle rejects the whole `plan_spec`; (3) every story has ≥1 `touches` glob (or the existing `EPIC_WIDE` sentinel → serialized cohort); (4) every AC carries a `testBinding` (default `unbound`); (5) `specShardRef.contentHash` doubles as the content-hash cache key and drift detector.

**Three gates, one graph:** `readyFrontier(graph)` reads `depends_on`; the dev-job contract reads `touches`+`forbiddenAreas`; `completion-gate` reads `acceptanceCriteria[].testBinding.status`.

**AC-binding timing (decisive resolution of the vault's open question):** ACs are authored **`unbound`** at Spec; the dev contract requires the agent to emit a `<BINDING>` manifest (parsed like `touch-point-inference.mjs` parses `<INFERENCE>`) mapping `acId→testRef`, setting `status: bound` at write; the Verify stage runs the bound tests deterministically and flips `passing`/`failing`. "Done" is thus a deterministic function of the graph. `manual` ACs are excluded from the auto-flip and routed to VQA/human. Binding is materialized at story-context assembly (`daemon/pipelines/lib/story-context-pack.mjs`); flagged for override if Mycelium later binds at Spec.

---

## 4. Target architecture, stage by stage

```
CONCEPT/SPEC ──► SCHEDULE ──► DEV ──► INTEGRATE ──► VERIFY ──► LEARN
 (Mycelium)     (frontier)   (gate)  (commit-lock)  (bound-AC) (instinct)
```

| Stage            | Owns                                                                                                                                                                                                                                                                 | Donor mechanism / spike plugged in                                                                                                            | Key files                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Concept/Spec** | Mycelium converges `plan_spec`: story nodes + unbound→bound ACs + edges + spec_shards                                                                                                                                                                                | —                                                                                                                                             | `concept-driver.ts`, `plan-spec-schema.ts`                                                                                |
| **Schedule**     | Ingest `plan_spec`→graph; continuous Kahn ready-frontier dispatch; atomic claim                                                                                                                                                                                      | **ecc ready-frontier** (epic-unblock sweep → story Kahn); **DynamoDB atomic claim** (beats ecc non-atomic GitHub-issue claim)                 | `plan-spec-ingest.ts`, `daemon/lib/ready-frontier.mjs`, `story-graph.mjs`, `atomic-claim.mjs`, `story-node-repository.ts` |
| **Dev**          | Spawn one Claude per ready story, scoped to `touches`, under the **live gate**, lazy-injected, model-routed, in the **shared plan tree** (scope-gated, no per-story worktree)                                                                                        | **pretool-gate spike** (PreToolUse hook); **ponytail spike** (lazyArgs); **ecc model routing**; **jcode split system prompt + session reuse** | `story-dev-pipeline.mjs`, `dev-job-contract.mjs`, `pretool-gate.mjs`, `inject-lazy.mjs`, `model-router.mjs`               |
| **Integrate**    | **Per-story commit** of the story's `touches` to the plan branch under a **commit lock** (serialize only the commit step — kills the index race without worktrees); atomic dep-counter decrement → frontier unblock. **No per-story branches, no per-story merges.** | **commit-lock** (shared-tree); merge-tree predict kept only as a rare-overlap safety net                                                      | `story-integrate.mjs`, `commit-lock.mjs`, `merge-tree.mjs` (rare-overlap only)                                            |
| **Verify**       | Run bound tests deterministically; flip `testBinding.status`; delivery-journey replay on merged PLAN; seam-mount gate                                                                                                                                                | **bound-AC gate**; **content-hash cache**; existing `qa-delivery-selector`/`qa-author`                                                        | `completion-gate.mjs`, `test-binding-runner.mjs`, `delivery-verifier.ts`, `seam-mount-gate.mjs`                           |
| **Learn**        | Confidence-scored instinct capture from Pre/PostToolUse observations → Mycelium nodes → re-injected as policy/context                                                                                                                                                | **ecc instinct loop**; **ponytail single-source/multi-adapter injection**                                                                     | `posttool-observe.mjs`, `instinct-distiller.mjs`, `instinct-store.mjs`, `instinct-promote.mjs`, `instinct-injector.mjs`   |

Cross-cutting: **jcode compaction** (200k/80%/95%/RECENT=10/flat-1600-image/split prompt) on long compile + context-assembly sessions; **content-hash cache** wrapping read-heavy compile/extraction/QA-frame steps; **context-budget audit** trimming dead MCP/skill/CLAUDE.md weight pre-spawn; **local ONNX MiniLM top-k** replacing full-file reads in `search-cascade.mjs` Layer 4.

### 4.1 Git model (commits / branches / worktrees / GitHub)

The single source of confusion in the legacy era was per-story branches+merges. Pipeline-3's git model is deliberately flat and matches what the orchestrator already does (shared tree, scope-gated parallelism):

| Concern                  | Granularity        | What happens                                                                                                                                                                                          |
| ------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace / worktree** | **per PLAN**       | one checkout per plan on `plan/<slug>`; worktrees isolate _concurrent plans_ from each other — the only place they earn their keep. **Never per-story.**                                              |
| **Branch**               | **per PLAN**       | `plan/<slug>`. **No per-story branches.**                                                                                                                                                             |
| **Commit**               | **per STORY**      | when a story's bound ACs pass, `git add <touches> && git commit` to the plan branch — a commit, **not a merge**. The commit SHA is what `testBinding.lastRunSha` binds against (the staleness guard). |
| **Merge**                | **per PLAN, once** | at sign-off/deploy: one `plan/<slug>` → `main` PR. The **only** merge in the flow.                                                                                                                    |
| **GitHub**               | **per PLAN**       | push the plan branch / open one PR at the end; deploy from `main`.                                                                                                                                    |

**The index-race fix without worktrees:** parallel stories writing disjoint files never conflict on _content_ (the gate guarantees disjoint `touches`); the only shared resource is `.git/index` at commit time. So **only the `git commit` step is serialized** by a lightweight `commit-lock.mjs` (dev runs fully parallel; the commit is a few ms). This is what the per-story-worktree design was buying — bought far more cheaply. Worktrees + `merge-queue` are retained ONLY as the rare-overlap / concurrent-plan safety net, `OFF` by default (Phase 3A).

---

## 5. Detailed workstream designs

### 5.1 Handoff / ingest (Concept → Schedule)

**New:** `functions/shared/types/plan-spec.ts`, `functions/shared/schemas/plan-spec-schema.ts`, `functions/shared/services/plan-spec-ingest.ts`, `functions/shared/repositories/story-node-repository.ts`.

**Data model — new table `plan-spec-graph`** (declare in `sst.config.ts`, PAY_PER_REQUEST, PITR; one-table-per-concern law honored):

- `PK storyId`; attrs `planId, appId, cohort, acceptanceCriteria[], depends_on[], touches[], forbiddenAreas[], specShardRef, complexity, state(blocked|ready|claimed|developing|merging|verifying|done|failed), unblockedDepsCount(N), cohortBatch(N), jobId, version`.
- `GSI-1 planId-state-index` (frontier scan per plan); `GSI-2 planId-cohortBatch-index` (UI/merge grouping).
- **Event-driven Kahn (no full-graph scan):** at ingest `unblockedDepsCount = depends_on.length`, `state = ready` if 0 else `blocked`. On a story reaching `done`, Integrate decrements each dependent via **atomic conditional `UpdateExpression`** (`ADD unblockedDepsCount :neg1` + `ConditionExpression version`); at 0 it flips `blocked→ready`.

`agentJobs` stays the execution queue; add `storyNodeRef:{storyId,planId}` + `devContractRef`. **StoryNode = unit of schedule/spec/completion; AgentJob = unit of execution** (one AgentJob minted per ready StoryNode).

`ingestPlanSpec(raw, deps)` `safeParse`s, rejects the whole spec on any error, computes `cohortBatch` topo levels (shared with `ready-frontier`), idempotent batch-puts by `storyId`, stamps the Plan row `concept→developing`, and does **not** enqueue jobs (the dispatcher owns minting). Entry points: the Concept driver on convergence, plus `POST /api/plans/:id/plan-spec` for manual/replay.

**Tests:** cycle rejection, dangling `depends_on`, empty `touches`, legacy-AC parses, idempotent re-ingest, whole-spec reject on one bad story, `unblockedDepsCount`/`state` seeding.

### 5.2 Scheduling + parallelism + integration (Schedule → Dev → Integrate)

**New (all `daemon/lib/`, pure-first):** `story-graph.mjs` (`detectCycles`, `readyFrontier`, `topoOrder`, `applyTransition` — no I/O), `ready-frontier.mjs` (continuous dispatch), `atomic-claim.mjs` (`claimStory`/`renewClaim`/`releaseClaim` conditional writes), `lockfile-fingerprint.mjs` (SHA over manifest+lockfile, chunked 65536), `worktree-manager.mjs` (extends existing `story-worktree.mjs`/`node-modules-store.mjs`), `merge-tree.mjs` (`predictConflicts` via `git merge-tree --write-tree`), `merge-queue.mjs` (single-consumer FIFO), `dev-job-contract.mjs`.

**Modified:** `agent-daemon.mjs` (insert `isStoryDispatchable` frontier filter between the PENDING query and `selectNext` ~L8456; replace the unconditional RUNNING write ~L3035 with `claimStory`; `MAX_CONCURRENT`/capacity gate **untouched**); `job-router.mjs` (`selectHandler` + `JOB_HANDLER_STORY_DEV`); `epic-dev-pipeline.mjs` (spawn cwd = `worktreePath`, base = latest merged HEAD); `compile-pipeline.mjs` (per-worktree fast typecheck, authoritative build to integrator); `wave-merge.mjs` (predict before `buildWaveMergeCommand`, skip dirty merges via existing `buildMergeConflictAttention`, advance `integHead`); `concurrency-manager.mjs` (`canAdmit` admission tokens — defers timing under RAM pressure, never lowers slot count); `stale-heartbeat.mjs` (clear expired `claimExpiresAt`).

**Job-row schema (additive):** `dependsOn[]`, `storyState`, `claimOwner/claimToken/claimExpiresAt`, `worktreePath/worktreeBranch/depCacheMode`.

**Worktree safety (baked-in mitigation for the open t2.micro question):** symlink mode is **read-only-deps** — the install step is skipped entirely when the lockfile fingerprint matches (no writes into the shared tree); a story needing a new dependency won't match → independent install, never a stale symlink. Build artifacts go to the worktree's own dir. Phase-3 spike (one wave, measure compile time, watch ENOENT/races) gates the flip.

**Dev-job contract** (`buildDevContract`): `forbiddenAreas = authored ∪ DANGER_PATHS ∪ touches-of-concurrent-siblings` (mutual exclusion → ~0 merge collisions). Emits `FUTURATOR_STORY_ID`, `FUTURATOR_ALLOWED_PATHS` (`:`-joined), `FUTURATOR_FORBIDDEN_AREAS`, `FUTURATOR_AC_JSON`, `FUTURATOR_SPEC_SHARD_URI/_HASH`, `FUTURATOR_GATE_MODE`, `FUTURATOR_WORKTREE`, `CLAIM_TOKEN`.

**Tests:** diamond-DAG topo order; atomic-claim race (two callers, one wins); `ConditionalCheckFailedException`→`{claimed:false}` not throw; lease-expiry reclaim; lockfile match/mismatch; `merge-tree` clean vs parsed CONFLICT on fixture repos; merge-queue single-consumer invariant; worktree destroy preserves parent `node_modules`; 3-story integration (story-2 `dependsOn:[story-1]` never claimed before story-1 done; independents concurrent); existing wave-merge tests stay green with predict in front.

### 5.3 Context + token optimization (cross-cutting Dev/Compile)

**Ground truth:** `compactor.mjs` (V1 stub — single 80k threshold, no rewrite), `session-warmth.mjs` (HOT/WARM/COLD + `estimateResumeCostUsd`), `session-pool.mjs` (admission only), `node-modules-store.mjs` (lockfile-SHA content-keyed store — the exact pattern to mirror), `search-cascade.mjs` (Layer-4 raw read = token sink).

**Keystone of this workstream:** the **SubagentStart injector** (`daemon/lib/subagent-start.mjs`) — the single seam through which laziness, split-prompt caching, and session-resume reach the subagents that actually write code (the orchestrator's parent context never reaches them). It is the one-canonical-source → thin per-harness adapter object that doubles as the OpenCode provider seam.

**New:** `session-thread.mjs` (`--resume` threading across stages, backed by the existing `agent-sessions` table — no new table), `system-prompt-split.mjs` (static→`--append-system-prompt` cacheable, dynamic→`-p`), `embeddings/minilm.mjs` (all-MiniLM-L6-v2 ONNX, 384-dim, dense cosine+BM25+RRF, `CHUNK_TOKENS=512`, `TOP_K=8`, persistent sidecar), `content-cache.mjs` (mirror `node-modules-store`, `{sha256}.json`, corruption=miss), `context-budget.mjs` (`WORD_TO_TOKEN=1.3`, `MCP_TOOL_TOKENS=500`, keep/lazy/remove buckets), `inject-lazy.mjs` (promoted from spike).

**Modified:** `compactor.mjs`/`session-warmth.mjs` (dual threshold `SOFT=0.80`, `HARD=0.95`, `RECENT_TURNS_TO_KEEP=10`, `IMAGE_FLAT_TOKENS=1600`, one-shot **Haiku** summarize); `epic-dev-pipeline.mjs:255` (spread `lazyArgs`, split prompt, `resumeArgs`); `compile-pipeline.mjs` + `ast/semantic/service-extract.mjs` (wrap in content-cache); `search-cascade.mjs` (Layer 3.5 top-k before raw read; raw-read fallback only when confidence < 0.6); `role-policy.mjs` (`mcpProfile` per role).

**Session-reuse decision (resolves the open question for MVP):** **dev→compile shares session** (compile is mechanical extraction — no judgment contamination, biggest single win). **dev→review is a fresh spawn** but warm-starts the _substrate_ not the _judgment_ — review gets a `--resume` of a read-only Haiku-primed "facts" session (bound-AC list + touched paths), never dev's reasoning transcript. Net ≈ 42k tokens/story saved.

**Per-stage budget ceilings (200k window), enforced by the context-budget audit:** Orchestrator ~55k (from ~90k), Dev ~45k (from ~85k), Review ~32k (from ~60k), Compile ~22k (from ~55k) — aggregate **~40–50% context reduction per story-cycle**, concentrated on dev full-file reads + compile re-reads.

**Tests:** content-cache hit/miss/corruption/invalidation; context-budget bucketization; session-thread resumeArgs (empty stage-1, populated stage-2, facts-only review); compaction soft@160k/hard@190k/RECENT=10 boundary; `minilm.topK` RRF ordering; golden per-stage budget snapshot (CI fails on >10% regression); reviewer-independence regression (facts-only review still flags a planted bug); compaction fidelity (no path/AC-id loss).

### 5.4 Gating + cost + safety spine (the deterministic differentiator)

**Three-layer defense-in-depth, all kept:** admission (`prework-gate.mjs` + `concurrency-manager.admit`) → live (`pretool-gate.mjs`, in-turn) → backstop (`scope-violation-detector.mjs` + `enforceWaveBudgetGate`). The live gate **reuses `detectScopeViolations`** so pre-write == post-hoc audit byte-for-byte.

**New:** `daemon/lib/pretool-gate.mjs` (promoted spike + `resolvePolicyForTarget` + `sweepStaleMemos`), `gate-policy-writer.mjs` (drops `.futurator/gate-policy.json` into each worktree root — the filesystem-carried SubagentStart-equivalent for per-story scope), `cost-tracker.mjs` (immutable frozen, `.add` returns new, `.overBudget`/`.warnThreshold`), `harness-cost-bridge.mjs` (`readHarnessCost`/`reconcile` over `/tmp/harness-cost-{sessionId}.json`), `daemon/hooks/statusline-cost.mjs` (writes authoritative per-process spend each turn + Stop-flush), `daemon/hooks/posttool-ceiling.mjs` (PostToolUse: warn at 0.8×, write `.futurator/halt` at ≥ceiling), `model-router.mjs` (`selectModel`), `gate-ledger.mjs` (append-only `gate-events.jsonl` + `rollupGateStats`), `gate-memo-sweep.mjs` (30-min TTL).

**Modified:** `epic-dev-pipeline.mjs` (L255/L301 — inject `--settings gate-settings.json` registering PreToolUse `Edit|Write|MultiEdit|Bash` + statusLine + PostToolUse hooks; gate/cost env; reconcile cost on `result`); `role-policy.mjs` (L206 — delegate `model` to `selectModel`); `cost-meter.mjs` (L27/L113 — `source` dedup, mid-turn `decideAction`); `agent-daemon.mjs` (mid-turn ceiling kill via `.futurator/halt` watch reusing the L5546–5603 story-mark+attention path; reconcile before `enforceWaveBudgetGate` reads `totalCostUsd`); `concurrency-manager.mjs` (L111 `admit` refuses over-budget acquisition, never lowers `maxConcurrent`); `prework-gate.mjs` (L55 compose cost skip).

**The ~10× under-report fix:** every Claude process (orchestrator + subagents) runs `statusline-cost.mjs`, writing its own spend to `/tmp/harness-cost-{sessionId}.json`; `reconcile` sums all files in the session tree, dedups by sessionId, and writes the true total to `costSoFarUsd` — which `enforceWaveBudgetGate` then reads, so the hard ceiling fires on real spend. The hard ceiling is **mid-turn** (PostToolUse sentinel) not just at the wave boundary.

**Model routing (WITHIN Max):** DEV/TEST trivial→`claude-haiku-4-5`; medium/large or >10 000 chars / >30 items→`claude-sonnet-4-6`; orchestrator + production-rigor review→Opus. A throughput/quality lever, not a per-token cut. Confirm current model IDs via the `claude-api` skill at wire time — do not hardcode from memory.

**audit→enforce rollout:** (1) `audit` on one canary epic, ledger `would-block` only; (2) grep would-blocks by tier/factor, confirm zero false-positives (esp. `infra-file` on `package.json` during installs → allowlist refinement); (3) flip one story to `enforce` via its policy file, confirm post-diff scope-AC failures drop toward 0; widen. Kill switches at every level: `mode:off`, `FUTURATOR_HOOKS_DISABLED=1`, remove `--settings`; **fail-open** by contract (exit 0 allow, exit 2 block→self-correct, other→fail-open; 5s timeout).

**Per-story scope decision:** Phase-1 ships **coarse** (epic-level `forbiddenAreas` + risk-tier live; per-story `touchPoints` stay at the post-diff backstop). Per-story precision lands in Phase 3 via the worktree-carried `gate-policy.json` (`resolvePolicyForTarget` walks up from the tool target). Do **not** block gate rollout on the worktree workstream.

**Tests:** `cost-tracker` immutability + boundary; `model-router` threshold table; `harness-cost-bridge` dedup/corruption-as-miss/missing-file fail-open; `resolvePolicyForTarget` walk-up precedence; `sweepStaleMemos` mtime cutoff; port the spike's 8 gate tests; pre==post parity vs `detectScopeViolations`; `mode:audit` never returns exit 2; `FUTURATOR_HOOKS_DISABLED=1` short-circuits.

### 5.5 Completion + verification + learning loop

**Pillar 1 — Bound-AC = deterministic completion.** Partition ACs into deterministic (test-bound) vs advisory (taste/security). `completion-gate.mjs` (`classifyAcs`, `evaluateCompletion`, immutable `bindAc`): a deterministic AC passes iff `testBinding.status === 'passing'` AND `lastRunSha === currentHeadSha` (staleness guard reuses the merge SHA); `advisory-security` reviewer fail blocks; `advisory-taste` reviewer fail becomes operator `attention`, never a retry; any `needs-human` escalates. `test-binding-runner.mjs` dispatches by `kind` (unit→vitest filter, visual/probe→existing harness, lint/typecheck→`cached-tsc.mjs`+eslint), content-hash-cached. The reviewer is still spawned but **advisory and non-blocking** (kills triple-fails). Wired into `review-criteria-parser.mjs` aggregation (new `aggregateWithBindings` alongside the old path), `wave-merge.mjs` (`classifyWaveMergeOutcome` only merges a story whose deterministic ACs all pass at the merge SHA), `done-detector.mjs` (binding completion contract), `epic-dev-pipeline.mjs` (inject `acClass`/`testBinding` so DEV writes the minimum to pass). Retry prompt carries only failing-test detail.

**Pillar 2 — QA delivery-journey verification on merged PLAN.** Mostly assembly — `qa-delivery-selector.ts` (`selectDeliveryTests`) and `qa-author.ts` (`launchPlanQaAggregate`) exist. New `delivery-verifier.ts` (`prepareDeliveryRun`→select+compile journeys; `assembleDeliveryVerdict`→`delivered|send-back|accept-with-notes`, aligning with the operator's send-back-for-render-bugs / accept-for-interaction-gated-false-negatives model). New `seam-mount-gate.mjs` (promote `seam-mount-check.mjs`): deterministic grep that each journey's `__harness`/snapshot seam is wired in the merged bundle before any browser spawn (`SEAM_UNMOUNTED` blocks cheaply). On `send-back`, `vqa-triage-router.mjs`/`wave-vqa-fix-story.mjs` mint a fix story whose ACs reuse the Pillar-1 `testBinding`, re-entering the bound-AC gate — not a blanket re-QA. Schema: `DeliveryVerdict`/`JourneyResult` in `qa-report.ts`; PM authors `deliveryJourneys[]`.

**Pillar 3 — The learning loop (closes the IAM-blocked reflector).** Stop having an LLM author privileged CLAUDE.md/skill mutations; instead capture deterministic observations and promote them as **data the spawn reads**, not repo writes. Lifecycle `observe → distill → score → evolve → promote → inject`: `posttool-observe.mjs` (PostToolUse sibling on the gate's plumbing → `observations.jsonl`: `{session,role,tool,target,riskScore,gateTier,scopeViolation,exitOutcome,sha}`); `instinct-distiller.mjs` (pure frequency reducer → scored candidate instincts); `instinct-store.mjs` (immutable scoring, `activeInstinctsFor({role,touches})`); `instinct-promote.mjs` (high-confidence → Mycelium `Instinct` nodes via `graph-sync.mjs`/`propagator-ingest.mjs`, with `DERIVED_FROM`/`CONSTRAINS` edges — a graph write, no IAM privilege); `instinct-injector.mjs` (ponytail single-source builder + SubagentStart adapter splices active instincts into spawn args). Instincts carry `enforcement: advisory|gate|test` so a learned rule can graduate from prompt nudge → live `pretool-gate` deny delta → auto-attached bound AC. Reframe `reflector-runner.mjs` to distill first (LLM enrichment advisory-only); `reflection-apply-poller.mjs` gains an `instinct` branch (no `resolveWorkingDir` dependency → unblocks the rows that SKIP forever).

**Deferred (Phase 5 seams designed now):** `review-complexity-gate.mjs` (route trivial deterministic ACs around the reviewer entirely — composes with Pillar 1, effort S, do early if reviewer cost bites); `gan-evaluator.mjs` (adversarial critic that can only ADD a bound `testBinding`, never flip a pass without a reproducing test — feeds the instinct loop).

**Tests:** completion-gate truth table (all-passing→pass, one-unbound→fail, stale-SHA→fail, advisory-taste→pass+attention, advisory-security→block, needs-human precedence); test-binding-runner kind dispatch + cache-hit; `aggregateWithBindings`; delivery-verifier selection→verdict + send-back mapping; seam-mount unwired-blocks-before-spawn; instinct-distiller frequency→confidence; instinct-store threshold gating; instinct-injector parent/subagent parity.

---

## 6. Optimization budget table

Effort: S ≤ ~1 day, M ≈ 2–4 days, L ≈ 1–2 weeks. Wins are vs the named forensics pain.

| #   | Lever                                            | Goal(s)                   | Stage          | Donor / spike                        | Effort              | Expected win vs named pain                                                    |
| --- | ------------------------------------------------ | ------------------------- | -------------- | ------------------------------------ | ------------------- | ----------------------------------------------------------------------------- |
| 1   | Live PreToolUse gate                             | parallelism, token, time  | Dev            | pretool-gate spike (BUILT)           | S                   | landed scope-AC failures → ~0; kills bypassPermissions + post-hoc-only gating |
| 2   | Hard cost ceiling + harness-cost bridge          | token, cost-observability | Dev/cross      | ecc cost-aware-llm SKILL             | S–M                 | ~10× under-report → accurate; soft ceiling → hard mid-turn                    |
| 3   | Ready-frontier Kahn dispatch                     | time, parallelism         | Schedule       | ecc epic-unblock sweep               | M                   | 2–5 min inter-wave dead time → <30s → ~0                                      |
| 4   | Worktree lock-SHA dep-cache + merge-tree + queue | parallelism, time         | Dev/Integrate  | ecc2 worktree/mod.rs                 | L                   | ~47% compile thrash + index.md race + OOM, no concurrency drop                |
| 5   | Bound-AC completion gate                         | time                      | Verify         | SDD task-unit analysis               | M                   | reviewer triple-fails / subjective "done" → deterministic                     |
| 6   | Instinct learning loop                           | learn                     | Learn          | ecc instinct loop                    | L                   | reflector IAM dead-end (proposals written, 0 applied) → graph-promoted        |
| 7   | AC-aware laziness injection                      | token, time, context      | Dev            | ponytail spike (BUILT)               | S                   | −54% LOC / −20% cost / −27% time vs over-build cascade                        |
| 8   | Session reuse + compaction                       | context, token, time      | Dev/Compile    | jcode compaction + KV                | L                   | 30s cold-start ×3 + ~27k cache ×3 → ~42k tok/story; bounded 200k              |
| 9   | Model routing (WITHIN Max)                       | token, throughput         | Dev            | ecc model routing                    | S                   | 3–4× cheaper trivial work; Opus reserved for orchestrator/prod-review         |
| 10  | Provider-agnostic adapter seam                   | portability               | cross          | ponytail single-source/multi-adapter | M                   | OpenCode/overflow valve; classify failover by regex, no LLM latency           |
| 11a | Context-budget audit                             | context                   | cross          | ecc context-budget SKILL             | S                   | reclaim context headroom; trim ~500 tok/unused MCP tool                       |
| 11b | Content-hash cache                               | context, token            | Compile/Verify | ecc content-hash-cache SKILL         | S–M                 | repeated-scan tax across dev/compile/extract                                  |
| 12  | Local ONNX MiniLM top-k                          | context                   | Dev            | jcode tract/MiniLM                   | M (L if host-gated) | ~24k tok/dev spawn vs full-file reads                                         |
| 13  | Admission tokens                                 | parallelism               | Schedule       | jcode/ecc admission                  | S                   | OOM stopgap without lowering concurrency                                      |
| 14  | Delivery-journey QA + seam-mount gate            | quality, time             | Verify         | existing qa-selector/author          | M                   | re-litigated per-AC QA + unwired-app-reaches-QA                               |

### Phase-1 quick-win subset (S/S-M, attack named pains immediately)

Gate audit (1) · ponytail wire (7) · cost bridge + ceiling + routing (2,9) · context-budget audit (11a) · content-hash cache (11b).

---

## 7. Phased roadmap

Dependencies: gate-spine → bound-AC (gate enforces the `touches` the AC contract defines) → ready-frontier (needs deterministic "done") → worktree-cache (per-story isolation makes continuous dispatch safe). Session-reuse `full` is blocked on the reviewer-independence question. Everything coexists with the current daemon via `daemon/lib/pipeline-flags.mjs` (env-sourced, default OFF, deterministic per-epic bucketing `sha256(flag|epicId)%100 < pct`, resolved flag-set frozen onto `job.p3Flags` at claim) and the `metrics-csv.mjs` p3 channel as the A/B substrate. **Never delete a legacy path until its replacement runs `on` at 100% for two weeks with green A/B.**

| Phase            | Ships                                                                                                                    | Flag / first mode                                      | A/B method                                                                                              | Coexistence / fallback                                                       | Effort |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| **0 — built**    | `pretool-gate` spike (green, 8 tests); `ponytail` spike (green)                                                          | n/a (promote only)                                     | n/a                                                                                                     | spikes only, nothing wired                                                   | done   |
| **1A**           | Promote gate → `daemon/lib/pretool-gate.mjs`, live PreToolUse hook, reuse `detectScopeViolations`, `gate-memo-sweep` TTL | `P3_GATE_MODE=audit` on `P3_EPIC_ALLOWLIST=<1 canary>` | shadow-counterfactual: ledger `would_block` vs post-hoc detector; flip enforce at 0 false-positive      | admission + backstop layers kept; `=off` env flip                            | S      |
| **1B**           | Promote ponytail → `inject-lazy.mjs`, spread `lazyArgs` at L255, SubagentStart adapter                                   | `P3_LAZY_MODE=full` at `P3_ROLLOUT_PCT=50`             | split-test 50/50 matched epics; LOC/tokens/time, no AC-pass regression                                  | legacy = no lazy args; `=off`                                                | S      |
| **1C**           | Harness-cost bridge (observe), immutable `CostTracker`, model routing, mid-turn ceiling                                  | `P3_COST_CEILING=observe` ≥1 wk → `enforce`            | observe exposes ~10× gap, recalibrate baseline; ceiling = p90 real                                      | wave-boundary gate kept as backstop; de-escalate to `observe`                | S–M    |
| **2A**           | `ready-frontier.mjs` + `story-graph.mjs` + atomic claim; demote WaveCompletionCheck to a nudge                           | `P3_READY_FRONTIER=shadow` → `on`                      | shadow logs would-dispatch vs legacy waves; on when dead-time saved, no dep-order violation             | legacy wave reducers behind flag                                             | M      |
| **2B**           | `plan-spec` contract + `plan-spec-graph` table + ingest; `completion-gate` bound-AC; `<BINDING>` parser                  | `P3_BOUND_AC_GATE=shadow` → `on`                       | parallel-judge: subjective reviewer + bound-AC, log disagreement; on when bound-AC ≥ reviewer on canary | subjective reviewer kept; `=off`. **Resolve AC-binding-timing before `on`.** | M      |
| **3A**           | Worktree dep-cache (extend `story-worktree.mjs`/`node-modules-store.mjs`) + `merge-tree` predict + merge-queue           | `P3_WORKTREE_CACHE=on` low-pct **after host spike**    | mandatory 1-wave EC2 spike (compile time + fs corruption); then low-pct                                 | shared workspace fallback; `worktree-reaper.mjs` GC; `=off`                  | L      |
| **3B**           | Session reuse + finish `compactor.mjs` + split prompt                                                                    | `P3_SESSION_REUSE=dev_compile` only                    | dev→compile arm vs off; **`full` blocked** on reviewer-independence                                     | fresh-spawn review retained; `=off`; `P3_COMPACTION=off`                     | L      |
| **4**            | Instinct loop (observe→distill→promote→inject); adapter seam shape                                                       | observe-only first                                     | disagreement / promotion-precision logged                                                               | proposals stay write-only if disabled                                        | M–L    |
| **4-def**        | Local ONNX MiniLM top-k                                                                                                  | gated behind host fix                                  | sidecar RSS + p95 soak on t2.micro-equiv                                                                | raw-file-read fallback                                                       | M/L    |
| **5 — deferred** | GAN evaluator, complexity-only review, council, scorecards, harness matrix                                               | inspiration-only                                       | —                                                                                                       | —                                                                            | —      |

**Execution order:** (1) `pipeline-flags.mjs` + p3 metrics channel + additive `job.p3` schema (unblocks all, S); (2) 1A audit → 1B lazy-50% → 1C observe, run 1 week for real baselines; (3) flip 1A→enforce + 1C→enforce + 1B→100% if green; (4) 2A shadow→on, 2B shadow→on (after AC-binding resolved); (5) worktree host spike → 3A low-pct; 3B dev→compile only; (6) Phase 4; defer ONNX + Phase 5.

---

## 8. Success metrics — baselines & targets

Measured via the `metrics-csv.mjs` p3 channel; "win" = flagSet-off vs flagSet-on on matched epics (complexity bucket = story count × avg AC), n≥4/arm, median + IQR, no single-epic claims.

| Metric                  | Baseline (forensics)                                  | Phase-1 target                   | Phase-3 target                     | Lever | Measurement                                           |
| ----------------------- | ----------------------------------------------------- | -------------------------------- | ---------------------------------- | ----- | ----------------------------------------------------- |
| $ / epic                | **~10× under-reported** (~$14 reported vs ~$147 real) | accurate + hard ceiling          | −30% real                          | 1C    | `/tmp/harness-cost-{id}.json` vs internal meter delta |
| Tokens / epic           | ~27k cache re-paid/stage, no reuse                    | −20% (laziness)                  | −50% (laziness+session+compaction) | 7,8,9 | sum stream-json usage per epicId                      |
| Wall-clock / epic       | inter-wave dead 2–5min×N + 30s cold-start×spawns      | inter-wave <30s                  | −40% total                         | 3,8   | claim→merge timestamps                                |
| Compile thrash %        | **~47% of epic wall-clock** + index.md race           | −25% (consolidated wave-compile) | <10% (worktree cache)              | 4     | compile-stage time / epic time                        |
| Inter-wave dead time    | 2–5 min × waves                                       | <30s                             | ~0 (continuous Kahn)               | 3     | gap last-story-done → next-dispatch                   |
| Scope-violations landed | post-hoc only                                         | ~0 would-block leak (audit)      | 0 landed (enforce)                 | 1     | gate `would_block` vs post-hoc detector hits          |
| Reviewer rounds / story | triple-fails (inconsistent)                           | measured; −1 round               | deterministic                      | 5     | review spawns per storyId                             |
| Host saturation (OOM)   | t2.micro OOM under parallel                           | 0 at same concurrency            | 0                                  | 4,13  | OOM counter; concurrency never lowered                |

---

## 9. Risks · mitigations · rollback

| Change               | Risk                                                                         | Mitigation                                                                                                                    | Rollback                                         |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Gate enforce         | fact-force memo no-TTL stale-blocks legit retries; over-block stalls dev     | `gate-memo-sweep` 30-min TTL before scale; fail-open contract; audit-first                                                    | `P3_GATE_MODE=off` (per-job env, no redeploy)    |
| Laziness             | under-builds → AC fails → more review                                        | AC-pass regression is the A/B kill-switch; `lite` below `full`                                                                | `P3_LAZY_MODE=off`                               |
| Cost ceiling enforce | wrong baseline hard-kills legit epics                                        | observe-mode recalibrates real baseline; ceiling = p90 real                                                                   | `P3_COST_CEILING=observe` (de-escalate, not off) |
| Ready-frontier       | cycle / missed dep → out-of-order dispatch                                   | code-enforced cycle detection at ingest + dispatch; shadow-diff vs legacy first                                               | `P3_READY_FRONTIER=off` → legacy waves           |
| Bound-AC gate        | binding-timing unresolved → false "done" on unbound AC                       | treat `unbound`/`bound` as NOT-done; shadow vs reviewer disagreement gate                                                     | `P3_BOUND_AC_GATE=off` → subjective reviewer     |
| Worktree cache       | t2.micro fs corruption under concurrent symlinked node_modules; disk blowout | mandatory 1-wave host spike; read-only-deps symlink by construction; SHA-mismatch → independent dir; `worktree-reaper.mjs` GC | `P3_WORKTREE_CACHE=off` → shared workspace       |
| Session reuse        | reviewer judgment contamination via shared KV (Med-High)                     | block `full`; dev→compile only; review stays fresh spawn                                                                      | `P3_SESSION_REUSE=off`                           |
| Compaction           | over-compacts, drops load-bearing context                                    | RECENT=10 verbatim floor; apply only to compile/context-assembly                                                              | `P3_COMPACTION=off`                              |
| Saturation fixes     | temptation to lower concurrency                                              | **hard constraint: never lower concurrency**; worktree cache (root) + admission tokens (stopgap); real root = bigger host     | revert admission policy, keep concurrency        |
| Reflector loop       | IAM block on direct proposal apply                                           | deterministic instinct capture → graph nodes, sidestep apply                                                                  | leave proposals write-only (current state)       |
| Multi-table claim    | non-atomic claim races multi-host / on restart                               | atomic conditional `UpdateExpression` + lease + `stale-heartbeat` reclaim                                                     | `FRONTIER_ATOMIC_CLAIM=off` → in-process guard   |

---

## 10. Honored constraints + open questions

**Operator constraints → concrete decisions:**

- **Ship MVP, add complexity later** → graph MVP unit = story + bound AC + `depends_on` + `touches`; the 12-edge Mycelium governance registry, GAN/council/scorecards/harness-matrix are deferred to Phase 5.
- **Preserve parallelism (fix the real root, never lower concurrency)** → `MAX_CONCURRENT` untouched everywhere; saturation fixed structurally by worktree dep-cache (no N-fold `node_modules`) and shaped by `canAdmit` admission tokens (timing only); ready-frontier dispatches _more_ eagerly than waves. Real root = bigger host.
- **Proper fix over shortcut** → reflector closed by building the instinct loop (not auto-bypassing the IAM block); unwired apps caught by the seam-mount gate (not skipping QA); per-story scope built via worktree policy file (not dropping the gate).
- **Deterministic gating is the differentiator (LLM advisory)** → every dispatch/scope/completion/cost/promotion verdict is a pure function; the reviewer is non-blocking except `advisory-security`; LLM only authors the fact-force self-correct message and the compaction summary.
- **Stay on Max** → model routing optimizes throughput/quality WITHIN Max (confirm IDs via `claude-api` skill); multi-provider failover is an overflow valve + OpenCode seam classified by regex (429/auth/413), not a per-token cost move.
- **DynamoDB multi-table = source of truth** → new `plan-spec-graph` table (one concern); `agentJobs`/`agent-sessions` extended additively; claims are atomic conditional writes (beats ecc non-atomic GitHub-issue claim).

**Open questions to resolve with the operator (each blocks a specific flip):**

1. **Reviewer independence vs session-reuse KV** → blocks `P3_SESSION_REUSE=full`. MVP ships dev→compile only; review fresh. Resolve whether facts-only review is acceptable to reclaim the review-stage win.
2. **AC binding promotion point** (Spec-unbound → shard → code-bound) → blocks `P3_BOUND_AC_GATE=on`. MVP binds at story-context assembly; confirm Mycelium doesn't bind at Spec.
3. **`plan_spec` ↔ `spec_shard` authority on conflict** (block contradicting idea vs supersede with approval) → a Concept-stage Mycelium policy; the contract only carries `contentHash` so drift is _detectable_.
4. **Worktree symlink safety on t2.micro** under parallel writes → blocks `P3_WORKTREE_CACHE` rollout until the 1-wave host spike.
5. **Model routing under Max** (subscription vs per-token) → reframes $ targets as observability-first; confirm prompt-cache maps onto CLI spawns.
6. **Local ONNX footprint on OOM-prone host** → Phase-4 ONNX deferred behind the host fix / sidecar validation.
7. **fact-force memo TTL at scale** → `gate-memo-sweep` (30-min) mandatory before enforce-at-scale; no-op risk in audit.

---

_End of plan._
