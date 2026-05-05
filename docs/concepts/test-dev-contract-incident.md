# Incident — TEST & DEV agents overwrote each other's test files

**When:** brick-breaker plan, 2026-04-23, story "Implement ball physics and
collision detection" (`b8929537-1`), wave 0, mvp rigor.
**Outcome:** story completed in 9m 4s / $0.94, but burned ~2 extra minutes and
a reconciliation round because DEV and TEST diverged on a shared contract.

---

## Timeline (from the Logs tab)

| Time     | Agent       | Action |
|----------|-------------|--------|
| 15:30:57 | test-author | step_start |
| 15:31:04 → 15:32:31 | test-author | 20+ Read / Bash / Glob exploring project |
| 15:33:44 | test-author | **Write `src/physics/index.test.ts`** — uses `destroyedIds` in the return shape |
| 15:33:47 | test-author | runs `npx vitest run src/physics/index.test.ts` — red (expected) |
| 15:34:01 | test-author | emits `---TEST_FILES---\nsrc/physics/index.test.ts\n---END_TEST_FILES---` + step_complete |
| 15:34:02 | dev | step_start |
| 15:34:06 → 15:34:12 | dev | Glob + Read types + constants |
| 15:34:32 | dev | **Write `src/physics/index.ts`** — uses `destroyedBrickIds` internally |
| 15:34:57 | dev | **Write `src/physics/index.test.ts`** — overwrites test author's file with a different naming scheme |
| 15:35:00 | dev | `ls /home/ubuntu/projects/brick-breaker/src/physics/` (noticing something already exists?) |
| 15:35:02 | dev | Read `src/physics/index.test.ts` — sees the TEST agent's version |
| 15:35:14 | dev | text_delta: *"The existing test file uses `destroyedIds` (not `destroyedBrickIds`). I need to update my implementation to match."* |
| 15:35:27 | dev | Edit `src/physics/index.ts` to rename the field |
| 15:35:29 | dev | `npx vitest run src/physics/index.test.ts` — green |

DEV essentially self-corrected by reading the on-disk file after overwriting
it, which worked by luck (its second Write was with the same field naming as
its own impl, and the Read brought TEST's version back into its context).

---

## Root cause

The DEV prompt never received the list of files TEST already authored. From
DEV's point of view, the story description was the only source of truth for
field names, and the description ("list of destroyed brick ids") was
ambiguous enough that DEV reached for a plausible but divergent name.

Three mutually-reinforcing gaps:

1. **No inter-agent handoff.** The pipeline's shared-variable mechanism
   (`{{TEST_FILES}}`, `{{WORK_SUMMARY}}`) was capturing TEST's output but the
   DEV prompt wasn't consuming it.
2. **No soft contract in the story template.** Stories describe behavior
   ("returns updated ball velocity and list of destroyed brick ids") but not
   the exact signature (`{ball, destroyedIds}` vs `{ball, destroyedBrickIds}`).
   This is fine when one agent writes both sides — but we split tests from
   implementation precisely to catch contract drift.
3. **Tamper-check would not have fired on mvp rigor.** Even on production
   rigor, the tamper-check command had a bug — the extracted `{{TEST_FILES}}`
   block still contained its `---TEST_FILES---` fence markers, which would
   have leaked into `git diff` as invalid paths and masked genuine
   violations.

---

## Impact

- **Cost:** roughly 3k extra tokens on DEV's ls/Read/Edit round-trip —
  negligible ($0.01 ballpark) at this scale, but compounds across many
  stories.
- **Latency:** ~90 s lost reconciling vs a clean first-pass.
- **Correctness:** story ended up green because DEV noticed the existing file
  and conformed. **If DEV had overwritten without reading first, the story
  would have shipped with the wrong field name in the public API and the
  next consumer story (e.g. `App.tsx`) would have broken at typecheck time.**
  We were lucky, not safe.
- **Brittleness:** production rigor's tamper-check would have been a
  false-negative (fence markers break the `git diff` invocation), so even
  turning rigor up wouldn't have caught this today.

---

## Fix shipped (commit `aa3135d`)

### 1. DEV prompt now includes the TEST handoff

The `dev` step's prompt gained a **Test contract** section (only rendered
when rigor ≥ mvp):

```
## Test contract (CRITICAL — tests already exist)

The TEST agent has already authored the failing tests for this story.
They are the source of truth for function names, field names, and
signatures.

{{TEST_FILES}}

Rules:
1. Do NOT create, overwrite, or edit any file listed above.
2. Read each test file first before writing your implementation so you
   match the exact exported names and type shapes the tests import.
3. If the story wording contradicts the tests (e.g. story says
   "destroyedBrickIds", test imports "destroyedIds"), follow the test.
4. Tamper-check will auto-revert any edits to test files and fail the
   step. [rendered when tamperOn]
```

File: `functions/shared/pipelines/story-pipeline.ts`.

### 2. Tamper-check robustness

The production-rigor `tamper-check` shell now strips the fence markers and
filters paths by test-file pattern before handing them to `git diff`:

```diff
- echo "{{TEST_FILES}}" | tr '\n' '\0' | xargs -0 -n1
-   | grep -vE '^\s*$'
+ echo "{{TEST_FILES}}" | tr '\n' '\0' | xargs -0 -n1
+   | grep -vE '^\s*$'
+   | grep -vE '^---'
+   | grep -E '\.(test|spec)\.[jt]sx?$|^e2e/|^tests/'
```

If after filtering the file list is empty it exits cleanly with
`__TAMPER_CLEAN__ (no test files extracted)` rather than running `git diff`
against nothing and potentially returning a misleading result.

---

## Residual gaps (not fixed by shipped commit)

- **The story description is still the primary behavioral spec.** If TEST
  writes tests that don't cover an AC, DEV has no ground truth for the
  uncovered surface.
- **TEST has no view of REVIEWER's rubric.** Reviewer might reject on
  grounds TEST didn't test for (e.g. "no mocks", "no React deps") — the
  TEST agent can't pre-bake those assertions.
- **REVIEWER sees neither TEST's file list nor the tamper result.** It
  reviews the diff without knowing which files were meant to be immutable.
- **No explicit module-API contract.** DEV and TEST both have to infer the
  exported symbols from the story prose. First-one-to-write wins.

---

## Suggested improvements (for brainstorming)

None of these are scoped or agreed — they're thinking prompts.

### A. **"Module API stub"** — insert an author step before TEST

Add a tiny step `api-author` (or have the PM emit this at plan time) that
produces a `.d.ts`-style interface header per story:

```ts
// src/physics/index.ts — DECLARATIVE API for this story
export function moveBall(ball: Ball, dt: number): Ball;
export function checkWallCollisions(ball: Ball, canvasW: number, canvasH: number): Ball;
export function checkPaddleCollision(ball: Ball, paddle: Paddle): Ball;
export function checkBrickCollisions(
  ball: Ball,
  bricks: Brick[],
): { ball: Ball; destroyedIds: string[] };
```

Both TEST and DEV consume this stub. Names are frozen before either agent
writes. **Tradeoff:** extra step, extra cost (~$0.05 per story?), but
eliminates the whole class of naming divergence.

### B. **Hand DEV the actual test file content, not just the path**

Today `{{TEST_FILES}}` is a list of paths; DEV has to Read each one. We
could instead inject the file contents directly (capped at ~30 kB total):

```
{{TEST_FILE_CONTENTS}}
```

**Tradeoff:** saves DEV 2–5 tool calls per story + some tokens, but prompt
gets longer. Might be a net win given token cache economics on repeated
invocations across a wave.

### C. **REVIEWER sees the TEST contract too**

Extend the REVIEWER prompt with:

> The TEST agent authored `{{TEST_FILES}}` and they pass. Verify:
> 1. DEV did not edit any listed test file.
> 2. The test coverage matches all needs_browser=false ACs.
> 3. Any uncovered AC → fail with actionable feedback.

Today reviewer checks ACs against behavior but doesn't gate on test
coverage.

### D. **Lift rigor's `tamper-check` to mvp by default**

MVP currently skips tamper-check. But the brick-breaker incident would
have been prevented — or at least reliably surfaced — if tamper-check ran
at mvp too. Cost of running the step is ~1 s of shell. Cost of not
running is the class of bugs described above.

**Tradeoff:** mvp is supposed to be "balanced", not strict. Counter:
tamper-check is close to free; it's only the *red-gate* that takes real
time.

### E. **Fail fast on contract drift**

If DEV writes to a path that's listed in `TEST_FILES`, don't wait for
tamper-check — refuse the Write at tool-call level via an allowlist
injected into the DEV agent's `disallowedTools` / pre-tool hook. This is
hardest to build but has the strongest guarantee.

### F. **Let TEST declare "frozen" and "open" files**

Today every test file is treated as immutable. But sometimes a test needs
a testing helper (e.g. `src/__tests__/fixtures/gameState.ts`) that DEV
also needs to update if the shape changes. TEST could emit two blocks:

```
---TEST_FILES_FROZEN---        // tamper-check enforces immutability
src/physics/index.test.ts
---END_TEST_FILES_FROZEN---

---TEST_FILES_SHARED---        // DEV may edit; tamper doesn't check
src/__tests__/fixtures/gameState.ts
---END_TEST_FILES_SHARED---
```

---

## What I'd do first if it were my call

Option **A** (module-API stub) if you want to eliminate the root cause.
Option **B** (inject test contents into DEV) if you want the minimum-surface
fix that makes the next run smoother without pipeline surgery.

Both are compatible; A + B together is the strong version.

---

# Incident 2 — TEST assumed a type change that would break existing tests

**When:** same brick-breaker plan, 2026-04-23 14:07–14:11, story
"Implement useBrickBreakerGame hook", mvp rigor. This ran **after** the
`aa3135d` prompt fix shipped.

## What the fix did and didn't do

✅ **Working:** at 14:07:05 the DEV agent immediately **read both test files**
before writing any implementation. That's the new behavior my prompt fix
targeted: `{{TEST_FILES}}` injection + "Read each test file first" rule.
Zero overwrites, zero tamper candidates — a clear improvement over
Incident 1.

❌ **New failure mode surfaced:** TEST wrote unit tests that expected a
state value the type system didn't support, because TEST hadn't read the
_existing_ tests that lock the type system down.

## Timeline

| Time     | Agent | Action |
|----------|-------|--------|
| 13:54:51 | TEST | step_start |
| 13:54:59 | TEST | launches `Explore` subagent on project root |
| 13:55:03 → 13:55:47 | TEST | 40+ Read/Bash calls (mostly redundant with the Explore above) |
| 14:05:36 | TEST | Writes `src/hooks/useBrickBreakerGame.test.ts` — references `GameStatus = 'idle'` as an initial state value that doesn't exist in the type today |
| 14:06:33 | TEST | Writes `e2e/game.spec.ts` |
| 14:06:37 | TEST | runs vitest, confirms red state |
| 14:07:00 | TEST | step_complete, emits `TEST_FILES` |
| 14:07:05 | DEV | **Reads both test files immediately** (new prompt rule working ✓) |
| 14:07:11 | DEV | **launches `Explore` subagent — same root TEST just explored** |
| 14:07:13 → 14:07:49 | DEV | 20+ more Read/Bash calls |
| 14:10:03 | DEV | **Edits `src/types/index.ts` to add `idle: 'idle'` to GameStatus** — because that's what the new test expected |
| 14:10:23 | DEV | Writes `src/hooks/useBrickBreakerGame.ts` using the new 'idle' status |
| 14:10:37 | DEV | new hook tests pass (49/49) |
| 14:10:42 | DEV | runs full suite — **failures in `src/types/index.test.ts`** |
| 14:11:18 | DEV | *"Let me check whether these failures are pre-existing or caused by my changes"* |
| 14:11:40 | DEV | realizes existing types test asserts **exactly 4 GameStatus values**; reverts the types change |
| 14:11:45 | DEV | workaround: initial status = `'paused'` instead of `'idle'` |

DEV recovered cleanly. But the recovery took ~90 s of waste (full implementation
→ full test run → diagnosis → revert → workaround) that a better TEST setup
could have prevented upfront.

## Root cause

TEST read the *source* types file (`src/types/index.ts`) and saw the
4-value GameStatus, but it did not read the *test* file that locks it
down (`src/types/index.test.ts`). So when TEST wanted a "not yet started"
state it reached for an invented value (`'idle'`) without realising the
type was frozen.

The Phase C.3 rule I added protects DEV from violating TEST's contract.
It does not protect TEST from violating the *existing project's* contract.

## Secondary observations worth fixing

1. **Double-Explore.** Both agents launched the `Explore` subagent on
   the same project root within 13 minutes. That's two subprocess spawns,
   two sets of reads, duplicated tokens. DEV should consume TEST's
   exploration findings instead of redoing them.
2. **50+ Read/Bash calls per story just to orient.** TEST did 40+, DEV
   did 20+, lots overlapping. Each tool call is a cache-hot but non-zero
   cost. The pattern scales badly: 10 stories × 60 reads = 600 reads per
   plan, much of it redundant.
3. **TEST mocked the entire integration surface.** `vi.mock('./useGameLoop')`,
   `vi.mock('./useKeyboardInput')`, `vi.mock('../physics')` — the unit
   tests verify how the hook calls its dependencies, not what the
   composition actually produces. That's fine for a pure orchestrator,
   but "this hook composes physics + loop + input" is exactly the kind
   of thing where integration bugs hide between the mocks. The e2e tests
   partially compensate but don't run in mvp rigor.
4. **"Workaround" is a smell.** DEV chose `'paused'` as initial because
   it satisfied both the new tests (which check `!== 'playing'`) and
   the existing types test (which enforces 4 values). Semantically
   dishonest — the hook is _not_ paused before you click Start, it's
   _not-yet-started_. Future stories that branch on `status === 'paused'`
   will be confused.

## Additional improvements (continuing from A–F)

### G. **TEST must read existing test files, not just source files**

Add to the TEST prompt:

> Before writing new tests, read **every test file** that touches the
> types, hooks, or modules your new tests depend on. Existing tests are
> load-bearing contracts — do not introduce expectations that contradict
> them.

Simplest possible version: add an explicit enumeration of existing test
files to the TEST prompt at pipeline-build time:

```
## Existing tests in this project (DO NOT break these)
src/types/index.test.ts
src/constants/index.test.ts
src/hooks/useGameLoop.test.ts
src/hooks/useKeyboardInput.test.ts
src/physics/index.test.ts
src/components/HUD.test.tsx
...
```

The pipeline builder can harvest this list via `git ls-files` on
`**/*.test.*` at story-launch time.

### H. **Run the existing test suite before TEST writes new tests**

At step 0 of the TEST step, capture a baseline:

```bash
npm test -- --silent > /tmp/test-baseline.json 2>&1 || true
```

Feed the baseline into the TEST prompt as "these tests pass today;
anything you add must not break them". Then post-TEST, post-DEV,
`test-verify` compares the new suite to the baseline and fails if any
previously-passing test now fails — regardless of whether the new
story's tests pass. Catches the GameStatus regression instantly.

### I. **Dedupe the `Explore` subagent between TEST and DEV**

If TEST ran Explore and captured findings, store the summary in a
pipeline variable (`{{PROJECT_EXPLORATION}}`) and inject it into
DEV's prompt instead of DEV re-running Explore. Saves ~30 s and one
subprocess per story.

Tradeoff: TEST's exploration is scoped to test-authoring concerns
(configs, existing test patterns); DEV cares about source layout.
They overlap but aren't identical. Could inject as hint rather than
replacement: "TEST already explored and reported: ..."

### J. **Budget tool-call cost per step**

Emit a soft warning when an agent exceeds N Read/Bash calls in a
step. We already have the event stream, so the daemon could count
and either:
- Append a nudge to the agent's context ("you've made 45 tool calls;
  consider writing now"), or
- Just log it as a metric and show in the Logs tab so operators
  can spot runaway exploration patterns.

Not fixing behavior, just making it visible.

### K. **When the story composes N modules, forbid mocking those N modules**

Opinionated prompt rule for TEST:

> If the story description contains the word "composes" or lists
> specific dependencies (e.g. "uses useGameLoop + useKeyboardInput +
> physics"), you may NOT `vi.mock()` those dependencies. Use the real
> implementations. If that makes the test hard to drive deterministically,
> consider testing at the e2e level instead.

Forces integration tests where they're actually valuable and stops
the "mock everything, assert mocks were called" antipattern.

---

## Updated first-move recommendation

Given Incident 2, my revised priority ordering for brainstorm:

1. **G** (TEST reads existing test files) — cheapest, highest signal.
2. **H** (baseline test suite) — safety net that catches any regression
   across incidents, not just TEST drift.
3. **A** (module-API stub) — still the structural fix for contract drift.
4. **B** (inject test contents into DEV) — already half-done by the
   Phase C.3 prompt rule; formalise it.
5. **K** (no mocking for composition stories) — fixes test quality.
6. **I** (dedupe Explore) — pure cost optimisation; low priority but
   cumulative wins.
7. **D, E, F, C, J** — nice to have.
