# Baseline-diff regression gate — design

| Field            | Value                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authored**     | 2026-05-05                                                                                                                                                                                                                                            |
| **Owner**        | Pipeline v2 Phase 2-A (Story 2-A-4-1)                                                                                                                                                                                                                 |
| **Status**       | Design — implementation deferred to PR-35 / PR-36 / PR-37                                                                                                                                                                                             |
| **Source**       | `docs/concepts/pipeline-v2/futurator-pipeline-v2-5-consolidated.md` §14 (Baseline-diff regression gate)                                                                                                                                               |
| **Scope**        | A two-phase shell-based gate that captures the set of passing tests at wave start and refuses to ship a story that breaks any of them. Net-new — Phase 1's PR-2 covers the **pre-DEV** TEST-must-have-run gate; this is the post-DEV regression gate. |
| **Out of scope** | The agent-driven baseline-diff REVIEWER step (Phase 3-E.10 — REFLECTOR-REVIEWER may use baseline data as input). This doc covers only the deterministic shell gate.                                                                                   |

---

## 1. Why

Brick-breaker incident 2 (per v2.5 §14): DEV broke a `GameStatus` test by
widening the type from `'idle' | 'playing' | 'paused' | 'over'` to include a
fifth value. The widening compiled, the new test passed, but a previously-
passing test that pattern-matched all four old values silently regressed. The
story shipped; the regression surfaced two stories later as a runtime crash.

Phase 1 PR-2 closed the pre-DEV side: TEST must run first; the daemon refuses
to spawn DEV until `test-author` has produced a red baseline. That catches
"DEV started without a test contract" but does nothing about "DEV's
implementation regressed something else."

Baseline-diff is the post-DEV side. Capture every test that passes against
the wave's starting commit; refuse to ship a story whose end state has fewer
passes. The gate is purely deterministic — no LLM involved — and the
mechanism is small enough to fit into starter-pack shell scripts plus daemon
glue.

Brick-breaker scope: catches regressions where DEV's implementation breaks
something the new test contract doesn't cover. Doesn't catch tautological
tests (covered by `test-gate-red`) or test tampering (covered by
`tamper-check`, Story 2-A-5-1).

## 2. Where it sits in the 11-step pipeline

```
 1. git-init-story         shell    (Story 2-B-1-1)
 2. api-author             agent    (Story 2-A-3-1, mvp+ only)
 3. test-author            agent    existing
 4. test-gate-red          shell    existing (production rigor only)
 5. dev                    agent    existing
 6. test-verify            shell    existing
 7. tamper-check           shell    (Story 2-A-5-1, mvp+ warn / production block)
 8. baseline-regression    shell    ◄── this design
 9. review                 agent    existing
10. retry                  agent    existing
11. compile-knowledge      agent    existing
```

`baseline-regression` runs **after** `test-verify` and `tamper-check` and
**before** `review`. Rationale:

- After `test-verify` because we need DEV's edits applied to the worktree and
  the new tests passing.
- After `tamper-check` because regressions caused by reverted tampering would
  be misleading (the agent-revert path resets test files; the comparison
  would then be against the post-revert state).
- Before `review` because a regression is a deterministic block — REVIEWER
  shouldn't waste a turn opining on code the gate has already rejected.

A wave-level baseline capture runs **once per wave** at wave start (before
the wave's first story's `test-author` step). Per-story regression checks
read this snapshot.

## 3. The two scripts (per v2.5 §14)

Both ship in `template-nextjs/scripts/` (Story 2-A-4-2). Stub boilerplates
(SST, Vite, Mobile) declare them as null in the registry until those
template repos get content.

### 3.1 `capture-test-baseline.sh` — wave start

```bash
#!/usr/bin/env bash
set -e
cd "${PROJECT_DIR:?PROJECT_DIR required}"
mkdir -p .pipeline
npm test --silent --reporter=json > .pipeline/baseline.json 2>&1 || true
jq -r '.testResults[].assertionResults[]
       | select(.status=="passed") | .fullName' \
  .pipeline/baseline.json | sort > .pipeline/baseline-passing.txt
echo "captured $(wc -l < .pipeline/baseline-passing.txt) passing tests"
```

**Output contract:**

- `.pipeline/baseline.json` — raw vitest JSON output. Useful for forensic
  inspection; not consumed by the gate.
- `.pipeline/baseline-passing.txt` — sorted, one full test name per line.
  This is the canonical baseline.

**Failure modes:**

- Test runner crashes / returns malformed JSON → `baseline-passing.txt` is
  empty. The gate treats empty baseline as "no regressions possible" and
  warns rather than fails (see §6).
- `jq` not installed → script fails. Boilerplate-sync (v2.5 §13.2) must
  ensure jq is present; mvp+ rigor's CI workflow installs it explicitly.

### 3.2 `check-regressions.sh` — post-DEV per story

```bash
#!/usr/bin/env bash
set -e
cd "${PROJECT_DIR:?PROJECT_DIR required}"
mkdir -p .pipeline
if [ ! -s .pipeline/baseline-passing.txt ]; then
  echo "BASELINE_EMPTY: skip regression check"
  exit 0
fi

npm test --silent --reporter=json > .pipeline/after.json 2>&1 || true
jq -r '.testResults[].assertionResults[]
       | select(.status=="passed") | .fullName' \
  .pipeline/after.json | sort > .pipeline/after-passing.txt

regressions=$(comm -23 .pipeline/baseline-passing.txt .pipeline/after-passing.txt)
if [ -n "$regressions" ]; then
  echo "BASELINE_REGRESSION_DETECTED"
  echo "$regressions" | head -5
  count=$(echo "$regressions" | wc -l | tr -d ' ')
  echo "REGRESSION_COUNT=$count"

  case "${RIGOR:-mvp}" in
    prototype)
      echo "WARNING — proceeding under prototype rigor"
      exit 0
      ;;
    mvp|production)
      exit 1
      ;;
  esac
fi
echo "BASELINE_OK"
```

**Output contract:**

- `.pipeline/after.json` — raw runner output for this story.
- `.pipeline/after-passing.txt` — sorted, one passing test per line.
- Stdout marker lines: `BASELINE_OK`, `BASELINE_REGRESSION_DETECTED`,
  `REGRESSION_COUNT=<n>`, `BASELINE_EMPTY`. Daemon parses these.

**Failure modes:**

- `comm` reports non-empty regressions and `RIGOR=mvp|production` → exit 1
  → daemon emits attention.
- Empty baseline → skip + warn (`BASELINE_EMPTY` marker).
- Test runner crash → `after-passing.txt` empty → every previously-passing
  test now appears as a regression → daemon should detect this case
  specifically (see §6.3).

## 4. Daemon integration (PR-36)

### 4.1 Wave-start hook

The wave-completion-check cron (or equivalent wave-start daemon hook —
exact location TBD as part of PR-36) invokes `capture-test-baseline.sh`
once per wave, before the first story's `test-author` step. Idempotent:
re-running overwrites `.pipeline/baseline-passing.txt`.

```ts
// pseudo-code
async function onWaveStart(wave: WaveContext) {
  if (!wave.boilerplate.baselineCapture) return; // stub boilerplate
  const result = await runShell({
    cwd: wave.projectDir,
    cmd: wave.boilerplate.baselineCapture.scriptPath,
    env: { PROJECT_DIR: wave.projectDir },
    timeoutMs: 180_000,
  });
  if (result.exitCode !== 0) {
    log.warn(`baseline-capture failed for wave ${wave.id}: ${result.stderr}`);
    // Don't block — empty baseline = no regressions possible
  }
}
```

### 4.2 Per-story post-DEV hook

Inserted as a new pipeline step `baseline-regression` between `tamper-check`
and `review` in `story-pipeline.ts` (mvp+ only — prototype skips).

```ts
// pseudo-code shape — actual implementation lives in story-pipeline.ts
{
  id: 'baseline-regression',
  stepType: 'shell' as const,
  command:
    `cd ${workingDir} && PROJECT_DIR=${workingDir} RIGOR=${rigor} ` +
    `bash scripts/check-regressions.sh`,
  timeout: 240000,
  captureAs: 'BASELINE_OUTPUT',
  expectExitCode: 0,
  onFail: { action: 'fail' as const, injectAs: 'BASELINE_ERROR' },
}
```

When the step fails (`exitCode !== 0`), the daemon parses `BASELINE_OUTPUT`
for the regression list and emits `attention.baseline-regression`:

```ts
{
  planId,
  dedupKey: `baseline-regression:${storyId}`,
  severity: rigor === 'production' ? 'high' : 'medium',
  category: 'baseline-regression',
  title: `Story ${storyId}: baseline-diff regressed ${count} test(s)`,
  body: `${topFiveRegressions.map(t => `- ${t}`).join('\n')}\n\n` +
        `Run \`npm test\` locally and compare against the wave's ` +
        `baseline (.pipeline/baseline-passing.txt) for the full list.`,
  context: {
    storyId,
    waveId,
    regressionCount: count,
    rigor,
  },
  suggestedActions: [
    { label: 'Apply futurator:accept-baseline-drift PR label', kind: 'pr-label' },
    { label: 'Retry story', kind: 'retry' },
    { label: 'Open worktree', kind: 'inspect' },
  ],
}
```

### 4.3 Forensic event emission

A new `BaselineCheck` event type lands in `AgentEventType` (Story 2-A-7-3,
already enumerated in the Phase 2 doc) and maps to the new `baseline-check`
Timer Intelligence category. Per-story duration of the gate becomes
visible in the timing panel.

## 5. The `acceptBaselineDrift` mechanism (PR-37)

When DEV's implementation legitimately changes a public surface — e.g. a
type widens from `'idle' | 'playing'` to a discriminated union with new
keys — the previously-passing tests are _expected_ to fail. The mechanism
must let the operator say "yes, intentional."

### 5.1 Production rigor — PR label

Per v2.5 §14: operator applies the GitHub PR label
`futurator:accept-baseline-drift` to the wave PR. The wave-completion-check
recognizes the label and converts the baseline-regression result from
**block** to **warn** for that wave only.

Implementation hook: `daemon/cron/wave-completion-check.mjs` (or equivalent)
reads PR labels via `gh pr view --json labels` after the wave PR opens.
Cached for the duration of the wave check.

### 5.2 mvp / prototype rigor — decision card

Per v2.5 §14: when wave-build-check detects regression at mvp rigor, the
plan dashboard surfaces a decision card:

> **Story X-Y regressed baseline test Z** (and 3 others)
> Was this intentional? [Accept] [Retry]

Card shape: reuses the existing decision-card component from PR-9 (Phase 1
hardening). Operator clicks Accept → daemon converts the regression to warn,
moves the wave forward, and rolls forward the baseline (§5.3). Operator
clicks Retry → wave marked `fixing`, the offending story re-enters DEV.

Card is dismissible only via Accept or Retry — there's no third option;
"ignore" hides important state.

### 5.3 Baseline roll-forward

After a wave merges green (or is operator-Accepted under §5.2), the
baseline rolls forward: `.pipeline/baseline-passing.txt` is overwritten
with `.pipeline/after-passing.txt` from the last story. This becomes the
input to the _next_ wave's baseline. Without this, every subsequent wave
would re-flag the same drift.

Roll-forward happens in the wave-merge step (Story 2-B-3-1 in the
Phase 2 doc).

### 5.4 Drift decisions audit trail

The `Plan` row gains an optional `driftDecisions[]` field:

```ts
interface DriftDecision {
  decidedAt: string; // ISO
  storyId: string;
  waveId: string;
  rigor: PlanRigor;
  decidedBy: 'pr-label' | 'operator-card';
  operatorEmail?: string; // present iff decidedBy === 'operator-card'
  regressedTests: string[]; // top 50, full list in forensic JSON
}
```

Forensic JSON export includes the full list. Operator dashboards surface
the count alongside cohort metrics.

## 6. Edge cases

### 6.1 Empty baseline (test runner crash at wave start)

Treat as "no regressions possible" → `check-regressions.sh` returns
`BASELINE_EMPTY` and exits 0. Daemon emits a low-severity
`baseline-capture-empty` attention item so the operator knows the gate
is effectively no-op for that wave.

Rationale: blocking the wave because the runner crashed at wave start is
worse than letting it through — the runner crash will surface elsewhere
(`test-verify` will catch its own crash, build will fail, etc.). The
gate's value is incremental, not load-bearing.

### 6.2 Flaky tests (intermittent failures)

The gate uses `--silent --reporter=json` which produces deterministic
output for vitest. If a test is flaky, baseline capture might catch it
in a passing state and post-DEV catch it failing. False-positive
regression.

Mitigation: prototype rigor warns rather than blocks. mvp/production
rigor relies on the project to keep tests non-flaky (CLAUDE.md-level
discipline). The `acceptBaselineDrift` mechanism (§5) provides the
escape hatch.

Out of scope for PR-35/36/37: an automatic flaky-test detector. That's
a Phase 3-E REFLECTOR pattern (read `metrics.csv` over time, identify
tests that flip pass/fail across runs, surface as a `flaky-test`
suggestion).

### 6.3 Test runner regression vs application regression

If `npm test` itself crashes on the post-DEV state (different exit code,
different output shape), `after-passing.txt` ends up empty. Naive `comm`
would report every baseline test as regressed.

Mitigation: when `after-passing.txt` is empty AND `baseline-passing.txt`
is non-empty, the script emits a distinct marker `TEST_RUNNER_FAILURE`
and exits 1 with a different attention category (`test-runner-failed`,
high severity) so the operator knows the issue is the runner, not the
code under test.

### 6.4 Per-story baseline (instead of per-wave)

v2.5 §14 specifies wave-level baseline. Per-story would catch
regressions earlier but would also flag legitimate cross-story behavior
changes within a wave (story 1 adds a new branch; story 2 narrows it
again). Wave-level is the right granularity — it matches the wave-merge
moment that's the integration check.

### 6.5 Boilerplate doesn't have tests yet

`baseline-passing.txt` has 0 lines → `BASELINE_EMPTY` per §6.1. The gate
is a no-op. As the project accumulates tests, the gate becomes more
load-bearing organically.

### 6.6 Boilerplate uses a non-vitest runner

The scripts assume vitest's JSON reporter shape. Phase 2 only ships the
`nextjs` boilerplate's wired implementation; the `BoilerplateMetadata`
registry field declares a per-type `baselineCapture` config so SST /
Vite / Mobile can declare different commands when those templates
graduate from stub to wired.

## 7. Test-runner detection per boilerplate

The `BoilerplateMetadata` registry (Story 2-A-4-2) gains a new optional
field:

```ts
interface BoilerplateMetadata {
  // ... existing fields ...

  /**
   * Phase 2-A baseline-diff scripts. Null for stub boilerplates that
   * haven't shipped tests yet. The daemon skips the gate when null.
   */
  baselineCapture?: {
    /** Path within the working tree to the capture script. */
    scriptPath: string;
    /** Path within the working tree to the regression-check script. */
    regressCheckPath: string;
    /** Stable name for the test runner, surfaced in attention items. */
    testRunner: 'vitest' | 'jest' | 'playwright' | 'mocha';
  } | null;
}
```

| Boilerplate        | Status in Phase 2 | `baselineCapture`              |
| ------------------ | ----------------- | ------------------------------ |
| nextjs-base        | wired             | vitest scripts shipped (PR-35) |
| nextjs-canvas-game | wired             | inherits nextjs-base           |
| nextjs-form-app    | wired             | inherits nextjs-base           |
| nextjs-dashboard   | wired             | inherits nextjs-base           |
| sst                | stub              | null                           |
| vite               | stub              | null                           |
| mobile             | stub              | null                           |

When SST / Vite / Mobile graduate to `wired`, that PR populates
`baselineCapture` for them.

## 8. Implementation sequencing

This design splits into three implementation PRs after PR-34
(this doc):

### PR-35 — Starter scripts

Ships `capture-test-baseline.sh` and `check-regressions.sh` into
`template-nextjs/scripts/`. Updates the boilerplate registry's
`baselineCapture` field for `nextjs-*` types. Updates the registry test
(G-2 from Phase 1).

**Effort:** ~½ day. **Test gate:** registry test + smoke against a
fresh `dino-runner-2` App.

### PR-36 — Daemon wiring + attention surface

Wires the wave-start hook + per-story `baseline-regression` step.
Threads `RIGOR` env var through. Adds `BaselineCheck` event type +
classifier mapping (Story 2-A-7-3 from the Phase 2 doc). Emits
`attention.baseline-regression` and `attention.baseline-capture-empty`
and `attention.test-runner-failed`.

**Effort:** ~1 day. **Test gates:** G-11 (block synthetic regression
under mvp+) + new daemon test for `BASELINE_EMPTY` and
`TEST_RUNNER_FAILURE` paths.

### PR-37 — `acceptBaselineDrift` mechanism

Implements the PR label recognition (production rigor) + decision card
(mvp/prototype). Adds `Plan.driftDecisions[]` field. Wires the
baseline-roll-forward into wave-merge. Forensic export includes the
decisions.

**Effort:** ~1 day. **Test gates:** end-to-end test that drifts the
baseline, accepts via card, verifies next wave's baseline includes the
new state.

**Aggregate:** ~2.5 days for the three implementation PRs after this
design. Within Phase 2-A's ~7d net-new budget.

## 9. Open questions (resolve before PR-35)

1. **Where does `capture-test-baseline.sh` actually run from?** The
   wave-start hook needs to be a real daemon code path. Today the
   wave-completion-check is cron-driven (post-wave); we need a wave-start
   hook (pre-first-story). Either extend the existing cron or add a new
   one. **Tentative:** extend the wave-completion-check to also handle
   wave-start by detecting "first story of next wave just dispatched" —
   re-uses existing cron infrastructure. PR-35 author confirms.

2. **Does jq need to be installed on EC2?** Daemon already shells out to
   tools that may not be present (graph-sync.mjs gracefully degrades). For
   jq, either bundle into the daemon image or detect at startup and surface
   a `jq-not-installed` attention item. **Tentative:** detect at startup,
   block daemon spawn if missing, document in deployment runbook.

3. **What's the baseline behavior on a brownfield App?** `dino-runner-1`
   already exists and has tests. The first wave to use baseline-diff there
   needs a bootstrap baseline. **Tentative:** daemon detects "no
   `.pipeline/baseline-passing.txt` exists" and runs capture as a
   one-shot bootstrap before the wave starts. PR-36 handles this.

4. **Does the gate run for `experiment/` plans?** v2.5 §22 says
   `experiment/<plan-slug>` is "never auto-merge." Should baseline-diff
   even fire? **Tentative:** yes — even experiments benefit from knowing
   they regressed something. The `acceptBaselineDrift` PR label is the
   escape hatch; experiments use it liberally.

5. **What about plans without a test runner at all?** `pmContext.testsPath`
   in the registry tells us where tests _should_ live; if there are zero
   `*.test.*` files in the worktree, both scripts return empty. The gate
   no-ops. No special handling needed.

## 10. Cross-references

- **v2.5 spec:** §14 (this gate's source of truth), §16 (tamper-check that
  runs immediately before this gate), §26 (wave-merge that the
  baseline-roll-forward plugs into).
- **Phase 2 doc:** Epic 2-A-4 (this gate's epic), Story 2-A-4-1 (this
  doc), Story 2-A-4-2 (PR-35), Story 2-A-4-3 (PR-36), Story 2-A-4-4
  (PR-37). Test gate G-11 in §10.
- **Phase 1 hardening:** PR-2 (pre-DEV gate, the complementary half).
