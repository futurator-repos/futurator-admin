# Refactoring Assessment Module — Product Requirements Document

> **Status:** Draft for build · 2026-06-19
> **Owner surface:** Futurator-Admin Labs (single-operator factory)
> **Sources:** `docs/concepts/refactoring-assessment-pipeline.md`, `docs/concepts/applicator-assessment-plan.md`, `docs/concepts/applicator-editor-unification-plan.md`, `docs/concepts/refactoring-recon-experiment-reborders.md`, `docs/concepts/refactoring-recon-experiment-applicator.md`, `docs/epics-refactoring-module.md`, and the shipped recon toolchain under `daemon/scripts/refactor-recon/` (`recon.mjs`, `alias-resolve.mjs`, `hotspot-detect.mjs`, `graphify-build.py`).

## TL;DR

The Refactoring Assessment Module adds a one-click **"Assess"** action to a migrated brownfield project in Futurator-Admin's Labs UI. It runs a deterministic, ~0-LLM-token recon chain (graphify for _shape_ + alias-resolve/knip for _usage_) on the EC2 clone, surfaces a severity-ranked hotspot report, and — on a second click — compiles that report into a draft plan (epics/stories) that flows into the existing test-gated dev pipeline. The module is **report-only → create-plan**: it never auto-edits code. It rides the Story 15.4 brownfield/daemon/agent-jobs/events substrate by adding exactly one new agent-job kind, `refactor-audit`, plus an optional fast-follow L3 agentic adjudication stage (`/assess-codebase`) that adversarially verifies every deterministic finding before it can reach a plan. The recon engines are already built and validated end-to-end on `applicator` (4,307-node graph in ~1 min, `button.tsx` fan-in corrected 1→115, a false-positive `primitives` finding overruled by the adjudicator); this PRD scopes the hardening, the job-kind/daemon integration, the UI, and the close-the-loop fix path.

---

## Table of Contents

1. [Overview & Context](#1-overview--context)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Users & Personas](#3-users--personas)
4. [User Journeys](#4-user-journeys)
5. [Functional Requirements](#5-functional-requirements)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [System Architecture & Integration](#7-system-architecture--integration)
8. [Data Model & DDB Schema Changes](#8-data-model--ddb-schema-changes)
9. [API Surface](#9-api-surface)
10. [UI/UX Requirements](#10-uiux-requirements)
11. [Recon Toolchain Spec](#11-recon-toolchain-spec)
12. [L3 `/assess-codebase` Workflow Spec](#12-l3-assess-codebase-workflow-spec)
13. [Epics Overview & MVP Cut](#13-epics-overview--mvp-cut)
14. [Risks & Mitigations](#14-risks--mitigations)
15. [Success Metrics & Acceptance](#15-success-metrics--acceptance)
16. [Rollout & Sequencing](#16-rollout--sequencing)
17. [Open Questions & Decisions](#17-open-questions--decisions)

---

## 1. Overview & Context

### 1.1 The problem

Futurator-Admin can already migrate a brownfield app into the factory (Story 15.4: clone-via-PAT, mirror to EC2, register in DynamoDB as `kind='brownfield'`). What it **cannot** do today is tell the operator _what is wrong with that app and what to do about it_. A migrated app like `applicator` arrives as a swamp — 659 source files, three parallel editor systems each reinventing the same context architecture, a 1,799-line `AWSProfileStorage` god-object with 44 public methods and 38 importers, a duplicated/forked design system, and explicit `-v2`/`v1`/`enhanced`/`hierarchical` version markers strewn across 32 `profile*` directories. No human can read 659 files to localize the real refactors.

The **Refactoring Assessment Module** closes that gap. It gives the operator a UI-triggered **"Assess"** action on a migrated brownfield project that runs a deterministic recon chain on the EC2 clone, surfaces a **severity-ranked hotspot report**, and turns that report into a **draft plan** (epics/stories) that flows into the _existing_ epic/story dev pipeline.

### 1.2 The shape of the solution (validated, not speculative)

The whole module is **report-only → create-plan. It never auto-edits code.** The only thing in the factory allowed to mutate code is the existing dev pipeline, behind test gates. This is a deliberate constraint (see §2.2 and the "proper fix over shortcut" / no-test-safety discipline), not a phase-1 limitation.

The pipeline is **layered, cheapest-and-deterministic first, expensive-and-agentic last** — the _Token law_: _you only pay an LLM for a judgment a deterministic tool cannot make._ Each layer shrinks the surface the next layer pays for.

| Layer                       | Tool class                                             | LLM cost           | Job                                                                | Status                      |
| --------------------------- | ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------ | --------------------------- |
| L0 — Tooling census         | deterministic, seconds                                 | ~0                 | does eslint/prettier/knip/strict-tsconfig exist?                   | concept                     |
| L0.5 — File-role map        | deterministic                                          | ~0                 | tag every file `source`/`test`/`config`/`generated`/`fixture`      | concept                     |
| L1 — Clutter classification | knip / tsc / prettier                                  | ~0                 | classify + **propose**, never delete (Type-A dead code)            | shipped feed                |
| L2 — Graph build (recon)    | graphify + alias-resolve                               | bounded (AST/math) | god-nodes, communities-vs-folders, duplicate clusters, fan-in hubs | **built & validated**       |
| L3 — Agentic adjudication   | `/assess-codebase` dynamic workflow, N parallel agents | the only big spend | adversarially verify L2 findings; plan extract→repoint→delete      | **validated on applicator** |
| L4 — Judge → plan           | single agent                                           | small              | fuse, severity-rank, emit dev-pipeline stories                     | validated                   |

### 1.3 Two-engine recon — built and validated

The L2 recon is two complementary engines, chained deterministically by `daemon/scripts/refactor-recon/recon.mjs`:

1. **graphify = shape.** AST-only directed graph → god-objects, communities-vs-folders, cohesion, ownership out-degree. Built a 4,307-node / 7,952-edge graph of `applicator` in ~1 min for **0 LLM tokens** (`refactoring-recon-experiment-applicator.md`).
2. **alias-resolver + knip = usage.** `daemon/scripts/refactor-recon/alias-resolve.mjs` recomputes the import graph from source with tsconfig `paths` resolution → trustworthy fan-in, design-system hub detection, and (∩ knip) high-confidence dead code.

**Why the second engine is non-negotiable (the validated false-negative trap):** raw graphify reports `button.tsx` in-degree **1**, but it is actually imported by **~115** files — graphify does not resolve `@/…` aliases (~77% of applicator's imports). `alias-resolve.mjs` corrects in-degree **1 → 115** (exact ground truth, `alias-resolve.mjs:5-9`, `hotspot-detect.mjs:44-46`), flipping the design-system verdict from false to correct and revealing that applicator has a _duplicated_ design system to consolidate (not a missing one to build). **Inbound fan-in / hub / dead-code reads are only valid after alias resolution.**

The fused detector (`hotspot-detect.mjs`) emits five hotspot kinds — `god-object`, `duplicate-subsystem`, `design-system-consolidation`, `low-cohesion-split`, `dead-code` — each with `severity`, `score`, `files`, `evidence`, and a `suggestedAction`, written to `graphify-out/hotspots.json` plus a human `REPORT.md`.

### 1.4 L3 adversarially verifies the deterministic detector

The deterministic detector is fast but fallible. The L3 `/assess-codebase` dynamic workflow fans out **one read-only `version-adjudicator` agent per hotspot** (~6 agents, _not_ 4,307 files) to **independently confirm each finding from the code before it reaches a plan**. This is not a rubber stamp — in the validated `applicator` run it **overruled** the detector: the detector flagged `src/components/primitives` as part of a "triplicated design system" (a filename collision: `button`/`card`/`badge`); the adjudicator read the code, found `primitives` is a separate CV-export rendering layer (`var(--cv-*)` inline styles, an `exportButton()` HTML generator) consumed only by `section-wrapper.tsx`, and **rejected the finding** — merging it would have broken static CV export (`applicator-assessment-plan.md:13-20`). _That adversarial check is the reason L3 exists._

### 1.5 It rides Story 15.4 substrate — a new job kind, not a new system

The module adds **exactly one new agent-job kind, `refactor-audit`**, to the existing daemon/agent-jobs/events substrate. No new service, no new infrastructure.

| Capability                                                                  | Reused for                            | Mechanism                                                        |
| --------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| Brownfield clone on EC2 (`/home/ubuntu/projects/<slug>`)                    | the tree recon runs against           | Story 15.4 / party-bootstrap                                     |
| `futurator-agent-jobs` DDB table (PK `jobId`, GSI `status-createdAt-index`) | enqueue the audit; daemon FIFO pickup | `agent-jobs-repository.ts`; no schema migration (DDB schemaless) |
| Daemon poll → dispatch by `jobType`                                         | run `recon.mjs` headless              | `job-router.mjs` `selectHandler`; new handler branch             |
| `futurator-agent-events` (7-day TTL) + `GET /api/agent-jobs/:id/events`     | live UI progress (`assess.*` events)  | reuse as-is, no new stream endpoint                              |
| Epic/story dev pipeline (writes tests, runs `npm run ci`)                   | **the fixer** — the only code mutator | `import-plan` / `apply-plan` seam                                |

The five concrete edit sites are: the `jobType` union + payload (`functions/shared/types/agent-orchestrator.ts:340-366`), the enqueue endpoint `POST /api/party/projects/:id/assess` (mirroring the refresh handler, `functions/api/index.ts:6905-6977`), the router branch (`daemon/pipelines/job-router.mjs:64-81`), the daemon handler `executeRefactorAuditJob` (modeled on `executeScorecardAssessJob`), and a durable findings table (one-per-concern, since the events TTL is 7 days). **Deploy note:** the API/site half ships via `sst deploy`; the daemon half ships via `scripts/rsync-daemon.sh` — two independent ships. **RESOLVED 2026-06-23:** the recon scripts were relocated into `daemon/scripts/refactor-recon/` (`git mv`, single canonical copy), so they now ride the existing `rsync-daemon.sh` (`daemon/` tree) automatically — no deploy-script change. The remaining EC2 prerequisite is runtime deps only (python `import graphify` + `npx knip`).

### 1.6 What is built vs. what this PRD scopes

| Built / validated                                                                                  | This PRD scopes (to build)                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `recon.mjs`, `alias-resolve.mjs`, `hotspot-detect.mjs`, `graphify-build.py`                        | Epic A hardening (knip parse, calibration config)             |
| `applicator` end-to-end run (recon → L3 → 3-workstream plan)                                       | Epic B: `refactor-audit` job kind + daemon handler            |
| The `/assess-codebase` L3 workflow + `version-adjudicator` (validated, overruled a false positive) | Epic C: persist it as a saved workflow + tool-scope the agent |
| Story 15.4 brownfield/daemon/agent-jobs/events substrate                                           | Epic D: Assess trigger + hotspot dashboard + Create-plan      |
|                                                                                                    | Epic E: characterization-net gate + dev-pipeline execution    |

**MVP (v0) = A + B + D** — operator clicks Assess, sees a correct severity-ranked report, clicks Create plan. Epic C upgrades "report" to "adjudicated plan"; Epic E closes the loop to fixes.

---

## 2. Goals & Non-Goals

### 2.1 Goals

| #   | Goal                                                                                                                                               | Success measure                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **One-click assess on a migrated brownfield project.** Operator triggers a full deterministic recon from the Labs UI with no shell.                | `POST /api/party/projects/:id/assess` enqueues a `refactor-audit` job; UI shows live `assess.*` progress; terminal `assess.completed` renders the report.                                       |
| G2  | **Correct severity-ranked hotspot report.** Two-engine recon produces trustworthy hotspots, grouped by workstream.                                 | On `applicator`: `button.tsx` fan-in ≥ 100, design-system verdict "hub present"; no `route.ts ×N` false positives; dead-code count reflects real knip ∩ zero-fan-in (not the under-counted ~1). |
| G3  | **L3 adversarially verifies before anything reaches a plan.** A deterministic finding contradicted by code is dropped/flagged, not passed through. | The `primitives` false-positive (or its equivalent) is rejected by the adjudicator; only verified findings enter the plan.                                                                      |
| G4  | **Report → draft plan, zero auto-fix.** One click compiles the report into draft epics/stories ingestible by `create-story`/`dev-story`.           | "Create plan" produces a valid `planOutput` JSON (passes `validatePlanOutputJson`); **never** writes to the assessed code tree.                                                                 |
| G5  | **Near-zero recon cost.** L0–L2 deterministic; LLM spend only at L3, bounded by hotspot count (~6), not file count (~4,000).                       | Recon < 3 min on a 700-file repo at 0 LLM tokens (Epic A1 AC2); L3 fan-out width = hotspot count.                                                                                               |
| G6  | **Rides the existing substrate.** No new service; reuse agent-jobs, events stream, and the dev pipeline.                                           | New `jobType` + handler + one durable table only; no new Lambda, no new event-stream endpoint.                                                                                                  |
| G7  | **Deletion is always test-gated and graph-verified.** The fix is a sequenced Strangler-Fig (extract → repoint → delete), each step provably safe.  | Generated plans order deletions after extract/repoint; a characterization net gates any deletion on no-test apps (Epic E1).                                                                     |

### 2.2 Non-Goals

| #   | Non-Goal                                                                                                                                                         | Rationale                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NG1 | **No auto-fix / no autonomous code mutation by the module.**                                                                                                     | Report-only → Create plan. LLM refactors ship ~1.75× more logic errors; every refactor must be verified by tests, not eye. The dev pipeline is the _only_ code mutator. |
| NG2 | **No deletion on the recon path.** L1 classifies and _proposes_; it never deletes.                                                                               | knip false-positives on dynamic imports / string registries / route conventions make blind deletion roulette on a no-test app.                                          |
| NG3 | **Not multi-tenant; no per-token cost engineering.**                                                                                                             | Single-operator factory on the Max subscription. No per-tenant isolation, no Bedrock/managed-token migration.                                                           |
| NG4 | **Not a new pipeline or reducer.** The audit does not touch the plan reducer, wave-reducer, or daemon dispatch beyond its one handler branch.                    | It's a new job _kind_, not a new system.                                                                                                                                |
| NG5 | **Durable Mycelium graph is NOT written on intake.** Only graphify (disposable recon) runs during assessment.                                                    | Embedding dead code on intake pollutes the permanent record with the very code L1–L3 is about to delete; the durable graph is populated _after_ adoption.               |
| NG6 | **No new agent-job statuses.** Reuse `PENDING→RUNNING→COMPLETED\|FAILED`.                                                                                        | Avoids touching the state-machine helpers; an audit is not wave-merge/epic-dev (do not trigger `triggerWaveReduce`).                                                    |
| NG7 | **Security/Sentinel scanning is out of scope for v0.**                                                                                                           | Infra extractors are 15–30% built; v0 is structural refactoring assessment only. Deterministic security scans graduate later.                                           |
| NG8 | **No syncing recon artifacts to `futurator-ai-website`.** Artifacts live only in `<projectPath>/graphify-out/` on the EC2 clone (or the durable findings table). | Deploy-safety (CLAUDE.md): that bucket hosts the public homepage.                                                                                                       |

### 2.3 Guiding principles (binding constraints carried from the briefing)

1. **Token law** — pay an LLM only for a judgment a deterministic tool cannot make.
2. **Adversarial verification** — the agentic layer must not trust the deterministic layer; it verifies and may overrule (the `primitives` case is the proof and a named requirement).
3. **Find, don't fix** — enforced _mechanically_: the `version-adjudicator` subagent is tool-scoped to Read/Grep/Glob/Bash with **no Write**.
4. **No-rollback = danger** — every change rides a git branch in small, resumable batches; deletion is graph-verified + grep-zero + test-gated.
5. **Two-graph discipline** — graphify (recon, disposable) now; durable Mycelium only after adoption.

---

## 3. Users & Personas

This is a **single-operator factory** (Labs tenancy is internal). There is exactly one human persona; the rest are system actors the persona orchestrates. The UX target is _one operator, in the Labs UI, who never touches a shell on EC2._

### 3.1 Primary persona — The Operator (factory pilot)

| Attribute                       | Detail                                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Who**                         | The single technical operator running the Futurator factory. Authenticated via Identity Broker (Bearer JWT); `c.get('user').userId` stamps every job's `createdBy`.                                                                                                          |
| **Goal**                        | Take a just-migrated brownfield app from "swamp" to "structured, tested, adopted" — without reading 659 files or running tools by hand.                                                                                                                                      |
| **Mental model**                | "I migrated it. Now tell me what's wrong, rank it by danger, and give me a plan I can run through the pipeline I already trust."                                                                                                                                             |
| **Surface**                     | The Labs brownfield **App detail** view — an "Assess" tab/action (mirrors the Plan Retrospect / Reality-Check pattern: trigger → live stream → severity cards → push-to-plan). Static-export UI: state via `?appId=…&tab=assess` query params, never dynamic route segments. |
| **What they decide**            | When to assess; which workstream/hotspot to turn into a plan; the rigor of the resulting plan. They do **not** decide deletions by hand — the plan + dev pipeline + tests do.                                                                                                |
| **Constraints they live under** | One non-terminal Plan per App at a time; recon runs on the EC2 clone, never the homepage bucket; cost stays ~$0 until L3.                                                                                                                                                    |
| **Pain today**                  | No visibility into a migrated app's structure; manual recon requires SSH + running three scripts; no path from "this is a mess" to "here are ordered, safe stories."                                                                                                         |

### 3.2 System actors (orchestrated by the Operator, not separate users)

| Actor                                                            | Role                                                                                                                                      | Tool scope / authority                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recon engine** (`recon.mjs` + graphify + alias-resolve + knip) | Deterministic L0–L2. Runs headless on the EC2 clone for a `refactor-audit` job.                                                           | Read-only against the clone; writes only to `<projectPath>/graphify-out/`. 0 LLM tokens.                                                      |
| **`version-adjudicator`** (L3 subagent)                          | Adversarially verifies each hotspot from the code; plans extract→repoint→delete.                                                          | **Read/Grep/Glob/Bash only — NO Write.** "Find, don't fix" enforced mechanically. Queries the resolved graph via MCP, not grep-only fallback. |
| **L4 Judge** (single agent)                                      | Fuses verdicts into a severity-ranked plan; emits dev-pipeline stories.                                                                   | Read-only; output is a `planOutput` JSON, not code.                                                                                           |
| **Daemon**                                                       | Polls `futurator-agent-jobs`, dispatches `refactor-audit`, runs the recon child process, emits `assess.*` events, writes terminal status. | Runs on EC2 `i-0826d68c316ae97dd`; the recon child is a plain Node process, **not** a Claude spawn (0 tokens, no OAuth).                      |
| **Dev pipeline**                                                 | Executes the created plan: writes tests, runs `npm run ci`, performs extract→repoint→delete grep-gated.                                   | **The only actor permitted to mutate the assessed code**, and only behind test gates.                                                         |

### 3.3 Explicit non-personas

- **No end users / no multi-tenant customers.** The assessed apps are internal factory inventory, not products with their own users.
- **No reviewers / approvers other than the Operator.** There is no review board; machine-checkable gates (tests, grep-zero, adversarial verify) are the supervisory layer, by design.

---

## 4. User Journeys

The end-to-end arc is **migrate → assess → report → create-plan → fix**. The module owns _assess → report → create-plan_; migrate (Story 15.4) and fix (dev pipeline) are reused.

### 4.1 Journey overview

```
[Story 15.4]        [THIS MODULE]                                   [dev pipeline]
 migrate    →   assess   →   report   →   create-plan        →        fix
 (clone EC2)  (recon job)  (hotspots)  (draft epics/stories)   (extract→repoint→delete,
                            adjudicated                          test-gated, grep-zero)
```

### 4.2 Journey 1 — Migrate (precondition, reused)

The operator has already migrated the brownfield app via Story 15.4: cloned via PAT, mirrored to a bare repo at `/home/ubuntu/repos/<projectId>.git`, checked out to `/home/ubuntu/projects/<slug>`, and registered in DynamoDB with `kind='brownfield'`. **No module work here** — it is the precondition that gates the Assess action (`project.kind === 'brownfield'` and `project.path` exists).

### 4.3 Journey 2 — Assess (the trigger)

| Step | Operator action                                                                                                                                    | System behavior                                                                                                                                      | Contract / file ref                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | Opens the brownfield app's Labs detail view, clicks **"Assess"** (gated like `hasSourceTab`: `githubRepoUrl` OR `boilerplateType+bootstrappedAt`). | UI `POST /api/party/projects/:id/assess`.                                                                                                            | mirror `…/refresh` `index.ts:6905-6977`                                                                  |
| 2    | —                                                                                                                                                  | API validates brownfield-only (400 `INVALID_FOR_GREENFIELD` otherwise), guards `PROJECT_BUSY` (409), enqueues a PENDING job.                         | `createJob({status:'PENDING', jobType:'refactor-audit', refactorAuditPayload:{projectId, projectPath}})` |
| 3    | —                                                                                                                                                  | Returns **202 `{jobId, projectId}`**. UI stashes `jobId`, begins polling.                                                                            | async-enqueue idiom                                                                                      |
| 4    | Watches a live log.                                                                                                                                | Daemon `getOldestPendingJob` picks it up, flips `RUNNING`, spawns `recon.mjs` as a **plain Node child** in `cwd=projectPath`.                        | `daemon/agent-daemon.mjs` dispatch; recon is **not** a Claude spawn (0 tokens)                           |
| 5    | Sees stages stream: graphify → knip → alias-resolve → hotspot-detect.                                                                              | Daemon emits `assess.started` → `assess.step.started/output` (one per stage) → terminal `assess.completed{hotspotCount}` or `assess.failed{reason}`. | `pushEvent`; consumed via `GET /api/agent-jobs/:id/events` (no new endpoint)                             |

**Edge handling:** graphify not importable → `recon.mjs` exits 2; degenerate build → exits 3; the daemon surfaces these as `assess.failed` with the specific message, not a generic crash. A killed run **resumes** without rebuilding the graph (`recon.mjs --skip-graphify` when `graph.json` is fresh).

### 4.4 Journey 3 — Report (read the verdict)

The operator lands on a **severity-ranked hotspot dashboard** (mirrors the Reality-Check card pattern: count chips + expandable rows, inline-style CSS-var dialect, severity-token coloring).

- Hotspots render from `hotspots.json`: `kind`, `severity` (critical/high/medium/low), `score`, `files`, `evidence`, `suggestedAction`, **grouped by workstream**.
- For `applicator` (the validated reference), the report shows: **design-system-consolidation** (the forked `profile-editor/components/ui` → canonical `src/components/ui`, `button.tsx` fan-in 115), **god-object** (`AWSProfileStorage`: 44 methods, 38 importers, 12 dead, cohesion 0.026), **duplicate-subsystem** (`-v2`/`v1`/`hierarchical`/`enhanced` version-marker files; three parallel editor engines), and **dead-code** (knip ∩ zero resolved fan-in).
- **Evidence is a reference, never a dump** — each row cites `file:line` / fan-in counts / community id, never pasted code (matches the scorecard discipline).
- If L3 (Epic C) has run, the dashboard reflects the **adjudicated** view: the `primitives` mis-flag is shown as _rejected by the adjudicator_ (would break CV export), demonstrating the adversarial gate to the operator.

### 4.5 Journey 4 — Create plan (the report-only → plan seam)

This is the hard boundary: the module produces a **plan draft**, never an edit.

| Step | Operator action                                                                     | System behavior                                                                                                                                          | Contract                                                                                                         |
| ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1    | Clicks **"Create plan"** on a workstream/hotspot (or the whole adjudicated report). | The report (L4 plan, or hotspots if pre-C) is compiled into a `planOutput` JSON tree.                                                                    | `planOutputSchema` (`plan-output-schema.ts:129`) — local `E#/S#` ids, `touchPoints`, ≥1 criterion per story      |
| 2    | —                                                                                   | A fresh brownfield **`kind:'change'`** Plan is created, then `POST /api/plans/:id/import-plan` materializes epics/stories.                               | rides concept→start→execute→fix→deploy spine; **not** `apply-plan` on a started plan (destructive, concept-only) |
| 3    | —                                                                                   | Stories are sequenced as a **Strangler-Fig**: extract → repoint → delete, each deletion ordered _after_ its extract/repoint and gated grep-zero.         | `applicator` reference: WS1 (orphan deletes) → WS2 (design-system) → WS3 (god-object split, characterize first)  |
| 4    | —                                                                                   | Validation rejects bad plans: cross-ref errors, touch-point hygiene (no lockfiles/tsconfig/absolute paths), or zero-`needsBrowser` coverage on a UI app. | `validatePlanOutputJson` chain                                                                                   |

**Guarantee:** "Create plan" **never auto-edits code** (Epic D3 AC; "proper fix over shortcut"). It writes plan/epic/story DDB rows only — the assessed code tree is untouched until the dev pipeline runs.

### 4.6 Journey 5 — Fix (handed to the trusted pipeline)

The plan rides the **existing** dev pipeline — the module designs no retry logic and no mutation engine.

1. **Characterization net first (Epic E1).** Before any deletion/repoint story runs, a thin app-level Playwright net over the 3–4 routes that matter is required (the `applicator` WS3-S1 pattern). Depth scales with impact.
2. **Execute (Epic E2).** Stories flow through `start → wave execution → VQA → fix-loop → deploy`. Each step: writes a test, runs `npm run ci`, performs extract→repoint→delete with a final grep-zero check + typecheck/knip/build between steps.
3. **Self-correction is free.** The plan inherits the dev pipeline's fix-loop (auto fix-forward `wave-vqa-fix` stories, `FIX_CYCLE_HARD_CAP` per wave, exhaustion → attention item). The module specifies _only_ whether audits use the default cap or a "never auto-fix, always escalate" policy.
4. **Outcome.** The app emerges structured + tested + adopted — at which point (and only then) the durable Mycelium graph is built, and re-validated against a fresh graphify run forever after.

### 4.7 Re-run / idempotency

Re-running Assess on the same app is safe (recon overwrites `graphify-out/`; `--skip-graphify` resumes). Re-running **Create plan** produces a _new_ `change` plan each time — and because of the one-non-terminal-Plan-per-App rule, the prior plan must reach a terminal state first (`getActivePlanForApp`). The durable findings table (one-per-concern) preserves audit history beyond the 7-day events TTL so the dashboard can render a past report without re-running recon.

---

## 5. Functional Requirements

The Refactoring Assessment Module adds a UI-triggered **"Assess"** action to a migrated brownfield project that runs a **deterministic recon chain** on the EC2 clone, surfaces a **severity-ranked hotspot report**, and turns it into a **plan draft** that flows into the existing epic/story dev pipeline. **Report-only → Create plan. No auto-fix.** It rides the Story 15.4 substrate as a new agent-jobs job kind `refactor-audit` — not a new system (`docs/epics-refactoring-module.md:15-19`).

Requirements are grouped: **Recon (FR1–FR8)** · **Job/daemon (FR9–FR17)** · **Event/status (FR18–FR23)** · **L3 workflow (FR24–FR29)** · **UI (FR30–FR34)** · **Plan-handoff (FR35–FR39)**.

### 5.1 Recon toolchain (Epic A) — built & validated

The recon chain is **two engines**: `graphify` for _shape_ (modules, god-objects, cohesion) and `alias-resolve.mjs` + `knip` for _usage_ (fan-in, dead code, design-system hub) (`docs/epics-refactoring-module.md:21-24`).

| #       | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence / file:line                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **FR1** | A single command `node daemon/scripts/refactor-recon/recon.mjs <repo> [--src src] [--skip-graphify]` MUST chain graphify (AST, directed) → `knip --reporter json` → `alias-resolve.mjs` → `hotspot-detect.mjs` with zero manual steps.                                                                                                                                                                                                                            | `recon.mjs:8`, `:45-69`                                 |
| **FR2** | The runner MUST write **up to six** artifacts to `<repo>/graphify-out/` — five always (`graph.json`, `graph.resolved.json`, `resolved-imports.json`, `hotspots.json`, `REPORT.md`) plus `knip.json` **only when knip is available** (best-effort; skipped non-fatally per FR6). Acceptance tests MUST assert the five-always set, NOT exactly-six. `hotspots.json` is the machine contract the UI (FR32) and L3 (FR24) consume; `REPORT.md` is the human summary. | `recon.mjs:23,72-86`                                    |
| **FR3** | Recon MUST resolve `@/…` tsconfig path-alias imports before computing fan-in, so usage reads are correct on alias-heavy repos (applicator is ~77% aliased). Validated benchmark: `button.tsx` resolved in-degree MUST read ≥100 (graph-raw shows ~1), and the design-system verdict MUST be "hub present".                                                                                                                                                        | `alias-resolve.mjs:6-12`, `recon.mjs:66`; `epics:41-42` |
| **FR4** | `hotspots.json` MUST carry `{ counts: {<kind>: <n>}, hotspots: [{ kind, severity, score, title, files, evidence, suggestedAction }] }`, ranked by `score` descending. Severity buckets MUST be: `score ≥ 80 → critical`, `≥ 55 → high`, `≥ 30 → medium`, else `low`.                                                                                                                                                                                              | `hotspot-detect.mjs:56-57`, `recon.mjs:76,78-79`        |
| **FR5** | Hotspot kinds MUST be: `god-object`, `duplicate-subsystem`, `design-system-consolidation`, `low-cohesion-split`, `dead-code`.                                                                                                                                                                                                                                                                                                                                     | `hotspot-detect.mjs:13-14`                              |
| **FR6** | The dead-code feed MUST robustly parse `knip --reporter json` across knip versions and cross-check each unused file against resolved fan-in 0, labelling each `safe-candidate` (fan-in 0) vs `needs-review`. knip unavailability MUST be non-fatal (dead-code category skipped, recon continues).                                                                                                                                                                 | `epics:39`; `recon.mjs:56-63`                           |
| **FR7** | Framework-convention filename excludes (`route.ts`, `page.tsx`, `index.ts`, …) and the UI-directory rollup MUST be externalized to a calibration config so other frameworks can tune them. There MUST be no `route.ts ×N` / `page.tsx` false positives, and UI-component duplicates MUST roll up under `design-system-consolidation`.                                                                                                                             | `epics:43-44`                                           |
| **FR8** | `hotspot-detect.mjs` MUST read fan-in from `resolved-imports.json` hubs (`resolved_in_degree`), preferring `graph.resolved.json` over `graph.json`, and MUST use `.links` / `.relation` — never raw graph in-degree (the validated false-positive fix).                                                                                                                                                                                                           | `hotspot-detect.mjs:31-46,50-53`                        |

### 5.2 `refactor-audit` job kind + daemon (Epic B)

The audit runs headless on the EC2 clone via the existing daemon/agent-jobs substrate. It is a **new `jobType`** following the reflector / scorecard-assess template — not the legacy `pipeline.steps` path and not `phase==='epic-dev'`.

| #        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Edit site                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **FR9**  | Add `'refactor-audit'` to the `AgentJob.jobType` union and a `refactorAuditPayload?: { projectId: string; projectPath: string; src?: string; skipGraphify?: boolean; runL3?: boolean; topN?: number }` field (mutually-exclusive payload convention). The type MUST be the full superset per §8.1 — `runL3`/`topN` gate the Epic C adjudication and MUST NOT be omitted from the type even though Epic B ignores them.                                                                                                                                                                                                                 | `functions/shared/types/agent-orchestrator.ts:366` (union), `:379-499` (payload, near `partyRefreshPayload`) |
| **FR10** | Expose `POST /api/party/projects/:id/assess`, auth-protected (below the `app.use('/api/*')` gate — NOT in the public allow-list), modeled on `POST /…/refresh`. It MUST: param-validate `:id`, load + 404 (`NotFoundError`), guard `kind==='brownfield'` (400 `INVALID_FOR_GREENFIELD`), guard `PROJECT_BUSY` (409 via `hasProcessingSession`), then `createJob({ status:'PENDING', workingDir: project.path, jobType:'refactor-audit', refactorAuditPayload })` and return **202 `{ jobId, projectId }`**.                                                                                                                            | `functions/api/index.ts:6905-6977` (refresh template)                                                        |
| **FR11** | Add a Zod `assessProjectParamsSchema` (and any body schema) validated via `.safeParse()`; reject with `ValidationError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `functions/shared/schemas/party-schema.ts:179-181` (refresh-param template)                                  |
| **FR12** | The audit is **read-only**: it MUST require no exclusive `bmadStatus` lock (a read-only audit rides the `PROJECT_BUSY` session guard; no new `ASSESSING` enum state).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `party-schema.ts:10-18`; finding §gotchas                                                                    |
| **FR13** | `daemon/pipelines/job-router.mjs` MUST add `export const JOB_HANDLER_REFACTOR_AUDIT='refactor-audit'`, a `selectHandler` branch placed **before** the `phase==='epic-dev'` check, and a `validateRefactorAuditJob(job)` requiring `jobId` + `payload.projectId` + `payload.projectPath`.                                                                                                                                                                                                                                                                                                                                               | `job-router.mjs:46,64-81,201-211`                                                                            |
| **FR14** | `daemon/agent-daemon.mjs` MUST import the handler constant + the new runner, add an `else if (handler===JOB_HANDLER_REFACTOR_AUDIT)` dispatch branch, and add `executeRefactorAuditJob(job)` modeled on `executeScorecardAssessJob`. The handler MUST set `status:'RUNNING'` at entry and own the terminal `COMPLETED`/`FAILED` writeback via `updateJobFields`.                                                                                                                                                                                                                                                                       | `agent-daemon.mjs:60-84,6228-6259,6860-6958`                                                                 |
| **FR15** | A new `daemon/pipelines/refactor-audit-job-runner.mjs` MUST be a **pure, dependency-injected module** mirroring `scorecard-assess-job-runner.mjs` **for its lifecycle/dep-injection skeleton ONLY — NOT its agent-spawn body** (the scorecard runner spawns a Claude agent via `spawnGateAgent`; recon must be a plain Node child — see FR16). Provide `validateRefactorAuditJob`, `buildAssessEvent`, `runRefactorAuditJob(job, deps)` where `deps.runRecon` spawns `recon.mjs` as a plain Node child in `projectPath`, streams chunks to `deps.pushEvent`, then reads `graphify-out/hotspots.json` + `REPORT.md` and returns counts. | `scorecard-assess-job-runner.mjs:1-41,322-492`                                                               |
| **FR16** | Recon MUST run as a **plain Node child process** (`spawn(process.execPath, [reconPath, projectPath, …])`, registered via `registerChild(jobId, proc)` for kill-on-timeout) — **never** routed through `runAgent`/`spawnGateAgent` (Epic B is ~0 LLM tokens; an agent spawn would burn OAuth and hit the auth circuit-breaker).                                                                                                                                                                                                                                                                                                         | `agent-daemon.mjs:1793-1799`; finding §gotchas-3                                                             |
| **FR17** | The runner MUST assert `projectPath.startsWith(PARTY_PROJECTS_ROOT)` and `existsSync(projectPath)` before running recon, where `PARTY_PROJECTS_ROOT = process.env.PROJECTS_ROOT \|\| '/home/ubuntu/projects'`. Recon writes **only** to `<projectPath>/graphify-out/` and MUST NOT touch `s3://futurator-ai-website/` (deploy-safety).                                                                                                                                                                                                                                                                                                 | `agent-daemon.mjs:3663`; `party-refresh.mjs:44-48`; CLAUDE.md                                                |

### 5.3 Event stream + status lifecycle (Epic B3)

| #        | Requirement                                                                                                                                                                                                                                                                                                                                             | Evidence                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **FR18** | Progress MUST stream through the existing `pushEvent(jobId, stepId, agentId, eventType, data)` (6-digit zero-padded `eventSeq`, 7-day TTL) and be readable via the existing `GET /api/agent-jobs/:id/events?after=&limit=` — **no new stream endpoint**.                                                                                                | `agent-daemon.mjs:641-671`, `functions/api/index.ts:882-894` |
| **FR19** | Event types MUST be: `assess.started{projectId}` → `assess.step.started{step}` / `assess.step.output{step,stream,data}` (one per recon stage: `graphify`, `knip`, `alias-resolve`, `hotspot-detect`) → terminal `assess.completed{hotspotCount, counts, reportPath}` \| `assess.failed{reason, message}`, following the `party.bootstrap.step.*` shape. | `party-bootstrap.mjs:449-473`; finding §contracts            |
| **FR20** | The status lifecycle MUST reuse the existing `AgentJobStatus` enum unchanged: `PENDING → RUNNING → COMPLETED \| FAILED`. No new statuses; the audit MUST NOT set `phase:'epic-dev'` and MUST NOT trigger `triggerWaveReduce`.                                                                                                                           | `agent-orchestrator.ts:19-32`; finding §gotchas-3,8          |
| **FR21** | Recon MUST be idempotent/resumable: a re-run MUST pass `--skip-graphify` when `graphify-out/graph.json` exists and is fresh, so a killed run resumes without rebuilding the graph.                                                                                                                                                                      | `recon.mjs:22,51`; `epics:54-55`                             |
| **FR22** | A missing `graphify` python (`recon.mjs` exit 2) or a degenerate graphify build (`graphify-build.py` exit 3) MUST surface as `assess.failed` with the specific message — not a generic crash.                                                                                                                                                           | `recon.mjs:47,50,52`; `epics:38`                             |
| **FR23** | `classifyAgentForSpend` MUST learn `'refactor-audit'` (e.g. its own class or `pipeline-v2`) so the per-job spend row is not mis-bucketed to `other`.                                                                                                                                                                                                    | `agent-daemon.mjs:6392-6401`                                 |

### 5.4 L3 assessment workflow (Epic C — fast-follow)

The saved `/assess-codebase` dynamic workflow **adversarially verifies** the deterministic detector before any finding reaches a plan (it overruled the `primitives` false-positive in testing).

| #        | Requirement                                                                                                                                                                                                                                                                                      | Evidence                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **FR24** | The validated `/assess-codebase` workflow MUST persist to `.claude/workflows/`, read `hotspots.json` (top-N), and emit a sequenced plan with ordered `dependsOn` stories; the applicator run is the reference output.                                                                            | `epics:61-62`                                                            |
| **FR25** | The adjudicator MUST be a tool-scoped read-only `version-adjudicator` subagent (Read / Grep / Glob / Bash, **no Write**), making "find, don't fix" mechanical. It MUST query the resolved graph via `.links` / `.relation` / `resolved_in_degree` (not raw in-degree, not a grep-only fallback). | `epics:63-64`; `hotspot-detect.mjs:32-53`                                |
| **FR26** | Each finding MUST pass an **independent adversarial verifier** that confirms it from code before it reaches the plan; a deterministic finding contradicted by code MUST be dropped or flagged, never passed through.                                                                             | `epics:65-66`                                                            |
| **FR27** | The adjudicator MAY query the Mycelium graph MCP (read-only allowlist: `query_graph`, `get_node`, `neighbors`, `blast_radius`, `god_nodes`, `orphans`, `shortest_path`, gated `MYCELIUM_MCP=on`) or `search-cascade` for evidence gathering.                                                     | `daemon/lib/mcp-config.mjs:35`; `daemon/scripts/search-cascade.mjs:1-20` |
| **FR28** | The L3 stage, if run, MUST be a **second, optional** daemon stage after recon — gated like scorecard-assess — and MUST NOT be a prerequisite for the MVP report (Epics A/B/D ship without it).                                                                                                   | `epics:26-27,57-59`                                                      |
| **FR29** | Judge output MUST map to the existing epic/story pipeline format (FR37) so generated stories are ingestible by `create-story` / `dev-story`.                                                                                                                                                     | `epics:67-68`                                                            |

### 5.5 UI: hotspot report + Create-plan (Epic D — MVP)

The Assess surface lives as a tab/button on the brownfield project detail view — **never** a new route (static-export constraint).

| #        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **FR30** | Add an **"Assess" trigger** to the brownfield project surface, gated by the dual brownfield predicate (`githubRepoUrl` OR (`boilerplateType && bootstrappedAt`)). The trigger MUST `POST …/assess`, stash the returned `jobId`, and render live progress via `StoryLiveOutput` (which wraps the events stream). Disabled state MUST show a `blockReason` title (gated-button pattern).                                                                                                                                                                                                                                                                                                                                                                                            | `app-detail-view.tsx:81,103-136`; `retrospect-rail.tsx:91-100`; `new-plan-cta.tsx` |
| **FR31** | A new `src/hooks/use-app-audit.ts` MUST mirror `use-scorecard.ts`: `useAppAudit(appId)` GET (queryKey `['app-audit', appId]`) + `useRunAppAudit(appId)` POST returning a discriminated union `{ status:'assessing', jobId } \| { status:'scored', hotspots }`. The hook MUST use the canonical backend routes (§9): `useRunAppAudit` POSTs `/party/projects/:appId/assess` (FR10 enqueue) and `useAppAudit` reads the durable record via `/refactor-audits/:auditId` (§9.5), with `/party/projects/:appId/audits` (§9.4) for history; the `:appId` path param IS the project id. The job MUST be polled via `useAgentJob`, whose `refetchInterval` self-terminates on `COMPLETED`/`FAILED`/error. API paths MUST NOT be `/api`-prefixed (the client base already ends in `/api`). | `use-scorecard.ts:9-12`; `use-agent-job.ts:16-24`; `api-client.ts`                 |
| **FR32** | A **severity-ranked hotspot dashboard** MUST render `hotspots.json`: per-kind count chips (red/amber by severity) in a header + expandable hotspot rows (kind, severity, score, files, evidence, suggested action), grouped by workstream (design-system-consolidation, god-objects, legacy, dead-code), drill-down to files, ranked severity-descending. It MUST reuse the `reality-check-card.tsx` `CriterionRow` / `VERDICT_TONE` pattern and the inline-style + CSS-var dialect of the dashboard views.                                                                                                                                                                                                                                                                       | `reality-check-card.tsx:17-22,52-232`; `epics:74-75`                               |
| **FR33** | Findings MUST cite an **evidence reference** (`file:line`) — never paste/dump code (holds the same line as Retrospect).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `scorecard.ts:29`; finding §prdImplications-4                                      |
| **FR34** | A new `AuditHotspot` type MUST be mirrored on **both** sides (`src/types/*.ts` ← → `functions/shared/types/*.ts`), reusing the Verdict/severity shape (severity bucket + score + evidence ref + suggested action).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | finding §gotchas (type-mirror discipline)                                          |

### 5.6 Plan handoff: report-only → Create plan (Epic D3)

The report-only → plan seam. **Never auto-edits code.**

| #        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **FR35** | A **"Create plan"** action (per-hotspot or batch) MUST compile selected hotspot(s) into a `PlanOutput` JSON tree and open `NewPlanModal` with a pre-filled `intent`, reusing `useCreatePlanForApp` → `router.push(links.plan(...))`. One click MUST produce **draft stories** and MUST NEVER auto-edit code.                                                                                                                                                                                                                                                                                           | `epics:76-77`; `new-plan-modal.tsx:31,47-76`; `use-apps.ts:111-126`                             |
| **FR36** | `NewPlanModal` MUST accept an optional `initialIntent` prop (currently `intent` is internal `useState`) so the audit can seed it; submit path is otherwise unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `new-plan-modal.tsx:31`                                                                         |
| **FR37** | The Create-plan output MUST conform to `planOutputSchema`: `{ plan: { name (kebab, matches regex), description (≥20 chars), epics: [{ id:'E1', title, goal, dependsOn (earlier epics only), stories: [{ id:'S1', dependsOn (earlier stories same epic only), touchPoints (real relative paths or `<EPIC_WIDE>`), criteria: [{ id, text, needsBrowser, verify }] }] }] } }`, and MUST pass `validatePlanOutputJson` (schema → cross-ref → touch-point-hygiene → visual-coverage).                                                                                                                       | `plan-output-schema.ts:129,185-222`; `plan-generation-service.ts:97`                            |
| **FR38** | Injection point: the audit MUST create a **fresh Plan** then `POST /api/plans/:id/import-plan` (or a `kind:'change'` brownfield plan for a live shipped app). It MUST NOT use `apply-plan`/`import-plan` on an already-started plan (destructive, concept-only — the 2026-06-17 "2 done → 0/14" incident). The single-active-plan-per-App rule means a prior plan MUST reach a terminal state before re-running an audit.                                                                                                                                                                              | `index.ts:1981,2695,2779`; `plan-repository.ts:223`                                             |
| **FR39** | Refactor stories MUST use **real existing relative paths** (brownfield clause) and `<EPIC_WIDE>` for genuinely cross-cutting refactors so waves serialize correctly; touch-points MUST NOT claim infra/config files (`package.json`, `tsconfig`, lockfiles, absolute/`..` paths) or the whole plan is auto-rejected. For UI-bearing apps the plan MUST emit ≥1 `needsBrowser` AC per rendering story or set `rigor:'prototype'`. Once on the pipeline, the audit inherits the existing fix-loop (FIX_CYCLE_HARD_CAP, auto fix-forward, retry-exhausted attention items) for free — no new retry logic. | `plan-output-schema.ts:159-183`; `plan-generation-service.ts:137`; finding §prdImplications-D,E |

---

## 6. Non-Functional Requirements

### 6.1 Determinism

| #        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **NFR1** | The recon chain (Epic A/B) MUST be fully deterministic: the same repo at the same commit MUST produce byte-stable `hotspots.json` counts and severity ranking across runs. No LLM, no sampling, no wall-clock-dependent ordering in the detector.                                                                                                                                                                                    | `recon.mjs:6`; `epics:21-24`   |
| **NFR2** | The two engines MUST remain separable and individually verifiable: graphify (shape) and alias-resolve+knip (usage) each produce a standalone artifact (`graph.resolved.json` vs `resolved-imports.json` / `knip.json`) so a regression in one is attributable. The validated benchmark — `button.tsx` resolved fan-in ≥100 and zero `route.ts`/`page.tsx` false positives — MUST be re-asserted by an automated test on each change. | `recon.mjs:2-6`; `epics:41-44` |

### 6.2 Token economy — 0-LLM recon

| #        | Requirement                                                                                                                                                                                                                                                       | Evidence                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **NFR3** | Epic A/B recon MUST consume **~0 LLM tokens** — it is a plain Node child process and MUST NOT spawn a Claude agent. Any non-zero LLM cost for an audit MUST come only from the optional Epic C L3 adjudication stage.                                             | `recon.mjs:6,10`; finding §gotchas-3          |
| **NFR4** | LLM cost enters **only** at Epic C and only on operator opt-in; the deterministic recon report (Epics A/B/D) is shippable value at zero LLM cost. As a single-operator factory on the Max-subscription path, there are no per-token / multi-tenant cost concerns. | `epics:26-27,104`; finding §prdImplications-H |

### 6.3 Performance budgets

| #        | Requirement                                                                                                                                                                                                                                                                            | Evidence                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **NFR5** | A full recon MUST complete in **< 3 minutes on a 700-file repo** (validated against applicator).                                                                                                                                                                                       | `recon.mjs` / `epics:37` (A1 AC2)                     |
| **NFR6** | Re-runs MUST skip graphify when `graph.json` is fresh (`--skip-graphify`), so an incremental re-audit avoids the most expensive stage. The daemon child MUST be killable on timeout via `registerChild`.                                                                               | `recon.mjs:51`; `agent-daemon.mjs:1799`               |
| **NFR7** | UI polling MUST self-terminate: the agent-job `refetchInterval` MUST stop on `COMPLETED`/`FAILED`/error (fast 1s while running, slow when stable) — no infinite 404 loops. The events stream MUST drain via paginated `?after=&limit≤500` with a single final catch-up after terminal. | `use-agent-job.ts:16-24`; `use-agent-events.ts:32-73` |

### 6.4 Security / read-only

| #         | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **NFR8**  | The audit MUST be mechanically **read-only**: recon writes only to `<projectPath>/graphify-out/` on the EC2 clone; the Epic C `version-adjudicator` agent MUST have **no Write tool**. The dev pipeline is the only code mutator, and only after a test-gated plan. No path of the audit may edit source.                                                                                                                                                        | `epics:63,103`; FR16, FR25                                |
| **NFR9**  | The audit MUST NEVER write to `s3://futurator-ai-website/` (the 2026-04-15 homepage-overwrite incident). The admin app deploys only via `sst deploy`; recon artifacts reach the UI only through the events stream or a scoped read endpoint.                                                                                                                                                                                                                     | CLAUDE.md (DEPLOY SAFETY); finding §gotchas-4             |
| **NFR10** | `POST /api/party/projects/:id/assess` MUST be auth-protected (Bearer JWT vs Identity Broker JWKS; sits below the `app.use('/api/*')` gate, NOT in the public allow-list). `createdBy` MUST come from `c.get('user').userId`. CORS MUST remain at the Lambda Function URL — **no** Hono CORS middleware.                                                                                                                                                          | `auth-middleware.ts`; `index.ts:452-460`; CLAUDE.md       |
| **NFR11** | `refactor-audit` requires **zero new AWS infrastructure** for enqueue/progress (reuses `futurator-agent-jobs` + `futurator-agent-events`, already PITR-protected and IAM-linked). If durable audit history beyond the 7-day events TTL is adopted, it MUST be a **new dedicated DDB table** (`futurator-refactor-audits`, PAY_PER_REQUEST, PITR, one-table-per-concern — never single-table), linked to the Api Lambda with its env name threaded to the daemon. | `sst.config.ts:215-229`; finding §prdImplications (infra) |

### 6.5 Observability / events

| #         | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Evidence                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **NFR12** | Every recon stage MUST emit a step event (`assess.step.started` / `assess.step.output` / terminal `assess.completed` \| `assess.failed`) so the operator sees live, per-stage progress. `eventSeq` MUST be the daemon's 6-digit zero-padded monotonic seq — never hand-rolled.                                                                                                                                                                                                                                                                                                                                                                                                             | FR18–FR19; `agent-daemon.mjs:650`; finding §gotchas-1 |
| **NFR13** | The agent-events table has a **7-day TTL**; therefore a long-lived audit report (the Create-plan source per FR35/Epic D3) MUST be persisted to a durable home (the plan tree itself, or a dedicated audit table per NFR11) — never relied on from the events stream alone.                                                                                                                                                                                                                                                                                                                                                                                                                 | `agent-daemon.mjs:664`; finding §gotchas-7            |
| **NFR14** | Per-job cost MUST be attributable: the spend row MUST be classified by the new `refactor-audit` class in `classifyAgentForSpend`; failure to wire it silently mis-buckets cost forensics to `other`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `agent-daemon.mjs:6392-6401`; FR23                    |
| **NFR15** | **Deploy-ordering observability**: the API/site half ships via `sst deploy`, the daemon half via `scripts/rsync-daemon.sh` + restart. These are independent ships; a `refactor-audit` job enqueued before the daemon is rsynced will sit `PENDING` indefinitely. The daemon and its required runtime deps — a python with `import graphify`, and `npx knip` resolvable in the clone — MUST be confirmed present on the EC2 box **before** the API endpoint is exposed. **RESOLVED 2026-06-23:** the recon scripts now live under `daemon/scripts/refactor-recon/`, so they ship with the daemon tree via `rsync-daemon.sh`; the only remaining prerequisite is the two runtime deps above. | finding §gotchas-1,2,6; `rsync-daemon.sh`             |

### 6.6 Accessibility

| #         | Requirement                                                                                                                                                                                                                                                                                                                               | Evidence                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **NFR16** | Severity MUST NOT be conveyed by color alone: each hotspot row MUST pair its color chip with a text label (critical/high/medium/low) and/or count, using semantic CSS tokens (`--success`, `--warning`, `--destructive`, `--text-faint`) — never hardcoded hex — so it works in dark/light mode and for color-vision-deficient operators. | `reality-check-card.tsx:17-22`; finding §patterns                       |
| **NFR17** | All trigger and action controls (Assess, per-stage Run/Re-run, Create plan) MUST be real `<button>`s with disabled+`title=blockReason` states, keyboard-operable, and carry `data-testid` hooks for Playwright smoke coverage (mirrors the Retrospect rail).                                                                              | `retrospect-rail.tsx:91-100,191-205`; `new-plan-cta.tsx`                |
| **NFR18** | The hotspot dashboard MUST expose drill-down via accessible expand/collapse (the `CriterionRow` collapsible pattern) with discernible labels for each evidence `file:line` reference; dense layout is hand-rolled (no DataTable/charting primitive exists) and MUST remain navigable without a pointer.                                   | `reality-check-card.tsx:92-232`; finding §gotchas (no table/chart libs) |

---

## 7. System Architecture & Integration

The Refactoring Assessment Module is **a new job kind on the existing Labs agent-jobs substrate, not a new service**. It rides the Story 15.4 brownfield clone, the EC2 daemon, the `futurator-agent-jobs` / `futurator-agent-events` tables, and the existing event-stream API. No new AWS infrastructure is required for the MVP (Epics A/B/D); a new durable results table is added only when L3 plans must outlive the 7-day events TTL (§8).

### 7.1 End-to-end flow

```
Operator clicks "Assess" (brownfield app card)
  │
  ▼  POST /api/party/projects/:id/assess          [functions/api/index.ts, new route after :6977]
  │  validate brownfield + project.path → createJob({ jobType:'refactor-audit', status:'PENDING', … })
  │  → 202 { jobId, projectId }
  ▼
futurator-agent-jobs (PENDING)                    [GSI status-createdAt-index FIFO pickup]
  │
  ▼  daemon poll loop claims oldest PENDING        [daemon/agent-daemon.mjs getOldestPendingJob]
  │  job-router.selectHandler(job) → JOB_HANDLER_REFACTOR_AUDIT
  ▼
executeRefactorAuditJob(job)                       [agent-daemon.mjs, new; modeled on executeReflectorJob :6658]
  │  updateJobFields(RUNNING) → emit assess.started
  ├─ STAGE B (deterministic, ~0 LLM): runRecon → node recon.mjs <projectPath>
  │     graphify(AST,directed) → knip → alias-resolve → hotspot-detect
  │     writes <projectPath>/graphify-out/{graph.resolved.json, resolved-imports.json, hotspots.json, knip.json, REPORT.md}
  │     stream stdout/stderr → pushEvent(assess.step.output)
  │  emit assess.completed { hotspotCount, counts, reportPath }
  ├─ (Epic C, fast-follow) STAGE L3: /assess-codebase adjudication over hotspots.json (top-N)
  │     N parallel version-adjudicator agents (read-only) → adversarial verify → Judge → PlanOutput JSON
  │     persist to futurator-refactor-audits
  │  updateJobFields(COMPLETED | FAILED)
  ▼
UI polls GET /api/agent-jobs/:id/events           [existing, functions/api/index.ts:882]
  │  renders live log + severity-ranked hotspot dashboard
  ▼
Operator clicks "Create plan"
  │  → POST /api/plans/:id/import-plan (or kind:'change' brownfield plan)  [existing dev-pipeline seam]
  ▼
existing epic/story dev pipeline executes (test-gated). REPORT-ONLY → CREATE PLAN. NO AUTO-FIX.
```

### 7.2 The five integration edit-sites (and the one new file)

| #   | File                                                                                                 | Change                                                                                                                                                                                                                            | Grounding                                                       |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `functions/shared/types/agent-orchestrator.ts`                                                       | Append `\| 'refactor-audit'` to the `jobType` union (currently ends :366 `scorecard-assess`); add `refactorAuditPayload?` field next to `partyRefreshPayload` (:379–384)                                                          | jobType discriminated union is the canonical add-a-kind pattern |
| 2   | `functions/shared/schemas/agent-orchestrator-schema.ts` + `functions/shared/schemas/party-schema.ts` | Add `assessProjectParamsSchema` (mirror `refreshProjectParamsSchema`); `.safeParse()` in the route                                                                                                                                | project convention: validate with `.safeParse()`                |
| 3   | `functions/api/index.ts`                                                                             | New `POST /api/party/projects/:id/assess` immediately after the refresh route (:6905–6977 is the exact template)                                                                                                                  | auth-gated automatically by `app.use('/api/*')` (:452–460)      |
| 4   | `daemon/pipelines/job-router.mjs`                                                                    | `export const JOB_HANDLER_REFACTOR_AUDIT = 'refactor-audit'` (~:46); a `selectHandler` branch placed **before** the `phase==='epic-dev'` check (~:78); `validateRefactorAuditJob(job)` mirroring `validatePartyRefreshJob` (:173) | dispatcher is pure; jobType checked before phase                |
| 5   | `daemon/agent-daemon.mjs`                                                                            | Import the handler const (:60–84 block) + the runner (~:197); add the dispatch else-if in `runJobAsync` (:6228–6259); add `executeRefactorAuditJob`; add `'refactor-audit'` to `classifyAgentForSpend` (:6392–6401)               | terminal status writeback is the handler's responsibility       |
| NEW | `daemon/pipelines/refactor-audit-job-runner.mjs`                                                     | Pure module with injected deps (`runRecon`, `pushEvent`, `readArtifacts`, `writeAttentionItem`), mirroring `scorecard-assess-job-runner.mjs`                                                                                      | every effect injected; unit-testable without spawn/DDB          |

**Hard requirement — wire all five together in one ship.** A jobType added to the `.ts` type without a router branch silently falls through to `JOB_HANDLER_LEGACY` (router :80), which expects `pipeline.steps`, and the job is mis-run as a legacy pipeline and fails confusingly. Adding the router branch without the daemon dispatch leaves the job PENDING forever.

### 7.3 Deterministic recon vs LLM stages — engine boundary

The recon stage (Epic B) is a **plain Node child process, not a Claude spawn**. It MUST NOT route through `runAgent`/`spawnGateAgent`, or it will (a) burn OAuth budget on a 0-token job and (b) trip the auth circuit-breaker poll-gate (`agent-daemon.mjs:7427`). Use the detached-pgroup `spawn` pattern (`agent-daemon.mjs:1793`) with `registerChild(jobId, proc)` for kill-on-timeout, `cwd = projectPath`. The LLM cost enters **only at Epic C** (the `/assess-codebase` adjudicators). `scorecard-assess-job-runner.mjs` is the correct template for the **lifecycle/dep-injection skeleton only** — its agent-spawn body is the wrong template for the deterministic recon.

### 7.4 MCP / graph-as-lens (Epic C only)

The L3 `version-adjudicator` queries the resolved graph through the Mycelium read-only MCP (`daemon/lib/mcp-config.mjs`, gated `MYCELIUM_MCP=on`): allowlisted tools `query_graph / get_node / neighbors / blast_radius / god_nodes / orphans / shortest_path`. When the MCP is off, the adjudicator falls back to `daemon/scripts/search-cascade.mjs` (GraphRAG → wiki → grep → raw read) and the on-disk `graph.resolved.json`. The MVP recon stage needs neither.

### 7.5 Dev-pipeline seam (report-only → create-plan)

The module is a **new producer at the front of the existing plan pipeline** — it touches neither the reducer nor the daemon's dev path. The "Create plan" action compiles findings into the `planOutputSchema` JSON tree (`functions/shared/schemas/plan-output-schema.ts:129`) and submits via `POST /api/plans/:id/import-plan` (for a fresh plan) or a `kind:'change'` brownfield plan (for an already-shipped app). It then rides `start → execute → fix-loop → deploy` for free. It MUST NOT use `apply-plan`/`import-plan` to append to an already-`developing` plan (destructive, concept-only; the 2026-06-17 "2 done → 0/14" incident). The audit never calls a mutation engine — the test-gated dev pipeline is the only code mutator.

### 7.6 Deploy & operational constraints (binding)

1. Two ship surfaces, ordering matters: the API/types change ships via **`sst deploy`**; the daemon runner + recon scripts ship via **`scripts/rsync-daemon.sh`** + daemon restart. Ship the daemon first, or accept transient PENDING jobs.
2. Recon writes ONLY to `<projectPath>/graphify-out/` on the EC2 clone. **NEVER** sync artifacts to `s3://futurator-ai-website/` (deploy-safety, CLAUDE.md). Surface artifacts to the UI via the events stream or a scoped read endpoint.
3. Infra deploys to the **production stage only** (`sst.config.ts:45–54` guard — tables are not stage-namespaced).
4. Do NOT add Hono CORS middleware — CORS is at the Function URL (`sst.config.ts:1211–1222`).
5. **Deploy-packaging prerequisite (RESOLVED 2026-06-23):** `recon.mjs` and its siblings now live under `daemon/scripts/refactor-recon/` (relocated via `git mv` — option (b), but a _move_ not a copy, so it stays a single canonical source). They ride the existing `rsync-daemon.sh` (which syncs the whole `daemon/` tree with `--delete`) automatically — no deploy-script change. The daemon runner resolves recon at `daemon/scripts/refactor-recon/recon.mjs` (path relative to the daemon, stable). **Remaining EC2 runtime deps (operator-owned, must exist before B2 runs):** a Python with `import graphify` (`graphifyy`) and `npx knip` resolvable against the brownfield clone.

### 7.7 Concurrency & spend classification

`daemon/lib/concurrency-manager.mjs` classifies by `jobType` and defaults unknown types to `'batch'` (:206) — a new kind works out of the box. Recommended: keep `refactor-audit` in the `batch` class (it is long-running, deterministic, non-interactive). Add it explicitly to `classifyAgentForSpend` (`agent-daemon.mjs:6392`) or its spend row silently buckets to `'other'`. A `refactor-audit` job is **not** wave-merge/epic-dev, so it MUST NOT trigger `triggerWaveReduce` (only fires for those two handlers at `:6294`).

---

## 8. Data Model & DDB Schema Changes

DynamoDB is schemaless and the agent tables key only on `jobId` (+ `eventSeq` for events), so **adding the `refactor-audit` kind requires zero infra migration**. The only new table is the durable audit-results store, added when Epic C plans must persist beyond the events TTL.

### 8.1 `AgentJob` extensions (`functions/shared/types/agent-orchestrator.ts`)

Add the jobType literal and a mutually-exclusive payload (convention: each jobType carries exactly one payload field).

```ts
jobType?:
  | …existing…
  | 'scorecard-assess'
  | 'refactor-audit';                 // NEW (append to union, currently ends :366)

/** Refactoring Assessment Module — recon (Epic B) + optional L3 adjudication (Epic C). */
refactorAuditPayload?: {
  projectId: string;                  // PartyProject id (FK; enables cascade-delete wiring)
  projectPath: string;                // EC2 clone path; == AgentJob.workingDir; recon <repo> arg
  src?: string;                       // source subdir (default 'src')
  skipGraphify?: boolean;             // resume: reuse existing fresh graph.json (B3)
  runL3?: boolean;                    // Epic C gate: run /assess-codebase adjudication after recon
  topN?: number;                      // hotspots passed to L3 (default 40, matches hotspot-detect --top)
};
refactorAuditSummary?: {              // small denormalized summary on the job row (like reflectorProposalCount)
  hotspotCount: number;
  counts: Record<string, number>;     // { 'god-object': n, 'design-system-consolidation': n, … }
  auditId?: string;                   // FK into futurator-refactor-audits (Epic C)
  reportPath: string;                 // <projectPath>/graphify-out/REPORT.md
};
```

Also add `'refactor-audit'` to the daemon-side `PartyJobType` union (`functions/shared/types/party.ts:174`) and mirror `refactorAuditPayload`/`refactorAuditSummary` into `src/types/agent-orchestrator.ts` (the frontend type is a hand-kept mirror).

**Status lifecycle:** reuse the existing `AgentJobStatus` enum verbatim — `PENDING → RUNNING → COMPLETED | FAILED`. No new statuses (avoids touching the state-machine helpers). Only escalate to `NEEDS_ATTENTION` if a recoverable-blocked case is later needed (requires a `JobTriggeredBy` reason).

### 8.2 `futurator-agent-jobs` (existing — reused, no change)

| Attribute                    | Notes                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| PK `jobId`                   | `crypto.randomUUID()`                                               |
| GSI `status-createdAt-index` | hashKey `status`, rangeKey `createdAt` — drives FIFO PENDING pickup |
| required                     | `jobId, status, createdAt, updatedAt, createdBy, workingDir`        |
| `workingDir`                 | = `refactorAuditPayload.projectPath` (the EC2 clone)                |
| **no TTL**                   | grows unbounded                                                     |

**Cascade-delete gotcha:** the jobs table has no TTL. To make `refactor-audit` jobs purge when their app is deleted, add `refactorAuditPayload.projectId` to `agent-jobs-repository.ts` `jobBelongsToApp` (:93–106) and the `ProjectionExpression` (:127–128). Otherwise an audit job becomes an orphan that keeps a deleted app "alive" (a documented bug class in that repo).

### 8.3 `futurator-agent-events` (existing — reused, no change)

`pushEvent(jobId, stepId, agentId, eventType, data)` (`agent-daemon.mjs:641`) writes a row with a **6-digit zero-padded `eventSeq`** range key (`String(n).padStart(6,'0')`, seeded from `loadMaxEventSeq`), 7-day TTL `expireAt`. Always emit via the shared `pushEvent` — never hand-roll seqs (lexical sort breaks pagination). The events endpoint defaults `after='000000'`.

**Proposed event taxonomy** (follows the `party.bootstrap.step.*` shape; reuse generic `eventType` values so they don't fall into the "unattributed" classifier bucket, OR declare them in `AgentEventType`):

| eventType             | data                                                                        | When                         |
| --------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| `assess.started`      | `{ projectId }`                                                             | handler entry, after RUNNING |
| `assess.step.started` | `{ step: 'graphify'\|'knip'\|'alias-resolve'\|'hotspot-detect' }`           | each recon stage             |
| `assess.step.output`  | `{ step, stream:'stdout'\|'stderr', data }`                                 | streamed child chunks        |
| `assess.completed`    | `{ hotspotCount, counts, reportPath, auditId? }`                            | terminal success             |
| `assess.failed`       | `{ reason:'graphify-missing'\|'degenerate-build'\|'recon-error', message }` | terminal failure             |

### 8.4 NEW table `futurator-refactor-audits` (Epic C / durable persistence)

The events stream is ephemeral (7-day TTL); an L3 plan that seeds dev stories needs a durable home. One table per concern (never single-table):

| Field                           | Type                                      | Notes                                             |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| PK `auditId`                    | string (uuid)                             |                                                   |
| GSI `projectId-createdAt-index` | hashKey `projectId`, rangeKey `createdAt` | list audits per app, newest-first                 |
| `jobId`                         | string                                    | FK to the producing AgentJob                      |
| `projectId` / `projectPath`     | string                                    | app linkage                                       |
| `status`                        | `'recon-only' \| 'adjudicated'`           | recon-only (Epic B) vs L3-completed (Epic C)      |
| `counts`                        | map                                       | by hotspot kind                                   |
| `hotspots`                      | list                                      | the `hotspots.json` contract (§11.4)              |
| `verdicts`                      | list                                      | L3 `VERDICT_SCHEMA` results (Epic C)              |
| `plan`                          | map                                       | `PLAN_SCHEMA` / `planOutputSchema` draft (Epic C) |
| `createdAt` / `createdBy`       |                                           |                                                   |

SST: declare with `PAY_PER_REQUEST` + PITR; thread env `REFACTOR_AUDITS_TABLE` to the Api Lambda (read path) and the daemon (write path). Omit this table entirely if the team accepts recon-only MVP with no durable history.

---

## 9. API Surface

All routes sit below the `app.use('/api/*')` auth gate (`functions/api/index.ts:452–460`); none is added to the public allow-list. Success bodies are bare JSON via `c.json(payload, status)`; errors are thrown as `AppError`/`ValidationError`/`NotFoundError` and serialized by `app.onError` to `{ error: { code, message } }` (:13175–13181). Never hand-roll error JSON; never add Hono CORS.

### 9.1 `POST /api/party/projects/:id/assess` — enqueue an audit

Models the refresh route (:6905–6977). Async-enqueue → 202.

**Request:** path param `id` (validated by `assessProjectParamsSchema`, regex `^[a-z0-9][a-z0-9-]{0,63}$`). Optional body:

```json
{ "src": "src", "skipGraphify": false, "runL3": false, "topN": 40 }
```

**Handler logic:**

1. `const projectId = c.req.param('id')`; `safeParse` → `ValidationError` on failure.
2. `getProject(projectId)` → `NotFoundError('PartyProject', id)` if absent.
3. Guard: `project.kind === 'brownfield'` else `400 INVALID_FOR_GREENFIELD`.
4. Guard: `project.path` present else `409 INVALID_STATE`.
5. Guard (optional): `hasProcessingSession(projectId)` → `409 PROJECT_BUSY`. An audit is read-only, so a heavy lock is **not** recommended for MVP; ride the session guard or skip.
6. `createJob({ jobId: crypto.randomUUID(), status:'PENDING', createdAt, updatedAt, createdBy: c.get('user').userId, workingDir: project.path, jobType:'refactor-audit', refactorAuditPayload:{ projectId, projectPath: project.path, src, skipGraphify, runL3, topN } })`.

**Response 202:**

```json
{ "jobId": "uuid", "projectId": "applicator" }
```

| Error           | Code                     | Status |
| --------------- | ------------------------ | ------ |
| bad id          | `VALIDATION_ERROR`       | 400    |
| no such project | `NOT_FOUND`              | 404    |
| greenfield app  | `INVALID_FOR_GREENFIELD` | 400    |
| no clone path   | `INVALID_STATE`          | 409    |
| busy            | `PROJECT_BUSY`           | 409    |

### 9.2 `GET /api/agent-jobs/:id` — job status (existing, reused)

Returns the full `AgentJob` including `status`, `refactorAuditSummary`. `404 NOT_FOUND ('AgentJob')` if absent. UI polls until terminal (stop on `COMPLETED`/`FAILED`).

### 9.3 `GET /api/agent-jobs/:id/events?after=&limit=` — live trace (existing, reused)

(`functions/api/index.ts:882`) `after` default `'000000'`, `limit` clamped `1..500`. Returns `{ events: AgentEvent[], lastSeq: string }`. UI drains paginated `assess.*` events at ~1s while running, single catch-up after terminal. **No new stream endpoint.**

### 9.4 `GET /api/party/projects/:id/audits` — audit history (Epic C, durable)

Reads `futurator-refactor-audits` via the `projectId-createdAt-index`. Returns newest-first list of `{ auditId, status, counts, createdAt }`.

### 9.5 `GET /api/refactor-audits/:auditId` — full audit (Epic C, durable)

Returns the persisted record: `{ auditId, jobId, projectId, status, counts, hotspots[], verdicts[], plan }`. This is what the severity dashboard and the "Create plan" action read.

### 9.6 Create-plan handoff (existing dev-pipeline routes — no new endpoint)

The "Create plan" action compiles the audit into a `planOutputSchema` JSON tree and posts to the **existing** `POST /api/plans/:id/import-plan` (fresh plan) or creates a `kind:'change'` brownfield plan. The audit module adds **no** plan-creation endpoint — it reuses the validated pipeline seam. The produced JSON is validated by `validatePlanOutputJson` (`plan-generation-service.ts:97`) and rejected on cross-ref / touch-point-hygiene / visual-coverage failure (see §12.5).

---

## 10. UI/UX Requirements

> **Scope guardrail (restate from Epic spec, `docs/epics-refactoring-module.md`):** the UI is **report-only → Create plan**. It NEVER edits code, never auto-fixes, and never triggers a fix-loop directly. The only mutating action the UI offers is **Create plan**, which hands off to the existing Plan/Story DEV spine. The Assess feature is a **new job kind on the Story 15.4 brownfield/daemon/agent-jobs substrate**, not a new system — the frontend only **triggers**, **streams**, and **renders**; all analysis is a daemon agent job.

### 10.1 Placement & Routing

| #      | Requirement                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1.1 | The Assess surface MUST live as an **"Assess" tab** on the brownfield App detail view (`src/components/labs/app-detail/app-detail-view.tsx`, `<TabsList>` at L103–110), appended after the existing Overview/Source/Party/Performance tabs. It MUST NOT be a new route.                                          |
| 10.1.2 | Because the app is a static export (`output: 'export'`), per-entity state is carried in **query params only** — deep-link the tab via `?tab=assess`, extending the `tabParam` allow-list at `app-detail-view.tsx` L40–43. NEVER add a `/labs/[appId]/audit` dynamic segment.                                     |
| 10.1.3 | URLs MUST be built through `src/lib/links.ts` helpers (`links.app(appId)`), never hand-concatenated. The Create-plan handoff navigates via `router.push(links.plan(appId, planId) + '&pmJobId=' + pmJobId)` exactly as `new-plan-modal.tsx` does today.                                                          |
| 10.1.4 | The Assess tab MUST be **gated by the same brownfield predicate** used by the Source tab (`app-detail-view.tsx` L81): `githubRepoUrl` OR (`boilerplateType && bootstrappedAt`). Pure-brownfield apps (have `githubRepoUrl`, no `bootstrappedAt`) MUST still show the tab. Greenfield-only apps MUST NOT show it. |

### 10.2 Assess Trigger (on the brownfield card / tab)

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.2.1 | The primary trigger is a single **"Assess" button** modeled on `new-plan-cta.tsx` (gated primary-button pattern): enabled → `variant="default"`; disabled → `variant="outline"` + `title={blockReason}`.                                                                                                                                                    |
| 10.2.2 | On click, the button calls a new mutation `useRunAppAudit(appId)` (new hook `src/hooks/use-app-audit.ts`, mirroring `src/hooks/use-scorecard.ts`) → the canonical enqueue route `POST /party/projects/:appId/assess` (FR10 / §9.1; the `:appId` path param IS the project id) — api-client base already ends in `/api`, so do NOT prefix the path.          |
| 10.2.3 | The response is the existing async-job discriminated union: `{ status: 'assessing', jobId }` (recon enqueued) — mirror `RunScorecardStageResponse` (`src/types/scorecard.ts` L123). On `assessing`, stash `jobId` in local component state and enter the **streaming** state (10.4).                                                                        |
| 10.2.4 | The button MUST be **disabled with an explicit `blockReason`** when: the app is not a readable repo (fails 10.1.4 predicate), or an audit job for this app is already `PENDING`/`RUNNING`. Re-running after a completed audit is allowed (a fresh `jobId`). Reuse the `blockReason` copy pattern from the App detail gating (`app-detail-view.tsx` L69–74). |
| 10.2.5 | Recon is deterministic and **~0 LLM tokens** (`daemon/scripts/refactor-recon/recon.mjs` L6); the trigger copy MUST NOT imply a paid/long LLM run for the recon stage. Target perf budget surfaced to the user: recon completes in **< 3 min on a ~700-file repo** (Epic A1 AC2).                                                                            |

### 10.3 Severity-Ranked Hotspot Dashboard

The dashboard renders `hotspots.json` produced by `recon.mjs` (`<repo>/graphify-out/hotspots.json`), shaped `{ counts: {...}, hotspots: [{ severity, score, title, ... }] }`.

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 10.3.1 | Build the dashboard by mirroring the **Reality Check** analog (`src/components/labs/plan-dashboard/views/retrospect/reality-check-card.tsx` + `retrospect-view.tsx`) — the closest validated pattern. Use the **inline-style + CSS-var dialect** that all `plan-dashboard/views/` files use (NOT Tailwind utility classes), to match the file area.                    |
| 10.3.2 | A **header summary** MUST show count chips by severity (red / amber / grey), mirroring the `CountChip` header in `reality-check-card.tsx` L52–81, populated from `hotspots.json.counts`.                                                                                                                                                                               |
| 10.3.3 | Hotspots MUST be rendered as rows **ranked by severity descending**, then by `score` descending. The severity → theme-token map MUST reuse semantic CSS variables only (never hardcoded hex): 🔴→`var(--destructive)`, 🟡→`var(--warning)`, 🟢→`var(--success)`, ⚪→`var(--text-faint)` (the `VERDICT_TONE` map, `reality-check-card.tsx` L17–22).                     |
| 10.3.4 | Each row MUST surface the **two-engine provenance** so the operator can see WHY it's a hotspot: a **shape** signal from graphify (e.g. god-object / low-cohesion / large module) and a **usage** signal from alias-resolve + knip (e.g. fan-in count, dead-code, design-system hub). Display the engine via a small badge per row (mirror the `engine: 'deterministic' | 'assessor'`chip in`ScorecardSlice`). |
| 10.3.5 | Fan-in values MUST be shown from the **alias-resolved** graph, not raw in-degree. The known-good benchmark (Epic A3) is `button.tsx` fan-in ≈ **115**, not 1 — the UI MUST display the resolved number. Route/page false positives (`route.ts`/`page.tsx`) MUST NOT appear as dead-code hotspots (Epic A4).                                                            |

### 10.4 Live Event Streaming States

The audit job streams events via the **existing** `GET /api/agent-jobs/:id/events?after=&limit=500` endpoint (`functions/api/index.ts` L882) — no new stream endpoint. The UI consumes it through `src/hooks/use-agent-events.ts` (or the `StoryLiveOutput` wrapper) and polls terminal status via `src/hooks/use-agent-job.ts`.

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10.4.1 | While `status === 'assessing'`, render the live log by reusing `<StoryLiveOutput jobId={jobId} hideResponse />` (`src/components/labs/agentic-workflow/story-live-output.tsx`) exactly as `retrospect-view.tsx` L185 does. Verify its props (`jobId`, `hideResponse`) before reuse.                                                                                                        |
| 10.4.2 | The stream MUST render the recon stage events emitted by the daemon runner: `assess.started`, `assess.step.started` / `assess.step.output` (one stage each: **graphify → knip → alias-resolve → hotspot-detect**), terminating in `assess.completed { hotspotCount, counts, reportPath }` or `assess.failed { reason, message }`. A per-stage progress indicator (4 steps) is RECOMMENDED. |
| 10.4.3 | Polling MUST **self-terminate**: the `refetchInterval` returns `false` on error and on terminal status (`COMPLETED`/`FAILED`), fast (1–2s) while `RUNNING` — mirror `use-agent-job.ts` L16–24. Infinite 404/poll loops are a documented past incident and are not acceptable.                                                                                                              |
| 10.4.4 | On `assess.completed`, the UI MUST invalidate `['app-audit', appId]` and refetch the persisted result, then transition from the live-log state to the hotspot dashboard (10.3). The dashboard shows when `hotspots.length > 0` OR the job reached `COMPLETED`.                                                                                                                             |
| 10.4.5 | If the recon process exits with the specific failure codes — **exit 2** (python `graphify` package missing) or **exit 3** (degenerate graph build) — the daemon emits `assess.failed` with the specific reason (Epic A1 AC3). The UI MUST render that specific reason (not a generic "failed"). See 10.6.3.                                                                                |

### 10.5 Drill-Down

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.5.1 | Each hotspot row MUST be **expandable** (mirror `CriterionRow`, `reality-check-card.tsx` L92–232) to reveal: the contributing graphify shape metric(s), the alias-resolved usage metric(s), and an **evidence reference**.                                                                                                                                                                                                                                             |
| 10.5.2 | Evidence MUST be a **`file:line` (or graph-node) reference — never a code/data dump** (held line from the Reality Check pattern, `scorecard.ts` L29). The drill-down cites where the issue is; it does not paste source.                                                                                                                                                                                                                                               |
| 10.5.3 | The drill-down SHOULD note that the L3 stage (Epic C, fast-follow) **adversarially verifies** the deterministic detector — i.e., the displayed hotspot is a candidate the L3 adjudicator can confirm or overrule (the validated mechanism that overruled the "primitives" false positive). For MVP (recon-only) this is rendered as the deterministic finding; when L3 results are present, the row MUST show the adjudicated verdict alongside the deterministic one. |
| 10.5.4 | There MUST be **no per-row "Fix" or "Apply" action**. The only actionable control per hotspot (or batch) is **Create plan** (10.7). This enforces report-only.                                                                                                                                                                                                                                                                                                         |

### 10.6 Empty / Loading / Error States

| State                                | Requirement                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Never assessed** (10.6.1)          | Empty state: a short explainer ("Run a deterministic refactor audit — graphify shape + alias/knip usage, ~0 LLM cost") plus the Assess button. No fabricated/zero rows.                                                                                                                                           |
| **Loading existing result** (10.6.2) | While `useAppAudit(appId)` is fetching a previously-stored report, render `ui/skeleton` rows matching the dashboard layout.                                                                                                                                                                                       |
| **Recon failed** (10.6.3)            | On `assess.failed`, show a destructive-toned banner with the **specific reason**: exit 2 → "graphify (python) not available on the build host"; exit 3 → "degenerate graph build — repo may have no resolvable source"; knip failure is **non-fatal** and MUST NOT block the report. Provide a **Re-run** action. |
| **App not ready** (10.6.4)           | If the brownfield predicate (10.1.4) fails (e.g. no `githubRepoUrl` and not bootstrapped), disable Assess and show `blockReason` copy explaining the app must be a readable brownfield repo first.                                                                                                                |
| **Active plan / busy** (10.6.5)      | If the App already has a non-terminal Plan, the **Create-plan** action (not Assess) MUST be disabled with a `blockReason` ("finish or archive the active plan first") — enforced by the single-active-plan-per-App rule (`getActivePlanForApp`). Assessing itself remains allowed (read-only).                    |
| **Stale/expired stream** (10.6.6)    | Events have a 7-day TTL; the durable report is read from the audit store, not the events stream. If a job is `COMPLETED` but events are gone, render the persisted dashboard and omit the live log.                                                                                                               |

### 10.7 Create-Plan Action (the only mutation)

| #      | Requirement                                                                                                                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.7.1 | Provide a **"Create plan"** action — per-hotspot and/or **batch (selected hotspots → one plan)** — modeled on the Reality Check `ImprovementActions` push buttons (`retrospect-view.tsx` L579–594), but wired to a **real** create-plan flow (NOT the local-only stub the Retrospect push currently is).                     |
| 10.7.2 | The action MUST open **`NewPlanModal`** (`src/components/labs/app-detail/new-plan-modal.tsx`) with the `intent` textarea **pre-filled** from the selected hotspot(s). `NewPlanModal` currently sources `intent` from internal `useState` (L31) — it MUST be extended with an **`initialIntent` prop** that seeds that state. |
| 10.7.3 | Submit MUST reuse the existing mutation + navigation unchanged: `useCreatePlanForApp` (`src/hooks/use-apps.ts` L111–126) → `router.push` to the plan dashboard with `&pmJobId=`. The audit feature does NOT introduce a parallel plan-creation path.                                                                         |
| 10.7.4 | The pre-filled `intent` MUST be derived from hotspot evidence (title + `file:line` refs + engine signals), framed as a refactor goal. The PRD-defined defaults: `kind: 'change'` (brownfield refactor on a live app), `rigor` per 10.7.5. Single-hotspot → one plan; batch-selected hotspots → one consolidated plan.        |
| 10.7.5 | For UI-bearing target apps, the resulting plan MUST satisfy the **visual-coverage gate** downstream (≥1 `needsBrowser` AC) or default `rigor: 'prototype'`; surface this choice in the modal so the operator picks consciously. (This is enforced server-side; the UI only sets expectations.)                               |
| 10.7.6 | After a plan is created, the originating hotspot(s) SHOULD reflect a **"planned"** state if persisted server-side (10.8). If persistence is deferred, the planned marker is local-only and clearly transient.                                                                                                                |

### 10.8 Persistence of Audit Results (UI contract)

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.8.1 | The dashboard MUST read durable results from the canonical durable routes (§9.4/§9.5), not from the 7-day events stream, so reports survive past TTL: **`GET /refactor-audits/:auditId`** for the full record the dashboard renders, and **`GET /party/projects/:appId/audits`** for history (queryKey `['app-audit', appId]`; api-client base already ends in `/api`, do NOT prefix). |
| 10.8.2 | The audit result type (`AuditHotspot` / report) MUST be **mirrored on both sides** — `src/types/*.ts` (FE) and `functions/shared/types/*.ts` (BE) — per the type-mirror discipline noted in every `src/types` header.                                                                                                                                                                  |
| 10.8.3 | If a hotspot's "planned" state must persist across reloads, it requires a server write (a `POST` on the audit resource); if that endpoint is deferred, the UI MUST treat "planned" as local-only and not imply server persistence.                                                                                                                                                     |

### 10.9 Design-System Reuse (mandatory)

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.9.1 | Use only existing **shadcn/Tailwind primitives** in `src/components/ui/` (dialog, button, card, badge, tabs, table, select, switch, checkbox, input, textarea, label, skeleton, separator, collapsible). There is **no charting / DataTable / syntax-highlighter** primitive — the severity table and any drill-downs MUST be hand-rolled (budget for it).                            |
| 10.9.2 | **Two style dialects coexist** — forms/cards/modals use Tailwind utility classes (match `new-plan-modal.tsx`); dense dashboard views under `plan-dashboard/views/` use inline `style={{...}}` with CSS vars (match `reality-check-card.tsx`). The Assess **trigger/modal** code uses the Tailwind dialect; the Assess **dashboard** code uses the inline-CSS-var dialect. Do not mix. |
| 10.9.3 | All severity/status colors MUST come from semantic tokens (`var(--success \| warning \| destructive \| accent-blue \| accent-purple \| text-mute \| text-dim \| text-faint \| foreground \| border \| bg-elev \| font-mono)`) — never hardcoded hex — so dark/light mode and theme consistency hold.                                                                                  |
| 10.9.4 | Interactive controls (Assess button, Run/Re-run, Create-plan, expand rows) MUST carry **`data-testid`** hooks for Playwright smoke coverage, mirroring `retrospect-rail.tsx` and `retrospect-view.tsx` action buttons.                                                                                                                                                                |

### 10.10 Optional: Pipeline-Strip Integration

| #       | Requirement                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.10.1 | If Assess should appear as a visual pipeline stage, add an `'assess'`/`'audit'` stage to `PIPELINE_STAGES` (`src/components/labs/plan-dashboard/constants.ts` L85–91) and `pipelineStageIndexFor`; `pipeline.tsx` renders it automatically. This is OPTIONAL for MVP — the Assess **tab** (10.1) is the required home; the pipeline strip is a presentation enhancement only. |

---

## 11. Recon Toolchain Spec

The recon chain is **built, validated on `applicator` (659 src files / 4307-node graph), and is the deterministic Stage B engine**. It is a single headless command the daemon invokes. **Two engines, by design:**

- **graphify = shape** (modules, god-objects, communities, cohesion) — out-degree/ownership is trustworthy.
- **alias-resolve + knip = usage** (fan-in, dead code, design-system hub) — corrects graphify's blind spot on alias-heavy code.

### 11.1 One command

```
node daemon/scripts/refactor-recon/recon.mjs <repo> [--src src] [--skip-graphify]
```

`~0 LLM tokens`; target `< 3 min` on a 700-file repo (Epic A1 AC2). Runs in `cwd = <repo>` (the EC2 clone). Writes everything to `<repo>/graphify-out/`.

### 11.2 The chain (`recon.mjs`)

| #   | Stage                                 | Script                                  | Output                                         | Notes                                                                                                                                                                                                                                               |
| --- | ------------------------------------- | --------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | graphify build (AST, directed, 0 LLM) | `graphify-build.py`                     | `graph.json`                                   | networkx node-link; edges under `links` with `.source/.target/.relation`. Removes stale `graph.json` first so the overwrite-guard can't pin an old build. **Exits 3** on a degenerate build (AST worker crash → tiny/edgeless graph); recon aborts. |
| 2   | dead-code feed                        | `npx --no-install knip --reporter json` | `knip.json`                                    | best-effort; knip exits 1 with issues (captured from stdout). Skipped non-fatally if knip unavailable.                                                                                                                                              |
| 3   | alias-resolved fan-in                 | `alias-resolve.mjs`                     | `graph.resolved.json`, `resolved-imports.json` | recomputes the import graph from source through tsconfig `paths`; merges `resolved_in_degree` onto graph nodes by `source_file`.                                                                                                                    |
| 4   | ranked hotspots                       | `hotspot-detect.mjs`                    | `hotspots.json`                                | fuses graph + resolved-imports + knip into one ranked list.                                                                                                                                                                                         |
| 5   | human report                          | (inline)                                | `REPORT.md`                                    | severity-ranked summary + top hubs; ends `_Next: feed hotspots.json to the /assess-codebase L3 workflow_`.                                                                                                                                          |

### 11.3 Why alias-resolution is load-bearing (validated)

graphify (and any naive AST extractor) does **not** resolve `@/…` tsconfig path-alias imports (~77% of applicator's imports). This makes inbound fan-in / dead-code / design-system-hub reads **false** — `button.tsx` showed in-degree **1** while actually imported by **~115** files. `alias-resolve.mjs` resolves the tsconfig `paths` map (JSONC-safe parse, extension + index resolution), keyed by stable `source_file`.

| Requirement           | AC                   | Validated value                                                       |
| --------------------- | -------------------- | --------------------------------------------------------------------- |
| `button.tsx` fan-in   | A3 AC: ≥ 100         | **1 → 115** (exact ground truth)                                      |
| design-system verdict | A3 AC: "hub present" | flipped false → correct; also revealed a **duplicated** design system |

**Rule for any in-house extractor:** resolve tsconfig paths at extraction time, or run this post-processor before any usage/hub/dead-code read. Out-degree/ownership/cohesion are safe without it; inbound fan-in is not.

### 11.4 Hotspot kinds & `hotspots.json` contract (`hotspot-detect.mjs`)

Output: `{ generatedAt, repo, graphifyOutDir, counts: {kind:n}, hotspots: Hotspot[] }` (top-N, default 40). Severity from score: `≥80 critical · ≥55 high · ≥30 medium · else low`.

```ts
type Hotspot = {
  kind:
    | 'god-object'
    | 'duplicate-subsystem'
    | 'design-system-consolidation'
    | 'low-cohesion-split'
    | 'dead-code';
  score: number; // 0–100
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  files: string[]; // file:path evidence, never code dumps
  evidence: Record<string, unknown>;
  suggestedAction: string; // extract→repoint→delete language; never a bare auto-delete
};
```

| Kind                          | Detector                                                                                                                             | Score                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `god-object`                  | class with ≥12 `method` out-edges + importers                                                                                        | `methods*1.2 + importers`           |
| `duplicate-subsystem`         | same basename across dirs with importers; + version-marker paths (`-v2`/`v1`/`enhanced`/`hierarchical`/`legacy`/`old`/`copy`/`_bak`) | `25 + copies*8 + min(40, ΣimP/3)`   |
| `design-system-consolidation` | >1 `components/(ui\|primitives)` dir; canonical = highest aggregate fan-in; UI-component dups roll up here                           | `40 + Σ(dup-dir fan-in)`            |
| `low-cohesion-split`          | community ≥25 nodes, internal/(internal+boundary) cohesion ≤0.12                                                                     | `30 + size/2 + (0.12−cohesion)*200` |
| `dead-code`                   | knip-flagged **∩** zero resolved fan-in (two methods agree)                                                                          | `min(70, 20 + count)`               |

### 11.5 Detector calibration (A4 — validated, prevents false positives)

- **Framework-convention filenames excluded** from duplicate detection (`route.ts`, `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `middleware.ts`, `index.ts/tsx/js`, `sitemap.ts`, `robots.ts`, `opengraph-image.tsx`) — required to repeat, not duplication. **AC: no `route.ts ×N` false positives.**
- **UI-component dups roll up** under `design-system-consolidation` rather than appearing as standalone duplicates.
- **Dead-code safety:** knip false-positives (test tooling flagged as unused devDeps) are why dead-code requires the resolved-fan-in cross-check; `suggestedAction` still says "gate behind a behavioral net; verify no dynamic import via grep." (§12 / no-test discipline.)
- Excludes/UI-rollup are externalized to a calibration config so other frameworks can tune.

### 11.6 Failure & resumability semantics (daemon contract)

| Condition                      | recon behavior                    | daemon maps to                                          |
| ------------------------------ | --------------------------------- | ------------------------------------------------------- |
| graphify not importable        | `exit 2` with install hint        | `assess.failed { reason:'graphify-missing' }`           |
| degenerate build               | `exit 3` (AST worker crash guard) | `assess.failed { reason:'degenerate-build' }`           |
| knip unavailable               | non-fatal; dead-code skipped      | continue; note in `assess.step.output`                  |
| re-run with fresh `graph.json` | `--skip-graphify` reuses it       | resumable run skips the expensive graph rebuild (B3 AC) |

The daemon runner MUST surface exit 2/3 as a specific `assess.failed`, not a generic crash (A1 AC3), and MUST assert `projectPath.startsWith(PROJECTS_ROOT)` and `existsSync(projectPath)` before spawning recon.

---

## 12. L3 `/assess-codebase` Workflow Spec

> **Epic C — fast-follow. Not required for MVP.**

There is **exactly one** Claude Code dynamic workflow in the pipeline, fired at the single spot where fan-out across graph-pinned hotspots is justified. It **adversarially verifies the deterministic detector** before any finding reaches a plan — this is what overruled the `primitives` false-positive in testing. Saved as `.claude/workflows/assess-codebase`, invoked headless by the daemon via `claude -p` after Stage B, gated by `refactorAuditPayload.runL3`.

### 12.1 Token discipline (the reason this exists)

- Fan-out width `N = hotspot count` (~5–6 on applicator: `{ unify-editor-engine, consolidate-profile, merge-generation-pipelines, retire draft-editor-v1, retire EnhancedSectionEditor/hierarchical }`), **not** file count (~4307). The deterministic layers converted "read 4307 functions" into "adjudicate ~5 pre-localized hotspots."
- Intermediate verdicts live in **script variables**, not a context window (kills context-window degradation).
- **Resumable:** if the daemon dies mid-run, completed agents return cached results.
- L0–L2 are deterministic (math + CLI); L4 is a single agent. Only L3 fans out.

### 12.2 Workflow structure (two phases)

```js
export const meta = {
  name: 'assess-codebase',
  description: 'Adjudicate graph-flagged refactoring hotspots in a migrated brownfield app',
  phases: [{ title: 'Adjudicate' }, { title: 'Judge' }],
};
// args = { projectId, hotspots, graphMcp }   ← from the deterministic recon stage (hotspots.json top-N)
```

**Phase 1 — Adjudicate (parallel, N agents).** One `version-adjudicator` per hotspot. Each queries the graph MCP to decide current-vs-superseded version and which functions are shared-core (incoming edges from the kept version), and proposes extract→repoint steps — **never a bare delete of reachable code**. Returns a `VERDICT_SCHEMA`.

**Phase 2 — Judge (single agent).** Fuses verdicts into a severity-ranked plan, sequenced so every deletion is graph-verified safe (extract → repoint → delete). Emits dev-pipeline stories.

### 12.3 Tool-scoped adjudicator subagent (`version-adjudicator`)

"Find, don't fix" is enforced **mechanically**: the subagent is read-only — `Read / Grep / Glob / Bash`, **no `Write`** (C2 AC: the agent cannot modify files). It queries the **resolved** graph, not a grep-only fallback. **Graph-contract gotcha (validated false-positive fix):** read `graph.resolved.json` via `.links` / `.relation` and `resolved_in_degree` — **not** raw in-degree. Benchmark: `button.tsx` fan-in must read ~115, not ~1.

### 12.4 Adversarial-verify gate (C3 — named requirement)

Every deterministic-detector finding gets an **independent verifier** that must confirm it from code before it reaches the plan. A finding contradicted by code is **dropped/flagged, not passed through** (C3 AC). This gate is what overruled the `primitives` false-positive — it is a binding requirement of the L3 stage, not an optimization. Combined with the read-only tool scope, the L3 layer can neither fabricate work nor mutate code.

### 12.5 Output schemas

**Per-hotspot `VERDICT_SCHEMA`:**

```ts
{ kind, currentVersion, supersededVersions[], sharedCore[],
  steps: [{ action: 'extract'|'repoint'|'delete', files[], rationale }],
  confidence, blastRadiusVerified }
```

**`PLAN_SCHEMA` (Judge):** `{ projectId, severityRanked: [{ finding, severity, stories[] }], summary }`.

**Dev-pipeline ingest contract (C4 — the report-only→plan seam):** the Judge output is compiled to the existing `planOutputSchema` (`plan-output-schema.ts:129`) so stories are ingestible by `create-story`/`dev-story`. Mapping rules the L3 plan MUST satisfy or be rejected by `validatePlanOutputJson`:

1. Local `E#`/`S#` ids; epic `dependsOn` references **earlier epics only**; story `dependsOn` references **earlier stories in the same epic only** (cross-epic ordering goes through the epic layer).
2. Each story carries real, existing relative `touchPoints` (brownfield clause), or the `<EPIC_WIDE>` sentinel for genuinely cross-cutting refactors. **Never** claim infra/config files (lockfiles, `package.json`, `tsconfig`, build/test config, absolute/`..` paths) — auto-rejected by `validateTouchPointHygiene`.
3. The Strangler-Fig sequence is emitted as ordered stories: **extract** shared-core → **repoint** kept-version imports → **delete** the proven-orphan remainder. Each step is individually graph-safe.
4. ≥1 acceptance criterion per story. For UI-bearing apps, emit at least one `needsBrowser` AC per rendering story or set `rigor:'prototype'`, or the visual-coverage gate rejects the plan.
5. Evidence is a **ref** (`file:line` / graph path), never a code dump.

### 12.6 Boundaries

The L3 stage **finds and plans; it never fixes**. The trusted, test-gated dev pipeline is the only code mutator (Flag #1: LLM refactors ship ~1.75× more logic errors → verified by tests, not by eye). Before any deletion/repoint story runs, Epic E gates it behind the thin app-level Playwright net (one behavioral net under the whole app, not 4,000 unit tests). Single-operator factory — Max-subscription model path; no per-token/multi-tenant concerns.

---

## 13. Epics Overview & MVP Cut

This module is implemented as five epics that map 1:1 to `docs/epics-refactoring-module.md`. The governing rule across all of them: **report-only → create-plan, never auto-fix.** The only thing in the company allowed to mutate code is the existing test-gated epic/story dev pipeline. The assessment layer _finds_; the dev pipeline _fixes_.

### 13.1 Epic map

| Epic  | Title                                          | Layer (per §1.2)           | Status of substrate                                                                                 | MVP?        |
| ----- | ---------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- | ----------- |
| **A** | Recon toolchain — one-command headless runner  | L0–L2 deterministic        | **Built & validated** (`recon.mjs`, `alias-resolve.mjs`, `hotspot-detect.mjs`, `graphify-build.py`) | A1, A3, A4  |
| **B** | `refactor-audit` job kind + daemon integration | job substrate (Story 15.4) | Substrate exists; job kind net-new                                                                  | B1, B2, B3  |
| **C** | L3 `/assess-codebase` adversarial adjudication | L3 agentic                 | Workflow validated in experiment; not persisted as job                                              | Fast-follow |
| **D** | UI — hotspot report + Create-plan              | Labs frontend + L4         | Analogs exist (Retrospect)                                                                          | D1, D2, D3  |
| **E** | Close the fix loop                             | dev pipeline               | Pipeline exists                                                                                     | Later       |

### 13.2 Epic A — Recon toolchain (two-engine, built & validated)

The two engines are **already built and validated** on `applicator`; Epic A is hardening + packaging, not greenfield.

1. **A1 — `recon.mjs` orchestrator.** Single command `node daemon/scripts/refactor-recon/recon.mjs <repo> [--src src] [--skip-graphify]` chains graphify (AST, directed) → knip → `alias-resolve.mjs` → `hotspot-detect.mjs`, writing `<repo>/graphify-out/{graph.json, graph.resolved.json, resolved-imports.json, hotspots.json, knip.json, REPORT.md}` (`recon.mjs:44-86`).
   - _AC1:_ one invocation produces all six artifacts on `applicator`, zero manual steps.
   - _AC2:_ pure-deterministic (~0 LLM tokens); completes < 3 min on a 700-file repo.
   - _AC3:_ exits non-zero with a specific message when graphify (`exit 2`, `recon.mjs:47`) or the graphify build is degenerate (`exit 3`, `recon.mjs:50`) is missing; idempotent re-run.
2. **A3 — Alias-resolved fan-in (the validated correctness fix).** `alias-resolve.mjs` recomputes the import graph from source through the tsconfig `paths` map, keyed by `source_file`, and merges `resolved_in_degree` onto graph nodes (`alias-resolve.mjs:115-197`). This is the engine that converts the false-negative hub trap (graphify saw `button.tsx` in-degree **1**) into ground truth (**115**).
   - _AC:_ `recon.mjs` on `applicator` reports `button.tsx` fan-in **≥ 100** and design-system verdict = "HUB PRESENT" (`alias-resolve.mjs:182`).
3. **A4 — Detector calibration config.** Externalize framework-convention filename excludes (`route.ts`, `page.tsx`, `index.ts`, `layout.tsx`, …) and the UI-dir rollup, currently hard-coded in `hotspot-detect.mjs` (`CONVENTION` set `hotspot-detect.mjs:75-77`; UI rollup `:114-134`).
   - _AC:_ no `route.ts ×N` false positives; UI-component dups roll up under `design-system-consolidation`, not `duplicate-subsystem`.

> **A2 (deferred to fast-follow):** harden the knip `--reporter json` parser across versions. The current parser is shape-tolerant but under-counts (`hotspot-detect.mjs:169`). Dead-code is the lowest-severity hotspot kind (capped at score 70, `hotspot-detect.mjs:172`) so an under-count degrades gracefully — it does not block MVP.

The two-engine split is load-bearing and must be preserved: **graphify = shape** (god-objects via method out-degree `hotspot-detect.mjs:60-71`; low-cohesion communities `:136-164`); **alias-resolve + knip = usage** (fan-in hubs, dead-code, design-system hub presence). Neither engine alone is correct on alias-heavy TS.

### 13.3 Epic B — `refactor-audit` job kind (new kind, not new system)

A new job `kind` on the **existing** agent-jobs/agent-events/daemon substrate. **Zero new AWS infrastructure** is required for the run/progress path — `futurator-agent-jobs` and `futurator-agent-events` already exist, are PITR-protected, are `link`ed to the Api Lambda (`sst.config.ts:952,996`), and are polled by the daemon.

1. **B1 — Job kind + enqueue API.** Add `'refactor-audit'` to the `jobType` union and a `refactorAuditPayload?: { projectId; projectPath; src?; skipGraphify? }` field at `functions/shared/types/agent-orchestrator.ts` (`jobType` union L340-366, payload near L379). New route `POST /api/party/projects/:id/assess` mirrors the refresh handler exactly (`functions/api/index.ts:6905-6977`): validate brownfield + `project.path`, `agentJobsRepo.createJob({status:'PENDING', workingDir: project.path, jobType:'refactor-audit', refactorAuditPayload})`, return `202 {jobId, projectId}`. Add the Zod param schema in `functions/shared/schemas/party-schema.ts`.
   - _AC:_ enqueue returns a `jobId`; job row carries `jobType`, payload `projectId`/`projectPath`, `status:'PENDING'`.
2. **B2 — Daemon handler runs the recon chain.** Add a pure runner `daemon/pipelines/refactor-audit-job-runner.mjs` mirroring `scorecard-assess-job-runner.mjs`'s dep-injection skeleton (validate/run/buildEvent), wire it via: a `JOB_HANDLER_REFACTOR_AUDIT` const + `selectHandler` branch + `validateRefactorAuditJob` in `daemon/pipelines/job-router.mjs` (~L46/L78); an `executeRefactorAuditJob` + dispatch else-if in `daemon/agent-daemon.mjs` (`runJobAsync` ~L6255); and a `classifyAgentForSpend` branch (`agent-daemon.mjs:6392-6401`). **Recon runs as a plain Node child process (`spawn`/`execFile`), NOT a Claude agent** — it is ~0 LLM tokens and must not touch `spawnGateAgent`/the auth circuit-breaker.
   - _AC:_ an `applicator` audit run end-to-end on EC2 produces `hotspots.json` + `REPORT.md` in the project's `graphify-out/`.
3. **B3 — Event stream + resumability.** Reuse `GET /api/agent-jobs/:id/events` (`functions/api/index.ts:882`) — no new stream endpoint. Emit `assess.started` → `assess.step.started/output` (one per recon stage: graphify/knip/alias-resolve/hotspot-detect) → terminal `assess.completed{hotspotCount, counts}` / `assess.failed{reason}` via the shared `pushEvent` (`agent-daemon.mjs:641-671`). Pass `--skip-graphify` (`recon.mjs:22,51`) when a fresh `graph.json` exists.
   - _AC:_ UI polls the run live; a killed run resumes without rebuilding the graph.

### 13.4 Epic C — L3 `/assess-codebase` adversarial adjudication (fast-follow)

The single official dynamic workflow (§12), fan-out width = hotspot count (~6), not file count (~4000).

1. **C1 — Saved workflow.** Persist `/assess-codebase` to `.claude/workflows/`; reads `hotspots.json` (top-N), emits a sequenced plan.
2. **C2 — Tool-scoped `version-adjudicator` subagent.** Read-only (Read/Grep/Glob/Bash, **no Write**); queries the **resolved** graph via `.links`/`.relation` and `resolved_in_degree` (`hotspot-detect.mjs:46`), never raw in-degree. "Find, don't fix" enforced mechanically by tool scope.
3. **C3 — Adversarial verify gate (named requirement).** Each deterministic-detector finding gets an independent verifier that must confirm from code before it reaches a plan. **This is what overruled the `primitives` false-positive** in the experiment and is the reason L3 exists.
   - _AC:_ a deterministic finding contradicted by code is dropped/flagged, not passed through.
4. **C4 — Plan → dev-pipeline stories.** Judge output maps to `planOutputSchema` (`functions/shared/schemas/plan-output-schema.ts:129`) so it is ingestible by `create-story`/`dev-story`.

### 13.5 Epic D — UI: hotspot report + Create-plan (MVP)

Lives as an **"Assess" tab on the brownfield App detail view** (`src/components/labs/app-detail/app-detail-view.tsx:103-136`) — **not a new route** (static export, no dynamic segments). Built by mirroring the Retrospect/Reality-Check analog.

1. **D1 — "Assess" trigger.** Gated button (model `NewPlanCta`) → `POST …/assess`; stream live progress via `StoryLiveOutput` + `useAgentJob`/`useAgentEvents`, exactly as `retrospect-view.tsx:166-186`.
2. **D2 — Severity-ranked dashboard.** Render `hotspots.json` by descending `score` with `severity` chips (`critical/high/medium/low`, `hotspot-detect.mjs:57`), grouped by `kind`, drill-down to `files` + `evidence`. Reuse `reality-check-card.tsx` (count chips + expandable rows, CSS-var tokens). **Evidence cites file:line/refs, never a code dump** (Retrospect discipline).
3. **D3 — "Create plan" action.** One click compiles selected hotspot(s) into a draft plan via the existing `NewPlanModal` + `useCreatePlanForApp` flow (add an `initialIntent` prop). **Never auto-edits code.**

### 13.6 MVP cut (v0)

```
A1 → A3 → A4          (toolchain hardened — mostly built)
A1 → B1 → B2 → B3     (headless on daemon)
B2 → D1 → D2 → D3     (UI report + Create plan)  ← MVP completes here
hotspots.json → C1 → C2 → C3 → C4   (L3 adjudicated plan — fast-follow)
C4/D3 → E1 → E2        (fix loop — later)
```

**MVP = A1, A3, A4, B1, B2, B3, D1, D2, D3.** The operator clicks Assess, sees a correct severity-ranked report (deterministic, ~0 LLM cost), and clicks Create plan. Epic C upgrades "report" → "adjudicated plan" (adds the only meaningful LLM spend); Epic E closes the loop to test-gated fixes. The recon report alone is shippable value.

---

## 14. Risks & Mitigations

| #   | Risk                                                                                                                                                                                                                                                                                                                          | Severity       | Likelihood | Mitigation                                                                                                                                                                                                                                                                                                                                   | Owner/Epic |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| R1  | ~~**`recon.mjs` not shipped to EC2.**~~ **RESOLVED 2026-06-23** — scripts relocated to `daemon/scripts/refactor-recon/` (`git mv`); they now ship with the `daemon/` tree via `rsync-daemon.sh` automatically. Residual risk reduced to runtime-dep provisioning (graphify/knip).                                             | ~~High~~ → Low | High       | Runner resolves recon at a daemon-relative path; add a startup self-check that `recon.mjs` exists (fail fast). Provision python `import graphify` + `npx knip` on EC2 before B2 runs.                                                                                                                                                        | B2         |
| R2  | **graphify/knip runtime deps absent on EC2.** recon needs a python with `import graphify` (`exit 2`, `recon.mjs:47`) and `npx knip` in the clone (`:57`); `graphify-build.py` exits 3 on degenerate build.                                                                                                                    | High           | Medium     | Provision `graphifyy` (uv/pip) on the daemon EC2 as a prereq; runner maps `exit 2`/`exit 3` to a specific `assess.failed{reason}` (per A1 AC3), not a generic crash. knip is best-effort/non-fatal — dead-code degrades, audit still completes.                                                                                              | B2         |
| R3  | **jobType added without daemon branch → silent fall-through.** Unknown `jobType` falls through to `JOB_HANDLER_LEGACY` (`job-router.mjs:80`) which expects `pipeline.steps`; a refactor-audit job mis-runs as a legacy pipeline and no-ops/fails. The dispatch wiring is a manual step the runner module cannot self-perform. | High           | Medium     | All four edits (import const, import runner, `selectHandler` branch, `runJobAsync` else-if) land in one PR with a `job-router.test.mjs` case asserting `refactor-audit → JOB_HANDLER_REFACTOR_AUDIT`. Never set `phase:'epic-dev'` on the job (selectHandler checks jobType before phase).                                                   | B1/B2      |
| R4  | **Two deploy surfaces, ordering matters.** API/site ships via `sst deploy`; daemon ships via `rsync-daemon.sh` + restart. A job enqueued before the daemon is rsynced sits PENDING forever (the documented scorecard failure mode; the reflector IAM-blocked precedent).                                                      | Medium         | High       | Ship daemon first, then API. Document the ordering in the rollout runbook (§16). Until daemon ships, hide/disable the D1 Assess button behind a feature flag.                                                                                                                                                                                | §16        |
| R5  | **False positives reaching a plan (the `primitives` case).** The deterministic detector flagged `primitives` as duplication; only adversarial verification overruled it. MVP ships D before C — i.e. the human reads the report before any L3 gate exists.                                                                    | Medium         | Medium     | (a) Detector calibration A4 (convention excludes, UI rollup) removes the worst FP class deterministically; (b) D3 produces a **draft** plan the operator reviews — nothing auto-runs; (c) Epic C C3 adds the mechanical adversarial gate as a fast-follow before any unattended path.                                                        | A4/C3/D3   |
| R6  | **Destructive `apply-plan` on a started plan.** `apply-plan`/`import-plan` REPLACE the whole epic tree with fresh UUIDs and hard-refuse unless `plan.status==='concept'` (`index.ts:1981`) — the 2026-06-17 "2 done → 0/14" incident.                                                                                         | High           | Low        | D3/C4 create a **fresh** Plan (or a `kind:'change'` brownfield plan) and apply once at concept status. PRD forbids appending audit stories to an already-developing plan via apply/import.                                                                                                                                                   | D3/C4      |
| R7  | **Touch-point hygiene rejects refactor stories.** Refactor stories edit existing files and often "add a dependency"; `validateTouchPointHygiene` rejects lockfile/`package.json`/`tsconfig`/absolute/`..` paths (`plan-output-schema.ts:159-183`) and rejects the whole plan.                                                 | Medium         | Medium     | C4 producer must emit real existing relative paths (brownfield clause) and `<EPIC_WIDE>` for cross-cutting refactors; never name infra/config files. Story `dependsOn` is same-epic-earlier-only; cross-epic ordering at the epic layer.                                                                                                     | C4         |
| R8  | **Visual-coverage gate rejects UI-app plans.** A UI-bearing app with zero `needsBrowser` ACs is rejected unless `rigor==='prototype'` (`plan-generation-service.ts:137`, enforced `index.ts:2023`).                                                                                                                           | Medium         | Medium     | C4/D3 emit ≥1 idle-visible `needsBrowser` AC per rendering story, or set `rigor:'prototype'` explicitly. Specify which per plan kind.                                                                                                                                                                                                        | C4/D3      |
| R9  | **Deploy-safety: never sync to `futurator-ai-website`.** The 2026-04-15 incident overwrote the homepage `index.html`. Audit artifacts must not reach the public bucket.                                                                                                                                                       | Critical       | Low        | Audit writes ONLY to `<projectPath>/graphify-out/` on the EC2 clone. Findings reach the UI via the events stream or a scoped read endpoint — never `aws s3 sync out/`. Admin deploys only via `sst deploy`.                                                                                                                                  | All        |
| R10 | **Events table 7-day TTL vs durable report.** `futurator-agent-events` expires rows at +7d (`agent-daemon.mjs:664`); `futurator-agent-jobs` has no TTL but grows unbounded. The D3 "Create plan" seam and any audit history need a durable home.                                                                              | Medium         | Medium     | Persist the report summary (counts + `reportPath`) on the job row (small, like reflector's count). If queryable history is needed, add a dedicated `futurator-refactor-audits` table (one-per-concern, PAY_PER_REQUEST, PITR) linked to the Api Lambda — otherwise read `hotspots.json` from the clone via a scoped endpoint. Decide in §17. | B3/§17     |
| R11 | **LLM logic-error rate on refactors (~1.75×, briefing Flag #1).**                                                                                                                                                                                                                                                             | Medium         | Medium     | Read-only adjudication (C2 no-Write); the dev pipeline is the only mutator and is test-gated; Epic E requires a behavioral net before any deletion/repoint runs.                                                                                                                                                                             | C/E        |
| R12 | **Cost-forensics mis-bucketing.** Missing `classifyAgentForSpend` branch sends spend rows to 'other' (`agent-daemon.mjs:6392`); the row is written for every job in `runJobAsync` finally.                                                                                                                                    | Low            | Medium     | Add a `refactor-audit` (or `pipeline-v2`) class in B2.                                                                                                                                                                                                                                                                                       | B2         |

---

## 15. Success Metrics & Acceptance

### 15.1 Correctness (the validated bar)

| #   | Metric                                  | Target                                                                                                                   | Source / how measured                                                           |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| M1  | Alias-resolved fan-in accuracy          | `applicator` `button.tsx` in-degree ≥ 100 (ground truth 115)                                                             | A3 AC; `alias-resolve.mjs:182`                                                  |
| M2  | Design-system verdict correctness       | `applicator` reports "HUB PRESENT" + flags the **duplicate** design system (`profile-editor/components/ui` vs canonical) | D2 render; `design-system-consolidation` hotspot (`hotspot-detect.mjs:121-134`) |
| M3  | No framework-convention false positives | Zero `route.ts ×N` / `page.tsx ×N` duplicate hotspots                                                                    | A4 AC; `CONVENTION` excludes (`hotspot-detect.mjs:75-77`)                       |
| M4  | Dead-code precision                     | Dead-code list = knip-flagged ∩ zero resolved fan-in (two methods agree)                                                 | `hotspot-detect.mjs:170`                                                        |
| M5  | Adversarial-gate efficacy (Epic C)      | The `primitives`-class false positive is dropped/flagged by C3, not passed to a plan                                     | C3 AC                                                                           |

### 15.2 Performance & cost

| #   | Metric                   | Target                                                                                   | Source                                           |
| --- | ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| M6  | Recon wall-clock         | < 3 min on a 700-file repo                                                               | A1 AC2                                           |
| M7  | Recon LLM cost           | ~0 tokens (deterministic only)                                                           | A1 AC2; "token law" (§1.2)                       |
| M8  | L3 fan-out width         | = hotspot count (~6), bounded by upstream deterministic finding — not file count (~4000) | §12.1                                            |
| M9  | Infra cost delta for MVP | $0 new AWS (reuses agent-jobs + agent-events)                                            | reuses existing tables (`sst.config.ts:215-229`) |

### 15.3 End-to-end acceptance (MVP "done")

The MVP is accepted when **all** of the following pass on `applicator`:

1. Operator clicks **Assess** on the brownfield App detail Assess tab; a `refactor-audit` job is enqueued returning `202 {jobId}` (B1).
2. The daemon runs `recon.mjs` headless on the EC2 clone and writes all six artifacts to `graphify-out/` (B2 AC).
3. The UI streams live progress (`assess.started` → per-stage steps → `assess.completed`) via the existing events endpoint, and self-terminates polling on the terminal status (B3).
4. The severity-ranked dashboard renders the four expected `applicator` workstreams — `design-system-consolidation`, `god-object`, `duplicate-subsystem`/legacy, `dead-code` — sorted by score, with file/evidence drill-down and no code dumps (D2).
5. **Create plan** produces draft epics/stories ingestible by the dev pipeline and **does not edit a single line of application code** (D3 AC; "proper fix over shortcut").
6. A killed audit re-run completes without rebuilding the graph (`--skip-graphify`, B3 AC).
7. No artifact is ever written to `s3://futurator-ai-website/` (deploy-safety).

### 15.4 Fast-follow acceptance (Epic C)

8. `/assess-codebase` re-runnable; `version-adjudicator` is mechanically read-only (cannot Write) and queries the **resolved** graph (C2).
9. Generated plan passes `validatePlanOutputJson` (cross-ref + touch-point hygiene + visual coverage) and stories are ingestible by `create-story`/`dev-story` (C4).

---

## 16. Rollout & Sequencing

### 16.1 Tune on the easy patient first

Before pointing the toolchain at `applicator`'s swamp, validate the deterministic layer on a small prototype (~20-file repo, see `refactoring-recon-experiment-reborders.md`) so the pipeline and the target's mess are not two unknowns multiplying. Confirm communities-vs-folders and hub detection tell the truth, then iterate up to `applicator`. **A3/M1 (button.tsx ≥ 100) is the gate** that proves the alias engine before anything ships.

### 16.2 Build order

```
Phase 0  (pre-req)  Provision graphify(python) + knip on daemon EC2;
                    decide & implement recon deploy-packaging (R1)
Phase 1  (Epic A)   Harden recon: A1 → A3 → A4   [mostly built — finish + calibration]
Phase 2  (Epic B)   B1 (types + API + Zod) → B2 (router + runner + daemon wiring
                    + classifyAgentForSpend) → B3 (events + resumability)
Phase 3  (Epic D)   D1 (Assess tab + trigger) → D2 (dashboard) → D3 (Create plan)
                    ── MVP SHIPS ──
Phase 4  (Epic C)   C1 → C2 → C3 → C4   (L3 adjudicated plan; first real LLM spend)
Phase 5  (Epic E)   E1 (characterization net) → E2 (dev-pipeline execution)
```

### 16.3 Deploy ordering (binding — two surfaces)

The API/site and the daemon ship via **independent** mechanisms; a mismatch leaves jobs PENDING forever (R4).

| Step | Surface                       | Mechanism                                        | Guard                                                                             |
| ---- | ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1    | Daemon runner + router branch | `scripts/rsync-daemon.sh` → EC2, restart daemon  | Verify `recon.mjs` resolvable on box; daemon log shows the new handler registered |
| 2    | API route + types + Zod       | `sst deploy` (production stage only)             | Production-only deploy guard (`sst.config.ts:45-54`); never `--stage foo`         |
| 3    | Frontend Assess tab           | `sst deploy` (static export to admin SST bucket) | **Never** `aws s3 sync out/ s3://futurator-ai-website/`                           |

**Rule: ship daemon (step 1) before API/UI (steps 2–3)**, or keep the D1 Assess button behind a feature flag until the daemon is confirmed running. This avoids the documented "enqueue before daemon rsynced → PENDING" failure mode.

### 16.4 Per-epic exit gates

- **A exits** when A1/A3/A4 ACs pass on `applicator` (M1–M3, M6, M7).
- **B exits** when an end-to-end audit on EC2 writes `hotspots.json` + `REPORT.md` and the events stream shows terminal `assess.completed` (15.3 #2–3, #6).
- **D exits** (MVP) when 15.3 #1–7 all pass.
- **C exits** when 15.4 #8–9 pass.

---

## 17. Open Questions & Decisions

| #   | Question                                                                        | Options                                                                                                                                             | Recommendation                                                                                                                                                                                                                                                                                                                     | Status                                             |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Q1  | ~~How does `scripts/refactor-recon/` reach the EC2 daemon box?~~                | (a) extend `rsync-daemon.sh` to ship it; (b) move into `daemon/scripts/`; (c) git-pull the admin repo on the box                                    | **DECIDED 2026-06-23 → (b) as a `git mv`** — relocated to `daemon/scripts/refactor-recon/`, a single canonical copy that ships with the `daemon/` tree via the existing `rsync-daemon.sh` (no deploy-script edit). Beats (a) (no second rsync path / `--delete` interaction) and avoids the duplication that a _copy_ would cause. | **CLOSED**                                         |
| Q2  | **Durable storage for audit reports beyond the 7-day events TTL?**              | (a) summary on job row + read `hotspots.json` from clone via scoped endpoint; (b) new `futurator-refactor-audits` DDB table (one-per-concern, PITR) | (a) for MVP — zero new infra; promote to (b) only if queryable cross-app history is wanted                                                                                                                                                                                                                                         | **Open — needed before D2 persistence**            |
| Q3  | **Concurrency lock on assess?**                                                 | (a) none (audit is read-only); (b) light `PROJECT_BUSY` guard via `hasProcessingSession`; (c) full `tryAcquireRefreshLock`-style lock               | (a)/(b) — a read-only audit needs no exclusive lock; reuse the existing session guard if dedup is wanted. Do **not** add an `ASSESSING` bmadStatus (closed enum)                                                                                                                                                                   | **Decide in B1**                                   |
| Q4  | **Where does the L3 LLM call run?**                                             | (a) daemon Claude CLI (Max subscription, out-of-band creds); (b) Lambda `ANTHROPIC_API_KEY` secret                                                  | (a) — single-operator factory, stay on the Max path; no per-token/multi-tenant model                                                                                                                                                                                                                                               | **Decide in C1**                                   |
| Q5  | **Plan injection point for Create-plan.**                                       | (a) fresh Plan → `import-plan`; (b) `kind:'change'` brownfield plan                                                                                 | (a) for greenfield-style audits; (b) for audits on a live shipped app. **Never** apply/import onto an already-developing plan (R6)                                                                                                                                                                                                 | **Decide in C4/D3**                                |
| Q6  | **Auto-fix vs always-escalate cap policy.**                                     | Reuse `FIX_CYCLE_HARD_CAP` auto fix-forward; OR "never auto-fix, always escalate"                                                                   | **Report-only is the product rule.** Audit-generated stories ride the normal pipeline fix-loop once a human approves the plan; no special auto-fix path. This is the one place a different cap _could_ be configured if desired                                                                                                    | **Settled: report-only; cap config deferred to E** |
| Q7  | **Structural-only Memgraph at recon (for C2 entangled-delete proofs)?**         | (a) light it up (reuses tree-sitter branch, near-free); (b) punt to durable phase                                                                   | (a, settled lean-yes) so L3 can _prove_ the profile1/profile2 untangle is safe — the most-wanted refactor                                                                                                                                                                                                                          | **Settled (lean yes); scope into Epic C**          |
| Q8  | **New `AgentEventType` values for `assess.*`, or reuse generic events?**        | (a) declare `assess.started/step.*/completed/failed`; (b) reuse `status`/`text_delta`/`tool_use`/`result`                                           | (a) — explicit names render cleanly in the live trace; declare them in the types so they don't fall into the 'unattributed' classifier bucket                                                                                                                                                                                      | **Decide in B3**                                   |
| Q9  | **Cascade-delete: must deleting an app purge its refactor-audit jobs?**         | (a) yes — add `appId`/`projectId` to `jobBelongsToApp` (`agent-jobs-repository.ts:93-106`); (b) no                                                  | (a) — the payload already carries `projectId`; wire it so audit jobs don't orphan a deleted app (documented bug class)                                                                                                                                                                                                             | **Decide in B1**                                   |
| Q10 | **Assessment cadence: one-time vs per-PR/daily entropy checks (`hone` model).** | (a) one-time on demand (MVP); (b) cron-scheduled later                                                                                              | (a) for MVP; (b) is a portfolio-graduation feature                                                                                                                                                                                                                                                                                 | **Settled: on-demand MVP; cadence deferred**       |
| Q11 | **Concurrency class for the new jobType.**                                      | interactive vs batch in `concurrency-manager.mjs`                                                                                                   | Default 'batch' works out of the box; add an explicit `refactor-audit` class if it should not contend with dev jobs                                                                                                                                                                                                                | **Decide in B2**                                   |

---

_End of PRD. Validated recon toolchain: `daemon/scripts/refactor-recon/{recon.mjs, alias-resolve.mjs, hotspot-detect.mjs, graphify-build.py}`. Epic source: `docs/epics-refactoring-module.md`._
