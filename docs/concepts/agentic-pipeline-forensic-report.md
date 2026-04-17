# Agentic Pipeline — Forensic Report

**Project:** Chrome Dinosaur Game — React + TypeScript + Vite
**Epic ID:** `713edafa-b826-4aea-b23b-de81aa7e6302`
**Status:** 10/10 stories done, in_review
**Total stories:** 10 (1 + 8 + 1 across 3 waves)

This report analyzes every step, substep, and agent action that occurred across the full story lifecycle, based on actual DynamoDB job records. All durations, costs, and iterations are measured values, not estimates.

---

## Pipeline Architecture Overview

The system runs 3 tiers of work per epic:

```
EPIC
│
├─ WAVE (parallel stories sharing dependencies)
│   │
│   ├─ STORY PIPELINE (one job per story)
│   │   ├─ Step 1: dev              (Agent DEV, haiku)      — implement code
│   │   ├─ Step 2: review           (Agent REVIEWER, haiku) — PASS/FAIL
│   │   ├─ Step 3: retry            (Agent DEV, loop)       — fix if FAIL
│   │   ├─ Step 4: compile-diff     (shell)                 — git diff
│   │   ├─ Step 5: compile-knowledge (Agent COMPILER, sonnet) — wiki articles
│   │   └─ Step 6: compile-sync     (shell)                 — Memgraph + S3
│   │
│   └─ WAVE BUILD CHECK PIPELINE (one job per wave, after all stories done)
│       ├─ Step A: build-check      (shell)                 — npm run build
│       └─ Step B: server-check     (shell)                 — curl health check
│
├─ VISUAL QA PIPELINE (one job per epic, after all waves done)
│   ├─ Step I:   qa-start-server    (shell)                 — start dev server
│   ├─ Step II:  qa-evaluate        (Agent QA, sonnet)      — visual tests
│   └─ Step III: qa-stop-server     (shell)                 — kill server
│
├─ PO REVIEW PIPELINE (one job, optional) — not run for this epic
└─ DEPLOY PIPELINE   (one job, optional) — not run for this epic
```

---

## Actual Measured Performance (Chrome Dinosaur)

### Story pipeline costs and durations

| Story                   | Cost      | Total Duration | Review Attempts | Compile Duration | Compile % of Total |
| ----------------------- | --------- | -------------- | --------------- | ---------------- | ------------------ |
| 1 — Scaffold            | $0.44     | 4m 0s          | 1               | 139s             | 58%                |
| 2 — useGameLoop         | $0.24     | 10m 19s        | 1               | 571s             | 92%                |
| 3 — useGameState        | $0.64     | 13m 40s        | 1               | 147s             | 18%                |
| 4 — useObstacleSpawner  | $0.63     | 12m 33s        | 1               | 639s             | 85%                |
| 5 — DinoSprite          | $0.48     | 5m 0s          | 3               | 64s              | 21%                |
| 6 — ObstacleSprite      | $0.26     | 1m 52s         | 1               | 36s              | 32%                |
| 7 — Ground & Background | $0.25     | 3m 9s          | 3               | 17s              | 9%                 |
| 8 — HUD                 | $0.20     | 2m 12s         | 1               | 56s              | 42%                |
| 9 — GameOverlay         | $0.36     | 3m 54s         | 2               | 102s             | 44%                |
| 10 — App Assembly       | $1.19     | 13m 29s        | 3               | 188s             | 23%                |
| **TOTALS**              | **$4.69** | **70m 8s**     | —               | 1,959s (32m 39s) | **47%**            |

### Epic-level costs and durations

| Pipeline             | Cost      | Duration   | Steps             |
| -------------------- | --------- | ---------- | ----------------- |
| Wave 0 build check   | $0        | 9s         | 2 shell           |
| Wave 1 build check   | $0        | 6s         | 2 shell           |
| Wave 2 build check   | $0        | 6s         | 2 shell           |
| Visual QA            | $0.87     | 6m 29s     | 1 agent + 2 shell |
| **Epic-level total** | **$0.87** | **6m 50s** | —                 |

### Grand total

- **10 stories + QA + 3 build checks: $5.56 USD**
- **Total elapsed wall time (sequential equivalent): ~77 minutes of agent work**
- **Real-world elapsed time (with parallelism + crashes + retries): ~25+ hours**

---

## Step-by-Step Breakdown

### STEP 1: `dev` — DEV Agent writes code (model: haiku)

**Expected behavior:**
The DEV agent receives the story's acceptance criteria and implementation files list. It uses Bash/Read/Edit/Write/Glob/Grep tools to create the required files. Outputs a `---WORK_SUMMARY---` block describing what it did.

**What actually happened:**
Works correctly. Durations ranged from 32s (small hooks) to 640s (useGameState, which involved complex state logic), averaging ~130s per story. Cost averaged $0.12/story.

**Observed issues:**

- **No shared context across stories**: story 10 (App assembly) took 249s + $0.32 because the DEV agent had to re-read every file from previous stories to understand how to wire them together. There's no inherited session memory from prior DEV sessions.
- **Story 3 anomaly (640s, $0.20)**: DEV spent 10+ minutes on a single hook. Logs suggest the agent went down rabbit holes exploring the codebase structure rather than implementing narrowly.

---

### STEP 2: `review` — REVIEWER Agent validates code (model: haiku)

**Expected behavior:**
The REVIEWER agent reads the DEV's work, checks the 5 acceptance criteria, and outputs `VERDICT: PASS` or `VERDICT: FAIL` with structured feedback. If FAIL, the pipeline loops to step 3 (retry).

**What actually happened:**
Runs correctly. Durations 16-60s, cost $0.02-0.11 per invocation.

**Observed issues:**

- **Inconsistent strictness**: Story 5 failed review 3 times for "missing test files" when the original acceptance criteria didn't require tests. The reviewer interpreted `needs_browser=true` as needing test files, but tests are a separate concern from browser rendering. This caused 3 unnecessary dev retry iterations.
- **Review verdicts can conflict with actual criteria**: Story 10 failed review 3 times with increasingly vague feedback ("critical issues", "missing integration"). The final PASS was on the same code — the reviewer essentially gave up.
- **No calibration**: The same REVIEWER passes story 2 on attempt 1 but rejects story 5 three times for equivalent quality code.

---

### STEP 3: `retry` — DEV Agent fixes review failures (loop-only, max 3 attempts)

**Expected behavior:**
When review FAILs, retry resumes the previous DEV session (via `--resume sessionId`) with the reviewer's feedback. DEV fixes issues and emits a new WORK_SUMMARY. Loop returns to review step.

**What actually happened:**
Loop triggered on 4 stories (5, 7, 9, 10). Retry cost $0.02-0.12 per attempt.

**Observed issues:**

- **No progression signal**: If review fails 3 times, the loop just proceeds to compile-knowledge anyway. There's no escalation to human or fallback behavior.
- **Story 10 retry waste**: 3 retries × ~85s each = 255s wasted when the reviewer was being inconsistent, not when the code was actually broken.
- **Session resume context loss**: DEV resumes session but doesn't always remember earlier decisions. Observed the agent re-editing the same file 3 times across retry attempts.

---

### STEP 4: `compile-diff` — Shell: extract changed files

**Expected behavior:**

```bash
cd <workingDir> && git diff --name-status HEAD~1 HEAD
```

Should produce a manifest like `A\tsrc/components/DinoSprite.tsx`.

**What actually happened:**
Runs in <1s, $0 cost. Works.

**Observed issues:**

- **Fallback path is wrong**: The `find -newer .mycelium/last-compile-marker` fallback triggers when `git diff` fails, but it catches every file ever touched since the first compile. For a freshly scaffolded project, the first compile's fallback catches _every file in the repo_, causing the compiler to try to document node_modules and every config file.
- **No commit awareness**: DEV doesn't commit its changes. So `HEAD~1 HEAD` compares against some arbitrary prior state, not against the state before this story began.

---

### STEP 5: `compile-knowledge` — COMPILER Agent writes wiki articles (model: sonnet)

**Expected behavior:**
Read changed files, write markdown wiki articles in `knowledge/code/`, update `knowledge/index.md`, `knowledge/system/dependency-map.md`, and `knowledge/log.md`.

**What actually happened (the biggest problem):**

| Story    | compile-knowledge duration | cost  |
| -------- | -------------------------- | ----- |
| Story 2  | **571s (9.5 min)**         | $0.16 |
| Story 4  | **639s (10.7 min)**        | $0.47 |
| Story 3  | 147s                       | $0.40 |
| Story 10 | 188s                       | $0.34 |
| Story 1  | 139s                       | $0.26 |

The compile-knowledge step consumed **32 of 70 total minutes (47%)** across the epic and **35% of total cost ($1.63 of $4.69)**.

**Observed issues:**

- **Wrong model**: Uses `sonnet` (12x more expensive than haiku) for what is effectively markdown templating. No reasoning complexity.
- **Redundant reads per story**: Every compile session re-reads `knowledge/index.md`, `knowledge/log.md`, `knowledge/system/dependency-map.md` — the same 3 files it just wrote 2 minutes ago in the previous story.
- **Race conditions in parallel waves**: 8 stories in wave 1 each wrote to the same `knowledge/index.md` concurrently. Last write wins; 7 writes are lost.
- **No awareness of small diffs**: Story 2 had a 1-file diff (`useGameLoop.ts`) but compile-knowledge ran 9.5 minutes. The agent went into exploration mode (Glob, Read every file in knowledge/, Grep for imports) when it should have just written one article.
- **Per-file session overhead**: Each compile spawns a fresh Claude session with 27k cache-creation tokens. For a 1-file diff, setup is 75% of tokens used.
- **Memory pressure**: 5 parallel Sonnet compilers on a 1.8GB t2.micro caused OOM kills three times, losing mid-flight work.

---

### STEP 6: `compile-sync` — Shell: embed to Memgraph + S3 backup

**Expected behavior:**

```bash
node /home/ubuntu/scripts/graph-sync.mjs --project <id> ...
aws s3 sync knowledge/ s3://futurator-ai-website/knowledge-live/<id>/
```

Embeds articles into Memgraph graph database and backs up to S3.

**What actually happened:**
Runs in <1s, $0 cost. Reports "success" in every job.

**Observed issues:**

- **Silent failures**: `aws s3 sync` ran but the bucket `s3://futurator-ai-website/knowledge-live/dino-chrome/` is empty. The `|| echo "S3 backup skipped"` swallows errors.
- **graph-sync.mjs execution not verified**: No output captured confirming that Memgraph actually received the nodes/edges.
- **No state validation**: The job marks compilation "success" even if graph-sync did nothing.

---

### WAVE BUILD CHECK — shell: `build-check` + `server-check`

**Expected behavior:**
After all stories in a wave complete, run `npm run build` in the project dir to verify nothing broke. Then start dev server and curl `/` to verify it responds.

**What actually happened:**
3 wave build jobs, each ~6-9s, $0 cost. All passed.

**Observed issues:**

- **Build runs against final wave state, not per-story state**: If story 3 broke the build but stories 4-8 worked around it, the wave-level build check passes and the real break is hidden.
- **Server check is 2s curl**: No verification that the app actually renders or hydrates — just that the HTTP server is up.
- **No rollback on wave build failure**: If `build-check` fails, the pipeline fails the whole wave, but doesn't identify which story broke it.

---

### VISUAL QA — QA Agent runs browser tests (model: sonnet)

**Expected behavior:**
Starts dev server, uses `npx playwright screenshot` to capture visual tests defined in each story's `visualTests` array, and evaluates whether each test passed.

**What actually happened:**
1 job, 6 min 29s duration, $0.87 cost.

- `qa-start-server`: 4s (dev server launch)
- `qa-evaluate`: 385s, $0.87 (QA agent running tests)
- `qa-stop-server`: 0s (kill dev server)

**Observed issues:**

- **Most expensive single step in the pipeline ($0.87)**: More than 2x any other step.
- **Sonnet-powered screenshot evaluation**: The agent takes screenshots and evaluates them using a multimodal Sonnet call. For a simple game this is overkill — the 5 visual criteria across 5 stories could be evaluated in parallel with Haiku + DOM inspection.
- **Sequential test execution**: Each visual test runs serially in one agent session. 25 tests × ~15s each = 6+ minutes.
- **No partial pass/fail granularity**: QA reports an overall verdict but individual test failures aren't surfaced back to specific stories for targeted re-review.

---

## The Real Bottleneck: Compounding Overhead

The system design implicitly assumes linear accumulation, but it actually compounds multiplicatively:

| Source                             | Per-story impact                               |
| ---------------------------------- | ---------------------------------------------- |
| Base dev + review                  | ~2 min, $0.15                                  |
| +1 retry (when review fails)       | +45s, +$0.08                                   |
| +Compile (sonnet, redundant reads) | +2-10 min, +$0.20-0.47                         |
| +OOM crash mid-flight              | +0-25 hours (elapsed), +$0 but requires re-run |
| +Parallel wave contention          | 2-5x slower under load                         |

For 10 stories: design says "should take 20 minutes and $2". Reality: **$5.56 and 25+ hours elapsed**.

---

## What Needs to be Fixed

### Critical (blocking usability)

1. **Claude Code CLI + custom daemon is the wrong architecture**
   - Each `claude` invocation spawns a full Node.js Claude Code process (~200MB RAM, ~30s cold start, ~27k tokens of system prompt as cache creation).
   - The orchestrator is a manually-managed DynamoDB poller with no native streaming, no backpressure, no supervision.
   - This causes: OOM kills, zombie jobs on crash, lost work on restart, no native multi-agent coordination.
   - **Fix:** Move to Claude Agent SDK with subagents. One parent process, many lightweight subagents within a single context. No per-call cold starts, native streaming, proper lifecycle management.

2. **The compile-knowledge step is architecturally misplaced**
   - Runs per-story but writes to shared files (index.md, log.md, dependency-map.md) causing race conditions.
   - Uses Sonnet when Haiku is sufficient.
   - Re-reads the same files every story.
   - **Fix:** Replace with a single post-epic "knowledge consolidation" subagent that sees all diffs at once and writes system files atomically.

3. **Reviewer calibration is broken**
   - Inconsistent verdicts cause unnecessary retries.
   - Story 5 rejected 3x, story 10 rejected 3x — both were passable code.
   - **Fix:** Reviewer needs structured criteria evaluation (pass/fail per criterion) instead of free-form verdict. Or replace with a deterministic linter + a lightweight LLM grader only for subjective criteria.

4. **No session inheritance between steps**
   - DEV, REVIEWER, COMPILER are 3 separate Claude processes. Each starts fresh, reading the same files.
   - **Fix:** Agent SDK subagents share context. DEV's file reads are cached for REVIEWER and COMPILER.

### High priority

5. **t2.micro is undersized for any concurrent agent work**
   - 1.8GB RAM cannot hold even 2 Claude Code processes during heavy tool use.
   - **Fix:** Either upsize the instance, or move execution to Lambda per-agent (ephemeral compute).

6. **No credential lifecycle management**
   - OAuth tokens expire mid-epic. The daemon has no refresh mechanism — it just fails with "Not logged in".
   - **Fix:** Long-running daemons need service account credentials or automatic token refresh, not OAuth from a user's keychain.

7. **No idempotency / crash recovery**
   - When daemon dies mid-story, the job stays RUNNING forever. No one detects that the process is gone.
   - **Fix:** Lease-based job locks with TTL. If a job's lease expires without updates, it's reclaimed.

8. **Credential refresh triggers daemon restart, killing active work**
   - `/api/ec2/refresh-credentials` does `systemctl restart`, killing any in-flight stories.
   - **Fix:** Credentials should be hot-reloadable. Claude Code reads credentials per-invocation, so just writing the file should suffice — no restart needed.

### Medium priority

9. **YOLO mode silently retries failed jobs without bounds**
   - If a story fails 10 times, YOLO retries 10 times. No circuit breaker.
   - **Fix:** Max-retry per story, with escalation to human after N failures.

10. **Visual QA is too coarse**
    - 25 tests in one Sonnet call with screenshots. Can't attribute failures back to stories.
    - **Fix:** Per-story visual QA runs as part of each story pipeline, not deferred to epic-level.

11. **compile-diff fallback path is dangerous**
    - When git diff fails, `find -newer` captures every file ever touched, including node_modules.
    - **Fix:** Either commit after each story (so git diff is always valid) or track changes in a state file the DEV updates.

12. **No observable progress within a step**
    - A compile-knowledge step can run 10 minutes with no intermediate signals. From the UI, it looks frozen.
    - **Fix:** Stream tool-use events per step so "Developing... 10m" can show "Developing... reading DinoSprite.tsx (3/8 files)".

### Low priority (cosmetic / future)

13. **Cost aggregation is imprecise** — totalCost per job drifts from sum of step costs by 5-15%.
14. **Compile success is unverified** — graph-sync.mjs "success" doesn't mean anything actually landed in Memgraph.
15. **S3 sync silently fails** — knowledge-live bucket is empty despite 10 "successful" syncs.

---

## Summary

The current pipeline works end-to-end but is inefficient, fragile, and expensive:

- **47% of total time** spent on the compile-knowledge step (wiki documentation)
- **35% of total cost** spent on that same step
- **3 OOM crashes** requiring manual intervention
- **At least 5 hours** of zombie-job time waiting for detection
- **Inconsistent reviewer** caused 5+ unnecessary retries
- **No session inheritance** between DEV / REVIEWER / COMPILER forces redundant file reads

The path forward — **Claude Agent SDK with subagents** — addresses most of these directly:

- Single parent process eliminates cold starts and OOM risk
- Subagent context inheritance eliminates redundant reads
- Native streaming eliminates the "is it frozen?" problem
- Structured subagent orchestration replaces DynamoDB polling
- Credential management is SDK-level, not per-process

This report is the baseline. Every deficiency above should be addressable in the new architecture without writing a custom daemon.
