# v3-hybrid probes — falsification instruments

Implements `docs/concepts/pipeline-v3/spike-test-plan.md`. Each probe emits a single
machine-readable `PROBE-RESULT:` line; wrap any probe in the A3 stat harness for N-run
distributions. All probes run headless `claude -p --permission-mode bypassPermissions`
(RC1) on CLI 2.1.181.

```bash
# foundational
node probes/B1-harvester/harvest.mjs /tmp/v3-spike-clean-run     # O4 telemetry recovery
bash probes/A3-stat/run-n.sh 10 bash probes/A1-shared-contract/run.sh --no-stub

# Round A (load-bearing [CHOSEN] decisions)
bash probes/A1-shared-contract/run.sh --no-stub   # O2 drift on shared contract
bash probes/A1-shared-contract/run.sh --stub      # O2 mitigation arm (frozen .d.ts)
bash probes/A2-anticheat/run.sh                   # O-CHEAT (blind) — add --readable for the cheat arm
bash probes/A4-enforce/run.sh                     # O3c gate-blocks-merge
bash probes/A5-capability/run.sh                  # O3c per-agent capability strip

# Round B (measurement spine)
bash probes/B2-ab/run.sh                          # M-AB frozen-plan head-to-head

# Round C (deferred mechanisms; need B1 for measurement)
bash probes/C1-fixswarm/run.sh                    # O7 swarm vs --serial
bash probes/C2-cascade/run.sh                     # O1 contract-stable release safety
bash probes/C3-collision/run.sh                   # O8 merge collision / I3
bash probes/C4-standards/run.sh                   # O6b standards-critic orthogonality

# Round D (env-gated: EC2 / Memgraph / scale)
bash probes/D1-ec2/run.sh                         # O3b headless durability (EC2)
bash probes/D2-resume/run.sh                      # O5 kill / cross-session resume
SPIKE_BROWNFIELD=/path bash probes/D3-graph/run.sh# O6 brownfield graph-gate (Memgraph)
bash probes/D4-multimodel/run.sh                  # O9 opus-vs-sonnet refuter
bash probes/D5-scale/run.sh                       # M-SCALE 16-cap honored, no truncation
```

## Status (2026-06-19) — full sweep run

Reconciliation against objections O1–O9 in `docs/concepts/pipeline-v3/spike-test-results.md`.

| Probe             | Objection | Result                                                              | Disposition                                                          |
| ----------------- | --------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| B1                | O4, O3    | model/tokens reconcile, duration derived; hash→story needs `stepId` | **refined** — recoverable via harvester + schema convention          |
| A1 no-stub        | O2        | `drift=no 4/4`                                                      | **softened** (simple case: agents converge)                          |
| A1 stub           | O2        | `drift=YES` — producer redefined type, ignored stub                 | **sharpened** — non-enforced stub backfires → candidate **I10**      |
| A2 blind/readable | O-CHEAT   | both `heldout=PASS testTouched=yes`                                 | **inconclusive** — task too trivial; stray-test caught               |
| A3                | M-STAT    | bash-3.2 portable N-run wrapper                                     | ✅ tool                                                              |
| A4                | O3c       | `blocked=yes merged=no`                                             | **confirmed** — enforce-mode is a real gate                          |
| A5                | O3c       | `bashRefused=yes sentinel=absent`                                   | **partly retired** — frontmatter strip works under bypassPermissions |
| B2                | M-AB/O1   | serial 20.6s vs workflow 104.9s; tokens harvested                   | **supported+caveat** — needs envelope-matched crossover              |
| C1                | O7        | swarm 93.7s vs serial 14.2s                                         | **confirmed concern** — overhead dominates on easy bugs              |
| C2                | O1        | `rework=no`                                                         | **supported** — contract-stable safe (cooperative case)              |
| C3                | O8        | `collisionDetected=yes autoResolved=no`                             | **resolved** (git layer) — I3 upheld                                 |
| C4                | O6b       | `correctness=PASS standards=FAIL orthogonal=yes`                    | **confirmed** — orthogonal critics add coverage                      |
| D1                | O3b       | env-gate (EC2)                                                      | open                                                                 |
| D2                | O5        | `journalSurvives=no` (path confound)                                | inconclusive — fix `cd $WORK`                                        |
| D3                | O6        | env-gate (Memgraph)                                                 | open                                                                 |
| D4                | O9        | both refuters caught the bug                                        | inconclusive — defect too obvious                                    |
| D5                | M-SCALE   | `completed=0` (path confound)                                       | inconclusive — fix path resolution                                   |

Instrument fixes for the next sweep: see `spike-test-results.md` §3.
Raw rows: `probes/results/*.csv` and `probes/results/sweep-*.md`.
