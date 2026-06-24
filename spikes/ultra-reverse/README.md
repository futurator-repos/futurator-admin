# ultra-reverse — the ultracode bench (vertical slice)

The MVP harness for the bench in `docs/concepts/pipeline-v3/ultracode-bench-design.md`
(strategy: `ultracode-bench-strategy.md`). Runs the **same intent** through two plan-generators,
halts both at "plan produced," normalizes to a common `DecisionPlan` IR, and scores them.

This directory is the **§9.1 smallest vertical slice**: prove `capture → normalize → score`
on the deterministic pieces first. Case 1 = real ultracode; Case 2 = the existing Futurator
concept chain (wired in M1, not here yet).

## Layout

```
lib/
  decision-schema.mjs        # the DecisionPlan IR (factory + dependency-free validator)    [design §2]
  pattern-classify.mjs       # phase-names → pattern (shared by both projectors)            [design §5]
  case1-to-decision.mjs      # AST parser: ultracode .js → DecisionPlan (TS compiler API)    [design §3]
  case2-to-decision.mjs      # projector: planOutputSchema → DecisionPlan (faithful port)    [design §4]
  case2-to-decision-real.mjs # PRODUCTION projector: real computeStoryWaves* + buildAgentConfig [design §4]
  structural-diff.mjs        # Scorer 1: pattern_match + dag_shape (+ full 8-metric set)     [design §6]
  judge-panel.mjs            # Scorer 2: blind-paired 3-judge panel (pluggable runJudge)     [design §7]
  guardrail-uplift.mjs       # Scorer 3: Case-2-only guardrail uplift (6 sub-axes)           [design §8]
  scorecard-emit.mjs         # map scores → ScorecardSlice[] (scorecard/types.ts shape)      [design §9]
  stats.mjs / reps.mjs       # N≥5 rep aggregation → distributions (mean±stdev)             [design §9]
  store.mjs                  # corpus: FileStore (default) + DynamoStore/S3 (config-gated)   [§8.3]
bin/
  run-slice.mjs              # the §9.1 driver: normalize both → score → emit → persist      [design §9.1]
capture/
  script-capture.mjs         # M0: fs.watch the session dir, grab the generated script       [design §3/strategy §5]
  case1-runner.mjs           # M0 automation scaffold (node-pty) — live cancel [VERIFY]
  verify-capture.mjs         # M0: assert agentCount:0 / no transcripts after a manual run    [design §10.1]
test/                        # 30 tests, all green — node --test spikes/ultra-reverse/test/*.test.mjs
  case1-to-decision.test.mjs · case2-to-decision.test.mjs · case2-real.test.mjs (drift guard)
  judge-panel.test.mjs · scoring.test.mjs · reps-store.test.mjs
  fixtures/sample-plan-output.json
```

## Run

```bash
npm install                               # once — pulls `typescript` into node_modules
node --test spikes/ultra-reverse/test/    # the parser round-trip tests (no live claude needed)

# inspect what the parser extracts from any workflow script:
node spikes/ultra-reverse/lib/case1-to-decision.mjs spikes/v3-hybrid/probes/C1-fixswarm/fixswarm.workflow.js
```

### M0 capture (the one piece that needs a live `claude`)

```bash
# Terminal 1 — start the watcher in your target repo's cwd:
node spikes/ultra-reverse/capture/script-capture.mjs --cwd "$PWD" --out /tmp/case1

# Terminal 2 — launch claude in the SAME cwd and trigger an ultracode run:
claude
> ultracode <your intent>

# The watcher prints CAPTURED + the saved Case1Result the instant the script is written.
# Then CANCEL (the live [VERIFY]) and confirm agentCount stays 0.
```

## Status (built 2026-06-23, branch `ultra-reverse` @ post-pipeline-v3 merge)

| Piece | State |
| --- | --- |
| `DecisionPlan` IR + validator | ✅ built |
| `case1ToDecision` AST parser | ✅ built; round-trip tests against 5 real fixtures |
| pattern classifier + structural diff (slice metrics) | ✅ built |
| `script-capture.mjs` (fs.watch grab) | ✅ built (dependency-free) |
| `case2ToDecision` — faithful plain-JS port + **real-services** projector | ✅ built; drift guard proves the port ≡ the deployed `computeStoryWavesWithTouchPoints`/`buildAgentConfig` |
| judge panel (design §7) | ✅ built — blind-paired A/B, 3 judges, outlier rejection, honesty downgrade (pluggable `runJudge`) |
| guardrail uplift (design §8) | ✅ built — 6 sub-axes + headline uplift, Case-2-only |
| `ScorecardSlice` emit + `run-slice` driver | ✅ built — normalize→score→emit→persist |
| N-rep distributions + store abstraction | ✅ built — `reps.mjs` (mean±stdev), `store.mjs` (FileStore + DynamoStore/S3 config-gated) |
| **Tests executed** | ✅ **30/30 green** + driver runs end-to-end on node v26.3.1 (2026-06-23). Run: `node --test spikes/ultra-reverse/test/*.test.mjs` (list files — v26 `--test <dir>` treats a bare dir as a module entry). |
| Live cancel-with-zero-agents [VERIFY] | ⛔ **open — the ONE piece needing a human at an interactive terminal.** Helper built (`verify-capture.mjs`); run one `ultracode` session + cancel, then verify (strategy §5.4, design §10.1). |
| DDB/S3 wiring + live judge (`claude -p`) | ⏳ scaffolded + config-gated; needs AWS creds / a live model to activate (deploy-time, design §9/M5). |

## What remains (only activation, not construction)

1. **Live cancel [VERIFY]** — the single human-in-the-loop step. Run one `ultracode` session, capture with
   `script-capture.mjs`, cancel, then `verify-capture.mjs --session <dir>` → expect PASS (`agentCount:0`).
2. **Activate the live judge** — `judge-panel.mjs` defaults to `claude -p`; needs a live model + an
   approved cost budget to run for real. Until then it's exercised with stub judges in tests.
3. **Activate DDB/S3** — set `UR_RUNS_TABLE` + `UR_ARTIFACTS_BUCKET` and wire `DynamoStore` via
   `functions/shared/repositories` (deploy-time). `FileStore` is the working default.
4. **Real Case-1 corpus** — feed captured ultracode scripts (not just the v3-hybrid fixtures) through
   `run-slice` at N≥5 reps to populate the distillation corpus.

## Verified end-to-end (2026-06-23, node v26.3.1)

```
node bin/run-slice.mjs --case1 <ultracode-script.js> \
  --case2 test/fixtures/sample-plan-output.json --target greenfield --rigor production
→ case1ToDecision (AST) + case2ToDecisionReal (real wave layering) → structural slice + guardrail
  uplift → 10 ScorecardSlices → persisted via the store. 30/30 unit tests green.
```
