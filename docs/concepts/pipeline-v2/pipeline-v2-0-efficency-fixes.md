# Pipeline v2.0 — Efficiency Fixes (bash-first refactor)

| Field               | Value                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**          | Active backlog — pre-Phase-2 work                                                                                                                                             |
| **Version**         | v2 (bash-first refactor of original 2026-04-28 plan)                                                                                                                          |
| **Position**        | Slots between Phase 1 (GitHub MVP, shipped 2026-04-28) and Phase 2 (Pipeline ergonomics)                                                                                      |
| **Inbound docs**    | `docs/concepts/pipelinev1-deferrals.md` (P1.0a, D.3, D.4, D.5, E.2, E.3, P0.1, P2.1, P2.2, P1.9, P0.5)                                                                        |
| **Source incident** | `dino1` (2026-04-28): Story `5ED860A0` looped on a no-op for ~$40 and 50 min before operator abandoned                                                                        |
| **Goal**            | Get the developing-stage pipeline from "wasteful, prone to infinite retry" to "tight, cache-friendly, never spends >$1 on a no-op story" before resuming Phase 2 feature work |

---

## The bash-first principle (read this before reading anything else)

Every prompt token is paid on every spawn. Prompt rules are advisory and probabilistic — the LLM may ignore them, and dino1 logs prove it does (DEV ignored "do not run `ls/find`"; REVIEWER ignored "do not spawn Explore subagents"). Bash and daemon code are deterministic, observable, free.

**Every fix in this plan must answer the question "why can't bash do this?" before adding anything to a prompt.**

The pipeline's job is to **compress what the LLM has to decide**. Agents do the irreducibly creative work — write code, judge ambiguous ACs, reason about architecture. Daemon and shell scripts do everything else: file IO, git, tsc, lint, scope checks, cost rollups, attempt counters, sequencing, S3 mirror, knowledge-index updates, sentinel detection.

**v1 audit of where this principle was violated:**

| Old fix                                                                     | Approach                                                                                          | Verdict                                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0.2 (prework — original)**                                               | Add prompt paragraph asking agent to emit "No changes required" sentinel; daemon detects sentinel | ❌ Bloat. Daemon can detect no-op stories itself before spawning the LLM at all (see §T0.2 below).                                                            |
| **T0.4 (reviewer prompt hardening)**                                        | Add 20-line DISCOVERY/VERIFICATION block to reviewer template                                     | ❌ Bloat. Tool allowlist (`Read,Glob,Grep` only) makes the prompt rules unnecessary. **Killed.**                                                              |
| **T1.5 (wave context pack — original)**                                     | Pre-build a wave-context block, prepend to every sibling DEV's prompt                             | ❌ Bloat. Materialize as a filesystem artifact at `<projectDir>/.context/wave-N.md`; agents that need it Read it (see §T1.5 below).                           |
| **T1.3 (wave-close compiler — original)**                                   | One LLM call per wave instead of N per story                                                      | ⚠️ Partial. Most of compile-knowledge is mechanical (log append, index regen, dep-map). LLM only needed for non-trivial new file articles. (See §T1.3 below.) |
| `dev-subagent-prompt.md.tpl` PROJECT BASELINE paragraph (landed 2026-04-28) | Tell agent "do not run `npm create vite`"                                                         | ❌ Bloat. Daemon detects scaffolding tool_use events and can deny via `disallowedTools` or process-kill. (See §B-series.)                                     |

This v2 of the plan kills the bloat fixes, redesigns the partial-bloat ones, and adds explicit **bash between agents** gates as their own first-class section.

---

## Document map

- [**Tier 0** — bleeding-stop (3 fixes)](#tier-0)
- [**Tier 1** — structural wins (5 fixes)](#tier-1)
- [**B-series** — bash between agents (7 gates) — _new in v2_](#b-series)
- [**Tier 2** — cleanups (5 fixes)](#tier-2)
- [Removed / folded from v1 of the plan](#removed)
- [Operational tunables](#tunables)
- [Landing sequence](#landing-sequence)
- [Cross-references to v1 deferrals](#crossref)
- [Open questions](#open-questions)
- [Out of scope](#out-of-scope)
- [Acceptance criteria](#acceptance)

---

<a id="tier-0"></a>

## Tier 0 — Bleeding-stop fixes

### T0.1 — Treat `COST_HARD` after `---DONE---` as success (✅ shipped in PR-1)

- **AC ref.** v1 deferrals **P1.0a**.
- **Mechanism.** Daemon scans buffered text deltas for `---DONE---` + `---WORK_SUMMARY---` (line-anchored regex, deterministic). On forced termination after both markers, synthesize a finalResult and resolve. **No LLM involvement.**
- **File.** `daemon/agent-daemon.mjs` `runAgent` close handler + `daemon/lib/done-detector.mjs` (extracted helper, 8 unit tests).
- **Status.** Shipped in PR-1 (commit pending).

### T0.3 — Tighter retry budget for story pipelines (✅ shipped in PR-1)

- **AC ref.** dino1 forensic + v1 deferrals **P1.0a**.
- **Mechanism.** Daemon counter check in `handleJobFailure`. Story pipelines (jobs with `pipeline.initialVariables.STORY_ID`) get `MAX_DEV_ATTEMPTS_PER_STORY` (default 2; env-overridable). Final failure → `dev-retry-exhausted` attention category with Salvage as primary action.
- **Mechanism.** Daemon counter, no LLM.
- **Status.** Shipped in PR-1 (commit pending).

### T0.2 — Daemon-side pre-DEV gate (replaces v1 prework-sentinel approach)

- **AC ref.** v1 deferrals **D.5** + dino1 forensic.
- **What changed from v1 of the plan.** v1 said "ask the agent to emit a sentinel". v2 says **detect no-op stories deterministically before spawning the agent at all.**
- **Mechanism.** Daemon-side `prework-gate.mjs` runs in `executePipeline` BEFORE the dev step spawns. Pure bash + JS:
  1. `git log --since=<plan-start-iso> -- <touchPoints>` — recent commits in scope (already exists in `daemon/pipelines/lib/prework-check.mjs::collectRecentTouchPointWork`).
  2. For each AC, derive named exports from the AC text (heuristic: regex for `function <name>` / `const <name>` / `class <name>` patterns; if none derivable, fall through and let the agent run).
  3. `grep -lE "^export (function|const|class) (<name1>|<name2>|...)"` across touchPoint files.
  4. `tsc --noEmit` (or the project's `runCommand`) cached against the working tree's git SHA — only re-run if SHA changed since last gate evaluation.
  5. **Decision matrix:**
     | git log hits | exports present | tsc clean | Outcome |
     |---|---|---|---|
     | ≥1 | all required | yes | `markJobCompletedViaPrework`. Skip DEV. ~$0.02 (DDB writes only). |
     | ≥1 | partial | yes | Spawn DEV with the gate's evidence pre-injected as `<gate_evidence>` filesystem artifact (NOT in prompt). |
     | 0 | n/a | n/a | Spawn DEV normally. |
     | any | any | no | Spawn DEV with `tsc` output pre-injected as the failing baseline. |
- **What does NOT change.** No prompt-paragraph addition. Agents that DO get spawned see the same prompt they see today.
- **File touch points.**
  - `daemon/lib/prework-gate.mjs` (new — wraps the existing `prework-check.mjs` helpers).
  - `daemon/agent-daemon.mjs::executePipeline` — call gate before each step that's `step.id === 'dev'`.
  - `functions/shared/types/agent-job-state-machine.ts` — add `'COMPLETED_VIA_PREWORK'` to `AgentJobStatus`, `TERMINAL_STATUSES`, `SUCCESS_STATUSES`.
- **Smoke.** Pre-scaffolded story → no DEV agent spawn at all. Job row carries `status: COMPLETED_VIA_PREWORK`, `precheckEvidence: { gitShas: [...], exports: [...], tscPassedAt: ISO }`. Total wall-clock ≤ 5 s. Total cost ≤ $0.02.
- **Why this version is right.** The agent's only role in the v1 design was to do something the daemon could already do: read files, check ACs, decide "this is a no-op". Removing the agent removes the only probabilistic step. Cost drops from ~$0.30 (current v1 design with sentinel) → $0.02. Wall-clock drops from ~90s → 5s.

---

<a id="tier-1"></a>

## Tier 1 — Structural wins

### T1.1 — Wire D.4 (scope-violation pre-fill) — _unchanged from v1_

Daemon parses diff against touchPoints, prepends auto-failed AC lines to reviewer's variables. Reviewer doesn't compute the violation. ✅ Bash/code-side.

### T1.2 — Wire D.3 (wave-conflict resolver) — _unchanged from v1_

Pure function at plan-build time. Plan-builder gates wave assignments through `resolveWaves`. Launcher defensively asserts `assertWaveScopeNonOverlapping`. ✅ Bash/code-side.

### T1.3 — Bash-first wave-close compile (redesigned)

- **What changed from v1 of the plan.** v1 said "one LLM call per wave instead of N per story". v2 says **one LLM call per non-trivial new file per wave, plus zero LLM calls for the mechanical 90% of compile-knowledge work.**
- **What's mechanical (do in bash):**
  - **Log append** (`compile-log.sh`): one shell heredoc appending a row to `knowledge/log.md`. Inputs: storyId, status, articleCounts, timestamp.
  - **Index regen** (`compile-index.sh`): regenerate `knowledge/index.md` from `find knowledge/code -name '*.md' | sort` + a markdown template. Idempotent.
  - **Dep-map regen** (`compile-deps.sh`): for each `.ts/.tsx/.mjs` in the wave's diff, extract import statements with `grep -E '^(import|from)'` + assemble into `knowledge/system/dependency-map.md`. Idempotent.
  - **Article stub** (`compile-stub.sh`): for each NEW file in the wave's diff that doesn't yet have a knowledge article, create a stub at `knowledge/code/<path-flat>.md` with frontmatter + Purpose/Exports/Dependencies sections populated from the file's own AST (AST via `tree-sitter` if installed; `grep` patterns otherwise).
- **What's irreducibly LLM (run only when needed):**
  - **Significant rewrites**: a file modified in this wave whose existing knowledge article's `lastMutatedByStory` is older than 3 stories ago AND whose diff exceeds 20 lines. One bounded LLM call per such file.
  - **New non-trivial code**: a new file > 30 lines or > 1 export gets one LLM call to write a substantive article.
- **Pipeline:** `wave-close-compile.mjs` runs the bash steps first, then enumerates the residue (new big files + significantly-rewritten files) and dispatches one bounded LLM job per residue file with a tiny prompt: `Write a knowledge article for <path>. Diff: <patch>. Existing imports: <list>. Format: <frontmatter template>.`
- **Cost projection.** A typical 3-story wave with 4 new small files + 2 modified medium files: 4 stubs (bash) + 2 articles (LLM, ~$0.10 each) = ~$0.20 vs. dino1's per-story compile cost of ~$0.50 × 3 = ~$1.50. **~7× cheaper.**
- **File touch points.**
  - `daemon/scripts/compile-log.sh`, `daemon/scripts/compile-index.sh`, `daemon/scripts/compile-deps.sh`, `daemon/scripts/compile-stub.sh` (new shell scripts).
  - `daemon/pipelines/wave-close-compile.mjs` (new orchestrator that runs bash → enumerates residue → dispatches per-file LLM jobs).
  - `functions/cron/wave-completion-check.ts` — dispatcher (already covered in v1 of plan).
  - `functions/shared/pipelines/wave-compile-pipeline.ts` — exists; gets simplified.

### T1.4 — Per-plan + daily cost ceiling — _unchanged from v1_

Daemon-side cost-meter check in `runAgent`'s step_complete path. ✅ Bash/code-side.

### T1.5 — Wave-context as filesystem artifact (redesigned)

- **What changed from v1 of the plan.** v1 said "prepend a wave-context block to every sibling DEV's prompt". v2 says **write it to disk; agents Read it on demand.**
- **Mechanism.** When the wave's first DEV step starts, the daemon writes:
  - `<projectDir>/.context/wave-N.md` — wave-scoped: project tree (depth 3), package.json deps + scripts only, tsconfig `paths` + `target`, central files imported by ≥3 stories' touchPoints capped at 8.
  - `<projectDir>/.context/wave-N-story-<id>.md` — story-scoped: story spec, the bash gate's evidence (from T0.2), recent commits per touchPoint.
- The dev prompt's **touchPoints list** auto-includes `.context/wave-N.md` and `.context/wave-N-story-<id>.md` as Read-only references. The prompt body itself doesn't grow; the touchPoints list does (by 2 lines).
- An agent that needs orientation Reads the file. An agent that doesn't — most second-and-later DEV agents in a wave — pays nothing.
- **Why this version is right.** Token cost is paid only by agents that actually need the context. The daemon's bash side does the discovery (`find`, `head`, `grep` for cross-imports) once per wave, deterministic and free.
- **File touch points.**
  - `daemon/pipelines/lib/wave-context-fs.mjs` (new — bash-first wave-pack writer).
  - `daemon/pipelines/lib/context-pack-resolver.mjs` — call wave-pack, append paths to touchPoints.
  - **No template changes.** The dev-subagent-prompt template is unmodified.

### T1.6 — Empty-diff compile skip — _unchanged from v1_

Daemon checks DIFF_MANIFEST length, skips compile-knowledge step entirely. ✅ No agent spin-up.

### T1.7 — Daemon-stale banner — _unchanged from v1_

Daemon writes `gitSha` into heartbeat; UI banner when origin/main is ahead. ✅ No agent involved.

---

<a id="b-series"></a>

## B-series — Bash between agents (new in v2)

The pipeline runs DEV → REVIEWER → COMPILER as agent steps. Between each step, the daemon already runs shell utilities (e.g. `compile-diff.sh`). This section formalizes seven additional **bash gates** that compress what the LLM has to decide. None of them grow any prompt.

### B1 — Pre-DEV `tsc --noEmit` baseline

- **Where**: in `executePipeline`, before the DEV step (paired with T0.2 prework gate).
- **What**: run the project's `runCommand` (typically `npm run typecheck` or `tsc --noEmit`) at the working-tree's current state. Record the failures in `<projectDir>/.context/tsc-baseline.txt`.
- **Why**: dino1's E1 finished with a partially-broken scaffold. Knowing the **pre-DEV baseline** of failures lets B2 distinguish "DEV introduced this" from "scaffold already had this".
- **Caching**: keyed on `git rev-parse HEAD`. Re-run only when SHA changes.
- **Cost**: one `tsc` invocation per wave-start (~5–15s, $0).
- **Status**: open. New script `daemon/scripts/tsc-baseline.sh`.

### B2 — Post-DEV `tsc` + `prettier --check` + `eslint` gate

- **Where**: between DEV step and REVIEWER step.
- **What**:
  - Run `tsc --noEmit` on the post-DEV tree.
  - Diff against B1's baseline. New failures → fail.
  - Run `prettier --check` on changed files only.
  - Run `eslint` on changed files only (with project's config).
- **Action on fail**: do NOT spawn REVIEWER. Reroute via `loopTo` to the dev step with `OPERATOR_HINT = "tsc/lint failures introduced by your changes:\n<failing-output>"`.
- **Why**: the reviewer can't add value here — the failure is objective. Save the reviewer's $0.40 and route the DEV agent back with deterministic feedback.
- **Cost saved**: ~$0.40 per cycle on stories that introduce type/lint errors (estimated ~10–15% of stories).
- **Status**: open. New script `daemon/scripts/post-dev-gate.sh`.

### B3 — Post-DEV scope-diff gate (extends T1.1)

- **Where**: between DEV step and REVIEWER step.
- **What**: extends T1.1's scope-violation detector. After DEV, compute:
  - `git diff --name-only <pre-dev-sha> HEAD` → modified files.
  - Files outside `touchPoints` ∪ `forbiddenAreas`-allowed → violation.
  - **Also**: if diff is empty AND AC-named exports are now present in touchPoint files → re-run T0.2's prework gate; if green, mark COMPLETED_VIA_PREWORK retroactively (DEV did the right thing — recognized the AC was already met — and we trust that without spawning REVIEWER).
- **Why**: catches the case where DEV correctly emits `---DONE---: no changes needed` but the prework gate didn't fire pre-spawn (e.g., commit history was the wrong shape). Deterministic retroactive shortcut.
- **Status**: open. Extends `daemon/pipelines/lib/scope-violation-detector.mjs`.

### B4 — Post-REVIEW verdict reconciliation

- **Where**: between REVIEWER step and COMPILER step.
- **What**: parse REVIEW_CRITERIA via the existing `review-criteria-parser.mjs`. Then **cross-check against bash-derived signals**:
  - If reviewer said `pass` but B2's gate said `fail` → daemon overrides verdict to `fail`. Reviewer doesn't get the last word on objective signals.
  - If reviewer said `pass` but B3's scope check shows out-of-scope file modifications → override to `fail` with `scope-touchpoints-N: fail`.
  - If reviewer said `needs-human` for an AC that's actually objectively pass-able (tsc clean, exports present, tests pass) → daemon downgrades to `pass`.
- **Why**: the reviewer is probabilistic. Bash-derived facts are not. When they disagree, bash wins.
- **Status**: open. New module `daemon/pipelines/lib/verdict-reconciliation.mjs`.

### B5 — Pre-COMPILE diff-significance gate

- **Where**: before COMPILER step.
- **What**: stricter version of T1.6. Skip the COMPILE step entirely when:
  - DIFF_MANIFEST is empty.
  - Diff is < N lines AND consists entirely of comments/whitespace (`git diff -U0` output's non-empty non-comment lines == 0).
  - Diff is a single file and matches a "deterministic-pattern" template (e.g., a constant value change → write a templated knowledge entry directly).
- **Cost saved**: ~$0.30 per skip. Estimated 25% of stories qualify (small follow-up tweaks).
- **Status**: open. New script `daemon/scripts/diff-significance.sh`.

### B6 — Bash-first knowledge-graph operations (folds into T1.3)

See T1.3 above. Compile-log/index/dep-map/stub all become shell scripts. Listed here for the registry.

### B7 — Per-wave context as filesystem artifact (folds into T1.5)

See T1.5 above. Listed here for the registry.

### B8 (operator-shutdown enforcement, no LLM) — replaces the prompt-rule "do not run npm create vite"

- **Where**: in `daemon/agent-daemon.mjs::processStreamEvent` when `event.type === 'tool_use'` and `tool === 'Bash'`.
- **What**: deterministic deny-pattern for scaffolding commands the agent must not run:
  ```
  ^\s*npx?\s+create-(react-app|next-app|vite)\b
  ^\s*npm\s+create\s+(vite|next-app)\b
  ^\s*tsc\s+--init\b
  ^\s*git\s+init\b
  ^\s*rm\s+-rf\s+(\.|src|node_modules|package\.json)
  ```
  On match: kill the child process with SIGTERM, write a `tamper-reverted` attention item, mark job `FAILED` with `triggeredBy: 'OPERATOR_ABORT'`. **The PROJECT BASELINE paragraph in `dev-subagent-prompt.md.tpl` becomes deletable** (the rule is now enforced at the process layer; the prompt rule is obsolete).
- **Why**: dino1's PROJECT BASELINE prompt addition was the kind of prose rule the LLM ignores. SIGTERM-on-pattern-match is unbypassable.
- **Status**: open. Pairs with the dev-subagent-prompt cleanup (delete the paragraph once B8 ships).

### Tool-allowlist enforcement (replaces v1 T0.4 + part of v1 T0.5)

This is the cleanest example of bash-first done right. **Per-step tool restrictions** declared in `functions/shared/pipelines/story-pipeline.ts`:

| Step                | `allowedTools`                                                      |
| ------------------- | ------------------------------------------------------------------- |
| `dev`               | `Read,Write,Edit,Glob,Grep,Bash` (Bash gated by B8)                 |
| `review`            | `Read,Glob,Grep` only — **no Bash, no Agent, no Task, no WebFetch** |
| `compile-knowledge` | `Read,Write,Edit,Glob,Grep`                                         |

The Claude CLI enforces — REVIEWER literally cannot spawn Explore subagents because the `Agent` tool isn't available. The 20-line DISCOVERY block in v1's T0.4 is **deleted**. Pipeline config replaces 20 prompt lines paid on every spawn forever.

- **File touch points.** Single edit to `story-pipeline.ts` adding `allowedTools` field per step.
- **Status**: open. ~30 lines of pipeline config.

---

<a id="tier-2"></a>

## Tier 2 — Cleanups

### T2.1 — Promote prompt-cache-stable head (P0.1) — _unchanged_

`prompt = EXIT_SIGNALS_PROMPT_SUFFIX + '\n\n' + body`. Free win.

### T2.2 — Restructure subagent templates for cache-friendliness (P2.1)

Cache-stable preamble first, per-story tail last. **Note:** with v2's bash-first redesign, the templates SHRINK (T0.4 is killed; PROJECT BASELINE paragraph is deletable per B8). Less to cache, but what's cached actually hits.

### T2.3 — Dedupe per-pipeline prompt boilerplate (P2.2) — _unchanged_

Extract shared blocks to `_shared.md.tpl`. Tiny mustache helper.

### T2.4 — Token tracking in legacy executePipeline (P0.5) — _unchanged_

### T2.5 — Inbox row inline action buttons (P0.4) — _unchanged_

---

<a id="removed"></a>

## Removed / folded from v1 of the plan

| v1 fix                                                                                                 | Why removed                                                                             | What replaces it                                                                         |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **T0.4** (reviewer prompt hardening — 20-line DISCOVERY block)                                         | Prompt-bloat. LLM ignores prose rules.                                                  | Tool allowlist (single line in `story-pipeline.ts`). Prompt rules deleted.               |
| **T1.5 original** (wave-context block prepended to every prompt)                                       | Token-bloat. Every sibling DEV pays for context most don't need.                        | T1.5 redesigned: filesystem artifact + touchPoints reference.                            |
| **T0.5 original** (Bash sub-command intercept after-the-fact)                                          | Useless — by the time the daemon sees the tool_use event, the Bash command already ran. | B8 (SIGTERM on pattern match while command is in flight) + `--allowedTools` declaration. |
| **PROJECT BASELINE paragraph in `dev-subagent-prompt.md.tpl`** (landed 2026-04-28 in commit `94cd017`) | Same prompt-bloat anti-pattern. LLM ignores it (dino1 logs prove).                      | B8 deny-pattern. Once B8 ships, delete the paragraph.                                    |

---

<a id="tunables"></a>

## Operational tunables to revisit during this work

| Var                                   | Current default         | Recommended after T0+T1+B-series | Why                                                           |
| ------------------------------------- | ----------------------- | -------------------------------- | ------------------------------------------------------------- |
| `MAX_CONCURRENT_TOTAL`                | 4 (set 2026-04-27)      | 4                                | Per-story worktree (Phase 2) reduces race risk; can keep at 4 |
| `MAX_CONCURRENT_INTERACTIVE_RESERVED` | 1                       | 1                                | Talk-to-agent responsiveness                                  |
| `MAX_DEV_ATTEMPTS_PER_STORY`          | 2 (T0.3 default)        | 2                                | Per T0.3                                                      |
| `WAVE_CLOSE_COMPILER_ENABLED`         | false                   | **true** after T1.3 ships        | Per E.2/E.3                                                   |
| `DEFAULT_PER_PLAN_COST_CEILING_USD`   | (effectively unbounded) | 25                               | Per T1.4                                                      |
| `DEFAULT_PER_DAY_COST_CEILING_USD`    | (effectively unbounded) | 50                               | Per T1.4                                                      |
| `PREWORK_GATE_ENABLED`                | (new)                   | **true**                         | T0.2                                                          |
| `B2_GATE_ENABLED` (post-DEV tsc/lint) | (new)                   | true                             | B2                                                            |
| `B8_DENY_PATTERN_ENABLED`             | (new)                   | true                             | B8                                                            |

---

<a id="landing-sequence"></a>

## Landing sequence (revised for v2)

The order minimizes risk and maximizes immediate operator wins. **PR-1 is already shipped** (T0.1 + T0.3).

| PR          | Scope                                                                                                               | Diff size  | Why this order                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| ✅ **PR-1** | T0.1 + T0.3                                                                                                         | ~150 lines | Stops the bleeding. Already landed.                                                      |
| **PR-2**    | T0.2 daemon-side prework gate                                                                                       | ~250 lines | Eliminates LLM cost for no-op stories entirely. Unblocks safe testing of subsequent PRs. |
| **PR-3**    | Tool allowlist + B8 deny-pattern + delete PROJECT BASELINE paragraph                                                | ~100 lines | Enforces what dino1 prompts couldn't. Reviewer cost drops ~50%.                          |
| **PR-4**    | T1.1 (D.4 scope) + T1.2 (D.3 wave-conflict) + B3 (scope-diff gate)                                                  | ~150 lines | All already-built libs; just wiring.                                                     |
| **PR-5**    | B1 (pre-DEV tsc baseline) + B2 (post-DEV tsc/lint gate) + B4 (verdict reconciliation) + B5 (diff-significance gate) | ~300 lines | Compresses what reviewer + compiler must decide.                                         |
| **PR-6**    | T1.3 (bash-first wave-compile) + T1.6 (empty-diff skip extension)                                                   | ~400 lines | Largest of the bunch but isolated to compile path. Behind `WAVE_CLOSE_COMPILER_ENABLED`. |
| **PR-7**    | T1.4 (per-plan ceiling) + T1.5 (filesystem wave-context) + T1.7 (daemon-stale banner)                               | ~250 lines | Final structural wins.                                                                   |
| **PR-8**    | T2.x (cache-stable templates, dedupe boilerplate, legacy token tracking, inbox actions)                             | ~200 lines | Cleanups, bundled.                                                                       |

After PR-2 lands, you can run `dino2` end-to-end and verify the bleeding has stopped. Subsequent PRs are incremental wins, not blocking issues.

---

<a id="crossref"></a>

## Cross-references — what this plan supersedes vs. inherits from v1 deferrals

| v1 deferral                                      | Status here           | Notes                                             |
| ------------------------------------------------ | --------------------- | ------------------------------------------------- |
| **P0.1** (suffix→prefix)                         | T2.1                  | Same                                              |
| **P0.4** (inbox inline actions)                  | T2.5                  | Same                                              |
| **P0.5** (legacy executePipeline token tracking) | T2.4                  | Same                                              |
| **P0.6** (compactor never starts)                | Out of scope          | Depends on transcript-rewrite (v1 deferrals P1.3) |
| **P1.0a** (empty-diff cascade)                   | **T0.1 + T1.6 + B5**  | Three gates jointly                               |
| **P1.0b** (skipped vs failed surface)            | Folds into B5         | `KNOWLEDGE_COMPILE_SKIPPED` event                 |
| **P1.9** (per-plan + daily cost ceiling)         | T1.4                  | Same                                              |
| **D.3** (wave-conflict resolver wiring)          | T1.2                  | Same                                              |
| **D.4** (scope-violation pre-fill)               | T1.1 + B3             | Daemon does it; reviewer doesn't compute          |
| **D.5** (prework + COMPLETED_VIA_PREWORK)        | **T0.2 (redesigned)** | **No prompt growth.** Daemon-side pre-spawn gate. |
| **E.2 + E.3** (wave-close compiler)              | T1.3 (redesigned)     | Bash-first; LLM only for non-trivial residue      |
| **P2.1** (template cache restructure)            | T2.2                  | Same — even better since templates shrunk         |
| **P2.2** (dedupe boilerplate)                    | T2.3                  | Same                                              |
| **AP-D2** (atomic abandon)                       | Inherits              | Already covered by `canDispatchJob`               |

---

<a id="open-questions"></a>

## Open questions

### X1. Where exactly is the per-spawn `COST_HARD $5/$8` ceiling configured?

The dino1 logs show `[COST WARN] $4.X of $5.00 ceiling` and `[COST HARD] $7.84 hit ceiling; terminating.` These messages do not come from this repo (`grep -rn 'COST HARD' daemon/ functions/` returns nothing). They are from the **Claude Code CLI itself** via an environment variable or config file we set on EC2.

**Action**: SSH to EC2, run `printenv | grep -i claude` and `cat ~/.claude/settings*.json`. Document in this file. T0.1's fix relies on detecting the textual signal in the buffered text — confirmed working in dino1 logs.

### X2. dino1 timing-API 500

Separate API bug. CloudWatch logs needed. Not blocking this plan.

### X3. T0.2 export-detection heuristic

The pre-DEV gate's "extract named exports from AC text" step is heuristic. False-negatives (gate fails to recognize an export, spawns DEV unnecessarily) are cheap. False-positives (gate says "exports present" when AC actually wants different behavior) are dangerous — would skip DEV when work is needed.

**Mitigation**: only mark COMPLETED_VIA_PREWORK when ALL three signals (commits + exports + tsc) are green. Single-signal evidence is too thin. Confirm via dino2 smoke run before raising confidence.

### X4. B2 gate deterministic feedback to DEV

When B2 reroutes via `loopTo`, the dev gets `OPERATOR_HINT` with the tsc output. We need to make sure the dev's prompt template renders OPERATOR_HINT (per v1 deferrals P2.5 — currently nowhere uses it).

**Action**: in PR-3 or PR-5, add `{{OPERATOR_HINT}}` near the top of the dev template (above the per-call body, below the cache-stable head). Empty by default.

---

<a id="out-of-scope"></a>

## Out of scope for this plan

- **Per-story `wip/` worktree isolation** — Phase 2.
- **GitHub Actions OIDC for daemon → AWS** — Phase 2.
- **Compaction (P0.6 / P1.3 / P2.6)** — deeper hole; remains in v1 deferrals.
- **Concept-stage / Review-stage / Party Mode efficiency** — this plan is scoped to the Developing stage.
- **AI-side reviewer redesign** — the reviewer's role shrinks under v2 (B2 + B4 take more of its work) but doesn't disappear; that's deliberate. Replacing the reviewer with bash entirely would lose subjective AC judgment.

---

<a id="acceptance"></a>

## Acceptance criteria for "this plan is shipped"

- [x] PR-1 merged (T0.1 + T0.3).
- [ ] PR-2 through PR-8 merged.
- [ ] `WAVE_CLOSE_COMPILER_ENABLED=true`, `PREWORK_GATE_ENABLED=true`, `B2_GATE_ENABLED=true`, `B8_DENY_PATTERN_ENABLED=true` on production.
- [ ] A re-run of dino1's spec (3 epics × 9 stories against pre-scaffolded code) completes in **<5 minutes wall-clock and <$1.00 total spend**.
  - Of those: ≥7 stories route via `COMPLETED_VIA_PREWORK` (no DEV spawn at all).
  - ≤2 stories spawn DEV; each completes in ≤90 seconds at ≤$0.10.
- [ ] On a "real changes needed" plan, wave 0 cost is within ±10% of pre-plan cost (no regression).
- [ ] No story spawns a DEV agent more than 2 times.
- [ ] Reviewer's `tool_use` log contains zero `Bash`, zero `Agent`/`Task`/`Explore`.
- [ ] Per-wave compile job runs once per wave OR not at all (B5-skipped).
- [ ] Plan dashboard shows live `costSoFar / costCeiling` chip; ceiling fires deterministically at $25.
- [ ] **Net prompt-byte change across all dev/reviewer/compiler templates: negative** (templates shrink under v2 because T0.4, PROJECT BASELINE paragraph, and v1's T1.5 prompt-block are all removed).

---

## Document conventions

- **Status field on each Tier item**: add `Status: open | in-progress | done` inline as PRs land.
- **AC ref**: link to v1 deferral id.
- **Smoke**: the _one_ observable signal that proves the fix works.
- **The bash-first principle**: enforced in code review. Any new fix proposed in this doc must answer "why can't bash do this?" before adding to a prompt.
