# Pipeline v3 — Dynamic-Workflow Orchestration (Concept Spec)

Status: **CONCEPT / FOR-DEBATE (2026-06-18)**
Author intent: this is a _concept spec_ to be stress-tested into a detailed PRD in a
later session. Decisions marked **[CHOSEN]** are the operator's current lean; all
alternatives are kept visible on purpose so the PRD can re-open them.

Composes with (does **not** supersede):

- `system-graph-prd.md` — graphify/tree-sitter/Leiden MCP graph explorer (the discovery + governance substrate; **soft dependency** here)
- `vqa-qa-review-prd.md` / `vqa-qa-review-redesign.md` — the visual-QA redesign
- `concept-stage-v2-bmad.md` — the BMAD concept stage that emits the parallelizable plan v3 consumes
- `../pipeline-v2/multi-host-dispatch-readiness.md` — the v4 fleet dispatcher (shares this doc's durable spine)
- `../dynamic_workflows/` — the operator's prepared case: `workflow-authoring-SKILL.md` (invariants I1–I9), `workflow-lint.mjs` (C0–C9), `lint-and-launch.sh` (Layer-3 gate), `dynamic-workflow-replays.jsx` (WF-1/2/3 replay study)

---

## 0. One-sentence thesis

**Pipeline v3 is a thin, swappable JavaScript-workflow orchestration layer that replaces
the brittle LLM epic-orchestrator and the cron-polled wave wall — running _over_ the
unchanged durable spine of DynamoDB job/event rows + git SHAs + `.pipeline/` evidence —
where inter-agent trust moves from parseable text conventions to typed values sealed by
git SHAs, and tests/ACs are protected by _blindness + a merge-time SHA gate_ rather than
by hope.**

It is **hybrid, not a replacement**: bash/daemon keeps durability, OS-level enforcement,
git authority, and (later) cross-host dispatch; the JS workflow owns in-session
orchestration and the information firewall. The seam between them is a set of explicit
**gates** — and the operator's own `lint-and-launch.sh` is already one of them.

---

## 1. The hybrid distribution of concerns (the core design)

The operator's instinct to use bash for "controlled agentic sessions" is correct and is
preserved. Dynamic workflows do **not** subsume bash; they take the one job bash is worst
at — holding a stateful, branching orchestration plan that an LLM currently holds in a
context window it overflows and disobeys.

| Concern                                                                                           | Owner                            | Grounded reason                                                                                                          |
| ------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Durable state; cross-session survival; cross-host code truth                                      | **daemon + DynamoDB / git / S3** | Workflows have **no cross-session journal** (see §3). Invariant I8: "assume the instance can die any minute."            |
| OS-level enforcement (deny-lists, `chmod`, SIGTERM, hooks)                                        | **daemon (bash)**                | `bash-deny-patterns.mjs`, `git-deny-list.json`, hook scripts — policy-as-physics lives _below_ the model                 |
| Git authority: worktree CAS, merge, trunk push, **test-SHA gate**                                 | **daemon (bash)**                | `wave-merge-runner.mjs:1177-1191` (atomic `update-ref` CAS). Must be durable + unfakeable, not ephemeral JS              |
| Multi-host dispatch (v4)                                                                          | **daemon + queue**               | One workflow = one host, 16 concurrent. Fleet scheduling is a control-plane concern (`multi-host-dispatch-readiness.md`) |
| In-session orchestration: readiness DAG, fix tournaments, refuter-before-merge, per-class routing | **JS workflow**                  | Deterministic, zero-context, **cannot disobey** `maxParallel`; replaces the LLM orchestrator                             |
| Information firewall (blind-dev: exactly what enters each prompt)                                 | **JS workflow**                  | The script composes prompts; disk is readable, terminals can't enforce this                                              |
| Typed handoffs between agents within a run                                                        | **JS workflow**                  | Replaces fragile sentinel-regex extraction (`runExtractors`, `agent-daemon.mjs:688-723`)                                 |

**The gates (handoff points between the layers):**

1. **Launch gate** — daemon sets up worktrees + DDB job rows, then `lint-and-launch.sh`
   structurally lints (`workflow-lint.mjs` C0–C9) + Haiku-semantic-reviews the generated
   script, copies it immutably, and launches it with the plan passed as `args`.
2. **Telemetry gate** — at every phase boundary, each agent step emits an `AgentEvent`
   (`stepId/role/cost/durationMs`) that the daemon persists to DynamoDB. Non-negotiable
   (see §9 Hard Constraints) — the Plan Retrospect scorecard reads these.
3. **Merge gate** — the workflow _proposes_ a candidate (a git SHA); the **daemon's
   CAS + test-SHA check is the authority that lands it**. The workflow cannot push to
   trunk (I9 + durable git layer).
4. **Death/resume gate** — on a clean finish, the workflow's final report → daemon. On
   session death, the daemon resumes from DDB checkpoints, **never** from lost JS state.

---

## 2. Grounded v2.5 baseline (what actually runs today)

From a 7-agent codebase investigation (2026-06-18). These are the real enforcement points
v3 must replace or interoperate with.

- **Two execution paths.** (a) Per-story linear `runPipeline()` step loop
  (`agent-daemon.mjs ~L2740`); (b) the **epic-orchestrator** path
  (`epic-dev-pipeline.mjs`) — a **single long-running Claude session** that manages the
  whole wave DAG via the Task tool, spawned with `--permission-mode bypassPermissions`,
  **no `--max-turns`**, and `maxParallel=4` enforced **only as a prompt instruction**
  (`epic-orchestrator-prompt.md.tpl:40`). This is the brittle core v3 targets — it is a
  textbook **Disobey-Task-Specification** surface (MAST, [arXiv:2503.13657](https://arxiv.org/abs/2503.13657), 11.8% of failures).
- **The wave wall is a polling hack.** `wave-reducer.ts` (`reduceEpicWaves`, L103) refuses
  to launch wave N+1 until **every** current-wave job row is terminal (L161-165), nudged
  by `triggerWaveReduce()` + a cron backstop. Readiness is **binary** (`done`/`failed`) —
  there is no contract-stable/tests-passing tier. (WF-1 is therefore net-new.)
- **Spawn:** `claude -p --output-format stream-json --model X --allowedTools …
--max-turns N --append-system-prompt …` (`runAgent`, L869-937). **No extended-thinking
  flag exists** — effort is injected as prompt keywords. **OAuth/Max only** (API key
  stripped from env, L934-936) → the cost model is a flat subscription, not per-token.
- **Handoffs are sentinel text.** `runExtractors` (L688-723) regex/`between`-extracts
  `---WORK_SUMMARY---`, `---REVIEW_CRITERIA---`, `---PLAN_JSON---`, etc., and substitutes
  `{{VAR}}` into the next prompt. A partial output (OAuth cut mid-stream) **silently
  yields no variable**.
- **No atomic test snapshot.** Protection is only the post-hoc `scope-violation-detector`
  (diffs modified files against `story.touchPoints`/`forbiddenAreas` globs — easy to omit)
  plus a prompt label calling tests "immutable contracts" (`story-context-pack.mjs:434`),
  plus VQA's `git reset --hard` if an evidence agent dirties the candidate
  (`wave-vqa-runner.mjs:455`). **No SHA gate, no path read-deny, no `chmod`/`chattr`.**
- **Fix loop is serial, single-fixer, no escalation** in the story pipeline
  (`maxIterations=3`, `story-pipeline.ts:221`; loop at `agent-daemon.mjs:3340-3469`). Only
  the **wave-gate VQA fixer** escalates (round 1 Sonnet → round 2 Opus,
  `agent-daemon.mjs:4575-4582`). (WF-2 generalizes escalation.)
- **Concurrency is small.** Daemon `ConcurrencyManager` default `MAX_CONCURRENT=2`
  (host-gated to 2 under 3 GB RAM). Orchestrator `maxParallel=4` is a _prompt instruction_.
  **There is no 32-capacity supervisor.** → The workflow runtime's 16-concurrent cap is an
  **upgrade**, not a constraint, relative to today's effective width.
- **Worktrees + git.** `git worktree add -B wip/<storyId>` from bare repos at
  `/home/ubuntu/repos/<appId>.git`; throwaway `_cand/<jobId>/` scratch for wave-merge;
  sequential `--no-ff` merges; **atomic CAS** `git update-ref refs/heads/plan/<slug>
<cand> <green>` (`wave-merge-runner.mjs:1181`). Force-push already denied
  (`git-deny-list.json`).
- **Telemetry the scorecard depends on.** `StepResult` carries
  `durationMs/cost/inputTokens/outputTokens/contextWindow/numTurns/model`; `AgentEvent`
  rows carry `cost/durationMs/sessionId`; `TimerSlice` is derived. Scorecard criteria
  already measure the replay inefficiencies: **D-WS1** (parallelism factor / wave-wall
  idle), **D-CC1/D-CC3** (compile thrash / share), **D-VQ3** (wasted fix rounds), **OV4**
  (cost reconciliation, walks the `retryOf` chain).

---

## 3. Hard runtime facts about dynamic workflows (and the risk)

From the canonical docs (`code.claude.com/docs/en/workflows`, fetched 2026-06-18):

- **Concurrency:** up to **16** agents concurrent (fewer on low-CPU hosts); **1,000**
  agents total per run (runaway backstop).
- **No mid-run user input.** Only permission prompts pause a run. **Each human sign-off
  stage must be its own workflow.** → epic/plan-level approvals stay in the daemon.
- **The script has no filesystem/shell access** — only agents read/write/execute. The JS
  coordinates; it cannot itself touch git or disk. (This is _why_ the merge-SHA gate must
  live in the daemon, not the script.)
- **Resumability is within-session only.** Paused runs resume with completed agents
  returning cached results. **There is no cross-session journal** — exit Claude Code and
  the next session starts fresh. **Intermediate results live in JS variables, not a
  persistent store.** This is the single most load-bearing constraint: **the workflow is
  working memory, never the record.**
- **Worktree isolation is opt-in** (`isolation: worktree` in a subagent def, or a natural
  instruction), branching from `origin/HEAD` by default — set `worktree.baseRef: "head"`
  to branch from local HEAD (required, since v3 uses local bare-repo branches).
- **Subagents always run `acceptEdits`** and inherit the tool allowlist; per-agent tool
  restriction is via subagent/custom-agent frontmatter.
- **Only the final report returns to the orchestrator's context** — intermediate agent
  outputs never inflate it. This is the property that makes the JS orchestrator immune to
  MAST's orchestrator-context failure modes by construction.

**⚠ Risk to log (undocumented API):** the public docs describe behavior but **do not
expose** the `agent()/parallel()/pipeline()/phase()` signatures or the structured-output
schema. v3 is coupling to undocumented runtime internals that can change between Claude
Code versions. **Mitigation:** keep all durable contracts (DDB schema, git-SHA gates, the
structured handoff envelope) **independent of the exact primitives, behind a thin adapter**
(`v3-workflow-adapter`), so a CLI bump cannot break the pipeline.

---

## 4. The three replay workflows, mapped to real enforcement points

The operator's `dynamic-workflow-replays.jsx` projects three patterns against the
horse-runner1 run (47m, 8/10 stories, E4 never started, E3 26m fix stall, compile 24.3%,
169k tok, $8.32). Grounded:

- **WF-1 Readiness Cascade** — replace the binary wave wall (`wave-reducer.ts`) with a
  per-story **readiness tier** held in JS: `contract-stable` (DEV committed types/sigs) →
  `tests-passing` (build-check green) → `reviewer-approved`. Dependents launch the instant
  their _required_ tier is met, not when the slowest sibling is fully done. Projected
  47m → ≈26m; E4 idle 47m → 0m. **MVP note:** the full cascade needs cross-wave
  orchestration in one script (see §5).
- **WF-2 Fix Swarm** — replace the serial single-fixer loop (`agent-daemon.mjs:3340`) with
  a bounded parallel tournament: triage → N hypotheses → N fixers in **scratch worktrees**
  (`isolation: worktree`) → N **refuters** (I3) → vote → merge; escalate model tier on
  round 2, operator on exhaustion (I6). Generalizes the escalation that today only the VQA
  fixer has. Projected E3 26m serial → ≈9m parallel.
- **WF-3 Adaptive Router** — one-shot Haiku classifier → **per-class chain** (types-only:
  dev-haiku + tsc; visual: dev + VQA; logic: test-author-first + dev + property-tests);
  **batched compile per merge-group** instead of per-story. Projected compile 13m18s → ≈4m.

All three compose into one production-wave script — which is exactly what the JS
orchestrator is _for_.

---

## 5. Scope-unit analysis — how big is one workflow run? **[CHOSEN: per-wave MVP]**

This is the central structural decision. It trades blast-radius / session-death risk
against how fully WF-1's cross-wave cascade can be realized.

### Per-wave (one workflow orchestrates the stories of a single wave + its merge gate)

- **Pros:** smallest blast radius; best fit for ephemeral state (a wave is minutes, not
  hours — survives within one session); maps cleanly onto today's wave-merge boundary;
  directly replaces the brittlest unit (the orchestrator's intra-wave Task fan-out); easy
  head-to-head vs v2.5 wave-by-wave; respects "ship MVP, add complexity later."
- **Cons:** **cannot realize WF-1's cross-wave cascade** — releasing wave N+1 dependents
  early needs cross-wave state in one script. Inter-wave sequencing stays in the daemon
  (the cron wave-reducer remains, demoted to "advance when the wave-workflow reports
  done"). So the headline 47m→26m projection is _partially_ captured (intra-wave
  parallelism + fix-swarm + routing) but the cascade win is deferred.
- **Verdict:** **the MVP.** Captures WF-2 + WF-3 fully and WF-1 _within_ a wave, at the
  lowest risk. The cross-wave cascade becomes the first v3.x increment.

### Per-epic (one workflow orchestrates all waves of an epic)

- **Pros:** **fully realizes WF-1** — readiness tiers cascade across wave boundaries; the
  whole epic DAG is one deterministic plan; the wave wall _disappears_ rather than being
  demoted.
- **Cons:** an epic run can be tens of minutes to hours → much higher exposure to the
  **no-cross-session-journal** constraint. Requires **aggressive DDB checkpointing at
  every readiness/merge transition** so a mid-run instance death resumes from the spine,
  not from lost JS state. The 1,000-agent / 16-concurrent caps are _per run_ — a large epic
  could approach them.
- **Verdict:** **the v3.x target**, once per-wave proves the model and the DDB-checkpoint
  externalization is hardened.

### Per-plan (one workflow orchestrates every epic)

- **Pros:** maximal global coordination (cross-epic resource balancing, global fix-swarm
  prioritization).
- **Cons:** almost certainly collides with the caps and the ephemeral-state risk over long
  runs; a single session holding an entire plan is the wrong granularity for a box that
  "can die any minute."
- **Verdict:** **not now.** Likely never as a _single_ workflow — the plan level is where
  the **daemon + (v4) dispatcher** orchestrate _multiple_ wave/epic workflows.

**Chosen shape:** **per-wave workflow** as the MVP unit; daemon retains epic/plan
sequencing; cross-wave cascade is the first follow-on increment via a per-epic workflow.

---

## 6. Migration — v3 as a parallel, selectable-at-plan-creation pipeline **[CHOSEN]**

The operator's design: **duplicate the running v2.5 pipeline in the codebase and add a v3
workflow pipeline that is selectable at plan-creation**, so both coexist and can be
compared on real plans.

- **Selection:** a `pipelineEngine: 'v2.5-daemon' | 'v3-workflow'` field on the Plan row,
  chosen at plan creation (UI toggle + API default). Both engines write the **same DDB
  job/event schema** and the **same git branch/merge model** → the Plan Retrospect
  scorecard grades them **identically**, enabling true head-to-head (D-WS1 parallelism,
  D-CC3 compile share, D-VQ3 fix waste, OV4 cost — same criteria, two engines).
- **Coexistence boundary:** v3 swaps **only** the epic-dev execution path
  (`executeEpicDevJob` → a workflow launcher); the concept stage (BMAD route/PRD/UX/arch/
  pm-plan), the API, the dashboard, REFLECTOR, and the durable spine are **shared,
  untouched**. This keeps the running v2.5 safe (CLAUDE.md deploy-safety rules intact).
- **Why not big-bang:** couples production to undocumented workflow internals with no
  fallback (§3 risk). **Why not shadow-only first:** slower to value, and the
  selectable-parallel design already gives a controlled, opt-in real comparison without
  endangering v2.5 plans. The operator can run app A on v2.5 and app B on v3 the same hour.
- **Provenance (from `multi-host-dispatch-readiness.md` §3.6):** every v3 commit stamps
  `Pipeline-Engine: v3-workflow` alongside the existing machine/model/Epic-Id trailers, so
  the ledger distinguishes engines forensically.

---

## 7. Test/AC immutability — all tiers visible; **MVP = Tier 1 [CHOSEN]**

The threat is real and quantified: **ImpossibleBench (2025)** reports frontier models cheat
**~92%** of the time when they can _read_ test files (oracle-reading, operator-overloading),
vs ~54% blind; read-only-but-visible does **not** fix it; blindness + an abort mechanism
does. _(arXiv:2510.20270 — to verify before PRD.)_ So the design protects against **three**
distinct lazinesses: test **rewriting**, test **oracle-reading**, and AC **softening**.

### Tier 1 — Blind-dev + SHA-CAS gate **[CHOSEN for MVP]**

- **Blind development (the new capability workflows enable):** the JS script composes each
  agent's prompt, so **DEV receives the contract + ACs but never the test bodies; the
  test-author never sees DEV's implementation.** Terminals can't enforce this cleanly
  because disk is readable; the script-controlled prompt can.
- **SHA-CAS gate (durable, unfakeable):** at the merge CAS (`wave-merge-runner.mjs:1177`),
  before `update-ref` advances `plan/<slug>`, assert **no `**/_.test._`/`**/_.spec._`
  file SHA changed** vs the story's context-pack digest (`story-context-pack.mjs:815`
  already computes digests). A test diff outside the declared TEST step → gate fails, no
  judgment involved. **Lives in the daemon's durable git layer, not the ephemeral script.**
- **AC anti-softening:** ACs live in the **durable story row (DynamoDB)**; DEV _receives_
  them but the authoritative copy the refuter and gate check against is durable state the
  agent cannot mutate. (The existing `AC_CONTEST` abort path — `agent-daemon.mjs:3386` —
  is the "flag impossible" mechanism ImpossibleBench shows cuts cheating ~80%; keep it.)

### Tier 2 — + per-agent path read/write deny (defense-in-depth)

- Add path-scoped deny of `**/*.test.*` (**read and write** — read matters more per the
  research) to a **unified `role-policy` JSON** (today duplicated `.mjs`/`.ts` with a parity
  test — unify to one source). The harness refuses the tool call before model intent
  matters (the Praetorian capability-stripping pattern). Recommended fast-follow.

### Tier 3 — + OS-level `chmod a-w` / `chattr +i` on test paths

- Policy-as-physics, feasible since the operator owns EC2, but the map flags it
  **operationally fiddly**: bare-repo worktrees share objects, you'd `chmod` per-worktree
  test files at `setupStoryWorktree`, conflicting with the `--force` reuse path. **Defer
  unless Tiers 1–2 prove insufficient.**

**Honesty checkpoint (kept in scope):** separate contexts ≠ separate minds. Same-model
test-author + dev share blind spots; a misread AC is misread identically by both. The
_only_ fix is model diversity — see §8.

---

## 8. Governance — 5-layer model; **MVP includes the graph-gate (degradable) [CHOSEN]**

The operator's #1 concern: governed, high-quality code under app standards (architecture,
style, folder structure, type quality, abstraction levels, component-driven design) — that
the dev agent cannot lazily game. v3 makes this a **layered** property:

1. **Meta-gate (deterministic).** `workflow-lint.mjs` (C0–C9) + `lint-and-launch.sh` gate
   the _plan-of-work_ before it runs. _(exists — operator-built)_
2. **Convention gates (deterministic, batched per merge-group — WF-3).** `tsc` strict,
   `eslint --max-warnings 0`, `knip` (dead exports), `prettier --check`, `vitest`. Already
   shell steps; v3 batches them. Unfakeable.
3. **Graph gate (structural) — degradable. [IN MVP, soft dependency]** The story's
   post-merge **graph delta** (graphify/tree-sitter/Leiden, per `system-graph-prd.md`) is
   checked for architectural drift: a new **cross-community edge** (wrong layering), a
   forming **god-node** (abstraction violation), folder-structure / type-quality deviation.
   **Degradation contract:** when the system-graph MCP is available, the gate **enforces**;
   when not, it **fails open to a `⚪ needs-instrumentation` advisory** (the Plan Retrospect
   honesty-guard pattern) — logged, not blocking. So v3 ships _without_ blocking on the
   graph workstream, yet the gate is wired from day one. The **same MCP** also gives DEV
   agents full dependency context (discovery amortization — §10) — one substrate, two wins.
4. **Standards-critic (adversarial, sonnet+ floor — I7).** A refuter whose _only_ mandate
   is app-standards (structure, naming, abstraction, component boundaries, type quality)
   against a **living standards rubric**, orthogonal to the correctness-refuter. _Team of
   Rivals (arXiv:2601.14351 — to verify):_ orthogonal critics catch distinct failure
   classes (Swiss-cheese). Read-only (Read/Grep/Glob/Skill), like REVIEWER today
   (`role-policy.mjs:120`).
5. **Self-improvement.** Plan Retrospect + REFLECTOR mine each run → propose updates to the
   standards rubric + graph invariants + skills. The quality bar rises run-over-run; the
   pipeline self-governs. _(scorecard exists; this closes its loop into v3.)_

---

## 9. Critic model policy — Anthropic now; cross-vendor analyzed **[CHOSEN: Anthropic multi-tier]**

- **MVP (now): Anthropic multi-tier.** Refuter/standards-critic on **Opus**, DEV on
  **Sonnet**, classifier/inventory on **Haiku** — different _tiers_, all within the Max
  subscription (effectively free at the margin). Honors the operator's "stay on Max"
  constraint. Routing lives as **structured metadata** (a routing table), not prose in a
  prompt — fixing the split-authority problem (today: Lambda job-creation for per-story vs.
  the orchestrator-prompt table for epic-dev subagents).
- **Limit, stated honestly:** tier diversity within one model family is only **partial**
  mitigation of _correlated_ failure — shared training → shared blind spots.
- **Cross-vendor critic (analysis, gated to v3.x/v4).** True cognitive diversity — a
  non-Anthropic refuter (GPT / Gemini / GLM / DeepSeek) — measurably catches distinct
  failure classes (multi-model-diversity research). **Cost/ops:** breaks the
  single-subscription model, adds API keys + per-token billing + a provider-abstraction
  layer. This is **the same provider-agnostic direction already forward-looked** in
  `multi-host-dispatch-readiness.md` (Claude Agents SDK + Bedrock when limits hit, then
  fully provider-agnostic). **Recommendation:** wire a `critic.provider` field now (default
  `anthropic`), implement the cross-vendor adapter only when the v4 dispatcher + provider
  abstraction land — so a future `refuter.provider = 'openai'` is a config change, not a
  rewrite.

---

## 10. Forward-compatibility (v4 dispatch · graph-MCP · provider-agnostic)

- **v4 multi-host dispatch.** This doc's two-layer model **is** the dispatcher's model:
  DynamoDB control-plane + git/S3 truth; compute is swappable. A v3 _per-wave workflow_ is
  a unit of work a future host **claims** from the queue (`multi-host-dispatch-readiness.md`
  §0). EC2 = burst, local machines (laptop, Mac mini) = preferred; multiple Max accounts =
  no machine limit. **v3 must therefore externalize every checkpoint to DDB/git** so a wave
  workflow is relocatable and resumable on _any_ host — which the no-cross-session-journal
  constraint already forces. The two efforts reinforce each other.
- **Graph-MCP (soft dependency).** v3 workflows _use_ the system-graph MCP for discovery
  (replacing per-agent re-globbing) and for the graph-gate (§8.3) **when available**, with
  glob/grep fallback otherwise. Decoupled, independently shippable.
- **Discovery amortization under a flat subscription.** Because cost is Max-subscription
  (not per-token), the scout-brief + cache-aligned-prefix wins are primarily **throughput,
  latency, and rate-limit headroom** (run wider waves under the same ceiling), not dollars.
  A single **scout agent** per run emits a compact repo/graph brief injected into every
  worker; Anthropic's own data confirms the ~15× multi-agent token multiplier is _managed,
  not eliminated_, via tight task boundaries.
- **Provider-agnostic horizon.** `critic.provider` / `dev.provider` fields now; adapters
  later. Claude Agents SDK + Bedrock as the first non-OAuth path when Max limits bite.

---

## 11. MVP staging (first shippable slices)

1. **S0 — Adapter + parallel-engine plumbing.** `pipelineEngine` field on Plan; plan-create
   toggle; `v3-workflow-adapter` (thin, isolates undocumented primitives); both engines on
   shared DDB schema + scorecard. _No orchestration change yet — proves the seam._
2. **S1 — Per-wave workflow replacing intra-wave Task fan-out.** WF-3 router + batched
   compile + deterministic convention gates (layers 1–2). Telemetry gate emitting
   `AgentEvent`s. Daemon keeps inter-wave sequencing.
3. **S2 — Blind-dev + SHA-CAS test gate (Tier 1) + AC durability.** The anti-laziness spine.
4. **S3 — Fix Swarm (WF-2)** with scratch worktrees, refuter-before-merge, capped
   escalation ladder.
5. **S4 — Standards-critic (layer 4) + graph-gate wired as degradable advisory (layer 3).**
6. **S5 — Cross-wave readiness cascade (WF-1)** → promote to a per-epic workflow with DDB
   checkpointing (the v3.x increment).

Each slice is independently comparable against v2.5 on the same scorecard.

---

## 12. Hard constraints (must hold for every slice)

- **Scorecard continuity.** Every workflow step **must** emit an `AgentEvent`
  (`stepId/role/cost/durationMs`) and every retry **must** set `retryOf`, or detectors
  D-WS1/D-CC1/D-CC3/D-VQ3/OV4 go blind (`⚪`). The "only final report returns to context"
  guarantee applies to the _orchestrator_, not to per-step telemetry.
- **Ephemeral state is never the record.** Checkpoint to DDB/git at every phase boundary.
- **Durable git authority.** Trunk push, merge CAS, and the test-SHA gate stay in the
  daemon. The workflow proposes; the daemon disposes.
- **Undocumented-API isolation.** All workflow-primitive calls behind the adapter.
- **Deploy safety (CLAUDE.md).** v3 never touches the public-bucket scoped paths; `out/`
  never syncs to `futurator-ai-website`.

---

## 13. Open questions for the PRD

1. **Readiness-tier definitions** — exact gates for `contract-stable` / `tests-passing` /
   `reviewer-approved`, and which dependents may start at each (the WF-1 edge semantics).
2. **DDB checkpoint schema** for per-epic workflows (S5/S6) — what minimal state makes a
   wave-workflow resumable on another host (v4 alignment).
3. **Standards rubric authorship** — is the app-standards rubric a new artifact, or an
   extension of the existing Plan Retrospect rubric / `test-bench-rubric.md`?
4. **Graph-gate thresholds** — what graph deltas are blocking vs advisory (god-node degree,
   cross-community edge tolerance, layering rules) once the MCP is live.
5. **Fix-swarm sizing** — hypothesis fan-out width vs the 16-concurrent cap when multiple
   stories fail in one wave.
6. **Citations to verify** before PRD: ImpossibleBench (2510.20270), Team of Rivals
   (2601.14351), and the multi-model-diversity sources — confirm IDs/claims independently.
7. **Human sign-off placement** — since workflows can't take mid-run input, which approvals
   (epic gate, budget gate, red-class path merges) stay as separate daemon-level stages?

---

_This concept spec is deliberately decision-transparent: every **[CHOSEN]** marker has its
alternatives preserved above it so the PRD session can re-open any of them with full
context._
