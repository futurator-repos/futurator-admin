# Epics & Stories — Pipeline v1

| Field | Value |
|---|---|
| **Status** | Ready for development |
| **Source PRD** | `docs/concepts/prd-pipelinev1-self-corrections-escalation.md` |
| **Planning notes** | `docs/concepts/pipelinev1-self-corrections-escalation.md` |
| **Date** | 2026-04-26 |
| **Total epics** | 6 |
| **Total stories** | 41 |
| **Estimated effort** | ~5-6 weeks of focused work, sequenced |

---

## How to use this document

Each epic is a deployable, demo-able increment. Stories within an epic are ordered by recommended implementation sequence. Stories carry:

- **ID** — `<epic>.<story>` (e.g., `1.3`)
- **Title** — short imperative
- **Story** — As / I want / So that
- **Acceptance criteria** — numbered, each independently testable
- **Technical notes** — file paths, library calls, gotchas
- **Dependencies** — other story IDs (within or across epics)
- **Effort** — `S` (≤4 h), `M` (½–1 day), `L` (1-2 days), `XL` (2-3 days)
- **Type** — `arch` (introduces new pattern/contract; warrants architectural-rigor implementation), `std` (standard feature work), `triv` (trivial)
- **DoD** — definition of done

The "Type" labels map to `dev-architectural` / `dev-standard` / `dev-trivial` agent flavors when developed via the BMAD pipeline.

---

## Index

| Epic | Title | Stories | Effort | Sequencing |
|---|---|---|---|---|
| 1 | Failure recovery surface | 10 | 3-5 days | Ship first — unblocks dino3 class of incidents |
| 2 | Concurrency manager | 6 | 5-7 days | Builds on Epic 1's job-state model |
| 3 | Talk-to-agent v1 | 9 | 7-10 days | Builds on Epic 1's job state and Epic 2's session pool |
| 4 | Cost & time discipline | 6 | 3-5 days | Independent; can interleave with Epic 2 or 3 |
| 5 | Cache & context optimization | 5 | 3-5 days | Builds on Epic 3's SessionRegistry |
| 6 | Quality of service | 5 | 3 days | Builds on Epic 2's priority concept |

### Cross-epic dependency graph

```
Epic 1 ──┬─→ Epic 2 ──┬─→ Epic 3 ──→ Epic 5
         │             │
         └─→ Epic 4    └─→ Epic 6
```

Epic 4 (cost discipline) is the most independent — can ship as soon as the team has bandwidth.

---

## Glossary

| Term | Definition |
|---|---|
| **Step** | One unit of work in a pipeline (e.g., `qa-evaluate`). Has a `stepId` (string in pipeline def). |
| **Job** | One run of a pipeline. Has a `jobId` (UUID) row in `futurator-agent-jobs`. |
| **Session** | One Claude conversation. Has a `claudeSessionId` from the Claude CLI's `system.init` event. |
| **Conversation** | A human-driven chat thread on top of a session (Epic 3). Has a `conversationId`. |
| **Slot** | A unit of concurrent Claude execution capacity (Epic 2). Typed: `interactive` / `critical` / `background`. |
| **Attention item** | An entry in the operator's inbox requiring a decision (Epic 1, FR-9 in PRD). |
| **Salvageable** | A failed step is salvageable when its output extractors fired before failure. |
| **Skip-tolerant** | A pipeline step is skip-tolerant when downstream steps don't depend on its output. |

---

# Epic 1 — Failure recovery surface

**Goal.** Turn every failed step into a recoverable artifact. After this epic, the dino3-style "agent succeeded but daemon stalled" incident is a one-click fix.

**Scope.** New `NEEDS_ATTENTION` job state, structured exit signals, loop detection, pre-flight validation framework, and the four operator actions (Salvage / Retry / Skip / Abort) wired through both API and UI. Attention inbox v0.

**Out of scope.** Concurrency/queueing (Epic 2). Talk-to-agent (Epic 3). Cost ceilings (Epic 4).

**Demo.** Induce a failure on a test plan; system marks it `NEEDS_ATTENTION`; operator sees attention item; clicks Salvage; wave advances. Total operator time: <10 seconds.

---

### Story 1.1 — Add `NEEDS_ATTENTION` job status

**As a** daemon, **I want** a job state distinct from `FAILED` for recoverable failures, **so that** the wave can pause without losing work.

**Acceptance criteria.**
1. `AgentJob.status` enum in `functions/shared/types/agent-orchestrator.ts` includes `NEEDS_ATTENTION` and `COMPLETED_VIA_SALVAGE`.
2. State transitions documented in code:
   - `RUNNING` → `NEEDS_ATTENTION` (recoverable failure)
   - `RUNNING` → `FAILED` (only on explicit operator Abort or unrecoverable infra error like DDB write)
   - `NEEDS_ATTENTION` → `RUNNING` (Retry action creates a *new* job; the original stays `NEEDS_ATTENTION` archived)
   - `NEEDS_ATTENTION` → `COMPLETED_VIA_SALVAGE` (Salvage action)
   - `NEEDS_ATTENTION` → `MANUALLY_SKIPPED` (Skip action — also a new enum value)
   - `NEEDS_ATTENTION` → `FAILED` (Abort action)
3. Wave-state recompute treats `NEEDS_ATTENTION` as "paused, do not advance" but does not propagate to sibling jobs.
4. Existing `FAILED` jobs in DDB are not migrated; v1 only applies going forward.

**Technical notes.**
- Job state machine likely lives in `daemon/agent-daemon.mjs` and `functions/cron/wave-completion-check.ts`. Audit both.
- Add fields per PRD §9.2: `attentionItemIds: string[]`, `salvageableExtractors: string[]`, `escalationPayload?: {...}`, `retryOf?: string`.

**Dependencies.** None.
**Effort.** `M` (½ day)
**Type.** `arch`
**DoD.** Type tests + a unit test asserting the transitions; manual smoke that a forced failure produces `NEEDS_ATTENTION` not `FAILED`.

---

### Story 1.2 — Inject universal escalation extractors into agent prompts

**As an** agent, **I want** a documented protocol to signal "I'm stuck" or "I need a human", **so that** the daemon can route me to the operator instead of looping.

**Acceptance criteria.**
1. New file `daemon/pipelines/lib/exit-signals.mjs` exports a constant `EXIT_SIGNALS_PROMPT_SUFFIX` containing the prompt block per PRD §8.6.
2. Pipeline runner in `daemon/agent-daemon.mjs` (or wherever the agent prompt is assembled) appends `EXIT_SIGNALS_PROMPT_SUFFIX` to every agent's first turn, exactly once per session.
3. Three new extractors registered globally on every step (in addition to per-step extractors):
   - `EXIT_DONE` — matches `---DONE---` (boolean presence)
   - `ESCALATION` — matches the full `---ESCALATE---…` block, parsed into `{ whatFailed, whatTried[], whyStuck, recommendedAction, humanQuestion? }`
   - `HUMAN_QUESTION` — matches `---NEED-HUMAN---\nHUMAN_QUESTION: …` (string)
4. When `ESCALATION` or `HUMAN_QUESTION` extracts: daemon transitions job to `NEEDS_ATTENTION` and writes the payload to `job.escalationPayload`.
5. Existing per-pipeline extractors continue to work unchanged.

**Technical notes.**
- The pipeline runner already does extractor parsing (`runExtractors` at `daemon/agent-daemon.mjs:313-348`). Add the three universal extractors to its config.
- The prompt suffix injection point is wherever `prompt` is built before spawning Claude — grep for `Spawning claude for step` in `agent-daemon.mjs`.
- Keep the suffix tight; every token costs across all jobs.

**Dependencies.** 1.1
**Effort.** `M` (1 day)
**Type.** `arch`
**DoD.** Unit tests for parser variations (well-formed, malformed, partial). Integration test: a stub agent that emits `---NEED-HUMAN---` produces a `NEEDS_ATTENTION` job with `escalationPayload.humanQuestion` populated.

---

### Story 1.3 — Loop detector

**As a** daemon, **I want** to detect when an agent is repeating the same tool call without progress, **so that** I can escalate to the operator before quota is wasted.

**Acceptance criteria.**
1. New module `daemon/pipelines/lib/loop-detector.mjs` exports a `LoopDetector` class with:
   - `observe(toolName, args)` — adds to sliding window; returns `{ action: 'continue' | 'hint' | 'force-escalate', repeatCount }`
   - Configurable via env vars: `LOOP_DETECTOR_WINDOW_SIZE` (default 10), `LOOP_DETECTOR_HINT_AT` (default 4), `LOOP_DETECTOR_FORCE_AT` (default 6)
2. Hash function: `sha1(toolName + JSON.stringify(sortedArgs))`. Args are deeply sorted by key to handle reordering.
3. When `action === 'hint'`: daemon injects a system message into the agent stream (using Claude SDK's mid-turn injection if available, otherwise queued for next turn): *"You appear to be retrying the same operation. If you cannot find a different approach, please escalate via `---ESCALATE---`."*
4. When `action === 'force-escalate'`: daemon terminates the step with `triggeredBy: LOOP_DETECTED` and a payload containing the repeated tool call.
5. Per-step `LoopDetector` instance — does not bleed across steps.

**Technical notes.**
- Tool-use events come through the Claude CLI's stream-json output. The party-turn pipeline already parses this (`daemon/pipelines/party-turn.mjs:236-257`); reuse the parser.
- "Inject system message mid-turn" may not be possible with `claude` CLI — fall back to "queue for next turn" if so. Document the limitation.
- False positives are the main risk. Prefer over-tolerant defaults (force at 6, not 4) and instrument early.

**Dependencies.** 1.1, 1.2
**Effort.** `L` (1-2 days)
**Type.** `arch`
**DoD.** Unit tests covering: same call N times → escalates at N=6; alternating calls do not escalate; calls with different args do not collide. Manual: replay the dino3 stdout and confirm the playwright-finding loop would have triggered.

---

### Story 1.4 — Pre-flight validator framework + `folder-exists` validator

**As a** pipeline runner, **I want** to fail fast on obvious infrastructure errors, **so that** I don't waste a Claude spawn on conditions I can check cheaply.

**Acceptance criteria.**
1. New module `daemon/pipelines/lib/preflight.mjs` exports:
   - `runPreflight(checks: PreflightCheck[]): Promise<{ ok: true } | { ok: false, failedCheck, message }>`
   - Initial check types: `folder-exists` (with optional `writable_by` field)
2. `PipelineStep` interface in `functions/shared/pipelines/*.ts` gains optional `preconditions?: PreflightCheck[]` field.
3. Pipeline runner calls `runPreflight(step.preconditions)` *before* spawning Claude. On failure: marks job `NEEDS_ATTENTION` with `triggeredBy: PREFLIGHT_FAILED` and the structured `failedCheck` payload.
4. The `folder-exists` validator runs an SSM command (or local fs check, if running on the daemon's host) verifying:
   - Path exists
   - If `writable_by` specified: `stat -c %U:%G` matches and write permission is set
5. Validator failures are not retried — they require operator action.

**Technical notes.**
- The chown bug we just fixed would have been caught by `{ check: 'folder-exists', path: '${workingDir}', writable_by: 'ubuntu' }`.
- Plumb step variables (e.g., `${workingDir}`) into the validator before execution — there's an existing template substitution in the pipeline runner.
- Future check types (`port-free`, `dependency-installed`, `dev-server-reachable`, `env-var-set`, `disk-space-available`) are stubs in this story; only `folder-exists` is implemented. Stories in later epics may add others.

**Dependencies.** 1.1
**Effort.** `M` (1 day)
**Type.** `arch`
**DoD.** Unit tests for each path (folder missing, folder exists wrong owner, folder exists correct). Add `folder-exists` check to the QA pipeline as the first concrete consumer.

---

### Story 1.5 — Salvage action (API + state apply)

**As an** operator, **I want** to apply already-extracted variables from a failed step as if it had succeeded, **so that** valid agent output isn't lost.

**Acceptance criteria.**
1. New endpoint `POST /api/jobs/:jobId/steps/:stepId/salvage` in `functions/api/index.ts`.
2. Request: empty body. Response: `{ ok: true, job: AgentJob, advanced: boolean }` or 4xx error.
3. Server logic:
   - Loads job; verifies status `NEEDS_ATTENTION` AND step has `salvageableExtractors.length > 0` AND pipeline-step's `salvageable !== false`.
   - Runs the step's apply logic (the same code path a successful step would take — usually epic patch + wave advancement) using `job.variables`.
   - Marks step `COMPLETED_VIA_SALVAGE`; appends to audit log: `{ action: 'salvage', actor: userId, at: now(), variables: [...names] }`.
   - Recomputes wave state; advances if appropriate.
4. Idempotent: salvaging twice returns the same response without double-applying.
5. Returns 409 with descriptive message if the step is not in a salvageable state.

**Technical notes.**
- "The step's apply logic" varies by step type (QA → epic patch with verdict; PM → epics generation; Dev → none). Reuse the success-path code by extracting it into a helper `applyStepOutput(jobId, stepId, variables)` used by both the success path and the salvage path.
- Audit log: extend the existing event log used by the daemon (`futurator-agent-events`) with a new event type `STEP_SALVAGED`.

**Dependencies.** 1.1
**Effort.** `L` (1-2 days)
**Type.** `arch`
**DoD.** Unit test: salvage on a stub QA job produces the same DDB writes as a successful QA closeout. Integration test: replay the dino3 job through salvage; confirm wave advances.

---

### Story 1.6 — Retry action (API)

**As an** operator, **I want** to re-run a failed step, optionally with a hint, **so that** I can recover from transient or fixable failures without restarting the plan.

**Acceptance criteria.**
1. New endpoint `POST /api/jobs/:jobId/steps/:stepId/retry`.
2. Request body (all optional): `{ hint?: string }`. Response: `{ ok: true, newJobId: string }`.
3. Server logic:
   - Loads original job; verifies status `NEEDS_ATTENTION`.
   - Counts consecutive retries via the `retryOf` chain. If `>= maxConsecutiveRetries` (default 3, configurable per step), returns 409 with message recommending Talk or Abort.
   - Creates a new `AgentJob` with the same pipeline + step config and fresh `jobId`. Sets `retryOf = originalJobId`.
   - If `hint` provided: prepends "Hint from operator: <hint>" to the agent's first turn (extends the prompt assembly).
   - Enqueues the new job in PENDING state for the daemon to pick up via the normal queue.
   - Original job remains `NEEDS_ATTENTION` — its attention item is auto-resolved with `resolution: 'retry'` linking to the new jobId.

**Technical notes.**
- "Prepend hint to first turn" — define how the prompt template handles the hint. Suggested: a new template variable `${OPERATOR_HINT}` that's empty by default.
- The new job is independent — has its own variables, its own session, its own retry counter (which references the chain via `retryOf`).
- Configurable per-step retry max: gate on `pipelineStep.maxConsecutiveRetries` if defined, else default 3.

**Dependencies.** 1.1, 1.2 (for the prompt-assembly extension)
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Integration test: failed job → retry → new job appears in queue → completes; retry chain length tracked; hitting cap returns 409.

---

### Story 1.7 — Skip action (API)

**As an** operator, **I want** to mark a failed step as manually skipped when downstream tolerates it, **so that** a flaky step doesn't block the entire plan.

**Acceptance criteria.**
1. New endpoint `POST /api/jobs/:jobId/steps/:stepId/skip`.
2. Request body: `{ reason?: string }`. Response: `{ ok: true, advanced: boolean }`.
3. Server logic:
   - Loads job; verifies status `NEEDS_ATTENTION`.
   - Verifies the pipeline step's `skipTolerant === true`. If not, returns 409 with explanatory message.
   - Marks step `MANUALLY_SKIPPED`; appends audit event with reason.
   - Variables for the skipped step are left empty; downstream steps that consume them must tolerate this (responsibility of the pipeline definition).
   - Recomputes wave state; advances.
4. `PipelineStep.skipTolerant` defaults to `false` (most steps require their output).

**Technical notes.**
- Audit which existing steps are safe to mark `skipTolerant: true`. Likely candidates: optional QA review on prototype rigor, idempotent cleanup steps.
- Consider a follow-up to surface `skipTolerant` per step in the UI (gray out Skip button when not tolerant) — that lives in Story 1.9.

**Dependencies.** 1.1
**Effort.** `S` (≤4 h)
**Type.** `std`
**DoD.** Skip on a tolerant step advances the wave; skip on a non-tolerant step returns 409 with clear message.

---

### Story 1.8 — Abort action (API)

**As an** operator, **I want** to terminate a job that cannot be recovered, **so that** the plan can move forward (or be archived).

**Acceptance criteria.**
1. New endpoint `POST /api/jobs/:jobId/steps/:stepId/abort`.
2. Request body: `{ reason?: string }`. Response: `{ ok: true }`.
3. Server logic:
   - Loads job; verifies status `NEEDS_ATTENTION` or `RUNNING`.
   - If `RUNNING`: signals the daemon to terminate the active Claude process for this step (best-effort SIGTERM via the daemon's job-control surface).
   - Marks job `FAILED` with audit event `STEP_ABORTED`.
   - Wave is *not* automatically advanced — abort means "this plan needs operator decision." Wave goes to `BLOCKED`; plan status optionally moves to `NEEDS_OPERATOR` (a new plan status — small extension).

**Technical notes.**
- Daemon needs a way to receive "abort jobId X" — could be a DDB poll for a new `abortRequested: true` field on the job, or an SSM command. Pick whichever is simpler with current infra.
- Confirmation modal lives in Story 1.9 — this story is just the API.

**Dependencies.** 1.1
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Abort marks the job FAILED; if RUNNING, the Claude subprocess terminates within 10s.

---

### Story 1.9 — Failed-step panel UI

**As an** operator, **I want** a clear, structured view of a failed step with all recovery options visible, **so that** I can decide what to do without reading 30 minutes of logs.

**Acceptance criteria.**
1. New component `src/components/labs/plans/failed-step-panel.tsx` rendered when a step is in `NEEDS_ATTENTION` (or `FAILED`) state.
2. Contents:
   - Status badge (amber for `NEEDS_ATTENTION`, red for `FAILED`)
   - Triggered-by label (mapped from enum to human-readable text)
   - "Agent's last words" section: if `escalationPayload` present, render `whatFailed` / `whatTried` (bullet list) / `whyStuck`; otherwise show last 200 chars of stdout
   - Action buttons row: `Salvage` (primary if salvageable), `Retry`, `Skip` (disabled with tooltip when not skip-tolerant), `Talk` (disabled with "coming in Epic 3" tooltip until Epic 3 ships), `Abort` (destructive, requires confirm modal)
   - Optional textarea for hint (toggled by clicking Retry; collapsed by default)
   - Cost & time chips: `cost so far: $X.XX`, `time elapsed: Mm Ss`
   - "Show full log" expander
3. Action button states reflect server constraints (disabled Salvage when no extractors fired; disabled Skip when not tolerant; etc.).
4. Successful actions trigger:
   - Optimistic UI update + toast
   - Plan/wave query invalidation in TanStack Query

**Technical notes.**
- Component lives alongside other plan-detail components in `src/components/labs/plans/`.
- Action calls go through new hooks in `src/hooks/use-plans.ts` (or a new `src/hooks/use-step-actions.ts`): `useSalvageStep`, `useRetryStep`, `useSkipStep`, `useAbortStep`.
- Confirm modal for Abort: reuse existing AlertDialog primitive.

**Dependencies.** 1.5, 1.6, 1.7, 1.8
**Effort.** `L` (1-2 days)
**Type.** `std`
**DoD.** Manual: failed step renders correct buttons; Salvage on dino3-equivalent works end-to-end; Abort with confirm works; Talk button is disabled with tooltip.

---

### Story 1.10 — Attention inbox v0

**As an** operator, **I want** a single place to see what needs my decision across all plans, **so that** I'm not refreshing N plan dashboards.

**Acceptance criteria.**
1. New DDB table `futurator-attention-items` (or extension of existing — see Open Question OQ-2 in PRD).
2. New endpoints:
   - `GET /api/attention?status=open` — returns list per `userId` (currently single-user, but field is reserved)
   - `POST /api/attention/:itemId/resolve` — body `{ resolution: 'retry' | 'salvage' | 'skip' | 'talk' | 'abort' | 'manual' }`
   - `POST /api/attention/:itemId/reopen`
3. Daemon writes attention items on every `NEEDS_ATTENTION` transition (Stories 1.1-1.4 hook into this — refactor to make it a single helper `createAttentionItem(jobId, stepId, payload)`).
4. New UI page `src/app/inbox/page.tsx` (or sidebar drawer in the existing layout — operator preference, default to sidebar for v0):
   - List items sorted by `createdAt` desc
   - Each row: plan name, step name, trigger reason chip, summary (truncated to 1-2 lines), recommended-action buttons inline
   - Filter chips at top: by plan, by trigger reason
   - Click expands to the full panel from Story 1.9
5. Sidebar badge `Inbox [N]` showing unresolved count, polling every 30s.

**Technical notes.**
- Schema fields per PRD §FR-9 / §9.2.
- Recommended actions on the inbox row are *shortcut copies* of the actions in the failed-step panel — they call the same hooks. No duplicated logic.
- Single-user assumption: `userId` stamped at creation but no per-user filtering applied yet (returns all items for now).

**Dependencies.** 1.5, 1.6, 1.7, 1.8, 1.9
**Effort.** `L` (1-2 days)
**Type.** `std`
**DoD.** Inducing a failure produces an inbox item within 5s; clicking Salvage from the inbox row works without navigating to the plan.

---

# Epic 2 — Concurrency manager

**Goal.** No more self-inflicted 429s. Interactive sessions never wait behind background pipeline work. Background pipeline work yields gracefully when interactive work appears.

**Scope.** `SessionPool` admission control with typed slots, event-driven 429 retry, step-boundary pre-emption, header concurrency chip, status endpoint.

**Out of scope.** API-key fallback (deferred per PRD §13). Multi-account OAuth pooling. Mid-step pre-emption.

**Demo.** Start a Dev wave on plan A; open a Party Mode chat on plan B; chat acquires a slot immediately, Dev step pauses at next boundary, no 429s logged.

---

### Story 2.1 — `SessionPool` core class

**As a** daemon, **I want** a single class managing all concurrent Claude session slots, **so that** admission decisions are centralized and queueable.

**Acceptance criteria.**
1. New module `daemon/lib/session-pool.mjs` exports a `SessionPool` singleton with:
   - `acquire(class: 'interactive' | 'critical' | 'background', meta: { jobId, stepId, planId }): Promise<Token>`
   - `release(token, completionMeta): void`
   - `predict(): { freeSlots: { interactive, critical, background }, queueDepth: number, activeTokens: Token[] }`
   - Event emitter: `on('slot_freed', listener)`, `on('queue_changed', listener)`
2. Configuration loaded from env vars at startup (per PRD §9.4):
   - `MAX_CONCURRENT_TOTAL` (default 2)
   - `MAX_CONCURRENT_INTERACTIVE_RESERVED` (default 1)
3. Slot allocation logic: floating-pool model. Interactive always has reserved slots; critical and background share the remainder, with critical priority.
4. Queue behavior:
   - `interactive` queue waits ≤30s, then rejects with `CAPACITY_SATURATED`
   - `critical` queue waits ≤5min, then escalates via attention item with `triggeredBy: CAPACITY_TIMEOUT`
   - `background` queue waits indefinitely (FIFO)
5. Daemon restart recovery: on startup, `SessionPool` scans `agent-jobs` for `RUNNING` jobs and registers their tokens (tokens reconstructed from job metadata).

**Technical notes.**
- In-memory state only; recovery from DDB on restart per AC-5.
- Token = `{ id, class, jobId, acquiredAt, releasedAt? }` — minimal opaque object.
- The "promote interactive from critical" logic (PRD §5.3) is part of `acquire()`.
- Hot-reload of slot config via SIGHUP is a bonus, not required for v1.

**Dependencies.** None.
**Effort.** `XL` (2-3 days)
**Type.** `arch`
**DoD.** Unit tests: acquire/release, queueing across classes, promotion, timeout behavior. Integration test: simulated 5-job concurrent burst against ceiling=2 produces correct slot allocation.

---

### Story 2.2 — Integrate `SessionPool` into job runner

**As a** pipeline runner, **I want** every Claude spawn to go through `SessionPool.acquire()`, **so that** no spawn ever bypasses admission control.

**Acceptance criteria.**
1. Every Claude-spawning code path in `daemon/agent-daemon.mjs` and `daemon/pipelines/*.mjs` calls `SessionPool.acquire(class, meta)` before spawning and `SessionPool.release(token)` after the session terminates (success or failure).
2. `concurrencyClass` is determined by:
   - Pipeline step's declared `concurrencyClass` field (added in Story 2.5 below — for now, default rules)
   - Default rules: `party-turn` and `agent-turn` jobs → `interactive`; pipeline steps in the plan currently focused by the operator → `critical` (per Story 2.6 surfacing); all others → `background`
3. Job's `concurrencyClass` field is persisted on creation per PRD §9.2.
4. Failure of `acquire` (capacity saturated, timeout) is converted to a `NEEDS_ATTENTION` transition (or 4xx response for synchronous interactive paths).
5. Existing 429 retry logic in the daemon is removed and replaced by Story 2.3.

**Technical notes.**
- Audit for all Claude-spawning sites; each must be wrapped. A typical pipeline step looks like: prompt assembly → spawn → stream parse → write variables. The acquire/release wraps the spawn.
- The "currently focused plan" needs a signal from the UI to the daemon. v1 simplification: track `focusedPlanId` per user in DDB, updated on every plan-detail page view.

**Dependencies.** 2.1
**Effort.** `L` (1-2 days)
**Type.** `arch`
**DoD.** Manual: open two plans + a party chat; observe correct slot class assignment via `/api/health/concurrency` (Story 2.6).

---

### Story 2.3 — Event-driven 429 retry

**As a** daemon, **I want** to retry 429'd calls when a slot frees, not on a blind timer, **so that** retries don't burn quota against an unmoved wall.

**Acceptance criteria.**
1. Replace existing `daemon/lib/retry.mjs` (or wherever the 30s/2m/8m backoff lives) with event-driven logic:
   - On 429, parse the response body. Reasons:
     - `concurrent_requests` → register a one-shot waiter on `SessionPool.slot_freed`. Add 0-2s jitter before retry.
     - `daily_limit` / `monthly_limit` → no retry. Mark `NEEDS_ATTENTION` with `triggeredBy: QUOTA_EXHAUSTED`. Notify operator immediately.
     - Unknown / unparseable → fall back to exponential backoff capped at 2 retries.
2. Total maximum wait per step is bounded: 5 minutes wall-clock, after which the call fails into `NEEDS_ATTENTION`.
3. Retry attempts are logged with structured reason for analysis.

**Technical notes.**
- Anthropic 429 response body has a `type` field — verify exact structure against current API docs.
- The "register a one-shot waiter" pattern is straightforward with the EventEmitter `SessionPool` exposes.

**Dependencies.** 2.1, 2.2
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Inject a fake 429 with reason `concurrent_requests`; verify retry fires only after a slot frees. Inject `daily_limit`; verify no retry.

---

### Story 2.4 — Step-boundary pre-emption

**As an** operator, **I want** my interactive request to acquire a slot promptly even if all are busy, **so that** I'm not blocked behind a long background job.

**Acceptance criteria.**
1. When `SessionPool.acquire('interactive', …)` queues and the only active slot is held by a `background` token: `SessionPool` flags the job behind that token with `pauseAfterCurrentStep: true` (DDB write).
2. Pipeline runner checks this flag between steps. If set: releases the token, re-enqueues the job in PENDING state with `priority: 'now'` (so it stays high-pri when it resumes), clears the flag.
3. The interactive request acquires the freed slot immediately.
4. Anti-thrash: a job that was just promoted out cannot be re-promoted for 60s (configurable via `MIN_PREEMPTION_HOLD_SECONDS`).
5. Audit event written for every preemption: `{ jobId, preemptedFor: interactiveJobId, atStep: stepId }`.

**Technical notes.**
- "Between steps" is the natural granularity — pipelines are step-decomposed. The runner already loops through steps in order; checking the flag at the top of the loop is enough.
- A step that's mid-Bash-call cannot be paused — the step finishes naturally first. Worst case wait = step duration.

**Dependencies.** 2.1, 2.2
**Effort.** `L` (1-2 days)
**Type.** `arch`
**DoD.** Integration test: long background job + interactive request → background pauses at step boundary → interactive proceeds → background resumes after.

---

### Story 2.5 — Concurrency-class declaration on pipeline steps

**As a** pipeline author, **I want** to declare a step's concurrency class explicitly when the default isn't right, **so that** I can override the runtime default rules.

**Acceptance criteria.**
1. `PipelineStep` interface in `functions/shared/pipelines/*.ts` gains optional `concurrencyClass?: 'interactive' | 'critical' | 'background'`.
2. Pipeline runner uses this override when present; falls back to the default rules from Story 2.2 otherwise.
3. Existing pipelines audited; default behavior preserved.
4. Documentation comment on the interface explains the three classes and when to use each.

**Technical notes.**
- Most pipeline steps will leave this undefined and inherit the default. Talk-to-agent and Party Mode pipelines (Epic 3) will explicitly set `interactive`.

**Dependencies.** 2.2
**Effort.** `S` (≤4 h)
**Type.** `triv`
**DoD.** Type check passes; one pipeline annotated with explicit class as a smoke test.

---

### Story 2.6 — Concurrency status endpoint + header chip

**As an** operator, **I want** to see at a glance how the concurrency pool is being used, **so that** I understand why things are queueing.

**Acceptance criteria.**
1. New endpoint `GET /api/health/concurrency` returns:
   ```json
   {
     "ceiling": 2,
     "slotsByClass": { "interactive": { "used": 1, "max": 1 }, "critical": { "used": 0 }, "background": { "used": 1 } },
     "queued": [
       { "jobId": "...", "class": "background", "queuedAt": "...", "planName": "..." }
     ],
     "activeTokens": [
       { "jobId": "...", "class": "interactive", "stepId": "...", "planName": "...", "acquiredAt": "..." }
     ],
     "recentRateLimits": [{ "at": "...", "reason": "concurrent_requests" }]
   }
   ```
2. New UI component `src/components/layout/concurrency-chip.tsx` rendered in the admin header.
3. Visual: small inline widget, e.g. `[● ● ○]  2/2 in use  ●1 queued`.
4. Hover/click opens a popover with:
   - Active sessions list (plan + step name)
   - Queue list with positions
   - "Promote to critical" button per background job (calls `POST /api/jobs/:jobId/promote-class` — small endpoint added in this story)
5. Polls `/api/health/concurrency` every 5s when the popover is open, every 30s when closed.

**Technical notes.**
- The endpoint is a thin wrapper around `SessionPool.predict()` — daemon writes its state to a DDB row periodically (every 5s); API Lambda reads.
- "Promote to critical" updates the job's `concurrencyClass` and (if currently queued) re-sorts the queue.

**Dependencies.** 2.1, 2.2
**Effort.** `L` (1-2 days)
**Type.** `std`
**DoD.** Manual: with two active jobs, the chip shows `2/2 in use`. Promote-to-critical reorders the queue.

---

# Epic 3 — Talk-to-agent v1

**Goal.** Conversational debugging on any agent's session — failed, completed, or in-flight. Generalize Party Mode's session machinery into a reusable channel.

**Scope.** New `agent-sessions` and `agent-conversations` tables, generalized `agent-turn` pipeline (refactored from `party-turn`), conversation API + SSE, conversation panel UI, apply-output bridge.

**Out of scope.** Multi-conversation per step (v2). Multi-user attribution (v2). Session forking for parallel branches (v2).

**Demo.** Open a Talk conversation on the dino3 QA step. Ask "why did you decide PASS." Receive a coherent answer. Click Apply. Wave advances.

---

### Story 3.1 — `futurator-agent-sessions` table + `AgentSession` type

**As a** system, **I want** to persist every Claude session as a first-class entity, **so that** I can resume, query warmth, and attach conversations.

**Acceptance criteria.**
1. New DDB table `futurator-agent-sessions` provisioned via `sst.config.ts`. PAY_PER_REQUEST, PITR enabled.
2. Schema:
   - PK: `sessionId` (UUID, our internal id)
   - GSI `jobId-stepId-index`: PK `jobId`, SK `stepId`
   - Fields: `claudeSessionId`, `firstTurnAt`, `lastTurnAt`, `tokenCount`, `costUsd`, `status` (`ACTIVE` | `IDLE` | `STALE` | `ARCHIVED`), `cwd`, `agentKind`, `compactedFrom?`
3. New repository `functions/shared/repositories/agent-sessions-repo.ts` exposing CRUD + a `findByJobAndStep(jobId, stepId)` query.
4. New types in `functions/shared/types/agent-session.ts`: `AgentSession`, `SessionWarmth = 'HOT' | 'WARM' | 'COLD' | 'STALE'`.
5. Daemon writes to this table on every Claude session creation (extracts `claudeSessionId` from the existing `system.init` event handler).

**Technical notes.**
- Existing `AgentJob.sessions?: Record<stepId, sessionId>` field is retained for backwards compat; new code reads from this table instead.
- Token count is updated per turn; deferred to Story 5.1 for full implementation. For now, Story 3.1 just creates the row and updates `lastTurnAt`.

**Dependencies.** None.
**Effort.** `M` (1 day)
**Type.** `arch`
**DoD.** Type tests pass; manual: spawn a party-mode session, verify a row appears.

---

### Story 3.2 — `futurator-agent-conversations` table + `AgentConversation` type

**As a** system, **I want** to persist conversation threads as separate entities from the underlying sessions, **so that** I can support fork/multi-branch debugging in future versions and clearly bound apply-output semantics.

**Acceptance criteria.**
1. New DDB table `futurator-agent-conversations` provisioned via `sst.config.ts`.
2. Schema:
   - PK: `conversationId` (UUID)
   - GSI `sessionId-index`: PK `sessionId`
   - Fields: `sessionId`, `jobId`, `stepId`, `mode` (`fresh` | `resume` | `compact-resume`), `openedBy` (userId), `openedAt`, `lastActivityAt`, `status` (`OPEN` | `APPLIED` | `CLOSED`), `messageCount`, `totalCostUsd`, `appliedToJobAt?`, `costCeilingUsd`
3. Repository `functions/shared/repositories/agent-conversations-repo.ts`.
4. Type `AgentConversation` in `functions/shared/types/agent-session.ts`.

**Technical notes.**
- Conversations point to a session (not the other way around) — one session may have multiple conversations attached over time.
- v1: at most one `OPEN` conversation per `(sessionId)` enforced at the API layer (Story 3.4).

**Dependencies.** 3.1
**Effort.** `M` (1 day)
**Type.** `arch`
**DoD.** Type tests; smoke insert.

---

### Story 3.3 — Generalize `party-turn` → `agent-turn`

**As a** developer, **I want** the session-resume + chat machinery decoupled from BMAD-Party-Mode specifics, **so that** any agent's session can be conversed with via the same code path.

**Acceptance criteria.**
1. New file `daemon/pipelines/agent-turn.mjs` containing the generic version: spawn-or-resume Claude session, stream events to event log, persist turns, update `AgentSession.lastTurnAt` and `tokenCount`.
2. Decouplings vs `party-turn.mjs`:
   - No `/bmad-party-mode` prefix (system prompt comes from the conversation's `systemPromptSource` — for fresh-mode talk-to-agent, this is the handoff template; for resume-mode, the original session's transcript carries it).
   - No party-projects lock check; replaced by `tryAcquireConversationLock(conversationId)` against `futurator-agent-conversations`.
   - Working directory comes from the `AgentSession.cwd`, not from a party-projects row.
3. `party-turn.mjs` is rewritten as a thin wrapper that prepends `/bmad-party-mode` to the first turn's content and calls `agent-turn.mjs`. Existing Party Mode behavior is unchanged.
4. Existing Party Mode integration tests pass without modification.
5. New `tryAcquireConversationLock(conversationId)` in `agent-conversations-repo.ts`.

**Technical notes.**
- This is the meatiest refactor in Epic 3. Party Mode is in active use — extra care to not regress.
- "Handoff template" for fresh-mode: a templated string with sections for `taskBrief`, `agentTriedSummary`, `failureReason`, `latestVariables`. Content of the template is defined here; it's used by Story 3.4.

**Dependencies.** 3.1, 3.2
**Effort.** `XL` (2-3 days)
**Type.** `arch`
**DoD.** Party Mode regression tests pass. New `agent-turn.mjs` can be invoked directly with a conversation id and message content; produces an Active row in `agent-sessions` and a turn event in `agent-events`.

---

### Story 3.4 — Conversation creation API

**As an** operator, **I want** to start a conversation on a specific step, **so that** I can begin chatting with that agent's session.

**Acceptance criteria.**
1. New endpoint `POST /api/jobs/:jobId/steps/:stepId/conversations`.
2. Request body: `{ mode: 'fresh' | 'resume' | 'compact-resume' }`. Default if omitted: `'fresh'`.
3. Server logic:
   - Loads job + step + existing session (if any).
   - Verifies no other `OPEN` conversation exists for this `(sessionId)` (v1 single-conversation rule).
   - For `resume` / `compact-resume`: requires an existing `claudeSessionId`. Returns 404 if the step never had a Claude session.
   - For `compact-resume`: enqueues a Sonnet compaction job first (Story 5.3 will implement; for v1 stub just returns 501 if requested), then opens conversation against the compacted session.
   - For `fresh`: creates a new session row (no `claudeSessionId` yet — daemon will populate on first turn). System prompt = handoff template populated from job state.
   - Creates `Conversation` row with status `OPEN`.
4. Response: `{ conversationId, sessionId, warmth, estimatedFirstTurnCost }`.
5. Estimated first-turn cost = simple calculation: `tokenCount * pricePerInputToken` for the appropriate cache state. Use static cost constants for v1.

**Technical notes.**
- The handoff template is filled with: original step name, `escalationPayload` (if any), latest `job.variables`, plan intent. Keep it under ~2k tokens.
- `compact-resume` returning 501 is acceptable for Epic 3 v1; Story 5.3 enables it.

**Dependencies.** 3.1, 3.2, 3.3
**Effort.** `L` (1-2 days)
**Type.** `std`
**DoD.** Integration: open conversation in fresh mode on a failed step → returns conversationId; open in resume mode on a step with a session → returns conversationId; open second on same session → 409.

---

### Story 3.5 — Conversation messages API + SSE event stream

**As an** operator, **I want** to send messages and stream agent responses, **so that** the chat feels real-time.

**Acceptance criteria.**
1. New endpoint `POST /api/conversations/:conversationId/messages`.
   - Request body: `{ content: string }`.
   - Server: verifies conversation status `OPEN`; verifies cost not exceeded (`totalCostUsd >= costCeilingUsd` → 409); enqueues an `agent-turn` job for the daemon.
   - Response: `{ messageId, jobId }`.
2. New endpoint `GET /api/conversations/:conversationId/events` (SSE stream).
   - Streams events from `futurator-agent-events` filtered by this conversation.
   - Replays events from `since` query param if provided (default: replay everything from conversation open).
   - Connection kept alive with heartbeat every 15s.
3. Daemon's `agent-turn` pipeline writes structured events:
   - `conversation.user_message` — operator's content
   - `conversation.agent_text` — agent text deltas
   - `conversation.tool_use` — agent tool calls
   - `conversation.turn_complete` — with cost delta
4. UI subscribes via EventSource (Story 3.7).

**Technical notes.**
- Lambda functions can support SSE via response streaming (added to AWS Lambda recently). Verify our SST setup supports this; if not, fall back to short-lived polling at 1s interval.
- Cost cap enforcement at 409 prevents the conversation from blowing past its budget.

**Dependencies.** 3.3, 3.4
**Effort.** `L` (1-2 days)
**Type.** `arch`
**DoD.** Curl POST a message → see SSE events arrive in real-time (or near-real-time via polling fallback).

---

### Story 3.6 — Apply-output API

**As an** operator, **I want** to apply an agent's conversation output to the canonical job state, **so that** debug conversations can fix things, not just observe.

**Acceptance criteria.**
1. New endpoint `POST /api/conversations/:conversationId/apply-output`.
2. Request body: `{ extractWith?: string }` (optional name of a specific extractor; default: run the original step's full extractor set).
3. Server logic:
   - Loads conversation + most recent agent turn from event log.
   - Runs the step's extractors against the agent turn's text.
   - If required extractors all fire: invokes the same `applyStepOutput` helper as Story 1.5 (Salvage). Updates `job.variables`, marks step `COMPLETED_VIA_TALK`, advances wave.
   - If extractors fail: returns 422 with `{ extractorsThatFired, extractorsThatFailed }`. Conversation stays `OPEN`.
   - On success: updates conversation `status: APPLIED`, `appliedToJobAt: now()`. Conversation can still be re-opened for follow-ups (re-opening sets status back to `OPEN`).
4. Audit event written.

**Technical notes.**
- New status enum value `COMPLETED_VIA_TALK` distinct from `COMPLETED_VIA_SALVAGE` for traceability.
- Extractor reuse: the per-step extractor config lives on the pipeline. Apply by `(jobId, stepId)`-keyed lookup of the original pipeline def.

**Dependencies.** 1.5, 3.5
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Conversation produces a valid `---QA_REPORT---` → Apply succeeds → wave advances. Conversation produces malformed output → Apply returns 422 with the missing extractor list.

---

### Story 3.7 — Conversation panel UI

**As an** operator, **I want** a chat panel that feels like Party Mode but attached to any step, **so that** debugging is fluid.

**Acceptance criteria.**
1. New component `src/components/labs/conversations/conversation-panel.tsx`.
2. Mounted as a slide-out drawer from the failed-step panel (or any step panel) when "Talk" is clicked.
3. Header: agent kind chip, step name, plan name, session warmth chip (`warm — $0.04 to resume`), close button.
4. Mode selector (rendered before first message): three radio options (fresh / resume / compact-resume), each showing estimated cost; default `fresh`. Hidden after first message is sent.
5. Chat scroll: agent turns rendered with markdown; tool calls collapsible.
6. Composer: textarea + Send button. Live char count + cost preview.
7. Footer: "Apply this output" button (active when last agent turn matches the step's extractors per Story 3.6 dry-run check).
8. Subscribes via EventSource to `/api/conversations/:conversationId/events` for live updates.
9. Shows running cost meter at top-right; turns red at 80% of cap, blocked at 100%.

**Technical notes.**
- Reuse Party Mode chat scroll/composer components if they exist; refactor to a shared `chat-thread.tsx` if Party Mode component is currently bespoke.
- Apply-output dry-run: a separate API endpoint or a query param on `apply-output` that returns "would-succeed: yes/no" without committing — small extension to Story 3.6.

**Dependencies.** 3.4, 3.5, 3.6
**Effort.** `XL` (2-3 days)
**Type.** `std`
**DoD.** Click Talk → panel opens → send message → agent responds within 5s → click Apply → wave advances.

---

### Story 3.8 — Wire the failed-step panel's "Talk" button to Story 3.7

**As an** operator, **I want** the Talk button to actually open a conversation, **so that** Epic 3's value is reachable from Epic 1's UI.

**Acceptance criteria.**
1. The Talk button in the failed-step panel (Story 1.9) — disabled until now — becomes active.
2. Click opens the conversation panel (Story 3.7) bound to this step.
3. Loading state while the conversation is being created (POST in flight).
4. Handles errors gracefully (API 4xx → toast with reason).

**Technical notes.**
- Trivial integration; mostly removing the "coming soon" tooltip and wiring the click handler.

**Dependencies.** 1.9, 3.4, 3.7
**Effort.** `S` (≤4 h)
**Type.** `triv`
**DoD.** Manual: click Talk on a `NEEDS_ATTENTION` step → panel opens.

---

### Story 3.9 — Add Talk action to the attention inbox row

**As an** operator, **I want** to start a conversation directly from the inbox without navigating to the plan, **so that** I can triage quickly.

**Acceptance criteria.**
1. The inbox row (Story 1.10) gains a "Talk" inline button next to Salvage/Retry/Skip.
2. Click opens the conversation panel (Story 3.7) overlaid on the current page.
3. After Apply/Close, the inbox is invalidated and refreshed.

**Dependencies.** 1.10, 3.8
**Effort.** `S` (≤4 h)
**Type.** `triv`
**DoD.** Manual: click Talk in inbox → panel opens with correct context.

---

# Epic 4 — Cost & time discipline

**Goal.** Budget guardrails active across all jobs. No more "I forgot a plan was running and burned $$$."

**Scope.** Cost meter integrated into job execution, per-step time ceilings, per-job/plan/daily cost ceilings, soft warnings at 80%, plan dashboard cost meter, ceiling overrides.

**Out of scope.** Detailed cost analytics dashboards (future). Per-agent-kind cost shaping (future).

**Demo.** Set $1 ceiling on a plan; watch the system inject a warning at $0.80, then trigger `NEEDS_ATTENTION` at $1.00; raise ceiling to $5; resume; complete normally.

---

### Story 4.1 — Cost meter integrated into job execution

**As a** daemon, **I want** to track per-turn cost in real time, **so that** ceilings can be enforced before they're exceeded.

**Acceptance criteria.**
1. New module `daemon/lib/cost-meter.mjs` with:
   - `recordTurn(jobId, sessionId, costUsd, tokenIn, tokenOut, cacheStats): void`
   - `getJobCost(jobId): number`
   - `getPlanCost(planId): number`
   - `getDailyCost(): number`
2. Daemon parses cost from Claude CLI's `result` event (already includes cost field — verify in current daemon log format).
3. Updates `agent-jobs.costSoFarUsd` and `agent-sessions.costUsd` on every turn.
4. Plan-level cost is the sum of all jobs in the plan; computed via DDB query (or maintained as a running total via `plans.totalCostUsd` — already exists).
5. Daily cost = sum across all jobs in a 24-hour rolling window.

**Technical notes.**
- Cost field in Claude CLI output: `{ cost: { input, output, cache_read, cache_write }, total_usd }` — confirm exact shape from a recent daemon log.
- Avoid race conditions: use DDB conditional updates with retry on conflict.

**Dependencies.** 3.1 (sessions table — to record per-session cost)
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** A 5-turn job's `costSoFarUsd` matches the sum from the Claude CLI output. Plan total reconciles.

---

### Story 4.2 — Per-step time ceilings

**As a** daemon, **I want** to terminate a step that runs too long, **so that** stuck or runaway agents don't drain quota.

**Acceptance criteria.**
1. `PipelineStep` interface gains optional `timeCeilingMs?: number`. Default by agent kind: PM 5min, Dev 20min, Reviewer 10min, QA 10min, Deploy 5min.
2. Pipeline runner starts a wall-clock timer when a step begins. At `timeCeilingMs * 0.8`: inject system message into agent stream "*You have approximately Xs remaining. Please complete or escalate.*". At `timeCeilingMs * 1.0`: terminate the Claude subprocess and mark step `NEEDS_ATTENTION` with `triggeredBy: TIME_CEILING`.
3. Operator can raise the ceiling and Retry (per Story 1.6).

**Technical notes.**
- The 80%-warning system message is informational; the agent may or may not heed it. The 100% kill is enforced by the daemon.
- Subprocess termination: send SIGTERM, then SIGKILL after 5s grace.

**Dependencies.** 1.1, 1.2 (escalation parser — to surface termination as `NEEDS_ATTENTION`)
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** A long-running step is terminated at the configured ceiling; transitions to `NEEDS_ATTENTION` with the right trigger.

---

### Story 4.3 — Per-job, per-plan, daily cost ceilings

**As an** operator, **I want** budget caps to prevent runaway spend, **so that** a misbehaving agent cannot drain my quota.

**Acceptance criteria.**
1. Three configurable ceilings:
   - Per-job: `DEFAULT_PER_JOB_COST_CEILING_USD` (env, default $5). Stored on each job at creation.
   - Per-plan: `DEFAULT_PER_PLAN_COST_CEILING_USD` (env, default $50). Stored on each plan at creation.
   - Daily: `DEFAULT_DAILY_COST_CEILING_USD` (env, default $100).
2. Daemon checks these on every turn (after `recordTurn`):
   - At 80% of any: inject warning system message into the active stream.
   - At 100% of any: terminate the Claude subprocess; mark step `NEEDS_ATTENTION` with `triggeredBy: COST_CEILING` and a payload identifying which ceiling was hit.
3. New endpoints:
   - `POST /api/plans/:id/raise-cost-ceiling` body `{ newCeilingUsd, reason }` → updates plan ceiling, audit logged.
   - `POST /api/jobs/:jobId/raise-cost-ceiling` body `{ newCeilingUsd, reason }` → updates job ceiling.
4. Daily ceiling reset at configurable rollover (default 00:00 UTC).

**Technical notes.**
- Per-job ceiling is the tightest enforcement — fast feedback. Per-plan and daily are aggregates checked less frequently (every 10 turns or every minute, whichever first).
- Audit log every override with operator + reason — important for accountability.

**Dependencies.** 4.1
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** A job with $0.50 ceiling is terminated when cost reaches $0.50; raising the ceiling and retrying succeeds.

---

### Story 4.4 — Soft-warning system message injection

**As an** agent, **I want** to know when I'm close to a budget, **so that** I can choose to escalate instead of plowing through.

**Acceptance criteria.**
1. Reusable helper `injectSystemMessage(activeSessionId, message)` in the daemon.
2. Used by Stories 4.2 (time warning) and 4.3 (cost warning).
3. Message format: `"[SYSTEM] You have approximately $X remaining (or Ys time). Please complete or use ---ESCALATE--- if you cannot."`.
4. Mid-turn injection support: depends on Claude CLI capabilities. If not supported, queue the message to be prepended to the next turn the operator/system sends. Document the limitation either way.

**Technical notes.**
- This is the same primitive Story 1.3 (loop detector hint) needs — share the helper.

**Dependencies.** 1.3, 4.2, 4.3
**Effort.** `S` (≤4 h)
**Type.** `triv`
**DoD.** Trigger an 80% cost warning manually; verify the system message appears in the next agent turn.

---

### Story 4.5 — Cost meter UI on plan dashboard

**As an** operator, **I want** to see per-plan cost in real time, **so that** I can decide when to raise ceilings or stop a runaway plan.

**Acceptance criteria.**
1. Add cost meter component to plan dashboard header.
2. Visual: `$X.XX / $Y.YY` with a horizontal progress bar; bar turns amber at 80%, red at 100%.
3. Click opens a small modal: "Raise ceiling" textarea + Save button → calls `POST /api/plans/:id/raise-cost-ceiling`.
4. Live update: refetches every 5s when active, every 30s when idle.

**Dependencies.** 4.3
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Cost meter shows correct value; raising ceiling works; bar color changes at thresholds.

---

### Story 4.6 — Daily cost summary widget

**As an** operator, **I want** a one-glance view of today's total spend, **so that** I notice when I'm trending toward the daily cap.

**Acceptance criteria.**
1. Small widget in the admin header (next to or under the concurrency chip from Story 2.6).
2. Shows `$X.XX today` with a tiny progress bar against the daily ceiling.
3. Hover: tooltip breaking down spend by plan.
4. Click: navigates to a simple cost-by-plan list page (new minimal page; full analytics deferred).

**Dependencies.** 4.3
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Widget shows correct daily total; navigation works.

---

# Epic 5 — Cache & context optimization

**Goal.** Make session resume cheap by tracking warmth and auto-compacting bloated sessions. Hide warming/compaction details from the operator while exposing the cost impact.

**Scope.** Token-count tracking, warmth chips in UI, auto-compaction worker, resume-mode cost previews, audit + dedupe of agent prompt prefixes for cache stability.

**Out of scope.** Cache warming via no-op pings (simple to add later if data warrants). Cross-account cache pre-loading (not applicable — single account).

**Demo.** Open a Talk conversation on a 100k-token session; UI shows session being compacted automatically; resume cost drops from ~$0.30 to ~$0.05.

---

### Story 5.1 — Track token count + cost per session turn

**As a** system, **I want** every turn's token usage recorded against the session, **so that** I can compute warmth-aware cost estimates.

**Acceptance criteria.**
1. `agent-turn.mjs` (Story 3.3) extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` from each turn's API response metadata in the stream.
2. After each turn, atomically updates `agent-sessions`: `tokenCount += input + output`, `costUsd += turnCostUsd`, `lastTurnAt = now()`, `status = ACTIVE` (or `IDLE` after a release).
3. `Session.status` transitions:
   - `ACTIVE` while a turn is in flight
   - `IDLE` after turn completes
   - `STALE` after `SESSION_STALE_AFTER_MINUTES` (env, default 30) — set by a periodic sweeper
   - `ARCHIVED` after compaction (Story 5.3) or explicit close
4. Helper `getSessionWarmth(session): SessionWarmth` — pure function based on `now() - lastTurnAt`.

**Technical notes.**
- The Claude CLI streams turn-completion events with usage metadata. Locate and parse these in `agent-turn.mjs`.
- Sweeper for `STALE` transition: simple 5-min cron in the daemon scanning for `IDLE` sessions older than threshold.

**Dependencies.** 3.1, 3.3
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** A 5-turn conversation's `tokenCount` matches the sum from the CLI events. `getSessionWarmth` returns correct values across time gaps.

---

### Story 5.2 — Session warmth chips in UI

**As an** operator, **I want** to see warmth and cost-to-resume on every session, **so that** I can choose between fresh and resume modes informedly.

**Acceptance criteria.**
1. Conversation panel header (Story 3.7) shows `warm — $0.04 to resume` when `mode = resume` is selected (or hovered).
2. Mode selector (Story 3.7) shows cost preview per mode:
   - `fresh: $0.01 (cold start)`
   - `resume: $0.04 (warm)` or `$0.31 (cold)`
   - `compact-resume: $0.04 (compacted to ~30k tokens)` (estimate)
3. Color coding: green (HOT/WARM), amber (COLD), red (STALE).
4. Tooltip explains each warmth class and the implication for cost.

**Dependencies.** 3.7, 5.1
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Switching mode in the panel updates the cost preview to match the formula. Manual: open a session you used <2 min ago vs >30 min ago and confirm the chips differ.

---

### Story 5.3 — Auto-compaction worker

**As a** system, **I want** large sessions automatically compacted in the background, **so that** subsequent resumes are cheap.

**Acceptance criteria.**
1. New cron-style task in the daemon, runs every 5 minutes.
2. Scans `agent-sessions` for: `status = IDLE` AND `tokenCount > SESSION_COMPACTION_TOKEN_THRESHOLD` (env, default 80000).
3. For each candidate: spawns a one-shot Sonnet call with a compaction prompt that summarizes turns 1..N-2 of the saved transcript into a single block.
4. Replaces the saved transcript on disk with the compacted version. Marks the original session `ARCHIVED` with `compactedFrom = originalSessionId`. Creates a new session row representing the compacted version.
5. Compaction uses the `BACKGROUND` slot class (must respect concurrency).
6. Compaction failures are logged and skipped — original session remains usable.
7. Resume operations (Story 3.4 with mode `compact-resume`) target the compacted session.

**Technical notes.**
- The `claude` CLI saves transcripts on disk per session. Locate the path and the format. Compaction = regenerate with a synthesized "[CONVERSATION COMPACTED]" block in place of N early turns.
- Compaction prompt template: ~500 tokens, instructs Sonnet to produce a structured summary preserving file paths, decisions, key tool outputs, and current goal.
- Compaction itself costs ~1 turn's worth of input tokens — measurable and worth amortizing over 2-3 subsequent resumes to break even.

**Dependencies.** 3.1, 5.1
**Effort.** `XL` (2-3 days)
**Type.** `arch`
**DoD.** A 100k-token session is compacted to <40k. Resume against the compacted session works and the agent retains key context. Original session preserved for audit.

---

### Story 5.4 — `compact-resume` mode end-to-end

**As an** operator, **I want** the `compact-resume` mode in the conversation panel to actually work, **so that** I have an option between cheap-fresh and expensive-full-resume.

**Acceptance criteria.**
1. Story 3.4's stub `501 Not Implemented` for `compact-resume` is removed.
2. When operator chooses `compact-resume`: API enqueues a compaction job (Story 5.3 logic, but on-demand instead of via the periodic sweep), waits for it (sync, with a 30s timeout), then opens the conversation against the compacted session.
3. Cost preview accurately reflects compaction overhead + post-compact cheaper resume cost.

**Dependencies.** 3.4, 5.3
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Operator selects `compact-resume`; conversation opens after compaction; first turn's cost matches preview within 20%.

---

### Story 5.5 — Audit + dedupe agent prompt prefixes

**As a** system, **I want** identical prompt prefixes across same-kind agent invocations, **so that** Anthropic's API-side cache hits across sessions.

**Acceptance criteria.**
1. Audit all agent prompt templates in `daemon/pipelines/templates/*.tpl` and `daemon/pipelines/lib/`. Identify any cache-busters: timestamps, random IDs, free-form variables interpolated into the system prompt prefix.
2. Refactor templates so the cache-stable prefix (system prompt + tool definitions + project context) is identical across invocations of the same agent kind. Move all variable content to the user message.
3. Document the cache-stable prefix structure in `daemon/pipelines/templates/README.md`.
4. Verify with metrics: same-kind jobs run within 5 min of each other show >50% input tokens served from cache (visible in `usage.cache_read_input_tokens`).

**Technical notes.**
- Cache-busters to grep for: `Date.now()`, `${timestamp}`, `${runId}`, `Math.random()`, `crypto.randomUUID()` in template files.
- This is a free 30-50% input cost reduction on background pipeline jobs — high ROI.

**Dependencies.** 5.1 (to measure)
**Effort.** `L` (1-2 days)
**Type.** `arch`
**DoD.** Audit doc produced; >50% cache hit rate confirmed on a same-kind back-to-back run.

---

# Epic 6 — Quality of service

**Goal.** Operator control over scheduling. Turn the constraint of fixed concurrency into a manageable schedule, not a constant blocker.

**Scope.** Job priority field, time-shifted batching scheduler, promote-to-critical override, optional email digest for attention items.

**Out of scope.** Slack/Discord webhooks (v1.x). Push notifications (future). Multi-tenant scheduling.

**Demo.** Queue a non-urgent retro tagged `nightly`; watch it sit in queue; advance time to 02:00; job runs in the configured window.

---

### Story 6.1 — Priority field on jobs

**As an** operator, **I want** to defer non-urgent work to off-hours, **so that** my daytime concurrency capacity is reserved for active development.

**Acceptance criteria.**
1. `AgentJob` gains field `priority: 'now' | 'nightly' | 'weekend'` (default `'now'`).
2. Plan creation form (and daemon-side enqueue helpers) accept an optional `priority` parameter.
3. UI: dropdown on job creation surfaces (e.g., "Run now" / "Run tonight" / "Run this weekend").

**Dependencies.** None.
**Effort.** `S` (≤4 h)
**Type.** `triv`
**DoD.** Type test; manual: queue a `nightly` job and verify it stays PENDING until the window.

---

### Story 6.2 — Time-shifted batching scheduler

**As a** daemon, **I want** to hold non-urgent jobs in a queue until the configured window, **so that** they don't compete with active work.

**Acceptance criteria.**
1. New module `daemon/lib/batch-scheduler.mjs`.
2. Configuration via env vars: `NIGHTLY_BATCH_WINDOW_START` (default `02:00`), `NIGHTLY_BATCH_WINDOW_END` (`06:00`), `WEEKEND_BATCH_WINDOW_START` (`Saturday 00:00`), `WEEKEND_BATCH_WINDOW_END` (`Sunday 24:00`).
3. Daemon's job-pickup logic: when scanning for PENDING jobs, filter out `priority: nightly` jobs unless current time is within nightly window. Same for `weekend`.
4. Within their window, batched jobs occupy `BACKGROUND` slots — they never bump higher-priority work.
5. UI surfaces "queued for tonight" status on batched jobs.

**Technical notes.**
- "Local time" — pick a default timezone (e.g., user's TZ from a profile field, fallback UTC). Document this.
- A job that's been waiting since yesterday's nightly window must still pick up in the next window if not run.

**Dependencies.** 6.1, 2.1
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Job tagged `nightly` doesn't run during the day; runs when window opens.

---

### Story 6.3 — Promote-to-critical override

**As an** operator, **I want** to bump a background job to critical priority, **so that** I can speed up something I'm watching without stopping a sibling job.

**Acceptance criteria.**
1. New endpoint `POST /api/jobs/:jobId/promote-class` body `{ to: 'critical' | 'background' }`.
2. Server: updates `job.concurrencyClass`. If currently queued in `SessionPool`, removes from old queue and re-inserts in new queue at appropriate position.
3. UI: button rendered in the concurrency chip popover (Story 2.6) per background job.
4. Audit logged.

**Dependencies.** 2.6, 6.1
**Effort.** `S` (≤4 h)
**Type.** `triv`
**DoD.** Promote a background job; confirm it advances in the queue ordering.

---

### Story 6.4 — Email digest for attention items

**As an** operator, **I want** an optional email when I have unresolved inbox items, **so that** I notice them without keeping the admin tab open.

**Acceptance criteria.**
1. New cron Lambda `functions/cron/attention-digest.ts` runs hourly.
2. Per user (single user in v1, but designed for multi): queries unresolved attention items created in the last hour. If any, sends an email digest.
3. Configurable per user via a profile setting `emailDigestEnabled: boolean` (default false).
4. Email content: subject "[Futurator] N attention items waiting", body with a list (plan, step, trigger reason, link to inbox).
5. Uses AWS SES with a verified sender address.

**Technical notes.**
- AWS SES sandbox mode initially OK (verified recipients only — single user, easy).
- Rate limiting: never more than one digest per user per hour.

**Dependencies.** 1.10
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Toggle digest on; create an attention item; receive email within the hour.

---

### Story 6.5 — User profile setting page (minimal)

**As an** operator, **I want** a simple settings page to toggle digest on/off and set my timezone, **so that** v1 quality-of-service features are configurable.

**Acceptance criteria.**
1. New page `src/app/settings/page.tsx`.
2. Fields: `emailDigestEnabled`, `timezone` (IANA tz string with select), `emailAddress` (read-only, from JWT).
3. Persisted on `futurator-users` table (extend existing user row).

**Dependencies.** 6.4
**Effort.** `M` (1 day)
**Type.** `std`
**DoD.** Page renders; settings persist; daemon's batch scheduler honors the user's timezone.

---

## Recommended sequencing

A two-track sequence works well for one developer:

```
Week 1:        Epic 1 (stories 1.1 → 1.10)
Week 2:        Epic 2 (stories 2.1 → 2.6)              | Epic 4 (stories 4.1 → 4.6, can interleave)
Week 3-4:      Epic 3 (stories 3.1 → 3.9)              |
Week 5:        Epic 5 (stories 5.1 → 5.5)
Week 5-6:      Epic 6 (stories 6.1 → 6.5)
```

For a two-developer team:
- Dev A: Epic 1 → Epic 3 → Epic 5
- Dev B: Epic 2 → Epic 4 → Epic 6 (Epic 4 starts as soon as Story 3.1 lands)

---

## Definition of "story ready for development"

Each story above qualifies as ready when:
- ✅ Acceptance criteria are testable
- ✅ Dependencies on other stories are explicit
- ✅ Technical notes identify file paths and interfaces
- ✅ Effort is sized
- ✅ Type is labelled (arch / std / triv)
- ✅ Definition of Done specifies verification

All 41 stories above meet this bar. Open-question items in the PRD (§12) may sharpen specific stories at implementation time but do not block start.
