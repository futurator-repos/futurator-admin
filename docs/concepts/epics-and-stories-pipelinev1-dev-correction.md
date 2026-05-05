# Epics & Stories — Pipeline v1 Dev Correction

| Field | Value |
|---|---|
| **Status** | Ready for development |
| **Source plan** | `docs/concepts/pipeline-v1-dev-correction.md` |
| **Findings input** | `docs/concepts/pipeline-v1-optimization.md` |
| **Forensic baseline** | `docs/concepts/agentic-pipeline-forensic-report.md` |
| **Sibling plan** | `docs/concepts/epics-and-stories-pipelinev1.md` (failure recovery, talk-to-agent, cost discipline) |
| **Date** | 2026-04-26 |
| **Total epics** | 5 |
| **Total stories** | 28 |
| **Estimated effort** | ~3 weeks of focused work, sequenced |

This plan delivers the **token / context / cost / time optimizations** for the per-story dev pipeline (DEV → REVIEWER → COMPILER → SYNC). Targeted gains: typical 10-story epic from $5.56 / 70 min agent-time / 25 hours wall-clock to **$1.50 / 25 min / ~3 hours**.

---

## How to use this document

Same conventions as the sibling pipelinev1 plan. Each story carries:

- **ID** — `<epic>.<story>` (e.g., `A.3`)
- **Story** — As / I want / So that
- **Acceptance criteria** — numbered, each independently testable
- **Technical notes** — file paths, gotchas, contracts
- **Dependencies** — story IDs across both plans (`A.1`, `pipelinev1 1.2`)
- **Effort** — `S` (≤4 h), `M` (½–1 day), `L` (1-2 days), `XL` (2-3 days)
- **Type** — `arch` (introduces new pattern/contract) / `std` (typical feature) / `triv` (mechanical)
- **Findings addressed** — F-numbers from `pipeline-v1-optimization.md`
- **DoD** — definition of done

---

## Relationship to pipelinev1 (sibling plan)

The sibling plan (`epics-and-stories-pipelinev1.md`) delivers **failure recovery, escalation contracts, talk-to-agent, cost discipline**. This plan delivers **context / token / time optimization** for the happy-path pipeline. They share infrastructure:

| This plan needs from pipelinev1 | Story |
|---------------------------------|-------|
| `NEEDS_ATTENTION` job state | 1.1 |
| Universal exit-signal extractors (`---ESCALATE---`, `---NEED-HUMAN---`) | 1.2 |
| Loop detector (force-escalate at N repeats) | 1.3 |
| Pre-flight validator framework | 1.4 |
| `SessionPool` with typed slot classes (`background` for the wave-close compiler) | 2.1, 2.5 |
| Per-step time ceilings (defense in depth) | 4.2 |
| Cost ceilings + warnings | 4.3, 4.4 |
| Same-kind prompt prefix dedupe (cache stability across DEV→DEV calls) | 5.5 |

| What this plan adds beyond pipelinev1 |
|---------------------------------------|
| Visual-tests file written by daemon (kills 50% retry rate) |
| Per-story `git commit` (kills `find -newer` fallback risk) |
| Compiler model flip (Sonnet → Haiku, 12× cheaper) |
| Story Context Pack (same-story prefix dedupe across DEV+REVIEWER+COMPILER) |
| Wave-close knowledge compiler (one run per wave, kills 47%-of-epic bottleneck) |
| `touchPoints` + `forbiddenAreas` per story (correctness in parallel waves) |
| Pre-flight "story already done" detector |
| Structured per-AC reviewer verdicts |
| Reviewer 5-call budget + inline story spec |
| DEV/REVIEWER prompt hygiene (no Bash-cat / no Explore subagent / no npm verification) |

---

## Index

| Epic | Title | Stories | Effort | Sequencing |
|---|---|---|---|---|
| A | Quick-wins prompt & template hygiene | 7 | 2–3 days | **Ship first** — independent of all pipelinev1 work |
| B | Story Context Pack | 6 | ~5 days | Independent; can interleave with pipelinev1 Epics 1-4 |
| C | Reviewer reform & exit-signal integration | 5 | 3 days | After pipelinev1 1.2 + 1.3 |
| D | `touchPoints` + `forbiddenAreas` + pre-flight checks | 5 | 4 days | After pipelinev1 1.4 |
| E | Wave-close knowledge compiler | 5 | 3 days | After Epic B + pipelinev1 2.1, 2.5 |

### Cross-epic dependency graph

```
Epic A ──→ (independent, ship first)
Epic B ──→ Epic E
              ↑
pipelinev1 Epic 2 (SessionPool) ───┘
pipelinev1 1.2 + 1.3 ──→ Epic C
pipelinev1 1.4 ──→ Epic D
```

---

## Glossary

| Term | Definition |
|---|---|
| **Story Context Pack** | One canonical context block built per story by the daemon, fed byte-identically to DEV / REVIEWER / COMPILER for prompt-cache stability. |
| **Wave-close compiler** | The knowledge-compilation step moved from per-story to per-wave. One run per wave with all story diffs together. |
| **`touchPoints`** | Files a story will create or modify. Declared in story schema. Used to serialize wave-conflicting stories. |
| **`forbiddenAreas`** | File regions / concerns a story must NOT modify. Reviewer enforces. |
| **Per-AC verdict** | Reviewer emits one pass/fail per acceptance criterion in a structured `---REVIEW_CRITERIA---` block; daemon ANDs them deterministically. |
| **Visual-tests block** | The `---VISUAL_TESTS---` block extracted from DEV's output. Currently expected on disk in `visual-tests.md`; this plan makes the daemon the writer. |

---

# Epic A — Quick-wins prompt & template hygiene

**Goal.** Eliminate the high-frequency waste patterns observable in dino3 logs without any structural change. Single-afternoon to 3-day total effort. Independent of pipelinev1.

**Scope.** Compiler model flip, daemon-written visual-tests file, per-story git commits, sync-failure attention items, retry template substitution fix, DEV prompt hygiene rules, story-id in event headers.

**Out of scope.** Reviewer reform (Epic C). Context Pack (Epic B). Compiler relocation (Epic E).

**Demo.** Run a 3-story plan; observe: no VISUAL_TESTS retries, COMPILER cost ~$0.04/story (was ~$0.16), event log shows story IDs, project state has clean per-story commits.

**Expected outcome:** ~44% cost reduction and ~50% retry rate elimination on this epic alone.

---

### Story A.1 — Flip COMPILER model from Sonnet to Haiku

**As a** plan operator, **I want** the compile-knowledge step to use Haiku, **so that** documentation generation costs ~12× less without quality regression.

**Acceptance criteria.**
1. In `functions/shared/pipelines/story-pipeline.ts`, the compile-knowledge step's `model` field changes from `'sonnet'` (or whatever default) to `'haiku'`.
2. Override is env-var-gated: `COMPILER_MODEL` env var, default `'haiku'`, allowing rollback to `'sonnet'` if quality regresses.
3. Updated cost-estimate constants (if any) reflect Haiku pricing.

**Technical notes.**
- One-line code change in the pipeline builder. The bigger work is QA: run 3 representative stories with Haiku, compare output quality of `knowledge/code/*.md` articles against Sonnet baseline. Acceptable: ≥80% structural / informational equivalence.
- Reverse-flip via env var is the rollback path.

**Dependencies.** None.
**Effort.** `S` (≤4 h, including QA pass).
**Type.** `triv`
**Findings addressed.** F22.
**DoD.** Three test stories run end-to-end with Haiku compiler. Articles inspected; no regressions vs Sonnet on the same stories. Cost-per-compile drops by ≥10× in measurement.

---

### Story A.2 — Daemon writes `visual-tests.md` from extracted block

**As a** reviewer agent, **I want** the visual-tests block on disk before I run, **so that** I do not FAIL valid stories for "missing visual-tests file."

**Acceptance criteria.**
1. The daemon's step-output extractor (currently emits `extraction VISUAL_TESTS = …` log lines) writes/appends the block to `<projectDir>/visual-tests.md`.
2. Append semantics: each `criteriaRef` (e.g., `AC-1`) becomes a unique key. New blocks for the same `criteriaRef` replace existing entries; new `criteriaRef`s append.
3. The file's structure is preserved: a single `---VISUAL_TESTS---` … `---END_VISUAL_TESTS---` envelope containing all entries.
4. Parsing failure (malformed YAML inside the block): write a `compile-sync-failed` attention item, do not partial-write.
5. Reviewer prompt template updates: drop the line that says "the developer must include visual-tests block." Replace with: "Visual tests are at `visual-tests.md`. The daemon writes this file from the dev's `---VISUAL_TESTS---` block automatically."

**Technical notes.**
- Extractor logic likely in `daemon/agent-daemon.mjs` near the existing `runExtractors` call (~line 313–348 per pipelinev1 docs).
- File-write happens BEFORE the reviewer step starts. Synchronously, in the daemon job loop — not deferred.

**Dependencies.** None.
**Effort.** `S` (≤4 h).
**Type.** `std`
**Findings addressed.** F2 (the highest-frequency waste pattern, 50% retry rate).
**DoD.** Run a story whose dev emits inline `---VISUAL_TESTS---`. Verify `visual-tests.md` is written with the block before reviewer runs. Reviewer PASSes on first try. Re-run with the same story; verify the block is replaced, not duplicated.

---

### Story A.3 — Add `compile-commit-on-pass` shell step (per-story commits)

**As a** compile-diff step, **I want** a guaranteed clean `HEAD~1 HEAD` diff per story, **so that** I never fall back to `find -newer` (which catches `node_modules`).

**Acceptance criteria.**
1. New shell step `compile-commit-on-pass` inserted into the per-story pipeline AFTER `review` PASS and BEFORE `compile-diff`.
2. Shell command:
   ```bash
   cd <projectDir> && \
     git add -A && \
     git -c user.email=daemon@futurator.local -c user.name='Daemon' \
       commit --allow-empty -m "story: <storyId> — <storyTitle>"
   ```
3. The `git diff` in `compile-diff` reliably scopes to this story's changes only.
4. The `find -newer .mycelium/last-compile-marker` fallback in `compile-diff` is **removed**. If `git diff --name-status HEAD~1 HEAD` returns empty unexpectedly, the step fails loud and writes a `compile-sync-failed` attention item (does not silently document everything).
5. Per-plan branches stay clean: commits created by the daemon use the `Daemon <daemon@futurator.local>` author so they're identifiable in `git log`.

**Technical notes.**
- The shell-guard (Phase A.2) must allow the `git` command in `<projectDir>`. It already does for the existing `compile-diff` step.
- A dry-run: confirm no other code path expects `HEAD~1 HEAD` to compare against epic-start state rather than story-start state.

**Dependencies.** None (sibling pipelinev1 work doesn't gate this).
**Effort.** `S` (≤4 h).
**Type.** `std`
**Findings addressed.** F23.
**DoD.** Run a 3-story plan. After each story, `git log --oneline` shows one new commit per story. `compile-diff` output is scoped per story. Removing `find -newer` does not break any existing test.

---

### Story A.4 — Verify post-sync; remove silent-error swallowing

**As a** plan operator, **I want** to see attention items when sync fails, **so that** I'm not surprised by an empty knowledge bucket.

**Acceptance criteria.**
1. The `compile-sync` shell step's `|| echo "S3 backup skipped"` and `|| echo "Memgraph skipped"` are removed.
2. Post-sync verification:
   - `aws s3 ls s3://<bucket>/<planSlug>/ | wc -l` must be > 0 → otherwise `exit 1`.
   - Memgraph node count check (using `mgconsole` or equivalent) must show ≥1 node tagged with this story → otherwise `exit 1`.
3. On failure, an attention item is written: `category: compile-sync-failed`, `severity: medium`, payload with `{ planId, storyId, sync-target, errorOutput }`.
4. New `compile-sync-failed` value added to `AttentionCategory` union (if not already present from Phase A.4 unused entries).
5. The full sync output (stdout + stderr) is captured in the step's event log so the operator can see why it failed.

**Technical notes.**
- `AttentionCategory` already has `other` — use that if `compile-sync-failed` isn't in the type, OR add it (per `functions/shared/types/attention.ts`).
- Memgraph check shouldn't block the pipeline — it's slower; consider running async after the wave completes.

**Dependencies.** Phase A.4 (attention-items table — already shipped).
**Effort.** `S` (≤4 h).
**Type.** `std`
**Findings addressed.** F26.
**DoD.** Force a sync failure (e.g., revoke S3 IAM temporarily). Verify an attention item appears with the right category and payload. Restore IAM, retry — verify the next sync succeeds and no spurious item is created.

---

### Story A.5 — Fix `{{FEEDBACK}}` template substitution in retry prompt

**As a** retry dev agent, **I want** the actual reviewer feedback in my prompt, **so that** I do not waste a turn asking "where's the feedback?"

**Acceptance criteria.**
1. Audit `daemon/pipelines/templates/*.tpl` (or wherever lives) for the retry prompt. Identify the `{{FEEDBACK}}` placeholder substitution path.
2. Verify substitution feeds the **verbatim reviewer feedback text** (not the truncated `extraction FEEDBACK = …` extractor output, which strips the `FEEDBACK:` label).
3. After Epic C (structured verdicts), substitution feeds **only the failed AC reasons**, not the full PASS/FAIL prose wall. This story prepares the substitution path; Epic C wires the structured input.
4. Add a smoke unit test that asserts a sample reviewer text round-trips through the template with no `{{…}}` placeholders surviving.

**Technical notes.**
- The bug observed in dino3 e3w0s3: dev retry sees literal `{{FEEDBACK}}`, then asks "could you paste the real feedback?" Wastes a turn. Cause: either substitution is broken or the extractor truncates the leading label.

**Dependencies.** None.
**Effort.** `S` (≤4 h).
**Type.** `triv`
**Findings addressed.** F9.
**DoD.** Force a review FAIL; observe retry prompt; verify it contains the verbatim feedback text and no `{{…}}` artifacts.

---

### Story A.6 — DEV prompt hygiene rules

**As a** DEV agent, **I want** clear instructions to skip discovery I don't need, **so that** I don't burn 10–25 tool calls re-bootstrapping the project on every story.

**Acceptance criteria.**
1. The DEV prompt template gains a new `DISCOVERY` section appended after the role description:
   ```
   DISCOVERY:
   - Project tree, plan, story spec, AC, and adjacent files are already in your
     context (see <project_context> below — added by Epic B; until then, use the
     existing <story_brief>).
   - Do NOT run `ls`, `find`, `tree`, or `Bash cat` on the project directory.
   - Do NOT spawn Agent / Explore subagents — your context already contains everything.
   - Read at most the files you will modify, in ONE message with parallel Read calls.

   VERIFICATION:
   - Do NOT Read a file you just Wrote or Edited — those tools error if they fail.
   - Do NOT run `npm run dev` / `node --check` / `node --input-type=module` for
     ad-hoc verification. The project's runtime is in <run_command>.
   - Visual tests in `visual-tests.md` are the contract — your job is to make them
     pass at runtime.
   ```
2. The reviewer prompt is updated with a parallel section (covered in Epic C; this story does the DEV side only).
3. A `<run_command>` placeholder is added to the prompt scaffold; for now substitutes from `plan.runCommand` if set, otherwise falls back to `python3 -m http.server 8080`.
4. The Discovery section is appended exactly once (no duplication on retry).

**Technical notes.**
- Templates live in `daemon/pipelines/templates/` per Phase C documentation. Specifically `epic-orchestrator-prompt.md.tpl` was modified recently — check sibling files for dev/reviewer prompts.
- Keep total added prompt length under ~400 tokens.

**Dependencies.** None.
**Effort.** `S` (≤4 h).
**Type.** `triv`
**Findings addressed.** F3, F12, F17, F18.
**DoD.** Run a story; observe the dev does NOT spawn an Explore subagent, does NOT run `ls`/`find`/`tree`, does NOT re-Read just-edited files, does NOT run npm. Tool count for typical dev step drops by ≥5.

---

### Story A.7 — Story ID prefix in every event header

**As an** operator reading raw logs, **I want** to see which story emitted each event, **so that** I can tell parallel stories apart without the dashboard.

**Acceptance criteria.**
1. Every event line emitted by the daemon (currently `[<timestamp>] dev / DEV / step_start`) gains a `[<storyShortId>]` prefix → `[<timestamp>] [<storyShortId>] dev / DEV / step_start`.
2. `storyShortId` = first 6 chars of story UUID (e.g., `774F39`).
3. Applies to ALL step types (dev, review, retry, compile-*). Currently `compile-knowledge` already logs `Compilation started for story <uuid>` once at start; this extends the pattern to every event.
4. The Logs tab UI (Phase C.5) renders the prefix; existing filter chips (per-step filters) continue to work.
5. Event-table schema is unchanged; the storyId is added to the rendering layer only.

**Technical notes.**
- The event emitter / logger lives in the daemon, likely `daemon/agent-daemon.mjs` and `daemon/pipelines/lib/`. Find the central log fn.
- Don't break the parser used by `src/components/labs/agentic-workflow/story-live-output.tsx` — verify it tolerates the new prefix or update it to extract storyId from the prefix.

**Dependencies.** None.
**Effort.** `S` (≤4 h).
**Type.** `triv`
**Findings addressed.** F15.
**DoD.** Trigger 2 parallel stories; observe their events interleaved in raw log; verify storyId prefix is correct on every event line.

---

# Epic B — Story Context Pack

**Goal.** Establish a single canonical context block per story, fed identically to DEV / REVIEWER / COMPILER, so the prompt cache stays warm across all three agents and no agent re-discovers anything.

**Scope.** Context-pack assembler module, prompt-template wiring for DEV/REVIEWER/COMPILER, knowledge index format, recent-diffs and prev-WORK_SUMMARY fields.

**Out of scope.** Reviewer prompt structural changes (Epic C). Wave-close compiler (Epic E).

**Demo.** Run a 3-story plan. Inspect Anthropic API logs / event log: cache-read input tokens >> cache-creation tokens across DEV→REVIEWER→COMPILER for the same story. Per-agent bootstrap reads drop to ≤2.

**Expected outcome:** -15 to -25 tool calls per story, -$0.20 to -$0.40 per story.

---

### Story B.1 — `buildStoryContextPack` assembler module

**As a** daemon job-launcher, **I want** a single function to assemble the context pack, **so that** all three agents per story share a deterministic block.

**Acceptance criteria.**
1. New module `daemon/pipelines/lib/story-context-pack.mjs` exports `async function buildStoryContextPack(input)`.
2. Input: `{ plan, story, prevStoriesInWave, projectDir }` (plan + story rows from DDB; prev stories already DONE in this wave; absolute project dir).
3. Output (deterministic; same inputs → same output):
   ```
   {
     planMd: string,                              // full plan.md content
     storySpec: { id, title, ac, touchPoints },   // structured story data
     projectTree: string,                         // depth-2 tree, dirs+filenames
     fileDigests: Record<path, { sha: string, head50: string }>,
                                                  // adjacent files (touchPoints + 1-hop)
     recentDiffs: string,                         // git log --oneline --since=<wave-start>
     prevWorkSummaries: { storyId, title, summary }[],
                                                  // adjacent done stories' WORK_SUMMARY
     knowledgeIndex: string,                      // knowledge/index.md ONLY, NOT bodies
     runCommand: string,                          // from plan.runCommand or default
   }
   ```
4. The output is **serialized to a stable string** (used for prompt-cache compatibility): JSON with sorted keys, OR a fixed-order markdown block. Document the choice in module header.
5. Total serialized size capped at 30k tokens (~120kB). If the file digests would push over, truncate `head50` to `head20` first; if still over, emit a `context-truncated` warning event.

**Technical notes.**
- `git log --since=<wave-start>` — wave-start time comes from the wave's `startedAt` field on the wave object.
- `fileDigests` is intentionally lightweight. Full file bodies enter the prompt only when the agent decides to Read them (which it shouldn't usually need to).
- `knowledgeIndex` reads ONLY `knowledge/index.md` — not `log.md`, not `dependency-map.md`, not any `code/*.md`. Those are too big.

**Dependencies.** None (independent module).
**Effort.** `M` (1 day).
**Type.** `arch`
**Findings addressed.** F1, F5, F7, F13, F16.
**DoD.** Unit tests with synthetic plan + story + project dir; verify output is deterministic across two runs. Snapshot-test the serialization format.

---

### Story B.2 — Inject `<project_context>` into DEV prompt

**As a** DEV agent, **I want** the project context as a prompt block, **so that** I don't re-read the same files for every story.

**Acceptance criteria.**
1. The dev prompt template (per `daemon/pipelines/templates/`) gains a `<project_context>` block at a fixed position (BEFORE role instructions, AFTER any system header that must precede everything).
2. The block contains the markdown-serialized output of `buildStoryContextPack` (Story B.1).
3. The block is identical across DEV / REVIEWER / COMPILER for the same story (Stories B.3, B.4 will mirror this).
4. The DEV's "DISCOVERY" rules from A.6 are updated to reference `<project_context>` explicitly: "Your context already contains the project tree, plan, story spec, AC, adjacent files, and recent diffs. Do not re-read these."
5. Cache-stable: the block's position and surrounding boilerplate are byte-identical between two runs of the same story (no timestamps, no random IDs).

**Technical notes.**
- "Cache-stable" means: the prompt prefix Anthropic's API hashes for cache lookup must match across DEV→REVIEWER→COMPILER. Position the `<project_context>` block as early as possible in the prompt, before any role-specific text.
- Coordinate with pipelinev1 Story 5.5 (audit prompt prefixes) — they target same-kind cache hits across stories; we target same-story cache hits across roles. Compatible.

**Dependencies.** A.6, B.1.
**Effort.** `M` (1 day).
**Type.** `arch`
**Findings addressed.** F1, F16.
**DoD.** Run one story with logging on Anthropic-API-side cache stats. DEV's `cache_read_input_tokens` ≥ 0 (first run, cache primed). Reviewer's run on same story shows `cache_read_input_tokens` >> `cache_creation_input_tokens` for the prefix.

---

### Story B.3 — Inject `<project_context>` into REVIEWER prompt

**As a** REVIEWER agent, **I want** the same context block as DEV, **so that** I do not Glob/find/Read-on-dir to discover the project.

**Acceptance criteria.**
1. Reviewer prompt template gains the same `<project_context>` block at the same position as DEV (B.2).
2. Reviewer's existing `<story_spec>` block is **removed** in favor of `<project_context>.storySpec` — single source of truth.
3. Reviewer prompt now includes a forbid-discovery section (will be expanded in Epic C):
   ```
   DISCOVERY:
   - Story spec, AC, project tree, adjacent files, recent diffs are in <project_context>.
   - Do NOT use Glob, find, Bash ls, or Read on a directory.
   - Do NOT search disk for the story spec — it is in <project_context>.storySpec.
   ```

**Technical notes.**
- Cache hit between DEV and REVIEWER requires the `<project_context>` block to be byte-identical. Do not interpolate any per-role text into it.

**Dependencies.** B.2.
**Effort.** `S` (≤4 h).
**Type.** `std`
**Findings addressed.** F1, F4, F5, F8, F13, F16.
**DoD.** Run a story; reviewer's tool-call count drops from baseline ~5–17 to ≤2. Cache-read tokens for reviewer's first run on the second story show DEV→REVIEWER cache reuse.

---

### Story B.4 — Inject `<project_context>` into COMPILER prompt

**As a** COMPILER agent, **I want** the same context block as DEV+REVIEWER plus the diff, **so that** I do not re-read every knowledge file and source file the dev just edited.

**Acceptance criteria.**
1. Compiler prompt template gains the `<project_context>` block at the same position.
2. New `<step_input>` block added AFTER `<project_context>` containing:
   - `git diff` output for this story (from `compile-diff` step result)
   - DEV's WORK_SUMMARY
   - REVIEWER's verdict
3. Compiler prompt's discovery rules: "Do NOT re-read the source files DEV just edited — their post-state is in `<step_input>.diff`. Do NOT read `knowledge/log.md`, `knowledge/system/dependency-map.md`, or `knowledge/code/*.md` unless you intend to edit them. The index is in `<project_context>.knowledgeIndex`."

**Technical notes.**
- The COMPILER's typical 10-read pattern (every story) collapses to 0–2 reads if it stays in scope.
- This story stages the cleanup. The bigger savings come in Epic E (wave-close compiler).

**Dependencies.** B.2.
**Effort.** `S` (≤4 h).
**Type.** `std`
**Findings addressed.** F1, F7, F11, F16.
**DoD.** Run a story; compiler's read count drops from ~10 to ≤2. Knowledge articles still produced correctly.

---

### Story B.5 — Knowledge index format (paths + 1-line purpose only)

**As a** context-pack assembler, **I want** a tight knowledge-index format, **so that** I never include full knowledge bodies in the context block (which would blow context budgets).

**Acceptance criteria.**
1. New required format for `knowledge/index.md`:
   ```
   # Knowledge Index

   ## Code articles
   - code/main.js.md — Game loop, state machine, drawScene orchestrator.
   - code/dino.js.md — Dino physics + pixel-art sprite rendering.
   - code/obstacle.js.md — Cactus spawning, scrolling, and rendering.
   ...

   ## System articles
   - system/dependency-map.md — Module → module import graph.
   - system/architecture.md — High-level architecture overview.

   ## Tests
   - tests/visual-tests.md — Visual test definitions.
   ```
2. Each line is ≤ 120 characters: `<path> — <one-line-purpose>`.
3. The COMPILER (current per-story OR future wave-close) maintains this format. New articles are added with a 1-line purpose distilled from the article body.
4. `buildStoryContextPack` (B.1) reads only this index, never the full bodies.
5. A migration: existing `knowledge/index.md` files in active projects get re-generated to this format on the next compile (compiler reads existing entries, distills 1-liner if missing, writes new format).

**Technical notes.**
- This is a soft contract: the compiler may include richer text in the index, but the parser ignores anything beyond the first ` — ` separator on a line.

**Dependencies.** B.1.
**Effort.** `M` (1 day).
**Type.** `std`
**Findings addressed.** F1, F7.
**DoD.** Existing dino3 project's `knowledge/index.md` is re-generated to this format. Index size drops from ~5kB to ~1kB. Context-pack output (B.1) reflects the new shape.

---

### Story B.6 — `recentDiffs` + `prevWorkSummaries` context fields

**As a** DEV / REVIEWER / COMPILER agent on story N+1 of a wave, **I want** to see what the prior stories in the wave just shipped, **so that** I know how the codebase changed without re-reading everything.

**Acceptance criteria.**
1. `buildStoryContextPack` populates `recentDiffs` from `git log --oneline --since=<waveStart> -- <projectDir>` (paths included).
2. `prevWorkSummaries` is populated from prior DONE stories in the same wave: their stored WORK_SUMMARY texts are included verbatim, keyed by storyId.
3. WORK_SUMMARYs are stored on the story row when emitted by DEV (already extracted by daemon — verify storage path; if not stored, add to story-repository).
4. When story N+1 starts, its DEV / REVIEWER / COMPILER all see what stories N and earlier shipped.
5. Size cap: top 20 commits in `recentDiffs`; top 5 prior WORK_SUMMARYs (latest first). If more, truncate with `[…N more truncated]`.

**Technical notes.**
- Prior stories' WORK_SUMMARYs are gold for context. They tell DEV "the previous story added a `drawCacti()` function in `obstacle.js`" without DEV needing to read the file.
- For wave-0 of an epic, both fields will be near-empty. Fine.

**Dependencies.** B.1.
**Effort.** `M` (1 day).
**Type.** `std`
**Findings addressed.** F1, F19.
**DoD.** Run a 4-story sequential wave. Story 4's DEV prompt contains stories 1–3's WORK_SUMMARYs. Story 4's DEV does not re-read files that 1–3 created.

---

# Epic C — Reviewer reform & exit-signal integration

**Goal.** Make REVIEWER deterministic, budgeted, and able to escalate cleanly to humans on subjective AC.

**Scope.** Structured per-AC verdicts, daemon parser, 5-call budget, inline story spec, exit-signal integration.

**Out of scope.** DEV escalation (deferred — DEV rarely needs it). Visual-QA reviewer (separate plan).

**Demo.** Force a story with one ambiguous AC. Reviewer emits per-AC verdicts including `AC-3: needs-human — <reason>`. Daemon transitions job to NEEDS_ATTENTION. Operator opens a Talk conversation, resolves, applies output, wave advances.

**Expected outcome:** ~80% reduction in retry waste from inconsistent verdicts (~$0.40 / 4 min saved per epic).

---

### Story C.1 — Structured `---REVIEW_CRITERIA---` block in reviewer prompt

**As a** REVIEWER, **I want** to emit one verdict line per AC, **so that** the daemon can decide PASS/FAIL deterministically.

**Acceptance criteria.**
1. Reviewer prompt template (after the `<project_context>` block from B.3) requires the output:
   ```
   ---REVIEW_CRITERIA---
   AC-1: pass
   AC-2: pass
   AC-3: fail — <one-line reason, ≤120 chars>
   AC-4: needs-human — <one-line question>
   ---END_REVIEW_CRITERIA---
   ```
2. Three verdict values per AC: `pass`, `fail`, `needs-human`.
3. The block is REQUIRED — reviewer must emit it on every review. Missing block = daemon-side hard FAIL with a `prompt-format` attention item.
4. Reviewer's free-form `VERDICT: PASS` / `VERDICT: FAIL` text is REMOVED from the prompt template — the daemon derives the overall verdict from the structured block.

**Technical notes.**
- Per-AC structure forces the LLM to localize judgement, which Haiku does much more consistently than free-form prose.
- `needs-human` is the integration point with pipelinev1 Story 1.2's `---NEED-HUMAN---` exit signal — see C.2 and C.5.

**Dependencies.** B.3 (reviewer context block).
**Effort.** `M` (1 day).
**Type.** `arch`
**Findings addressed.** F2, F4, F25.
**DoD.** Run 5 stories. Each reviewer turn emits a well-formed `---REVIEW_CRITERIA---` block. Aggregate inconsistency rate (same-AC-different-verdict-on-same-code) drops below 10%.

---

### Story C.2 — Daemon parser for `---REVIEW_CRITERIA---` → deterministic verdict

**As a** daemon, **I want** to parse the structured block and decide PASS/FAIL by ANDing AC verdicts, **so that** verdict aggregation is deterministic.

**Acceptance criteria.**
1. New extractor in `daemon/pipelines/lib/extractors/` (alongside existing extractors): `reviewCriteriaExtractor`.
2. Parses the block into `{ [acId]: { verdict: 'pass' | 'fail' | 'needs-human', reason?: string } }`.
3. Daemon's verdict logic:
   - All `pass` → step PASS, advance pipeline.
   - Any `fail` → step FAIL, route to retry; **retry prompt includes ONLY the failed-AC reasons**, not the full block.
   - Any `needs-human` (regardless of others) → step transitions to `NEEDS_ATTENTION` with `triggeredBy: REVIEWER_NEEDS_HUMAN`, payload contains the per-AC question(s).
4. Malformed block (missing AC, unknown verdict value, no reasons for `fail`/`needs-human`) → step FAIL with `prompt-format` attention item.
5. Compatible with pipelinev1 Story 1.2's escalation extractors — `needs-human` produces the same NEEDS_ATTENTION outcome, so the operator UI (pipelinev1 Story 1.9) handles both uniformly.

**Technical notes.**
- This story consumes pipelinev1 Story 1.1 (`NEEDS_ATTENTION` state) and 1.2 (escalation payload schema). If those haven't shipped yet, this story is blocked. Could be implemented standalone with a simpler `FAIL`/`PASS` mapping (no `needs-human` path) and the `needs-human` path added later — split if blocked.

**Dependencies.** C.1, pipelinev1 1.1, pipelinev1 1.2.
**Effort.** `S` (≤4 h on top of C.1).
**Type.** `std`
**Findings addressed.** F2, F4, F25.
**DoD.** Synthetic test: send a structured block with mixed `pass` / `fail` / `needs-human` → daemon makes the right decision. Force-test malformed block → attention item created.

---

### Story C.3 — Reviewer 5-call budget; ban Globs / find / dir-Read

**As a** REVIEWER, **I want** a hard cap on tool calls and explicit forbid-list, **so that** I stop pathological exploration before it overruns.

**Acceptance criteria.**
1. Reviewer prompt template includes:
   ```
   CONSTRAINTS:
   - Hard budget: 5 tool calls maximum.
   - Do all reads in ONE message with parallel calls. Never sequential.
   - Do NOT use Glob, find, Bash ls — the changed-file list is in <project_context>.
   - Do NOT Read directories — Read takes file paths only.
   - Do NOT re-grep for symbols Edit just inserted — trust the diff.
   ```
2. Daemon-side defense in depth: pipelinev1 Story 1.3's loop detector (force-escalate at 6 repeated tool calls) catches violations even if the reviewer ignores the budget.
3. Daemon-side defense from pipelinev1 Story 4.2: time ceiling 10 min for reviewer step. If exceeded, transition to NEEDS_ATTENTION via `triggeredBy: TIME_CEILING`.

**Technical notes.**
- The 5-call budget is a soft (prompt-level) cap. The loop detector is the hard cap. With both, F14-style 17+ tool-call reviews become impossible.
- Same prompt position as C.1's CONSTRAINTS — append to the existing block.

**Dependencies.** B.3 (reviewer context block).
**Effort.** `S` (≤4 h).
**Type.** `triv`
**Findings addressed.** F4, F8, F10, F14, F21.
**DoD.** Run 5 stories. Average reviewer tool calls drop to ≤4. No reviewer turn exceeds 6 tool calls.

---

### Story C.4 — Inline `<story_spec>` removes disk-search behavior

**As a** REVIEWER, **I want** the complete story spec inline in my prompt, **so that** I never search the filesystem for it.

**Acceptance criteria.**
1. The `<project_context>.storySpec` field (from B.1) is rendered explicitly in the reviewer prompt as a `<story_spec>` markdown block.
2. Reviewer prompt explicitly says: "The complete story spec is in `<story_spec>` above. The story spec is NOT stored on the project box (the EC2 worker). Do not search the filesystem for `**/*.story.md`, `**/*test*.md`, etc."
3. Reviewer prompt drops any references to `knowledge/tests/visual-tests.md` and any other knowledge-tree paths that don't exist on the worker — the only canonical visual-tests path is `<projectDir>/visual-tests.md` (per A.2).

**Technical notes.**
- This story is mostly a prompt edit; the data already lands via B.1.

**Dependencies.** B.3, C.1.
**Effort.** `S` (≤4 h).
**Type.** `triv`
**Findings addressed.** F5, F13.
**DoD.** Reviewer no longer Globs for `**/*.story.md`, `**/*acceptance*`, etc. across 5 test stories.

---

### Story C.5 — Reviewer `needs-human` integrates with Talk-to-agent

**As an** operator, **I want** to Talk to a reviewer that asked for human input, **so that** I can resolve subjective AC quickly.

**Acceptance criteria.**
1. When reviewer emits `needs-human` for an AC, the resulting NEEDS_ATTENTION item includes (per pipelinev1 Story 1.2 schema):
   - `category: reviewer-needs-human` (new value in `AttentionCategory`)
   - `escalationPayload.humanQuestion`: the AC's reason from the structured block
   - `escalationPayload.context`: `{ acId, dev_work_summary, diff }`
2. The attention inbox row (pipelinev1 Story 1.10) renders the question prominently.
3. Operator clicks Talk (pipelinev1 Stories 3.7, 3.8, 3.9) → opens conversation in `fresh` mode with handoff template populated from the escalation payload.
4. Operator's conversation produces a verdict (e.g., "AC-3 should pass — the visual aesthetic is acceptable for prototype rigor").
5. Operator clicks "Apply this output" (pipelinev1 Story 3.6) → the conversation's last turn is parsed for an updated `---REVIEW_CRITERIA---` block; if extractors fire, the daemon uses that as the final verdict and advances the wave.

**Technical notes.**
- `apply-output` (pipelinev1 Story 3.6) needs to know how to map a Talk's last turn into a reviewer-style structured block. This may need a dedicated handoff template for `reviewer-needs-human`.
- This story is mostly UI/DDB plumbing; the LLM-side contract is in C.1 + C.2.

**Dependencies.** C.1, C.2, pipelinev1 1.2, pipelinev1 1.10, pipelinev1 3.6, pipelinev1 3.8.
**Effort.** `M` (1 day).
**Type.** `std`
**Findings addressed.** F25 (residual cases not solvable by structured verdicts alone).
**DoD.** Force a `needs-human` reviewer verdict. Operator opens Talk, exchanges 2 messages, clicks Apply. Wave advances. Story is marked `COMPLETED_VIA_TALK`.

---

# Epic D — `touchPoints` + `forbiddenAreas` + pre-flight discovery

**Goal.** Eliminate parallel-wave file collisions (correctness) and the "no-code-needed story burns 25 tool calls discovering this" waste.

**Scope.** Schema additions, planner emission, plan-time wave-conflict serialization, dev/reviewer enforcement, pre-flight validator.

**Out of scope.** Per-region forbiddenAreas inside a file (regex-based). v1 = full-file granularity.

**Demo.** Plan with two stories declaring `touchPoints: ['main.js']` is rejected at plan-build with "stories X and Y conflict on main.js — assign to different waves." After fix, plan runs cleanly. A story with all `touchPoints` already covered by recent commits emits "no changes required" without spawning DEV's full discovery.

**Expected outcome:** **correctness** (eliminates silent data loss in parallel waves) + ~$0.30 / 3 min saved per no-op story.

---

### Story D.1 — Schema: `touchPoints` and `forbiddenAreas` on Story

**As a** plan-time validator, **I want** structured fields per story to declare file touch and no-touch zones, **so that** I can serialize conflicts.

**Acceptance criteria.**
1. `Story` type in `functions/shared/types/plan.ts` (and mirrored in `src/types/plan.ts`) gains:
   ```
   touchPoints: string[]      // file paths the story creates or modifies
   forbiddenAreas?: string[]  // glob patterns or paths the story must NOT modify
   ```
2. Story Zod schema in `functions/shared/schemas/plan-schema.ts` validates both fields.
3. DDB story-repository handles read/write of new fields.
4. Backwards compat: stories without `touchPoints` (legacy) default to `['<UNKNOWN>']` — a sentinel that disables conflict-serialization for them (treats them as wave-isolated).

**Technical notes.**
- `touchPoints` is REQUIRED for new stories created by the planner (D.2). Legacy stories carry the sentinel.

**Dependencies.** None.
**Effort.** `S` (≤4 h).
**Type.** `arch`
**Findings addressed.** F6, F20.
**DoD.** Type tests pass; existing stories load without breaking; new stories can be created with both fields.

---

### Story D.2 — Planner emits `touchPoints` per story

**As a** planner agent, **I want** to declare which files each story touches, **so that** the wave reducer can serialize conflicts.

**Acceptance criteria.**
1. The planner workflow (`bmad:bmm:workflows:create-epics-and-stories` or wherever stories get generated) is updated to emit `touchPoints` for every new story.
2. Planner prompt instructs:
   ```
   For each story, declare `touchPoints` — the file paths it will create or modify.
   Be precise: list every file the story will touch. If a story doesn't have a clear
   file set, restate the story scope until it does.
   Optionally declare `forbiddenAreas` — file regions or concerns the story must not
   modify (e.g., "HUD rendering", "src/utils/auth.ts").
   ```
3. For HARD cases (cross-cutting refactors, integration stories), the planner is allowed to declare `touchPoints: ['<EPIC_WIDE>']` — a sentinel that excludes the story from parallel waves entirely.
4. Existing planning workflows in `bmad/` are updated; documented in their templates.

**Technical notes.**
- Planning prompts are in the BMAD bundle. Find the create-epics-and-stories workflow's instructions and append the new requirement.

**Dependencies.** D.1.
**Effort.** `M` (1 day).
**Type.** `arch`
**Findings addressed.** F6, F20.
**DoD.** Generate a fresh plan via the planner. All stories carry `touchPoints`. A cross-cutting story carries `<EPIC_WIDE>`.

---

### Story D.3 — Plan-time wave-conflict serialization

**As a** wave reducer, **I want** stories whose touchPoints intersect to be in different waves, **so that** I never silently drop one writer's edits.

**Acceptance criteria.**
1. New module `functions/shared/services/wave-conflict-resolver.ts` exports `resolveWaves(stories): Wave[]`:
   - Build graph: file → set of stories that touch it.
   - Greedy assignment: place story in earliest wave where no existing story shares a `touchPoint`.
   - `<EPIC_WIDE>` stories always get their own wave.
2. Plan reducer (`functions/shared/services/plan-reducer.ts`) calls `resolveWaves` at plan-build time, replacing or augmenting the existing wave assignment.
3. Wave launch (`launchPipelineWave`) asserts no two RUNNING stories' `touchPoints` intersect — defensive runtime check.
4. Errors fail loud with a structured message: `"Wave conflict: stories <A> and <B> both touch <file>. They must be in different waves."`

**Technical notes.**
- The current wave assignment may already exist somewhere; this story replaces or wraps it.
- v1: greedy is fine. Optimal scheduling (NP-hard) is out of scope.

**Dependencies.** D.1, D.2.
**Effort.** `M` (1 day).
**Type.** `arch`
**Findings addressed.** F6.
**DoD.** Synthetic plan with overlapping touchPoints — resolver produces correct serialization. Existing dino3 e2w0 (4 stories all editing `main.js`) would have been split into 4 sequential waves by this resolver.

---

### Story D.4 — DEV / REVIEWER enforce `touchPoints` and `forbiddenAreas`

**As a** REVIEWER, **I want** to FAIL diffs that touch files outside the declared scope, **so that** stories don't silently leak work into adjacent stories' territory.

**Acceptance criteria.**
1. The DEV prompt (after `<project_context>`) includes:
   ```
   SCOPE:
   - You may modify files in <touch_points>.
   - You MUST NOT modify <forbidden_areas>.
   - Modifying any other file requires escalation via ---ESCALATE---.
   ```
2. The REVIEWER computes the actual diff's file set from `<step_input>.diff` and flags:
   - Files modified outside `touchPoints` → AC: `scope-touchpoints: fail — modified <file> not in touchPoints`
   - Files matching `forbiddenAreas` → AC: `scope-forbidden: fail — modified <file> in forbiddenAreas`
3. These appear as automatic AC entries in the structured `---REVIEW_CRITERIA---` block — added by the daemon's reviewer prompt builder, not the human author.
4. Reviewer's emission of these scope ACs is enforced via prompt: "If `<step_input>.diff` shows files outside `touch_points`, you MUST emit `scope-touchpoints: fail` for those files."

**Technical notes.**
- Daemon-side enforcement (computing diff against touchPoints in shell) would be more deterministic than asking the LLM. Optional alternative: a shell step BEFORE reviewer that computes the scope-violation set and pre-fills the structured block. Trade-off: deterministic but more daemon code.

**Dependencies.** D.1, B.4 (compiler diff in step input also useful here).
**Effort.** `M` (1 day).
**Type.** `std`
**Findings addressed.** F6, F20.
**DoD.** Test: a DEV-produced diff that adds `obstacle.js` (out of scope) → reviewer FAILs with `scope-touchpoints: fail`.

---

### Story D.5 — Pre-flight `prework-check` validator

**As a** DEV agent, **I want** the daemon to detect "story already done" before spawning me, **so that** I don't burn 25 tool calls discovering this.

**Acceptance criteria.**
1. New validator added to pipelinev1 Story 1.4's pre-flight framework: `prework-check`.
2. Logic:
   - Run `git log --since=<planStart> --name-only --pretty=format: -- <touchPoints> | sort -u` to collect files touched recently.
   - If any of the story's `touchPoints` were modified since plan-start, capture the recent commits + their changes into a `<recent_work>` block.
3. The `<recent_work>` block is included in DEV's `<project_context>` (via Story B.1 — extends `recentDiffs` with a touchPoints-filtered subset).
4. DEV prompt addition:
   ```
   PRE-FLIGHT:
   If <recent_work> shows recent commits already modified your touch_points, INSPECT
   those changes first. If your AC are already satisfied, emit:
     ---WORK_SUMMARY---
     No changes required — AC already satisfied by <commit-shas>.
     ---END_WORK_SUMMARY---
   and stop. Do not re-implement.
   ```
5. The daemon recognizes the `No changes required` WORK_SUMMARY pattern and routes the story to `COMPLETED_VIA_PREWORK` (new AgentJob status value, parallel to Phase 1.1's other completion modes).

**Technical notes.**
- Reviewer doesn't need to re-validate prework completions — they're trusted because the touchPoints are already covered. Optional: light-touch reviewer that just confirms AC are visible in the recent diffs.

**Dependencies.** B.6, D.1, pipelinev1 1.4, pipelinev1 1.1 (status enum).
**Effort.** `M` (1 day).
**Type.** `std`
**Findings addressed.** F19.
**DoD.** The dino3 e4w0s1 (integration story that produced no code) would now complete in <1 minute and ~$0.05 instead of 22 minutes and $0.30+.

---

# Epic E — Wave-close knowledge compiler

**Goal.** Move compile-knowledge from per-story to per-wave. Single Haiku run per wave with all story diffs together. Eliminates the 47%-of-epic compile bottleneck and the parallel-write race on shared knowledge files.

**Scope.** Remove per-story compile-knowledge step; add wave-close compile job; wave-close compiler prompt; slot-class wiring; legacy fallback removal.

**Out of scope.** Wave-close VISUAL_QA (separate decision per `pipeline-v1-dev-correction.md` Strategy 7).

**Demo.** 8-story wave runs to completion in 8 parallel DEV+REVIEWER cycles; compiler does NOT run during the wave; after wave-close-check (build + server check), one wave-compile job dispatches; produces all knowledge articles in 5 minutes; total wave time drops by ~30%.

**Expected outcome:** -25 to -30 min/epic, -$1.50/epic. Combined with A.1 (Haiku flip), the compile-knowledge step's epic cost drops from ~$1.63 → ~$0.05 (~97% reduction).

---

### Story E.1 — Remove per-story `compile-knowledge` step

**As a** story pipeline, **I want** to skip per-story compile-knowledge, **so that** I terminate sooner and free resources.

**Acceptance criteria.**
1. In `functions/shared/pipelines/story-pipeline.ts`, the `compile-knowledge` step is removed from the per-story pipeline.
2. `compile-diff` and the new `compile-commit-on-pass` (A.3) remain — they collect data the wave-close compiler will consume.
3. `compile-sync` is also moved to wave-close (it depends on compile-knowledge output).
4. Per-story pipeline now ends after `compile-diff`. Story status transitions DONE without further work.
5. Behind a feature flag `WAVE_CLOSE_COMPILER_ENABLED` (env, default `false`) until E.2 ships. With flag off, the old per-story compile flow runs.

**Technical notes.**
- Coordinate with Phase A.6 / B.4 / wave-completion-check.ts logic — wave readiness currently waits for all stories to reach DONE (which includes per-story compile). After this change, wave readiness still waits for DONE, but DONE no longer implies knowledge has compiled.

**Dependencies.** A.3 (per-story commits keep working without compile), A.4 (sync is also relocated).
**Effort.** `S` (≤4 h).
**Type.** `arch`
**Findings addressed.** F7, F11.
**DoD.** With flag off, existing behavior. With flag on, story DONE without compile; no knowledge updates yet (E.2 ships them).

---

### Story E.2 — Wave-close compile job dispatcher

**As a** wave-completion-check cron, **I want** to dispatch a wave-compile job after build+server check pass, **so that** all stories' knowledge compiles atomically.

**Acceptance criteria.**
1. `functions/cron/wave-completion-check.ts` is extended: when all stories in a wave are DONE AND build-check / server-check pass, dispatch a new `WaveCompileJob` to the daemon.
2. New job kind: `wave-compile`. Has its own pipeline (`wave-compile-pipeline.ts`) with steps:
   - `wave-compile-prepare` (shell): collect all stories' diffs + WORK_SUMMARYs into a single context blob.
   - `wave-compile-knowledge` (Haiku agent): produces all knowledge articles.
   - `wave-compile-sync` (shell): post-compile S3 + Memgraph sync (relocated from A.4 per-story location).
3. Wave is marked `KNOWLEDGE_COMPILED` after the wave-compile job succeeds.
4. Wave-compile failures: write `compile-sync-failed` attention item (severity high), do not retry automatically. Operator can re-trigger via UI.

**Technical notes.**
- Build-check / server-check (Phase wave-build per `pipeline-enhancement-phases-a-c-handoff.md`) is the gate. Don't compile knowledge for a broken wave.
- Wave-compile job runs in `BACKGROUND` slot class (pipelinev1 Story 2.5) so it never bumps active dev/review work.

**Dependencies.** E.1, pipelinev1 2.5 (slot classes), A.4 (sync verification logic).
**Effort.** `M` (1 day).
**Type.** `arch`
**Findings addressed.** F7, F11, F22.
**DoD.** Run a 3-story wave. After wave close, exactly one wave-compile job runs. All 3 stories' knowledge articles produced. Wave-compile job uses `BACKGROUND` slot.

---

### Story E.3 — Wave-close compiler prompt: takes all stories' diffs together

**As a** wave-compile agent, **I want** all stories' diffs and WORK_SUMMARYs in my prompt, **so that** I produce coherent knowledge articles in a single pass.

**Acceptance criteria.**
1. Wave-compile prompt template includes:
   - `<project_context>` block (from B.1) — same context other agents see (cache reuse).
   - `<wave_input>` block:
     - List of stories in this wave with: storyId, title, AC, WORK_SUMMARY.
     - Combined `git diff` for the wave (`git diff <wave-start-sha> HEAD` after all per-story commits).
   - Compiler instructions: produce all required knowledge articles in one batched output.
2. Output format: `---WAVE_KNOWLEDGE_OUTPUT---` block with one sub-block per article:
   ```
   ---FILE: knowledge/code/main.js.md---
   <full markdown content>
   ---END_FILE---

   ---FILE: knowledge/code/dino.js.md---
   <full markdown content>
   ---END_FILE---
   ```
3. Daemon parses the block and writes each file atomically (one `fs.writeFile` per file).
4. Index.md update: compiler emits a `---FILE: knowledge/index.md---` block with the full updated index. No per-story index race.

**Technical notes.**
- This is where the parallel-write race (F11: 7 of 8 writes lost) goes away. There's only one writer.
- The compiler's prompt is bigger than per-story (sees ~5–10 stories' content) but Haiku handles it well, and the prompt cache hits across stories within a wave.

**Dependencies.** E.2, B.1.
**Effort.** `M` (1 day).
**Type.** `arch`
**Findings addressed.** F7, F11.
**DoD.** Run a 5-story wave. Wave-compile produces all 5 article updates + a coherent updated `index.md` in ≤5 minutes total wall-time and ≤$0.10 cost.

---

### Story E.4 — Wave-compile job runs in `BACKGROUND` slot class

**As a** SessionPool, **I want** wave-compile to use the background slot, **so that** it does not bump operator-facing dev/review work.

**Acceptance criteria.**
1. The wave-compile job (E.2) is enqueued with `concurrencyClass: 'background'` (per pipelinev1 Story 2.5).
2. SessionPool yields wave-compile slots to interactive/critical jobs when contention occurs.
3. Wave-compile latency target: ≤10 min wall-clock from dispatch under nominal conditions; ≤30 min under contention.

**Technical notes.**
- Trivial wiring once pipelinev1 Epic 2 ships. Just sets the `concurrencyClass` field.

**Dependencies.** E.2, pipelinev1 2.5.
**Effort.** `S` (≤4 h).
**Type.** `std`
**Findings addressed.** F24 (memory pressure: wave-compile no longer competes with dev for memory slots).
**DoD.** Force contention: 5 active dev jobs + 1 wave-compile dispatched. Wave-compile waits or yields; dev jobs progress without OOM.

---

### Story E.5 — Drop `find -newer` fallback in `compile-diff` (full migration)

**As a** post-migration daemon, **I want** to remove the `find -newer .mycelium/last-compile-marker` fallback, **so that** there's only one canonical diff source per story.

**Acceptance criteria.**
1. `compile-diff` step's shell command is simplified to:
   ```bash
   cd <projectDir> && git diff --name-status HEAD~1 HEAD
   ```
2. The `find -newer` fallback is **deleted**.
3. If `git diff` returns empty (which would be a bug now that A.3 commits per story), the step emits a `compile-sync-failed` attention item with payload `{ storyId, reason: 'unexpected-empty-diff' }`.
4. The `.mycelium/last-compile-marker` file is no longer created/touched. Optional cleanup: remove `.mycelium/` from active project repos as part of the migration.

**Technical notes.**
- This story should ship AFTER A.3 (per-story commits) is verified working in production for at least 1 epic. Otherwise removing the fallback could mask bugs.

**Dependencies.** A.3, E.1, E.2 (the wave-compile uses individual story diffs from compile-diff outputs).
**Effort.** `S` (≤4 h).
**Type.** `std`
**Findings addressed.** F23.
**DoD.** Run 5 stories. Each `compile-diff` produces a clean per-story diff. No `find -newer` invocations in process strace. No regressions in wave-compile.

---

## Recommended sequencing

A staged rollout maximizing risk-isolation and incremental value:

```
Sprint 1 (3 days):           Epic A (all 7 stories)
                             [SHIP TO PROD: 44% cost reduction visible]

Sprint 1-2 (parallel):       Epic B (6 stories)         + pipelinev1 1.1, 1.2, 1.3
                             [no prod impact yet — staging only]

Sprint 2 (3 days):           Epic C (5 stories)
                             [SHIP: deterministic verdicts active]

Sprint 3 (4 days):           Epic D (5 stories)         + pipelinev1 1.4
                             [SHIP: parallel-wave correctness + no-op stories detected]

Sprint 3-4 (parallel):       pipelinev1 Epic 2 (Concurrency Manager)
                             [SHIP: background slot class for E.4]

Sprint 4 (3 days):           Epic E (5 stories)
                             [SHIP: wave-close compiler — biggest single saver]
```

**Total: ~3 weeks** sequenced after pipelinev1 Epics 1+2 are at least started. Epic A can ship in week 1 regardless.

For a one-developer team running both this plan and pipelinev1: ~5–6 weeks total combined.

---

## Cross-doc dependency map

| Story here | Depends on (sibling pipelinev1) | Reason |
|-----------|--------------------------------|--------|
| C.2, C.5 | 1.1, 1.2 | NEEDS_ATTENTION state + escalation extractors |
| C.3 | 1.3, 4.2 | Loop detector + time ceilings as defense-in-depth |
| C.5 | 1.10, 3.6, 3.8 | Talk-to-agent flow for `needs-human` cases |
| D.5 | 1.1, 1.4 | New status enum + pre-flight validator framework |
| E.4 | 2.1, 2.5 | SessionPool + concurrency-class declaration |
| (informative) | 5.5 | Same-kind prompt prefix dedupe; complementary to B.2/B.3/B.4 |

| pipelinev1 story | Benefits from (this plan) |
|------------------|---------------------------|
| 1.4 | D.5 adds the `prework-check` validator to the framework |
| 5.5 | B.2/B.3/B.4 establish per-story prefix stability; 5.5 closes the same-kind axis |
| 4.1 | E.4's `BACKGROUND` slot makes wave-compile cost predictable for cost-meter |

---

## Definition of "story ready for development"

Each story above qualifies as ready when:
- ✅ Acceptance criteria are testable
- ✅ Dependencies are explicit (within this plan and to pipelinev1)
- ✅ Technical notes identify file paths and contracts
- ✅ Effort is sized
- ✅ Type is labelled
- ✅ Definition of Done specifies verification

All 28 stories meet this bar. Stories whose pipelinev1 dependency hasn't shipped yet are flagged in the dependency map; those should be deferred to the sprint where the dependency lands, OR split (e.g., C.2 has a "drop the `needs-human` path" reduced version that can ship before pipelinev1 1.1/1.2).

---

## Expected outcome (consolidated)

After all 5 epics ship (vs forensic-baseline 10-story epic at $5.56 / 70 min agent-time / 25 hours wall-clock):

| Metric | Baseline | After Epic A | After A+B+C | After all 5 |
|--------|----------|--------------|-------------|-------------|
| Cost per epic | $5.56 | $3.10 (-44%) | $2.30 (-59%) | **$1.50 (-73%)** |
| Agent-time per epic | 70 min | 55 min (-21%) | 45 min (-36%) | **25 min (-64%)** |
| Wall-clock per epic | ~25 h | ~12 h (-52%) | ~8 h (-68%) | **~3 h (-88%)** |
| Tool calls per story | ~40 | ~25 | ~20 | **~12 (-70%)** |
| Tokens per story | ~250k | ~180k | ~120k | **~60k (-76%)** |
| VISUAL_TESTS retry rate | 50% | ~10% | <5% | **<2%** |
| OOM crashes per epic | 3 | 3 | 3 | **0** (combined w/ pipelinev1 Epic 2) |
| Compile-knowledge cost share | 35% | 5% | 5% | **<2%** (wave-close + Haiku) |
| Compile-knowledge time share | 47% | 47% | 35% | **<10%** |
