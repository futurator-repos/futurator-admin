# Pipeline v2 — Phase 2 Epic Plan

| Field            | Value                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | **Active** — entry point Phase 2-A. PR-2/3/4/5 (committed in Phase 1 hardening) and PR-11/15 (in `ebc4c7b`) already touched ~30% of Phase 2-A surface.                                                                                                                                                              |
| **Authored**     | 2026-05-05                                                                                                                                                                                                                                                                                                          |
| **Source spec**  | `docs/concepts/pipeline-v2/futurator-pipeline-v2-5-consolidated.md` (v2.5 consolidated). Part II §9–§20 (inner loop) + Part III §21–§32 (git substrate) + Part VIII §51–§54 (phase enumeration A/B/D).                                                                                                              |
| **Phase scope**  | Bring the 11-step inner loop, branch-per-story `wip/` worktrees, ARCHITECT + `aws.manifest.yaml`, expanded `Plan.kind` enum, GitHub Actions OIDC, and basic CDK deploys into production. Three sub-phases: **A** (inner-loop discipline), **B** (git substrate), **D** (AWS + integrations). v2.5 §51–§54 in order. |
| **Effort**       | ~25–30 dev days (Phase 2-A ~11d − ~30% already shipped ≈ ~7d; Phase 2-B ~14d after Phase-3 deferrals; Phase 2-D ~28d after Phase-3 deferrals)                                                                                                                                                                       |
| **Ship gate**    | See §3 below — one composite condition with five verifiable sub-checks                                                                                                                                                                                                                                              |
| **Out of scope** | Skills federation + SKILL-SCOUT (Phase 3-C); REFLECTOR + Reflection Inbox (Phase 3-E); speculation `explore/` + EVALUATOR (Phase 3-B.10 + 3-D.11); production rigor 24h soak (Phase 3-D.15); persona evolution; brownfield migration of pre-v2 projects (Phase 3-F)                                                 |

---

## 1. Big-picture: where Phase 2 sits in v2

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PIPELINE v2 (overview)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Phase 1 — SUBSTRATE                                       ✅ shipped    │
│  ─────────────────────                                                  │
│  GitHub repo per App, typed boilerplates, App-bootstrap saga,           │
│  Roadmap visibility, Timer Intelligence. PR-1 → PR-31. (~16-18d)        │
│                                                                         │
│  Phase 2 — PIPELINE                                ◄── you are here     │
│  ──────────────────                                                     │
│  The 11-step inner loop with policy-as-code allowlists, typed context   │
│  packs, baseline-diff regression, API-AUTHOR + tamper-check, branch-    │
│  per-story `wip/` worktrees, wave-merge --no-ff, distributed merge      │
│  lock, ARCHITECT + aws.manifest.yaml, OIDC deploys, basic CDK.          │
│  v2.5 §9–§32 + §51–§54 (Phases A, B, D). ~25-30 days.                   │
│                                                                         │
│  Phase 3 — COMPOUNDING                                                  │
│  ─────────────────────                                                  │
│  Skills federation + SKILL-SCOUT, REFLECTOR + Reflection Inbox,         │
│  speculation `explore/` + EVALUATOR, production rigor 24h soak,         │
│  drift detection, persona evolution. v2.5 §53/§55/§56 (C, E, F).        │
│  ~25-30 days.                                                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

The Phase 2 entry point is **inner-loop discipline (Phase 2-A)** because Phase 1
established the substrate but left the inner loop running on Phase-1 shortcuts:
coarse-string allowlists set per-pipeline-file, an accretion-grown
`PROJECT_CONTEXT` shape, no baseline-diff gate, no API stub step, no tamper-check.
The Phase 1 hardening pass (PR-1 → PR-31) closed the most painful symptoms but
left the structural fixes for here.

Phase 2-B (git substrate) is foundational but bigger; it lands second so the
inner loop is already disciplined when stories start running in `wip/` worktrees.

Phase 2-D (AWS + integrations) lands third because ARCHITECT is the biggest
single unknown in v2.5 and pushing it earlier would block both A and B.

---

## 2. Where Phase 1 left things — substrate inventory

A snapshot of what Phase 1 actually shipped into the inner loop, so a reader
of this doc one quarter from now doesn't have to re-derive it.

| Area                         | Today (post Phase 1)                                                                                                                                                                                                     | Phase 2 target                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline shape               | 6 pipeline files (`story`, `pm-plan`, `wave-compile`, `visual-qa`, `wave-build`, `plan-build`). 4 agents in `story-pipeline.ts`: TEST, REVIEWER, DEV, COMPILER.                                                          | The 11-step v2.5 §9 pipeline: `git-init-story` → `api-author` → `test-author` → `test-gate-red` → `dev` → `test-verify` → `tamper-check` → `baseline-regression` → `review` → `retry` → `compile-knowledge`.                       |
| Tool allowlists              | Coarse strings hardcoded per agent, e.g. `'Bash,Read,Edit,Write,Glob,Grep'`. Daemon (`agent-daemon.mjs:644-645`) string-passes `--allowedTools`. PR-3 added blanket `--disallowedTools "Task,Agent,WebFetch,WebSearch"`. | Typed `RolePolicy` resolved at spawn-time from `(boilerplateKind, rigor, role)`. Policy includes `allowedTools[]`, `disallowedTools[]`, `maxTurns`, optional path-globs (e.g. `Write(${STORY_MODULE}/index.d.ts)` for API-AUTHOR). |
| Context pack                 | `PROJECT_CONTEXT` placeholder injected at job spawn. Shape grown by accretion (PR-11 default + PR-15 file contents). No schema, no validation.                                                                           | Typed Zod schema per v2.5 §11. Validate at inject-time. Surface validation failures as attention items rather than silent garbage. Per-wave rebuild flag.                                                                          |
| Baseline regression          | None. PR-2 added a daemon-side **pre-DEV** gate (forces TEST step to run first); the post-DEV regression gate doesn't exist.                                                                                             | `capture-test-baseline.sh` at wave start + `check-regressions.sh` after every DEV step. Rigor matrix: prototype warns, mvp/production blocks. `acceptBaselineDrift` mechanism for intentional API changes.                         |
| API stub step                | None. TEST and DEV both invent type names; PR-5 mitigates via boilerplate-aware PM prompt but doesn't physically share names.                                                                                            | `API-AUTHOR` agent emits a frozen `.d.ts` between PM and TEST. `--max-turns 2`, allowlist scoped to `Write(${STORY_MODULE}/index.d.ts)`. Both TEST and DEV `import type { ... } from './index'`.                                   |
| Tamper-check                 | None at runtime. Husky pre-commit exists but doesn't read a frozen-file list.                                                                                                                                            | SHA-256 snapshot of test files at end of TEST step; compare after DEV; first offense → auto-revert + DEV retry, second → high-severity attention item `tamper-repeat`. Husky `pre-commit` reads `.pipeline/frozen.txt`.            |
| Turn caps                    | Some `maxTurns` set per agent in pipelines. No rigor-aware matrix.                                                                                                                                                       | Rigor-aware matrix per v2.5 §17 (api-author=2, TEST=6/8/10, DEV=8/10/12, REVIEWER=4/6/8). Driven by `RolePolicy`.                                                                                                                  |
| Explore subagent caching     | None. Each story spawns Explore separately for TEST and DEV.                                                                                                                                                             | Cache TEST's Explore output to `.pipeline/explore-input-$STORY_ID.md`; DEV's context pack prepends it.                                                                                                                             |
| Metrics emission             | Timer Intelligence captures step-level events; `metrics.csv` per v2.5 §19 doesn't exist.                                                                                                                                 | Tee `--output-format stream-json` `step_complete` events to `metrics.csv` per plan. Wave-level threshold check (1.5× rolling median).                                                                                              |
| Branch namespace             | All work on `main`. No `wip/<storyId>`, no per-story isolation.                                                                                                                                                          | `wip/<storyId>` from epic-base SHA, story-bounded, deleted after wave merge.                                                                                                                                                       |
| Worktrees                    | Single primary worktree per App at `/home/ubuntu/projects/<slug>`.                                                                                                                                                       | Per-story worktrees under `/home/ubuntu/worktrees/<project>/<plan>/<storyId>`. Daemon GC pass on startup.                                                                                                                          |
| Wave merge                   | Stories commit directly to `main`; PR-19 added per-story `git push` after `compile-sync`.                                                                                                                                | `--no-ff` per story branch, full test re-run against merged state. Failure → reset main + `merge-conflict` attention item.                                                                                                         |
| Distributed merge lock       | None. Concurrent plans race on `git push`.                                                                                                                                                                               | DDB conditional write (`PK = LOCK#<project-slug>`, `SK = MERGE`, 5-min TTL for crash recovery).                                                                                                                                    |
| Plan tag → semver            | Plans don't tag.                                                                                                                                                                                                         | `<project>-plan-<plan-slug>` tag on plan completion; `<project>-v<semver>` semver tag on operator promote.                                                                                                                         |
| Branch protection            | None at create-time. PR-6 deferred enforcement.                                                                                                                                                                          | Rigor-aware: prototype (lint + typecheck), mvp (+ unit), production (+ e2e + build + security-audit + 1 approval). `pr-mode: true` modifier per plan.                                                                              |
| Stream branches              | Convention only — operator opens new terminal, commits to `main`.                                                                                                                                                        | `stream/<n>` namespace per v2.5 §25; auto-archive after 30d idle.                                                                                                                                                                  |
| Daemon GC                    | Stale-heartbeat scanner exists (PR-28 covers per-story dev-pipeline jobs).                                                                                                                                               | Add worktree cross-reference + `wip/` branch reconciliation per v2.5 §24.2.                                                                                                                                                        |
| ARCHITECT                    | Three reservation comments only (`functions/shared/types/app.ts:74`, `timer/types.ts:14`, `boilerplates/types.ts:54`).                                                                                                   | Full agent + T1/T2/T3 triggers per v2.5 Part V (skipping T4-EVALUATOR, deferred to Phase 3).                                                                                                                                       |
| `aws.manifest.yaml`          | Schema reservation in `boilerplate.types.ts:54` (`defaultManifestSeed?: AwsManifestSeed`). No actual schema.                                                                                                             | Full Zod schema + parser + `cdk import` for brownfield + CDK generation by COMPILER.                                                                                                                                               |
| `integrations.manifest.yaml` | Not started.                                                                                                                                                                                                             | Schema + parser + secret-path tracking.                                                                                                                                                                                            |
| Credential layers            | EC2 instance profile (Layer A) for daemon. No per-project IAM roles (Layer B). No ephemeral session per plan (Layer C).                                                                                                  | Layer A retained, Layer B per-project IAM roles, Layer C ephemeral session deferred to D.10.                                                                                                                                       |
| GitHub Actions OIDC          | Stub workflow `pipeline-stub.yml` (lint + build).                                                                                                                                                                        | OIDC roles per project; deploy workflows per env (dev/staging/prod).                                                                                                                                                               |

This inventory is the baseline against which every Phase 2 PR proves it
moved the needle.

---

## 3. Ship gate (Phase 2 done = this composite condition passes)

> **A feature plan on a Phase-1 App runs end-to-end through all 11 pipeline
> steps inside a `wip/` branch, merges to `main` via wave-merge, and the
> Timer Intelligence panel shows correct per-category attribution for the
> full plan.**

Decomposed into five verifiable sub-checks:

1. **All 11 steps fire and are observable.**
   For a fresh feature plan against `dino-runner-1` (or a new `nextjs-canvas-game` App),
   the Timer Intelligence forensic JSON shows step entries for every one of
   `git-init-story`, `api-author`, `test-author`, `test-gate-red`, `dev`,
   `test-verify`, `tamper-check`, `baseline-regression`, `review`, `retry` (when fired),
   `compile-knowledge`. Pipeline classifier extends to map each step to a category.

2. **Per-story branch isolation works under parallelism.**
   At least three stories from one wave run concurrently, each in its own
   `/home/ubuntu/worktrees/<project>/<plan>/<storyId>` directory and on its own
   `wip/<storyId>` branch off the wave-base SHA. No story can read or write
   files in another story's worktree.

3. **Wave merge is `--no-ff` and re-runs the full test suite.**
   On wave completion, `git log main --merges` shows one merge commit per story
   in the wave with `Agent: WAVE-MERGE` metadata. Test suite passes on the
   merged state before push. Failure mode: reset `main`, mark wave `fixing`,
   surface `merge-conflict` or `wave-build-failed` attention item.

4. **Inner-loop discipline gates fire with rigor-correct behavior.**
   - `tamper-check` blocks a synthetic test mutation in DEV step.
   - `baseline-regression` blocks under mvp+ rigor when DEV intentionally
     regresses a previously-passing test (and warns under prototype).
   - `api-author` emits exactly one `.d.ts` and is used by both TEST and DEV
     (verified via `grep "from '\\./index'"` in both files).

5. **Timer Intelligence per-category attribution is complete.**
   For the full plan, the Timing panel's stacked bar shows non-zero slices for
   the new categories: `branch-isolation`, `api-stub`, `baseline-check`,
   `tamper-check`, `wave-merge`, `merge-lock-wait`. MECE invariant
   (`Σ slice ≡ endedAt − startedAt ± 1s`) holds.

ARCHITECT and `aws.manifest.yaml` are required for the Phase 2-D portion of the
ship-gate but **not** for the Phase 2 entry-point demo. The minimal Phase 2 ship
demo is provable on a frontend-only `nextjs-canvas-game` App where AWS
deployment is the existing Phase-1 stub workflow.

---

## 4. Prerequisite resolutions (PR-32 onward)

These are the named decisions Phase 2 inherits from Phase 1 wrap and must
re-confirm before each sub-phase starts.

| #     | Decision                          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                | Owner of action |
| ----- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| PR-32 | Tool allowlists as code           | **Typed `RolePolicy` Zod schema + spawn-time resolver.** Policy keyed on `(boilerplateKind, rigor, role)`. Eight pipeline files (incl. `story-pipeline.ts`, `wave-compile-pipeline.ts`, `visual-qa-pipeline.ts`, `plan-build-pipeline.ts`, `wave-build-pipeline.ts`, `pm-plan-pipeline.ts`, daemon `compile-pipeline.mjs`, daemon `epic-compile-pipeline.mjs`) replace string concat with resolver calls. | Story 2-A-1-1   |
| PR-33 | `PROJECT_CONTEXT` typed           | **Zod schema in `functions/shared/schemas/project-context-schema.ts`**, validated at inject-time in daemon `context-pack-resolver.mjs` + `story-context-pack.mjs`. Validation failures emit `attention.context-pack-invalid` (medium severity) and skip the inject (PR-12 already strips before DDB persist).                                                                                             | Story 2-A-2-1   |
| PR-34 | Baseline-diff design              | **Design doc `docs/concepts/pipeline-v2/baseline-diff-design.md`**; sequences into 3 implementation PRs (PR-35 starter scripts, PR-36 daemon wiring, PR-37 acceptBaselineDrift mechanism).                                                                                                                                                                                                                | Story 2-A-4-1   |
| PR-35 | API-AUTHOR step ownership         | **Lives in `functions/shared/pipelines/story-pipeline.ts`** alongside TEST/DEV/REVIEWER/COMPILER. New `API-AUTHOR` agent definition with `allowedTools: 'Write(${STORY_MODULE}/index.d.ts),Read,Glob,Grep'` and `maxTurns: 2`. Pipeline gains a new step before `test-author`. Skipped under prototype rigor.                                                                                             | Story 2-A-3-1   |
| PR-36 | Tamper-check ownership            | **Daemon `pipelines/lib/tamper-check.mjs`** runs SHA-256 snapshot at TEST step end and compare after DEV step. Husky `pre-commit` hook in starter reads `.pipeline/frozen.txt`. Defense-in-depth — both layers ship together.                                                                                                                                                                             | Story 2-A-5-1   |
| PR-37 | Per-story branch ownership        | **Daemon owns all `wip/*` branches.** Operators never touch `wip/`. Created on `git-init-story` step, deleted on wave-merge success or escalated as `abandoned/<original>` on daemon GC if found unattributed.                                                                                                                                                                                            | Story 2-B-1-1   |
| PR-38 | Worktree storage location         | **`/home/ubuntu/worktrees/<project>/<plan>/<storyId>`**, outside the project tree per v2.5 §24.1. EBS budget: 2GB × concurrent-slot count × active-plan count.                                                                                                                                                                                                                                            | Story 2-B-2-1   |
| PR-39 | Distributed lock backend          | **Existing single DDB table** (no extra infra). `PK = LOCK#<project-slug>`, `SK = MERGE`, attributes `holder` + `acquired_at` + `ttl`, conditional write with TTL=now+5min. 5-min TTL handles daemon-crash recovery.                                                                                                                                                                                      | Story 2-B-4-1   |
| PR-40 | Wave-merge conflict-resolver tier | **Tier 1 only — operator falls through.** v2.5 mentions a Tier-2 `wave-conflict-resolver` agent; not in Phase 2 scope. Conflicts surface as `merge-conflict` attention items with file list and operator runbook link.                                                                                                                                                                                    | Story 2-B-3-1   |
| PR-41 | ARCHITECT model + sandbox         | **Sonnet by default, Opus when `aws.manifest.yaml` is empty (greenfield).** Same model selection logic as PM. ARCHITECT runs in the primary worktree (read-mostly except for manifest writes); never spawns inside per-story worktrees.                                                                                                                                                                   | Story 2-D-4-1   |
| PR-42 | OIDC role naming                  | **`futurator-pipeline-${appSlug}-${env}`** for GitHub Actions deploys. Trust policy scoped to `repo:futurator-repos/${appSlug}:ref:refs/heads/main` for dev, `:ref:refs/tags/${appSlug}-v*` for production.                                                                                                                                                                                               | Story 2-D-3-1   |
| PR-43 | CDK qualifier                     | **`futurator`** per v2.5 §54 (D.4). Avoids collision with the default `hnb659fds` qualifier already used by SST in the admin app.                                                                                                                                                                                                                                                                         | Story 2-D-3-1   |
| PR-44 | `Plan.kind` enum expansion        | **Add `feature`, `bugfix`, `maintenance`, `prototype-on-top`, `hotfix`, `rigor-upgrade`, `implementation-spec`** alongside existing `initial`/`change`/`experiment`. Migration: existing rows mapped `initial`→`feature` for new plans, `initial`→`implementation-spec` for app-bootstrap-style plans. Backfill job deferred — old rows keep their existing kind.                                         | Story 2-A-7-1   |

---

## 5. Architectural decisions encoded in this phase

These are the choices that bind every Phase 3 surface. Captured here so a reader
of this doc one quarter from now can reconstruct intent.

1. **Policy-as-code, not policy-as-prose.** Tool allowlists, turn caps, and
   per-step gates live in typed schemas resolved at spawn time. Agent prompts
   stop carrying "do not edit X" rules — the rules become mechanical
   impossibilities at the CLI layer. PR-3 was the seed; PR-32 is the proper
   structure.

2. **Git is the durable substrate; DDB stores process state.** Phase 1
   established this for App identity (slug = repo = working dir = URL); Phase 2
   extends it to per-story state via `wip/<storyId>` branches + commit metadata
   per v2.5 §23. Reconstruction queries against history are `git log --grep`,
   not DDB scans. DDB stores plan/job/event rows + Timer summaries + the merge
   lock — process state, not code state.

3. **Inner-loop fixes precede outer-loop fixes.** A.6 (API-AUTHOR), A.7
   (tamper-check), and A.5 (baseline gate) close the brick-breaker incident
   classes that Phase 1 worked around with prompts. They land before B.2
   (branch-per-story) so per-story isolation is meaningful — isolating a story
   that can still tamper its own tests buys nothing.

4. **Wave-merge is the integration moment, not story-merge.** Stories collect
   on `wip/` branches; wave-merge is where conflicts surface. v2.5 §26 is
   non-negotiable on this — story-by-story merge would let undetected
   incompatibilities accumulate. PR-19 already pushes per-story commits but
   Phase 2 changes target from `main` to `wip/<storyId>`.

5. **Distributed lock for `main` writes only.** Concurrency lives at the wave-
   merge moment (one writer per repo at a time). Inside a wave, parallelism is
   filesystem-isolated by worktrees + git. The lock is DDB-conditional (no
   extra infrastructure).

6. **ARCHITECT does not run inside per-story worktrees.** It reads the primary
   worktree, writes to `aws.manifest.yaml` and `integrations.manifest.yaml`,
   and emits CDK in `deployment/cdk/`. It runs at trigger points (T1: project
   init, T2: plan intent submitted, T3: brownfield audit), not during story
   execution. This decouples infrastructure decisions from per-story velocity.

7. **Phase 2-A and Phase 2-B can interleave; Phase 2-D follows.** A and B both
   plug into the same pipeline file (`story-pipeline.ts`); changes don't
   conflict and parallel work makes sense for them. D adds a separate agent
   (ARCHITECT) and a separate output surface (manifests + CDK) and is mostly
   independent of A/B.

---

## 6. Phase 2-A — Inner-loop discipline (the active sub-phase)

**Goal.** Promote the inner-loop discipline already partially shipped via
PR-2/3/4/5 into typed, mechanical, rigor-aware structure. Land the four net-new
gates (api-author, baseline-diff, tamper-check, single-pass-verification) with
the same fidelity as the Phase-1 hardening pass.

**Source.** v2.5 §9–§20, Phase A enumeration §51 (10 items, ~11d minus ~30%
already shipped ≈ ~7d net-new).

**Dependency.** None — Phase 2-A is the entry point.

**Sequencing within sub-phase.** A-1 (policy) and A-2 (context) first; they're
prerequisites for everything else. Then A-3 (api-author), A-4 (baseline-diff),
A-5 (tamper-check) in any order. A-6 (single-pass + Explore caching) and A-7
(`Plan.kind` + metrics CSV) wrap up.

### Epic 2-A-1 — Tool policy as code 🔧

**Goal:** Typed `RolePolicy` schema resolved at spawn time. Replaces 8 hardcoded
allowlist strings with one resolver. Closes Phase A item A.2 (`--allowedTools` /
`--disallowedTools`) — PR-3 partial, PR-32 finishes.

**Dependency:** none.

#### Story 2-A-1-1 — Typed `RolePolicy` schema + spawn-time resolver

`pv2-p2-A-1-1-typed-role-policy` · **M** · backlog

**Acceptance Criteria:**

1. `functions/shared/pipelines/role-policy.ts` exports `RolePolicy` (Zod schema with `role`, `allowedTools[]`, `disallowedTools[]`, `maxTurns`, optional `writePathGlobs[]`) and `resolveRolePolicy(boilerplateKind, rigor, role): RolePolicy`.
2. Resolver inputs use existing types: `BoilerplateType` from `functions/shared/boilerplates/types.ts`, `Rigor` enum (`'prototype' | 'mvp' | 'production'`), `Role` enum (`'API_AUTHOR' | 'TEST' | 'DEV' | 'REVIEWER' | 'COMPILER' | 'PM' | 'PARTY' | 'CONVERSATION' | 'REFLECTION' | 'DEPLOY' | 'TOUCH_POINT'`).
3. Eight pipeline files migrate to `resolveRolePolicy(...)` calls — no remaining hardcoded `allowedTools: '...'` strings in `functions/shared/pipelines/*.ts` or `daemon/pipelines/*.mjs` for the in-scope agents.
4. Daemon (`agent-daemon.mjs:644-645`) is unchanged — agents continue to set `allowedTools` and `disallowedTools` as strings. The serialization happens in the policy → string adapter at the call site.
5. Read-only roles (REVIEWER, REFLECTION, conversation/explore) emit `--disallowedTools "Write,Edit,NotebookEdit,Bash"` per v2.5 §10 (Bash deny is the most important).
6. Write-path globs (e.g. `Write(${STORY_MODULE}/index.d.ts)` for API-AUTHOR) round-trip through the schema even though only API-AUTHOR uses them in Phase 2; field exists for future agents.
7. Unit tests: every `(boilerplateKind, rigor, role)` combination in the cartesian product resolves to a non-empty `allowedTools` and a `disallowedTools` containing `Bash` for read-only roles. Snapshot tests capture the resolved string per role.
8. No behavioural change observable in plan execution — a clean run of `dino-runner-1` produces the same forensic JSON shape as before PR-32 (resolver outputs match the strings PR-3 set).

**Touch points:**

- `functions/shared/pipelines/role-policy.ts` (new — schema + resolver)
- `functions/shared/pipelines/__tests__/role-policy.test.ts` (new)
- `functions/shared/pipelines/story-pipeline.ts` (replace strings)
- `functions/shared/pipelines/wave-compile-pipeline.ts` (replace strings)
- `functions/shared/pipelines/visual-qa-pipeline.ts` (replace strings)
- `functions/shared/pipelines/plan-build-pipeline.ts` (replace strings)
- `functions/shared/pipelines/wave-build-pipeline.ts` (replace strings)
- `functions/shared/pipelines/pm-plan-pipeline.ts` (replace string)
- `daemon/pipelines/compile-pipeline.mjs` (replace string)
- `daemon/pipelines/epic-compile-pipeline.mjs` (replace string)
- `daemon/pipelines/conversation-pipeline.mjs` (replace string)
- `daemon/pipelines/self-reflection-pipeline.mjs` (replace string)
- `daemon/pipelines/deploy-compile-pipeline.mjs` (replace string)

**Tasks:**

- [ ] Author `role-policy.ts` schema + cartesian-product baseline policy table
- [ ] Implement `resolveRolePolicy(...)` (pure function — no side effects)
- [ ] Author `role-policy.test.ts` with snapshot tests per role
- [ ] Migrate `story-pipeline.ts` agent definitions to call resolver
- [ ] Migrate the seven other pipeline files
- [ ] Type-check + lint + test pass; `npm run ci` clean
- [ ] Run a fresh plan against `dino-runner-1`; diff forensic JSON pre vs post — should be byte-equal except for timestamps/IDs

#### Story 2-A-1-2 — Per-rigor turn caps from policy

`pv2-p2-A-1-2-per-rigor-turn-caps` · **S** · backlog

**Acceptance Criteria:**

1. `RolePolicy.maxTurns` is populated per the v2.5 §17 matrix: api-author=2, TEST=6/8/10, DEV=8/10/12, REVIEWER=4/6/8, QA=—/—/8, PO=—/—/6 (per prototype/mvp/production).
2. Pipelines that previously set `maxTurns` independently now read `policy.maxTurns`.
3. Unit test verifies the matrix per `(rigor, role)`.
4. Daemon honors the new caps — observed in forensic JSON `step_complete.numTurns` ≤ cap.

**Touch points:**

- `functions/shared/pipelines/role-policy.ts` (extend)
- All eight pipeline files (replace per-step `maxTurns` lookups)

**Tasks:**

- [ ] Encode the v2.5 §17 matrix in `role-policy.ts`
- [ ] Update pipelines to read `policy.maxTurns`
- [ ] Run plan; verify forensic `numTurns` capped

---

### Epic 2-A-2 — Context pack as typed contract 📦

**Goal:** Lift `PROJECT_CONTEXT` from accretion-grown shape to a Zod schema with
inject-time validation. Closes Phase A item A.4 (Context pack injection) — PR-11

- PR-15 partial.

**Dependency:** none (parallel with 2-A-1).

#### Story 2-A-2-1 — `PROJECT_CONTEXT` Zod schema + inject-time validation

`pv2-p2-A-2-1-project-context-schema` · **M** · backlog

**Acceptance Criteria:**

1. `functions/shared/schemas/project-context-schema.ts` exports `ProjectContextSchema` (Zod) + `ProjectContext` type. Shape: `{ fileTree: string[], packageJson: object | null, tsconfig: object | null, existingTests: string[], publicExports: { types: string[], constants: string[] }, frozenFiles: string[], boilerplateKind: BoilerplateType, generatedAt: string, fileContents: Record<string, string> (PR-15) }`.
2. Inject-time validation in `daemon/pipelines/lib/context-pack-resolver.mjs` and `daemon/pipelines/lib/story-context-pack.mjs` — call `ProjectContextSchema.safeParse(...)` before substituting into the prompt template.
3. Validation failure emits `attention.context-pack-invalid` (medium severity) with the Zod error path. Daemon proceeds with `PROJECT_CONTEXT` set to the empty fallback rather than the malformed value.
4. PR-12 (strip transient before DDB persist) keeps working — schema includes `fileContents` but the strip helper is updated to read schema field names rather than hardcoded keys.
5. Unit tests: full valid pack passes; missing `fileTree` fails with a clear path; oversized `fileContents` (> 100 KB) emits a warning but still validates (size enforcement is separate concern).
6. Existing `dino-runner-1` plan execution unchanged — validation passes, no attention items emitted on the happy path.

**Touch points:**

- `functions/shared/schemas/project-context-schema.ts` (new)
- `functions/shared/schemas/__tests__/project-context-schema.test.ts` (new)
- `daemon/pipelines/lib/context-pack-resolver.mjs` (validate at boundary)
- `daemon/pipelines/lib/story-context-pack.mjs` (validate at boundary)
- `daemon/pipelines/lib/attention-writer.mjs` (new attention type)
- `functions/shared/services/plan-reducer.ts` (if PROJECT_CONTEXT travels through reducer state)

**Tasks:**

- [ ] Author Zod schema mirroring current PR-11 + PR-15 shape
- [ ] Add `safeParse` at both inject sites
- [ ] Wire `attention.context-pack-invalid` (mirror existing attention-writer signature)
- [ ] Test happy path + missing-field + oversized-content
- [ ] Run plan; confirm zero attention items on green path
- [ ] Negative test: corrupt the resolver output, confirm attention surfaces

#### Story 2-A-2-2 — Auto-populate `existingTests` + `publicExports`

`pv2-p2-A-2-2-context-pack-test-and-exports` · **M** · backlog

**Acceptance Criteria:**

1. `context-pack-resolver.mjs` runs `git ls-files '*.test.*' '*.spec.*'` to populate `existingTests`.
2. `context-pack-resolver.mjs` greps `^export` from `src/types/*.ts` and `src/constants/*.ts` to populate `publicExports.types` and `publicExports.constants`.
3. v2.5 §11.1 invariant: every TEST agent's prompt prepends "the following test files are immutable contracts" with the `existingTests` list. (TEST prompt template updated.)
4. Brick-breaker incident 2 regression test — synthetic plan that introduces a new exported value attempts to widen a type already locked by a test; baseline-diff gate (Epic 2-A-4) catches it. (This story sets up the surface; the gate enforces.)
5. Pack regenerates per wave by default; `--rebuild-context-pack` daemon flag forces mid-wave rebuild.

**Touch points:**

- `daemon/pipelines/lib/context-pack-resolver.mjs`
- `daemon/pipelines/lib/story-context-pack.mjs`
- `functions/shared/pipelines/story-pipeline.ts` (TEST prompt template — add immutable-contracts line)

**Tasks:**

- [ ] Add `git ls-files` shell-out in resolver
- [ ] Add `grep -hE '^export'` shell-out
- [ ] Update TEST prompt template
- [ ] Test: schema validates with populated arrays
- [ ] Daemon flag for mid-wave rebuild

---

### Epic 2-A-3 — API-AUTHOR step (frozen `.d.ts`) 🔒

**Goal:** Insert API-AUTHOR between PM and TEST so type names are physically
shared. Closes Phase A item A.6 — net-new.

**Dependency:** Epic 2-A-1 (RolePolicy needs to know about API_AUTHOR role).

#### Story 2-A-3-1 — `API-AUTHOR` agent + `api-author` step

`pv2-p2-A-3-1-api-author-step` · **L** · backlog

**Acceptance Criteria:**

1. `functions/shared/pipelines/story-pipeline.ts` adds an `API_AUTHOR` agent definition. Allowlist via resolver: `Write(${STORY_MODULE}/index.d.ts), Read, Glob, Grep`. Disallowlist: `Bash, Edit, Task, Agent, WebFetch, WebSearch`. `maxTurns: 2`.
2. Pipeline gains a new `api-author` step that runs **before** `test-author` for mvp+ rigor. Skipped under prototype rigor with a forensic event marker `step.skipped.rigor-prototype`.
3. `${STORY_MODULE}` is derived from the story's `touchPoints[]` (set by PR-4 — touch-point inference). If touchPoints span > 1 module, daemon emits `attention.api-author-ambiguous-module` and the operator picks.
4. API-AUTHOR's emitted `.d.ts` is committed (under prototype: skipped; under mvp: committed by COMPILER step at the end; under production: committed by API-AUTHOR itself with `Agent: API-AUTHOR` metadata).
5. Both the TEST prompt and DEV prompt are extended to: "Import every type from `./index` — names are frozen by API-AUTHOR." This is enforced by the existing PR-3 string allowlist for now; v2.5 §10 path-glob enforcement lands when daemon supports per-call cwd-relative globs (deferred to 2-A-3-2).
6. Forensic JSON shows `api-author` step entry between `pm-output` and `test-author` for mvp+ plans; the step entry includes `outputFile: "src/<module>/index.d.ts"`, `numTurns`, and `outputTokens`.
7. Story pipeline retry logic: API-AUTHOR rarely retries; on `--max-turns 2` exhaustion, emit `attention.api-author-failed` (medium) and skip to `test-author` with a flag that TEST gets a "no frozen surface — choose names defensively" prompt addendum.

**Touch points:**

- `functions/shared/pipelines/story-pipeline.ts` (new agent + new step)
- `functions/shared/pipelines/role-policy.ts` (API_AUTHOR policy — depends on 2-A-1)
- `functions/shared/prompts/api-author-prompt.ts` (new)
- `functions/shared/prompts/__tests__/api-author-prompt.test.ts` (new)
- `daemon/agent-daemon.mjs` (recognize new agent role; existing dispatch already string-passes allowedTools)
- `functions/shared/types/agent-orchestrator.ts` (extend `Role` enum)
- `functions/shared/timer/types.ts` (extend `AgentEventType` if needed for the new step)
- `functions/shared/timer/slicer.ts` (map api-author step to `api-stub` category — see Epic 2-A-7)

**Tasks:**

- [ ] Add `API_AUTHOR` to Role enum + RolePolicy
- [ ] Author api-author prompt template (small, ~30 lines)
- [ ] Insert step into story-pipeline
- [ ] Daemon: dispatch API_AUTHOR role
- [ ] Timer classifier: map api-author event to category
- [ ] Run plan against `nextjs-canvas-game`; verify `.d.ts` emitted and TEST/DEV import from it
- [ ] Negative test: ambiguous touchPoints → attention item

#### Story 2-A-3-2 — Per-call cwd-relative path-glob enforcement

`pv2-p2-A-3-2-path-glob-enforcement` · **M** · backlog

**Acceptance Criteria:**

1. Daemon supports `RolePolicy.writePathGlobs[]` translated to Claude CLI `--allowedTools "Write(<glob>),Edit(<glob>)"` form, expanded against the story's worktree cwd.
2. API-AUTHOR receives `Write(src/<module>/index.d.ts)` only — attempts to write elsewhere fail at the CLI layer.
3. TEST receives `Write(**/*.test.ts), Write(**/*.test.tsx), Write(e2e/**/*.spec.ts), Read, Glob, Grep, Bash` — exactly per v2.5 §10 example.
4. DEV receives the inverse — `Write(**/*.{ts,tsx})` with `disallowedTools "Write(**/*.test.*), Edit(**/*.test.*), Write(e2e/**/*.spec.ts), Edit(e2e/**/*.spec.ts)"`.
5. Brick-breaker incident 1 (TEST writes `destroyedIds`, DEV writes `destroyedBrickIds`) cannot recur — physical impossibility.

**Touch points:**

- `daemon/agent-daemon.mjs` (extend allowedTools serializer for path-glob form)
- `functions/shared/pipelines/role-policy.ts` (populate writePathGlobs per role)

**Tasks:**

- [ ] Daemon serializer: `Write(<glob>), Edit(<glob>)` form
- [ ] Populate writePathGlobs in policy
- [ ] Negative test: TEST attempts to write src file → CLI rejects
- [ ] Negative test: DEV attempts to write test file → CLI rejects

---

### Epic 2-A-4 — Baseline-diff regression gate ⚖️

**Goal:** Capture passing tests at wave start, refuse to ship a story that
regresses them. Closes Phase A item A.5 — net-new.

**Dependency:** Epic 2-A-2 (context pack must list existing tests).

#### Story 2-A-4-1 — Baseline-diff design doc

`pv2-p2-A-4-1-baseline-diff-design` · **S** · backlog

**Acceptance Criteria:**

1. `docs/concepts/pipeline-v2/baseline-diff-design.md` exists. Sections: scope, scripts (`capture-test-baseline.sh` + `check-regressions.sh`), invocation points (wave-start + post-DEV), rigor matrix (prototype warn / mvp+ block), `acceptBaselineDrift` mechanism (PR label for production, decision card for mvp/prototype), test-runner detection per boilerplate kind (Next.js: `npm test --reporter=json`; SST: TBD; Vite: `vitest run --reporter=json`), failure-mode handling (timeouts, JSON parse failures), forensic event types.
2. Doc references v2.5 §14 verbatim and notes deltas (e.g. PR-2's pre-DEV gate is preserved; baseline-diff is post-DEV).
3. Sequences into PR-35 (starter scripts in `template-nextjs`), PR-36 (daemon wiring + attention items), PR-37 (`acceptBaselineDrift` mechanism + UI surface).
4. Each follow-up PR has rough effort estimate and a test-gate definition.

**Touch points:**

- `docs/concepts/pipeline-v2/baseline-diff-design.md` (new — doc only)

**Tasks:**

- [ ] Draft per the AC sections
- [ ] Reference v2.5 §14 verbatim block
- [ ] Sequence PR-35/36/37 with effort + test gates
- [ ] Cross-link from this Phase 2 epics doc

#### Story 2-A-4-2 — `capture-test-baseline.sh` + `check-regressions.sh` in starter

`pv2-p2-A-4-2-baseline-scripts-in-starter` · **M** · backlog

**Acceptance Criteria:**

1. `template-nextjs` repo gets `scripts/capture-test-baseline.sh` and `scripts/check-regressions.sh` per v2.5 §14 verbatim.
2. Output files: `.pipeline/baseline-passing.txt` (sorted full-test-name list), `.pipeline/baseline.json` (raw runner JSON), `.pipeline/after-passing.txt`, `.pipeline/after.json`.
3. `.pipeline/` is gitignored.
4. Boilerplate registry (`functions/shared/boilerplates/registry.ts`) declares `baselineCapture: { scriptPath: 'scripts/capture-test-baseline.sh', regressCheckPath: 'scripts/check-regressions.sh' }` per type. SST / Vite / Mobile stubs declare null (gracefully no-op until those types ship).
5. Brownfield regression: `dino-runner-1` (existing) must work with the same scripts after a one-time sync from boilerplate (per v2.5 §13.2 — operator action).

**Touch points:**

- (out-of-repo) `futurator-repos/template-nextjs/scripts/*` (new)
- `functions/shared/boilerplates/registry.ts` (extend metadata)
- `functions/shared/boilerplates/types.ts` (add field)
- `functions/shared/boilerplates/__tests__/registry.test.ts`

**Tasks:**

- [ ] Add the two shell scripts to `template-nextjs`
- [ ] Extend boilerplate metadata
- [ ] Update registry test (G-2 still passes)
- [ ] Smoke-test against fresh `dino-runner-2` App

#### Story 2-A-4-3 — Daemon wiring + attention surface

`pv2-p2-A-4-3-baseline-daemon-wiring` · **M** · backlog

**Acceptance Criteria:**

1. Daemon's story pipeline runs `scripts/capture-test-baseline.sh` at wave start (one shot per wave, before first story's TEST step).
2. `scripts/check-regressions.sh` runs after every DEV step and after `test-verify`.
3. Regression output → `attention.baseline-regression` (medium under mvp, high under production, info under prototype).
4. Forensic JSON gains `baseline-check` step entry with category `baseline-check` (Epic 2-A-7).
5. Attention item includes the regressed test names (top 5 + count).

**Touch points:**

- `daemon/pipelines/story-pipeline-runner.mjs` (or equivalent — wire the gate post-DEV)
- `daemon/pipelines/lib/attention-writer.mjs` (new attention type)
- `functions/shared/timer/slicer.ts` (new category)

**Tasks:**

- [ ] Wave-start shell-out
- [ ] Post-DEV shell-out
- [ ] Attention emission + rigor matrix
- [ ] Forensic event emission

#### Story 2-A-4-4 — `acceptBaselineDrift` mechanism

`pv2-p2-A-4-4-accept-baseline-drift` · **M** · backlog

**Acceptance Criteria:**

1. Production rigor: PR label `futurator:accept-baseline-drift` recognized by daemon — when present on the wave PR, baseline-regression converts from block to warn.
2. mvp/prototype rigor: decision card surfaced in plan dashboard — _"Story X-Y regressed baseline test Z. Intentional?"_. Operator confirms → proceed; declines → wave marked `fixing` and DEV retries.
3. Decision recorded in plan history (forensic JSON + DDB `Plan.driftDecisions[]`).
4. Baseline rolls forward after a green wave: `.pipeline/baseline-passing.txt` overwritten with `.pipeline/after-passing.txt` on wave-merge success.

**Touch points:**

- `daemon/pipelines/wave-completion.mjs` (or equivalent)
- `functions/shared/types/plan.ts` (`driftDecisions[]` field)
- `src/components/plan/baseline-drift-card.tsx` (new — UI)
- `src/hooks/use-baseline-drift.ts` (new)

**Tasks:**

- [ ] Daemon: recognize PR label
- [ ] Decision card UI
- [ ] DDB persistence
- [ ] Baseline-roll-forward on green wave
- [ ] Test: drift accepted → next wave's baseline includes new state

---

### Epic 2-A-5 — Tamper-check + frozen-file pre-commit hook 🔐

**Goal:** Belt-and-braces against test tampering by DEV. Closes Phase A item
A.7 — net-new.

**Dependency:** Epic 2-A-3 (frozen files include API-AUTHOR's `.d.ts`).

#### Story 2-A-5-1 — Runtime tamper-check

`pv2-p2-A-5-1-runtime-tamper-check` · **M** · backlog

**Acceptance Criteria:**

1. `daemon/pipelines/lib/tamper-check.mjs` exports `snapshotFrozenFiles(worktree, fileList)` and `compareSnapshot(worktree, fileList, snapshot)` (returns array of mismatched files).
2. Story pipeline calls `snapshotFrozenFiles` at end of `test-author` step. Frozen list = all test files written/modified by TEST + the API-AUTHOR `.d.ts` (Epic 2-A-3).
3. Story pipeline calls `compareSnapshot` after DEV step (becomes the `tamper-check` step in the 11-step pipeline).
4. First offense → auto-revert mismatched files to snapshot SHA, DEV retry with prompt addendum "your previous attempt modified frozen test files; do not modify any test file".
5. Second offense → `attention.tamper-repeat` (high severity), wave halts.
6. `.pipeline/frozen.txt` is written (one path per line) at TEST step end and cleared on story → done. Used by Story 2-A-5-2 hook.

**Touch points:**

- `daemon/pipelines/lib/tamper-check.mjs` (new)
- `daemon/pipelines/lib/__tests__/tamper-check.test.mjs` (new)
- `daemon/pipelines/story-pipeline-runner.mjs` (wire snapshot + compare)
- `daemon/pipelines/lib/attention-writer.mjs` (new attention types)

**Tasks:**

- [ ] SHA-256 snapshot helper
- [ ] Compare helper
- [ ] Wire into story pipeline (snapshot post-TEST, compare post-DEV)
- [ ] Auto-revert path
- [ ] Second-offense escalation
- [ ] Test: synthetic DEV mutation of test file → revert + retry

#### Story 2-A-5-2 — Frozen-file Husky pre-commit hook in starter

`pv2-p2-A-5-2-frozen-file-husky` · **S** · backlog

**Acceptance Criteria:**

1. `template-nextjs/.husky/pre-commit` reads `.pipeline/frozen.txt`; if file present and any staged file matches an entry, refuses commit per v2.5 §16.
2. Hook is no-op when `.pipeline/frozen.txt` missing.
3. Other husky responsibilities (lint-staged, typecheck) preserved.
4. Brownfield: `dino-runner-1`'s existing husky hook updated via boilerplate sync (operator action per v2.5 §13.2).

**Touch points:**

- (out-of-repo) `futurator-repos/template-nextjs/.husky/pre-commit`
- `functions/shared/boilerplates/registry.ts` (note version bump for sync notification)

**Tasks:**

- [ ] Update template hook
- [ ] Smoke: stage a frozen file → commit blocked

---

### Epic 2-A-6 — Single-pass verification + Explore caching ⚡

**Goal:** Drop DEV's redundant `npx vitest run`; cache TEST's Explore subagent
output for DEV reuse. Closes Phase A items A.8 + A.9.

**Dependency:** Epic 2-A-1 (turn caps live in policy).

#### Story 2-A-6-1 — Single verification pass + scoped vitest

`pv2-p2-A-6-1-single-pass-verify` · **S** · backlog

**Acceptance Criteria:**

1. DEV prompt template no longer instructs DEV to run `npx vitest run` itself; verification happens in `test-verify` step only.
2. `test-verify` step uses `npx vitest run --changed HEAD~1 || npx vitest run` per v2.5 §17.
3. Forensic `test-verify` step entry shows `numTurns: 0` agent involvement (it's a shell step) and the test result count.
4. Wave-completion-check still runs the full suite per v2.5 §26 — single-pass applies to in-story verification only.

**Touch points:**

- `functions/shared/pipelines/story-pipeline.ts` (DEV prompt edit)
- `daemon/pipelines/story-pipeline-runner.mjs` (test-verify shell step)

**Tasks:**

- [ ] Edit DEV prompt
- [ ] Update test-verify shell command
- [ ] Verify forensic shows single shell run

#### Story 2-A-6-2 — Cache TEST's Explore output for DEV

`pv2-p2-A-6-2-explore-output-cache` · **S** · backlog

**Acceptance Criteria:**

1. After TEST step, daemon parses `stream-json` output and extracts the `Agent(subagent_type="Explore")` invocations into `.pipeline/explore-input-$STORY_ID.md` per v2.5 §18.
2. DEV's context pack for the same story prepends the cached file contents.
3. Cache invalidates on wave-merge (cleared by daemon at wave-merge step).
4. Saves ~30s per story (verifiable via Timer Intelligence delta vs pre-PR baseline).

**Touch points:**

- `daemon/pipelines/lib/context-pack-resolver.mjs` (read cache when present)
- `daemon/pipelines/story-pipeline-runner.mjs` (write cache after TEST)

**Tasks:**

- [ ] Stream-json parse helper
- [ ] Cache-write hook post-TEST
- [ ] Cache-read prepend pre-DEV
- [ ] Cache-clear on wave-merge

---

### Epic 2-A-7 — `Plan.kind` enum + metrics CSV 📊

**Goal:** Expand `Plan.kind` from 3 to 7+ values per v2.5 §5; emit per-step
`metrics.csv` per v2.5 §19. Closes Phase A item A.10 (partial — Timer
Intelligence covered most of it).

**Dependency:** none (parallel with all other A epics).

#### Story 2-A-7-1 — `Plan.kind` enum expansion

`pv2-p2-A-7-1-plan-kind-enum` · **M** · backlog

**Acceptance Criteria:**

1. `functions/shared/types/plan.ts` extends `Plan.kind` with `feature | bugfix | maintenance | prototype-on-top | hotfix | rigor-upgrade | implementation-spec` alongside existing `initial | change | experiment`.
2. PM prompt (`pm-plan-prompt.ts`) updated to emit new kinds where appropriate; brownfield (`change`) and greenfield (`initial`) preserved.
3. New plan UI exposes the new kinds via the existing emoji picker (PR-9 in Phase 1 hardening).
4. Plan-build-pipeline + wave-build-pipeline branch on kind where v2.5 specifies (e.g. `hotfix` skips PO/QA gates per v2.5 §50.4 — placeholder for now since PO/QA aren't in Phase 2 scope; encode the branching, leave the gate stubs).
5. Migration: existing plans keep their existing kind. New plans use new kinds.
6. Backfill job not in scope.

**Touch points:**

- `functions/shared/types/plan.ts`
- `functions/shared/schemas/plan-schema.ts`
- `functions/shared/prompts/pm-plan-prompt.ts`
- `src/components/plan/new-plan-form.tsx` (kind picker)
- `functions/shared/pipelines/plan-build-pipeline.ts` (kind branching)

**Tasks:**

- [ ] Extend type + Zod schema
- [ ] Update PM prompt
- [ ] Update New Plan UI
- [ ] Add kind-branching stubs in plan-build-pipeline
- [ ] Test: each kind round-trips through DDB

#### Story 2-A-7-2 — `metrics.csv` per plan + wave threshold check

`pv2-p2-A-7-2-metrics-csv-emission` · **S** · backlog

**Acceptance Criteria:**

1. Daemon tees Claude `step_complete` events to `<workdir>/.pipeline/metrics.csv` per v2.5 §19 (columns: story_id, agent, num_turns, output_tokens, cache_read, cache_creation, context_percent).
2. Wave-completion-check: if total turns for the wave > 1.5× rolling median (last 5 waves of same plan kind), emit `attention.wave-turn-budget-exceeded` (info severity).
3. CSV survives across daemon restarts (append, never truncate).
4. Forensic JSON export includes the wave's CSV rows.

**Touch points:**

- `daemon/agent-daemon.mjs` (tee logic)
- `functions/cron/wave-completion-check.ts` (threshold check + attention)
- `functions/shared/timer/forensic-builder.ts` (include CSV rows in export)

**Tasks:**

- [ ] CSV append in daemon spawn wrapper
- [ ] Wave-completion-check median calc
- [ ] Attention surface
- [ ] Forensic-builder include

#### Story 2-A-7-3 — New Timer Intelligence categories

`pv2-p2-A-7-3-new-timer-categories` · **S** · backlog

**Acceptance Criteria:**

1. `functions/shared/timer/types.ts` `AgentEventType` extends with: `ApiAuthorStep`, `BaselineCheck`, `TamperCheck`, `WorktreeInit`, `WaveMerge`, `MergeLockWait`.
2. `functions/shared/timer/classifier.ts` maps each new event to a new category (`api-stub`, `baseline-check`, `tamper-check`, `branch-isolation`, `wave-merge`, `merge-lock-wait`).
3. G-5 (classifier coverage test) updated; compile-time exhaustiveness still passes.
4. G-4 (MECE) still holds — sum across new categories continues to equal total.
5. Timer Intelligence panel in plan dashboard surfaces the new categories with stable colors (extends existing palette).

**Touch points:**

- `functions/shared/timer/types.ts`
- `functions/shared/timer/classifier.ts`
- `functions/shared/timer/__tests__/classifier-coverage.test.ts`
- `src/components/plan/timing-panel.tsx`

**Tasks:**

- [ ] Add event types
- [ ] Map to categories
- [ ] Update classifier-coverage test
- [ ] Update G-4 fixture
- [ ] Add palette colors

---

## 7. Phase 2-B — Git substrate

**Goal.** Per-story `wip/` branches + worktrees; wave-merge `--no-ff` with full
re-run; distributed merge lock; commit metadata template per v2.5 §23.

**Source.** v2.5 §21–§32, §52 (12 items, ~17d). Phase-3 deferrals subtract
B.10 (speculation `explore/` + EVALUATOR — ~3d). Net Phase 2-B effort: ~14d.

**Dependency.** Phase 2-A epic 1 (RolePolicy needed for daemon to spawn into a
worktree cwd) and epic 2 (context pack rebuild per worktree).

**Sequencing within sub-phase.** B-1 (branch-per-story + commit metadata) and
B-2 (worktrees) first; they're prerequisites for B-3 (wave merge). Then B-4
(merge lock), B-5 (plan tag → semver + branch protection), B-6 (stream
auto-archive), B-7 (daemon GC), B-8 (experiment + hotfix namespaces).

### Epic 2-B-1 — Branch-per-story `wip/` + commit metadata 🌿

**Source items:** B.2 (3d).

**Stories:**

- **2-B-1-1** — `git-init-story` step: `git worktree add` + `git checkout -b wip/<storyId> <epic-base-sha>`. Forensic event `WorktreeInit` mapped to `branch-isolation` category. **L**
- **2-B-1-2** — Commit metadata template per v2.5 §23 emitted by COMPILER step. Includes Project / Plan / Plan-Kind / Phase / Epic / Wave / Story / Agent / Model / Rigor / Stream / Tests-Added / Tests-Modified / Files-Changed. CI lint on commit message: `Tests-Modified: N > 0` from non-TEST agent fails build. **M**
- **2-B-1-3** — Per-rigor PM prompt update — PM emits `Plan-Kind` + frozen names (per v2.5 §15) so api-author becomes a pass-through. **S**

### Epic 2-B-2 — Per-story worktrees 🗂️

**Source items:** B.3 (2d).

**Stories:**

- **2-B-2-1** — Worktree creation under `/home/ubuntu/worktrees/<project>/<plan>/<storyId>`; daemon cwd scoped per spawn. Capacity check (EBS) before create. **L**
- **2-B-2-2** — Worktree lifecycle: removed on wave-merge success, retained on story failure for inspection until operator resolves. Daemon log shows worktree count + EBS used. **M**

### Epic 2-B-3 — Wave merge `--no-ff` + full re-run 🔀

**Source items:** B.4 (1d).

**Stories:**

- **2-B-3-1** — Wave-merge step per v2.5 §26: serial `git merge --no-ff wip/<storyId>` per story; full `pnpm install --frozen-lockfile && pnpm test && pnpm run build` against merged state; on green, push; on red, `git reset --hard origin/main` + `merge-conflict` attention. Tier 1 only (no `wave-conflict-resolver` agent — operator resolves). **L**
- **2-B-3-2** — Wave smoke check per v2.5 §26.1: dev server starts + root URL returns 200 + no console errors during page load. Failure → revert wave merge + `wave-smoke-failed` attention. **M**

### Epic 2-B-4 — Distributed merge lock 🔒

**Source items:** B.5 (1d).

**Stories:**

- **2-B-4-1** — DDB conditional-write lock per v2.5 §27. `PK = LOCK#<project-slug>`, `SK = MERGE`, `holder` + `acquired_at` + `ttl=5min`. Daemon acquires before wave-merge, releases on success/failure. TTL handles crash recovery. Reuses existing single DDB table — no extra infrastructure. **M**

### Epic 2-B-5 — Plan tag + branch protection by rigor 🏷️

**Source items:** B.6 (1d) + B.7 (1d).

**Stories:**

- **2-B-5-1** — Plan completion → `<project>-plan-<plan-slug>` tag emitted per v2.5 §29; deploy to staging triggered on tag push. **M**
- **2-B-5-2** — Operator-initiated semver promote → `<project>-v<semver>` tag emitted per v2.5 §29; production deploy gated on tag (24h soak + audit + approval are Phase 3-D.15 deferrals — Phase 2 only emits the tag). **M**
- **2-B-5-3** — Branch protection by rigor per v2.5 §31: daemon runs `gh api -X PUT /repos/<owner>/<repo>/branches/main/protection` at project init based on rigor; re-applies on rigor change. Production rigor adds `wave-ready` label requirement. **M**

### Epic 2-B-6 — Stream branches + auto-archive 🌊

**Source items:** B.8 (1d).

**Stories:**

- **2-B-6-1** — `stream/<n>` namespace + 30d-idle auto-archive per v2.5 §22.2 + §25. Daily cron scans, archives idle streams as `archive/stream/<n>@<sha>`. Hard purge is operator-only. **M**

### Epic 2-B-7 — Daemon GC pass on startup 🧹

**Source items:** B.9 (1d).

**Stories:**

- **2-B-7-1** — Daemon GC pass on startup per v2.5 §24.2: list worktrees → cross-reference active jobs in DDB; orphan worktrees → archive branch as `abandoned/<original>`, remove worktree; orphan `wip/` branches → archive or delete; verify `main` clean. Uses existing stale-heartbeat scanner pattern (PR-28). **M**

### Epic 2-B-8 — `experiment/` + `hotfix/` branch namespaces ⚗️

**Source items:** B.11 (1d) + B.12 (1d).

**Stories:**

- **2-B-8-1** — `experiment/<plan-slug>` namespace for prototype-on-top plans per v2.5 §22; never auto-merge. Plan kind `prototype-on-top` (Epic 2-A-7) drives branch creation. **M**
- **2-B-8-2** — `hotfix/<issue-slug>` branches off the production semver tag per v2.5 §22 + §50.4. Skips PO/QA gates (gate stubs only — full PO/QA is Phase 3). DEV implements + TEST writes regression test + REVIEWER passes; merges to `main` and cherry-picks to `release/v<N>`. **L**

---

## 8. Phase 2-D — AWS + integrations

**Goal.** ARCHITECT agent + manifest-driven CDK + GitHub Actions OIDC. Brings
infrastructure into the same pipeline that handles code.

**Source.** v2.5 Part V + §54 (18 items, ~33d). Phase-3 deferrals subtract
D.11-EVALUATOR portion (~1d), D.15 (production deploy gate 24h soak — ~2d),
D.17 (sandbox account integration — ~1d). Net Phase 2-D effort: ~28d.

**Dependency.** Phase 2-A and 2-B both feed into D — ARCHITECT spawns under the
same RolePolicy and runs in the same git substrate.

**Sequencing within sub-phase.** D-1 (credentials) → D-2 (manifest schemas) →
D-3 (CDK bootstrap + OIDC) before ARCHITECT lands. Then D-4 (ARCHITECT) and
D-5 (COMPILER CDK gen) in parallel. D-6 (Implementation Spec plan template),
D-7 (Cost engine), D-8 (Layer C + secret rotation), D-9 (reactive triggers),
D-10 (Brownfield audit), D-11 (aws-env-demo + cost-history) wrap up.

### Epic 2-D-1 — Credential layers A + B 🔑

**Source items:** D.1 (2d).

**Stories:**

- **2-D-1-1** — Layer A: existing EC2 instance profile retained, audited for least-privilege. **S**
- **2-D-1-2** — Layer B: per-project IAM roles created at project init via boilerplate. Trust policy scoped to instance profile. **M**

### Epic 2-D-2 — Manifest schemas 📋

**Source items:** D.2 (1d) + D.3 (1d).

**Stories:**

- **2-D-2-1** — `aws.manifest.yaml` Zod schema + parser per v2.5 Appendix D. Fields: `project`, `environments[]` (dev/staging/prod), `services[]` (lambda/dynamodb/s3/cloudfront/etc with sizing), `region`, `cost_envelope`. **M**
- **2-D-2-2** — `integrations.manifest.yaml` Zod schema + parser. Fields: `vendor`, `version`, `secret_path` (SSM), `endpoint`, `planned_status` (active/paused/sunset), `webhook_endpoints[]`. **M**

### Epic 2-D-3 — CDK bootstrap + OIDC 🚀

**Source items:** D.4 (½d) + D.5 (1d).

**Stories:**

- **2-D-3-1** — CDK bootstrap with `futurator` qualifier per v2.5 §54 (D.4). Boilerplate ships `deployment/cdk/` skeleton. **S**
- **2-D-3-2** — GitHub Actions OIDC roles per project per v2.5 §54 (D.5). Trust policy scoped per env (dev = main branch, staging = plan tag, prod = semver tag). Role naming `futurator-pipeline-${appSlug}-${env}` per PR-42. **M**

### Epic 2-D-4 — ARCHITECT agent + T1/T2/T3 🏗️

**Source items:** D.6 (4d).

**Stories:**

- **2-D-4-1** — ARCHITECT agent definition + RolePolicy (Sonnet by default, Opus when greenfield). Allowlist: `Read, Write(.deployment/**), Edit(.deployment/**), Glob, Grep, Bash`. Disallowlist: `Write(src/**), Edit(src/**), Task, Agent, WebFetch, WebSearch`. **L**
- **2-D-4-2** — T1 (project init) trigger: ARCHITECT proposes initial `aws.manifest.yaml` based on `BoilerplateType.defaultManifestSeed`. Decision card surfaces to operator. **M**
- **2-D-4-3** — T2 (plan intent submitted) trigger: ARCHITECT runs in parallel with PM during plan decomposition; emits delta to `aws.manifest.yaml` if intent implies infra change. Surfaces in plan card. **L**
- **2-D-4-4** — T3 (brownfield audit) trigger: `/architect audit` operator command — ARCHITECT scans current AWS account tagged with project slug, proposes manifest reflecting reality. Read-only — never auto-applies. **M**

### Epic 2-D-5 — COMPILER CDK generation 🧱

**Source items:** D.7 (3d).

**Stories:**

- **2-D-5-1** — COMPILER step extension: when `aws.manifest.yaml` changed in the plan, regenerate `deployment/cdk/` from manifest. Idempotent. **L**
- **2-D-5-2** — Wave-merge runs `cdk synth` against the merged state; failure → `cdk-synth-failed` attention. **M**

### Epic 2-D-6 — Implementation Spec plan template 📐

**Source items:** D.8 (2d).

**Stories:**

- **2-D-6-1** — `Plan.kind = 'implementation-spec'` template per v2.5 (5 fixed epics: ARCHITECT T1, SKILL-SCOUT T1 (deferred to Phase 3 — stubbed in Phase 2), CDK bootstrap, GitHub Actions setup, manifest commit). Triggered automatically at project init. **M**

### Epic 2-D-7 — Cost engine 💰

**Source items:** D.9 (3d).

**Stories:**

- **2-D-7-1** — Infracost integration: `cdk synth` output → Infracost CLI → cost estimate per env. Surfaces in plan card before operator confirms. **L**
- **2-D-7-2** — Bedrock cost-shim skill: Infracost doesn't price Bedrock; first cost-shim skill provides per-token pricing per model. **M**
- **2-D-7-3** — Cost envelope check at plan start: if estimated cost > envelope, `cost-envelope-exceeded` attention surfaces before story 1 starts. **M**

### Epic 2-D-8 — Layer C + secret rotation 🎫

**Source items:** D.10 (2d) + D.13 (1d).

**Stories:**

- **2-D-8-1** — Layer C: per-plan ephemeral AWS session via STS AssumeRole. Session valid for plan duration. **L**
- **2-D-8-2** — T7 (secret rotation due) trigger: ARCHITECT scans `integrations.manifest.yaml` for rotation cadences; emits `secret-rotation-due` attention 7 days before due. **M**

### Epic 2-D-9 — Reactive triggers 🔔

**Source items:** D.11 (1d, EVALUATOR portion deferred) + D.12 (3d).

**Stories:**

- **2-D-9-1** — T4 (cost-shape speculation): ARCHITECT proposes alternative shapes when cost envelope breaches; surfaces decision card. (EVALUATOR-driven A/B selection is Phase 3-B.10 — Phase 2 only surfaces options, operator picks.) **M**
- **2-D-9-2** — T5 (cost overrun) + T6 (drift detection) + T8 (vendor change scan) per v2.5 §38: T5 reads CloudWatch billing alarm webhooks; T6 daily drift detection (`cdk diff` against deployed); T8 weekly vendor changelog scan. **L**

### Epic 2-D-10 — Brownfield audit 🔄

**Source items:** D.14 (3d).

**Stories:**

- **2-D-10-1** — `/architect audit` plan template per v2.5 §32. Scans existing AWS resources tagged with project slug; emits proposed `aws.manifest.yaml` + `cdk import` commands. Read-only — operator approves before any apply. **L**

### Epic 2-D-11 — Demo env + cost history 📈

**Source items:** D.16 (1d) + D.18 (½d).

**Stories:**

- **2-D-11-1** — `aws-env-demo` promotion path from `aws-ephemeral` per v2.5 §30.2. Operator action. Stack rename + lifetime tag change. **S**
- **2-D-11-2** — `cost-history.yaml` append-only track in starter; appends on rigor changes. **S**

---

## 9. Dependency graph

```
                 Phase 1 substrate (PR-1 → PR-31)
                            │
                            ▼
              ┌──────────────────────────────┐
              │  Phase 2-A — inner-loop      │
              │  ──────────────────────────  │
              │  2-A-1 (policy)              │
              │     └─► 2-A-3 (api-author)   │
              │     └─► 2-A-5 (tamper)       │
              │  2-A-2 (context pack)        │
              │     └─► 2-A-4 (baseline)     │
              │  2-A-6 (single-pass)         │
              │  2-A-7 (Plan.kind + metrics) │
              └──────────────────────────────┘
                            │
                            ▼
              ┌──────────────────────────────┐
              │  Phase 2-B — git substrate   │
              │  ──────────────────────────  │
              │  2-B-1 (wip/ + metadata)     │
              │     └─► 2-B-2 (worktrees)    │
              │           └─► 2-B-3 (merge)  │
              │                 └─► 2-B-4    │
              │                     (lock)   │
              │  2-B-5 (tag + protection)    │
              │  2-B-6 (stream archive)      │
              │  2-B-7 (daemon GC)           │
              │  2-B-8 (experiment/hotfix)   │
              └──────────────────────────────┘
                            │
                            ▼
              ┌──────────────────────────────┐
              │  Phase 2-D — AWS + integ.    │
              │  ──────────────────────────  │
              │  2-D-1 (creds A+B)           │
              │     └─► 2-D-2 (manifests)    │
              │           └─► 2-D-3 (CDK)    │
              │                 └─► 2-D-4    │
              │                   (ARCHITECT)│
              │                     ├─► 2-D-5│
              │                     │   (CDK)│
              │                     └─► 2-D-6│
              │                       (spec) │
              │  2-D-7 (cost engine)         │
              │  2-D-8 (Layer C)             │
              │  2-D-9 (reactive)            │
              │  2-D-10 (brownfield)         │
              │  2-D-11 (demo + history)     │
              └──────────────────────────────┘
                            │
                            ▼
                Phase 2 ship-gate (§3)
```

**Critical path:** 2-A-1 → 2-A-3/4/5 → 2-B-1 → 2-B-2 → 2-B-3 → 2-B-4 → 2-D-1 →
2-D-2 → 2-D-3 → 2-D-4. ~16-18 days serial.

**Parallel work:** 2-A-2 (context pack, parallel to 2-A-1); 2-A-6 + 2-A-7
(single-pass + metrics, parallel to A-3/4/5); 2-B-5/6/7/8 (tag, stream,
GC, namespaces — parallel to wave-merge); 2-D-7/8/9/10/11 (cost, secret,
reactive, brownfield, demo — parallel to ARCHITECT once D-2 done).

A two-track schedule (one critical path, one parallel) lands the whole phase in
**~22-25 calendar days** at the same cadence as Phase 1 (assuming similar
operator availability).

---

## 10. Test gates (Phase 2 non-negotiables)

These extend the Phase 1 G-1 → G-7 gates. All CI-enforced.

| Gate                                       | What it asserts                                                                                                                                           | Where it lives                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **G-8** RolePolicy resolver coverage       | Every `(boilerplateKind, rigor, role)` combination resolves to a non-empty `RolePolicy`. Read-only roles always emit `disallowedTools` containing `Bash`. | `functions/shared/pipelines/__tests__/role-policy.test.ts`            |
| **G-9** PROJECT_CONTEXT validates          | Schema accepts the current shape produced by daemon; rejects malformed inputs with clear path                                                             | `functions/shared/schemas/__tests__/project-context-schema.test.ts`   |
| **G-10** API-AUTHOR emits exactly one file | `api-author` step writes exactly one `.d.ts` matching `${STORY_MODULE}/index.d.ts`. Daemon CLI rejects writes elsewhere.                                  | `daemon/pipelines/__tests__/api-author-isolation.test.mjs`            |
| **G-11** Baseline-diff blocks regression   | Synthetic plan that regresses a previously-passing test under mvp+ rigor → wave halts + attention item                                                    | `daemon/pipelines/__tests__/baseline-regression.test.mjs`             |
| **G-12** Tamper-check reverts mutation     | Synthetic DEV that modifies a frozen test file → auto-revert + DEV retry + first-offense logged                                                           | `daemon/pipelines/lib/__tests__/tamper-check.test.mjs`                |
| **G-13** Frozen-file pre-commit hook       | Husky hook in starter refuses commit when staged file matches `.pipeline/frozen.txt`                                                                      | (out-of-repo) `template-nextjs/.husky/__tests__/pre-commit.test.bash` |
| **G-14** Plan.kind round-trip              | All 7+ kind values round-trip through DDB; PM emits at least one of each new kind in fixture set                                                          | `functions/shared/__tests__/plan-kind-roundtrip.test.ts`              |
| **G-15** Worktree isolation                | Story A's worktree cannot read or write story B's worktree (filesystem perms or daemon cwd enforcement)                                                   | `daemon/__tests__/worktree-isolation.test.mjs`                        |
| **G-16** Wave-merge metadata               | Every wave-merge commit has `Agent: WAVE-MERGE` metadata + correct `Wave: <n>` + `Plan: <plan-id>`                                                        | `daemon/__tests__/wave-merge-metadata.test.mjs`                       |
| **G-17** Distributed lock contention       | Two concurrent daemon processes attempting wave-merge serialize correctly (one acquires, one waits, no double-merge)                                      | `functions/shared/repositories/__tests__/merge-lock.test.ts`          |
| **G-18** Tests-Modified invariant          | CI lints commit messages; non-TEST agent commit with `Tests-Modified: > 0` fails build                                                                    | `.github/workflows/commit-lint.yml`                                   |
| **G-19** AWS manifest validates            | `aws.manifest.yaml` schema accepts spec-conforming files; rejects malformed                                                                               | `functions/shared/schemas/__tests__/aws-manifest-schema.test.ts`      |
| **G-20** OIDC role assumable               | OIDC role naming convention round-trips: created at project init, `gh` CLI can assume it                                                                  | `functions/shared/__tests__/oidc-trust-policy.test.ts`                |
| **G-21** ARCHITECT scope                   | ARCHITECT cannot write outside `.deployment/**` (CLI rejects)                                                                                             | `daemon/pipelines/__tests__/architect-scope.test.mjs`                 |
| **G-22** Timer MECE with new categories    | G-4 invariant holds across the new `api-stub`/`baseline-check`/`tamper-check`/`branch-isolation`/`wave-merge`/`merge-lock-wait` categories                | `functions/shared/timer/__tests__/slicer-mece.test.ts` (extended)     |

---

## 11. Risks and mitigations

| Risk                                                                 | Likelihood | Mitigation                                                                                                                                           |
| -------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path-glob form `Write(<glob>)` not supported by current Claude CLI   | Medium     | Story 2-A-3-2 has a fallback: keep coarse `--allowedTools "Write,Edit"` + path-glob as advisory in prompt. Ship A-3-1 (the agent + step) regardless. |
| Per-story worktrees explode EBS                                      | Medium     | Per-slot 2GB budget; daemon emits `ebs-pressure` attention at 80% used; worktrees retained only on failure                                           |
| Distributed lock blocks legitimate concurrent merges across projects | Low        | Lock keyed on project-slug — different projects never contend                                                                                        |
| ARCHITECT generates incoherent CDK that nobody catches before deploy | Medium     | `cdk synth` is the gate — D-5-2 surfaces synthesis failures as attention; T6 drift detection catches post-deploy state drift                         |
| Tamper-check false positives (legitimate test refactor)              | Low        | First offense is auto-revert + retry, not escalation; second offense is high-severity but operator can override via attention dismiss                |
| Baseline-diff false positives (timing-sensitive tests)               | Medium     | acceptBaselineDrift mechanism (Story 2-A-4-4) handles intentional drift; flaky tests are a CLAUDE.md-level concern                                   |
| Brownfield projects don't pick up frozen-file hook                   | Certain    | v2.5 §13.2 boilerplate-sync action is operator-triggered; A-5-2 docs the sync; brownfield audit (Phase 2-D-10) is the proper fix                     |
| Wave-merge conflict-resolver agent not in scope, operator burden     | Medium     | `merge-conflict` attention items include file list + diff view link; operator runbook documents resolution flow                                      |
| Plan.kind expansion breaks existing UI                               | Low        | Existing kind values preserved; new kinds layered on; Story 2-A-7-1 includes UI component update                                                     |
| ARCHITECT model selection (Sonnet vs Opus) gets cost wrong           | Medium     | Sonnet default; Opus only on greenfield (where manifest is empty); cost monitored via metrics.csv; tunable in `RolePolicy`                           |
| Cost engine (Infracost) doesn't price Bedrock                        | Certain    | Story 2-D-7-2 ships the first cost-shim skill (Bedrock); pattern extends to other unpriced services                                                  |

---

## 12. Explicit deferrals to Phase 3

So future-Ricardo doesn't think these were forgotten:

**Deferred to Phase 3 (Compounding):**

- **Speculation `explore/` branches + EVALUATOR agent** (B.10, D.11 portion). Phase 2-B-3 / 2-D-9 stub the surface (operator-picks where Phase 3 will EVALUATOR-pick).
- **Skills federation + SKILL-SCOUT** — Phase 3-C entirely. Phase 2-D-6 stubs the SKILL-SCOUT slot in the implementation-spec plan.
- **REFLECTOR + Reflection Inbox** — Phase 3-E entirely. Phase 2-A-7-2 emits `metrics.csv` which is the input REFLECTOR will read.
- **Production rigor 24h soak gate** (D.15). Phase 2-B-5-2 emits the semver tag; the soak runs in Phase 3.
- **Persona evolution** — Phase 3-E.8.
- **`wave-conflict-resolver` agent** (Tier 2 — referenced in v2.5 §26). Phase 2-B-3 is Tier 1 only, falls through to operator.
- **Sandbox account integration** (D.17). Defer to Phase 3-D.17 once skill experiments need it.

**Deferred to Phase 3-F (Brownfield migration of pre-v2 projects):**

- One-by-one migration of Songster, goMAD, Mycelium, Atlassinator, Applicator, Contento, MBE, IndexForge, Contax, cayambe.de, Sellebra, Dasher.
- Phase 2-D-10 ships the **infrastructure** for brownfield audit (`/architect audit`); the actual audit + migration of each pre-v2 project is Phase 3-F.

**Permanently deferred (no current phase):**

- Multi-account AWS migration (v2.5 §22) — stays on shared account until a project's compliance demands otherwise.
- Claude Managed Agents (MA) migration (v2.5 §57) — opt-in per project once EU residency is solved.

---

## 13. Operator runbook hooks

Phase 2 introduces six new runbook entries. Add to `docs/runbooks/`:

1. **`baseline-drift-resolution.md`** — How to handle a `baseline-regression` attention item: reading the regressed test list, deciding accept-vs-revert, applying the `futurator:accept-baseline-drift` PR label or accepting via decision card.
2. **`wave-merge-conflict-resolution.md`** — How to resolve a `merge-conflict` attention item: which worktree to inspect, manual merge in the conflict resolver branch, push and re-trigger.
3. **`worktree-cleanup.md`** — How to manually clean up an `abandoned/<original>` branch the daemon GC found, including diff inspection before deletion.
4. **`tamper-repeat-investigation.md`** — How to investigate a `tamper-repeat` attention item: which DEV iterations modified which files, deciding whether to escalate to a CLAUDE.md change or accept as one-off.
5. **`architect-brownfield-audit.md`** — How to run `/architect audit` against an existing AWS account, review the proposed manifest, and approve `cdk import`.
6. **`oidc-role-rotation.md`** — How to rotate an OIDC role's trust policy (e.g. when an org migrates GitHub repos).

---

## 14. What "done" actually looks like (acceptance demo)

Three minutes of operator time, end-to-end:

1. Open `admin.futurator.ai/labs`.
2. Click **+ New App**, choose **Next.js + BMAD**, type `dino-v2-storyboard`, submit.
3. Watch the App card flip through the saga; App row created with `Plan.kind = 'implementation-spec'` automatically (Phase 2-D-6).
4. Open the new App; create a feature plan: **+ New Plan**, kind `feature`, intent _"Add a storyboard view that shows positions over time."_
5. PM decomposes into 3 epics, ~12 stories. Each epic has a wave plan.
6. Watch the plan dashboard:
   - **Timing panel** shows new categories: `branch-isolation`, `api-stub`, `baseline-check`, `tamper-check`, `wave-merge`, `merge-lock-wait`.
   - **Source tab** shows `wip/E1-S1`, `wip/E1-S2`, `wip/E1-S3` branches concurrently.
   - **GitHub** shows a wave PR (under `pr-mode: true` if enabled, else direct merges visible in `git log`).
7. Wave 1 completes → wave-merge step fires → 4 `--no-ff` merge commits visible in `git log main` with `Agent: WAVE-MERGE`.
8. ARCHITECT proposes `aws.manifest.yaml` delta when the storyboard plan implies S3+CloudFront for static assets; operator confirms; CDK regenerates; `cdk synth` clean.
9. Plan completes → `<dino-v2-storyboard>-plan-storyboard-v2` tag pushed; staging deploy fires.
10. Operator clicks **Promote to production** → `<dino-v2-storyboard>-v0.1.0` semver tag pushed; production deploy queued (full 24h soak gate is Phase 3 — Phase 2 emits the tag and triggers a basic deploy).
11. **Forensic JSON export** shows step entries for all 11 steps for at least one story; MECE invariant holds.

If those eleven steps work without intervention or hand-holding, Phase 2 is done.

---

## 15. Sequence next

1. **Sprint planning** — convert this doc into `docs/sprint-status.yaml` epic/story
   entries (existing tracking system at `tracking_system: file-system`). New
   epic IDs: `epic-pv2-p2-A-1` through `epic-pv2-p2-A-7`, `epic-pv2-p2-B-1` through
   `epic-pv2-p2-B-8`, `epic-pv2-p2-D-1` through `epic-pv2-p2-D-11`.
2. **PR-32 lands** — Story 2-A-1-1 (typed RolePolicy schema + spawn-time
   resolver). Pure refactor, no behaviour change. Validate with a clean
   `dino-runner-1` plan.
3. **PR-33 lands** — Story 2-A-2-1 (PROJECT_CONTEXT Zod schema +
   inject-time validation).
4. **PR-34 lands** — Story 2-A-4-1 (baseline-diff design doc only).
5. **Cohort accumulation** — ship-gate condition #4 from Phase 1
   (3× escalator) needs ≥5 same-shape plans. Each plan run during Phase 2-A
   work feeds the cohort. At ≥5, flip Phase 1 ship-gate #4 to PASS in
   `epics-pipeline-v2-phase-1.md` §14.
6. **Phase 2-A wrap retrospective** — when 2-A-1 → 2-A-7 all at `review`,
   run a wrap retrospective; capture lessons; check whether Phase 2-B
   sequencing still makes sense.
7. **Phase 2-B start** — story 2-B-1-1 (`git-init-story` + `wip/<storyId>`).
8. **Phase 2-D start** — once 2-B-3 (wave-merge) green, story 2-D-1-1.

When Phase 2 ships, this doc gets a status flip to `Shipped 2026-MM-DD` and
the equivalent Phase 3 doc takes over.

---

## 16. Phase 2 hardening pass — PR-32 → PR-?? (in progress)

This section will be authored at wrap (mirror Phase 1 §14). Each PR maps to a
real failure mode observed during Phase 2 implementation runs against
`dino-runner-1` (or a fresh `nextjs-canvas-game` App), with the fix that closed
it.

### Stabilisation PR catalogue (in flight)

- **PR-32** — typed RolePolicy schema + spawn-time resolver (Story 2-A-1-1)
- **PR-33** — PROJECT_CONTEXT Zod schema + inject-time validation (Story 2-A-2-1)
- **PR-34** — baseline-diff design doc (Story 2-A-4-1)
- **PR-35** — (sequenced from PR-34) baseline scripts in starter (Story 2-A-4-2)
- **PR-36** — (sequenced from PR-34) daemon wiring + attention surface (Story 2-A-4-3)
- **PR-37** — (sequenced from PR-34) `acceptBaselineDrift` mechanism (Story 2-A-4-4)
- **PR-38..** — append as Phase 2-A stories ship

### Observed end-to-end runs (cohort tracker)

| Plan                                     | Date       | Outcome                                     | Cohort count |
| ---------------------------------------- | ---------- | ------------------------------------------- | ------------ |
| `plan_dino-runner-1_moo8zzmz`            | 2026-05-02 | (Phase 1) Surfaced PR-14 → PR-21            | 1            |
| `plan_dino-runner-1_moseuhc9`            | 2026-05-05 | (Phase 1) Clean: 5/5 stories, deployed live | 2            |
| _(append per-plan as Phase 2 work runs)_ |            |                                             |              |

When cohort count ≥ 5, flip Phase 1 ship-gate #4 to **PASS** in
`epics-pipeline-v2-phase-1.md` §14.

### Ship-gate scorecard (live)

| #   | Sub-condition                                                | Status | Evidence                                        |
| --- | ------------------------------------------------------------ | ------ | ----------------------------------------------- |
| 1   | All 11 steps fire and are observable                         | TODO   | Forensic JSON shape                             |
| 2   | Per-story branch isolation works under parallelism           | TODO   | `git log` + worktree directories                |
| 3   | Wave merge `--no-ff` with full re-run                        | TODO   | `git log main --merges`                         |
| 4   | Inner-loop discipline gates fire with rigor-correct behavior | TODO   | tamper-check / baseline-diff / api-author tests |
| 5   | Timer Intelligence per-category attribution complete         | TODO   | Timing panel + MECE test                        |

Hand-off to Phase 3 will live below this scorecard once all five PASS.
