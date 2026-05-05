# PRD — Pipeline v1: Self-Correction, Escalation & Multi-Agent Concurrency

| Field | Value |
|---|---|
| **Status** | Draft, ready for epic decomposition |
| **Version** | 1.0 |
| **Date** | 2026-04-26 |
| **Owner** | Ricardo Araya |
| **Companion docs** | `docs/concepts/pipelinev1-self-corrections-escalation.md` (planning notes) |
| **Triggering incident** | dino3 QA reviewer job, 2026-04-26 17:25 UTC — agent succeeded, daemon 429'd on closeout, output stranded |
| **Capacity model** | Claude Code OAuth subscription only (1 account). Raw API-key fallback and multi-account pooling are explicitly out of scope for v1 — see §13. |

---

## 1. Executive summary

Today's pipeline is a one-shot conveyor belt: each step runs, succeeds, or fails — and on failure the only recovery is "delete and start over." That model doesn't survive what's coming next: simultaneous development on 2+ apps, mid-pipeline party-mode discussions, and conversational debugging sessions, all sharing a single Claude Code account's small concurrency ceiling.

Pipeline v1 introduces three primitives that together turn the pipeline from a brittle conveyor belt into a resilient, observable, recoverable system:

1. **A typed slot-based admission queue (`SessionPool`)** that prioritizes interactive work over background pipeline jobs and prevents 429s by queuing on the daemon side instead of letting Anthropic reject us.
2. **A universal salvage / escalate protocol** that turns failed jobs into recoverable artifacts: extracted output is preserved, the agent self-reports why it stopped, and the human is offered explicit Salvage / Retry / Skip / Talk / Abort actions.
3. **A generalized `agent-turn` channel** that lets the user open a real conversation with any agent's session — failed, completed, or in-flight — built by decoupling the existing Party Mode infrastructure.

Capacity is the binding constraint. Pipeline v1 does not attempt to expand it (that's a later phase via API keys / multi-account OAuth). It maximizes the value extracted from the slots we have: fewer wasted retries, fewer dead-end failures, fewer accidental 429s, and a much better story for "this needs a human."

---

## 2. Problem statement

### 2.1 What's broken today

**Failure is terminal, even when work is preserved.** When a step fails, the daemon marks the job `FAILED` and the wave `BLOCKED`. There is no mechanism to apply already-extracted output, retry just the failed step, or ask the agent what happened. The dino3 incident is the canonical example: a complete `---QA_REPORT---` with PASS verdict was extracted into `job.variables`, then a 429 on a closeout call killed the step. Three retries also 429'd. The report sits in DDB with no path to apply it.

**Concurrency is unmanaged.** The daemon enforces a 2-concurrent-session ceiling but has no notion of priority. A user-initiated party-mode chat and a background QA job race for the same slots; whichever spawns first wins, the other 429s and dies. With the user's stated intent to run **2+ apps in parallel pipelines plus interactive sessions**, the current behavior is a sustained outage waiting to happen.

**Retries are blind.** On 429, the daemon waits 30s → 2m → 8m. None of those windows are correlated with whether a slot has actually freed up. They consume retries against a wall that hasn't moved, then give up.

**Failures don't escalate.** Retry exhaustion writes a 300-character message to logs and stops. There is no inbox, no notification, no recommended action, no path back to a working state. The user discovers failures by refreshing the UI.

**No conversational debug surface.** Once a step has failed, the only artifact is a log. The 50k-200k tokens of context inside the agent's session — file reads, tool outputs, decision trail — are inaccessible. The user can't ask "what did you find" or "why did you decide PASS for that screenshot." This is the single biggest leverage opportunity the system is leaving on the table.

### 2.2 Why now

The system was built for one user, one app, one linear pipeline. Three changes in usage are converging:

- **Multi-app development** — the user is now spinning up multiple plans (dino3, bmad, dino-chrome, brick-breaker, pong-game). Cross-plan contention for the 2 slots is constant.
- **Mid-pipeline interactive use** — Party Mode is being used as an active design surface during plan execution, not just at the start. Interactive sessions interleave with pipeline runs.
- **Higher per-step cost** — agents (especially QA with screenshots) accumulate large sessions; failed jobs waste hundreds of K tokens that could have been salvaged.

Without v1 changes, every additional concurrent app or chat increases failure rate roughly linearly. The user's roadmap is multi-app + multi-conversation; without admission control, that roadmap is bottlenecked by the bug class dino3 demonstrated.

---

## 3. Goals & non-goals

### 3.1 Goals

- **G1.** Eliminate stranded-output failures — when an agent emits valid structured output, the system always offers a path to apply it, regardless of downstream errors.
- **G2.** Eliminate user-facing 429s caused by self-contention — the daemon's own concurrent calls never trigger Anthropic rate limits.
- **G3.** Make every failed step recoverable — the user can always retry, salvage, skip, talk to, or abort. No more "delete the plan and start over."
- **G4.** Enable conversational debugging of any agent session — the user can chat with a failed QA reviewer, an in-flight Dev agent, or a completed PM run, and apply the conversation's output back to the pipeline.
- **G5.** Make concurrency observable — the user can see at a glance how many slots are in use, what's queued, and why their interactive request is waiting.
- **G6.** Reduce repeat-failure waste — agents that hit a stuck loop self-detect and escalate instead of burning retries.
- **G7.** Operate safely within a fixed Claude Code subscription's concurrency ceiling, with graceful queueing and prioritization.

### 3.2 Non-goals (v1)

- **NG1.** Increase raw concurrency capacity. v1 lives within today's Claude Code limits. API-key fallback, multi-account OAuth pooling, and other capacity-expansion strategies are explicitly deferred to a later version.
- **NG2.** Replace BMAD Party Mode. Party Mode continues to work; v1 generalizes its underlying machinery so Party Mode becomes one consumer of a broader `agent-turn` channel.
- **NG3.** Build a full CI/CD-style observability stack. v1 surfaces concurrency state and attention items in the existing admin UI; metrics export to external systems is deferred.
- **NG4.** Multi-tenant conversation locking. v1 assumes one human user per Futurator-Admin instance; concurrent conversations on the same session by different users may interleave confusingly. Multi-user attribution is v2.
- **NG5.** Mid-step pre-emption. Steps run to completion (or to failure); pre-emption happens only between steps. Sub-step pause/resume is not in scope.

### 3.3 Success metrics

| Metric | Today | Target after v1 |
|---|---|---|
| **Self-inflicted 429 rate** (daemon-caused 429s ÷ total daemon Claude calls) | Unknown, ≥10% under contention | <0.5% |
| **Stranded-output incidents** (failed steps with extracted variables that the user cannot recover) | All such failures | 0 |
| **Mean time to recover from a failed step** (user-perceived) | Manual restart, ~minutes-to-hours | <30 seconds via salvage/retry button |
| **Retry-exhaustion failures with no actionable next step in UI** | 100% | 0% (every failure has typed actions) |
| **Concurrent-app capacity** (apps in active development + interactive sessions, no manual coordination) | 1 | 2-3 within Claude Code ceiling |
| **Loop-detected aborts** (steps caught thrashing and escalated early) | 0 | Tracked; non-zero is healthy |

---

## 4. Personas & use cases

### 4.1 Personas

- **Operator (Ricardo, today)** — single power user driving multiple plans. Comfortable with the admin UI and EC2 internals. Wants speed, observability, and the ability to intervene mid-pipeline without feeling locked out.
- **Future operators** — additional users may be added; v1 assumes single-user but doesn't preclude multi-user. UI surfaces (inbox, notifications) are scoped per-user.

### 4.2 Use cases

**UC-1. Two-app parallel development.** Operator has plan A in the Dev wave and plan B in the QA wave. They open Party Mode on plan A to discuss next steps. The system runs all three concurrently when slots allow, queues the lowest-priority work when contention occurs, and never produces a 429 the operator has to react to.

**UC-2. Failed step, salvageable output (the dino3 case).** Operator sees a failed QA step with extracted variables intact. They click "Salvage" and the wave advances; total user time spent: 5 seconds.

**UC-3. Failed step, ambiguous output.** Operator sees a failed Dev step with no clean salvage path. They click "Talk" and open a chat with the Dev agent's session. They ask "what file were you about to edit when you stopped?" The agent answers. The operator chooses Retry with a hint, and the wave advances.

**UC-4. Stuck-loop detection.** A Reviewer agent gets stuck rerunning the same `npm test` command 5 times in a row. The loop detector escalates after the 4th repetition; the attention item flags the loop with the recommendation "ask-human." The operator opens a chat, identifies a missing env var, fixes it, and retries.

**UC-5. Intentional skip.** Operator decides a flaky QA step is blocking progress on a low-stakes plan. They click "Skip" and the wave advances with a `MANUALLY_SKIPPED` audit trail.

**UC-6. Interactive session interrupting a pipeline.** A Dev wave is mid-run. The operator opens a Party Mode chat. The new chat acquires an interactive slot; if no slot is free, it borrows from the critical-path pool, pausing the next pipeline step at its boundary. The operator's chat is responsive; the pipeline resumes when the chat goes idle.

**UC-7. Cost ceiling tripped.** A long-running orchestrator-mode plan crosses its $50 ceiling. The agent is sent a system message ("you have $X left"). At hard ceiling the job is marked `NEEDS_ATTENTION` with reason `COST_CEILING`. The operator can raise the ceiling and retry, salvage what's done, or abort.

**UC-8. Operator off-hours batch run.** Operator queues a non-urgent retro pipeline tagged `priority: nightly`. The job sits in the queue until the configured low-traffic window (e.g., 02:00 local), then runs without competing against daytime interactive use.

---

## 5. Concurrency model

### 5.1 Capacity ground truth

- The daemon spawns Claude via the `claude` CLI authenticated against a single Claude Code OAuth subscription.
- Anthropic enforces a per-account concurrent-session ceiling. Today's observed ceiling is **2 concurrent sessions** (`1/2 concurrent` in daemon logs). This may move in either direction with subscription tier or Anthropic policy changes.
- All sessions — pipeline steps, party-mode chats, talk-to-agent conversations — draw from the same pool.
- Anthropic also enforces token/minute and request/minute limits, but the binding constraint at v1's workload is concurrent sessions.

v1 does not attempt to bypass this ceiling. It maximizes utility within it.

### 5.2 Slot classes & priority

The daemon defines three slot classes. Total slots = configured ceiling (default 2; raised by config when subscription tier allows).

| Class | Purpose | Default share of ceiling |
|---|---|---|
| `INTERACTIVE` | Party Mode chats, talk-to-agent conversations, any human-typing-now session | At least 1 reserved |
| `CRITICAL` | Pipeline step the user is currently watching (latest opened plan/wave) | Best-effort, may borrow remaining |
| `BACKGROUND` | All other pipeline steps (PM, Dev, Reviewer, QA, Deploy on un-watched plans) | Best-effort, lowest priority |

When the ceiling is 2: 1 reserved for `INTERACTIVE`, 1 floating between `CRITICAL` and `BACKGROUND`. When the ceiling rises (e.g., to 4): 2 reserved for `INTERACTIVE`, 1 for `CRITICAL`, 1 for `BACKGROUND`. Configuration drives the breakdown.

### 5.3 Admission protocol

Every Claude spawn calls `SessionPool.acquire(class, jobMeta)`:

1. If a slot in the requested class is free → grant immediately.
2. If `class == INTERACTIVE` and the `CRITICAL` pool has a free slot → grant via promotion (interactive borrows from critical).
3. If no slot is free:
   - `INTERACTIVE` callers wait up to 30s; if no slot frees, the call returns a structured "wait — capacity saturated" response that the UI surfaces immediately ("Your chat will start when a pipeline step finishes — in queue").
   - `CRITICAL` callers wait up to 5 minutes, then escalate via attention item.
   - `BACKGROUND` callers wait indefinitely (FIFO queue).
4. Releases happen automatically on session completion or step boundary.

**Pre-emption.** Interactive can pre-empt background **at step boundaries only**. Mechanism: when an `INTERACTIVE` request is queued and the only active slot belongs to a `BACKGROUND` job, the daemon flags the background job as `PAUSE_AFTER_CURRENT_STEP`. When that step completes, the background job releases its slot and re-queues itself. The interactive request acquires immediately.

**No mid-step pre-emption.** A step that is mid-Bash-call cannot be paused. Average step duration in the current pipeline is 30-180 seconds, so worst-case interactive wait is bounded by step duration.

### 5.4 429 handling

429s should be rare under v1 (admission control prevents most) but the system stays resilient:

- On 429 from Anthropic, parse the response body.
- If reason is `concurrent_requests` (transient, account momentarily oversubscribed): register a one-shot waiter on the next `SessionPool.slot_freed` event and retry. Add 0-2s jitter.
- If reason is `daily_limit` or `monthly_limit` (subscription quota exhausted): immediately mark step `NEEDS_ATTENTION` with reason `QUOTA_EXHAUSTED`. Do not retry. Notify the operator.
- If reason is unknown/unparseable: fall back to the existing 30s/2m/8m exponential backoff, but capped at 2 retries (not 3) to avoid burning quota on doomed retries.

### 5.5 Time-shifted batching

Pipeline jobs may be tagged with a `priority` field at creation:

- `now` (default for user-initiated waves) — runs immediately when slot available
- `nightly` — held in queue until the configured low-traffic window (default 02:00-06:00 local time)
- `weekend` — held until Saturday 00:00 local time

Time-shifted jobs occupy `BACKGROUND` slots when their window opens; they never bump scheduled work. This is the user-controllable lever for "I want this done, but not now."

### 5.6 Concurrency observability

The admin UI shows a persistent concurrency chip in the header:

```
[● ● ○]  2/2 in use, 1 queued
```

Hover/click expands to show: which jobs are using each slot, queue order, estimated wait, and a "promote to critical" override for `BACKGROUND` jobs.

---

## 6. Functional requirements

### FR-1: NEEDS_ATTENTION job state

**Description.** Introduce a new job status `NEEDS_ATTENTION` between `RUNNING` and `FAILED`. A job in this state is paused, preserves all state, and offers explicit recovery actions.

**Behavior.**
- Triggered by: retry exhaustion, agent-emitted `---ESCALATE---`, agent-emitted `---NEED-HUMAN---`, loop detection, pre-flight failure, post-validator failure, cost/time ceiling tripped, quota exhaustion.
- Job remains in DDB with all extracted variables intact.
- Wave containing the job pauses but does not fail; sibling jobs in the same wave continue.
- An attention item is created in the operator's inbox referencing the job + step + recommended actions.
- `FAILED` is reserved for the explicit Abort action (operator decision) or unrecoverable infrastructure errors (e.g., DDB write failure).

**Acceptance criteria.**
- The dino3-style failure produces `NEEDS_ATTENTION`, not `FAILED`.
- Operator sees the job in the attention inbox within 5 seconds of the trigger.
- All recovery actions (FR-2, FR-3, FR-7) operate on `NEEDS_ATTENTION` jobs without state corruption.

### FR-2: Salvage action

**Description.** A button on any failed step that re-applies already-extracted variables as if the step had succeeded.

**Behavior.**
- Available when: step has at least one successfully-extracted variable AND the pipeline step's `salvageable: true` flag is set (default true for output-bearing steps).
- On click: re-runs the pipeline step's apply logic against the existing `job.variables`, updates downstream state (epic patch, wave advancement), marks step `COMPLETED_VIA_SALVAGE`.
- Audit log entry records: who salvaged, when, what variables were applied, what the original failure reason was.
- Salvaged steps are visually distinguished in the UI (badge: "salvaged").

**Acceptance criteria.**
- Salvaging the dino3 QA job completes the wave and shows the QA verdict.
- A step with no extracted variables shows a disabled Salvage button with explanatory tooltip.
- Salvaging is idempotent — clicking twice doesn't double-apply.

### FR-3: Retry & skip actions

**Description.** Retry re-enqueues the failed step. Skip marks it `MANUALLY_SKIPPED` and advances the wave.

**Retry behavior.**
- Re-creates the agent job with the same params, fresh `jobId`, links to the original via `retryOf` field.
- Retries are bounded: after `maxConsecutiveRetries` (default 3) the action is disabled; the user must Talk, Salvage, or Abort.
- Optional "with hint" mode: opens a textarea where the operator types a one-line hint that gets prepended to the agent's first turn ("Hint from operator: …").

**Skip behavior.**
- Available only when the pipeline step declares `skipTolerant: true` (downstream steps must tolerate empty variables for this step).
- Marks step `MANUALLY_SKIPPED` and advances the wave.
- Audit log records skip + reason (optional textarea).

**Acceptance criteria.**
- Retrying a failed step produces a new job that the daemon picks up via the normal queue.
- Skip is disabled with tooltip when downstream steps depend on this step's output.
- Both actions trigger wave-state recompute.

### FR-4: Universal escalation extractors

**Description.** Every agent prompt (via a system-prompt suffix injected by the pipeline framework) recognizes structured exit signals.

**Signals.**
- `---DONE---` — normal completion, structured output follows per pipeline schema.
- `---ESCALATE---` — agent stuck or uncertain. Followed by:
  - `WHAT_FAILED:` (one line)
  - `WHAT_I_TRIED:` (bullet list, max 5 items)
  - `WHY_STUCK:` (one paragraph)
  - `RECOMMENDED_ACTION:` one of `retry-with-hint | skip-step | ask-human | abort-job`
  - `HUMAN_QUESTION:` (only when RECOMMENDED_ACTION is `ask-human`)
- `---NEED-HUMAN---` — shortcut for the common case. Followed by `HUMAN_QUESTION:` only.

**Behavior.**
- Daemon registers extractors for these signals on every step.
- When detected: marks job `NEEDS_ATTENTION`, populates attention item with the structured payload.
- The agent's recommendation appears prominently in the attention item but is advisory — the operator can choose any action.

**Acceptance criteria.**
- An agent emitting `---NEED-HUMAN---` with a question produces an attention item showing that exact question.
- The system prompt suffix is injected automatically by the pipeline runner; no per-pipeline boilerplate.

### FR-5: Loop detector

**Description.** Daemon-side monitor that detects an agent thrashing on the same operation and forces escalation.

**Behavior.**
- For each active step, hash every (tool_name, sorted_args) tuple emitted by the agent.
- Maintain a sliding window of the last 10 hashes.
- If any hash appears 4+ times in the window, inject a system message into the agent's stream: *"You appear to be retrying the same operation. If you cannot find a different approach, please escalate via `---ESCALATE---`."*
- If the same hash reaches 6 occurrences, terminate the step and create a `NEEDS_ATTENTION` item with reason `LOOP_DETECTED`.

**Acceptance criteria.**
- The dino3-style "find playwright everywhere" thrashing pattern triggers an escalation within 4-6 repeated calls.
- False positives (legitimate iteration like "read each file") are minimized by hashing on full tool args, not just tool name.
- Loop-detection events are logged for tuning.

### FR-6: Pre-flight validators

**Description.** Each pipeline step declares preconditions that the daemon checks before spawning Claude.

**Validator types (initial library).**
- `folder-exists` — path exists and is writable by the daemon's user (`ubuntu`).
- `port-free` — TCP port is not in use.
- `dependency-installed` — npm package or system binary is available.
- `dev-server-reachable` — HTTP GET on a URL returns 2xx within timeout.
- `env-var-set` — environment variable is non-empty.
- `disk-space-available` — at least N MB free on the target volume.

**Behavior.**
- Pre-flight runs as a fast, non-Claude-spawning check.
- A failing validator immediately marks the step `NEEDS_ATTENTION` with reason `PREFLIGHT_FAILED` and a structured payload identifying which check failed.
- Validators are declared per step in the pipeline definition.

**Acceptance criteria.**
- A QA step with `folder-exists` validator fails fast (no Claude spawn) when the folder is missing.
- The chown bug fixed in this session would have been caught by `folder-exists` with `writable_by: ubuntu`.

### FR-7: Talk-to-agent

**Description.** A conversation channel attached to any step (failed, completed, or in-flight) that lets the operator chat with the agent's session and apply outputs back to the canonical job.

**Lifecycle.**
1. Operator opens the step's panel and clicks "Talk."
2. UI prompts for mode:
   - `fresh` (default) — new Claude session with a handoff prompt summarizing what the original agent did and tried.
   - `resume` — `claude --resume <sessionId>`. Full continuity, higher cost (UI shows estimate).
   - `compact-resume` — runs a Sonnet compaction pass first, then resumes the compacted session.
3. A `Conversation` row is created in DDB and a backing `agent-turn` job is enqueued.
4. UI subscribes to the conversation's event stream (SSE), shows agent responses live.
5. Operator types messages; each turn enqueues a new `agent-turn` job.
6. Operator can click "Apply this output" — the conversation's most recent agent turn is run through the step's extractors; if all required extractors fire, the job's `variables` are updated and the wave advances.

**Constraints.**
- Conversations consume `INTERACTIVE` slots from `SessionPool`.
- Conversation cost is metered; default cap $1 per conversation, configurable per plan.
- Each step has at most one active conversation at a time (v1 limitation; multi-conversation per step is v2).
- Conversations are read-only with respect to the canonical job state until "Apply" is clicked.

**Acceptance criteria.**
- Operator can open a `fresh`-mode conversation on a `NEEDS_ATTENTION` step in <2 seconds.
- Apply correctly invokes the step's extractor set and produces the same downstream effect as a successful original step.
- Operator sees session warmth indicator + cost estimate before switching modes.

### FR-8: Session cache & warmth tracking

**Description.** Persist session state so the system knows when resuming will be cheap or expensive.

**Tracked per session.**
- `claudeSessionId` (from `system.init` event)
- `firstTurnAt`, `lastTurnAt`
- `tokenCount` (running total, updated from API response metadata)
- `status`: `ACTIVE` (turn in flight) | `IDLE` (recently used, may be warm) | `STALE` (>30 min idle) | `ARCHIVED` (compacted or closed)
- `costUsd` (running total)
- `agentKind` (PM, DEV, QA, REVIEWER, ORCHESTRATOR, PARTY)
- `cwd` (the project folder it ran in)

**Warmth classification.** Computed on read:
- `HOT` if `now - lastTurnAt < 2min` — near-100% cache hit on resume.
- `WARM` if `< 5min`.
- `COLD` if `< 30min`.
- `STALE` if `≥ 30min`.

**Auto-compaction.**
- A background daemon task scans `IDLE` sessions periodically (every 5 minutes).
- Sessions with `tokenCount > 80_000` are flagged for compaction.
- Compaction = a one-shot Sonnet call that summarizes turns 1..N-2 into a single block, replaces them in the saved transcript, and marks the session `ARCHIVED` with `compactedFrom: originalSessionId`.
- The original session is preserved (read-only); the compacted version is what subsequent resumes use.

**Acceptance criteria.**
- Session warmth is correct in UI within 30 seconds of last turn.
- A 100k-token session compacted to <40k tokens; subsequent resume measurably cheaper.
- No data loss on compaction (original session retained for audit).

### FR-9: AttentionInbox

**Description.** A list of items requiring operator decision, surfaced in the admin UI.

**Item shape.**
```
{
  attentionItemId,
  planId, jobId, stepId, sessionId,
  triggeredBy: 'RETRY_EXHAUSTED' | 'AGENT_ESCALATED' | 'AGENT_NEEDS_HUMAN' |
               'LOOP_DETECTED' | 'PREFLIGHT_FAILED' | 'POSTVALIDATE_FAILED' |
               'COST_CEILING' | 'TIME_CEILING' | 'QUOTA_EXHAUSTED',
  summary: string,           // one paragraph, agent- or daemon-generated
  whatAgentTried: string[],  // populated from ---ESCALATE--- payload when present
  costSoFar: number,
  estimatedCostToResume: number,  // computed from session warmth + token count
  recommendedActions: ('retry' | 'salvage' | 'skip' | 'talk' | 'abort')[],
  humanQuestion?: string,    // populated by ---NEED-HUMAN--- payload
  rawLogUrl: string,
  createdAt, resolvedAt, resolvedBy, resolution
}
```

**Behavior.**
- Inbox sorted by `createdAt` desc, with an "open count" badge in the admin sidebar.
- Filter chips: by plan, by triggeredBy, by recommendedAction.
- Resolution actions update the item with `resolvedAt`, `resolvedBy`, `resolution`.
- Resolved items remain visible (filterable as "show resolved") for audit.

**Notifications.**
- v1: in-app badge only.
- v1.x (configurable): optional email digest (default off).
- Future: webhook to Slack / Discord, push notifications.

**Acceptance criteria.**
- Inbox surfaces a new item within 5s of trigger.
- Recommended actions are clickable from the inbox without navigating to the plan.
- Filter and search work correctly across all triggeredBy types.

### FR-10: Cost & time ceilings

**Description.** Budget guardrails to prevent runaway agent spend.

**Ceiling types.**
- **Per-step time ceiling** — soft warning at 80%, hard kill at 100%. Configurable per step type (default 10 min for QA, 20 min for Dev, 5 min for PM).
- **Per-job cost ceiling** — soft warning at 80%, hard kill at 100%. Default $5.
- **Per-plan cost ceiling** — accumulates across all jobs in the plan. Default $50, raised by operator at any time.
- **Daily account ceiling** — across all plans. Default $100/day, configurable.

**Behavior.**
- At 80% of any ceiling, daemon injects a system message into the active agent's stream: *"You have approximately $X / Ymin remaining. Either complete or escalate."* Agent may or may not heed; the message is informational.
- At 100%, the step is terminated and marked `NEEDS_ATTENTION` with reason `COST_CEILING` or `TIME_CEILING`.
- Operator may raise the ceiling and retry, or salvage / abort.

**Acceptance criteria.**
- Ceiling overrides apply only to the specific job/plan the operator raised them on.
- Daily ceiling resets at configurable rollover time (default 00:00 UTC).
- Audit log records every ceiling override with operator + reason.

---

## 7. Non-functional requirements

### 7.1 Reliability
- The daemon survives restart without losing in-flight job state. All session and conversation state is persisted in DDB; in-memory state (active slots, queues) is reconstructed on startup by scanning `RUNNING` and `NEEDS_ATTENTION` jobs.
- A daemon restart in the middle of an interactive conversation degrades gracefully: in-flight turns may fail (retried by user), but conversation state and session bindings are preserved.

### 7.2 Latency
- Salvage action completes in <2 seconds end-to-end.
- Retry action enqueues a new job in <500 ms (visible to user via job-list refresh).
- Talk-to-agent first response: <5 seconds for `fresh` mode (cold spawn); <3 seconds for `resume` if session is HOT.
- Concurrency chip in header updates within 1 second of slot acquire/release.

### 7.3 Cost
- Salvage and skip actions consume zero Claude tokens.
- Retry action consumes the same as the original step.
- Talk conversations metered per-conversation (FR-7), with hard cap.
- Auto-compaction (FR-8) consumes one Sonnet call per session compacted; expected to pay for itself within 2-3 subsequent resumes.

### 7.4 Backwards compatibility
- Existing pipelines continue to function without per-step `preconditions`, `postValidate`, `salvageable`, or `skipTolerant` declarations. Defaults are sensible (no preconditions, no post-validation, salvageable when extractors exist, not skip-tolerant).
- Existing `FAILED` jobs in DDB are not migrated; v1 changes apply going forward.
- Party Mode continues to function; the underlying `party-turn` pipeline is generalized but a thin Party Mode wrapper preserves the existing API.

### 7.5 Observability
- Every state transition (step start/complete/escalate/salvage/retry/skip/abort) emits a structured event to the existing event log.
- Daemon exposes a JSON status endpoint `/health/concurrency` returning `{ slots: { interactive, critical, background }, queued: [], recentRateLimits: [] }`.
- All cost/time ceiling trips emit metrics suitable for future Grafana export (deferred infra; v1 just produces structured logs).

### 7.6 Security
- All new API routes are gated by the existing JWT bearer auth middleware (no new auth surface).
- Talk-to-agent conversations are scoped to `createdBy` user ID; v1 single-tenant assumption means this is mostly cosmetic, but the field is reserved for future multi-user.
- Cost ceiling overrides require the operator's user ID to be recorded in the audit log.

---

## 8. Architecture

### 8.1 Component map (new + modified)

```
┌─────────────────────────────────────────────────────────────────┐
│  Admin UI (Next.js)                                             │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────────┐   │
│  │ Plans / Wave │  │ Failed-step panel │  │ Concurrency chip  │   │
│  │   surfaces   │  │ (Salvage / Retry  │  │ (header)          │   │
│  │              │  │  / Skip / Talk)   │  │                   │   │
│  └─────────────┘  └──────────────────┘  └───────────────────┘   │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐  │
│  │ Attention inbox     │  │ Conversation panel               │  │
│  │ (sidebar badge)     │  │ (chat UI per step)               │  │
│  └─────────────────────┘  └──────────────────────────────────┘  │
└─────────────┬───────────────────────────────────┬───────────────┘
              │ HTTPS                              │ SSE
┌─────────────▼───────────────────────────────────▼───────────────┐
│  API Lambda (Hono) — functions/api/index.ts                     │
│  + /api/jobs/:jobId/steps/:stepId/{salvage,retry,skip}          │
│  + /api/jobs/:jobId/steps/:stepId/conversations                 │
│  + /api/conversations/:cid/{messages,events,apply-output}       │
│  + /api/attention/{list,resolve,reopen}                         │
│  + /api/health/concurrency                                      │
└─────────────┬───────────────────────────────────────────────────┘
              │ DDB
┌─────────────▼───────────────────────────────────────────────────┐
│  DynamoDB                                                       │
│  ~ futurator-agent-jobs (extended fields)                       │
│  ~ futurator-attention-items (extended fields)                  │
│  + futurator-agent-sessions       (FR-8 SessionRegistry)        │
│  + futurator-agent-conversations  (FR-7 talk-to-agent)          │
└─────────────────────────────────────────────────────────────────┘
              ▲ writes by daemon
              │ DDB
┌─────────────┴───────────────────────────────────────────────────┐
│  Daemon (Node.js on EC2) — daemon/agent-daemon.mjs              │
│  + SessionPool  (FR §5 admission control, queues, slot classes) │
│  + LoopDetector (FR-5 sliding-window tool-hash analysis)        │
│  + PreflightRunner (FR-6 validator library)                     │
│  + EscalationParser (FR-4 ---DONE---/---ESCALATE--- extractors) │
│  + CostMeter (FR-10 tracks per-job/plan/daily spend)            │
│  + SessionWarmthTracker (FR-8 + auto-compaction)                │
│  ~ pipelines/*.mjs (party-turn generalized to agent-turn)       │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 SessionPool design notes

- In-process singleton on the daemon. State is in-memory; on restart, reconstructed by scanning `agent-jobs` for `RUNNING` status.
- Exposes:
  - `acquire(class, jobMeta) -> Promise<Token>`
  - `release(token, completionMeta)`
  - `predict() -> { freeSlots: { interactive, critical, background }, queueDepth: number }`
  - `slot_freed` event (emitted on every release)
- Slot configuration loaded from environment at startup; supports hot reload via SIGHUP for ceiling adjustments.

### 8.3 SessionRegistry design notes

- DDB table `futurator-agent-sessions` populated on every agent spawn (from the `system.init` event captured today by `party-turn`).
- Updated on every turn with token delta (parsed from API response metadata in the stream).
- Read by talk-to-agent UI to show warmth + cost estimate, by auto-compaction worker to find candidates, and by audit/debugging tools.

### 8.4 Conversation lifecycle

- A `Conversation` is a thin wrapper around a `Session` plus a UI binding (subscriber list, last user message, last agent reply).
- Conversation messages are stored as events in the existing `futurator-agent-events` table (already used by Party Mode), keyed by `conversationId`.
- Apply-output is a synchronous operation: extracts variables from the conversation's last agent turn, runs the step's apply logic, returns success/failure to the UI.

### 8.5 Pipeline runner extensions

Each pipeline step gains optional declarative fields:

```ts
interface PipelineStep {
  // existing fields...
  preconditions?: PreflightCheck[];
  postValidate?: (vars: Record<string,string>) => true | { error: string };
  salvageable?: boolean;       // default: true if extractors exist
  skipTolerant?: boolean;       // default: false
  concurrencyClass?: 'interactive' | 'critical' | 'background';  // default: 'background'
  timeCeilingMs?: number;       // default: 10 minutes
  costCeilingUsd?: number;      // default: from per-job ceiling
}
```

The pipeline runner reads these and wires them into SessionPool admission + loop detector + escalation parser + post-validator.

### 8.6 Agent prompt template

A shared prompt suffix is appended to every agent's first turn:

```
─────────────────────────────────────────────────────────────────
EXIT SIGNALS — when finishing, emit exactly one:
  ---DONE--- followed by your structured output
  ---ESCALATE--- followed by:
    WHAT_FAILED: <one line>
    WHAT_I_TRIED:
      - <bullet>
      - <bullet, max 5>
    WHY_STUCK: <one paragraph>
    RECOMMENDED_ACTION: retry-with-hint | skip-step | ask-human | abort-job
    HUMAN_QUESTION: <only when ask-human>
  ---NEED-HUMAN---
    HUMAN_QUESTION: <single question>

If you find yourself repeating the same operation, please use ---ESCALATE---.
─────────────────────────────────────────────────────────────────
```

This is injected by the pipeline runner, not duplicated per pipeline.

---

## 9. Data model changes

### 9.1 New DDB tables

**`futurator-agent-sessions`**
- PK: `sessionId` (UUID, our internal id; not the same as `claudeSessionId`)
- GSI `jobId-stepId-index`: PK `jobId`, SK `stepId`
- Fields: `claudeSessionId`, `firstTurnAt`, `lastTurnAt`, `tokenCount`, `costUsd`, `status` (ACTIVE | IDLE | STALE | ARCHIVED), `cwd`, `agentKind`, `compactedFrom?`

**`futurator-agent-conversations`**
- PK: `conversationId`
- GSI `sessionId-index`: PK `sessionId`
- Fields: `sessionId`, `jobId`, `stepId`, `mode` (fresh | resume | compact-resume), `openedBy` (userId), `openedAt`, `lastActivityAt`, `status` (OPEN | APPLIED | CLOSED), `messageCount`, `totalCostUsd`, `appliedToJobAt?`, `costCeilingUsd`

### 9.2 Extended DDB tables

**`futurator-agent-jobs`** — add fields:
- `status` enum gains `NEEDS_ATTENTION` and `COMPLETED_VIA_SALVAGE`
- `attentionItemIds: string[]`
- `salvageableExtractors: string[]` (snapshot of which extractors fired before failure)
- `concurrencyClass: 'interactive' | 'critical' | 'background'`
- `priority: 'now' | 'nightly' | 'weekend'` (default `now`)
- `costSoFarUsd: number`
- `costCeilingUsd: number`
- `timeCeilingMs: number`
- `retryOf?: string` (jobId of the job this is a retry of, if any)
- `escalationPayload?: { whatFailed, whatTried[], whyStuck, recommendedAction, humanQuestion? }`

**`futurator-attention-items`** — verify shape against §FR-9; extend if needed:
- `triggeredBy` enum (per FR-9 list)
- `summary: string`
- `whatAgentTried: string[]`
- `costSoFar: number`
- `estimatedCostToResume: number`
- `recommendedActions: string[]`
- `humanQuestion?: string`
- `rawLogUrl: string`
- `resolvedAt?: string`
- `resolvedBy?: string`
- `resolution?: 'retry' | 'salvage' | 'skip' | 'talk' | 'abort' | 'manual'`

### 9.3 TypeScript types

New file `functions/shared/types/agent-session.ts`:
```ts
export interface AgentSession { ... }       // matches futurator-agent-sessions row
export interface AgentConversation { ... }  // matches futurator-agent-conversations row
export type SessionWarmth = 'HOT' | 'WARM' | 'COLD' | 'STALE';
export type ConcurrencyClass = 'interactive' | 'critical' | 'background';
```

Extended types:
- `AgentJob` — new fields per §9.2
- `AttentionItem` — verified/extended per §9.2
- `PipelineStep` — new optional fields per §8.5

### 9.4 Environment variables

```
MAX_CONCURRENT_TOTAL=2                    # Subscription ceiling; raise as Anthropic policy allows
MAX_CONCURRENT_INTERACTIVE_RESERVED=1     # Always-reserved interactive slots
DEFAULT_PER_JOB_COST_CEILING_USD=5
DEFAULT_PER_PLAN_COST_CEILING_USD=50
DEFAULT_DAILY_COST_CEILING_USD=100
NIGHTLY_BATCH_WINDOW_START=02:00          # Local time
NIGHTLY_BATCH_WINDOW_END=06:00
SESSION_COMPACTION_TOKEN_THRESHOLD=80000
SESSION_STALE_AFTER_MINUTES=30
LOOP_DETECTOR_WINDOW_SIZE=10
LOOP_DETECTOR_HINT_AT=4
LOOP_DETECTOR_FORCE_AT=6
```

---

## 10. UX surfaces

### 10.1 Failed-step panel (extended)

Today: red banner with the error message and a "Retry install" button.
v1: structured panel with:

- **Status badge**: `NEEDS_ATTENTION` (amber, not red — communicates "actionable")
- **Trigger reason**: human-readable label from `triggeredBy`
- **Agent's last words**: if `escalationPayload` present, render `whatFailed` / `whatTried` / `whyStuck` cleanly; if not, show last 200 chars of stdout
- **Action buttons**: Salvage (primary if extractors exist), Retry, Skip (disabled with tooltip when not skip-tolerant), Talk, Abort (destructive, requires confirm)
- **Cost & time chips**: cost so far, estimated cost to resume (talk mode), time elapsed
- **"Show full log" expander** for the curious

### 10.2 Conversation panel

Triggered by clicking "Talk" on a step. Slides in from the right, occupies ~40% of viewport.

- **Header**: agent kind (QA, Dev, etc.), step name, plan name, session warmth chip ("warm — $0.04 to resume")
- **Mode toggle**: fresh (default) / resume / compact-resume, with cost preview for each
- **Chat scroll**: agent turns rendered with markdown, tool calls collapsible
- **Composer**: textarea with Send button, char/cost preview as user types
- **Footer actions**: "Apply this output" (active when last agent turn matches step's extractors), "Close conversation"

### 10.3 Attention inbox

New left-sidebar item: **Inbox [N]** badge showing unresolved item count.

- List view sorted by `createdAt` desc
- Each item: plan name, step name, trigger reason chip, summary (1-2 lines), recommended-action buttons inline
- Filter chips at top: by plan, by trigger reason, by status (open / resolved)
- Click expands to full panel (same component as the failed-step panel) with full history

### 10.4 Concurrency chip (header)

Tiny widget in the top-right of the admin layout:

```
[● ● ○]  2/2 in use  ●1 queued
```

- Filled circles = used slots, hollow = free
- Hover: tooltip listing each active session with plan + step name
- Click: opens a small popover with the full queue, "promote to critical" buttons per job, and a link to the concurrency-history view

### 10.5 Plan dashboard additions

- **Cost meter** (per plan): live $ spent vs ceiling, click to raise
- **Slot usage timeline** (small sparkline): how busy was this plan over the last hour

---

## 11. Phased rollout (epics)

Each phase is a deployable, demo-able increment.

### Epic 1 — Failure recovery surface (3-5 days)
**Goal:** turn the dino3 incident into a one-click recovery.
- Add `NEEDS_ATTENTION` job status (FR-1)
- Salvage / Retry / Skip / Abort actions (FR-2, FR-3)
- Universal escalation extractors injected into agent prompts (FR-4)
- Loop detector (FR-5)
- Pre-flight validator framework, with `folder-exists` validator (FR-6 — initial)
- Failed-step panel UI (§10.1)
- Attention inbox v0 — list + actions, no notifications yet (FR-9 partial)

**Demo scenario:** induce a failure on a test plan; confirm `NEEDS_ATTENTION`; click Salvage; wave advances.

### Epic 2 — Concurrency manager (5-7 days)
**Goal:** eliminate self-inflicted 429s.
- `SessionPool` with typed slots, admission protocol, queues (§5.2-5.3)
- Event-driven 429 retry (§5.4)
- Concurrency chip in header (§10.4)
- `/api/health/concurrency` endpoint (NFR §7.5)
- Pre-emption between steps (§5.3)

**Demo scenario:** start a Dev wave on plan A, open a Party Mode chat on plan B; chat acquires immediately, Dev step resumes after; no 429.

### Epic 3 — Talk-to-agent v1 (7-10 days)
**Goal:** conversational debugging on any session.
- Generalize `party-turn` → `agent-turn` (§8.4)
- `SessionRegistry` table (FR-8 partial — tracking only, no compaction yet)
- `Conversations` table (FR-7)
- New API routes per §8.1
- Conversation panel UI (§10.2)
- Apply-output bridge (FR-7)
- Default to `fresh` mode

**Demo scenario:** open a Talk conversation on the dino3 QA step; ask "why did you decide PASS"; receive a coherent answer; click Apply; wave advances.

### Epic 4 — Cost & time discipline (3-5 days)
**Goal:** budget guardrails active across all jobs.
- Cost meter integrated into existing job execution (FR-10)
- Per-step time ceilings
- Per-job, per-plan, daily cost ceilings
- Cost meter UI on plan dashboard (§10.5)
- Soft warnings injected as agent system messages at 80% (FR-10)

**Demo scenario:** set a tight cost ceiling on a plan; watch the system inject a warning, then trigger `NEEDS_ATTENTION` at 100%; raise the ceiling; resume.

### Epic 5 — Cache & context optimization (3-5 days)
**Goal:** cheaper resumes, longer-lived sessions remain viable.
- Session warmth surface in UI (FR-8)
- Auto-compaction worker (FR-8)
- Resume-mode cost previews in talk-to-agent panel
- Audit + dedupe agent prompt prefixes for cross-session caching (eliminate cache-busting timestamps / random IDs)

**Demo scenario:** open a Talk conversation on a 100k-token session; UI shows compaction happening; resume cost drops measurably.

### Epic 6 — Quality of service (3 days)
**Goal:** operator control over scheduling.
- `priority: 'now' | 'nightly' | 'weekend'` field on jobs (§5.5)
- Time-shifted batching scheduler
- "Promote to critical" override on background jobs
- Optional email digest for attention items (configurable per user)

**Demo scenario:** queue a non-urgent retro tagged `nightly`; watch it sit in queue; advance system clock to 02:00; job runs.

**Total estimated effort:** ~5-6 weeks of focused work. Epics are independently shippable — Epic 1 alone resolves the dino3 class of incidents and pays for the rest.

---

## 12. Open questions

1. **Subscription tier ceiling.** What is the actual concurrent-session ceiling on the current Claude Code subscription, and does it move with plan tier? Confirms `MAX_CONCURRENT_TOTAL` default. Action: Anthropic docs / support ticket.
2. **Attention inbox shape today.** Existing `attention dock` work (per recent commits) — does the schema match §FR-9, or extend? Action: read `docs/concepts/pipeline-enhancement-phases-a-c-handoff.md` and audit before Epic 1 detailed design.
3. **Conversation cost cap default.** $1 per conversation reasonable, or should it be higher for long debugging sessions? Action: collect data from first month of use, tune.
4. **Compaction timing.** Auto-compact at 80k tokens — too eager (loses context) or too lax (sessions stay expensive)? Action: instrument first; tune based on observed compaction-vs-resume cost.
5. **Pre-emption boundary granularity.** Steps average 30-180s, so worst-case interactive wait is bounded — but Dev steps with long file edits may exceed 5 min. Should we add explicit checkpoints for long-running steps to allow finer-grained pre-emption? Action: defer to v1.x once we have data on actual step durations.
6. **Multi-account OAuth (capacity expansion).** Out of scope for v1, but we should agree on the trigger condition: "when do we revisit?" Suggested: when `SessionPool` queueing waits exceed 60s on >10% of interactive requests.

---

## 13. Out of scope (deferred)

- **Raw API-key fallback for background jobs.** Would expand capacity by routing pipeline jobs through `@anthropic-ai/sdk` instead of Claude Code CLI, doubling slots without new subscriptions. Deferred until v1 admission control + self-correction proves insufficient.
- **Multi-account OAuth pooling.** Pool of N Claude Code accounts; jobs round-robin. Linear capacity scaling. Deferred for the same reason.
- **Multi-tenant conversation locking.** v1 assumes one operator; concurrent conversations on the same session by different users may interleave. Multi-user attribution + locking is v2.
- **Mid-step pre-emption.** Pre-empting a step that's mid-Bash-call requires Claude SDK support that doesn't exist today. v1 only pre-empts at step boundaries.
- **External observability stack.** v1 emits structured logs; Grafana / Datadog export is a separate workstream.
- **Push notifications / mobile inbox.** v1 surfaces attention items in the admin UI only.
- **Webhook integrations (Slack / Discord).** v1.x feature, not v1.
- **Session forking for parallel debug branches.** v1 supports one open conversation per step. Multi-branch debugging is v2.
- **Cross-plan slot reservation.** v1 treats all plans as peers within their concurrency class. "Plan X always gets the next interactive slot" is not a concept.

---

## 14. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Subscription concurrent ceiling is lower than 2 (e.g., 1 on certain plans) | Low | High — most of v1 assumes 2+ | Validate with Anthropic before Epic 2; SessionPool degrades gracefully with `MAX_CONCURRENT_TOTAL=1` (queue everything, including interactive) |
| Auto-compaction loses critical context, agent makes wrong decisions on resume | Medium | Medium | Compaction marker preserved in transcript; UI shows "this session was compacted at turn N"; operator can choose `resume` mode (uncompacted original) at higher cost |
| Loop detector false-positives, escalates legitimate iteration | Medium | Low — operator sees "it's fine" and clicks Retry | Tune `LOOP_DETECTOR_FORCE_AT` upward in early use; track false-positive rate |
| Cost meter under-counts (race between agent emit + meter update) | Medium | Low — cost is approximate, ceiling is conservative | Reconcile actual spend against meter weekly; alert on >10% drift |
| Pre-emption causes background jobs to thrash (acquire-pause-release-requeue cycle) | Medium | Medium | Add minimum hold time between pre-emption events (e.g., a job promoted out cannot be re-promoted for 60s); track preemption-thrash metric |
| Talk-to-agent conversations balloon in cost (operator types extensively) | Medium | Low — cost cap protects | Default $1 cap is intentionally conservative; raise per-conversation when needed; show running cost in composer |
| Quota exhaustion from a single runaway plan (cost ceiling not honored) | Low | High | Daemon enforces ceilings, not the agent; agent's "soft warning" message is informational only |
| Attention inbox accumulates uncleared items, becomes noise | Medium | Medium | Auto-archive resolved items >30 days; surface "stale items needing attention" weekly |

---

## 15. Appendix — dino3 incident, mapped to v1 requirements

The exact failure walked through every gap v1 addresses. This appendix documents the mapping for traceability.

| Step in incident | What broke | v1 requirement that addresses it |
|---|---|---|
| QA agent emits perfect `---QA_REPORT---` | (worked) | — |
| Daemon makes follow-up call | 429 from Anthropic, concurrent with bmad party chat | FR §5 — SessionPool admission control queues this instead of attempting concurrent spawn |
| Retry 1, 2, 3 all 429 | Blind 30s/2m/8m backoff into the same overload window | FR §5.4 — event-driven retry on slot-free |
| Step marked `FAILED` | No salvage path despite extracted variables | FR-1 — `NEEDS_ATTENTION`; FR-2 — Salvage button |
| Operator stares at error | No UI to apply the report or talk to the agent | FR-9 — Attention inbox; FR-2 — Salvage; FR-7 — Talk-to-agent |
| Operator considers re-running entire plan | Hours of Claude time wasted | All of the above |

Under v1, the incident plays out as:

1. Daemon attempts QA closeout call. SessionPool predicts contention with active bmad party chat → defers spawn, queues call.
2. bmad party chat completes (any turn boundary), slot frees, queued call fires immediately. No 429.
3. Step completes normally, wave advances.

If for some reason the call still 429'd:

1. Step marked `NEEDS_ATTENTION` (not `FAILED`), variables preserved.
2. Attention inbox surfaces the item with `triggeredBy: AGENT_ESCALATED` (or `RETRY_EXHAUSTED`) and `recommendedActions: ['salvage']`.
3. Operator clicks Salvage in the inbox; wave advances in <2 seconds.
4. Total operator time: 5 seconds.

This PRD exists so dino3 is the last time this happens.
