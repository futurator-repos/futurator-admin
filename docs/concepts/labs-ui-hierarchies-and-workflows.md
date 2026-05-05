# Labs — Hierarchies, Workflows, Statuses, and UI Reference

> Source document for a brainstorm session on redesigning the Labs UI.
> Reflects the system as it ships at **2026-04-21** (post Epic 17 — Plan-Based Labs).

---

## 1. Mental model

Labs is an **agentic development runtime** where an operator describes product intent in natural language, a PM agent decomposes it into a structured plan, and a pool of Claude agents executes that plan in parallel waves against a live project folder on EC2. The system deploys the result to `futurator.ai/apps/<name>/`.

Three things matter for UI design:

- **The domain is hierarchical** — Plan → Epic → Story → Step. Most UI questions are "what level am I at, and what can I see/do?".
- **Execution is wave-parallel** — multiple agents work concurrently within a wave. The UI should make that obvious and celebrate it.
- **Agents are opaque by default** — each Claude process is a black box. The UI's job is to make those black boxes legible: what step they're on, what they're writing, what's the cost, what's the ETA.

---

## 2. Data hierarchy

```
Plan  (top-level product intent)
├── name              — kebab-case, locks folder + deploy URL
├── intent            — raw user input
├── plan.md           — persisted on disk, regenerated on every edit
├── status            — concept | developing | fixing | review | delivered | archived
├── executionMode     — pipeline | orchestrator
├── totalCostUsd      — rollup across all jobs
├── startedAt         — when concept → developing
├── planBuildJobId    — final integration check
│
└── Epic[]  (1..N groups of related stories, DAG)
    ├── title, goal, acceptanceCriteria
    ├── planId        — FK to Plan
    ├── dependsOnEpics — epic-level DAG
    ├── epicWave      — computed: 0 = first, N = depth
    ├── status        — draft | ready | in_progress | in_review | fixing | completed | failed | deployed
    ├── waveBuildJobs — Record<storyWaveN, buildCheckJobId>
    │
    └── Story[]  (1..N units of dev work, DAG within the epic)
        ├── title, description, acceptanceCriteria
        ├── dependsOn  — story-level DAG (within the epic)
        ├── wave       — computed: 0 = first in its epic
        ├── status     — pending | queued | running | in_review | fixing | done | failed | blocked | skipped
        ├── jobId      — the AgentJob executing this story
        ├── criteria[] — acceptance criteria with needsBrowser flag
        ├── visualTests — emitted by DEV agent if hasBrowserTests
        ├── touchPoints — inferred files the story touches
        ├── complexity — trivial | standard | complex | architectural
        ├── reviewRigor — light | standard | strict
        ├── blocker    — BlockerRecord if status=blocked
        │
        └── Pipeline  (the step-by-step agent plan)
            ├── agents  — DEV, REVIEWER, COMPILER (names + models + tool allowlists)
            ├── maxIterations
            │
            └── Step[]  (6 steps per story-pipeline)
                ├── dev           — agent step — Claude DEV implements the story
                ├── review        — agent step — Claude REVIEWER passes or fails
                ├── retry         — agent step — DEV loops if review failed
                ├── compile-diff  — shell step — extract `git diff`
                ├── compile-knowledge — agent step — Claude COMPILER updates Mycelium wiki
                └── compile-sync  — shell step — push wiki to S3 knowledge-live/
```

**Auxiliary pipelines** (not per-story):

- **Wave-build-check** — runs after each story-wave completes: `npm run build` + dev-server smoke (4 steps: build → build-fix-loop → server-check → server-fix-loop).
- **Plan-build-check** — runs after the last plan-wave completes: same shape, but against the full merged codebase. Flips Plan → `review`.
- **Visual QA** — manually triggered — Claude QA takes Playwright screenshots and scores against visualTests.
- **PO Review** — manually triggered — Claude PO audits the epic against stated acceptance criteria.
- **Dev-server** — manually triggered — Claude OPS starts `npm run dev` in background and returns the public URL.
- **Deploy** — manually triggered — deploy agent publishes `out/` to S3 apps path + CloudFront invalidation.
- **PM-plan** — triggered on plan generation — Claude PM converts intent → Plan JSON.

---

## 3. Status lifecycles

### 3.1 Plan status

```
          (user types intent + clicks Generate Plan)
                          │
                          ▼
   ┌─────────┐  edit   ┌─────────┐  Start Plan Development   ┌────────────┐
   │ (empty) │ ──────▶ │ Concept │ ─────────────────────────▶│ Developing │
   └─────────┘         └─────────┘ ◀──── Regenerate Plan ────└────────────┘
                                                                    │
                        ┌───────────── any epic or plan-build ──────┤
                        ▼                                            ▼
                   ┌────────┐  operator recovers      ┌────────┐ plan-build
                   │ Fixing │──────────────────────▶  │ Review │ passed
                   └────────┘                         └────────┘
                        ▲                                  │
                        │                                  ▼
                        │                             ┌────────────┐
                        │                             │ Delivered  │  (deployed)
                        │                             └────────────┘
                        │
                   archive any time → ┌──────────┐ restore (≤14d) → previous status
                                      │ Archived │
                                      └──────────┘
```

### 3.2 Epic status

Derived from the progression of its stories + build-checks. Operator rarely touches this.

```
draft → ready → in_progress → in_review → completed → deployed
                      │            │            
                      ▼            ▼
                  fixing ◀──────── failed
```

### 3.3 Story status

The one the UI renders most. Recently distinguished `queued` from `running`.

```
pending   (never launched)
   │
   ▼
queued    ← job created as PENDING, daemon slot pending
   │
   ▼
running   ← daemon actively executing
   │
   ▼
in_review ← reviewer pass/fail
   │
   ├─▶ done  ← reviewer PASS
   │
   └─▶ fixing ← reviewer FAIL → retry loop
         │
         ├─▶ done   ← retry passed
         ├─▶ failed ← retry budget exhausted
         └─▶ blocked ← agent reports hard blocker
```

`skipped` = operator explicitly skipped (rare).

### 3.4 Job status (underneath every story, wave-build, plan-build, visual-qa, etc.)

These live in `futurator-agent-jobs` table, owned by the daemon.

```
PENDING       — sitting in the queue
   │
   ▼
RUNNING       — daemon spawned the Claude process
   │
   ├─▶ COMPLETED                     — all steps passed
   ├─▶ COMPLETE_WITH_BLOCKED_STORIES — partial success (orchestrator-mode)
   ├─▶ FAILED                        — step failed or iteration limit hit
   └─▶ STALE                         — daemon heartbeat missed for > 5 min
```

### 3.5 Step status (within a job)

Steps are the finest-grained unit: a single Claude prompt or shell invocation.

```
step_queued → step_start → [step_progress emitted] → step_complete
                                                  └─▶ step_failed
                                                  └─▶ step_retried (loopTo)
```

Not all steps emit all events. Today's daemon emits `step_start` + `step_complete`/`step_failed`. **Progress events for mid-step visibility are missing** — see §8.

---

## 4. Events

Events live in `futurator-agent-events` (TTL 30d). Keyed by `(jobId, eventSeq)`.

### 4.1 Currently emitted

| Event type        | Emitted by | When | Payload |
|-------------------|------------|------|---------|
| `step_start`      | daemon     | job picks up a step | `stepId`, `agentId`, prompt snippet |
| `step_complete`   | daemon     | step exits 0 | captured variables, next step |
| `step_failed`     | daemon     | step exits non-zero or agent validation fails | error, captured variables |
| `step_retried`    | daemon     | `loopTo` directive fires | iteration count, target step |
| `tool_use`        | daemon     | agent calls a tool (Bash, Edit, Read…) | tool name, args (truncated) |
| `agent_message`   | daemon     | agent emits a chat message | text (for the UI log viewer) |
| `validation_failed` | daemon   | a step's validation[] rule failed | rule, expected vs actual |
| `job_complete`    | daemon     | job terminates | final status |

### 4.2 Missing events (proposed)

| Event type        | Purpose |
|-------------------|---------|
| `step_progress`   | Heartbeat every 10s while a step is alive. Surfaces last stdout chunk. Essential for diagnosing stuck steps (see 2026-04-21 QA hang). |
| `step_stdout`     | Partial stdout bytes from shell steps, streamed in 4KB chunks. Drives the "live console" view. |
| `wave_launched`   | Plan-level event when a plan-wave N starts. Decouples UI from polling. |
| `plan_status_changed` | Fires on `concept → developing → review` etc. |

---

## 5. Workflows

### 5.1 Plan creation

```
┌─ Operator ─────────────────────────────┐
│ Labs → [+ New Plan]                    │
│ ├─ Types intent                        │
│ ├─ Accepts auto-suggested name         │
│ └─ Clicks [Generate Plan]              │
└────────────────┬───────────────────────┘
                 │
                 ▼
┌─ API ──────────────────────────────────┐
│ POST /api/plans/from-intent            │
│ ├─ Validates name (kebab, unique)      │
│ ├─ Creates Plan (status=concept)       │
│ ├─ SSM: mkdir + write plan.md          │
│ └─ Creates pm-plan job (PENDING)       │
└────────────────┬───────────────────────┘
                 │
                 ▼
┌─ Daemon (EC2) ─────────────────────────┐
│ Picks up pm-plan job                   │
│ Runs Claude PM with intent             │
│ Captures PLAN_JSON between fences      │
│ Marks job COMPLETED                    │
└────────────────┬───────────────────────┘
                 │
                 ▼
┌─ UI (polling pmJobId) ─────────────────┐
│ Auto-calls /apply-plan on COMPLETED    │
│ Server validates PLAN_JSON (Zod)       │
│ Creates Epic rows + computes waves     │
│ Rewrites plan.md                       │
│ UI renders the plan tree               │
└────────────────────────────────────────┘
```

### 5.2 Plan development

```
Operator clicks [Start Plan Development]
           │
           ▼
POST /api/plans/:id/start
  computePlanWaves(epics) → { epicId → planWave }
  For each epic in plan-wave 0:
    launchPipelineWave(epic, 0) → creates N PENDING jobs
    epic.status = in_progress
    story.status = queued
  plan.status = developing
  plan.startedAt = now

           │
           ▼
Daemon polls agent-jobs, picks up PENDING ones up to slot limit
  Job status: PENDING → RUNNING
  Sync-on-read promotes story: queued → running

           │
           ▼
Each story-pipeline executes 6 steps:
  1. DEV  — Claude implements the story
  2. REVIEWER — Claude reviews; PASS or FAIL
  3. retry (if FAIL) — DEV loops, up to maxIterations
  4. compile-diff — git diff --name-status
  5. COMPILER — Claude updates Mycelium wiki
  6. compile-sync — graph-sync.mjs + S3 backup
  → Job status: COMPLETED
  → Sync-on-read promotes story: running → done

           │
           ▼
Cron (wave-completion-check, every 60s):
  For each epic whose current story-wave is all done:
    Create wave-build-check job (npm run build + server smoke)
    On success: launch story-wave N+1
    On last story-wave done: mark epic completed

  For each plan with all plan-wave N epics completed:
    Launch plan-wave N+1 epics
  For each plan with all plan-waves completed:
    Create plan-build-check
    On success: plan.status = review

           │
           ▼
(Operator reviews, runs Visual QA / PO Review / Deploy as desired)
```

### 5.3 Individual story re-run

```
Operator clicks [Retry] on a failed story
  POST /api/epic-workflows/:id/stories/:storyId/run
  Creates a new PENDING job (fresh jobId)
  story.jobId = new
  story.status = queued
  epic.status = in_progress
```

### 5.4 Regenerate plan (concept only)

```
Operator edits intent, clicks [Regenerate Plan]
  POST /api/plans/:id/regenerate
  Creates a new pm-plan job (same intent)
  UI polls new jobId; applies output on COMPLETED
  Epic tree is REPLACED (no merge in V1)
```

### 5.5 Visual QA (post-review)

```
Plan reaches review  →  operator clicks [Run Visual QA] on an epic
  POST /api/epic-workflows/:id/visual-qa
  Backfill visualTests from job variables
  buildQaPipeline → 3 steps:
    qa-start-server (npm run dev)
    qa-evaluate (Claude QA with Playwright)
    qa-stop-server
  epic.qaJobId = jobId
  epic.status = in_review
```

### 5.6 Dev server (manual)

```
Operator clicks [Start Dev Server]
  POST /api/epic-workflows/:id/dev-server
  OPS agent runs nohup npm run dev in bg
  Extracts PUBLIC_IP + PID
  Returns URL (e.g. http://1.2.3.4:5173)
```

### 5.7 Deploy

```
Operator clicks [Publish]
  Deploy agent:
    npm run build
    aws s3 sync out/ s3://futurator-ai-website/apps/<name>/
    CloudFront invalidation /apps/<name>/*
  plan.deployUrl = https://futurator.ai/apps/<name>/
  plan.status = delivered
```

### 5.8 Archive + restore

```
[⋮ menu] → Archive
  POST /api/plans/:id/archive
  Cancels running jobs
  SSM mv folder → .trash/plans/<name>-<iso>
  plan.status = archived
  preArchiveStatus saved for restore
  (Cron purge-archived-plans after 14d — not yet shipped)

[⋮ menu] → Restore  (archived only)
  POST /api/plans/:id/restore
  SSM mv folder back
  plan.status = preArchiveStatus
```

### 5.9 Hard delete

```
[⋮ menu] → Delete…
  Shows modal: scope of destruction + cost spent + requires typing name
  DELETE /api/plans/:id
  Cascades: events → jobs → epics → folder → S3 → plan
```

---

## 6. Participants (agents + actors)

### 6.1 Human

- **Operator (Richie)** — the only human. Types intent, edits plan tree, clicks Start / Retry / Visual QA / Publish / Archive.

### 6.2 Claude agents

Each has a specific role, model, and tool allowlist. They are invoked by the daemon via `claude -p` subprocesses.

| Agent | Model | Tools | Role |
|-------|-------|-------|------|
| **PM** | Sonnet | Read only | Decomposes intent → Plan JSON (name, epics, stories, deps) |
| **DEV** | Sonnet (default; overridable) | Bash, Read, Edit, Write, Glob, Grep | Writes and edits code for a story |
| **REVIEWER** | Haiku (default) | Read, Grep, Glob (no Write/Edit) | Gates the DEV's work with PASS/FAIL verdict |
| **COMPILER** | Haiku | Read, Write, Edit, Glob, Grep | Updates Mycelium knowledge graph (wiki articles + deps) |
| **QA** | Sonnet | Bash, Read, Write, Glob | Visual QA — Playwright screenshots + element checks |
| **PO** | Opus | Read, Grep, Glob, Bash | Product Owner review — reads AC + verifies against code |
| **OPS** | Haiku | Bash | Starts/stops dev server |
| **Integration-fixer** | Sonnet | Bash, Read, Edit, Write, Glob, Grep | Fixes plan-level build failures (runs plan-build-check fix loop) |

### 6.3 System components (non-human, non-Claude)

- **Daemon** (EC2, Node, systemd) — polls agent-jobs, spawns Claude subprocesses up to slot limit (currently 2-3), emits events.
- **API Lambda** (AWS, Hono) — handles all HTTP from UI. Validates, persists DDB, spawns jobs.
- **Cron (`WaveCompletionCheck`)** — fires every 60s, runs wave reducer + plan reducer.
- **Cron (other)** — cost-aggregator, resource-discoverer, tag-auditor, user-sync, schedule-executor. Not Labs-relevant.
- **CloudFront** — serves admin.futurator.ai + futurator.ai (apps/).
- **Identity Broker** — Google OAuth → JWT tokens.

---

## 7. Buttons + actions (per level)

### 7.1 Labs home (Plans list)

| Button | Scope | Effect | Visibility |
|---|---|---|---|
| `+ New Plan` | page | Opens inline intent form | always |
| Filter chips | page | Toggle which statuses show | always |
| Plan row → click | row | Opens plan detail (`?planId=X`) | always |
| `⋮ Open` | row | same as click | always |
| `⋮ Duplicate` | row | NEW — not shipped. Copies intent, creates new plan | future |
| `⋮ Archive` | row | Soft-delete | non-archived |
| `⋮ Restore` | row | Un-archive | archived only |
| `⋮ Delete…` | row | Opens confirmation modal | always |
| Expand "Archived" | page | Show hidden archived plans | if archived > 0 |
| `Cmd+K` | global | NEW — not shipped. Fuzzy search / open | future |

### 7.2 Plan detail — Plan tab

| Button | Scope | When shown | Effect |
|---|---|---|---|
| `[Regenerate Plan]` | plan | status=concept | Re-runs PM agent with current intent |
| `[Start Plan Development →]` | plan | status=concept AND hasEpics | Flips to developing, launches plan-wave 0 |
| Intent textarea | plan | status=concept | Auto-saves on blur via PATCH |
| `+ Add Epic` | plan | NEW — not shipped | Adds an epic to the tree |
| `⋮ Archive` / `⋮ Delete` | plan | always | Same as row menu |
| Epic tree edit (inline) | epic | NEW — not shipped for V1 | Drag to reorder, rename epics, edit deps |
| `+ Add Story` | epic | NEW — not shipped | Adds a story to an epic |
| Click story | story | post-development | Expands live output / retry button |

### 7.3 Plan detail — Workflow tab

Flat table of all stories.

| Button | Scope | Effect |
|---|---|---|
| `[Retry]` | story | Re-run a failed story |
| `[View Logs]` | story | Open log drawer for that story's jobId |
| Column sorts | table | Sort by status / cost / duration / wave |

### 7.4 Plan detail — Deploy tab

| Button | Scope | When | Effect |
|---|---|---|---|
| `[Start Dev Server]` | plan | any | OPS agent, returns URL |
| `[Run Visual QA]` | epic | epic complete, has browserTests | Runs buildQaPipeline |
| `[PO Review]` | epic | epic complete | Runs PO agent |
| `[Publish]` | plan | status=review | Deploy to S3 |
| `[Copy Deploy URL]` | plan | status=delivered | Copy to clipboard |

### 7.5 Resolve-blocker drawer (when story status=blocked)

| Button | Effect |
|---|---|
| `[Amend Story]` | Edit the story spec, re-run |
| `[Retry]` | Re-run as-is |
| `[Skip]` | Mark skipped, continue |

---

## 8. Real-time log visibility — CURRENT GAPS

This is the biggest gap. Today the UI can see:

- **Job status** (PENDING/RUNNING/COMPLETED/FAILED)
- **Discrete events** per step (`step_start`, `step_complete`)
- **Captured variables** after each step

But NOT:

- **Streaming stdout** from shell steps (npm install, vite build, etc.)
- **Streaming thoughts** from Claude agents (tool_use events exist but aren't rendered cleanly)
- **Step progress** inside a long-running step (no heartbeat)

### 8.1 Proposed architecture — real-time log viewer

```
DAEMON SIDE (EC2):

For agent steps (claude -p):
  ├─ claude --output-format stream-json
  └─ pipe each JSON line → write as `agent_message` event
     with fields: { jobId, stepId, role: assistant|tool, content }

For shell steps (bash):
  ├─ spawn with stdio: 'pipe'
  └─ on stdout data chunk (every 4KB or 1s, whichever first):
     ├─ write `step_stdout` event with chunk + byteOffset
     └─ in parallel, update job.lastStdoutByteAt timestamp

Heartbeat loop (per active step, every 10s):
  └─ write `step_progress` event:
     { jobId, stepId, elapsedMs, lastActivityMs, tokensUsed? }
```

```
API SIDE:

GET /api/agent-jobs/:jobId/events?since=<seq>
  Returns events from agent-events table with seq > since.
  Long-poll: wait up to 30s for new events.

(OR)

GET /api/agent-jobs/:jobId/events/stream  (Server-Sent Events)
  Opens SSE connection, streams events as they're written to DDB.
  Requires DDB streams + Lambda@SSE adapter, or skip and use long-poll.
```

```
UI SIDE:

<LogViewer jobId={story.jobId}>
  ├─ Left rail: list of steps (dev → review → retry → compile-*)
  │  Each with status dot + elapsed time
  │
  ├─ Main panel: selected step's event stream
  │  ├─ Agent messages rendered as chat bubbles
  │  ├─ Tool uses rendered as collapsible <ToolCall name=... args=... />
  │  ├─ Shell stdout rendered as monospace xterm-js
  │  └─ Auto-scroll-to-bottom with "Pause autoscroll" toggle
  │
  └─ Footer: total tokens, total cost, step progress bar
```

### 8.2 Other UI affordances needed

- **Stuck-step warning**: if `(now - lastActivity) > 60s`, show ⚠ on the step dot. Fix for the 2026-04-21 QA hang where the UI just said "Testing…" forever.
- **Cost-per-story tooltip**: hover a story → see tokens + dollars.
- **ETA**: rough projection based on completed stories' avg duration.
- **Daemon slot indicator**: the header should show "2/2 slots used" when queued jobs exist, so operators don't wonder "why isn't my 7-parallel plan actually running 7?"
- **Memory pressure indicator**: t2.micro runs out of memory if Sonnet is chosen for everything. Show RAM left when <100MB.

---

## 9. Known UX gaps (today → to-brainstorm)

| # | Gap | Current state | Desired state |
|---|---|---|---|
| 1 | Plan-level rollup counters stale | `plan.doneStories` never updates from 0 | Cron keeps it fresh |
| 2 | No live log viewer | Events table has data, UI doesn't render | Step-by-step viewer with streaming |
| 3 | No per-step progress heartbeat | Stuck steps look like slow steps | Heartbeat every 10s; ⚠ if quiet >60s |
| 4 | Plan tree not editable post-generation | Read-only | Drag-drop, inline rename, add/remove |
| 5 | No concurrency guard on plan creation | Double-click creates duplicate plans | Idempotency key or workingDir lock |
| 6 | File-explorer delete is too destructive | Clicking trash = rm -rf instantly | Moved to Admin panel + needs name-type-to-confirm |
| 7 | No cost visibility during development | Only final rollup in the epic card | Live cost-per-step with token counter |
| 8 | Daemon slot count is fixed (2-3) | Hardcoded | Configurable + autoscale based on EC2 type |
| 9 | No "pause" button on a plan | Must archive or let it run | Pause running jobs; resume later |
| 10 | `qa-start-server` shell step hangs | Dev-server keeps stdout open | Fix: redirect stdout in pipeline definition |
| 11 | No notification/toast system | Errors only in inline banners | Global toast for background events |
| 12 | No activity log at the plan level | Have to drill into jobs | Timeline view: "wave 0 launched", "E1 done", "build-check passed" |
| 13 | Agent "personality" invisible | Just a `DEV` label | Show which Claude model, effort, tools, and current attempt # |
| 14 | Orchestrator mode vs Pipeline mode inconsistent UI | Two different rendering paths | Unify or retire one |
| 15 | No mobile / narrow-screen support | Desktop-only layout | At least: read-only on mobile |

---

## 10. Open questions for the brainstorm

Organized by area so the session can jump around.

### Hierarchy

1. Do we need a fourth level above Plan — a **"Portfolio"** or **"Workspace"** — for organizing many plans? (e.g., "Games", "Client work", "Experiments".)
2. Should epic-level dependencies be editable by the operator post-generation, or should we trust the PM agent?
3. Should we support cross-plan dependencies (Plan B depends on Plan A's deployed API)?

### Status model

4. Is `fixing` a status or an orthogonal flag (a plan can be "developing AND fixing")? Today it's a status.
5. Do we need a `paused` status to let operators temporarily halt without archiving?
6. The daemon's `STALE` status vs. story `failed` — do we surface the difference?

### Parallelism

7. What's the right daemon slot count? Today: 2-3. With 7 parallel stories in a wave, 2 slots means queued-heavy execution. Is scaling EC2 or parallelizing across multiple EC2 instances right?
8. Should the UI animate the "launching wave" moment (e.g., green pulse across all stories in the wave as they flip queued)?

### Logs + visibility

9. Streaming logs vs. long-poll vs. DDB streams → which fits this stack? (Lambda doesn't love SSE, but CloudFront supports it.)
10. How much of the Claude agent's "thinking" do we render in the log viewer? Every `content_block_delta`? Only `tool_use` + final message?
11. Should we surface token counts live, or aggregate at step completion?

### UX patterns

12. Tree-edit UX: inline-editable cells vs. modal-per-edit vs. full markdown editor? My current V1 is read-only; upgrade path?
13. Plan vs. Story vs. Job level — which is the "default" surface operators spend time on? UI should optimize for that.
14. Should a click on a running story open a drawer, a modal, or navigate to a dedicated page?
15. Archive / delete / duplicate — overflow menu vs. dedicated toolbar vs. bulk actions?

### Cost + budgets

16. Should we surface a budget per plan at creation time ("stop if we spend more than $X")? With enforcement?
17. Real-time cost estimation before the operator clicks Start?

### Deployment

18. Is one Plan = one deployed app the right model, or do some plans produce multiple artifacts (frontend + backend + worker)?
19. Should the Deploy tab show a changelog since last deploy?

### Failure recovery

20. When a story is `blocked`, the resolve-blocker drawer lets the operator amend. Should this also be possible when `failed`? (Currently requires manual re-draft.)
21. Auto-retry-with-model-bump: if Haiku reviewer fails 3x, upgrade to Sonnet automatically?

---

## 11. Reference links

- **Epic 16** — Step-based pipeline recovery: [`docs/epics-orchestration-recovery.md`](../epics-orchestration-recovery.md)
- **Epic 17** — Plan-based Labs (this refactor): [`docs/epics-plan-based-labs.md`](../epics-plan-based-labs.md)
- **Pipeline types** — [`functions/shared/types/agent-orchestrator.ts`](../../functions/shared/types/agent-orchestrator.ts)
- **Plan types** — [`functions/shared/types/plan.ts`](../../functions/shared/types/plan.ts)
- **Epic + Story types** — [`functions/shared/types/epic-workflow.ts`](../../functions/shared/types/epic-workflow.ts)
- **Wave reducer** — [`functions/shared/services/wave-reducer.ts`](../../functions/shared/services/wave-reducer.ts)
- **Plan reducer** — [`functions/shared/services/plan-reducer.ts`](../../functions/shared/services/plan-reducer.ts)
- **Story pipeline** — [`functions/shared/pipelines/story-pipeline.ts`](../../functions/shared/pipelines/story-pipeline.ts)
- **Wave-build pipeline** — [`functions/shared/pipelines/wave-build-pipeline.ts`](../../functions/shared/pipelines/wave-build-pipeline.ts)
- **Plan-build pipeline** — [`functions/shared/pipelines/plan-build-pipeline.ts`](../../functions/shared/pipelines/plan-build-pipeline.ts)
- **PM-plan pipeline** — [`functions/shared/pipelines/pm-plan-pipeline.ts`](../../functions/shared/pipelines/pm-plan-pipeline.ts)
- **Forensic pipeline report** (measured behavior on real epic) — [`docs/concepts/agentic-pipeline-forensic-report.md`](./agentic-pipeline-forensic-report.md)
