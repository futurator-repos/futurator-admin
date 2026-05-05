# Pipeline v1 — Context Management & Tool-Call Optimization

**Status:** living document, updated per batch of pasted logs
**Source run:** first real Plan/Intent (`dino3`) on 2026-04-26, e1+e2
**Format:** findings-organized — each finding lists evidence + recommended fix
**Companion doc:** `pipeline-enhancement-phases-a-c-handoff.md` (Phases A–D shipped)

---

## Executive summary

Across 5 stories of the dino3 plan, the pipeline burns **~40–60% of dev/reviewer/compiler tool calls on rediscovering context that is already known to the system** (the same files, the same project layout, the same plan/story/AC). Each agent — DEV, REVIEWER, COMPILER — boots cold, runs `ls + cat` on the project, then re-reads the just-edited files to "verify." Two unrelated retry loops also fired because of a contract mismatch between what the dev emits (`---VISUAL_TESTS---` inline block) and what the reviewer expects (a `visual-tests.md` file). And one retry was lost to a `{{FEEDBACK}}` template placeholder that never got rendered.

The single highest-leverage fix is a **context bundle** assembled once per story and injected into the prompts of all three agents (DEV, REVIEWER, COMPILER). The second is **fixing the four contract mismatches** (visual-tests, retry feedback, dir-as-file Read, reviewer's spurious story-file globs).

---

## Pending upgrades from the handoff doc (status check)

From `pipeline-enhancement-phases-a-c-handoff.md` "Known deferred / future work":

- **S3 log persistence (C.5 deferred)** — events DDB has 7-day TTL. Out-of-scope here but worth noting: the optimizations below will reduce log volume materially.
- **`tamperCount` 3-strike attention item (C.4 deferred)** — not relevant to context-mgmt; relies on retry ladder.
- **`budget-warning` / `dev-server-down` attention writer sites (A.4)** — category values defined, no writer wired. Independent of this optimization pass.
- **Attention badges on pipeline stepper (D)** — UI-only, independent.

→ None of the Phase A–D deferred items overlap with the optimizations below. This document tracks a **separate v1 optimization pass** focused on the daemon pipeline's context management.

---

## Findings

### F1. Cold-start re-discovery on every agent invocation 🔥 **highest-impact**

Every DEV / REVIEWER / COMPILER agent re-bootstraps the project from scratch with `ls` + `cat` of the same 4–6 files, even though:
- The plan, epic, story, and AC are already passed in the prompt.
- The previous story in the same wave just touched the same files.
- The daemon has a `story-context.xml` concept (BMM) that isn't being used here.

**Evidence:**

| Batch | Agent | Bootstrap calls |
|-------|-------|-----------------|
| 1 (e1w0) | DEV | `ls memory` + `ls _bmad/` + `ls docs/` + `Read plan.md` = 4 |
| 2 (e2w0 physics) | DEV | `ls` + `cat main.js && cat constants.js && cat dino.js && cat input.js && cat index.html` = 2, but giant cat |
| 2 | REVIEWER | `Glob *.js` + 3 parallel `Read`s + `Read /dino3` (errors — dir) = 5 |
| 2 | COMPILER | `find` + `ls knowledge/` + `Read obstacle.js` + `Read main.js` + `Read constants.js` + `Read input.js` + `Read knowledge/index.md` + `Read log.md` + `Read code/main.js.md` + `Read system/dependency-map.md` = **10** |
| 3 (e2w0s1 obstacles) | DEV | `ls` + giant `cat` of 5 files = 2 |
| 3 | COMPILER | 11 reads, identical structure to batch 2 |
| 4 (e2w0s2 collision) | DEV | `ls` + cat 4 files = 2 |
| 4 | COMPILER | 11 reads, identical structure |
| 5 (e2w0s3 input) | DEV | `ls` + 3 parallel Reads = 4 |

Across 5 stories: roughly **45 redundant context-load tool calls**. The COMPILER alone burns ~10 reads per story re-reading what DEV/REVIEWER just read.

**Why it's worse than it looks:** each Read costs latency (sequential when not parallelized), context tokens, and — for COMPILER on Sonnet — model time. With 4-story waves running in parallel, this is 40 reads happening simultaneously against the same files.

**Fix (recommended):**

1. **Story Context Pack** — at story-launch time, the daemon assembles a single JSON/markdown blob:
   ```
   story-context.md
   ├── plan.md (full)
   ├── current-story (id, AC, work-summary inputs)
   ├── adjacent-files-digest (path → first 50 lines + sha)
   ├── prev-story-WORK_SUMMARY (just-shipped stories in same wave)
   └── knowledge-index (paths + 1-line purpose, NOT full bodies)
   ```
   Inject as the **system prompt** for DEV, REVIEWER, and COMPILER. Agent only reads files it actually needs to mutate.

2. **Knowledge index, not knowledge bodies** — `knowledge/index.md` already exists. Compiler re-reads `log.md`, `dependency-map.md`, and every `code/*.md` for every story. Pass an index summary and let the compiler request specific entries by path.

3. **Forbid bootstrap `ls`** — if the prompt already includes a file tree snippet (which it can, deterministically), the dev's first `ls` is pure waste. Add a one-line "Project tree (canonical):" block to the prompt and instruct: do not list directories.

---

### F2. VISUAL_TESTS contract mismatch → forced retry loops

DEV emits `---VISUAL_TESTS---` blocks inline in the response text (correct per the daemon's `extraction VISUAL_TESTS = ---VISUAL_TESTS---` log line). REVIEWER expects them in a `visual-tests.md` file on disk and FAILs when missing. Both batches with browser-testable AC (B1, B5) hit this and burned a retry.

**Evidence:**

- **B1:** dev emits inline visual tests → reviewer FAILs → retry writes `visual-tests.md` → reviewer PASSes. The retry's only deliverable was creating a file from text the dev already produced.
- **B5:** identical pattern — dev emits inline, reviewer FAILs requiring file, dev says "feedback contains `{{FEEDBACK}}` placeholder" (also see F10), then a fresh review cycle does pass on the file.

**Cost:** ~1 full retry cycle per story with browser-testable AC. At 2/5 stories that's a **40% retry rate driven by a single contract bug**.

**Fix:**

Pick one canonical sink. Two options, in order of preference:

1. **Daemon writes the file from the extracted block** — the daemon already extracts `VISUAL_TESTS` from dev's output. Have it write to `visual-tests.md` (append/replace per criteriaRef) before the reviewer step starts. Both contracts satisfied without changing prompts.
2. **Tell reviewer to accept inline blocks** — update reviewer prompt: "VISUAL_TESTS may be in `visual-tests.md` OR in the dev's WORK_SUMMARY context block injected above." Cheaper, no daemon code change.

Option 1 is more robust (file persists for the next story).

---

### F3. Self-verification reads after Edit/Write

Dev consistently runs `Read main.js` immediately after `Edit main.js` to "verify." The Edit tool errors if the substring isn't found, so the read tells the dev nothing new.

**Evidence:**

- B2: `Write input.js` → `Bash ls input.js` → `Read input.js` (3 calls for 1 newly-written file)
- B2, B3, B4, B5: every story ends with `Read main.js` after the last Edit
- B5: `Bash ls input.js` after creating it ("`echo exists \|\| echo not found`")

**Cost:** ~1 wasted Read per story, ×5 stories = 5 reads.

**Fix:**

Add to dev prompt: *"Do not Read a file you just Wrote or Edited — the tool already validates. Re-read only after a Bash command may have modified it."* Cheap prompt fix.

---

### F4. Reviewer redundant verification (grep / find on already-applied edits)

The reviewer (Haiku) frequently re-greps for symbols that the Edit tool just inserted, and runs `find . -name "*.js"` after a Glob already returned the same set.

**Evidence:**

- B4 reviewer: `grep -n "aabbCollides\|dinoHitsObstacle" collision.js main.js` — already visible in the Reads above it.
- B1 reviewer: `find . -name "*.html" -o -name "*.js"` after the Bash `ls -la` already showed everything.
- B2 reviewer: `Glob *.js` then `Read /home/ubuntu/projects/dino3` (the dir, errors).
- B3, B5: same dir-as-file pattern.

**Cost:** ~1–2 tool calls per review, ×5 = 5–10 calls.

**Fix:**

- Add to reviewer prompt: *"You are reviewing a diff, not auditing a tree. Do not run `find`/`Glob` to discover files — the changed file list is provided. Do not re-grep for imports inserted by Edit; trust the diff."*
- Add an explicit **changed-files list** to the reviewer prompt (already in the daemon as `compile-diff` output — pipe it forward).

---

### F5. Reviewer FAILs because story-file/AC isn't on disk and looks for it

B5 reviewer hunts for `**/story*`, `**/*acceptance*`, then `Glob *.md` — the AC was already in the prompt, but the reviewer doesn't trust the prompt and tries to find the source on disk. They never exist (the EC2 project box has no story files; those live in DDB / the orchestrator).

**Evidence:**

- B5: `Glob **/story*.md` (empty), `Glob **/*acceptance*` (empty), then re-Reads `plan.md` to find AC.
- B1, B2, B3: same wasted Glob to look for `**/story*` or `docs/*`.

**Cost:** 2–3 wasted Globs per review, ×5 reviews.

**Fix:**

- Inject AC and the literal story spec into the reviewer prompt as a `<story_spec>` block.
- Add to prompt: *"The complete story spec is in `<story_spec>` above. Do not search the filesystem for it — it is not stored on the project box."*

---

### F6. Wave parallelism causing file collisions on `main.js` and duplicate `input.js`

In **wave 0 of epic 2** (e2w0), three stories run in parallel touching `main.js`:

- **e2w0 (physics, B2)** — creates `dino.js` AND `input.js`, edits `main.js`
- **e2w0s1 (obstacles, B3)** — creates `obstacle.js`, edits `main.js`
- **e2w0s2 (collision, B4)** — creates `collision.js`, edits `main.js`
- **e2w0s3 (input handler, B5)** — creates `input.js` (again!), edits `main.js`

**Evidence of the collision:**

- B5 dev *creates* `input.js` even though B2 *already created* `input.js` (with the same shape).
- B2 dev mid-run writes `input.js` and then says: *"The file was already updated with a game loop and imports from `./input.js`"* — meaning another wave-mate had already edited `main.js` to import from a not-yet-written file.
- The two `input.js` files differ in implementation (B2 uses `pointerdown`, B5 uses `touchstart` + `click`).

**Cost:** wave runs to completion only because the last writer wins; the other writer's effort is silently discarded. In a more complex plan this would corrupt logic.

**Fix:**

This is **the most dangerous finding** — it's a correctness issue masquerading as a performance issue. Three options:

1. **Wave dependency analysis at plan time** — if two stories edit the same file, they cannot share a wave. The plan-reducer / `epic-tech-context` should detect this from declared touch-points and serialize them.
2. **File locking per wave** — pessimistic locking on file paths declared in story.touchPoints. Stories without conflicts run in parallel; conflicts go in next wave.
3. **Merge step at wave close** — let stories run on private branches/worktrees, then merge at wave close (heavier but parallelism survives).

Recommendation: **option 1** for v1 (add a `touchPoints` field to story spec, validate at plan-build-time). Option 3 is correct long-term but invasive.

Also: **e2w0 and e2w0s3 should be the same story** — both implement input. The plan generator created two stories for one capability. Worth investigating the planner prompt.

---

### F7. COMPILER agent re-reads everything DEV and REVIEWER just read (no shared context)

The compile-knowledge step re-reads:
- All source files just edited (already in DEV's tool history)
- All knowledge files (`knowledge/index.md`, `log.md`, `system/dependency-map.md`, every `code/*.md`)
- Then writes/edits knowledge articles

**Evidence:**

- B2 COMPILER: 10 reads
- B3 COMPILER: 11 reads
- B4 COMPILER: 11 reads

**Cost:** ~10 reads × 5 stories = **50 reads** purely for COMPILER bootstrap. This is the single largest waste category in absolute call count.

**Fix:**

1. **Pipe DEV's diff and REVIEWER's verdict forward into COMPILER's prompt.** The daemon already runs `compile-diff` (visible in logs as `Shell: cd ... && git diff --name-status HEAD~1 HEAD`) — pipe its output as a `<diff>` block into COMPILER's prompt.
2. **Pre-load knowledge index in prompt, not full bodies.** Compiler very rarely needs the full text of `system/dependency-map.md` — it needs to know which articles to update. An index with `path | last-mutated-by-story | one-line purpose` is enough.
3. **Skip COMPILER for trivial stories** — e.g., when `git diff` shows only doc changes or only one new isolated file. Save the run entirely.

---

### F8. `Read` against a directory path produces tool errors and wastes a turn

REVIEWER repeatedly runs `Read("/home/ubuntu/projects/dino3")` — that's the project dir, not a file. Tool returns an error. Reviewer then issues a `Glob` or `Bash ls` to recover.

**Evidence:** B2, B3, B5 reviewers — all hit this within their first 3 calls.

**Cost:** 1 wasted call per review.

**Fix:** add to reviewer prompt: *"To list directory contents, use `Glob` or `Bash ls`, never `Read`."* This is a Haiku-class mistake worth pinning.

---

### F9. Retry prompt has unrendered `{{FEEDBACK}}` placeholder

In B5, the dev's retry turn echoes back: *"The feedback message contains an unfilled template placeholder (`{{FEEDBACK}}`) — no actual reviewer notes were included. Could you paste the real feedback so I can address the specific issues?"*

Yet a few seconds earlier the reviewer DID emit a long, structured FAIL with feedback (the daemon extracted it: `extraction FEEDBACK = **`).

**Diagnosis:** the retry prompt template references `{{FEEDBACK}}` but the daemon either:
(a) didn't substitute it (templating bug), or
(b) substituted with the raw `FEEDBACK = ...` line that starts with `**` (which the agent didn't recognize as feedback).

**Cost:** 1 wasted turn (1 step that did nothing). Then a **second** review pass started from scratch (visible: another `step_start review` immediately after).

**Fix:** audit `daemon/pipelines/templates/retry-prompt.md.tpl` (or wherever the template lives) — verify the `{{FEEDBACK}}` substitution is wired and includes the verbatim reviewer text, not just the truncated extraction. The truncation visible in extraction logs (`FEEDBACK = **\n\n✅...`) suggests the extractor is dropping the leading `FEEDBACK:` label and the agent can't parse what remains.

---

### F10. Reviewer model (Haiku) churns on small reads instead of batching

Reviewer runs 5–10 small Reads/Globs per story, often serially. With Sonnet or with better batching instructions, 2–3 parallel reads would suffice.

**Evidence:**

- B5 reviewer: 12 tool calls in one review pass (Glob, Glob, Glob, Read dir, Glob, Glob, Read, Read, Read, Glob, Glob, Read, Bash, Read, Read, Read).
- B4 reviewer is well-batched (3 parallel Reads + 1 Bash) — proves it's a prompt/instruction issue, not a model limit.

**Fix:** add to reviewer prompt: *"Do all your file reads in ONE message with parallel tool calls. After reading, do not re-Glob or re-grep — analyze and emit verdict."*

---

### F11. The pipeline rebuilds the same knowledge graph 5× instead of incrementally

Every story's COMPILER opens `knowledge/system/dependency-map.md`, `knowledge/index.md`, and `knowledge/log.md` to update them. There's no shared state; each story reads, edits, writes back. Adjacent stories in the same wave can't see each other's compiles.

**Cost:** redundant reads + risk of overwriting (last-writer-wins on `index.md`).

**Fix (v1.5):**

Move knowledge compilation to a **wave-close step** instead of per-story. The wave-completion-check cron (already exists per Phase A.5/B.4) can spawn one COMPILER per wave that ingests all stories' DEV outputs together. Trades latency at wave close for ~80% fewer compiler runs, no overwrite races.

---

## Recommended optimization roadmap

Ordered by ROI (impact / implementation cost):

| # | Fix | Addresses | Effort | Expected savings |
|---|-----|-----------|--------|------------------|
| **1** | **Story Context Pack** in prompt | F1, F4, F5, F7 | M (1–2 days, daemon templates + assembler) | ~50% fewer tool calls per agent |
| 2 | Daemon writes `visual-tests.md` from extracted block | F2 | S (1 hour) | -1 retry per browser-testable story |
| 3 | Fix `{{FEEDBACK}}` template substitution in retry prompt | F9 | S (30 min) | -1 wasted turn per review FAIL |
| 4 | "Don't re-read just-edited files" rule in DEV prompt | F3 | S (5 min, prompt edit) | ~1 read per story |
| 5 | "Don't Read directories, use Glob/Bash ls" in REVIEWER prompt | F8 | S (5 min) | ~1 read per review |
| 6 | "Batch reads in one message; do not re-discover files" in REVIEWER prompt | F4, F10 | S (15 min) | ~3 reads per review |
| 7 | **`touchPoints` declared per story + plan-time conflict serialization** | **F6 (correctness!)** | M (plan-reducer + schema change) | prevents data loss in parallel waves |
| 8 | Wave-close COMPILER (one run per wave, not per story) | F7, F11 | M (cron wiring) | ~80% fewer compiler runs |
| 9 | Knowledge **index** in prompt, not full knowledge bodies | F1, F7 | S (template change) | -5 reads per compiler run |

Items 2–6 are sub-day prompt/template fixes. Item 1 is the foundation for everything else and unblocks the biggest savings. Item 7 is a **correctness blocker** for non-trivial parallel plans — should be prioritized regardless of optimization goals.

---

### F12. DEV reads the same file twice within a single turn (Bash `cat` then `Read`)

Even within one DEV invocation, files are read multiple times because `cat`-ing in Bash doesn't update the harness's "you-have-already-read-this-file" memory the way `Read` does. The dev then re-Reads to get the harness-tracked snapshot.

**Evidence:**

- **B6 (e3w0s1, dino sprite):** dev runs `cat dino.js && cat index.html && cat constants.js` (one Bash), then `cat main.js` (second Bash), then **`Read dino.js`** explicitly. Three views of `dino.js` content within ~3 minutes.
- B6 also uses `Read main.js offset:1 limit:20` and `Read main.js offset:110 limit:35` — peeking at chunks of a file that's already entirely in context from the earlier `cat`.

**Cost:** 1–2 redundant reads per dev turn that mixes Bash `cat` with `Read`.

**Fix:**

- Tell DEV in the prompt: *"Use `Read` (not Bash `cat`) to view files — the harness tracks Read state and won't double-load. Read files in parallel in one message."*
- And: *"Do not re-Read a file you just Read or Wrote. Do not Read with offset/limit unless the file exceeds 2000 lines."*

---

### F13. Reviewer reads non-existent canonical paths (knowledge tree leak)

B6 reviewer reads `knowledge/tests/visual-tests.md` — a path that doesn't exist on the project box. This path comes from the **knowledge compiler's directory convention** (compiler creates `knowledge/code/`, `knowledge/system/`, etc.) leaking into the reviewer's mental model.

**Evidence:**

- B6 reviewer: `Read("/home/ubuntu/projects/dino3/knowledge/tests/visual-tests.md")` — file doesn't exist.
- Same review also reads `visual-tests.md` (the real one) — so it knows the right path, but pre-emptively probes the knowledge-tree variant.

**Cost:** 1 tool error per review when the reviewer prompt or training carries stale knowledge-tree assumptions.

**Fix:** consolidate on a single canonical location for visual tests (recommend `visual-tests.md` at project root — already chosen). If F2's "daemon writes the file" fix lands, the reviewer prompt can hard-code the path: *"Visual tests are at `visual-tests.md` only. Do not look elsewhere."*

---

### F14. REVIEWER turn-budget overrun on complex stories (Haiku)

B6 reviewer runs **17+ tool calls** in a single review pass before writing its verdict, then the log appears to cut off mid-sentence ("Now let me check if there are any issues by examining the integration more carefully") with no `step_complete` shown in the paste. Either the agent timed out, hit a turn cap, or the user trimmed the paste — but the trajectory clearly shows pathological exploration.

**Evidence:**

- B6 (e3w0s1) reviewer call sequence: `Bash find` → `Read dino.js` → `Read main.js` → `Read plan.md` → `Glob **/*.story.md` → `Glob **/*test*.md` → `Glob **/*.spec.js` → `Read visual-tests.md` → `Read knowledge/tests/visual-tests.md` → `Glob **/*dino*sprite*.md` → `Bash grep "pixel-art dino sprite"` → `Bash find -name "*.md" -exec grep VISUAL_TESTS` → `Grep VISUAL_TESTS` → `Bash ls *.md` → `Glob *.md` → `Bash ls -1 *.md` → `Read constants.js` → `Read index.html` → "Now let me check…" (cut off).
- B7 (e3w0s2) reviewer is more disciplined (~12 calls) but still does 4 Globs hunting for the story.

**Diagnosis:** Haiku is given an open-ended prompt ("review the work") and no budget. With AC and changed-files in the prompt and a hard cap of ~5 tool calls, this would be 3× faster.

**Fix:**

- Add to reviewer prompt: *"You have a hard budget of 5 tool calls. Read the changed files in ONE parallel call. Then emit VERDICT. Do not Glob/find — the file list is provided."*
- Make this a literal instruction with the budget number visible. Haiku follows numeric budgets well.

---

### F15. Story ID not visible in log event headers (instrumentation gap)

**Resolved on follow-up:** the apparent "byte-identical e3w0s2 vs e3w0s3" logs in the previous iteration turned out to be a **paste duplicate**, not a daemon bug. Confirmed via dashboard screenshots: e3w0s2 is `774F391F-3` (cactus, started `13:12:21`, $0.48) and e3w0s3 is `5E2D3AE6-B` (HUD overlay, started `13:09:27`, $0.43) — clearly distinct stories, ran in parallel within e3w0.

The underlying instrumentation point still stands: when staring at raw log text, **there is no way to tell two stories apart**. Event headers read `dev / DEV / step_start` — no story ID, no story title. The COMPILER step alone logs `Compilation started for story <uuid>`; the rest of the events don't.

**Cost:** zero tool-call cost; pure operator-experience cost. Catching real parallelism bugs (like F6) from log text becomes much harder than necessary.

**Fix (low-priority polish):**

- Prefix every event line with `[<storyShortId>]` — e.g. `[774F39] dev / DEV / step_start`.
- Or add a one-line story banner at every `step_start` of the first agent for that story.

---

### F16. Prompt-context drift defeats prompt caching

`cacheCreation` numbers spike when prompt context changes between agents. B6 dev: `cacheCreation: 25512, cacheRead: 479512` — the run wrote 25k tokens of new cache because the system prompt or context block differed from the previous agent's. With a stable Story Context Pack (F1) this would compress to mostly cache reads.

**Evidence:**

- B6 dev: 25k cache write, 480k cache read (run was 16 turns).
- B5 dev: 11k cache write, 134k cache read.
- B4 compiler: 12k cache write, 222k cache read.

The cache reads dominate cache writes ~10–20×, which means caching IS working — but every context tweak between DEV/REVIEWER/COMPILER forces a fresh cache write. Bigger prompts (which we want for context-pack) only pay off if they stay **stable across the three agents per story**.

**Fix:** when designing the Story Context Pack (F1), reuse the **exact same** context block across DEV, REVIEWER, and COMPILER prompts. Only the role-specific instructions and the role-specific extracted output (DEV's WORK_SUMMARY → reviewer; REVIEWER's verdict → compiler) should differ. This maximizes cache hits across the 3-agent chain.

---

## Updated stats (after batch 8)

| Metric | After batches 1–5 | After batches 6–8 |
|--------|-------------------|-------------------|
| Stories observed | 5 | 8 (assuming s3 = paste dup of s2) |
| VISUAL_TESTS retry rate | 2/5 = 40% | **4/8 = 50%** ⬆ |
| Avg DEV bootstrap calls per story | ~3 | ~3 (steady) |
| Worst REVIEWER call count | 12 | **17+** ⬆ (B6) |
| Avg COMPILER reads per story | ~10 | ~10 (steady) |
| Net redundant tool calls (cumulative est.) | ~70 | ~110+ |

The VISUAL_TESTS contract bug is now the **single highest-frequency failure pattern** (50% of stories with browser-testable AC trigger a retry). Promoting fix #2 (daemon-writes-file) above #1 (Story Context Pack) on the roadmap by **urgency**, even though #1 has more total impact.

---

### F17. DEV spawns an `Explore` subagent in parallel with its own discovery reads (double exploration)

In e4 stories, DEV starts by spawning an `Agent(subagent_type='Explore')` to "give a complete picture of the codebase" — and **at the same time** issues its own parallel `find` + `tree` + 8–10 `Read` calls. The Explore subagent then performs the same reads internally. Two agents now load the same codebase concurrently.

**Evidence:**

- **e4w0s1 (B9, integration story):** dev fires `Agent(Explore, "Explore the project at /home/ubuntu/projects/dino3...")` THEN `find -type f -name "*.json" ...` THEN `tree -L 3` THEN 8 parallel Reads (package.json, index.html, main.js, constants.js, dino.js, obstacle.js, collision.js, input.js) THEN `Read hud.js` — **all within 8 seconds.** The Explore subagent is doing the same work simultaneously. Dev never references the subagent's output.
- **e4w1s1 (B10, clouds/pebbles story):** identical pattern — Explore subagent + 9 parallel reads + 3 redundant `find`s.

**Cost:** roughly **doubles** the discovery-phase tool spend on these stories. The Explore subagent's tokens are pure waste — its summary is never consumed by the dev's reasoning.

**Fix:**

- Tell DEV in the prompt: *"Read files directly; do not spawn an Explore subagent. Your context already contains the project tree and changed-file list. Read at most the files you intend to edit, in one parallel call."*
- Or, if you want to keep Explore as an option for very large projects: forbid spawning it when the dev's own reads cover the file set already.

---

### F18. DEV uses Node/npm verification commands on a static HTML5/ES-modules project

e4w1s1 dev runs `npm run dev -- --port 5174 &` then `curl -s http://localhost:5174/ | head -5` to "verify the server runs", and concludes "Server is running and responding." It also runs `node --input-type=module < /home/ubuntu/projects/dino3/clouds.js` for a "syntax check."

**Why this is wrong:**

- The dino3 project is **pure HTML + ES modules**, served via `python3 -m http.server` per its own visual-tests setup. There is no Vite/Next config; an `npm run dev` either fails or runs an unrelated stub script that doesn't actually validate the game.
- `node --input-type=module < clouds.js` doesn't catch all errors either — `import` paths resolve relative to cwd in ways that may not match browser behavior, and Node has no `CanvasRenderingContext2D`.

**Cost:** 2–3 tool calls per story doing pseudo-verification that proves nothing.

**Fix:**

- Inject the project's actual run command into the prompt as a `<dev_server>` block (per Plan): e.g. `python3 -m http.server 8080`.
- Add to dev prompt: *"Do not run `npm`/`node` ad-hoc verification scripts. The visual tests in `visual-tests.md` are the verification contract — your job is to make them pass, not to manually validate the runtime."*
- Or, more aggressive: forbid Bash entirely except for `git diff` / `ls` during the work phase.

---

### F19. "No-code-needed" stories pay full discovery cost — pre-flight check missing

e4w0s1 (E4 S1, "Integrate game loop with renderer") concluded **"No code changes were required. The integration was already fully implemented in main.js"** — and yet the dev burned **25+ tool calls** (Explore subagent + 13 Reads + 5 Bash listings + 3 Globs + Read plan.md + Read visual-tests.md + redundant re-reads of dino.js/obstacle.js) to determine this.

**Evidence:**

- e4w0s1 dev step: 15 turns, 4195 output tokens, $? — for a no-op outcome.
- Story was already satisfied by work delivered in e3w0s2 (cactus story, B7) which had wired `drawScene()` end-to-end.

**Diagnosis:** the planner created an integration story but the prior wave already delivered its scope incidentally. There's no daemon-side **pre-flight check** that asks "is this story already done?" before spawning DEV.

**Fix (cheap):**

- Add a `prework-check` shell step before DEV: run `git diff --name-only HEAD~<N> HEAD` AND `git log --oneline --since=<wave-start>` and inject as `<recent_work>` block into DEV's prompt. If files in the story's `touchPoints` were already mutated by recent work, prepend a note: *"Recent commits already touched these files. Inspect first; only modify if AC are not met."*
- Add to dev prompt: *"If your assessment is 'no changes needed', you may emit an empty WORK_SUMMARY without reading every file — confirm via `git log -p HEAD~3 -- <files>` only."*

---

### F20. Inline HUD code leaked across stories — story scope leakage

e3w0s3 dev observes: *"the GAME_OVER overlay shows two separate lines, not the required single 'GAME OVER — PRESS SPACE TO RESTART' string"* — meaning **a previous story (e2w0s2 collision/scoring) ALREADY rendered HUD/overlay text inline in `main.js`**, but with a slightly wrong format. The HUD story then had to **rewrite** that inline code into `hud.js` AND fix the format.

**Evidence:**

- B4 (e2w0s2) main.js diff added: `ctx.fillText('GAME OVER', ...); ctx.fillText('PRESS SPACE TO RESTART', ...)` — two lines.
- B6 (e3w0s3) HUD story replaced with: `drawGameOverOverlay(ctx)` rendering single `'GAME OVER — PRESS SPACE TO RESTART'` with em dash.

**Cost:** wasted work in s2, retry/rewrite in s3, plus risk of similar leakage in any plan with non-trivial cross-story coupling.

**Fix:**

- Strengthen the planner's story scope: explicitly forbid HUD/overlay rendering in non-HUD stories.
- Or in the dev prompt, list **forbidden mutations** alongside the touchPoints: *"You may modify these files: ... You may NOT add HUD/overlay text rendering — that belongs to E3 S3."*
- Same root cause as F6 (parallel waves stomping on `main.js`); a `touchPoints + forbiddenAreas` declaration on each story addresses both.

---

### F21. Reviewer turn-overrun keeps reproducing (F14 escalation)

The B6 (e3w0s1 dino-sprite) reviewer log was cut off mid-thought after 17+ tool calls (F14). The same pattern reproduces in:

- **e4w0s1 reviewer (B9):** at least 11 tool calls — `find`, `Read plan.md`, two more `find`s, `Read main.js`, `grep VISUAL_TESTS`, `Read visual-tests.md`, `ls -la`, `Glob *.js`, another `find`, `Read knowledge/tests/visual-tests.md` (doesn't exist — F13 again), `Read knowledge/log.md` (with limit:100). Log cuts off.
- **e4w1s1 reviewer (B10):** log shows `ls -la`, then 3 parallel Reads, then cuts off.

**Pattern:** reviewer trajectories that include multiple `find`/`Glob` early are the ones that overrun. Once the reviewer goes hunting for the story spec on disk (F5), it can't stop.

**Fix is the same as F14 + F5:** budget cap + inline story spec. With those two fixes, this class of failure should disappear.

---

## Updated stats (after batch 10)

| Metric | After batches 1–5 | After 6–8 | After 9–10 |
|--------|-------------------|-----------|-----------|
| Stories observed | 5 | 8 (1 paste-dup) | **10** |
| VISUAL_TESTS retry rate | 2/5 = 40% | 4/8 = 50% | **5/10 = 50%** ⬆ steady |
| Worst REVIEWER call count | 12 | 17+ | **17+** ⬆ steady (but now hits in 3 stories) |
| Avg DEV bootstrap calls per story | ~3 | ~3 | ~5 (e4 stories use Explore subagent + 13 reads) |
| "No-code-needed" stories | 0 | 0 | **1** (e4w0s1 — full-discovery cost for empty diff) |
| Cross-story scope leakage | not observed | not observed | **1** (HUD code added in collision story) |

---

## Updated optimization roadmap (re-prioritized)

| # | Fix | Addresses | Effort | Expected savings |
|---|-----|-----------|--------|------------------|
| **1** | **Daemon writes `visual-tests.md` from extracted block** | F2 | S (1 hour) | **eliminates 50% retry rate** |
| **2** | **Reviewer prompt: 5-call budget + inline story spec + forbid Globs** | F4, F5, F8, F10, F14, F21 | S (15 min) | -5 to -10 reviewer calls per story |
| 3 | Story Context Pack (DEV+REVIEWER+COMPILER share identical context) | F1, F4, F5, F7, F16 | M (1–2 days) | ~50% fewer tool calls per agent |
| 4 | Fix `{{FEEDBACK}}` template substitution | F9 | S (30 min) | -1 wasted retry turn |
| 5 | DEV prompt: don't re-Read just-edited files; use Read not Bash cat | F3, F12 | S (5 min) | ~2 reads per story |
| 6 | DEV prompt: don't spawn Explore subagent; don't run npm/node verification | F17, F18 | S (5 min) | -10+ tool calls on e4-style stories |
| 7 | **`touchPoints` + `forbiddenAreas` per story; plan-time wave conflict serialization** | **F6, F20 (correctness!)** | M | prevents data loss + scope leakage |
| 8 | **Pre-flight `prework-check` shell step before DEV** | F19 | S (1 hour) | skip discovery cost on no-op stories |
| 9 | Wave-close COMPILER (one run per wave, not per story) | F7, F11 | M | ~80% fewer compiler runs |
| 10 | Knowledge **index** in prompt, not full bodies | F1, F7 | S | -5 reads per compiler run |
| 11 | Story ID in every event header (instrumentation) | F15 | S | operator UX |

**Estimated combined effect of items 1, 2, 5, 6, 8** (all small-effort prompt/template fixes): a typical story should drop from ~40 tool calls (DEV+REVIEWER+COMPILER) to ~15–20, AND the 50% retry rate should drop to near-zero. That's the **bang-for-buck cluster** — a single afternoon of work.

Items 3 (Context Pack) and 7 (touchPoints) are the deeper structural fixes that unlock further savings + correctness, but both are 1–2 day efforts.

---

## Cross-reference: `agentic-pipeline-forensic-report.md` (prior epic, Chrome-Dino React+Vite)

That report analyzed an earlier 10-story epic at the **DDB-job level** (with measured durations and costs per step), giving a more rigorous baseline than my log-walking can. Findings line up cleanly — and surface several issues I missed.

### Confirmations (the forensic report independently observed the same patterns)

| My finding | Forensic-report evidence |
|------------|--------------------------|
| **F1** (cold-start re-discovery, no shared context) | "No shared context across stories" — Story 10 took 249s + $0.32 re-reading every prior file. **Proposed fix matches my Story Context Pack: "Agent SDK subagents share context. DEV's file reads are cached for REVIEWER and COMPILER."** |
| **F2** (VISUAL_TESTS retry rate / reviewer false-fail) | "Story 5 failed review **3 times** for 'missing test files' when AC didn't require tests. The reviewer interpreted `needs_browser=true` as needing test files." Same root cause. |
| **F4** (reviewer churn / inconsistent verdicts) | "Inconsistent strictness… Story 10 failed review 3 times with increasingly vague feedback. Final PASS was on the same code — the reviewer essentially gave up." |
| **F7** (compiler re-reads everything; needs shared context) | **"compile-knowledge consumed 32 of 70 total minutes (47%) and 35% of total cost ($1.63 of $4.69)."** Quantified. |
| **F11** (knowledge graph rebuilt 5× / race conditions) | "8 stories in wave 1 each wrote to the same `knowledge/index.md` concurrently. **Last write wins; 7 writes are lost.**" Confirms my recommendation to move COMPILER to wave-close. |
| **F19** (no-code-needed stories pay full discovery cost) | Story 10 (App Assembly) — same shape as e4w0s1: dev re-read every prior file just to wire things up. |

### New insights from the forensic report (now incorporated below)

**F22. Compiler runs on Sonnet for what is effectively markdown templating**

Forensic report: *"Wrong model: Uses sonnet (12× more expensive than haiku) for what is effectively markdown templating. No reasoning complexity."* Compile-knowledge averages **$0.16 of $0.47 per story**, dominating cost on small-diff stories. The current dino3 plan reproduces this — every COMPILER step in batches 1–8 was Sonnet.

**Fix:** flip COMPILER model to Haiku in the pipeline builder. Combined with **F7 fix #1** (wave-close compiler) the savings are multiplicative — fewer runs **and** cheaper per run.

---

**F23. DEV does not commit per story → `compile-diff` fallback fires the wrong file set**

Forensic report: *"DEV doesn't commit its changes. So `HEAD~1 HEAD` compares against some arbitrary prior state, not against the state before this story began. The `find -newer` fallback then catches every file ever touched — for a freshly scaffolded project, that's every file in the repo, causing the compiler to try to document `node_modules` and every config file."*

I didn't observe this in dino3 logs because the project is small and HTML-only — no `node_modules` to drown the compiler. But the dangerous fallback is still present in the daemon.

**Fix:**

1. **Commit per story.** Add a shell step `compile-commit-on-pass` after `review` PASS but before `compile-diff`: `git add -A && git commit -m "story: <storyId>"`. Then `compile-diff` is reliably the right scope.
2. Or: kill the `find -newer` fallback entirely and fail loud if `git diff` returns empty (instead of silently falling back to "everything").

---

**F24. OOM crashes from running multiple Claude Code processes on t2.micro (1.8 GB)**

Forensic report: *"5 parallel Sonnet compilers on a 1.8 GB t2.micro caused OOM kills three times, losing mid-flight work."* Phase A.1 (graceful shutdown) and A.3 (retry ladder) catch the symptom but don't address the cause.

**Fix options:**

1. **Per-agent concurrency cap on the daemon** (lower than the wave's parallelism, since waves dispatch faster than agents complete). The current cap appears to be implicit — make it explicit and tied to `MAX_CONCURRENT_CLAUDE_PROCESSES`, default 2 on t2.micro.
2. **Upsize EC2** to t3.small / t3.medium — small recurring cost vs. lost work + retries.
3. **Long-term:** the forensic report's preferred fix is **Claude Agent SDK with subagents** — one parent process, many lightweight in-context subagents. No per-call cold starts. Out of scope for v1; documented under "deferred architecture" below.

---

**F25. Reviewer needs structured per-criterion verdicts, not free-form PASS/FAIL**

Forensic report: *"Reviewer needs structured criteria evaluation (pass/fail per criterion) instead of free-form verdict. Or replace with a deterministic linter + a lightweight LLM grader only for subjective criteria."*

This goes deeper than my F2 (contract bug) + F14 (turn-budget). Even with both my fixes, a reviewer that emits free-form verdicts will keep being inconsistent on subjective AC. The forensic-report fix is more durable: have the reviewer output a JSON block like `{ AC-1: pass, AC-2: pass, AC-3: { verdict: fail, reason: "..." } }`. Then the daemon decides PASS/FAIL deterministically by ANDing.

**Fix:**

- Reviewer prompt requires `---REVIEW_CRITERIA---` block with one line per AC: `AC-X: pass|fail [reason if fail]`.
- Daemon parses → if any FAIL, route to retry with **only the failed AC** in the feedback (not the full wall of "what passed / what failed" prose).
- Combined with F2 (visual-tests file written by daemon) this resolves most retry waste.

---

**F26. Silent S3 / Memgraph sync failures**

Forensic report: *"`aws s3 sync` ran but `s3://futurator-ai-website/knowledge-live/dino-chrome/` is empty. The `|| echo \"S3 backup skipped\"` swallows errors."* And: *"graph-sync.mjs execution not verified — no output captured confirming Memgraph received the nodes/edges."*

**Fix:**

- Drop the `|| echo "skipped"` swallow on the sync shell step. Fail loud and write an `attention-item` (category=`other` or new `compile-sync-failed`).
- Add a post-sync verification: `aws s3 ls s3://.../<planSlug>/ | wc -l` should be > 0; `mgconsole -e "MATCH (n) WHERE n.planSlug = '<x>' RETURN count(n)"` should match expected.

---

**F27. Visual QA pipeline runs at epic-level (different paradigm than my analysis assumed)**

The forensic report describes a **dedicated VISUAL_QA pipeline** that runs after all waves complete: `qa-start-server` → `qa-evaluate` (Sonnet, 385s, $0.87) → `qa-stop-server`. **In dino3's logs (batches 1–10) I see no equivalent step.** The current pipeline appears to inline visual-tests authoring into DEV's WORK_SUMMARY but never runs the tests.

This is a contract design gap, not a bug per se: the system *captures* visual tests but doesn't *execute* them. Worth a decision:

- (a) Keep epic-level VISUAL_QA with Sonnet+Playwright (forensic-report cost: $0.87 / 6.5 min / epic). Coarse but cheap.
- (b) Per-story visual checks (Haiku + DOM inspection) inside the story pipeline. Tighter feedback but ~$0.05/story added.
- (c) Skip execution; visual-tests.md stays as documentation only (current dino3 behavior).

The forensic report recommends (b). Worth raising with the user before committing.

---

### Deferred architectural shift (per forensic report's "Critical" section)

The forensic report's #1 critical finding: **"Claude Code CLI + custom daemon is the wrong architecture."** Its recommended fix — **Claude Agent SDK with subagents** — addresses F1, F7, F11, F24, and most others structurally:

- Single parent process → eliminates cold starts, OOM risk
- Subagent context inheritance → eliminates redundant reads (F1)
- Native streaming → eliminates "is it frozen?" UX problem
- SDK-level credential management → fixes Phase A.3's "OAuth expired = non-retriable" pain
- Structured subagent orchestration → replaces DynamoDB polling

This is **out of scope for v1 optimization** (it's a re-architecture, not a tweak), but it should be noted as the destination on the roadmap. Items 1–11 in my roadmap are the v1 path; the SDK migration is v2.

---

## Updated optimization roadmap (after forensic-report cross-reference)

| # | Fix | Addresses | Effort | Expected savings |
|---|-----|-----------|--------|------------------|
| **1** | **Daemon writes `visual-tests.md` from extracted block** | F2 | S | eliminates 50% retry rate |
| **2** | **Reviewer: 5-call budget + inline story spec + forbid Globs** | F4, F5, F8, F10, F14, F21 | S | -5 to -10 reviewer calls/story |
| **3** | **Flip COMPILER model from Sonnet → Haiku** | F22 | S (one-line change in pipeline-builder) | **~70% compiler cost reduction** |
| **4** | **Commit per story** (`compile-commit-on-pass` shell step) | F23 | S | eliminates `find -newer` fallback risk |
| 5 | Story Context Pack (DEV+REVIEWER+COMPILER share identical context) | F1, F4, F5, F7, F16 | M | ~50% fewer tool calls per agent |
| 6 | Fix `{{FEEDBACK}}` template substitution | F9 | S | -1 wasted retry turn |
| 7 | DEV prompt: don't re-Read just-edited files; use Read not Bash cat | F3, F12 | S | ~2 reads per story |
| 8 | DEV prompt: don't spawn Explore subagent; don't run npm/node verification | F17, F18 | S | -10+ tool calls on e4-style stories |
| 9 | **Structured per-AC reviewer verdicts** (`---REVIEW_CRITERIA---`) | F25, F4, F2 | M (prompt + daemon parser) | ~80% reduction in retry waste from inconsistent verdicts |
| 10 | **`touchPoints` + `forbiddenAreas` per story** | F6, F20 | M | prevents data loss + scope leakage |
| 11 | Pre-flight `prework-check` shell step | F19 | S | skip discovery cost on no-op stories |
| 12 | Wave-close COMPILER (one run per wave + Haiku model) | F7, F11, F22 | M | ~80% fewer compiler runs + 12× cheaper each |
| 13 | Knowledge **index** in prompt, not full bodies | F1, F7 | S | -5 reads per compiler run |
| 14 | Concurrency cap + EC2 upsize | F24 | S | eliminates OOM crashes |
| 15 | Drop `\|\| echo "skipped"` on sync; verify post-sync | F26 | S | catches silent S3/Memgraph failures |
| 16 | Decide visual-QA paradigm (epic-level vs per-story vs none) | F27 | needs decision | varies |
| 17 | Story ID in every event header (instrumentation) | F15 | S | operator UX |
| 18 | **[v2] Claude Agent SDK with subagents** | F1, F7, F11, F16, F24, plus structural | L | full re-architecture |

**The new "small-effort high-impact bundle" is now items 1, 2, 3, 4, 6, 7, 8** — all S-effort. Estimated combined effect:

- Typical story: ~40 → ~15 tool calls
- VISUAL_TESTS retry rate: 50% → ~0%
- Compile-knowledge cost: ~$0.16/story → ~$0.013/story (12× cheaper Sonnet→Haiku)
- Compile-diff: deterministic (no fallback risk)

That's the **single-afternoon ROI cluster**. Items 5, 9, 10, 12 are the multi-day structural fixes that compound on top.

---

## Iteration log

- **2026-04-26 — batches 1–5:** logs covered e1w0 + e2w0/s1/s2/s3. Established F1–F11.
- **2026-04-26 — batches 6–8 (e3w0s1, e3w0s2, ⚠ e3w0s3 = paste dup):** added F12 (Bash-cat-then-Read), F13 (knowledge-tree path leak), F14 (Haiku turn-budget overrun, 17+ calls), F15 (logs need story-id at every event), F16 (cache-write spikes from drifting context). Reinforced F2 (now 4/8 = 50% retry rate), F4 (worst reviewer hit 17+ calls), F5 (more spurious globs).
- **2026-04-26 — clarification (dashboard screenshots):** confirmed e3w0s2 (`774F391F` cactus) and e3w0s3 (`5E2D3AE6` HUD overlay) are distinct stories — the prior "duplicate" logs were a paste artifact. F15 downgraded from "possible bug" to instrumentation-polish finding. **Real e3w0s3 (HUD) logs still pending.** With s3 starting `13:09:27` and s2 starting `13:12:21`, both touched `main.js` in parallel — F6 may reproduce when those logs arrive.
- **Stats refresh:** epic e3 wall-clock 22m 47s = 1× longest story (s1 dino-sprite 22m, $1.00 — alone is >50% of epic cost). Wave-level parallelism worked. s1 was also the F14 victim (17+ reviewer calls).
- **2026-04-26 — batches 9–10 (real e3w0s3 HUD, e4w0s1 integration, e4w1s1 visual polish):** added F17 (Explore subagent doubles discovery), F18 (npm/node verification on a static project), F19 (no-code-needed stories pay full discovery cost — 25+ tool calls for zero diff), F20 (HUD code leaked into collision story → cross-story scope leakage), F21 (F14 pattern reproducing across multiple stories). Reinforced F2 (5/10 = 50% retry rate steady), F13 (knowledge/tests/visual-tests.md probe reproducing in another reviewer), F14 (cut-off review log in 3 stories now). **Re-prioritized roadmap:** the cluster `{1, 2, 5, 6, 8}` is now identified as the small-effort high-impact bundle — single afternoon of work, drops typical story from ~40 to ~15–20 tool calls AND eliminates the 50% retry rate.
- **F6 reproduction check (e3w0):** confirmed s2/s3 ran in same parallel wave but the daemon happened to serialize their `main.js` writes (s3 finished writing at 13:10:30, s2 started reading at 13:12:34). F6 risk is real but didn't fire here. Still a correctness blocker for plans with denser parallelism.
- **2026-04-26 — forensic-report cross-reference (`agentic-pipeline-forensic-report.md`, prior Chrome-Dino React+Vite epic):** added F22 (compiler on Sonnet should be Haiku — 12× cost), F23 (no per-story commits → `compile-diff` fallback risk), F24 (OOM on t2.micro from 5 parallel Sonnet compilers), F25 (reviewer needs structured per-AC verdicts), F26 (silent S3/Memgraph sync failures), F27 (no visual-QA execution in current dino3 pipeline — design gap). Strong confirmations of F1, F2, F4, F7, F11, F19. Roadmap re-prioritized: small-effort cluster is now `{1, 2, 3, 4, 6, 7, 8}` — adds compiler model flip and per-story commits. **Architectural destination noted:** Claude Agent SDK with subagents as v2 target.

<!-- next iterations append here -->
