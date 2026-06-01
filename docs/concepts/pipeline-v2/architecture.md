# Pipeline v2 — Architecture (2026-05-18)

Single dense reference for the operator + future-Claude. Goal: complete picture
of what's shipped today, where the code lives, where it drifts from older spec
docs, and what's still open — so v3 can be designed without re-reading 14 docs.

For prose explainers, point external readers at `pipeline-v2-logic-overview.md`
or the v2.5 consolidated spec; this doc assumes you'll grep alongside it.

---

## 0. Topline

Pipeline v2 is the system that takes a one-line intent (`"build me a dino
runner game"`) and ships a deployed web app to S3+CloudFront, by orchestrating
LLM agents through a 16-step story pipeline executed against per-project
EC2 worktrees, with state in DynamoDB and a 1-minute cron reducer driving
wave + plan progression. It replaces the v1 8-step shape (PM→DEV→QA loop)
with policy-as-code agent allowlists, baked-immutable job pipelines, an
idempotent attention-item dedup contract, and a knowledge-compile sidecar
that ingests every commit into a Mycelium graph (Memgraph + Voyage embeddings).

The three "phases" are an evolutionary axis, not a runtime concept:

- **Phase 1 (substrate, shipped):** the things every plan needs — GitHub
  PAT pool, app-bootstrap saga, DDB schema, Timer Intelligence.
- **Phase 2 (pipeline, ~70% shipped):** the 16-step inner loop, RolePolicy
  agent allowlists, framework-aware port reclaim, baseline-regression gate,
  attention-item dedup, and the cron reducers.
- **Phase 3 (compounding, ~10% shipped):** skills federation, REFLECTOR
  inbox, brownfield migration, speculation branches. Most of this is still
  spec in `epics-pipeline-v2-phase-3.md`; the Memgraph knowledge-compile is
  the only Phase 3 piece live today.

---

## 1. Execution model (the bones)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend (Next.js static export → admin.futurator.ai)               │
│  Operator creates Plan → POST /api/plans → API Lambda                 │
└────────────┬─────────────────────────────────────────────────────────┘
             │ writes Plan + Epic + Story + Job rows to DynamoDB
             │ (jobs are PENDING; pipeline shape is BAKED into the row)
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DynamoDB (24 tables, no single-table design)                        │
│   • futurator-plans / -epic-workflows / -agent-jobs (the core)       │
│   • futurator-attention-items (with PR-7 dedupKey upsert)            │
│   • futurator-agent-events (forensic stream, ALL events)             │
│   • + 18 supporting tables                                            │
└────┬─────────────────────────────────────────────────┬───────────────┘
     │ polled every 1s                                 │ polled every 60s
     ▼                                                 ▼
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Daemon (EC2 t4g.small)    │         │  Cron Lambda                  │
│  agent-daemon.mjs          │         │  wave-completion-check.ts     │
│                            │         │                               │
│  • PENDING → RUNNING       │         │  • reducePlan(plan, epics)    │
│  • spawns claude -p / sh   │         │  • reduceEpicWaves per epic   │
│  • emits events to DDB     │         │  • launches next wave job     │
│  • writes attention items  │         │  • flips plan status          │
│  • git push to wip/<id>    │         │  • triggers QA / deploy       │
└────────────────────────────┘         └──────────────────────────────┘
     │                                                  │
     │ shells claude CLI subprocess per agent step      │
     ▼                                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  /home/ubuntu/projects/<appId>/  (primary worktree, one per app)     │
│  /home/ubuntu/worktrees/...      (per-story worktrees, Phase 2-B)    │
│  Memgraph @ bolt://localhost:7687, Voyage embeddings @ api           │
└──────────────────────────────────────────────────────────────────────┘
```

Three loose laws:

1. **The job row is the source of truth.** Pipeline shape is serialized
   into `futurator-agent-jobs.pipeline` at create-time and never mutated.
   A code redeploy does not change in-flight jobs (this caused the dino-7
   incident — see §10).
2. **The daemon executes; the cron decides.** Daemon never advances waves
   or epics. Cron never spawns Claude. The split is enforced by which
   binary holds the lambdas vs which holds the spawn capability.
3. **All cross-cutting state is in DDB.** No service has private mutable
   state. A daemon restart, a Lambda cold start, a cron skip — none lose
   work, because the next observer reads the same DDB rows.

---

## 2. Phase 1 — Substrate (shipped, May 2026)

**Mission:** the things every plan needs, regardless of how clever the
inner loop gets. If Phase 1 breaks, Phase 2 has nothing to run on.

**Components introduced:**

| Component            | Path                                               | Purpose                                                       |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| API Lambda           | `functions/api/index.ts` (~7600 lines)             | One Hono app, all API routes                                  |
| Daemon               | `daemon/agent-daemon.mjs` (~3000 lines)            | Main loop: poll PENDING, execute step, write events           |
| App bootstrap saga   | `daemon/pipelines/app-bootstrap.mjs`               | Clone boilerplate → npm install → BMAD init → push to GitHub  |
| Boilerplate registry | `functions/shared/boilerplates/registry.ts`        | `nextjs`, `sst`, `vite`, `mobile` (sst/vite/mobile are stubs) |
| PAT pool             | SSM `/futurator/_pipeline/github-pat`              | One org PAT scoped to `futurator-repos`                       |
| Timer Intelligence   | `functions/shared/timer/forensic-builder.ts`       | Per-step event capture → forensic JSON export                 |
| Plan lifecycle       | `functions/shared/repositories/plan-repository.ts` | Plan: `draft → developing → fixing → review → delivered`      |
| App lifecycle        | `functions/shared/repositories/app-repository.ts`  | App: `pending-bootstrap → active`                             |

**State transitions (job-level):**

```
PENDING ──daemon picks up──▶ RUNNING
RUNNING ──step succeeds──▶  RUNNING (next step) or COMPLETED
RUNNING ──step fails (no retry)──▶ FAILED
RUNNING ──daemon crash + heartbeat timeout──▶ STALE (next cron tick reaps)
COMPLETED / FAILED / STALE = terminal
```

**State transitions (plan-level):**

```
draft (operator authoring)
  └─▶ developing (first story job PENDING)
       ├─▶ fixing (any wave story FAILED → epic moves to fixing)
       │     └─▶ developing (operator retries → reducer relaunches)
       └─▶ review (all epics + plan-build pass → QA contract gate)
             └─▶ delivered (operator approves contract + deploy job COMPLETED)
```

**Exit condition for the phase:** Timer Intelligence has cohort baseline
data, `futurator-repos` org is live, app bootstrap saga is stable, plan/
epic/job lifecycle is observable end-to-end. All present today.

**Known fragilities still present:**

- Boilerplate stubs (`sst`, `vite`, `mobile`) have no test infrastructure
  scaffold, so `api-author` step is silently skipped on those projects.
  Only `nextjs-base` is fully wired.
- The dual-Lambda bifurcation of Phase 2 (see §10) shipped _after_ Phase 1
  was declared done — a Phase 1 design assumption (one writer per row)
  was violated by Phase 2 substrate work.

---

## 3. Phase 2 — Pipeline (active, ~70% shipped)

**Mission:** transform Phase 1's "we can run a job" into "we can run the
right 16 steps with the right agent allowlists, deterministic
intermediate gates, and recoverable failure modes."

**Components introduced:**

| Component                 | Path                                                                                      | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Story pipeline            | `functions/shared/pipelines/story-pipeline.ts`                                            | The 16-step shape (see §6)                                              |
| Wave-build pipeline       | `functions/shared/pipelines/wave-build-pipeline.ts`                                       | After all wave stories pass: `npm run build` + dev-server check         |
| Plan-build pipeline       | `functions/shared/pipelines/plan-build-pipeline.ts`                                       | After all epics: same suite at plan scope                               |
| Visual QA pipeline        | `functions/shared/pipelines/visual-qa-pipeline.ts`                                        | 2-stage: aggregate → operator approval → execute                        |
| Framework detect          | `functions/shared/pipelines/framework-detect.ts`                                          | Runtime detection of Vite/Next/Expo/Remix/SvelteKit/Nuxt + port reclaim |
| Role policy               | `functions/shared/pipelines/role-policy.ts`                                               | Per-rigor (`prototype` / `mvp` / `production`) agent tool allowlist     |
| Wave reducer              | `functions/shared/services/wave-reducer.ts` (`reduceEpicWaves`)                           | Per-epic state machine: which wave is next, when to build-check         |
| Plan reducer              | `functions/shared/services/plan-reducer.ts` (`reducePlan`)                                | Per-plan state machine: which epic is active, when plan-build runs      |
| Visual QA launcher        | `functions/shared/services/visual-qa-launcher.ts`                                         | Plan-scoped QA (PR-8); operator-approval gate before execute            |
| Cron entrypoint           | `functions/cron/wave-completion-check.ts`                                                 | 1-min tick; calls `reducePlan` on every active plan                     |
| Shell guard               | `daemon/pipelines/lib/shell-guard.mjs`                                                    | Path-allowlist on shell-step commands                                   |
| Attention writer          | `daemon/pipelines/lib/attention-writer.mjs`                                               | Idempotent upsert by dedupKey (daemon side)                             |
| Attention upsert (Lambda) | `functions/shared/repositories/attention-items-repository.ts` (`upsertOpenAttentionItem`) | Same upsert contract on the Lambda side                                 |
| Knowledge sidecar         | `daemon/scripts/graph-sync.mjs` + `daemon/pipelines/compile-events.mjs`                   | Memgraph (Neo4j-driver) + Voyage embeddings                             |

**Agent roles** (resolved by `role-policy.ts`):

| Role             | Default model | Tool allowlist (mvp)                                                             |
| ---------------- | ------------- | -------------------------------------------------------------------------------- |
| `API_AUTHOR`     | opus-4-6      | Read, Write, Edit (`src/types/**/*.ts` + a few API surfaces)                     |
| `TEST`           | sonnet-4-6    | Read, Write, Edit (test files only)                                              |
| `DEV`            | opus-4-6      | Read, Write, Edit, Bash (broad — but tamper-check enforces test-file invariants) |
| `REVIEWER`       | sonnet-4-6    | Read only                                                                        |
| `COMPILER`       | sonnet-4-6    | Read, Bash (knowledge-compile sidecar)                                           |
| `VISUAL_QA` (L1) | haiku-4-5     | Read, Bash (screenshot tooling)                                                  |
| `VISUAL_QA` (L2) | sonnet-4-6    | Read, Bash (when L1 escalates)                                                   |

Tool allowlist is enforced two ways:

1. CLI flag: `claude -p --permission-mode acceptEdits --allowed-tools "<list>"`
2. PreToolUse hook (Epic 18 free-agent style; not yet universal in Phase 2)

**Rigor tiers** (`PlanRigor` in `functions/shared/types/plan.ts`):

| Rigor        | api-author | test-gate-red | tamper-check | baseline-regression | review-runtime            |
| ------------ | ---------- | ------------- | ------------ | ------------------- | ------------------------- |
| `prototype`  | ❌         | ❌            | ❌           | ❌                  | ❌                        |
| `mvp`        | ✅         | ❌            | ✅           | ✅                  | ✅ (if `hasBrowserTests`) |
| `production` | ✅         | ✅            | ✅           | ✅                  | ✅                        |

**Exit condition for the phase:** one production-rigor plan ships
end-to-end (all 16 steps, wave-build, plan-build, QA aggregate→execute,
deploy) on a non-trivial app, with no manual intervention. Not yet
achieved — see §10.

---

## 4. Phase 3 — Compounding (~10% shipped)

**Mission:** every artifact the pipeline produces (commit, skill manifest,
AWS manifest, persona, story spec) becomes an observable + proposable
managed resource. The system learns from itself.

**Live today:**

- **Knowledge-compile sidecar**: `compile-knowledge` + `compile-sync` +
  `compile-push` steps (12-14 of the 16-step pipeline). Per commit, the
  COMPILER agent emits AST facts + commit metadata + diff summary into
  Memgraph (bolt://localhost:7687) and Voyage embeddings. Powers
  cross-project semantic search at the daemon level (not yet surfaced in
  UI).
- **Brownfield Party projects** (CLAUDE.md §"Recent changes" 2026-05-17):
  register an existing private GitHub repo as a Party-mode debate target.
  One-way `git fetch + reset --hard`. Per-project PAT in Secrets Manager
  - env vars in `PartyProject.envVars` (DDB at-rest KMS).
- **Migrate module** (CLAUDE.md §"Recent changes" 2026-05-18): the
  brownfield bootstrap is now a proper admin wizard with per-project PAT
  - env-var management; PATs at `futurator/brownfield-pat/<projectId>`,
    refresh re-syncs `.env`.
- **Free Claude Code Agent foundation** (Epic 18 Story 18.1, 2026-05-17):
  standalone `FreeAgentSessionRole` assumed via STS per session, session
  tags resolve to read-scoped inline policies, worktrees confined by
  PreToolUse hook (`daemon/pipelines/lib/free-agent-path-hook.sh`).
  Daemon-side GC ticker still pending (Story 18.2).

**Spec but not shipped:**

- SKILL-SCOUT agent + `.claude/skills.manifest.yaml`
- REFLECTOR inbox + `futurator-reflections` table (table exists, agent doesn't)
- Speculation branches (`explore/<plan>-<approach>` parallel pipelines)
- ARCHITECT agent + `aws.manifest.yaml` (placeholders only)
- Production deploy gate (24h staging soak, security-audit, operator approval)
- Drift detection (`cdk diff` weekly job)
- Personas as a managed resource (`futurator-personas` org)

The Phase 3 spec lives in `epics-pipeline-v2-phase-3.md`. Most of it is
still aspirational; treat as v3 input, not current behavior.

---

## 5. Cross-phase substrate

### 5.1 DynamoDB tables (24 total, no single-table)

**Core (read on every cron tick):**

- `futurator-plans` (PK `planId`) — Plan rows; status, epicIds, rigor, qaContractStatus, deployJobIds, totalCostUsd
- `futurator-epic-workflows` (PK `epicId`) — Epic rows; stories[], status, waveBuildJobs map, planId backref
- `futurator-agent-jobs` (PK `jobId`) — **Pipeline definition baked here**, status, sessions, stepResults, variables
- `futurator-attention-items` (PK `planId`, SK `itemId`) — Failure surfaces; PR-7 upsert by `dedupKey` → `itemId = "dk:<dedupKey>"`
- `futurator-agent-events` (PK `jobId`, SK `eventSeq`) — Forensic stream; every step_start / step_complete / tool_use / text_delta / extraction

**Supporting:**

- `futurator-apps` — App row per appId; status, boilerplateType, workingDir
- `futurator-timing-summary` — Forensic aggregate per plan (Story 1.8.6)
- `futurator-agent-sessions` + `futurator-agent-conversations` — Free-agent (Story 18.x)
- `futurator-free-agent-sessions` + `futurator-free-agent-conversations` — Per-session-IAM sessions (Story 18.1)
- `futurator-reflections` — Phase 3 REFLECTOR proposals (table exists, no writers yet)
- `futurator-party-projects` + `-party-sessions` + `-party-events` + `-party-inline-questions` — Party mode (debates against brownfield repos)
- `futurator-project-registry` — Brownfield app metadata
- `futurator-admin-*` (alerts/audits/costs/projects/resources/schedules/users) — Admin surfaces, mostly Phase 1

**Production-only — NEVER delete:** all of the above. SST guard in
`sst.config.ts` throws if `$app.stage !== 'production'` to prevent
non-prod stages from sharing the prod table namespace.

### 5.2 The dedup contract (`futurator-attention-items`)

PR-7 (G+I) defined the idempotent attention surface. As of today, both
sides honor it:

- **Write path:** caller supplies a `dedupKey` (e.g.
  `"wave-reducer:test-gate-failed:<storyId>"`). Writer computes
  `itemId = "dk:" + dedupKey.replace(/\s+/g, "_").slice(0, 1500)` and
  inserts with `ConditionExpression: attribute_not_exists(itemId) OR
status = 'resolved'`. Conditional fail → `UpdateItem ADD
recurrenceCount :one SET lastSeenAt = :now`.
- **Resolve path:** `autoResolveByDedupKey(planId, dedupKey)` flips the
  same row to `resolved`; subsequent recurrences create a fresh open row
  (operator sees a NEW item, not a silent bump).
- **Daemon writer:** `daemon/pipelines/lib/attention-writer.mjs`
- **Lambda writer:** `functions/shared/repositories/attention-items-repository.ts::upsertOpenAttentionItem`
- **Cron adapter** (added 2026-05-18 fix in this session):
  `functions/cron/wave-completion-check.ts:54` routes dedupKey-bearing
  items through the upsert; legacy `createAttentionItem` is fallback only.

**Pre-fix bug (dino1 forensic):** the cron was wired to raw
`createAttentionItem` which honors caller's `itemId`; wave-reducer was
passing `itemId: uuid()` per tick + a `dedupKey`. Result: 54 duplicate
rows for one logical failure, recurring every minute. Fixed in commit
pending (this session). Story moral: when a contract is split across a
daemon writer and a Lambda writer, **wire both ends** the first time.

### 5.3 Job immutability

Every job row's `pipeline` field is the full `PipelineDefinition` (steps,
agents, validations, extractors). The daemon executes verbatim. Two
consequences:

1. **Code deploys don't migrate in-flight jobs.** If you ship a fix to
   `story-pipeline.ts` while a story is RUNNING, that story continues on
   the old pipeline until it terminates. The fix only applies to jobs
   created post-deploy.
2. **Forensic reconstruction is exact.** The pipeline shape that ran is
   in the row; combined with `agent-events` you can replay any failure.

The price: hand-patching a stuck in-flight job's pipeline (we did this
once for snake-4) is unsupported — it's a hotfix, not a workflow.

### 5.4 Cron cadence

`WaveCompletionCheck` cron Lambda fires every minute (SST
`rate(1 minute)`). On each tick:

1. Query `futurator-plans` where `status IN (developing, fixing, review)`.
2. For each active plan, resolve epics, call `reducePlan(plan, epics, deps)`.
3. Reducer iterates epics in order, calls `reduceEpicWaves(epic, ...)`,
   acts on the returned `WaveReducerResult` (no-op / wave-running /
   wave-completed / wave-build-check-pending / wave-build-check-failed /
   epic-completed).
4. If reducer says "launch wave N+1", create new PENDING jobs (one per
   wave-N+1 story), batch insert. Daemon picks them up.
5. Per-plan errors are caught + logged; one bad plan doesn't block others.

**No backpressure today.** Every tick scans every active plan. Fine at
current load (dozens of plans). v3 should add a per-plan `nextTickAfter`
cursor.

### 5.5 Worktrees

- **Primary worktree:** `/home/ubuntu/projects/<appId>/` — clone of the
  app's `app-<appId>` repo on `main`. Shared across all stories of an
  app. Tamper-check runs `git diff HEAD` against this.
- **Per-story worktrees** (Phase 2-B, partially shipped):
  `/home/ubuntu/worktrees/<project>/<plan>/<storyId>/` on branch
  `wip/<storyId>`. Compile-push step pushes to origin. Wave-merge fast-
  forwards to main with `--no-ff` per story (distributed merge lock via
  DDB `PK=LOCK#<slug>, SK=MERGE`).
- **Free-agent worktrees** (Story 18.1):
  `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/` on
  `assist/<projectId>/<sessionId>` — never shared, never auto-merged.

### 5.6 Secrets (SSM Parameter Store, `/futurator/_pipeline/*`)

- `/futurator/_pipeline/github-pat` — org PAT (Phase 1)
- `/futurator/_pipeline/voyage-api-key` — Voyage embeddings (Phase 3 knowledge-compile)
- `/futurator/_pipeline/memgraph-user` + `-memgraph-password` — Memgraph auth
- `futurator/brownfield-pat/<projectId>` — Secrets Manager per-project PAT (Migrate module)
- `futurator/labs-brownfield-github-pat` — legacy shared PAT (back-compat)

Daemon pulls these via `ExecStartPre` into `/run/futurator-daemon.env`
(mode 0600). The systemd unit sources that file on start.

---

## 6. The 16-step story pipeline (annotated)

Source: `functions/shared/pipelines/story-pipeline.ts`. Step count per
`grep -c "id: '"`: 16. Order matters; each step's failure mode triggers
either a retry-loop (back to `dev`) or a fail-and-attention.

| #   | Step ID                  | Type    | Agent            | Gates on                                             | Failure           | Comment                                                                                                                                     |
| --- | ------------------------ | ------- | ---------------- | ---------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------- |
| 1   | `api-author`             | agent   | API_AUTHOR       | rigor=mvp+ AND boilerplate has API surface           | retry inside step | Frozen `.d.ts` stub; defines contracts before TEST writes tests                                                                             |
| 2   | `test-author`            | agent   | TEST             | rigor=mvp+                                           | retry inside step | Writes failing unit + integration tests                                                                                                     |
| 3   | `test-gate-red`          | shell   | —                | rigor=production                                     | fail+attention    | Asserts tests fail (catches no-op TEST)                                                                                                     |
| 4   | `dev`                    | agent   | DEV              | always                                               | loop target       | Implements feature; broad tool access                                                                                                       |
| 5   | `test-verify`            | shell   | —                | rigor=mvp+                                           | loop to `dev`     | Single test pass, changed-files-only                                                                                                        |
| 6   | `tamper-check`           | shell   | —                | rigor=mvp+                                           | loop to `dev`     | Reverts test-file edits by DEV via `git checkout --`                                                                                        |
| 7   | `baseline-regression`    | shell   | —                | rigor=mvp+ AND `scripts/check-regressions.sh` exists | fail+attention    | PR-36 baseline-diff gate                                                                                                                    |
| 8   | `review`                 | agent   | REVIEWER         | always                                               | loop to `dev`     | REVIEW_CRITERIA per AC; aggregator decides PASS/FAIL                                                                                        |
| 9   | `review-runtime`         | agent   | REVIEWER (Haiku) | rigor=mvp+ AND `hasBrowserTests`                     | loop to `dev`     | Screenshot + visual AC check                                                                                                                |
| 10  | `retry`                  | control | —                | review FAIL                                          | loops to step 4   | Up to `maxIterations` (default 3)                                                                                                           |
| 11  | `compile-commit-on-pass` | shell   | —                | review PASS                                          | fail+attention    | Per-story commit; trailers: `Skills-Used`, `Skills-Manifest-Sha`                                                                            |
| 12  | `compile-diff`           | shell   | —                | always (PR-52: tolerates empty diff)                 | non-blocking      | Extracts changed files for downstream compile steps                                                                                         |
| 13  | `compile-ast`            | shell   | —                | always                                               | non-blocking      | Tree-sitter AST → JSON file                                                                                                                 |
| 14  | `compile-knowledge`      | agent   | COMPILER         | always                                               | non-blocking      | Mycelium wiki + AST + metadata; consumes rate-limited shared Claude (compile-failed attentions are common — they're warnings, not blockers) |
| 15  | `compile-sync`           | shell   | —                | always (PR-51 fallback: `                            |                   | echo` for graph-sync crash)                                                                                                                 | non-blocking | `graph-sync.mjs` writes to Memgraph + Voyage |
| 16  | `compile-push`           | shell   | —                | always                                               | fail+attention    | `git push origin wip/<storyId>`                                                                                                             |

**Why "non-blocking" matters:** steps 12-15 emit compile-failed attention
items but never fail the job. The story is "done" once 11 (commit) passes.
If 14-15 fail, knowledge graph is incomplete for that commit — next
compile run rebuilds from the live diff.

**Recent fixes (snake-3/4/dino1 forensics, May 17-18):**

- `framework-detect.ts` port reclaim used pkill patterns that self-matched
  the bash interpreter via `/proc/PID/cmdline`. Fixed with `[c]` bracket-
  class regex trick.
- `shell-guard.mjs` regex scanned the raw script; single-quoted bash
  literals (e.g. paths inside echo strings) matched as traversal attempts.
  Fixed by stripping `'[^']*'` before scanning.
- `compile-sync` graph-sync crash now tolerated via `|| echo` fallback
  (PR-51 follow-up: non-critical step shouldn't fail the story).
- `compile-diff` empty-diff (first commit / merge-base same as HEAD) now
  short-circuits with marker output rather than `git diff` exit 128
  (PR-52).
- Cron attention-item dedup wiring (this session, 2026-05-18): see §5.2.

---

## 7. Wave + plan + QA pipelines

### 7.1 Wave-build pipeline (`wave-build-pipeline.ts`, 5 steps)

Fires when all stories in a wave reach terminal status. Steps:

1. `build-check` — `npm run build`, captures stdout/stderr
2. `dev-build-fix` (loop target) — DEV agent fixes build errors
3. `bundle-source-check` (PR-68) — scans sourcemap `.sources[]` arrays
   for every touch point declared by the wave's stories; missing path =
   "code is in source but orphaned" (catches `src/main.ts` stub never
   importing the new components). Framework-agnostic — works on Vite,
   Rollup, Webpack, esbuild, Turbopack, SvelteKit.
4. `server-check` — boots dev server via framework-detect, curls
   `localhost:$QA_PORT$QA_HEALTH_PATH` 30× over 30s
5. `dev-server-fix` (loop target) — DEV agent fixes server boot errors

Skipped under `prototype` rigor (per-story `tsc --noEmit` is enough).

### 7.2 Plan-build pipeline (`plan-build-pipeline.ts`, 3 steps)

Fires after all epics complete:

1. `plan-build-check` — full `npm run build`
2. `plan-build-fix` (loop target) — same DEV role as wave-build-fix
3. `plan-server-check` — dev server health on `0.0.0.0:$QA_PORT`

Pass → plan flips to `review` → triggers QA aggregate.

### 7.3 Visual QA pipeline (`visual-qa-pipeline.ts`, 2-stage)

PR-8d split this into two jobs to gate destructive runs on operator approval:

```
Plan reaches review status
  └─▶ cron auto-enqueues QA AGGREGATE job
       • parseVisualTests across all epics
       • buildQaAggregatePipeline → emits contract: list of tests to run
       • plan.qaContractStatus = 'pending'
  └─▶ ⛔ OPERATOR REVIEW (this is the bug from docs/qa-review-running-investigation.md)
       • Frontend has no UI for the contract gate
       • Operator clicks "Re-run QA" → re-enqueues aggregate → ⛔ again
  └─▶ POST /api/plans/:id/qa-contract/approve
       • plan.qaContractStatus = 'approved'
       • Cron launches QA EXECUTE job
       • Three-level routing: L0 bash (test scripts), L1 Haiku (visual ACs), L2 Sonnet (escalate)
```

**Open issue:** the contract gate is half-shipped. The aggregate emits the
contract; nothing in UI exposes it to the operator; the cron never auto-
approves. Stories sit in "Re-run QA" with `pending` status forever. Full
investigation + 4 solution options in `docs/qa-review-running-investigation.md`.

---

## 8. Failure handling + attention items

Attention items are the operator-facing surface for everything that
isn't auto-resolved. Categories (from `functions/shared/types/attention.ts`):

- `compile-failed` — non-blocking; step 14 (compile-knowledge) hit rate
  limit or transient error. Acknowledge or ignore.
- `test-gate-failed` — wave story FAILED; epic moved to `fixing`. Click
  "Retry step" to relaunch the story job.
- `dev-retry-exhausted` — DEV looped maxIterations on review/test
  failure. Real triage needed.
- `tamper-reverted` — DEV touched test files; tamper-check reverted +
  failed the step. Often resolves on retry (DEV doesn't repeat the edit).
- `daemon-shutdown-timeout` — daemon SIGTERM'd a stuck job during graceful
  shutdown.
- `context-pack-invalid` — story spec was malformed at job dispatch.
- `pat-rotation-pending` — Phase 1 PAT approaching expiry.
- `visual-qa-failed` — L1/L2 verdict was FAIL or escalated.

**Dedup discipline:** every emitter MUST supply a `dedupKey`. Categories
have stable conventions (e.g. `wave-reducer:test-gate-failed:<storyId>`,
`compile-failed:<planId>:<storyId>:<stepId>`). Recurrence count is the
signal — "this failure has happened 8 times in 2 minutes" is louder than
"8 distinct items."

---

## 9. Daemon mechanics (`daemon/agent-daemon.mjs`)

~3000-line single file. Mental model:

```
main loop (every 1s):
  jobs = scan futurator-agent-jobs WHERE status = PENDING
  for each job:
    if can_acquire_lock(job):                        # heartbeat-based
      mark RUNNING, record startedAt
      for step in job.pipeline.steps:                # baked at create time
        emit step_start
        if step.type == 'agent':
          spawn `claude -p` subprocess with:
            • role policy (allowlist tools)
            • prompt (template + variables)
            • context pack (story spec + AC + project context)
          stream stdout → forensic events
          capture WORK_SUMMARY + extractors → job.variables
        elif step.type == 'shell':
          spawn bash subprocess with:
            • shell-guard (path allowlist)
            • timeout
          capture exit code + stdout/stderr → job.variables
        emit step_complete or step_error
        if step_error and step.onFail.action == 'retry_step':
          loop back, increment retryAttempt
        else if step_error:
          mark FAILED, exit job loop
      mark COMPLETED
```

Heartbeat: daemon updates `job.lastHeartbeatAt` every 30s during RUNNING.
If it stops (daemon crash, OOM, EC2 reboot) the cron detects stale jobs
(heartbeat older than 5min) and marks them STALE + emits attention.

Concurrent jobs: configured via `MAX_CONCURRENT_JOBS` env var (default 3).
Per-job semaphore; no inter-job coordination beyond DDB.

Free-agent sessions (Epic 18) run alongside in the same daemon process but
on a separate spawn path (`daemon/pipelines/free-agent-session.mjs`).

---

## 10. Drift between docs and current code

Things older docs assert that aren't true today:

1. **"8-step pipeline"** (early Phase 2 docs): superseded — code has 16
   steps. Don't trust step counts in `pipeline-v2-logic-overview.md` or
   `futurator-pipeline-v2-5-consolidated.md`.

2. **"Single Lambda for all dispatch"** (Phase 1 assumption): there were
   two — API Lambda for operator-triggered jobs, cron Lambda for wave
   advancement. Until 2026-05-17 they could write incompatible pipeline
   shapes to the same DDB rows (dino-7 incident). Now guarded by
   `assertProductionStage()` in `pipeline-launcher.ts` + `sst.config.ts`
   stage refusal — but the architectural split remains. v3 should
   consolidate.

3. **"Epic orchestrator agent drives epic execution"**: superseded by
   Epic 17 (Plan-based labs). The orchestrator (`daemon/pipelines/epic-
dev-pipeline.mjs`) exists but has no live production callers post-
   Epic 17. `useEpicOrchestrator: false` is the new default (per CLAUDE.md
   2026-05-17). Old `epics-pipeline-v2-phase-2.md` describes orchestrator-
   driven flow — ignore those sections.

4. **"compile-knowledge produces Mycelium wiki entries"**: partially true.
   The agent runs and emits structured output; the wiki rendering side
   isn't built. Memgraph + Voyage facts ARE populated. Mycelium "wiki"
   in older docs = the future renderer, not the storage layer.

5. **"Per-story worktrees on `wip/<storyId>` branches"** (Phase 2-B):
   shipped for some flows, not universal. Primary worktree is still the
   shared `/home/ubuntu/projects/<appId>/` for most plans. v3 should
   finish the per-story isolation.

6. **"ARCHITECT agent + `aws.manifest.yaml`"**: file-level reservations
   exist (`boilerplates/types.ts:54`, `timer/types.ts:14`); no agent, no
   trigger, no schema. Pure spec.

7. **"REFLECTOR inbox"**: table exists (`futurator-reflections`); no
   writers, no readers. Pure spec.

8. **"Baseline-regression actively blocks regressions"**: the step runs
   but the wave-start baseline capture hook (PR-36b) isn't universally
   wired. Today most invocations hit the `BASELINE_EMPTY` short-circuit
   and no-op.

9. **"QA contract gate has an operator UI"** (PR-8d intent): backend
   gate exists; UI doesn't render the contract; cron has no auto-
   approve path. Stories sit in "pending" forever. See
   `qa-review-running-investigation.md`.

10. **"`expo start` pkill pattern is safe"** (older framework-detect
    comments): removed 2026-05-18. The bracket-class trick stops the
    pattern literal from self-matching, but the elif branch's
    `QA_DEV_CMD='npx expo start ...'` contains the bare bytes, so the
    pkill still self-killed. Expo target removed entirely.

---

## 11. v3 entry points — open questions

The decisions Phase 2 deferred that will shape v3:

1. **Unified dispatch.** Should v3 collapse API Lambda + cron Lambda + daemon
   into a single execution stack with one dispatcher? Today's 3-process
   split has caused two production incidents (dino-7 bifurcation, dino1
   attention dedup). The split exists because Lambdas can't shell out to
   `claude -p`, but maybe the cron can become a daemon trigger instead of
   a parallel writer.

2. **Per-plan cron cursor.** Today every cron tick scans every active
   plan. A `nextTickAfter` cursor would let waves that just launched
   skip the next 30s (no need to re-reduce). At current load (dozens of
   plans) this is fine; at 100+ plans it becomes a bottleneck.

3. **Pipeline shape migration.** Job rows bake the pipeline at create
   time. v3 should either: (a) version pipelines and auto-migrate
   in-flight jobs on version bump, or (b) explicitly mark "pipeline
   shape is locked, redeploy waits for in-flight to drain."

4. **Skills + ARCHITECT + REFLECTOR integration.** Phase 3 spec posits
   three new agents that propose changes to managed resources. Where do
   their proposals land — `futurator-reflections`? A new
   `futurator-proposals` table? Per-resource history?

5. **Memgraph + Voyage as service-level dependencies.** Today they're
   sidecars on the same EC2 box. If the daemon crashes Memgraph goes
   too. v3 should either: (a) move them off-host (managed Neo4j Aura,
   Voyage stays SaaS), or (b) decide they're stateful enough to back
   up + restore.

6. **Boilerplate parity.** `sst` / `vite` / `mobile` are stubs. Should
   v3 invest in bringing them to nextjs parity (test infrastructure,
   api-author wiring), or fork v3 around nextjs-only and bring others
   when needed?

7. **Worktree isolation.** Should v3 commit to per-story worktrees
   universally? It costs disk + an extra `git fetch` per story but
   eliminates the entire class of "DEV agent stomped on another wave's
   in-progress file" bugs.

8. **QA contract gate finishing.** Either ship the operator UI (Option
   B in qa-review-running-investigation.md) or auto-approve in cron
   (Option A). Half-shipping is the current mode and it strands plans.

9. **Cost ceiling enforcement.** `Plan.costCeilingUsd` is set at plan
   create-time but no runtime gate. Daemon should refuse to spawn the
   next agent step when `plan.totalCostUsd` exceeds ceiling — today it
   just burns past.

10. **Persona + skill versioning.** v2.5 forbids persona forking but
    doesn't say how versions are validated or rolled back. v3 needs to
    decide if every version change requires operator approval or if
    there's an allowlist mechanism.

---

## 12. Reading order for picking this up cold

If you have 30 minutes:

1. This doc (you're here)
2. `functions/shared/pipelines/story-pipeline.ts` — top-of-file block + step IDs
3. `functions/shared/services/wave-reducer.ts:reduceEpicWaves`
4. `functions/shared/services/plan-reducer.ts:reducePlan`
5. `functions/cron/wave-completion-check.ts` — the cron entrypoint
6. `daemon/agent-daemon.mjs` — top 60 lines (imports tell the story)
7. `docs/qa-review-running-investigation.md` — concrete example of a
   half-shipped contract gate and how to think about closing it

If you have 2 hours: add the three phase docs
(`epics-pipeline-v2-phase-{1,2,3}.md`), `pipelineV2-assessment.md`, and
`futurator-pipeline-qa-stage-redesign.md`. Recognize they're historical;
where they conflict with this doc, this doc wins.

If you're designing v3: also read `epics-free-agent.md` (Epic 18, the
newest substrate work), `epics-epic-orchestrator.md` (the abandoned
orchestrator path, useful as a "what didn't work" lesson), and the live
DDB schema via `aws dynamodb describe-table` for the core tables.
