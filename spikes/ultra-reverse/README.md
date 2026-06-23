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
  decision-schema.mjs     # the DecisionPlan IR (factory + dependency-free validator)   [design §2]
  pattern-classify.mjs    # phase-names → pattern (shared by both projectors)           [design §5]
  case1-to-decision.mjs   # AST parser: ultracode .js → DecisionPlan (TS compiler API)   [design §3]
  case2-to-decision.mjs   # projector: planOutputSchema → DecisionPlan (+ wave layering) [design §4]
  structural-diff.mjs     # Scorer 1: pattern_match + dag_shape (+ full metric set)      [design §6]
  guardrail-uplift.mjs    # Scorer 3: Case-2-only guardrail uplift (6 sub-axes)          [design §8]
  scorecard-emit.mjs      # map scores → ScorecardSlice[] (scorecard/types.ts shape)     [design §9]
bin/
  run-slice.mjs           # the §9.1 driver: normalize both → score → emit → persist     [design §9.1]
capture/
  script-capture.mjs      # M0: fs.watch the session dir, grab the generated script      [design §3/strategy §5]
  case1-runner.mjs        # M0 automation scaffold (node-pty) — live cancel [VERIFY]
test/
  case1-to-decision.test.mjs  # round-trips the real spikes/v3-hybrid workflow scripts   [design §3.2]
  case2-to-decision.test.mjs  # wave layering + guardrail projection                     [design §4]
  scoring.test.mjs            # guardrail uplift + ScorecardSlice emit                    [design §8/§9]
  fixtures/sample-plan-output.json  # synthetic Case-2 planOutput
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
| `case2ToDecision` (project planOutputSchema → IR) | ✅ built (slice: plain-JS wave layering + rigor→tier; production must call the real `computePlanWaves`/`buildAgentConfig`) |
| guardrail uplift (design §8) | ✅ built — 6 sub-axes + headline uplift, Case-2-only |
| `ScorecardSlice` emit + `run-slice` driver | ✅ built — normalize→score→emit→persist (JSON; DDB/S3 is M5) |
| **Tests executed** | ✅ **18/18 green** + driver runs end-to-end on node v26.3.1 (2026-06-23). Run: `node --test spikes/ultra-reverse/test/*.test.mjs` (list files — v26 `--test <dir>` treats a bare dir as a module entry). |
| Live cancel-with-zero-agents [VERIFY] | ⛔ open — needs one interactive `claude` run (strategy §5.4, design §10.1) |
| judge panel (design §7), N-reps, DDB/S3 store | ⛔ not built — M3+/M5 |

## Next steps (in order)

1. **Resolve the live cancel [VERIFY]** — one interactive ultracode run, confirm `agentCount:0` (design §10.1). This is the only piece of the slice that needs a live `claude`; everything else is green.
2. **Swap the slice projection for the real services** — `case2ToDecision` should call the real `computePlanWaves`/`buildAgentConfig`/`resolveRolePolicy` (via a TS loader or a compiled build) so the bench scores deployed behavior, not a re-implementation (design §4, risk #4).
3. **Judge panel** (design §7) — reuse `buildAssessorPrompt`/`parseAssessorOutput` with blind-paired A/B + 3 judges.
4. **N reps + DDB/S3 store** (design §9, M5) — adapt `probes/A3-stat/run-n.sh`; persist runs to DynamoDB+S3 instead of the JSON file `run-slice.mjs` writes today.

## Verified end-to-end (2026-06-23)

```
node bin/run-slice.mjs --case1 ../v3-hybrid/probes/E1-plan-swarm/epic-elicitation.workflow.js \
  --case2 test/fixtures/sample-plan-output.json --target greenfield --rigor production
→ normalizes both engines, scores structural slice + guardrail uplift, emits 10 ScorecardSlices, persists JSON.
```
