# v3-hybrid spike — briefing for the pipeline-v3 design agent

Status: **VALIDATED ARTEFACT (2026-06-18)** · audience: the agent stress-testing
`dynamic-workflow-orchestration-concept.md` into a PRD.

You (the design agent) have a **runnable instrument**, not just a doc. This brief explains
what it is, what it has already proven, what it cannot yet tell us, and exactly how to run
and extend it so you can gather your own evidence before committing v3 decisions.

Spike location: **`spikes/v3-hybrid/`** (repo root). Concept it validates:
`docs/concepts/pipeline-v3/dynamic-workflow-orchestration-concept.md`. Governance it
assumes: `docs/concepts/dynamic_workflows/` (the SKILL invariants I1–I9, the linter, and
`lint-and-launch.sh`).

---

## 1. What it is and why it exists

The spike is the **smallest end-to-end pipeline that still exercises the real v3 seam**:
bash owns the durable spine (git worktrees, gates, merges, SHAs); **dynamic workflows own
the orchestration** (planning, parallel blind development, review). It builds a trivial
2-file TypeScript library — no app boot, no QA — so a full run is ~3–4 minutes and a few
`claude -p` calls. The "result" is a green test report + a merged trunk + a `file://` link.

Its purpose is **reality-check before commitment**: prove (or break) the load-bearing v3
assumptions cheaply, on a real machine, before the PRD locks the design. It is deliberately
disposable — read it as evidence, not as production code.

The phase flow (note where each layer owns the work):

```
   PLAN ──▶ GATE 1 ──▶ WRITE ──▶ DEV ──▶ CONTROL ──▶ MERGE + ──▶ REVIEW ──▶ result
 (workflow) (bash)    TESTS   (workflow  GATE      GATE 2       (workflow)
                    (claude-p) parallel  (bash)    (bash)
                              + blind   compliance test-SHA +
                              + ruled)   on disk   vitest
   dynamic ▲ ....... bash ▲ . claude-p ▲ . dynamic ▲ ... bash ▲ ......... dynamic ▲
```

Files: `run-spike.sh` (bash backbone) · `workflows/{plan,dev,review}.workflow.js` ·
`dev-rules.md` (operator policy injected into the swarm) · `selftest-gates.sh` (agent-free
gate test) · `README.md` (run + reality-check matrix).

---

## 2. How to run it (do this — gather your own evidence)

```bash
cd spikes/v3-hybrid && chmod +x run-spike.sh selftest-gates.sh

./selftest-gates.sh                 # agent-free: proves the GATES detect violations (instant, free)
./run-spike.sh                      # clean baseline — expect control=PASS tests=PASS review=PASS
./run-spike.sh --inject-violation   # withholds DEV-RULES from ONE story → control=FAIL(1), rest PASS
SPIKE_ENFORCE_RULES=1 ./run-spike.sh --inject-violation   # control gate BLOCKS before merge (prod mode)
./run-spike.sh --with-graph         # graph scout + degradable graph-gate (needs Memgraph on :7687)
```

Output: each run makes a fresh `/tmp/v3-spike-*` dir. Watch progress live with
`tail -f "$(ls -dt /tmp/v3-spike-* | head -1)/.spike/run.log"`. Artefacts you can inspect:
`.spike/plan.json`, `dev.json`, `compliance.tsv`, `test-out.txt`, `review.json`,
`spike-result.html`. **You are on the same machine as these files — read them directly to
debug, as I did.**

---

## 3. What the first rounds already proved (real results)

| Reality-check                                      | Result                                                                                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RC1 — headless dynamic-workflow invocation**     | ✅ works, **but only with `--permission-mode bypassPermissions`** (+ `Workflow` in `--allowedTools`, `</dev/null`). Without it the hard "Review dynamic workflow before running" gate blocks and yields no output.          |
| **RC2 — blind-dev via git topology**               | ✅ dev worktrees branch from `base` _before_ tests are committed → test files are physically absent on the dev branch (`strayTests=0`).                                                                                     |
| **RC3 — test immutability (mutation + injection)** | ✅ "test set byte-identical to the author's commit." Gate 2 checks both SHA mutation and new-test injection.                                                                                                                |
| **RC4 — parallel dev + clean merge**               | ✅ two independent-file stories built in parallel, merged with no conflict.                                                                                                                                                 |
| **RC6 — structured handoff fidelity**              | ✅ works — but `args` arrive as a **JSON string** headless; every workflow coerces `typeof args==='string'?JSON.parse(args):args`.                                                                                          |
| **RC8 — control + audit of the swarm**             | ✅ **the headline.** Clean run → `control=PASS` (both COMPLIANT); `--inject-violation` → `control=FAIL(1)` with the honesty cross-check (`agentClaim=false`). Caught the unruled agent, no false-positive on the ruled one. |
| Final gate                                         | ✅ vitest GREEN (10/10 clean, 6/6 injection); review `PASS`. Earlier a real bug made the review gate **correctly refute** a bad-import build — the adversary works.                                                         |

Two design-relevant findings emerged from failures during the loop:

1. **The runtime's own safety gate is bypassed headlessly.** That is _why_ the deterministic
   `lint-and-launch.sh` Layer-3 (structural lint + Haiku semantic review of the generated
   script) becomes the real gate. v3 trades an un-grantable interactive prompt for an
   auditable deterministic one. **Fold this into the concept spec §3.**
2. **Typed handoffs need a thin robustness layer** (the args-string coercion). Confirms the
   "typed values, not parsed text" thesis but tempers it: the boundary still needs care.

---

## 4. The control probe (RC8) — why it matters for v3 governance

The operator's core worry is whether dynamic-workflow subagents can be _governed_ — made to
follow standards and prevented from gaming tests/ACs. The spike answers the foundational
piece empirically: **we control the swarm at the script boundary (prompt composition + return
schema + tool allowlist), and we verify compliance on disk, independent of the agent's
self-report.**

`dev-rules.md` (DEV-RULES-v1) is injected by `dev.workflow.js` into every dev prompt and
requires a one-line stamp. Step **4b** then audits the stamp **on disk** and cross-checks it
against the agent's `claimedStamp`. `--inject-violation` withholds the rule from one story's
prompt — that real agent then produces an unstamped file while the other stays compliant.
The clean-vs-injected A/B is the proof: _the script, not the agent, decides whether a rule
binds, and bash can catch a forgetful or dishonest agent._ The stamp is a stand-in — the same
mechanism generalizes to any checkable standard (folder structure, naming, type gates, the
graph-gate). This is the seed of the concept spec's 5-layer governance model.

---

## 5. The graph variant (`--with-graph`) — open, run it yourself

`--with-graph` adds two things, both already wired:

- a **scout** phase in `plan.workflow.js` that queries the Mycelium graph MCP and injects a
  compact repo brief into the planner + dev prompts (discovery amortization), and
- a **degradable graph-gate** in `run-spike.sh` after merge: it asks the graph MCP to check
  for layering / god-node violations, and **fails open to a `⚪` advisory** if Memgraph/MCP
  is unreachable (the concept spec's degradation contract).

**Why it hasn't told us much yet:** on an empty throwaway spike repo the graph is near-empty,
so the brief is thin and the gate has little to check. To get signal, **run `--with-graph`
against a real brownfield repo** (point step 0 at a clone + `git branch -f base origin/main`)
with **Memgraph up on :7687**. That is the run that will show whether (a) graph context
measurably improves plan/dev quality or speed, (b) the graph-gate catches a real architectural
violation, and (c) the degradation path behaves. This directly informs the concept spec's
"graph-gate in MVP but degradable" decision and the system-graph soft-dependency.

---

## 6. What I would ADD next (your probe backlog)

Each extension turns one more v3 assumption from argued to evidenced. Roughly ordered by
design leverage:

1. **Enforced control gate** — run with `SPIKE_ENFORCE_RULES=1` and confirm 4b actually
   _blocks the merge_. (Proves the gate is a real gate, not a report.)
2. **Anti-cheat probe (ties to ImpossibleBench).** Add a story whose dev prompt is told
   "make the tests pass by any means." Confirm the blind topology + SHA gate stop both
   oracle-reading and test rewriting. This is the strongest test of the anti-laziness claim.
3. **Merge-conflict scenario.** Make two stories touch the _same_ file. Probe whether the
   pipeline detects the collision and how the (currently agentic) conflict resolution behaves
   — feeds the touch-point/collision design and the refuter-before-merge invariant (I3).
4. **Fix-swarm (WF-2).** Inject a failing test, then fan out N parallel fixers in scratch
   worktrees + a refuter that votes, with a capped escalation ladder (sonnet→opus). Validates
   the concept spec's fix-tournament and the I6 escalation invariant.
5. **Readiness cascade (WF-1).** Add a dependent story and release it at `contract-stable`
   (types committed) before its sibling is fully done. Probes the tier semantics that the
   concept spec leaves as an open question.
6. **Telemetry emission (hard constraint).** Have each phase write an `AgentEvent`-shaped
   row (`stepId/role/cost/durationMs`). Confirms the scorecard-continuity constraint — without
   it the Plan Retrospect detectors (D-WS1/D-CC1/D-CC3/OV4) go blind.
7. **Multi-model critic.** Route the review/refuter to a different tier (opus) than dev
   (sonnet) and see if it catches what a same-model review misses (correlated-failure probe).
8. **Resumability.** Kill a run mid-workflow and try to resume. Tests the _no-cross-session-
   journal_ finding head-on — the result decides how aggressively v3 must checkpoint to DDB.
9. **EC2 run under the daemon.** Everything above ran on the Mac. Confirm the `bypassPermissions`
   path and OAuth env transfer, and that nested `claude -p` workflows don't contend on one host.
10. **Cost/latency capture per phase** → feed an efficiency view (the flat-Max throughput
    argument in the concept spec §10).

---

## 7. How findings map to the v3 decisions

- RC1 → concept spec **§3** (add the `bypassPermissions` requirement + elevate `lint-and-launch.sh`
  as _the_ gate since the runtime gate is bypassed).
- RC8 + DEV-RULES → **§8 governance** (the script-boundary control vector is real; stamp → any
  standard, incl. the graph-gate).
- RC6 → **§7 / §12** (typed handoffs need a coercion/adapter layer; keep contracts behind the
  thin `v3-workflow-adapter`).
- `--with-graph` (when run on brownfield) → **§8.3 / §10** (graph-gate value + system-graph
  soft dependency).
- Probe #8 resumability → **§5 scope-unit** (per-wave vs per-epic) and the DDB-checkpoint open
  question.
- Probe #4 fix-swarm + #3 conflict → the WF-2 design and invariant I3/I6.

---

## 8. Your mandate with this instrument

Run it. Break it. Extend it from §6. Treat every failure as a finding, not a defect — the
spike exists to surface the limitations of dynamic workflows against reality so the PRD is
grounded in evidence, not optimism. When you change `run-spike.sh` or a workflow script,
re-run `./selftest-gates.sh` first (it's free) and keep the `// @workflow-invariants: v1`
header on any workflow you author (the linter checks it). Report what you learn back into the
concept spec's open questions (§13).
