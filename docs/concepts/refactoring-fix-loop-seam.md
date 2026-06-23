# Refactoring Assessment — the fix-loop seam (Epic E)

> **Status:** built · 2026-06-23 · closes Epic E (E1 characterization gate + E2 dev-pipeline execution).
> The module is **report-only → create-plan**. It designs **no mutation engine** — the existing
> dev pipeline is the only thing allowed to change code, and only behind test gates.

## E2 — execution rides the existing pipeline (reuse, not rebuild)

There is **nothing new to build** for execution. A refactoring plan is an ordinary `planOutput`
tree; once materialized it flows through the _same_ spine every other plan uses:

```
Assess (recon) → Report (hotspots) → Create plan (planOutput)         ← THIS MODULE
   → import-plan → start → wave execution → VQA → fix-loop → deploy    ← EXISTING dev pipeline
```

- **Create-plan** (Epic D3 / L3 judge, Epic C) emits a `planOutputSchema` tree and submits it via
  `POST /api/plans/:id/import-plan` (a fresh `kind:'change'` brownfield plan). It never calls
  `apply-plan` on an already-started plan (destructive, concept-only — the 2026-06-17 incident).
- From there the plan inherits **for free**: per-story DEV→REVIEW, `npm run ci` gating, the
  wave-merge grep-zero check, VQA, and the existing fix-loop (`FIX_CYCLE_HARD_CAP`, auto
  fix-forward, retry-exhausted → attention item). The module specifies **no retry logic**.
- The **only** code mutator remains the dev pipeline, behind tests. The recon path and the L3
  `version-adjudicator` are mechanically read-only (no Write tool). "Proper fix over shortcut":
  we never auto-bypass a gate.

## E1 — characterization-net gate (enforced two ways)

A deletion/repoint on an app with no tests is roulette. The gate is enforced at **two** layers:

1. **Plan generation bakes it in.** Both the L3 judge prompt (`buildL3Prompt`,
   `.claude/workflows/assess-codebase.workflow.js`) and the Create-plan intent seed
   (`buildPlanIntent`, `assess-tab.tsx`) instruct: _sequence every refactor as a Strangler-Fig
   (extract → repoint → delete), and add a thin app-level Playwright characterization net BEFORE
   any deletion/repoint on a route lacking coverage; the delete/repoint story `dependsOn` the net._

2. **A deterministic validator flags violations.** `findCharacterizationGateViolations(planOutput)`
   (in `refactor-audit-job-runner.mjs`) scans the generated plan for any deletion/repoint story that
   does **not** depend on — or sit after — a characterization-net story in its epic. The daemon
   surfaces the count on the `assess.l3.completed` event and logs a warning, so a mis-sequenced plan
   is visible to the operator **before** it executes. (Run-time enforcement of tests-before-mutation
   is the dev pipeline's job — this is the pre-flight guard on the plan shape.)

   Net detection is heuristic (title/criteria text matching `characteriz|playwright|e2e|smoke|…` or a
   `needsBrowser` criterion); a story carrying a browser AC counts as a net. The check is a guard
   rail, not a hard reject — the operator decides, consistent with the single-operator-factory model.

## Why no hard reject / no new gate in the shared pipeline

Modifying the shared dev pipeline (wave reducer, story pipeline) to hard-block deletions would be
broad, risky, and out of this module's boundary. Instead the module (a) generates correctly-sequenced
plans, (b) flags violations pre-flight, and (c) leans on the pipeline's existing test gates at run
time. That keeps the blast radius inside the refactoring module while still making the gate real.
