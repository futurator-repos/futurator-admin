# TDD-Native Pipeline-3 — Design Blueprint

> Author: pipeline design session, 2026-07-01. Grounded in real code (legacy `story-pipeline.ts`,
> pipeline-3 `story-dev-pipeline.mjs`) and five cloned OSS frameworks analyzed against that code
> (`repos/spec-kit`, `repos/OpenSpec`, `repos/BMAD-METHOD`, `repos/superpowers`, `repos/get-shit-done`),
> plus the research brief `compass_artifact_… TDD for the Implementation Phase`.
>
> Companion to: `pipeline-3-development-plan.md`, `agentic-document-center-epics.md`,
> `vqa-v3-behavioral-probes` memory, `futurator-pipeline-sdd-exploration-overview.md`.

---

## 0. Thesis (one paragraph)

The **legacy** pipeline already implemented a full **double-loop TDD with agent separation and
deterministic gates** — test-first author, a dev that sees-but-cannot-edit the tests, a fresh read-only
reviewer, and a stack of non-LLM gates (`test-gate-red`, `ac-coverage-gate`, `tamper-check`,
`dev-scope-enforce`). **Pipeline-3 collapsed all of that into one Claude spawn per story** to win speed
and tokens — and in doing so lost exactly two things: (1) **test-author ≠ implementer context
isolation**, and (2) **tests-red-before-code ordering**. Everything else P3 still has, and in a _better_
form: its completion oracle (`test-binding-runner.mjs` + `completion-gate.mjs`) already runs the real
tests out-of-agent, so an agent **cannot self-pass**. Therefore the task is **not** a greenfield TDD
build and **not** re-importing all five legacy agents (that tax is what P3 fixed). It is a **surgical
re-import** of the proven legacy _deterministic gates_ onto P3's oracle, plus **one** context split and a
**graded ready-frontier**. The governing law: **isolate only the boundary that mathematically needs it;
make every other boundary a deterministic gate. Gates are free; agents are not.**

---

## 1. What we compared — verdicts

| Source                                                    | What it is                                                                      | Verdict                                                   | The 1–2 things we take                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Legacy** (`story-pipeline.ts`, `epic-dev-pipeline.mjs`) | N-spawn test-first pipeline: API_AUTHOR→TEST→DEV→REVIEWER→COMPILER + wave-merge | **Donor of proven deterministic gates**                   | `tamper-check`, `test-gate-red`, `ac-coverage-gate`, `api-contract-freeze`, `dev-scope-enforce`, fresh reviewer, wave-merge `--no-ff`                                                           |
| **Pipeline-3** (`story-dev-pipeline.mjs`)                 | 1-spawn/story, `<BINDING>` AC→test, out-of-agent oracle, Kahn frontier          | **The substrate we extend**                               | out-of-agent red/green oracle; graded frontier hook; skills PUSH; scope PreToolUse gate                                                                                                         |
| **OpenSpec** (`repos/OpenSpec`)                           | Real TS CLI: delta-spec Propose→Apply→Archive                                   | **Best deterministic-gate donor**                         | `validator.ts` (SHALL/MUST + ≥1 GWT scenario), archive **verify-before-merge** with machine-readable block codes, delta→canonical merge                                                         |
| **BMAD TEA** (`bmad/bmm/workflows/testarch/*`)            | Test-Architect persona + 8 workflows                                            | **Best risk/gate-_model_ donor (prose, we make it code)** | P×I(1–9)→P0–P3 risk score; PASS/CONCERNS/FAIL/WAIVED thresholds; traceability FULL/PARTIAL/NONE; NFR "CONCERNS-by-default"                                                                      |
| **Spec Kit** (`repos/spec-kit`)                           | SDD templates + Python CLI                                                      | **Patterns to reimplement, not adopt**                    | `contract→integration→e2e→unit→source` ordering; `/analyze` requirement→task coverage map. ⚠️ its Test-First is prompt-only and _this fork ships tests-OPTIONAL_                                |
| **Superpowers** (`repos/superpowers`)                     | Skills framework, "Iron Law" TDD                                                | **Token-economy + isolation patterns**                    | SessionStart `additionalContext` **lazy skill load** (not `--append-system-prompt`); file-handoff scripts (`task-brief`, `review-package`); fresh-subagent + "Do Not Trust the Report" reviewer |
| **GSD** (`repos/get-shit-done`)                           | Claude-native SDD, 33 subagents                                                 | **One primitive + one convention**                        | PreToolUse `exit 2` **blocking** hook; committed `test(...):`→`feat(...):` RED-before-GREEN checkpoint; worktree FATAL safety asserts                                                           |

**Cross-cutting finding that decides the architecture:** _none_ of the four modern OSS frameworks
(Spec Kit, BMAD, Superpowers, GSD) **deterministically enforces red/green separation** — all four rely
on model goodwill (prose "verify RED", or an advisory `git log --grep`). The research brief warns this is
exactly where LLMs cheat ("they subconsciously design tests around the implementation," Anthropic: "Claude
will sometimes change tests to make them pass"). **Legacy Futurator already solved this deterministically**
with `tamper-check` (auto-reverts any dev edit to a test file) and `test-gate-red` (asserts the suite
_fails_ before dev). So we **do not** copy the OSS prompt approach — we port legacy's code approach and let
the OSS frameworks contribute the _model_ (risk tiers, gate verdicts) and _token tricks_.

---

## 2. The core tension, and the principle that resolves it

- **Legacy economics:** every stage = a fresh Claude spawn ≈ **30 s cold start + ~27 k cache-creation
  tokens**; compile-thrash alone was **47 % of epic wall-clock**; $5.56 for 10 stories that should cost
  ~$2 (`agentic-pipeline-forensic-report.md`). Rigor, but expensive.
- **P3 economics:** one spawn/story amortizes cold-start and cache across the whole story. Cheap and
  fast — but the single context can "cheat" red/green (circular validation).
- **The resolution is not a slider between them.** It is a rule about _where_ to spend a spawn:

> **Isolation Law.** The only boundary that _mathematically_ requires two contexts is
> **test-author ≠ implementer** (a context that has already planned the implementation cannot write an
> honest failing test for it). Every _other_ TDD boundary — "did the test go red first?", "were tests
> edited to pass?", "is every AC covered?", "did the diff stay in scope?", "did the suite regress?" — is
> a **fact about files and exit codes**, and must be a **deterministic gate**, never a second LLM.

This gives us **exactly two spawns per story** (Test-Author + Implementer), not five, and not one. The
reviewer becomes **risk-tiered** (§5): a deterministic gate for the common case, a _third_ fresh spawn
only when risk ≥ threshold or the gate returns CONCERNS. That is the balance of "true speed + token
reduction + great code" the request asks for.

---

## 3. Target architecture — the double loop mapped onto P3

The research brief's double loop (outer acceptance loop, inner unit RGR) maps onto structure P3 **already
has**:

```
STORY (bound ACs, EARS+GWT, risk-tiered P0–P3)
   │
   ▼  [CARTOGRAPHER · deterministic+cheap-LLM]  normalize AC→EARS→GWT, tag P0–P3, shape-validate
   ▼  [gate: AC-SHAPE]  OpenSpec-style: every AC has SHALL/MUST + ≥1 GWT scenario  (else block, no spawn)
   │
   ▼  ╔═ OUTER LOOP (per acceptance scenario) ══════════════════════════════╗
      ║ [TEST-AUTHOR · fresh ctx, Sonnet]  writes FAILING tests + <BINDING>  ║
      ║   never sees an implementation plan; contract→integration→e2e→unit   ║
      ║ [gate: RED-FIRST]  run suite, assert FAIL for right reason (port      ║
      ║   legacy test-gate-red) → commit `test(story):` RED checkpoint        ║
      ║        │                                                             ║
      ║        ▼  ┌─ INNER LOOP (Red→Green→Refactor) ──────────────────────┐ ║
      ║           │ [IMPLEMENTER · fresh ctx]  minimal code to GREEN         │ ║
      ║           │   sees the committed failing tests; may NOT edit them    │ ║
      ║           │ [gate: TAMPER]  auto-revert any edit to a test file      │ ║
      ║           │ [oracle: test-binding-runner]  status=passing ⇔ real exit│ ║
      ║           └───────────────────────────────────────────────────────┘  ║
      ║ [gate: SCOPE]  PreToolUse touches/forbidden (already live in P3)      ║
      ╚══════════════════════════════════════════════════════════════════════╝
   │
   ▼  [gate: COVERAGE/TRACE]  every AC→passing bound test (FULL/PARTIAL/NONE); coverage floor
   ▼  [REVIEWER · fresh ctx — ONLY if riskTier≤P1 or gate=CONCERNS]  senior-reviewer verdict
   ▼  [gate: QUALITY]  deterministic PASS / CONCERNS / FAIL / WAIVED (port BMAD thresholds)
   ▼  done → propagate (graded, §6)
   │
   ▼  [REFLECTOR]  fires on story/plan close (already wired)
```

**The critical reuse:** the boxes marked _oracle_ and _gate_ are **not LLM calls**. P3's
`completion-gate.mjs:76` already passes an AC only if `testBinding.status==='passing' && lastRunSha===HEAD`
— that _is_ the GREEN oracle. We add the **RED** half (author tests first, prove they fail) and the
**immutability** half (tamper-check), both ported from legacy as deterministic code.

**Outer loop for UI stories already exists.** Our VQA v3 behavioral probes (reach/act/observe against the
`window.__harness` seam) are precisely the outer-loop _acceptance_ tests. So for UI stories the double
loop is: **outer = VQA probe (bound `verify:behavior` AC), inner = unit RGR.** We wire them as one loop
rather than inventing a parallel structure. `qa-author.ts` already compiles a BDD AC → an executable probe
flow deterministically — that is our AC→acceptance-test bridge for UI.

---

## 4. The three seams (exact, code-cited)

### Seam 1 — split the single spawn (test-author ≠ implementer)

- Today: one `spawn(claudeBin, …)` at `daemon/pipelines/story-dev-pipeline.mjs:183` writes code **and**
  tests **and** emits `<BINDING>`.
- Change: precede it with a **Test-Author spawn** that receives spec + normalized AC + the frozen
  contract, and is told to author failing tests + `<BINDING>` and **not** to read/write source. Then the
  existing spawn becomes the **Implementer**, receiving the committed failing tests (legacy already does
  this via `{{TEST_FILES}}` injection, `story-pipeline.ts:850-866`) and told "make green, never edit
  tests."
- Reuse: legacy `TEST` role prompt (`functions/shared/prompts/`… test-author) and `role-policy.ts`
  tool/turn caps (`TEST`: `Bash,Read,Write,Edit,Glob,Grep,Skill`, Sonnet-defaulted).

### Seam 2 — graded ready-frontier (the "earn time" ask)

- Today: pure Kahn. `daemon/lib/story-graph.mjs:154` `isDone = state==='done'`; a dependent unblocks only
  when **every** dep is fully `done` (`readyFrontier` `:152`, `recordDependencyDone` `atomic-claim.mjs:157`
  fires only at `newState==='done'`, `story-dev-pipeline.mjs:270`).
- Change: introduce **graded readiness** (§6). Relax `isDone` to accept an earlier state for a
  _dependent's test-authoring_, and move the propagation trigger for the **contract signal** to right
  after `integrateStory` commits (`story-dev-pipeline.mjs:238`) instead of only at `done` (`:270`).
- The intermediate StoryNode states **already exist in the enum but are skipped** (`merging`,
  `verifying`, `story-graph.mjs:15`) — the clean insertion points.

### Seam 3 — test-binding red-first + coverage/mutation

- Today: `<BINDING>` is emitted _post-hoc, in the same spawn as the code_; `completion-gate.mjs` enforces
  GREEN only. No check that a test was RED first, no check that the test actually _exercises_ the AC
  beyond exiting non-zero, no coverage/mutation.
- Change: (a) add a **RED-first proof** step (run bindings before implementer, require failing), (b) add
  a **coverage/trace gate** (every AC → a passing bound test; FULL/PARTIAL/NONE), (c) add **mutation**
  (Stryker) on P0 modules at L2. `test-binding-runner.mjs` already gives per-binding exit codes to build
  all three on.

---

## 5. Agent isolation, context, and tokens (the balance in numbers)

**Spawn budget per story:**

| Role                                 | Spawn?                        | Model                    | Context                                       | Rationale                                                                                           |
| ------------------------------------ | ----------------------------- | ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cartographer (AC→EARS/GWT, risk tag) | optional cheap                | Haiku                    | plan slice                                    | mostly deterministic; LLM only for prose normalization; can be a planning-time batch, not per-story |
| **Test-Author**                      | **yes (new)**                 | Sonnet                   | spec + AC + frozen contract, **no impl plan** | the one mandatory isolation                                                                         |
| **Implementer**                      | **yes (existing)**            | Sonnet/Opus by risk      | committed failing tests + spec                | the existing `:183` spawn                                                                           |
| Reviewer                             | **only if P0/P1 or CONCERNS** | Sonnet (senior-reviewer) | diff + AC only                                | risk-tiered; not every story pays                                                                   |
| Compiler (knowledge graph)           | fire-and-forget               | Haiku                    | diff                                          | already non-gating (`agent-daemon.mjs:1845`)                                                        |
| Reflector                            | on close                      | —                        | git window                                    | already wired                                                                                       |

So the **common (P2/P3) story pays 2 spawns**; only **high-risk stories pay 3**. That is strictly cheaper
than legacy's 4–5 and only one more than P3's 1 — and the extra spawn buys the single thing P3 can't fake.

**Token levers (all portable, ranked):**

1. **Shared cache prefix across Test-Author + Implementer.** Legacy shares a byte-identical
   `<project_context>` cache prefix across dev/review/compiler (`story-pipeline.ts:799-803`). Do the same
   across our two spawns so the second spawn pays cache-_read_ (~10 %), not cache-_creation_.
2. **Lazy skill loading** (Superpowers `hooks/session-start` → `additionalContext`; GSD `--profile=core`,
   ~12 k→~700 cold-start tokens). P3 currently **PUSHes full skill bodies into `--append-system-prompt`
   every spawn** (`story-skills-inject.mjs:62`) — with two spawns/story that doubles a large fixed cost.
   Move to inject _one_ bootstrap skill + lazy `Skill`-tool load. (Tracked as a separate optimization;
   keep PUSH until measured.)
3. **File-handoff, not context-passing** (Superpowers `task-brief`, `review-package`). The reviewer reads
   a diff _file_ in one call; the frontier controller never carries story text in-context.
4. **Risk-tiered reviewer** (BMAD P×I score) — spend reviewer tokens only where `score≥6` (P0/P1).

---

## 6. Dynamic dispatch — the graded frontier ("earn time")

Replace the binary `done` gate with **three graded signals per story**, and let a dependent consume the
_weakest signal each of its own phases actually needs_:

| Signal            | Emitted when                                                                                                | Unblocks in the dependent                                                                | Why it's safe                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `contract_frozen` | dep's contract (`.d.ts`/interface) + **failing acceptance tests** committed (post `integrateStory`, `:238`) | the dependent's **Test-Author** (tests are written against the _contract_, not the impl) | contracts are frozen and low-churn; this is contract-testing's "parallel dev" (Specmatic) applied to scheduling |
| `green`           | dep's bound tests pass but branch not merged                                                                | the dependent's **Implementer** (optimistic start on the shared branch)                  | tests-green means behavior is stable; rework only if dep later fails review                                     |
| `done`            | dep merged/verified (today's only signal)                                                                   | anything (risk-averse default)                                                           | current behavior, unchanged                                                                                     |

**Mechanics:**

- Add StoryNode states so "dev-done but not verified" is representable — reuse the dormant `merging` /
  `verifying` and add `contract_frozen`/`green` markers on the row (or an edge-level readiness field on
  the `depends_on` edge).
- `story-graph.mjs:154`: make `isDone` a policy `depReady(dep, phase)` keyed by the dependent's phase.
- Emit `recordDependencyDone`-style decrements at the **contract** and **green** points, not only `done`.
- **Speculative-start rework is bounded and opt-in.** If an upstream contract changes after a dependent
  started, invalidate only that dependent (its `touches` are disjoint and scoped, so blast radius is one
  story). Guard behind a per-plan flag `P3_FRONTIER_MODE = kahn | contract | green` (default `kahn`;
  `contract` is the recommended first step — it parallelizes _test-authoring_ with near-zero rework risk
  because tests bind to the frozen contract).

**Net effect:** test-authoring for an entire dependency chain can proceed in parallel the moment contracts
freeze, while implementation serializes only where it truly must — the requested "start the next task
when round-1 of the dependency finished, not when its compiler ends."

---

## 7. Tiered gates L0/L1/L2 — mapped to code we already have

| Tier   | When                              | Checks                                                                                  | Have today                                                                                     | Add                                                                                  |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **L0** | per tool-call / commit (secs)     | lint, typecheck, format, touched-unit; **scope**                                        | scope PreToolUse (`pretool-gate.mjs`, `gate-settings.mjs`); prework `tsc` (`prework-gate.mjs`) | wire `tsc --noEmit` + eslint as an L0 bound-executor kind                            |
| **L1** | per inner-loop / pre-merge (mins) | full unit + contract + **coverage floor** + **RED-first proof** + **test-immutability** | `test-binding-runner.mjs`, `completion-gate.mjs:76` (GREEN)                                    | port `test-gate-red`, `tamper-check`, `ac-coverage-gate`; add coverage floor (≥80 %) |
| **L2** | per story / wave / nightly (slow) | integration + **e2e/VQA probes** + **mutation (P0)** + **NFR audit**                    | `wave-vqa-runner.mjs`, `visual-qa-pipeline.ts`                                                 | Stryker on P0 modules (nightly); NFR CONCERNS-by-default                             |

**The quality-gate decision** (port BMAD's model — they only have prose; we make it a deterministic
function fed by the trace + coverage + CI results):

- **PASS** = P0 cov 100 % & pass 100 %; P1 cov ≥90 % & pass ≥95 %; overall cov ≥80 % & pass ≥90 %; critical
  NFRs pass; 0 security issues.
- **CONCERNS** (ship-with-follow-up) = P1 cov 80–89 % or overall pass 85–89 % or non-critical NFR fail.
- **FAIL** = any P0 gap, P1 cov <80 %, overall cov <80 %, critical NFR fail, any security issue.
- **WAIVED** = a would-be FAIL + named approver + justification + mitigation + evidence; **never** for P0,
  critical security, or critical NFR.

Encode once as `functions/shared/services/quality-gate.ts` (deterministic, `.safeParse`d inputs), mirror
to the daemon (the `role-policy.ts ↔ role-policy.mjs` parity-test pattern).

---

## 8. Branches & merges

- **Keep P3's shared-tree + disjoint-`touches` model** for the common case — it's cheap and the scope
  gate already guarantees non-overlap. No per-story worktree needed when `touches` are disjoint.
- **Add a verify-before-merge gate** at `plan/<id> → main` (`plan-branch.mjs:45 mergePlanToMain`, today
  called only at deploy) — port OpenSpec's archive gate shape: run L1/L2 + quality-gate, emit
  **machine-readable block codes** (`merge_validation_failed`, `tasks_incomplete`,
  `spec_validation_failed`) the scheduler consumes. (OpenSpec `archive.ts` is the reference; worktree
  creation itself is _not_ in OpenSpec — that stays ours.)
- **Worktree-per-story only for speculative (`green`-mode) starts** where two stories may diverge on the
  branch before merge — reuse the existing `story-worktree.mjs` / `worktree-reaper.mjs`, and port GSD's
  **FATAL worktree-safety asserts** (halt before commit if cwd escaped the worktree / HEAD on a protected
  branch — `agents/gsd-executor.md`). Legacy `wave-merge.mjs` (`--no-ff` per `wip/<storyId>`, wave-base
  chaining) is the reference if we return to per-story branches.
- **Contract-conflict detection** between concurrent stories (OpenSpec ADDED/MODIFIED/REMOVED collision on
  the same spec capability) becomes a **scheduler input** — two stories that modify the same contract
  cannot both be in the frontier speculatively.

---

## 9. AC → executable-test bridge (make free-form AC testable)

1. **Cartographer** normalizes each AC to **EARS** (`While <pre>, when <trigger>, the <system> shall
<response>`) then expands to **Given-When-Then** (happy + ≥3 edge + error + explicit out-of-scope), and
   tags **P0–P3** via BMAD's P×I(1–9) score.
2. **AC-shape gate (deterministic)** — port OpenSpec `validator.ts`: every AC body must contain SHALL/MUST
   and ≥1 GWT scenario, else block _before any spawn_. Extend our existing `solutioning-gate.ts` (which
   already checks BDD AC presence and PRD-requirement coverage) with the OpenSpec regex/section rules.
3. Each GWT scenario → a **test stub** the Test-Author fills; `testBinding` already maps AC→selector, so
   the traceability matrix (§7) is computable from data we already store on the StoryNode row.

---

## 10. Open-source tooling — staged install plan

We already have **Vitest** (unit/integration) and **Playwright** (e2e/VQA) — the pyramid base and top are
covered. Net-new, introduced by stage (nothing installed yet without your go-ahead — these mutate
`package.json`):

| Tool                               | Purpose                                                | Stage   | Note                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stryker** (`@stryker-mutator/*`) | mutation testing → L2 P0 gate ("do tests catch bugs?") | 4       | scope to auth/validation/orchestration modules; ratchet kill-score                                                                                                  |
| **fast-check**                     | property-based tests                                   | 4 (opt) | complements example-based for pure functions                                                                                                                        |
| **Zod-derived contract check**     | contract tests from our existing Zod schemas           | 3       | _lighter than Pact/Specmatic_ — we already have Zod schemas in `functions/shared/schemas`; reimplement OpenSpec's validator idea rather than stand up a Pact broker |
| OpenSpec CLI (`repos/OpenSpec`)    | reference for the validator/archive gate               | —       | reimplement as our own script; don't take a runtime dep                                                                                                             |

**Cloned already (for analysis, gitignored `repos/`):** `spec-kit`, `OpenSpec`, `BMAD-METHOD`,
`superpowers`, `get-shit-done` (+ prior `jcode`, `ecc`, `ponytail`). BMAD TEA is _also_ already installed
in-project at `bmad/bmm/workflows/testarch/*` (persona slash-commands, not auto-spawned subagents) — its
risk/gate knowledge fragments are the source for §7's thresholds.

---

## 11. Staged rollout (with benchmarks to advance) — behind `pipeline-flags`

- **Stage 1 — Executable AC.** Cartographer (EARS+GWT+risk tier) + AC-shape gate.
  _Advance when_ ≥95 % of stories enter Implementation with EARS+GWT AC and a P-tier.
- **Stage 2 — Double loop + agent split.** Test-Author spawn; RED-first proof; tamper-check;
  Implementer sees-but-can't-edit tests.
  _Advance when_ every merged story shows a committed `test(story):` RED checkpoint and **zero** stories
  had a test edited to pass (tamper-count = 0).
- **Stage 3 — Tiered gates + traceability + quality verdict.** L0/L1 wired per story; coverage floor;
  `quality-gate.ts` PASS/CONCERNS/FAIL/WAIVED; risk-tiered reviewer.
  _Advance when_ 100 % P0-AC coverage before merge; traceability matrix auto-emitted per story.
- **Stage 4 — Harden.** Stryker mutation on P0 (nightly, ratcheted); NFR CONCERNS-by-default audit.
  _Advance when_ mutation-kill trends up on criticality-weighted modules.
- **Parallel track — Graded frontier.** `P3_FRONTIER_MODE=contract` opt-in (test-authoring parallelizes on
  frozen contracts); measure wall-clock vs rework rate before enabling `green`.

---

## 12. Ideas selected vs rejected (explicit)

**Adopt (deterministic, high-leverage):** OpenSpec AC validator + verify-before-merge block codes + delta
merge · BMAD P×I risk score + PASS/CONCERNS/FAIL/WAIVED + FULL/PARTIAL/NONE trace + NFR-CONCERNS-default ·
GSD PreToolUse `exit 2` block + `test(...)→feat(...)` RED-commit checkpoint · Superpowers lazy-skill
injection + file-handoff + "Do Not Trust the Report" reviewer · Spec Kit `contract→…→unit` ordering +
requirement→task coverage map (reimplemented as a script) · **all legacy deterministic gates**
(tamper-check, test-gate-red, ac-coverage-gate, api-contract-freeze, dev-scope-enforce, wave-merge).

**Reject / defer:** Spec Kit as an adopted framework (its Test-First is prompt-only and _this fork ships
tests-OPTIONAL_) · BMAD/Superpowers/GSD **prompt-based** red/green "enforcement" (we use legacy's
deterministic tamper/red gates instead) · OpenSpec worktree-per-change (not actually implemented; we keep
shared-tree + our own worktree module) · heavyweight Pact broker (use Zod-derived contracts) · a formal
4-tier coverage oracle from BMAD (BMAD has none; that layer stays our own VQA deterministic-first design).

---

## 13. First PR (Wave 0) — smallest thing that proves the spine

1. **`quality-gate.ts` + parity `.mjs`** — the deterministic PASS/CONCERNS/FAIL/WAIVED function (pure,
   unit-tested), fed by traceability + coverage inputs. _No behavior change yet — just the oracle._
2. **Port `tamper-check` + `test-gate-red` as bound-executor kinds** in `test-binding-runner.mjs` — makes
   test-immutability and RED-first _checkable_ on the existing single-spawn path (proves the gates before
   we split the spawn).
3. **AC-shape gate** — extend `solutioning-gate.ts` with the OpenSpec SHALL/MUST + ≥1-GWT-scenario rule.
4. **`P3_FRONTIER_MODE` flag** (default `kahn`) + the `contract_frozen` propagation hook at
   `story-dev-pipeline.mjs:238` — dark-launched, off by default.

Stages 1–2 (Test-Author split) build on 1–4 once the gates are green in isolation. This ordering means
**every new gate is proven deterministic before any new spawn is added** — we never pay tokens for
rigor we haven't yet verified is real.

---

## 14. Risks & caveats

- **LLMs cheat red/green** → mitigated by deterministic `tamper-check` + RED-first proof (facts, not
  prose). This is the whole reason we port legacy rather than any OSS framework's prompt.
- **Second spawn = token regression** → mitigated by shared cache prefix, cheap Test-Author model,
  risk-tiered reviewer (2 spawns common-case, 3 only for P0/P1). Measure against the P3 baseline before
  defaulting on.
- **Speculative-start rework** → bounded to one story (disjoint `touches`), opt-in, contract-gated;
  `contract` mode has near-zero rework because tests bind to the frozen contract.
- **Don't rebuild what exists** → the legacy gates are reusable functions; the P3 oracle is agent-
  independent; VQA is the UI acceptance loop; the reflector is wired. This is assembly, not invention.
- **Two "legacy" execution models** (linear `story-pipeline.ts` vs Task-subagent `epic-orchestrator`) —
  we port the _gates_ (shared substrate), not either orchestration shell; P3's frontier is the
  orchestrator.
