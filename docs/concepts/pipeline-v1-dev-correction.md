# Pipeline v1 — Development Correction Plan

**Status:** strategic plan, ready for execution
**Inputs:**
- `docs/concepts/pipeline-v1-optimization.md` — 27 findings (F1–F27) from dino3 run + cross-reference
- `docs/concepts/agentic-pipeline-forensic-report.md` — DDB-job-level forensic data from prior Chrome-Dino React+Vite epic
- `docs/concepts/pipeline-enhancement-phases-a-c-handoff.md` — Phases A–D shipped (resilience + attention + rigor + polish)

**Goal:** Reduce **context tokens**, **tool calls**, **wall time**, and **cost** per story by ≥60%, while preserving the parallel-wave correctness model. No re-architecture (that's v2).

**Strategy:** Six bundled corrections, ordered by ROI. Strategies 1–3 are sub-day prompt/daemon fixes; 4–5 are 1–2 day structural fixes; 6 is operational hygiene.

---

## Strategy 1 — Stop the bleeding (single-afternoon prompt/template fixes)

These are the **highest-ROI lowest-effort** fixes. Each is a prompt edit, a daemon-template tweak, or a one-line config change. Combined they eliminate ~50% of waste with ~4 hours of work.

### 1.1 — Daemon writes `visual-tests.md` from extracted block

**Problem (F2):** DEV emits `---VISUAL_TESTS---` inline in its response. REVIEWER expects the block in `visual-tests.md` on disk and FAILs when missing → 50% of browser-testable stories trigger a retry whose only deliverable is moving the text from response to file.

**Fix:**

1. In `daemon/agent-daemon.mjs` (or wherever step extraction lives), after extracting `VISUAL_TESTS` from DEV's output, **append/replace blocks in `<projectDir>/visual-tests.md`** keyed by `criteriaRef`.
2. Update reviewer prompt: *"Visual tests are at `visual-tests.md`. The daemon writes this file from DEV's `---VISUAL_TESTS---` block automatically. If the file exists and contains tests for this story's `criteriaRef`s, the contract is satisfied."*

**Estimated saving:** -1 retry cycle on 50% of stories ≈ -45s and -$0.08 per affected story.

---

### 1.2 — Reviewer prompt: hard 5-call budget, inline story spec, forbid Globs

**Problem (F4, F5, F8, F10, F14, F21):** Reviewer (Haiku) burns 12–17+ tool calls per review hunting for story spec on disk (story files don't exist on EC2), reading the project dir as a file (errors), Globbing patterns that never match. Three reviews in dino3 cut off mid-thought before reaching a verdict.

**Fix — replace reviewer prompt boilerplate with:**

```
You are reviewing a single story's diff. The story spec is below in <story_spec>.
The list of changed files is in <changed_files>. The full content of changed files
is in <file_contents>.

CONSTRAINTS:
- Hard budget: 5 tool calls maximum.
- Do all reads in ONE message with parallel calls. Never sequential.
- Do NOT use Glob, find, or Bash ls — the file list is provided.
- Do NOT Read directories — Read takes file paths only.
- Do NOT search for the story spec or AC on disk — they are in <story_spec> above.
- Do NOT re-grep for symbols Edit just inserted — trust the diff.
- After reading, emit VERDICT and stop.

OUTPUT FORMAT (required):
---REVIEW_CRITERIA---
AC-1: pass
AC-2: pass
AC-3: fail — <reason>
---END_REVIEW_CRITERIA---

VERDICT: PASS  (or FAIL if any AC failed)
FEEDBACK: <only if VERDICT is FAIL — only address failed AC>
```

The structured `---REVIEW_CRITERIA---` block (Strategy 3) makes the verdict deterministic.

**Estimated saving:** -8 to -12 reviewer tool calls per story × ~$0.005/call = -$0.05 to -$0.08 per story; eliminates cut-off reviews.

---

### 1.3 — Flip COMPILER model from Sonnet to Haiku

**Problem (F22):** Compile-knowledge runs on Sonnet for what is markdown templating with no reasoning complexity. Forensic report measured 35% of total epic cost ($1.63 of $4.69) on this step alone, with Sonnet being 12× more expensive than Haiku per token.

**Fix:** In `functions/shared/pipelines/story-pipeline.ts` (or wherever the compile-knowledge step is constructed), change `model: 'sonnet'` → `model: 'haiku'`.

**Estimated saving:** ~92% cost reduction on compile-knowledge ≈ -$1.50 per 10-story epic.

---

### 1.4 — Fix `{{FEEDBACK}}` template substitution in retry prompt

**Problem (F9):** Dev retry sees the literal string `{{FEEDBACK}}` because the daemon's template substitution is broken or feeds it the post-extraction stub (which begins with `**` after the `FEEDBACK = ` label is stripped). Dev wastes a full turn asking "could you paste the real feedback?" before the retry can even begin.

**Fix:**

1. Audit `daemon/pipelines/templates/retry-prompt.md.tpl` (or wherever lives) — verify `{{FEEDBACK}}` is substituted with the **verbatim** reviewer text, not the truncated extraction.
2. Pass only the failed-AC reasons (Strategy 3's structured criteria), not the full PASS/FAIL prose wall.

**Estimated saving:** -1 wasted turn (~$0.02 + 30s) per FAIL retry.

---

### 1.5 — DEV prompt: forbid bootstrap discovery patterns

**Problem (F3, F12, F17, F18):** DEV does `Bash ls`, then `Bash cat <files>`, then `Read <same files>` (harness doesn't dedupe across tools), then re-reads files it just edited, then sometimes spawns an `Agent(Explore)` subagent in parallel with its own discovery, then runs `npm run dev` to "verify" a project that's served via `python3 -m http.server`.

**Fix — append to dev prompt:**

```
DISCOVERY:
- Project tree, plan, story spec, AC, and adjacent files are already in your
  context (see <project_context> above). Do NOT run `ls`, `find`, `tree`, or
  `Bash cat` on the project directory.
- Do NOT spawn Agent / Explore subagents — your context already contains everything.
- Read at most the files you will modify, in ONE message with parallel Read calls.

VERIFICATION:
- Do NOT Read a file you just Wrote or Edited — those tools error if they fail.
- Do NOT run `npm run dev` / `node --check` / `node --input-type=module` for
  ad-hoc verification. The project's runtime is in <run_command>.
- Visual tests in `visual-tests.md` are the contract — your job is to make them
  pass at runtime, not to manually validate.
```

**Estimated saving:** -10 to -15 tool calls per story (mostly affecting later-epic stories that were the worst offenders).

---

### Strategy 1 totals (single afternoon, ~4 hours of work)

| Effect | Per story | Per 10-story epic |
|--------|-----------|-------------------|
| Tool calls saved | -10 to -20 | -100 to -200 |
| Cost saved | -$0.10 to -$0.20 | **-$2 to -$2.50** |
| Time saved | -1 to -2 min | -10 to -20 min |
| Retry rate change | 50% → ~10% | -1.5 to -2 retries total |

---

## Strategy 2 — Story Context Pack (the central context-mgmt fix)

This is the **single highest-impact structural change**. It addresses F1, F5, F7, F13, F16 in one move, and unlocks Strategy 4. Effort: 1–2 days.

### Concept

The daemon assembles **one canonical context block per story** at story-launch time and feeds it to **DEV, REVIEWER, and COMPILER identically**. No agent re-discovers anything; all three share a stable cache anchor.

### Implementation

**New module:** `daemon/pipelines/lib/story-context-pack.mjs`

```js
export async function buildStoryContextPack({ plan, story, prevStoriesInWave, projectDir }) {
  return {
    plan_md: await readPlan(plan.id),                       // full plan.md
    story_spec: serializeStorySpec(story),                  // id, title, AC, touchPoints
    project_tree: await listProjectTree(projectDir, 2),     // dirs + filenames, depth 2
    file_digests: await digestAdjacentFiles(story.touchPoints, projectDir),
                                                            // path → sha + first 50 lines
    recent_diffs: await gitLogSince(plan.waveStart),        // git log --oneline + diffs
    prev_work_summaries: prevStoriesInWave.map(s => s.workSummary), // adjacent dones
    knowledge_index: await readKnowledgeIndex(projectDir),  // index.md only, NOT bodies
    run_command: plan.runCommand || 'python3 -m http.server 8080',
  };
}
```

**Daemon wiring:** the `dev`, `review`, and `compile-knowledge` steps each get the **same** `<project_context>` system prompt block. Role-specific instructions and outputs differ; the shared block is byte-identical so the prompt cache hits across the 3-agent chain.

**Prompt structure for each agent:**

```
<project_context>
{{ contextPack — same for DEV, REVIEWER, COMPILER }}
</project_context>

<role_instructions>
{{ DEV instructions OR REVIEWER instructions OR COMPILER instructions }}
</role_instructions>

<step_input>
{{ DEV: empty / REVIEWER: dev's WORK_SUMMARY + diff / COMPILER: review verdict + diff }}
</step_input>
```

### Why this works

- DEV doesn't bootstrap-discover (project tree + adjacent files are in `<project_context>`).
- REVIEWER doesn't search for the story spec on disk (it's in `<project_context>` as `<story_spec>`).
- COMPILER doesn't re-read the files DEV just edited (the diff is in `<step_input>`, file digests in `<project_context>`).
- The prompt cache stays warm across DEV→REVIEWER→COMPILER because the heavy block is shared. F16 cache-write spikes drop ~80%.
- Knowledge **index** in the prompt (path + 1-line purpose), not knowledge **bodies** — compiler asks for specific articles only when actually editing them.

### What doesn't change

The agents are still 3 separate Claude CLI processes. This isn't the SDK migration (Strategy 8 / v2). It's just disciplined prompt engineering with shared context blocks.

**Estimated saving:** -15 to -25 tool calls per story (DEV bootstrap reads → 0; REVIEWER discovery → 1–2; COMPILER re-reads → 0). ~$0.20 to ~$0.40 per story, 2–5 minutes per story.

---

## Strategy 3 — Structured verdicts + per-story commits

Effort: 1 day.

### 3.1 — Structured per-AC reviewer verdicts (F25)

**Problem:** Reviewer's free-form PASS/FAIL is inconsistent across stories of equivalent quality. Forensic report: Story 5 rejected 3× and Story 10 rejected 3× for "passable code." The reviewer essentially gave up on the third pass. This is the deeper bug behind F2 and F4.

**Fix:** Reviewer prompt now requires (already shown in Strategy 1.2):

```
---REVIEW_CRITERIA---
AC-1: pass
AC-2: pass
AC-3: fail — <reason>
---END_REVIEW_CRITERIA---
```

**Daemon parser** (extract similar to existing `VERDICT` extractor): parse the block, AND all results, set `verdict = FAIL` if any AC failed. For retries, **inject only the failed AC's reason** into the next dev turn — not the full pass/fail wall.

**Why this works:** removes subjectivity from the verdict aggregation. The LLM still judges each AC, but the daemon decides PASS/FAIL deterministically. Retries become focused (the dev sees `AC-3 failed: "the em dash should be U+2014, not a regular hyphen"`) instead of vague.

### 3.2 — Per-story commits (F23)

**Problem:** DEV doesn't commit its changes. `compile-diff` runs `git diff HEAD~1 HEAD` which compares against an arbitrary prior state. When `git diff` returns empty, the daemon's `find -newer .mycelium/last-compile-marker` fallback kicks in and **catches every file ever touched** — for a freshly scaffolded project, that means documenting `node_modules` and every config file.

**Fix:** add a new shell step `compile-commit-on-pass` after `review` PASS but before `compile-diff`:

```bash
cd <projectDir> && \
  git add -A && \
  git commit --allow-empty -m "story: <storyId> — <storyTitle>"
```

Then `compile-diff` is reliably scoped to **this story's changes only**. Kill the `find -newer` fallback — fail loud if `git diff` is unexpectedly empty.

### 3.3 — Drop silent error swallowing in compile-sync (F26)

**Problem:** `aws s3 sync` and `graph-sync.mjs` errors are swallowed by `|| echo "skipped"`. Forensic report: the S3 backup bucket is empty after 10 "successful" syncs.

**Fix:**

1. Remove `|| echo "skipped"` from compile-sync shell step.
2. Add post-sync verification:
   - `[[ "$(aws s3 ls s3://.../<planSlug>/ | wc -l)" -gt 0 ]] || exit 1`
   - `mgconsole -e "MATCH (n) WHERE n.planSlug = '<x>' RETURN count(n)"` should be > 0.
3. On verification failure, write an `attention-item` (new category `compile-sync-failed`).

**Strategy 3 estimated saving:** eliminates ~5 unnecessary retries per 10-story epic (forensic baseline) ≈ -$0.40 and -4 min. Plus correctness on compile-diff and observability on sync.

---

## Strategy 4 — Wave-close COMPILER (one run per wave, Haiku, shared diffs)

Effort: 1–2 days. Builds on Strategies 1.3 (Haiku) and 2 (Context Pack).

### Concept

Move the compile-knowledge step from **per-story** to **per-wave**, executed by the existing `wave-completion-check` cron (Phase A.5/B.4 already wired). One COMPILER invocation per wave sees ALL stories' diffs together, atomically updates shared knowledge files (`index.md`, `log.md`, `dependency-map.md`), and writes per-file articles in batch.

### Why

Forensic report: **47% of total epic time** and **35% of total cost** on compile-knowledge. Three failure modes addressed:

1. **Race conditions (F11):** 8 parallel stories writing to `knowledge/index.md` → 7 writes lost. With wave-close compiler, there's exactly one writer per wave.
2. **Redundant reads (F7):** every story's compiler re-reads the same 10 files. With one wave-close run, those 10 reads happen once per wave instead of per story (~5–10× reduction).
3. **Wrong-shaped work for the model:** small-diff stories (1 file changed) trigger a 9-minute Sonnet exploration. Wave-close batches diffs so the compiler always has substantial work, justifying the run cost.

### Implementation

1. Remove `compile-knowledge` step from the per-story pipeline in `functions/shared/pipelines/story-pipeline.ts`.
2. Keep `compile-diff` and `compile-commit-on-pass` (Strategy 3.2) per-story — the wave-close compiler needs the per-story diffs.
3. In `functions/cron/wave-completion-check.ts`, when all stories in a wave reach DONE, dispatch a new `WaveCompileJob` to the daemon.
4. The wave compile prompt receives:
   - All story `WORK_SUMMARY`s for this wave
   - All per-story `git diff`s (collected from `compile-diff` step output)
   - The shared `<project_context>` (Strategy 2)
5. Compiler emits one batched edit per shared knowledge file, plus N new code articles.

### Concurrency note

Wave-close compilers don't run in parallel with each other (waves are sequential within an epic), so no race risk. Across plans, separate plan workspaces — also no race.

**Estimated saving:** ~10 compiler runs/epic → ~3 (one per wave). Combined with Haiku model (12× cheaper): forensic-baseline compile-knowledge cost $1.63/epic → ~$0.05/epic. **-30% total epic cost.** Time: -25 to -30 min/epic.

---

## Strategy 5 — `touchPoints` + `forbiddenAreas` + pre-flight check (correctness)

Effort: 1–2 days. **This is correctness, not just optimization.**

### 5.1 — `touchPoints` per story (F6)

**Problem:** Multiple stories in a parallel wave edit `main.js` simultaneously. dino3 e2w0 had 4 stories all editing `main.js`. Last-writer-wins; other stories' work silently discarded. dino3 also had two stories independently creating `input.js` with different implementations.

**Fix:**

1. Extend story schema (`functions/shared/types/plan.ts` and `epic-workflow.ts`) with `touchPoints: string[]` — list of file paths the story will create or modify.
2. In `epic-tech-context` workflow, instruct the planner to declare `touchPoints` for every story.
3. In the plan-reducer / wave-builder (`functions/shared/services/wave-reducer.ts`), at plan-build time:
   - Build a `touchPoints` graph: file → set of stories that touch it.
   - **Any file touched by 2+ stories cannot have those stories share a wave.** Push the conflicts to the next wave.
4. Validate at wave-launch: assert no two RUNNING stories' `touchPoints` intersect.

### 5.2 — `forbiddenAreas` per story (F20)

**Problem:** dino3 e2w0s2 (collision/scoring) added inline HUD/overlay rendering to `main.js`, which the e3w0s3 (HUD) story then had to rewrite. Story scope leaked.

**Fix:** add `forbiddenAreas: string[]` to story schema — file regions or concerns this story must NOT modify. Inject into DEV prompt:

```
You may modify files in <touch_points>.
You MUST NOT modify these areas: <forbidden_areas>.
Examples: HUD/overlay rendering belongs to E3 S3, not this story.
```

Reviewer also checks the constraint: any diff outside `touchPoints` or in `forbiddenAreas` → automatic FAIL.

### 5.3 — Pre-flight `prework-check` shell step (F19)

**Problem:** dino3 e4w0s1 (integration story) burned **25+ tool calls** to conclude "no changes needed — earlier stories already did the work."

**Fix:** new shell step before DEV:

```bash
cd <projectDir>
# Check if touchPoints already mutated since plan start
CHANGED=$(git log --since="<planStart>" --name-only --pretty=format: -- <touchPoints> | sort -u)
if [ -n "$CHANGED" ]; then
  echo "<recent_work>" >> $STEP_OUTPUT
  echo "$CHANGED" >> $STEP_OUTPUT
  git log --since="<planStart>" --oneline -- <touchPoints> >> $STEP_OUTPUT
  echo "</recent_work>" >> $STEP_OUTPUT
fi
```

The `<recent_work>` block goes into DEV's `<project_context>` (Strategy 2). DEV's prompt adds:

```
If <recent_work> shows recent commits already touched your touch_points, INSPECT
those changes first. If AC are already satisfied, emit:
---WORK_SUMMARY---
No changes required — AC already satisfied by <commit-shas>.
---END_WORK_SUMMARY---
and stop. Do not re-implement.
```

**Strategy 5 estimated saving:** correctness-first (prevents data loss). Performance side-effect: -25 tool calls on no-op stories (~10% of stories in late-epic), eliminates partial-overwrite waste. Roughly -$0.30 per affected story.

---

## Strategy 6 — Concurrency cap + memory hygiene + observability

Effort: 1 day. Operational, not algorithmic.

### 6.1 — Explicit concurrency cap (F24)

**Problem:** Forensic report: 5 parallel Sonnet compilers on a t2.micro (1.8 GB RAM) caused 3 OOM kills per epic. Phase A.1 graceful shutdown catches symptoms but not cause.

**Fix:**

1. Add `MAX_CONCURRENT_CLAUDE_PROCESSES` env var to daemon, default `2` for t2.micro / `4` for t3.small / `6` for t3.medium.
2. The daemon's job poller already waits when full; just enforce a numeric cap derived from instance type.
3. Wave dispatch respects the cap — extra stories queue PENDING and pick up as workers free.

### 6.2 — Decision: upsize vs cap (F24)

Cost-benefit decision for the user:

| Option | Monthly cost | Concurrent agents | OOM risk |
|--------|-------------|-------------------|----------|
| t2.micro (current) | ~$10 | 2 | high |
| t3.small | ~$15 | 4 | low |
| t3.medium | ~$30 | 6–8 | none |

Strategy 4 (wave-close compiler) reduces peak concurrent agents materially (compilers no longer run alongside dev/review). t2.micro might suffice **after** Strategy 4 ships.

### 6.3 — Story ID + step ID in every event header (F15)

**Problem:** Logs read `dev / DEV / step_start` with no story identifier. Operators can't tell two parallel stories apart from raw logs. Real bugs (paste-mistake or daemon-bug) hide in plain sight.

**Fix:** prefix every event line with `[<storyShortId>]`. The COMPILER step already does this; extend to all step types. Trivial change in the event-emitter.

**Strategy 6 estimated saving:** non-token but operationally critical — eliminates ~3 OOM crashes per epic (forensic baseline), each requiring manual intervention + lost work. Saves ~30 min of human time per crash.

---

## Strategy 7 (decision needed) — Visual QA execution

**F27** surfaced a gap: dino3's pipeline **captures** visual tests in `visual-tests.md` but **never executes them**. The forensic report's prior epic had a dedicated VISUAL_QA pipeline ($0.87 / 6.5 min / epic, Sonnet + Playwright).

Three options for the user to decide:

| Option | Cost/epic | Latency | Granularity |
|--------|-----------|---------|-------------|
| (a) Epic-level QA (Sonnet + Playwright, after all waves) | $0.87 | +6 min at epic close | coarse — epic pass/fail |
| (b) Per-story QA (Haiku + DOM inspection, inline) | ~$0.50 (10 × $0.05) | +30s/story | fine — per-story pass/fail |
| (c) Documentation only — no execution (current) | $0 | 0 | none |

Recommendation: **(b)** for prototypes/MVPs (rigor=mvp tier), **(a)** for production rigor, **(c)** acceptable for prototype rigor only. Tie to the existing `PlanRigor` from Phase C.

---

## Strategy 8 (v2 — out of scope here) — Claude Agent SDK migration

Forensic report's #1 critical recommendation. Would address F1, F7, F11, F16, F24 structurally. Single parent process, native subagent context inheritance, native streaming, SDK-level credential management, no per-call cold starts (saves ~27k cache-creation tokens per agent).

Documented as the destination, not delivered in this plan. Strategies 1–6 should be done first; if they hit the targeted savings, the SDK migration is a "nice to have" rather than a "must have."

---

## Implementation order (recommended)

| Day | Work | Lifts |
|-----|------|-------|
| **Day 1 (afternoon)** | Strategy 1 — all 5 sub-fixes | F2, F3, F4, F5, F8, F9, F10, F12, F14, F17, F18, F22 |
| **Day 2** | Strategy 3 — structured verdicts + per-story commits + sync verification | F23, F25, F26 |
| **Day 3** | Strategy 6 — concurrency cap + story-id in events | F15, F24 |
| **Day 4–5** | Strategy 2 — Story Context Pack | F1, F5, F7, F13, F16 |
| **Day 6–7** | Strategy 4 — wave-close compiler (depends on Strategy 2) | F7, F11, F22 |
| **Day 8–9** | Strategy 5 — touchPoints + forbiddenAreas + pre-flight | F6, F19, F20 |
| (decision) | Strategy 7 — visual-QA paradigm choice | F27 |
| (later) | Strategy 8 — Claude Agent SDK | architectural |

**Total: ~9 working days** for v1 corrections (1.5–2 calendar weeks with testing).

---

## Expected Outcome — Quantified Reductions

Baseline = forensic-report Chrome-Dino React+Vite epic (10 stories, measured DDB-job data):

| Metric | **Baseline** | **After Strategy 1** | **After 1+2+3** | **After 1–6 (v1 complete)** |
|--------|--------------|----------------------|-----------------|----------------------------|
| **Cost per 10-story epic** | $5.56 | $3.10 (–44%) | $2.30 (–59%) | **$1.50 (–73%)** |
| **Agent-time per epic** (sequential equiv) | 70 min | 55 min (–21%) | 45 min (–36%) | **25 min (–64%)** |
| **Wall-clock per epic** (with parallelism + crashes) | ~25 hours | ~12 hours (–52%) | ~8 hours (–68%) | **~3 hours (–88%)** |
| **Tool calls per story (avg)** | ~40 | ~25 (–38%) | ~20 (–50%) | **~12 (–70%)** |
| **Tokens per story (avg, in+out+cache)** | ~250k | ~180k (–28%) | ~120k (–52%) | **~60k (–76%)** |
| **VISUAL_TESTS retry rate** | 50% | ~10% | <5% | **<2%** |
| **OOM crashes per epic** | 3 | 3 | 3 | **0** |
| **Compile-knowledge cost share** | 35% of epic | 35% (still expensive) | 5% (Haiku flip) | **<2%** (wave-close + Haiku) |
| **Compile-knowledge time share** | 47% of epic | 47% | 35% | **<10%** |

### Where the savings come from

- **Strategy 1 (token/call discipline):** ~$2.50 / 15 min / epic — pure waste elimination.
- **Strategy 2 (Story Context Pack):** ~$0.50 / 10 min / epic — discovery cost approaches zero per story.
- **Strategy 3 (structured verdicts + commits):** ~$0.40 / 4 min / epic — eliminates retry-loop waste from inconsistent reviews.
- **Strategy 4 (wave-close compiler):** ~$1.50 / 25 min / epic — biggest single time saver, kills 47%-of-epic compile bottleneck.
- **Strategy 5 (touchPoints):** correctness-first; performance side-effect ~$0.30 / 3 min on no-op stories. Prevents silent data loss in dense parallel waves.
- **Strategy 6 (concurrency + observability):** eliminates the ~1.5 hour/epic of human-time recovery from OOM crashes.

### Worth noting

- The 73% cost reduction lands the typical 10-story epic at **~$1.50 / ~3 hours wall-clock** — at that level, an MVP-rigor prototype Plan can ship in a single coffee break.
- The 76% token reduction has an additional benefit: it raises the ceiling on plan complexity. Today, plans larger than ~15 stories blow through context budgets. After v1 corrections, that ceiling roughly quadruples.
- The 0-crash target requires Strategy 6 (concurrency cap) + Strategy 4 (fewer parallel agents). Either alone is insufficient.
- Strategy 7 (visual QA execution) is **additive cost**, not savings — it's a quality choice the user makes. Not included in the table above.

---

## Risks and rollback

| Strategy | Risk | Mitigation |
|----------|------|------------|
| 1.3 (Haiku COMPILER) | Haiku may produce lower-quality knowledge articles | Sample first 3 stories; revert to Sonnet via env var if quality regresses |
| 2 (Context Pack) | Larger system prompt may saturate context on big plans | Cap `file_digests` total size; truncate `recent_diffs` to last 20 commits |
| 3.2 (per-story commits) | Commits proliferate on `main` | Plans run on per-plan branches already; commits are scoped |
| 4 (wave-close compiler) | If wave fails mid-stories, compiler doesn't run → knowledge stale | Existing wave-completion-check already gates; compiler runs only when all stories DONE |
| 5 (touchPoints) | Planner may declare touchPoints incorrectly → false conflicts | First-run telemetry: log when serialization triggers; tune planner if too aggressive |
| 6.1 (concurrency cap) | Lower throughput on small instances | Combined with Strategy 4 (fewer concurrent agents needed), net throughput is higher |

All strategies are env-var-gated where possible — flip them on per-plan via Phase C's rigor system.

---

## Cross-doc map

| Source doc | Findings landed here |
|------------|----------------------|
| `pipeline-v1-optimization.md` (this run) | F1–F21 (mine) — all 21 mapped to a strategy |
| `agentic-pipeline-forensic-report.md` (prior epic) | F22–F27 (forensic-only insights) — all 6 mapped |
| `pipeline-enhancement-phases-a-c-handoff.md` (Phase A–D shipped) | builds on existing infra (attention items, retry ladder, child tracker, rigor system) — no conflicts |

The Phase A–D infrastructure is the foundation this plan rests on. Specifically:

- **Strategy 6.1** (concurrency cap) extends the existing daemon job-poller.
- **Strategy 4** (wave-close compiler) reuses the existing `wave-completion-check` cron.
- **Strategy 3.3** (sync verification) writes new `attention-item` categories — already supported by the attention-items table.
- **Strategy 5** (touchPoints) extends the Plan/Story schemas already defined in `functions/shared/types/`.

No Phase A–D rework is required.
