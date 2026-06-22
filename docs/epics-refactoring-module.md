# Refactoring Assessment Module — Epics & Stories

> **Status:** Draft for build · 2026-06-19 · BMAD epic/story format, ready for `dev-story`.
> **Source of truth (design + validation):**
> [`refactoring-assessment-pipeline.md`](./concepts/refactoring-assessment-pipeline.md),
> [`refactoring-recon-experiment-reborders.md`](./concepts/refactoring-recon-experiment-reborders.md),
> [`refactoring-recon-experiment-applicator.md`](./concepts/refactoring-recon-experiment-applicator.md),
> [`applicator-editor-unification-plan.md`](./concepts/applicator-editor-unification-plan.md),
> [`applicator-assessment-plan.md`](./concepts/applicator-assessment-plan.md).
> **Validated artifacts:** `daemon/scripts/refactor-recon/alias-resolve.mjs`, `daemon/scripts/refactor-recon/hotspot-detect.mjs`,
> the saved `/assess-codebase` dynamic workflow.

## Goal & shape

Give the operator a **UI-triggered "Assess" action** on a migrated brownfield project that runs
a deterministic recon chain on the EC2 clone, surfaces a **severity-ranked hotspot report**, and
turns it into a **plan draft** that flows into the existing epic/story dev pipeline. **Report-only
→ Create plan. No auto-fix.** Rides the Story 15.4 substrate (brownfield clone, daemon, agent-jobs
events) — it is a new job kind `refactor-audit`, not a new system.

**Architecture rule (validated):** two engines. graphify for _shape_ (modules, god-objects,
cohesion); the alias-resolver + knip for _usage_ (fan-in, dead code, design-system hub). The L3
agentic layer **adversarially verifies** the deterministic detector (it overruled the `primitives`
false-positive in testing) before anything reaches a plan.

**MVP cut (v0):** Epics A, B, D (run recon from the UI, see the report). Epic C (L3 workflow) and
Epic E (fix loop) are fast-follows — the recon report alone is shippable value.

---

## Epic A — Recon toolchain: package as a one-command runner

Turn the two validated scripts + graphify + knip into a single headless command the daemon runs.

- **A1 — `recon.mjs` orchestrator.** One command: `node daemon/scripts/refactor-recon/recon.mjs <repo>` that runs graphify (AST, `--directed`) → `alias-resolve.mjs` → `hotspot-detect.mjs`, writing `graphify-out/{graph.resolved.json, resolved-imports.json, hotspots.json}` + a `REPORT.md`.
  - _AC1:_ single invocation produces all four artifacts on `applicator` with zero manual steps.
  - _AC2:_ pure-deterministic (0 LLM tokens); completes < 3 min on 700-file repo.
  - _AC3:_ exits non-zero with a specific message if graphify/knip missing; idempotent re-run.
- **A2 — Harden knip dead-code feed.** Robust parse of `knip --reporter json` across versions (current parser under-counts); cross-check each unused file against resolved fan-in 0 → `safe-candidate` vs `needs-review`.
  - _AC:_ dead-code category populated correctly on applicator (currently ~1; expect the real count).
- **A3 — Alias resolution at extraction (or post-process).** Promote `alias-resolve.mjs`'s tsconfig-`paths` resolution into the recon so fan-in/hub/dead-code reads are correct on alias-heavy repos. Validated benchmark: `button.tsx` in-degree must read ~115, not ~1.
  - _AC:_ `recon.mjs` on applicator reports `button.tsx` fan-in ≥ 100 and design-system verdict = "hub present".
- **A4 — Detector calibration config.** Externalize the framework-convention filename excludes (`route.ts`, `page.tsx`, `index.ts`…) and the UI-dir rollup into a small config so other frameworks can tune it.
  - _AC:_ no `route.ts ×N` false positives; UI-component dups roll up under design-system-consolidation.

## Epic B — `refactor-audit` job kind + daemon integration

Make the recon runnable headless on the EC2 clone via the existing daemon/job substrate.

- **B1 — DDB job kind + API.** Add `kind='refactor-audit'` to the agent-jobs schema; `POST /api/party/projects/:id/assess` enqueues it (mirrors the refresh endpoint).
  - _AC:_ enqueue returns a `jobId`; job row carries `kind`, `projectId`, `status`.
- **B2 — Daemon handler runs the recon chain.** Daemon picks up `refactor-audit`, runs `recon.mjs` on the project's clone, reports progress to disk, emits `assess.*` events.
  - _AC:_ `applicator` audit run end-to-end on EC2 produces `hotspots.json` + `REPORT.md` in the project's knowledge dir.
- **B3 — Event stream + resumability.** Reuse `/api/agent-jobs/:id/events`; terminal `assess.completed` / `assess.failed`; re-run skips graphify if `graph.json` fresh.
  - _AC:_ UI can poll the run live; a killed run resumes without rebuilding the graph.

## Epic C — L3 assessment workflow (fast-follow)

The saved `/assess-codebase` dynamic workflow that adjudicates hotspots into a plan.

- **C1 — Saved workflow command.** Persist the validated `/assess-codebase` script to `.claude/workflows/`; it reads `hotspots.json` (top-N) and emits a sequenced plan (the applicator run is the reference output).
  - _AC:_ re-runnable as `/assess-codebase`; produces a plan with ordered `dependsOn` stories.
- **C2 — Tool-scoped adjudicator subagent.** Define a read-only `version-adjudicator` agent (Read/Grep/Glob/Bash, **no Write**) so "find, don't fix" is mechanical; correct graph contract (`.links`/`.relation`, `resolved_in_degree`, not raw in-degree).
  - _AC:_ agent cannot modify files; queries the resolved graph, not grep-only fallback.
- **C3 — Adversarial verify gate.** Each finding gets an independent verifier that must confirm from code before it reaches the plan (this is what overruled the `primitives` false-positive).
  - _AC:_ a deterministic detector finding contradicted by code is dropped/flagged, not passed through.
- **C4 — Plan → dev-pipeline stories.** Judge output maps to the existing epic/story pipeline format.
  - _AC:_ generated stories are ingestible by `create-story`/`dev-story`.

## Epic D — UI: hotspot report + Create-plan (MVP)

- **D1 — "Assess" trigger on the brownfield project card.** Button → `POST …/assess`; show run progress via the event stream.
  - _AC:_ operator starts an audit from the card; live status renders.
- **D2 — Severity-ranked hotspot dashboard.** Render `hotspots.json`: kind, severity, score, files, evidence, suggested action; group by workstream.
  - _AC:_ applicator's report renders (design-system-consolidation, god-objects, legacy, dead-code) with drill-down to files.
- **D3 — "Create plan" action.** Turn the report (or the L3 plan) into draft epics/stories in the existing pipeline — the report-only→plan seam.
  - _AC:_ one click produces draft stories; **never** auto-edits code (per "proper fix over shortcut").

## Epic E — Close the fix loop (later)

- **E1 — Characterization-test net gate.** Before any deletion/repoint story runs, require the thin app-level Playwright net (per the assessment plans' WS3-S1 pattern).
- **E2 — Dev-pipeline execution.** Plan stories flow into the existing dev pipeline (writes tests, runs CI, extract→repoint→delete, grep-gated). No new mutation engine.

---

## Sequencing & dependencies

```
A1 → A3 → A4 → A2      (toolchain ready)
A1 → B1 → B2 → B3      (headless on daemon)
B2 → D1 → D2 → D3      (UI report + plan)   ← MVP completes here
hotspots.json → C1 → C2 → C3 → C4   (L3 plan, fast-follow)
C4/D3 → E1 → E2        (fix loop, later)
```

**MVP = A1, A3, A4, B1, B2, B3, D1, D2, D3** — operator clicks Assess, sees a correct severity-ranked
report, clicks Create plan. Epic C upgrades "report" to "adjudicated plan"; Epic E closes to fixes.

## Cross-cutting constraints (from project conventions)

- One DynamoDB table per concern; table names from SST env. No single-table design.
- Recon runs on the EC2 clone; **never** sync anything to `futurator-ai-website` (deploy-safety).
- Read-only adjudication; the dev pipeline is the only thing that mutates code (test-gated).
- Single-operator factory — no multi-tenant concerns; stay on the Max-subscription model path.
