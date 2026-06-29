# Granular (mid-grained) re-scan — design

> **Goal:** re-run only PART of the v2 scan and merge the fresh results into the
> persisted scan, leaving everything else untouched — so a re-scan costs a few
> agents instead of ~48. Sits between the two modes already shipped:
> `full` (recon + whole swarm) and `deterministic` (recon + detectors, ~0 LLM).
> This adds `targeted` (recon-reuse + a chosen subset of swarm tasks).
>
> **Status:** BUILT (Phase 1 + git-diff auto-target), 2026-06-30 — on `feat/pipeline-v3`,
> tested (9 runner specs green), not yet deployed. Builds on the shipped `scan-engine`
> job + the S3-persisted `scan.json` + the `mode` payload field. Decision: a re-run that
> returns zero findings for a task REMOVES that task's old findings (confirm-fixed).

---

## 1. Why

A full scan on applicator-onboarding = **~48 LLM agents** (43 analyzed subsystems +
5 cross-cutting passes) + 1 report writer ≈ 12 min, real spend. Today the only
cheaper option is `deterministic` (no LLM at all). But the common real need is
mid-grained:

- "I fixed the `safety-security` findings — **re-run just that pass** to confirm."
- "I refactored `src/lib` — **re-run only that subsystem**, keep the other 42."
- "The `ui-centralization` pass gave weak output — **re-run only it**."

Each of those is **1 agent**, not 48. That's the token economics this unlocks.

---

## 2. The core enabler: `producedBy` on every finding

Today an LLM finding carries `area` (the shardKey for an analyzer, or a label like
`UI` for the ui-centralization pass). But `area` is a _display_ field and is
sometimes overridden by the LLM (the ui pass forces `area:"UI"`), so it does NOT
reliably identify the **task** that produced the finding.

**Add `producedBy: string`** to every LLM finding = the stable task key:

- analyzer → the shardKey, e.g. `§sys:src--lib`
- cross-cutting pass → the pass area, e.g. `error-handling`, `ui-centralization`

Set in `scan-engine-job-runner.mjs` where findings are parsed (`parseAndValidate`
already receives `ctx`; stamp `producedBy = ctx.area` / pass key). Deterministic
findings get `producedBy: 'deterministic'`. This is the merge key — unambiguous,
independent of the display `area`.

(Additive field; `scan-finding-schema.ts` gains an optional `producedBy?: string`.)

---

## 3. Payload + mode resolution

`scanEnginePayload` gains:

```ts
targets?: string[];   // task keys to re-run: shardKeys and/or pass areas
reuseRecon?: boolean; // skip graphify/decompose/deps/detectors, reuse graphify-out
```

Mode resolution in the runner:

| condition                  | mode                     |
| -------------------------- | ------------------------ |
| `targets?.length`          | **targeted**             |
| `mode === 'deterministic'` | deterministic (existing) |
| else                       | full (existing)          |

`targeted` implies `reuseRecon: true` by default (you're re-running an LLM pass over
unchanged structure). Override to `false` to also refresh recon first.

---

## 4. Runner merge algorithm (`targeted`)

```
1. RECON
   if reuseRecon && graphify-out/ exists (graph.resolved + subsystem-shards):
       skip graphify / decompose / deps / detectors  — reuse the cached artifacts
   else:
       run them (fresh structure)                    — falls back to full recon

2. LOAD PRIOR   priorScan = deps.readPriorScan()      ← fetch S3 _refactor/scan.json
   priorFindings = priorScan.findings (or [] on first run / 404)

3. BUILD TASKS  only the selected ones:
   tasks = [ analyzers for shards whose shardKey ∈ targets ]
         + [ cross-cutting passes whose area ∈ targets ]
   pushEvent scan.targeted.started { targets, agents: tasks.length }

4. RUN          pool(tasks) → newLlm[]  (each stamped producedBy = its task key)
   newLlm = dropUnanchored(newLlm, anchored)

5. MERGE        keep everything NOT in the re-run set, swap in the fresh results:
   keptLlm = priorFindings.filter(f => f.source === 'llm' && !targets.has(f.producedBy))
   det     = reuseRecon ? priorFindings.filter(f => f.source === 'deterministic')
                        : freshDeterministicFindings    // re-mapped from new recon
   findings = dedupe([ ...det, ...keptLlm, ...newLlm ])

6. RE-SYNTHESIZE (all cheap/deterministic):
   planPhases → toPlanOutput → char-net gate
   computeMaturity (over merged findings)
   report = deterministicReport(...)   // no LLM in targeted mode (keep it cheap)

7. PERSIST      upload merged scan.json → S3 (+ durable record, summary on job row)
```

**Removal semantics fall out for free:** if a re-run subsystem now returns **zero**
findings (you fixed them), its old findings were dropped in step 5 (`keptLlm`
excludes that `producedBy`) and nothing replaces them → they vanish. So a targeted
re-run doubles as **"confirm I fixed these."**

---

## 5. Recon reuse + fallback (correctness)

- `reuseRecon` reuses `graphify-out/` from the clone (persists between runs on the
  box). Guard: if `graph.resolved.json` + `subsystem-shards.json` are missing
  (clone refreshed / reaped), **fall back to a fresh recon** and log it — never run
  a targeted swarm against absent structure.
- The clone's HEAD may have moved (you pushed a fix). `reuseRecon: false` re-runs
  recon so structure + deterministic findings reflect the new code, then re-runs
  only the selected LLM tasks. This is the "I changed code in src/lib, re-scan just
  it properly" path.

---

## 6. UI

Two affordances, both reading the persisted `scan.json` (which now exposes
`producedBy` per finding, so the UI can group):

**(a) "Re-run parts" panel** (collapsible, under the scan header):

```
Re-run parts            selected: 2 tasks (~2 agents)   [ ↻ Re-run selected ]
Cross-cutting passes
  ☐ error-handling (6)   ☑ safety-security (13)   ☐ magic-numbers (7)
  ☐ type-safety (7)      ☐ ui-centralization (11)
Subsystems (analyzed, by current finding count)
  ☑ §sys:src--lib (10)   ☐ §sys:src/components (10)   ☐ … (+38)   [show all]
  ☐ reuse recon (faster, code unchanged)   ← default ON
```

Counts come from grouping `scan.json.findings` by `producedBy`. The button POSTs
`scan-engine` with `{ targets, reuseRecon }`; the live log streams only the selected
agents (`scan.targeted.started` → per-agent → merge → done).

**(b) Inline re-run** — a small `↻` on each Priority-Matrix dimension filter and on
each Recommended-Sequencing item's subsystem, so "re-run this" is one click from
where you're reading.

---

## 7. Token economics (worked)

| Action                                | Agents       | ~Cost vs full |
| ------------------------------------- | ------------ | ------------- |
| Full scan                             | ~48 + writer | 100%          |
| Deterministic (shipped)               | 0            | ~0            |
| **Targeted: 1 cross-cutting pass**    | 1            | ~2%           |
| **Targeted: 1 subsystem**             | 1            | ~2%           |
| **Targeted: 5 subsystems + 2 passes** | 7            | ~15%          |

Report regen is deterministic in targeted mode (no writer agent), so the only spend
is the selected analyzers.

---

## 8. Edge cases

- **Zero-findings after re-run** → treated as "fixed", old ones removed (§4.5). Good.
- **Renamed / deleted subsystem** → its `producedBy` no longer in the new shard set;
  its prior findings are kept (not in `targets`) unless explicitly targeted. A full
  scan reconciles. (Document: targeted never deletes findings for _untargeted_ areas.)
- **Stale recon** (reuseRecon but code moved) → anchored-path guard + the fallback in
  §5; recommend `reuseRecon:false` after a code change.
- **Concurrent runs** → the job is one row; a second run started before the first
  finishes would race the S3 merge. Guard: reject a new scan-engine job for an app
  with a RUNNING one (the API already has a `hasProcessingSession`-style check; add a
  RUNNING-scan check), or last-write-wins with a warning.
- **First run / no prior scan.json** → `targets` with no prior → just runs the
  selected tasks (priorFindings = []); fine, but the UI only offers targeted once a
  scan exists.

---

## 9. Phased build

- **Phase 1 — BUILT:** `producedBy` tag (runner + `scan-finding-schema.ts`); `targets`
  - `reuseRecon` + `autoTargetChanged` payload (`party-schema`, `agent-orchestrator`,
    API route); the runner targeted-merge path (`scan-engine-job-runner.mjs` —
    `targeted` mode, `runSwarm`, prior-merge, zero-result removal); daemon deps
    `readPriorScan` (S3 GetObject), `reconAvailable`, `changedFiles` (git diff),
    `reuseDetectors` in `readArtifacts`, `scannedSha` stamped on upload; the "Re-run
    parts" panel (`scan-report.tsx` `RerunParts` — passes + subsystems grouped by
    `producedBy`, agent-count estimate, reuse-recon toggle, "Re-scan changed files").
    **+ git-diff auto-target** (promoted from Phase 2): `autoTargetChanged` diffs the
    clone vs the recorded `scannedSha` and re-runs only the changed subsystems. Tests:
    merge keeps untargeted + swaps targeted + removes zeroed + reuses recon + auto-target
    maps changed files + no-prior degrades to full (9 specs green).
- **Phase 2 (later):** inline per-dimension/per-subsystem `↻` (one-click from where
  you read); per-finding re-verify (re-run the adjudicator on a single finding);
  auto-target of cross-cutting passes (today auto-target selects subsystems only —
  changed code that affects a cross-cutting concern needs an explicit pass selection).

---

## 10. Risks

- **Merge drift:** re-dedupe over a partially-fresh set could reshuffle `(overlaps)`
  links. Low impact (dedupe is deterministic); acceptable.
- **`producedBy` accuracy:** if the swarm task set changes between scans (e.g. the
  cap surfaced different subsystems), a target may not exist in the new run → no-op
  for that target, logged. Not harmful.
- **Cost confusion:** the UI must show the agent-count estimate so "Re-run selected"
  never surprises with a big spend — the whole point is predictability.
