# Tier 1 — Test Infrastructure Implementation Plan

> Target: Labs story pipeline
> Goal: move from "DEV declares done" → "tests prove done, and DEV couldn't have faked it"
> Estimated effort: 1–2 days of focused work

---

## 1. The revised story pipeline

**Current** (6 steps):

```
dev → review → retry → compile-diff → compile-knowledge → compile-sync
```

**Tier 1** (10 steps — 4 new + 1 new agent):

```
1.  test-author         agent   TEST writes tests from story.criteria[]
2.  test-gate-red       shell   run tests, EXPECT FAIL (confirm red baseline)
3.  dev                 agent   DEV implements; tests/ locked by tool allowlist
4.  test-verify         shell   run tests, EXPECT PASS
5.  tamper-check        shell   verify test files unchanged since step 2
6.  review              agent   REVIEWER (now also checks AC-coverage)
7.  retry               agent   DEV loops if review failed → re-run 4 + 5
8.  compile-diff        shell   (unchanged)
9.  compile-knowledge   agent   (unchanged)
10. compile-sync        shell   (unchanged)
```

---

## 2. The TEST agent

| Field | Value |
|---|---|
| Model | Haiku (translation, not reasoning) |
| Tools | `Read, Glob, Grep, Edit(tests/**), Write(tests/**)` |
| Input | `story.title`, `story.description`, `story.criteria[]`, project test conventions |
| Output | One or more files under `tests/` matching project conventions |

**Prompt directive** (core):

> Write tests that FAIL against the current codebase. Do not implement the feature. Do not modify any source files. Cover every acceptance criterion. If a criterion has `needsBrowser: true`, write a Playwright test. Otherwise write a Vitest unit or integration test. Use descriptive test names that reference the AC by ID.

TEST cannot touch source files — the allowlist forbids it.

---

## 3. Tool allowlist hardening

Claude Code `claude -p` supports path-scoped permissions. Pass them via `--allowedTools` / `--disallowedTools` or declare in `.claude/settings.json`. **Verify exact flag casing against the Claude Code docs before shipping** — conceptually the syntax is stable but the flag names get tweaked.

**DEV allowlist** (the most important one):

```
--allowedTools
  "Read"
  "Glob"
  "Grep"
  "Edit(src/**)"
  "Write(src/**)"
  "Bash(npm run build:*)"
  "Bash(npm run dev:*)"
  "Bash(tsc:*)"

--disallowedTools
  "Edit(tests/**)"
  "Write(tests/**)"
  "Edit(**/*.test.ts)"
  "Write(**/*.test.ts)"
  "Edit(**/*.spec.ts)"
  "Write(**/*.spec.ts)"
  "Bash(sed:*)"
  "Bash(rm:*)"
  "Bash(mv:*)"
```

**TEST allowlist**:

```
--allowedTools
  "Read"
  "Glob"
  "Grep"
  "Edit(tests/**)"
  "Write(tests/**)"
  "Bash(npm test:*)"
  "Bash(tsc:*)"
```

**REVIEWER allowlist** (already read-only in spirit, tighten explicitly):

```
--allowedTools "Read" "Glob" "Grep"
--disallowedTools "Edit" "Write" "Bash"
```

The allowlist is the primary defense. Tamper-check is the backup for any path that slips through (creative bash, symlinks, etc.).

---

## 4. Red-green gates

Both are deterministic shell steps. Zero cost, fast (<10s for a small test suite).

**`test-gate-red`** — fails if tests are accidentally green before DEV runs:

```bash
# Snapshot current test files for the tamper-check
find tests -type f \( -name "*.test.ts" -o -name "*.spec.ts" \) | sort \
  > /tmp/test-files-before.txt

find tests -type f \( -name "*.test.ts" -o -name "*.spec.ts" \) \
  -exec git hash-object {} \; > /tmp/test-hashes-before.txt

# Now confirm red state
if npm run test -- --run tests/ ; then
  echo "ERROR: tests passed before DEV ran."
  echo "Either TEST agent wrote empty assertions, or the story is already implemented."
  exit 1
else
  echo "OK: tests are red, proceeding to DEV."
  exit 0
fi
```

**`test-verify`** — fails if tests don't pass after DEV:

```bash
npm run test -- --run tests/ || {
  echo "ERROR: tests still failing after DEV."
  exit 1
}
```

The red-state check is non-negotiable. Without it, `expect(true).toBe(true)` passes the whole pipeline.

---

## 5. Tamper-check (the TEST file integrity gate)

Compare hashes snapped during `test-gate-red` against hashes now:

```bash
# File list — catches adds/removes
find tests -type f \( -name "*.test.ts" -o -name "*.spec.ts" \) | sort \
  > /tmp/test-files-after.txt

if ! diff -q /tmp/test-files-before.txt /tmp/test-files-after.txt > /dev/null; then
  echo "ERROR: test files were added or removed during DEV."
  diff /tmp/test-files-before.txt /tmp/test-files-after.txt
  exit 1
fi

# Content hashes — catches modifications
find tests -type f \( -name "*.test.ts" -o -name "*.spec.ts" \) \
  -exec git hash-object {} \; > /tmp/test-hashes-after.txt

if ! diff -q /tmp/test-hashes-before.txt /tmp/test-hashes-after.txt > /dev/null; then
  echo "ERROR: test file contents were modified during DEV."
  diff /tmp/test-hashes-before.txt /tmp/test-hashes-after.txt
  exit 1
fi

echo "OK: all test files unchanged."
```

`git hash-object` is git's internal content-addressable hash. Same bytes → same hash, always. No commits needed.

---

## 6. REVIEWER updates

REVIEWER's prompt gains one new mandatory check:

> For each criterion in `story.criteria[]`, verify that at least one test file in `tests/` asserts against that criterion. If any AC lacks a covering test, FAIL with reason `missing_test_coverage` and list the uncovered ACs.

This prevents the failure mode where TEST agent skipped an AC and the rest of the pipeline never noticed.

---

## 7. Failure handling & retry cycles

Every gate in §4–§6 can fail. The pipeline doesn't just stop on red — it loops, escalates, or blocks based on *which* gate failed. This section defines the cycles.

### 7.1 Retry budgets

Sensible defaults, configurable per rigor tier:

| Gate | MVP | Production | On exhaustion |
|---|---|---|---|
| TEST authoring (loop on red-gate green) | 2 retries | 3 retries | story → `blocked` (`test_authoring_weak`) |
| DEV implementation (loop on test-verify fail) | 3 retries | 5 retries | story → `failed` (`implementation_incomplete`) |
| Tamper-check | 1 auto-revert + warn | 1 auto-revert + warn | story → `blocked` (`test_tampering`) |
| DEV review (loop on review fail) | 3 retries | 5 retries | story → `failed` (`review_rejected`) |

Each retry counts independently per gate — a story can burn 3 test-verify retries *and* 3 review retries before exhaustion.

### 7.2 Cycle A — TEST authoring loop (steps 1 ↔ 2)

```
test-author → test-gate-red
                  │
                  ├─ red (FAIL expected) ─────▶ proceed to DEV
                  │
                  └─ green (tests passed pre-implementation)
                       │
                       ├─ iteration < budget
                       │    → loop back to test-author
                       │    → feedback: "your tests pass against the current
                       │      codebase, meaning they don't actually test the
                       │      AC. Strengthen assertions or add missing cases."
                       │
                       └─ iteration >= budget
                            → story.status = blocked
                            → blocker.reason = test_authoring_weak
                            → operator review (see 7.6)
```

Accidental green has two root causes: weak tests (TEST agent's fault) or already-implemented feature (PM's fault — redundant story). The loop handles the former; exhaustion surfaces the latter for human judgment.

### 7.3 Cycle B — DEV implementation loop (steps 3 → 4 → 5)

```
dev → test-verify
         │
         ├─ pass ─▶ tamper-check
         │            │
         │            ├─ clean ─▶ proceed to review
         │            │
         │            └─ tests modified
         │                 ├─ first offense this story
         │                 │    → auto-revert tests from pre-DEV snapshot
         │                 │    → loop back to DEV with hard warning:
         │                 │      "tests were reverted; do not modify
         │                 │       anything under tests/; your tools are
         │                 │       restricted and further attempts will
         │                 │       block this story."
         │                 │
         │                 └─ second offense
         │                      → story.status = blocked
         │                      → blocker.reason = test_tampering
         │                      → operator review required
         │
         └─ fail (tests still red)
              │
              ├─ iteration < budget
              │    → loop back to DEV
              │    → DEV receives: failing test output, previous diff
              │
              └─ iteration >= budget
                   → story.status = failed
                   → failure.reason = implementation_incomplete
```

The tamper-check two-strike rule accommodates accidental tampering (a formatter, a rogue `mv`) while still blocking deliberate gaming. If the allowlist in §3 is correctly configured, tamper-check should almost never fire — when it does, it's a red flag worth operator attention.

### 7.4 Cycle C — REVIEW loop (steps 6 → 7 → 4 → 5 → 6)

```
review
   │
   ├─ pass ─▶ compile-diff
   │
   └─ fail
        │
        ├─ iteration < budget
        │    → retry step: DEV re-implements with REVIEWER feedback
        │    → test-verify MUST still pass (re-run)
        │    → tamper-check MUST still be clean (re-run)
        │    → review re-runs
        │
        └─ iteration >= budget
             → story.status = failed
             → failure.reason = review_rejected
             → failure.details = REVIEWER's final feedback
```

Critical invariant: on review retry, tests and tamper-check re-run. DEV can't "fix the review issue" by breaking tests or touching test files. The gates compound.

### 7.5 What the retrying agent receives

Retry budgets are useless if the agent doesn't get enough context to actually correct course. Each retry prompt must include:

**DEV on test-verify retry**:
- Full stdout/stderr of the failing test run
- Names of specific failing tests + assertion diffs
- DEV's own previous diff (`git diff HEAD`)
- Explicit directive: "do not modify anything under tests/"

**DEV on tamper-check retry (first offense only)**:
- List of tampered files
- Confirmation that tests have been reverted to their pre-DEV state
- Hard warning about the allowlist
- Previous diff

**DEV on review retry**:
- Full REVIEWER feedback text
- Specific rejection reasons (structured if REVIEWER emits them)
- Confirmation tests are still green
- Previous diff

**TEST on red-gate-green retry**:
- Which tests passed unexpectedly
- The story ACs (re-stated)
- Directive to strengthen assertions or add missing cases

### 7.6 Story state transitions

| Gate outcome | `story.status` becomes |
|---|---|
| test-gate-red: red (expected) | `running` (unchanged) |
| test-gate-red: green, retry available | `running` |
| test-gate-red: green, exhausted | `blocked` |
| test-verify: pass, tamper clean | `running` → proceeds |
| test-verify: fail, retry available | `fixing` |
| test-verify: fail, exhausted | `failed` |
| tamper-check: modified, 1st offense | `fixing` (with warning flag) |
| tamper-check: modified, 2nd offense | `blocked` |
| review: pass | `in_review` → `done` |
| review: fail, retry available | `fixing` |
| review: fail, exhausted | `failed` |

### 7.7 Wave-level implications of a stuck story

A single `failed` or `blocked` story has ripple effects:

- **Sibling stories in the same wave**: continue running to completion (independent work)
- **Wave-build-check**: runs anyway — may itself fail due to missing piece, that's fine, it's diagnostic
- **Next story-wave in the epic**: does NOT auto-launch if any next-wave story has this one in `dependsOn`
- **Epic status**: flips to `fixing` as soon as any story is `blocked` or `failed`
- **Plan status**: flips to `fixing` (existing plan-reducer logic already handles this)

### 7.8 Operator recovery paths

When a story lands in `blocked` or `failed`, the resolve-blocker drawer (existing — §7.5 of the main labs doc) offers:

- **Amend Story** — edit AC/description/complexity, re-run the pipeline from step 1 (fresh TEST authoring)
- **Retry** — re-run from step 1 as-is (for transient issues or post-tweak reattempts)
- **Bump Model** — upgrade DEV from Haiku → Sonnet or Sonnet → Opus, retry. Useful for `review_rejected` and `implementation_incomplete`.
- **Skip** — mark `skipped`, continue wave. Explicit override, logged.

Recommended surface by failure reason:

| `blocker.reason` / `failure.reason` | Default surface |
|---|---|
| `test_authoring_weak` | Amend Story (probably AC unclear) |
| `implementation_incomplete` | Bump Model, then Retry |
| `test_tampering` | Retry (DEV got rattled; fresh attempt often works) |
| `review_rejected` | Bump Model or Amend Story depending on REVIEWER feedback |

### 7.9 Known edge cases — deferred to Tier 2

Documented here so they don't get lost:

- **Flaky tests** — a test that passes 80% of the time. Tier 1 treats any single red as failure. Tier 2: retry a red test-verify N times before counting it.
- **DEV legitimately needs new tests** — e.g., discovers an edge case while implementing. Tier 1 blocks DEV from `tests/` entirely. Tier 2: DEV can emit a `test_request` signal → TEST agent adds tests → DEV continues. The test files remain TEST-owned.
- **Test infrastructure failure vs logic failure** — e.g., `npm test` crashes because node_modules broke. Tier 1 counts as test-verify fail. Tier 2: detect infrastructure errors and retry without consuming budget.

---

## 8. Test type matrix — Tier 1

| Level | Tests | Runner | Cost | Speed |
|---|---|---|---|---|
| **Story** | Unit tests (one per AC) + type-check | Vitest + `tsc --noEmit` | $0 | <10s |
| **Wave** | Build + dev-server smoke (existing) | `npm run build` | $0 | 30–60s |
| **Epic** | — deferred to Tier 2 | — | — | — |
| **Plan** | Plan-build-check (existing) | `npm run build` | $0 | 60s |

Tier 1 concentrates firepower at the story level — that's where agents iterate and game. Wave and plan levels keep what they already do.

Browser tests (`needsBrowser: true` ACs) run via Playwright at the story level, driven by TEST agent.

---

## 9. Rigor dial — prototype / MVP / production

New field on Plan:

```typescript
interface Plan {
  // ...existing fields...
  rigor: 'prototype' | 'mvp' | 'production'  // default: 'mvp'
}
```

The story-pipeline builder reads `plan.rigor` and conditionally includes steps. One code path, three behaviors.

### `prototype`
- Pipeline: `dev → compile-diff → compile-knowledge → compile-sync`
- **No** TEST agent, **no** test gates, **no** tamper-check
- REVIEWER runs advisory-only (never blocks)
- Wave-build-check runs (compile errors only)
- Deploy target: `preview.futurator.ai/<name>/`
- **When to use**: exploring whether an idea is worth building. Maximum speed, zero safety.

### `mvp` (default)
- Full Tier 1 pipeline (all 10 steps)
- TEST agent + tool allowlists + red-green gates + tamper-check
- REVIEWER blocking
- Wave-build-check + plan-build-check
- Deploy target: `staging.futurator.ai/<name>/`
- **When to use**: real external users (even just you, long-term). Default for anything you'd show someone.

### `production`
- Everything in MVP, plus all Tier 2 pieces (see §11)
- Deploy requires explicit manual sign-off after staging
- Target: `futurator.ai/apps/<name>/`
- **When to use**: real stakes — money, reputation, user data, uptime commitments.

### Parameterization pattern

The pipeline builder becomes something like:

```typescript
function buildStoryPipeline(story: Story, plan: Plan): Step[] {
  const steps: Step[] = [];

  if (plan.rigor !== 'prototype') {
    steps.push(testAuthorStep(story));
    steps.push(testGateRedStep());
  }

  steps.push(devStep(story, plan.rigor));

  if (plan.rigor !== 'prototype') {
    steps.push(testVerifyStep());
    steps.push(tamperCheckStep());
  }

  steps.push(reviewStep(story, plan.rigor));  // advisory vs blocking
  steps.push(retryStep(story));
  steps.push(compileDiffStep());
  steps.push(compileKnowledgeStep());
  steps.push(compileSyncStep());

  return steps;
}
```

PM agent is told about `plan.rigor` at generation time and tailors story complexity accordingly (a `prototype` plan can have looser ACs; a `production` plan must have testable ACs).

---

## 10. Implementation sequence

**Day 1 — morning**
1. Add `plan.rigor` field: type definition, DDB migration (default `mvp` for existing plans), API validation, UI selector on plan creation
2. Define TEST agent in the agent registry (model, tools, prompt) matching how DEV/REVIEWER/COMPILER are defined today
3. Update DEV and REVIEWER tool allowlists with the restrictions from §3

**Day 1 — afternoon**
4. Add step definitions: `test-author`, `test-gate-red`, `test-verify`, `tamper-check`
5. Update the story-pipeline builder to branch on `plan.rigor`
6. Update REVIEWER prompt with the AC-coverage check

**Day 2 — morning**
7. Update retry-loop logic so `test-verify` + `tamper-check` re-run after each DEV retry (should be natural if step ordering is correct, verify)
8. End-to-end test on a fresh 3-story plan at `mvp` rigor
9. End-to-end test on a fresh plan at `prototype` rigor (confirm steps are skipped)

**Day 2 — afternoon**
10. Update the UI step visualization to render the new step names and statuses
11. Update the log viewer to surface test-gate failures with the clear error messages from §4 and §5
12. Write one adversarial test: manually prompt DEV "also edit the test to make it easier" and confirm the pipeline catches it at tamper-check

---

## 11. Tier 2 preview

Once Tier 1 is stable, these layer on incrementally:

- **Expanded REVIEWER** — architectural checks: duplication detection, file structure adherence from `AGENTS.md`, abstraction-level appropriateness
- **ARCHITECT agent** — Opus, runs at epic boundary, reads the whole epic diff, flags structural issues the story-level REVIEWER can't see
- **Wave-level integration tests** — tests covering story-to-story interactions within a wave (auto-generated by TEST agent at wave-build time)
- **Epic-level E2E tests** — Playwright scenarios for the epic's complete user flow
- **Property-based tests** — for stories with `complexity: 'architectural'` or algorithmic work (fast-check / jsverify)
- **Mutation testing** — Stryker runs at epic completion, catches tests that look thorough but don't actually assert
- **Accessibility checks** — axe-core integrated into Playwright tests
- **Visual regression** — deterministic pixel-diff baselines (distinct from the existing agentic Visual QA)
- **Performance budgets** — bundle size limits, first-paint thresholds, Lighthouse CI
- **Security audit** — `npm audit` gate before publish, CVE severity threshold configurable per rigor tier
- **Contract tests** — for plans exposing APIs or integrating with external services

Estimated effort for Tier 2: ~1 week, spread incrementally over multiple plans as the need for each piece surfaces.

---

## Appendix — failure modes Tier 1 closes vs. leaves open

### Closed by Tier 1
- DEV modifies tests to make them pass — blocked by allowlist + caught by tamper-check
- DEV deletes failing tests — caught by file-list diff
- DEV writes `expect(true).toBe(true)` — blocked because TEST writes tests, not DEV
- TEST writes accidentally-green tests — caught by `test-gate-red`
- TEST skips an AC — caught by expanded REVIEWER AC-coverage check
- DEV writes code that compiles but violates types — caught by `tsc --noEmit` in test-verify

### Still open — addressed in Tier 2
- DEV writes code that passes tests but duplicates an existing module (→ expanded REVIEWER)
- DEV writes tests that pass but assert weakly on the AC (→ mutation testing)
- DEV implements something that works in isolation but breaks when combined with sibling stories (→ wave-level integration tests)
- Story "works" but the UX is broken (→ already covered by existing Visual QA; tighten at production rigor)
- App technically works but is slow / bloated / inaccessible (→ performance + a11y budgets)
