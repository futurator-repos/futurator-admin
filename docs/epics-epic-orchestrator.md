# Epic Orchestrator — Epic Breakdown

**Author:** Richie
**Date:** 2026-04-17
**Source:** [Epic Orchestrator Architecture](./concepts/epic-orchestrator-architecture.md)
**Companion docs:**

- [Orchestrator Prompt Template](./concepts/orchestrator-prompt-template.md)
- [Observability Spine Contract](./concepts/observability-spine-contract.md)
- [Touch-Point Inference Design](./concepts/touch-point-inference-design.md)
- [Resolve-Blocker Contract](./concepts/resolve-blocker-contract.md)

**Module:** Labs — Epic Orchestrator (replaces per-story terminal pipeline)

---

## Overview

This document decomposes the Epic Orchestrator architecture into implementable epics and stories. The goal: replace the current **one-Claude-terminal-per-story-per-role** Labs pipeline with **one orchestrator terminal per epic** that fans out parallel dev and reviewer subagents via Claude Code's `Task` tool — reducing context-gathering duplication, collapsing epic wall-clock time, and introducing a capability-isolated independent reviewer that cannot edit code.

### Epic summary

| #   | Epic                                       | Stories | Depends On    | Maps to arch doc Phase |
| --- | ------------------------------------------ | ------- | ------------- | ---------------------- |
| 1   | Subagent Foundations & Review Rubrics      | 5       | —             | 1, 2                   |
| 2   | Observability Spine                        | 5       | Epic 1        | 3                      |
| 3   | Touch-Point Inference                      | 5       | Epic 1        | 5                      |
| 4   | Orchestrator Dispatch & Epic-Dev Pipeline  | 6       | Epics 1, 2, 3 | 4                      |
| 5   | Blocker Resolution (API + UI)              | 5       | Epic 4        | 6                      |
| 6   | Agentic Office Visualization Extensions    | 4       | Epic 2        | 7                      |
| 7   | Legacy Cutover & Post-Launch Observability | 4       | Epics 4, 5, 6 | 8, 9                   |

**Total: 34 stories across 7 epics**

### Sequencing

```
Epic 1 (Foundations)
   │
   ├──► Epic 2 (Observability Spine) ──┐
   │                                   │
   └──► Epic 3 (Touch-Point Inference)─┤
                                       ▼
                                  Epic 4 (Orchestrator Dispatch)
                                       │
                           ┌───────────┼───────────┐
                           ▼           ▼           ▼
                       Epic 5      Epic 6     (orchestrator runs)
                      (Blockers)  (Office)
                           │           │
                           └─────┬─────┘
                                 ▼
                           Epic 7 (Cutover)
```

Epics 5 and 6 can run in parallel once Epic 4 produces events and blockers.

### Conventions

- **Story IDs:** `EO-{epicNum}.{storyNum}` (e.g., `EO-1.1`, `EO-4.3`).
- **AC format:** Given/When/Then where verifiable; bullet form otherwise.
- **Feature-flag rollout:** Epic 4 ships behind `useEpicOrchestrator` flag. Legacy per-story path stays active until Epic 7.
- **Test expectation per story:** every story has a testing line under Technical Notes. Unit tests use Vitest; E2E uses Playwright.

### Pre-committed artifacts (from design sessions)

The following files already exist and are referenced but **not re-created** by this plan:

- `.claude/agents/senior-reviewer.md`
- `.claude/agents/dev-trivial.md`
- `.claude/agents/dev-standard.md`
- `.claude/agents/dev-architectural.md`
- `docs/concepts/orchestrator-prompt-template.md`
- `docs/concepts/observability-spine-contract.md`
- `docs/concepts/touch-point-inference-design.md`
- `docs/concepts/resolve-blocker-contract.md`

Story EO-1.1 formalizes their acceptance as tracked inventory.

---

## Epic 1: Subagent Foundations & Review Rubrics

**Goal:** Establish the building blocks every subsequent epic depends on — the four subagent markdown specs, the orchestrator prompt template, and the layered review rubric.

### Story EO-1.1: Ratify and Freeze Subagent Markdown Specs

**Status:** done (committed in prior session)

As a **maintainer**,
I want **the four subagent specs committed and referenced from the architecture doc**,
So that **every Phase 4+ task can assume they are the canonical source of truth for subagent behavior**.

**Acceptance Criteria:**

- `.claude/agents/senior-reviewer.md` exists with `tools: Read, Grep, Glob, Bash` (no Edit/Write) and `model: sonnet`.
- `.claude/agents/dev-trivial.md` exists with `model: haiku` and touch-point-boundary rules.
- `.claude/agents/dev-standard.md` exists with `model: sonnet` and "think before you edit" process.
- `.claude/agents/dev-architectural.md` exists with `model: opus` and "always isolated wave" rule.
- Each spec's body matches `docs/concepts/epic-orchestrator-architecture.md` §4.1–4.4 verbatim.

**Prerequisites:** None.

**Technical Notes:**

- Already landed in branch.
- Do not edit these files from other Phase 1 stories — treat as frozen once EO-1.5 lands.
- **Testing:** manual diff against architecture doc §4.

**References:** [Arch Doc §4](./concepts/epic-orchestrator-architecture.md), `.claude/agents/*.md`

---

### Story EO-1.2: Commit Daemon-Ready Prompt Template Source

**Status:** done (committed in prior session as `docs/concepts/orchestrator-prompt-template.md`)

As a **daemon engineer**,
I want **the orchestrator, dev, reviewer, and remediation prompt templates consolidated in a single source-of-truth doc**,
So that **Phase 4 can copy them into `daemon/pipelines/templates/` without ambiguity**.

**Acceptance Criteria:**

- `docs/concepts/orchestrator-prompt-template.md` contains sections A, B, C (orchestrator prompt, dev/reviewer/remediation subagent prompts, blocker decision matrix).
- Template renders with explicit `{{vars}}` — table of 11 variables + their sources documented inline.
- "Change protocol" section requires matching updates in the architecture doc when templates change.

**Prerequisites:** EO-1.1

**Technical Notes:**

- Daemon-side `.tpl` copies at `daemon/pipelines/templates/*.md.tpl` are created in Epic 4, not here.
- **Testing:** render template once with a synthetic payload by hand; assert no unresolved `{{vars}}` remain.

**References:** [`docs/concepts/orchestrator-prompt-template.md`](./concepts/orchestrator-prompt-template.md), [Arch Doc App. A/B/C](./concepts/epic-orchestrator-architecture.md)

---

### Story EO-1.3: Author Global Default Review Rubric

**Status:** done

As a **reviewer operator**,
I want **a project-agnostic review rubric installed at a known path on EC2**,
So that **every project's epic-dev job inherits a baseline of correctness, convention, test, maintainability, and security rules**.

**Acceptance Criteria:**

**Given** the `senior-reviewer` subagent needs baseline rules
**When** the daemon launches an orchestrator
**Then** the merged rubric contains sections labeled `R-CORR-*`, `R-CONV-*`, `R-TEST-*`, `R-MAINT-*`, `R-SEC-*`
**And** each rule has an ID, a one-line rule statement, and a rationale
**And** the file lives at `/opt/futurator/rubrics/default.md` on the EC2 host

**Prerequisites:** EO-1.1

**Technical Notes:**

- Initial content: 5–8 rules per category; err on conservative, project-neutral phrasing.
- Rule ID format: `R-{CATEGORY}-{NNN}` (e.g., `R-CORR-001`).
- Install step: daemon bootstrap copies from repo path `scripts/rubrics/default.md` → `/opt/futurator/rubrics/default.md`.
- **Testing:** unit test parses the file and asserts every rule has a matching ID, statement, and rationale.

**References:** [Arch Doc §8](./concepts/epic-orchestrator-architecture.md), [Arch Doc §14](./concepts/epic-orchestrator-architecture.md)

---

### Story EO-1.4: Author Project Overlay Rubric for Futurator-Admin

**Status:** done

As a **Futurator-Admin maintainer**,
I want **a project-specific rubric overlay committed in this repo**,
So that **orchestrator reviews enforce DynamoDB multi-table, Bearer-token, Zod-safeParse, and other project-specific rules captured in CLAUDE.md**.

**Acceptance Criteria:**

**Given** the overlay rubric is present at `.claude/review-rubric.md`
**When** the rubric-merge helper (EO-1.5) runs
**Then** the overlay's rules are appended to the default rubric and passed to reviewer subagents
**And** the overlay covers at minimum: `R-ARCH-001..004` (DynamoDB multi-table, Hono single-file API, repository pattern, static export), `R-SAFE-001..003` (no direct S3 sync to futurator-ai-website, scoped-paths-only, sst deploy only), `R-CONV-001` (Bearer tokens not cookies), `R-TEST-001` (colocated Vitest), `R-SEC-001..002` (Zod safeParse, JWT validation)

**Prerequisites:** EO-1.1

**Technical Notes:**

- Content derives from `CLAUDE.md` + arch doc §14 verbatim.
- Path chosen at `.claude/review-rubric.md` so it sits alongside `.claude/agents/*.md`.
- Architectural stories proposing new rules update this file atomically (see `dev-architectural` spec).
- **Testing:** unit test asserts file parses with valid rule IDs and rationale lines.

**References:** [Arch Doc §14](./concepts/epic-orchestrator-architecture.md), `CLAUDE.md`

---

### Story EO-1.5: Implement Rubric-Merge Helper

**Status:** done

As an **epic-dev pipeline author**,
I want **a pure function that loads the global default and project overlay rubrics and returns a merged markdown string**,
So that **the orchestrator job payload's `rubric` field is deterministic and unit-testable**.

**Acceptance Criteria:**

**Given** `mergeRubric({ defaultPath, overlayPath })` is invoked
**When** both files exist
**Then** the returned string contains a `## Global Defaults` section followed by a `## Project Overlay` section
**And** duplicate rule IDs (overlay wins) are logged as warnings
**When** the overlay file is missing
**Then** the merged output is the default rubric unchanged with a `// no project overlay` note prepended

**Prerequisites:** EO-1.3, EO-1.4

**Technical Notes:**

- Location: `daemon/pipelines/lib/rubric-merge.mjs` (new dir `daemon/pipelines/lib/` for shared helpers).
- Export: `mergeRubric(opts) → string` + named export of the rule-ID parser.
- No network or DB calls — pure file read + string compose.
- **Testing:** Vitest fixtures under `daemon/pipelines/lib/__tests__/rubric-merge.test.mjs` — happy path, missing overlay, conflicting rule IDs.

**References:** [Arch Doc §8](./concepts/epic-orchestrator-architecture.md)

---

## Epic 2: Observability Spine

**Goal:** Deliver the event emission and read-back infrastructure every orchestrator interaction depends on. No orchestrator code is written until this epic lands.

### Story EO-2.1: Extend `AgentEventType` Union and `AgentEvent` Interface

**Status:** done

As a **backend engineer**,
I want **the event schema extended with orchestrator-specific event types and correlation fields**,
So that **DynamoDB writes, repository reads, and UI consumers all share a strongly-typed contract for orchestrator events**.

**Acceptance Criteria:**

**Given** `functions/shared/types/agent-orchestrator.ts` is updated
**When** the union is grepped
**Then** the 15 new event types listed in the observability-spine contract §6.1 appear (`epic_start`, `epic_complete`, `epic_failed`, `wave_start`, `wave_complete`, `wave_split`, `wave_collision`, `subagent_dispatch`, `subagent_return`, `dev_blocker_reported`, `story_blocked`, `blocker_resolved`, `touch_points_expanded`, `context_expanded`, `review_verdict`, `remediation_start`, `story_failed_terminally`, `inference_*`)
**And** `AgentEvent` has new optional fields: `epicId`, `waveNumber`, `storyId`, `role`, `subagentId`, `attempt`, `correlationId`, `payload`
**And** `npm run typecheck` passes with zero errors
**And** no existing callsite of `AgentEvent` breaks

**Prerequisites:** Epic 1

**Technical Notes:**

- Pure additive change — `AgentEventType` is a union so appending variants is backward-compatible.
- All new fields are optional; historical events continue to validate.
- **Testing:** run `npm run typecheck` and `npm run test` — expect green.

**References:** [Observability Spine Contract §6](./concepts/observability-spine-contract.md), `functions/shared/types/agent-orchestrator.ts:115`

---

### Story EO-2.2: Implement `scripts/emit-event.sh`

**Status:** done

As an **orchestrator subagent**,
I want **a single shell command that appends a validated NDJSON event line to a per-job log file**,
So that **I can emit events from the Bash tool without AWS credentials and without complex error handling**.

**Acceptance Criteria:**

**Given** `/opt/futurator/emit-event.sh` is installed
**When** invoked as `emit-event.sh '{"jobId":"x","epicId":"E","waveNumber":1,"role":"orchestrator","eventType":"wave_start","payload":{}}'`
**Then** the script exits 0 and appends the JSON as a single line to `/var/log/futurator/events/x.ndjson`
**And** the log directory is created if absent
**When** the input is invalid JSON
**Then** the script exits non-zero and writes an error to stderr
**When** a required field is missing (`jobId`, `epicId`, `waveNumber`, `role`, `eventType`)
**Then** the script exits non-zero with a field-name error

**Prerequisites:** EO-2.1

**Technical Notes:**

- Source path: `scripts/emit-event.sh`.
- Install: daemon bootstrap copies to `/opt/futurator/emit-event.sh` with `0755` permissions.
- Implementation uses `jq -e` for validation; no Node.js dependency at emit time.
- Per-event size budget: 4 KB (POSIX `PIPE_BUF` atomic-append).
- Env override: `FUTURATOR_EVENT_LOG_DIR` for local dev.
- **Testing:** Bash test script under `scripts/__tests__/emit-event.test.sh`. Cases: happy path, invalid JSON, missing field, missing log dir (auto-created).

**References:** [Observability Spine Contract §3](./concepts/observability-spine-contract.md)

---

### Story EO-2.3: Daemon NDJSON Forwarder Module

**Status:** done

As a **daemon engineer**,
I want **a module inside `agent-daemon.mjs` that tails `/var/log/futurator/events/*.ndjson` and writes each line to DynamoDB with a monotonic `eventSeq`**,
So that **events emitted by orchestrator subagents appear in the same table consumed by the existing UI within ~1s**.

**Acceptance Criteria:**

**Given** the forwarder is running
**When** 100 NDJSON lines are written to a single job file
**Then** all 100 appear in `futurator-agent-events` within 5 seconds, in order, with contiguous `eventSeq` values
**When** the daemon crashes mid-tail and restarts
**Then** no line is written twice (enforced by `ConditionExpression: attribute_not_exists(eventSeq)`)
**And** no line is lost (enforced by offset-checkpoint-after-DDB-write ordering)
**When** an NDJSON file is truncated or replaced
**Then** the forwarder detects size regression and re-tails from offset 0 safely

**Prerequisites:** EO-2.2

**Technical Notes:**

- New module: `daemon/forwarder/ndjson-forwarder.mjs`, consumed by `agent-daemon.mjs` at startup.
- Offset checkpoint file: `/var/log/futurator/events/<jobId>.ndjson.offset`.
- Poll interval: 250 ms per file via `setInterval`; serialized per file to preserve ordering.
- In-memory `Map<jobId, number>` counter, seeded from DDB `max(eventSeq)` on first sight.
- Reuses `agent-events-repository.ts :: pushEvent` but adds idempotency via `ConditionExpression`.
- **Testing:** integration test writes 100 events, forces daemon restart mid-flow, asserts final DDB state matches input.

**References:** [Observability Spine Contract §4](./concepts/observability-spine-contract.md), `functions/shared/repositories/agent-events-repository.ts`

---

### Story EO-2.4: Daemon-Local HTTP Receiver for Wave-Complete and Heartbeat

**Status:** done

As an **orchestrator subagent**,
I want **a loopback HTTP endpoint that persists wave checkpoints and heartbeats**,
So that **crash-resume (Epic 4.5) can skip completed waves and the daemon can detect stalled orchestrators**.

**Acceptance Criteria:**

**Given** the daemon is running with receiver bound to `127.0.0.1:17631`
**When** `POST /wave-complete` arrives with `{ jobId, epicId, wave, results }`
**Then** the daemon writes `waveResults[<wave>] = results` onto the job row and returns `{ ok: true, persistedAt }`
**When** `POST /heartbeat` arrives with `{ jobId, ts }`
**Then** the daemon updates `lastHeartbeatAt` on the job row and returns `{ ok: true }`
**And** the port is not exposed through the EC2 security group (loopback-only)
**And** no authentication is required (loopback trust boundary)

**Prerequisites:** EO-2.3

**Technical Notes:**

- Minimal `http.createServer` inside `agent-daemon.mjs` — avoid adding Express as a dependency.
- Port configurable via `FUTURATOR_DAEMON_PORT` env (default 17631).
- Reuses `agent-jobs-repository.ts :: updateJob` for persistence.
- Retry policy on orchestrator side: 3 attempts with exponential backoff (handled in orchestrator prompt, not here).
- **Testing:** integration test starts daemon, POSTs to both endpoints, asserts DDB state changes.

**References:** [Observability Spine Contract §5](./concepts/observability-spine-contract.md)

---

### Story EO-2.5: Flat-Log API Endpoint and Renderer

**Status:** done

As a **developer iterating on orchestrator behavior**,
I want **a plain-text endpoint that renders events with hierarchical correlation prefixes**,
So that **I can paste ten lines into a chat and reason about the full story of an epic's progress**.

**Acceptance Criteria:**

**Given** an epic has emitted events across multiple waves
**When** `GET /api/epic-workflows/:epicId/flat-log` is called
**Then** the response `Content-Type` is `text/plain; charset=utf-8`
**And** each event renders as `{epicId}/wave-{N}/{storyId|-}/{role}/{attempt|-}/{eventType}` followed by inline payload fields
**And** multi-line payloads (e.g., findings) indent under the parent line
**And** query params `since`, `role`, `storyId`, `wave`, `limit` filter correctly
**And** standard Bearer JWT auth is enforced

**Prerequisites:** EO-2.1, EO-2.3

**Technical Notes:**

- New renderer: `functions/shared/rendering/flat-log.ts` — pure function `renderFlatLog(events) → string`.
- New route in `functions/api/index.ts` near the existing `/api/agent-jobs/:id/events` route (~L520).
- The epic→jobId lookup happens server-side; no `jobId` required in the URL.
- **Testing:** Vitest snapshot test for `renderFlatLog` on canned fixtures; API integration test asserts filter params work.

**References:** [Observability Spine Contract §8](./concepts/observability-spine-contract.md), `functions/api/index.ts:520`

---

## Epic 3: Touch-Point Inference

**Goal:** Populate every story with deterministic `touchPoints`, `complexity`, and `reviewRigor` before the orchestrator dispatches, so sibling collisions are rare and dev subagents get precise edit boundaries.

### Story EO-3.1: Extend `EpicStory` Type with Inference Fields

**Status:** done

As a **type maintainer**,
I want **`EpicStory` to carry `touchPoints`, `complexity`, `reviewRigor`, and `inferenceMetadata`**,
So that **the orchestrator and reviewer subagents can read upstream-populated boundaries and tiers**.

**Acceptance Criteria:**

**Given** `functions/shared/types/epic-workflow.ts` is updated
**When** an epic is loaded
**Then** stories expose optional fields: `touchPoints: string[]`, `complexity: 'trivial'|'standard'|'complex'|'architectural'`, `reviewRigor: 'light'|'standard'|'strict'`, `inferenceMetadata: { inferredAt, model, confidence, reasoning?, retries? }`
**And** two new exported types exist: `StoryComplexity`, `ReviewRigor`
**And** `npm run typecheck` passes

**Prerequisites:** Epic 1

**Technical Notes:**

- Purely additive — no existing field changes.
- No DDB migration needed (schemaless).
- **Testing:** typecheck + one unit fixture creating an EpicStory with full inference fields.

**References:** [Touch-Point Inference Design §2](./concepts/touch-point-inference-design.md), `functions/shared/types/epic-workflow.ts:60`

---

### Story EO-3.2: Codebase-Index Builder

**Status:** done

As **the inference module**,
I want **a function that returns a compressed markdown codebase map for a given working dir**,
So that **Haiku has context to map stories to concrete files without crawling the repo**.

**Acceptance Criteria:**

**Given** a project with `knowledge/code/*.md` articles (Mycelium installed)
**When** `buildCodebaseIndex(workingDir)` is called
**Then** the returned string contains one line per code article with purpose, key exports, and dependencies
**And** total size ≤ 8 KB for a typical repo
**When** `knowledge/code/` is empty or absent
**Then** the function falls back to `bootstrap-scan.mjs` output
**And** the result is cached at `{workingDir}/.futurator/codebase-index-{sha}.md` and reused on next call for the same commit SHA

**Prerequisites:** EO-3.1

**Technical Notes:**

- New module: `daemon/pipelines/lib/codebase-index.mjs`.
- Reads `knowledge/code/*.md`, parses frontmatter + first N lines of body.
- Fallback: spawns existing `daemon/scripts/bootstrap-scan.mjs`.
- Cache invalidation via git SHA comparison.
- **Testing:** unit tests against a fixture repo with and without Mycelium knowledge dir.

**References:** [Touch-Point Inference Design §4](./concepts/touch-point-inference-design.md), `daemon/scripts/bootstrap-scan.mjs`

---

### Story EO-3.3: `touch-point-inference.mjs` Module with Haiku Prompt

As **an operator**,
I want **a module that calls Haiku per story and returns structured touch-point inferences**,
So that **epic-dev jobs start with fully-populated story records**.

**Acceptance Criteria:**

**Given** an epic with N stories
**When** `inferTouchPoints({ epic, workingDir })` is called
**Then** the function invokes Haiku in parallel batches of up to `maxParallel` (default 8) per story
**And** each Haiku invocation uses the template at `daemon/pipelines/templates/touch-point-inference.md.tpl`
**And** each response is parsed for an `<INFERENCE>` JSON block
**And** on parse failure the module retries once, then falls back to keyword-glob + `confidence: 'low'` + `requiresOperatorReview: true`
**And** the returned `InferenceResult` contains per-story fields, collisions list, wave reassignments, review-required list, and total cost

**Prerequisites:** EO-3.2

**Technical Notes:**

- New module: `daemon/pipelines/touch-point-inference.mjs`.
- Spawns Claude CLI: `claude --model haiku --allowedTools '' --print`.
- Template rendering via existing `substituteTemplate` pattern in `agent-daemon.mjs`.
- Cost estimation: track input/output tokens per call.
- Emits 5 new events (`inference_start`, `story_inferred`, `wave_conflict_autosplit`, `inference_failed`, `inference_complete`) via `emit-event.sh`.
- **Testing:** integration test with a fake `claude` binary on `PATH` that returns canned `<INFERENCE>` blocks.

**References:** [Touch-Point Inference Design §6, §11](./concepts/touch-point-inference-design.md)

**Status:** done

---

### Story EO-3.4: Glob-Intersect Utility and Wave Reassignment

As **the inference module**,
I want **a deterministic collision-detection pass that splits overlapping stories into adjacent waves**,
So that **the orchestrator rarely hits runtime wave collisions**.

**Acceptance Criteria:**

**Given** two stories with overlapping touch-point globs (e.g., `src/hooks/*.ts` vs `src/hooks/use-costs.ts`)
**When** the cross-story collision pass runs
**Then** the collision is reported with the intersecting path set
**And** one story is moved to a subsequent micro-wave while preserving DAG order from `dependsOn`
**And** wave numbers are re-normalized without gaps
**When** Haiku flagged the collision in `collisionsWith`
**Then** the fix respects Haiku's signal (auto-split without extra checks)
**When** stories have an explicit `dependsOn` relationship
**Then** the existing wave order is preserved (no reshuffling)

**Prerequisites:** EO-3.3

**Technical Notes:**

- New utility: `daemon/pipelines/lib/glob-intersect.mjs` — pure, no deps beyond `picomatch`.
- Reassignment logic: part of `touch-point-inference.mjs` orchestration.
- Conservative overlap detection: false positives OK (extra serialization), false negatives not OK (runtime crashes).
- **Testing:** unit test with known glob pairs (overlap vs not), wave-reassignment idempotency test.

**References:** [Touch-Point Inference Design §7](./concepts/touch-point-inference-design.md)

**Status:** done

---

### Story EO-3.5: Inference CLI Entry Point and Epic Row Persistence

As **an operator**,
I want **a CLI entry point that runs inference for an epic and writes results back to the epic row**,
So that **I can invoke inference manually, unit-test end-to-end, and re-run after editing stories**.

**Acceptance Criteria:**

**Given** `node daemon/pipelines/touch-point-inference.mjs --epic-id EPIC-42 --working-dir <path> --out /tmp/out.json` is invoked
**When** the command completes
**Then** `/tmp/out.json` contains the full `InferenceResult` document
**And** the epic row in DynamoDB has each story's `touchPoints`, `complexity`, `reviewRigor`, `inferenceMetadata` populated
**When** inference failed for any story
**Then** the job stays in `PENDING_INFERENCE` state with the failure recorded
**And** the operator can re-run with `--force` or `--stories STORY-7,STORY-9`

**Prerequisites:** EO-3.3, EO-3.4

**Technical Notes:**

- CLI parsing follows the pattern used in existing pipelines (`predev-compile-pipeline.mjs :: main()`).
- Persistence via `epic-workflow-repository.ts :: updateEpicFields`.
- Also exports library API `inferTouchPoints()` for Epic 4's pipeline to invoke directly.
- **Testing:** CLI smoke test against a 3-story synthetic epic; assert DB state post-run.

**References:** [Touch-Point Inference Design §11](./concepts/touch-point-inference-design.md)

**Status:** done

---

## Epic 4: Orchestrator Dispatch & Epic-Dev Pipeline

**Goal:** The core pipeline. Replace per-story dispatch with a single orchestrator terminal per epic, fanning out parallel subagents via Claude Code's Task tool, respecting waves, and persisting checkpoints for resume.

### Story EO-4.1: Epic Job Schema and Repository Additions

As a **backend engineer**,
I want **the agent-jobs schema extended with a `phase` discriminator and `waveResults`/`resumeFromWaveResults` fields**,
So that **the daemon can route epic-dev jobs distinctly from legacy per-story jobs and support crash-resume**.

**Acceptance Criteria:**

**Given** the job record is loaded
**When** `phase === 'epic-dev'`
**Then** additional fields exist: `epicId`, `waveResults: Record<string, WaveResult>`, `lastHeartbeatAt?: string`, `pipelineDefinition: EpicDevJobPayload`
**And** the existing per-story job shape remains valid (`phase` defaults to legacy behavior when absent)
**And** `functions/shared/schemas/agent-orchestrator-schema.ts` includes a Zod validator for the epic-dev payload

**Prerequisites:** Epic 2, Epic 3

**Technical Notes:**

- Purely additive to `functions/shared/types/agent-orchestrator.ts`.
- New types: `EpicDevJobPayload`, `WaveResult`, `StoryResult`.
- Repository: extend `agent-jobs-repository.ts` with `appendWaveResult(jobId, wave, result)` helper (used by EO-2.4).
- **Testing:** schema validation Vitest + type-check.

**References:** [Arch Doc §3](./concepts/epic-orchestrator-architecture.md), `functions/shared/repositories/agent-jobs-repository.ts`

**Status:** done

---

### Story EO-4.2: `epic-dev-pipeline.mjs` Entry Point + Prompt Render

**Status:** done

As **the daemon**,
I want **a new pipeline module that renders the orchestrator prompt and spawns Claude CLI as the orchestrator process**,
So that **epic-dev jobs run with full context, rubric, and story manifest injected**.

**Acceptance Criteria:**

**Given** a PENDING `phase: 'epic-dev'` job exists
**When** the daemon picks it up
**Then** the module: (1) loads rubric via `mergeRubric()`, (2) loads context digest, (3) renders `daemon/pipelines/templates/epic-orchestrator-prompt.md.tpl`, (4) spawns `claude` CLI with the rendered prompt, (5) pipes stdout/stderr through existing logging
**And** all 11 template `{{vars}}` resolve without warnings
**And** the spawned orchestrator process runs under the same auth/credential-rotation logic as existing agents
**And** orchestrator stdout is captured to `/var/log/futurator/events/<jobId>.orchestrator.stdout.log`

**Prerequisites:** EO-4.1, EO-1.5

**Technical Notes:**

- New module: `daemon/pipelines/epic-dev-pipeline.mjs`.
- Template copies at `daemon/pipelines/templates/{epic-orchestrator,dev-subagent,reviewer-subagent,remediation}-prompt.md.tpl` — regenerate from `docs/concepts/orchestrator-prompt-template.md`.
- Calls `inferTouchPoints()` from Epic 3 as a pre-step if any story lacks inference fields.
- Reuses the existing `spawn(CLAUDE_BIN, [...])` pattern in `agent-daemon.mjs`.
- **Testing:** integration test with a 2-story synthetic epic; assert orchestrator spawns and emits `epic_start` within 10 s.

**References:** [Orchestrator Prompt Template](./concepts/orchestrator-prompt-template.md), [Arch Doc §3](./concepts/epic-orchestrator-architecture.md), `daemon/agent-daemon.mjs`

---

### Story EO-4.3: Daemon Poll Loop Routing for `phase: 'epic-dev'`

**Status:** done

As **the agent daemon**,
I want **the poll loop to branch on the job's `phase` field**,
So that **epic-dev jobs invoke the new pipeline while legacy per-story jobs continue unchanged**.

**Acceptance Criteria:**

**Given** the daemon polls `futurator-agent-jobs`
**When** a job with `phase === 'epic-dev'` is found
**Then** it dispatches to `epic-dev-pipeline.mjs`
**When** a job with no `phase` or a legacy `pipelineId` is found
**Then** the existing dispatch continues unchanged
**And** the daemon honors `maxParallelJobs` at the host level (no change from today)

**Prerequisites:** EO-4.2

**Technical Notes:**

- Single branch point in `agent-daemon.mjs`.
- Do not regress legacy per-story job behavior.
- **Testing:** unit test on the branch selector; regression test against a fixture legacy job.

**References:** `daemon/agent-daemon.mjs`

---

### Story EO-4.4: `POST /api/epic-workflows/:epicId/start` Endpoint (Feature-Flagged)

**Status:** done

As a **Labs UI user**,
I want **a single button that creates an epic-dev job when the `useEpicOrchestrator` flag is on**,
So that **I can launch the full epic with one click instead of per-story dispatches**.

**Acceptance Criteria:**

**Given** a user with write access and `useEpicOrchestrator === true` for this epic
**When** `POST /api/epic-workflows/:epicId/start` is called
**Then** the server: (1) validates the epic is `ready` or `fixing`, (2) creates a `phase: 'epic-dev'` job, (3) returns `{ jobId }` with 201
**When** the flag is false or absent
**Then** the endpoint returns 409 with `useEpicOrchestrator-disabled` and the UI falls back to legacy per-story buttons

**Prerequisites:** EO-4.1, EO-4.3

**Technical Notes:**

- New route in `functions/api/index.ts` near existing story/run endpoint (~L1845).
- Flag storage: field on the epic row — `useEpicOrchestrator: boolean`.
- Zod schema validates the request body (currently empty; placeholder for future options like `maxParallel` override).
- **Testing:** API integration: happy path + flag-off + invalid epic status.

**References:** [Arch Doc §3](./concepts/epic-orchestrator-architecture.md), `functions/api/index.ts:1845`

---

### Story EO-4.5: Crash-Resume — Read `waveResults`, Skip Completed Waves

**Status:** done

As **the daemon**,
I want **to detect stale orchestrator processes and resume by injecting `resumeFromWaveResults` into a fresh orchestrator run**,
So that **EC2 crashes, OOMs, or manual kills do not force an epic to restart from wave 0**.

**Acceptance Criteria:**

**Given** an epic-dev job has `status: RUNNING` and `lastHeartbeatAt` is >5 min ago
**When** the daemon's stale-heartbeat detector runs
**Then** the job is marked `STALE` and a new orchestrator spawn is scheduled
**And** the new spawn's template renders `{{resumeFromWaveResults}}` with the prior job's accumulated checkpoints
**And** the orchestrator's prompt instructs: skip waves where all stories are APPROVED/FAILED-terminally, start at the first incomplete wave, never re-dispatch APPROVED stories
**When** no prior checkpoints exist
**Then** the resume behaves identically to a fresh start

**Prerequisites:** EO-4.2, EO-2.4

**Technical Notes:**

- Stale detection logic runs in the existing daemon poll loop.
- `resumeFromWaveResults` is a job-payload-level field; rendered into the prompt template.
- **Testing:** integration test: run 2-story epic, kill orchestrator after wave 1, assert resume starts at wave 2 and does not re-dispatch story 1.

**References:** [Arch Doc §11](./concepts/epic-orchestrator-architecture.md), [Orchestrator Prompt Template §A "Resume on crash"](./concepts/orchestrator-prompt-template.md)

---

### Story EO-4.6: Feature Flag in Labs UI — `useEpicOrchestrator` Toggle

**Status:** done

As a **Labs operator**,
I want **a toggle in the epic detail view to opt this epic into the orchestrator path**,
So that **I can pilot new epics on the new pipeline while older epics keep using the legacy per-story dispatch**.

**Acceptance Criteria:**

**Given** I am on the epic detail page
**When** I flip the "Use epic orchestrator" toggle
**Then** the API persists `useEpicOrchestrator` on the epic row
**And** the Start button becomes single-button (orchestrator mode) when true, or per-story buttons when false
**And** the toggle is disabled while the epic is `in_progress` to prevent mid-flight switches

**Prerequisites:** EO-4.4

**Technical Notes:**

- UI location: `src/components/labs/agentic-workflow/epic-header.tsx` (or nearest analog).
- API: reuse `PUT /api/epic-workflows/:id` — add `useEpicOrchestrator` to the updatable fields whitelist.
- Default for new epics: `false` in Phase 4; flipped to `true` in Epic 7.
- **Testing:** Playwright smoke — toggle on, click Start, assert `POST /start` request fires.

**References:** [Arch Doc Phase 4 Rollback](./concepts/epic-orchestrator-architecture.md), `src/components/labs/agentic-workflow/`

---

## Epic 5: Blocker Resolution (API + UI)

**Goal:** Give operators a clear, audited interface to resolve `BLOCKED` stories — amend, skip, or retry — and trigger resume jobs correctly.

### Story EO-5.1: `StoryStatus` `'blocked'` Variant and Blocker Types

**Status:** done

As a **type maintainer**,
I want **`StoryStatus` to include `'blocked'` and new types for blocker records and resolution history**,
So that **the UI and API share a strongly-typed contract for human-in-the-loop resolution**.

**Acceptance Criteria:**

**Given** `functions/shared/types/epic-workflow.ts` is updated
**When** a story is loaded
**Then** `status` may equal `'blocked'`
**And** `BlockerRecord` type has `code`, `severity`, `description`, `affectedPath?`, `suggestedResolution`, `requestedTouchPointExpansion?`, `attemptsBeforeBlock`, `reportedAt`, `reportedByAttempt`, `waveNumber`, `subagentId?`
**And** `BlockerResolutionRecord` type has `resolvedAt`, `resolvedBy`, `action`, `reason`, `amendedFields?`
**And** `EpicStory` carries optional `blocker: BlockerRecord` and `resolutionHistory: BlockerResolutionRecord[]`
**And** `BlockerCode` union covers the 6 codes from the architecture doc §7

**Prerequisites:** Epic 4

**Technical Notes:**

- Additive to `StoryStatus` union; no existing consumer should break (exhaustive-switch lint may flag new variant — audit and update).
- **Testing:** typecheck + exhaustive-switch audit script (grep for `switch (story.status)` missing `blocked` case).

**References:** [Resolve-Blocker Contract §2](./concepts/resolve-blocker-contract.md), `functions/shared/types/epic-workflow.ts:10`

---

### Story EO-5.2: Zod Schema + `POST /resolve-blocker` Endpoint

**Status:** done

As a **Labs operator**,
I want **a single endpoint that accepts `amend`, `skip`, or `retry` actions and validates input strictly**,
So that **ill-formed resolutions are rejected at the API boundary with clear error messages**.

**Acceptance Criteria:**

**Given** `POST /api/epic-workflows/:epicId/stories/:storyId/resolve-blocker` is called
**When** the body passes Zod validation for one of {`amend`, `skip`, `retry`}
**Then** the endpoint applies the resolution, emits `blocker_resolved`, and returns `{ ok: true, newStatus, resumeJobId, resolvedAt }`
**When** the body is invalid
**Then** the endpoint returns 400 with field-level Zod messages
**When** the story is not in `blocked` state
**Then** the endpoint returns 409 `not-blocked`
**When** `expectedBlockerReportedAt` is supplied and does not match the current blocker
**Then** the endpoint returns 409 `blocker-changed`
**When** the epic is in `deployed` or `completed`
**Then** the endpoint returns 409 `epic-terminal`

**Prerequisites:** EO-5.1

**Technical Notes:**

- New schema: `functions/shared/schemas/resolve-blocker-schema.ts` using `z.discriminatedUnion('action', [...])`.
- Route in `functions/api/index.ts` near story/run route (~L1845).
- Uses existing `ValidationError` / `AppError` envelope.
- Rate limit: 1 request / story / 5 s (prevents double-click; use simple in-memory throttle).
- **Testing:** API integration suite covering happy path for each action + all 4 error codes.

**References:** [Resolve-Blocker Contract §3](./concepts/resolve-blocker-contract.md)

---

### Story EO-5.3: Resume-Job Helper (Shared with EO-4.5)

**Status:** done

As **the resolve-blocker handler**,
I want **a shared helper that enqueues a new epic-dev job carrying prior `waveResults`**,
So that **amend and retry actions reliably resume without duplicating work and stay in sync with the daemon's stale-heartbeat resume path**.

**Acceptance Criteria:**

**Given** a prior job exists with populated `waveResults`
**When** `enqueueResumeJob({ epicId, userId, priorJobId })` is called
**Then** a new `phase: 'epic-dev'` job is created with `resumeFromWaveResults` carried from the prior job
**And** the new job's status is `PENDING`
**And** the returned `jobId` matches the new record
**When** `priorJobId` is undefined or points to a job with empty `waveResults`
**Then** the new job starts fresh (resume map empty)

**Prerequisites:** EO-5.2

**Technical Notes:**

- Helper location: `functions/shared/services/resume-job.ts`.
- Consumed by: `POST /resolve-blocker` (this epic) and the daemon's stale-heartbeat path (Epic 4.5).
- **Testing:** unit test with mocked DDB — assert resume payload carries prior `waveResults` correctly.

**References:** [Resolve-Blocker Contract §3.8](./concepts/resolve-blocker-contract.md)

---

### Story EO-5.4: Story Card Blocked-State Treatment

**Status:** done

As a **Labs operator**,
I want **the story card to surface blocker details directly and offer a Resolve Blocker action**,
So that **I can assess and act without leaving the epic detail view**.

**Acceptance Criteria:**

**Given** a story has `status: 'blocked'` and a populated `blocker`
**When** the card renders
**Then** the status dot is amber pulsing, badge reads `🚧 BLOCKED — {shortCode}`
**And** an inline summary shows blocker code, description, and suggested resolution
**And** a `[Resolve Blocker ▸]` button is visible and focusable
**And** epic-header counter `🚧 N blocked` appears when any story is blocked

**Prerequisites:** EO-5.1

**Technical Notes:**

- Modify `src/components/labs/agentic-workflow/story-card.tsx` — extend `getStatusDot`, `getStatusBadgeClasses`, `getStatusLabel` with `'blocked'` case.
- Epic header: separate small component added to `epic-header.tsx` or the existing epic detail summary row.
- Use theme tokens (`amber-500`) consistent with the project's semantic palette.
- **Testing:** Storybook entry for blocked state; Playwright smoke that seeds a blocked story and asserts the amber strip renders.

**References:** [Resolve-Blocker Contract §5.1](./concepts/resolve-blocker-contract.md), `src/components/labs/agentic-workflow/story-card.tsx`

---

### Story EO-5.5: Resolve-Blocker Drawer + `useResolveBlocker` Hook

**Status:** done

As a **Labs operator**,
I want **a drawer that surfaces the blocker, offers three actions, and submits with a reason field**,
So that **resolving a blocker takes under 60 seconds for common cases**.

**Acceptance Criteria:**

**Given** I click `[Resolve Blocker ▸]` on a blocked story
**When** the drawer opens
**Then** it shows: current blocker details, three action radios (`Amend`, `Skip`, `Retry`), action-specific sub-forms, and a required Reason textarea
**When** I submit `Amend` with edited fields and a reason
**Then** the POST request fires, TanStack Query invalidates the epic-workflow query, and the drawer closes with a success toast
**When** the server returns 409 `blocker-changed`
**Then** the drawer shows an inline reload banner instead of a toast
**And** Escape, click-outside, and the close button all dismiss the drawer
**And** the Apply button is disabled while the reason is empty

**Prerequisites:** EO-5.4, EO-5.2

**Technical Notes:**

- New component: `src/components/labs/agentic-workflow/resolve-blocker-drawer.tsx`.
- New hook: `src/hooks/use-resolve-blocker.ts` (mutation + invalidation).
- Reuse existing shadcn/ui Sheet component for the drawer.
- No new Zustand store — mutation state lives in the hook.
- **Testing:** Playwright smoke: seed blocker, open drawer, pick Skip, fill reason, submit, assert card flips to skipped.

**References:** [Resolve-Blocker Contract §5.3, §5.4](./concepts/resolve-blocker-contract.md)

---

## Epic 6: Agentic Office Visualization Extensions

**Goal:** Extend the Three.js isometric office to visualize orchestrator, dev, and reviewer subagents; waves; remediation loops; and the whiteboard as a blocker ledger.

### Story EO-6.1: Event Translator — New Event Types

**Status:** done

As **the Agentic Office frontend**,
I want **`event-translator.ts` to map the 15 new event types to animation intents**,
So that **the scene reacts to orchestrator events without ad-hoc switches scattered across components**.

**Acceptance Criteria:**

**Given** a new orchestrator event arrives
**When** `translateEvent(event)` is invoked
**Then** it returns a typed animation intent (`supervisor_dispatch`, `dev_spawn`, `reviewer_spawn`, `remediation_respawn`, `wave_band_activate`, `wave_collision_flash`, `blocker_card_place`, `blocker_card_remove`, `story_desk_terminal_fail`, etc.)
**And** unknown event types log a warn and return a no-op intent (never throws)

**Prerequisites:** Epic 2

**Technical Notes:**

- Extend `src/components/agentic-office/event-translator.ts`.
- Add a typed `OrchestratorAnimationIntent` union.
- **Testing:** unit test on every event type returning the expected intent shape.

**References:** [Arch Doc §10.3](./concepts/epic-orchestrator-architecture.md), `src/components/agentic-office/event-translator.ts`

---

### Story EO-6.2: Supervisor Desk and Review Booth Meshes

**Status:** done

As a **Labs operator watching the office**,
I want **a persistent supervisor desk and a distinct review booth**,
So that **I can visually distinguish orchestrator from dev workers from reviewers at a glance**.

**Acceptance Criteria:**

**Given** an epic-dev job is running
**When** the office renders
**Then** a supervisor figure is seated at a whiteboard-adjacent desk for the entire epic duration
**And** reviewer subagents appear at a distinct review booth (different color palette)
**And** a thin line connects each reviewer to the dev it is reviewing during that review
**And** the supervisor has a status ring: green (dispatching), yellow (waiting), orange (conflict resolution), red (failed)

**Prerequisites:** EO-6.1

**Technical Notes:**

- New mesh definitions under `src/components/agentic-office/scene/`.
- Reuse existing worker-desk mesh for dev subagents; review booth is a new primitive.
- Status-ring geometry: Three.js `RingGeometry` as a shader quad.
- **Testing:** manual visual review against a recorded event stream; no automated pixel comparisons.

**References:** [Arch Doc §10.3](./concepts/epic-orchestrator-architecture.md), `src/components/agentic-office/`

---

### Story EO-6.3: Whiteboard as Blocker Ledger

**Status:** done

As a **Labs operator**,
I want **the whiteboard in the office scene to display a 🚧 card per blocked story**,
So that **the human-action queue depth is visible at a glance**.

**Acceptance Criteria:**

**Given** a story transitions to `blocked`
**When** the office receives `story_blocked`
**Then** the corresponding dev worker walks to the whiteboard, places a 🚧 card with storyId, and returns to the desk (idle pose)
**When** `blocker_resolved` arrives
**Then** the card animates off the whiteboard
**And** the total card count on the whiteboard always matches the count of currently-blocked stories

**Prerequisites:** EO-6.1, EO-6.2

**Technical Notes:**

- New component: `src/components/agentic-office/scene/blocker-card.tsx`.
- Persistence: card state lives in the DDB story record — the scene restores from cold load, not only from events.
- **Testing:** integration test against a recorded stream: N blocker events → N cards; M resolved events → N−M cards.

**References:** [Arch Doc §10.3, §10.5](./concepts/epic-orchestrator-architecture.md), [Resolve-Blocker Contract §5.6](./concepts/resolve-blocker-contract.md)

---

### Story EO-6.4: Worker States — Attempt Badges, Idle Pose, Amber Ring

**Status:** done

As a **Labs operator**,
I want **worker desks to reflect attempt number, idle-after-blocker pose, and amber pulsing ring**,
So that **remediation loops and blocked states are visually obvious**.

**Acceptance Criteria:**

**Given** a dev subagent is dispatched on attempt 2
**When** the scene renders
**Then** the worker shows an `attempt: 2` badge above the desk
**Given** a story is blocked
**When** the scene renders
**Then** the desk has an amber pulsing ring and the worker is in idle pose (seated, motionless)
**Given** a story is terminally failed
**When** the scene renders
**Then** the desk goes gray with a persistent red ribbon (visible at end-of-epic)

**Prerequisites:** EO-6.2

**Technical Notes:**

- Badge rendering: small `Sprite` above desk mesh.
- Amber ring: `RingGeometry` with shader pulse.
- Idle-pose flag is a state property on the worker component.
- **Testing:** snapshot test of the scene graph against a fixture sequence (attempt 1 → 2 → blocked → resolved).

**References:** [Arch Doc §10.3](./concepts/epic-orchestrator-architecture.md)

---

## Epic 7: Legacy Cutover & Post-Launch Observability

**Goal:** Migrate from legacy per-story dispatch to epic-orchestrator by default, and ship the dashboards that drive rubric evolution and cost tuning.

### Story EO-7.1: In-Flight Job Migration

**Status:** done

As a **release manager**,
I want **a migration script that identifies in-flight per-story jobs and either drains them or converts them to epic-dev jobs**,
So that **the cutover does not lose work and does not mix pipelines mid-epic**.

**Acceptance Criteria:**

**Given** the script is invoked with `--dry-run`
**When** it scans agent-jobs for legacy per-story jobs
**Then** it reports: jobs eligible to drain (nearly complete), jobs to convert to epic-dev, jobs to block migration on
**When** invoked with `--apply`
**Then** the reported actions are taken and every change is logged with an audit record in `futurator-audit`

**Prerequisites:** EO-4.6

**Technical Notes:**

- Location: `scripts/migrate-to-epic-orchestrator.ts`.
- Invoked manually by release manager; not run automatically.
- Uses existing repo functions — no direct DDB access.
- **Testing:** dry-run against a snapshot of production; eyeball the reported actions before `--apply`.

**References:** [Arch Doc Phase 8](./concepts/epic-orchestrator-architecture.md)

---

### Story EO-7.2: Flag Flip — `useEpicOrchestrator: true` Default for New Epics

**Status:** done

As a **Labs operator**,
I want **new epics to default to the orchestrator path**,
So that **the legacy path is exercised only for historical epics**.

**Acceptance Criteria:**

**Given** a new epic is created via `POST /api/epic-workflows`
**When** no `useEpicOrchestrator` value is supplied
**Then** the epic is persisted with `useEpicOrchestrator: true`
**And** epics created before the flip retain their existing value (no backfill)

**Prerequisites:** EO-7.1

**Technical Notes:**

- Single-line default change in `epic-workflow-repository.ts :: createEpic`.
- Flip happens in a dedicated PR so it can be reverted independently of other stories.
- Announcement in `CLAUDE.md` under a "recent changes" section for operator awareness.
- **Testing:** API integration — POST a new epic, assert the persisted row has `useEpicOrchestrator: true`.

**References:** [Arch Doc Phase 8](./concepts/epic-orchestrator-architecture.md)

---

### Story EO-7.3: Monitoring Dashboard — Wall-Clock and Token Spend per Epic

**Status:** done

As a **release manager**,
I want **a dashboard comparing wall-clock time and token spend before vs after cutover**,
So that **the orchestrator's efficiency gains are measurable and regressions surface early**.

**Acceptance Criteria:**

**Given** orchestrator events include durations and cost metadata
**When** the dashboard renders
**Then** it shows: epic wall-clock (median, p95), story wall-clock, per-tier token spend (haiku/sonnet/opus), remediation rate, blocker taxonomy distribution
**And** filters by date range, project, `useEpicOrchestrator` boolean
**And** data is aggregated from `futurator-agent-events` — no new table

**Prerequisites:** EO-7.1

**Technical Notes:**

- New route + component in the Reports section of the admin UI.
- Backend aggregation via a new endpoint: `GET /api/reports/epic-orchestrator-metrics?range=...`.
- **Testing:** unit test the aggregator against a fixture event stream; smoke the UI with seeded events.

**References:** [Arch Doc Phase 9](./concepts/epic-orchestrator-architecture.md)

---

### Story EO-7.4: Remove Legacy Per-Story Dispatch Path

As a **maintainer**,
I want **the legacy per-story orchestration removed after 48 hours of stable orchestrator runs in production**,
So that **the codebase has one source of truth for epic dispatch and dead branches are pruned**.

**Acceptance Criteria:**

**Given** ≥ 48 hours of stable orchestrator runs on production with zero critical incidents
**When** this story's PR lands
**Then** the legacy `/api/epic-workflows/:id/stories/:storyId/run` endpoint returns 410 Gone with a message pointing to `/start`
**And** daemon's legacy job-dispatch branch is deleted
**And** `useEpicOrchestrator` field is removed from the epic schema (all epics are orchestrator-mode going forward)
**And** story-card UI no longer renders per-story Run buttons

**Prerequisites:** EO-7.2, EO-7.3

**Technical Notes:**

- Gated by release manager on real telemetry from EO-7.3.
- Removal is irreversible in the PR — revert via `git revert` if needed.
- CLAUDE.md updated to drop references to the legacy path.
- **Testing:** full-project typecheck + `npm run test` + Playwright smoke on a fresh epic.

**References:** [Arch Doc Phase 8 Rollback](./concepts/epic-orchestrator-architecture.md)

---

## Appendix A — Dependency Matrix

| Story  | Depends On     |
| ------ | -------------- |
| EO-1.1 | — (done)       |
| EO-1.2 | EO-1.1 (done)  |
| EO-1.3 | EO-1.1         |
| EO-1.4 | EO-1.1         |
| EO-1.5 | EO-1.3, EO-1.4 |
| EO-2.1 | Epic 1         |
| EO-2.2 | EO-2.1         |
| EO-2.3 | EO-2.2         |
| EO-2.4 | EO-2.3         |
| EO-2.5 | EO-2.1, EO-2.3 |
| EO-3.1 | Epic 1         |
| EO-3.2 | EO-3.1         |
| EO-3.3 | EO-3.2         |
| EO-3.4 | EO-3.3         |
| EO-3.5 | EO-3.3, EO-3.4 |
| EO-4.1 | Epic 2, Epic 3 |
| EO-4.2 | EO-4.1, EO-1.5 |
| EO-4.3 | EO-4.2         |
| EO-4.4 | EO-4.1, EO-4.3 |
| EO-4.5 | EO-4.2, EO-2.4 |
| EO-4.6 | EO-4.4         |
| EO-5.1 | Epic 4         |
| EO-5.2 | EO-5.1         |
| EO-5.3 | EO-5.2         |
| EO-5.4 | EO-5.1         |
| EO-5.5 | EO-5.4, EO-5.2 |
| EO-6.1 | Epic 2         |
| EO-6.2 | EO-6.1         |
| EO-6.3 | EO-6.1, EO-6.2 |
| EO-6.4 | EO-6.2         |
| EO-7.1 | EO-4.6         |
| EO-7.2 | EO-7.1         |
| EO-7.3 | EO-7.1         |
| EO-7.4 | EO-7.2, EO-7.3 |

## Appendix B — Files Touched by Epic

| Epic | New files                                                                                                                                                                                              | Modified files                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `.claude/review-rubric.md`, `scripts/rubrics/default.md`, `daemon/pipelines/lib/rubric-merge.mjs`                                                                                                      | `.claude/agents/*.md` (already committed)                                                                                                                                                                            |
| 2    | `scripts/emit-event.sh`, `daemon/forwarder/ndjson-forwarder.mjs`, `functions/shared/rendering/flat-log.ts`                                                                                             | `functions/shared/types/agent-orchestrator.ts`, `functions/api/index.ts`, `daemon/agent-daemon.mjs`                                                                                                                  |
| 3    | `daemon/pipelines/touch-point-inference.mjs`, `daemon/pipelines/lib/codebase-index.mjs`, `daemon/pipelines/lib/glob-intersect.mjs`, `daemon/pipelines/templates/touch-point-inference.md.tpl`          | `functions/shared/types/epic-workflow.ts`, `functions/shared/repositories/epic-workflow-repository.ts`                                                                                                               |
| 4    | `daemon/pipelines/epic-dev-pipeline.mjs`, `daemon/pipelines/templates/{epic-orchestrator,dev-subagent,reviewer-subagent,remediation}-prompt.md.tpl`                                                    | `daemon/agent-daemon.mjs`, `functions/api/index.ts`, `functions/shared/types/agent-orchestrator.ts`, `functions/shared/schemas/agent-orchestrator-schema.ts`, `src/components/labs/agentic-workflow/epic-header.tsx` |
| 5    | `functions/shared/schemas/resolve-blocker-schema.ts`, `functions/shared/services/resume-job.ts`, `src/components/labs/agentic-workflow/resolve-blocker-drawer.tsx`, `src/hooks/use-resolve-blocker.ts` | `functions/shared/types/epic-workflow.ts`, `functions/api/index.ts`, `src/components/labs/agentic-workflow/story-card.tsx`                                                                                           |
| 6    | `src/components/agentic-office/scene/blocker-card.tsx` (and supervisor/review-booth meshes)                                                                                                            | `src/components/agentic-office/event-translator.ts`, `src/components/agentic-office/`                                                                                                                                |
| 7    | `scripts/migrate-to-epic-orchestrator.ts`, Reports dashboard component                                                                                                                                 | `functions/shared/repositories/epic-workflow-repository.ts`, `functions/api/index.ts`, `CLAUDE.md`                                                                                                                   |

## Appendix C — Testing Expectations

Every story ships with at least:

- **Unit tests** (Vitest) for new pure functions (`rubric-merge`, `glob-intersect`, `renderFlatLog`, schemas).
- **Integration tests** for modules that orchestrate external processes (forwarder, inference, pipeline spawn).
- **API integration tests** (Vitest + mocked DDB) for new endpoints.
- **Playwright smoke** for user-facing UI (story card states, resolve-blocker drawer, toggle).

Epic 7 is gated on a 48-hour production soak with telemetry from EO-7.3 before EO-7.4 removes the legacy path.
