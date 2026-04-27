# Pipeline v1 — Deferrals & Follow-ups

| Field            | Value                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Active backlog                                                                                                                                                      |
| **Source PRD**   | `docs/concepts/prd-pipelinev1-self-corrections-escalation.md`                                                                                                       |
| **Source plan**  | `docs/concepts/epics-and-stories-pipelinev1.md`                                                                                                                     |
| **Sibling plan** | `docs/concepts/epics-and-stories-pipelinev1-dev-correction.md` (Epic A–E libraries shipped 2026-04-27; wiring deferred — see §"Dev-correction 2nd iteration" below) |
| **Built v1**     | 2026-04-26 (41 stories) + 2026-04-27 (9 follow-ups)                                                                                                                 |
| **This doc**     | Captures every intentionally-deferred AC + every gotcha discovered during the v1 build                                                                              |

## How to use this doc

Each item is sized as P0 / P1 / P2 and carries enough context to pick up cold:

- **AC reference** — story id from the source plan
- **Current state** — what shipped, what stubs out
- **Why deferred** — the v1 trade-off that left this for later
- **Suggested approach** — concrete next steps
- **Gotchas** — things I hit during the v1 build that aren't obvious from the code

P0 = small + high-leverage. P1 = real scope, infra-dependent, or behavior-changing. P2 = cleanups and nice-to-haves.

---

## P0 — Small, high-leverage wins

### P0.1 — Flip `EXIT_SIGNALS_PROMPT_SUFFIX` from suffix to prefix

- **AC ref.** Story 5.5 (audit doc, "high ROI" recommendation).
- **Current state.** `daemon/agent-daemon.mjs` `executeStep` does
  `prompt = body + '\n\n' + EXIT_SIGNALS_PROMPT_SUFFIX`. The suffix is
  ~600 chars and identical across every spawn — perfect cache material —
  but it lives at the _end_ of the prompt, after every per-call variable
  has already varied the byte stream, so it never benefits prompt-cache.
- **Why deferred.** Wanted to verify the protocol works end-to-end before
  optimizing layout.
- **Suggested approach.** Change the assembly to
  `prompt = EXIT_SIGNALS_PROMPT_SUFFIX + '\n\n' + body`. Confirm no agent
  prompt assumes positional content at line 1. Run any one
  same-kind-twice scenario and check `usage.cache_read_input_tokens` rises.
- **Gotchas.** The `--resume` path doesn't re-append the suffix (already
  correctly gated). Don't change that — resumes already saw the suffix
  on their first turn.

### P0.2 — Story 1.5 Salvage: run the step's apply logic, not just enum flip

- **AC ref.** Story 1.5 AC#3: _"Runs the step's apply logic (the same code
  path a successful step would take — usually epic patch + wave
  advancement) using `job.variables`."_
- **Current state.** `/api/jobs/:jobId/steps/:stepId/salvage` flips the
  job to `COMPLETED_VIA_SALVAGE` and clears attention items. The wave
  reducer (Story 1.1) treats this as success on the next tick, so wave
  advancement does happen — but **step-specific apply logic does not run**.
  Concretely: a QA step's `VISUAL_TESTS` extractor variable would normally
  trigger `mergeVisualTestsBlock` (`daemon/agent-daemon.mjs` line ~1147);
  Salvage today bypasses that.
- **Why deferred.** Refactoring the success-path apply logic into a shared
  `applyStepOutput(jobId, stepId, variables)` helper is broader than v1
  scope; the wave-advancement contract holds without it.
- **Suggested approach.** Extract the success-path post-extraction code
  (lines ~1147–1201 in `agent-daemon.mjs`) into
  `daemon/lib/apply-step-output.mjs`. Have both the daemon's normal path
  and the API's salvage endpoint call it. Make it idempotent — the apply
  may run twice (success path + retry-after-salvage).
- **Gotchas.** The current daemon-side apply does file IO (writing
  `visual-tests.md`) — when the API runs it, that IO has to happen on
  the EC2 box, not in Lambda. Easiest path: enqueue a tiny daemon-side
  `salvage-apply` job rather than running the apply in the Lambda.

### P0.3 — Story 3.6 apply-output: actually run extractors

- **AC ref.** Story 3.6 AC#3: _"Runs the step's extractors against the
  agent turn's text. If required extractors all fire: invokes
  `applyStepOutput`. If extractors fail: returns 422 with
  `{ extractorsThatFired, extractorsThatFailed }`."_
- **Current state.** The endpoint trusts the operator's click and flips
  to `COMPLETED_VIA_TALK` unconditionally. No extractor matching, no
  422 response.
- **Why deferred.** Required Salvage's `applyStepOutput` helper (P0.2)
  to share the apply path; v1 shipped the contract without the matching.
- **Suggested approach.** After P0.2 lands, this is small: load the most
  recent `agent-turn.agent_text` event for the conversation, run
  `runExtractors` (or the Lambda-side equivalent) against it, only flip
  status if every required extractor matched. Add a query-param
  `?dry-run=true` for the panel's "would-succeed" preview.
- **Gotchas.** The conversation's event stream is currently empty
  (`/api/conversations/:id/events` returns `events: []` — see P1.6); you
  may need to source the agent's response text directly from the
  agent-turn job's `stepResults` instead. Pipe through whichever lands
  first.

### P0.4 — Inbox row inline action buttons

- **AC ref.** Story 1.10 AC#4: _"Each row: plan name, step name, trigger
  reason chip, summary, recommended-action buttons inline."_
- **Current state.** `src/app/inbox/page.tsx` shows "Open plan" and
  "Mark resolved" only. The PRD/plan called for inline Salvage / Retry /
  Skip / Talk shortcuts that call the same hooks the failed-step panel
  uses.
- **Why deferred.** Cross-row state management for retry-hint / abort-
  reason inputs is fiddly; v1 shipped the inbox surface and links so the
  operator could navigate to the panel for the action.
- **Suggested approach.** Reuse `useSalvageStep` / `useRetryStep` /
  `useSkipStep` / `useAbortStep` directly in the inbox row. For retry's
  hint and abort's reason, render a tiny inline expander on click instead
  of a separate route. Disable buttons based on the same canSalvage /
  canSkip / canAbort gating as `failed-step-panel.tsx`.
- **Gotchas.** The inbox row only has the AttentionItem, not the full
  job. Either fan out a `useQuery` per row to fetch the underlying
  `AgentJob` (cheap with TanStack Query batching), or extend
  `/api/attention` to embed `job.salvageableExtractors.length` and
  `step.skipTolerant` so the row knows which buttons to enable.

### P0.5 — Token tracking in legacy `executePipeline` path

- **AC ref.** Story 5.1 AC#2: _"After each turn, atomically updates
  `agent-sessions`: tokenCount += input + output, costUsd += turnCostUsd,
  lastTurnAt = now()..."_
- **Current state.** `daemon/pipelines/agent-turn.mjs` correctly accrues
  tokenCount + costUsd to its session row. **`executePipeline`'s normal
  per-step path does NOT** — it never touches `agent-sessions`. So the
  warmth chip + cost-to-resume estimate (Story 5.2) only work for jobs
  that came through the agent-turn path; pipeline-step jobs show as
  COLD/0 forever.
- **Why deferred.** `executePipeline` predates the `agent-sessions`
  table; adding session-row maintenance there required a deeper
  understanding of which jobs get sessions vs which are one-shots.
- **Suggested approach.** When `executeStep` captures
  `result.session_id`, call `agentSessionsRepo.findByJobAndStep(jobId,
step.id)` — if no row exists, create one; either way `addUsage(...)`
  with the result's input/output/cache tokens. Use a fire-and-forget
  pattern so DDB write latency doesn't slow the step loop.
- **Gotchas.** Skip orchestrator + party-bootstrap jobs (their sessions
  are tracked separately or not at all). `executePipeline`'s per-step
  loop runs sequentially, so race conditions aren't a concern, but
  cross-step session-row sharing might be — a single agent's resume
  chain accumulates token count across step boundaries.

### P0.6 — Compactor never starts

- **AC ref.** Story 5.3 AC#1: _"New cron-style task in the daemon, runs
  every 5 minutes."_
- **Current state.** `daemon/lib/compactor.mjs` exists with `start()` /
  `stop()` / `tick()` methods. The daemon main loop never instantiates
  or calls `start()`. So compaction never runs.
- **Why deferred.** Wired the API + class but didn't pull the trigger on
  the live cron during v1 since the on-disk transcript rewrite (P1.3)
  isn't implemented yet — the placeholder rows the compactor creates
  would be misleading without it.
- **Suggested approach.** After P1.3 lands (or as a paired change), add
  to `daemon/agent-daemon.mjs` startup:
  ```js
  const compactor = new Compactor(ddb, { log });
  compactor.start();
  ```
  Add a SIGTERM hook to call `compactor.stop()` for graceful shutdown.
- **Gotchas.** Don't start before P1.3 — without the transcript rewrite,
  the new "compacted" session rows have the same `claudeSessionId` as
  their predecessor, so resuming against them costs identically. You'd
  log compactions that don't actually save anything.

---

## P1 — Medium scope, infra-dependent, or behavior-changing

### P1.1 — Story 3.3 full party-turn → agent-turn refactor

- **AC ref.** Story 3.3 AC#3: _"`party-turn.mjs` is rewritten as a thin
  wrapper that prepends `/bmad-party-mode` to the first turn's content
  and calls `agent-turn.mjs`."_
- **Current state.** `daemon/pipelines/agent-turn.mjs` exists and works
  for Talk-to-agent. `daemon/pipelines/party-turn.mjs` is unchanged —
  separate codepath, separate session locking, separate event handling.
- **Why deferred.** Party Mode is in active production use; refactoring
  it under the new contract requires regression testing against the
  existing Party UI (`src/components/labs/party/`) which isn't gated by
  unit tests alone.
- **Suggested approach.** Step 1: agent-turn gains a
  `prependCommandPrefix` option (e.g. `/bmad-party-mode`). Step 2:
  agent-turn's session lock acquisition is parameterized so party-turn
  can swap in `tryAcquireConversationLock` for the existing
  `tryAcquirePartyLock`. Step 3: party-turn's body is replaced with a
  call to agent-turn. Run the existing Party Mode integration tests —
  expect them to pass unchanged.
- **Gotchas.** Party Mode's session-lock semantics differ subtly from
  agent-turn's — Party prevents concurrent turns on the same _project_
  (multiple sessions can exist), agent-turn prevents concurrent
  conversations on the same _session_. Don't merge these; parameterize.

### P1.2 — Story 3.5 Lambda response-streaming SSE

- **AC ref.** Story 3.5 AC#2: _"GET `/api/conversations/:conversationId/events`
  (SSE stream)."_
- **Current state.** Endpoint returns `{ events: [], lastSeq }` and the
  conversation panel polls every 2 seconds. Functional but laggy and
  inefficient at scale.
- **Why deferred.** Lambda response-streaming via SST requires an
  `awslambda.streamifyResponse` wrapper that doesn't compose cleanly
  with Hono's current handler (handler returns a Response; streaming
  needs a streaming-response object). Polling worked; flipping was
  out-of-scope for v1.
- **Suggested approach.** Either:
  (a) Add a separate Lambda Function URL handler (bypasses Hono) that
  uses `awslambda.streamifyResponse`. Mount it at the same path so the
  client doesn't change. Confirm the SST `Function` resource type
  supports `invokeMode: 'RESPONSE_STREAM'`.
  (b) Defer until Hono v5 (whenever it lands with streamable-handler
  support).
- **Gotchas.** Browser EventSource clients reconnect on close — make
  sure the Lambda's 30s timeout kills idle connections cleanly without
  client-visible stutter. Heartbeat every 15s per the AC.

### P1.3 — Story 5.3 on-disk transcript rewrite

- **AC ref.** Story 5.3 AC#3-4: _"For each candidate: spawns a one-shot
  Sonnet call with a compaction prompt that summarizes turns 1..N-2 of
  the saved transcript into a single block. Replaces the saved
  transcript on disk with the compacted version."_
- **Current state.** `Compactor.compactSession()` creates a new session
  row with `compactedFrom` pointing back, and marks the predecessor
  ARCHIVED. **The actual on-disk transcript file is not touched.** So a
  resume against the compacted row costs identically to a resume against
  the original.
- **Why deferred.** The Claude CLI's transcript-on-disk format is opaque
  — locating the file and the safe rewrite path requires reverse-
  engineering. Out of scope for the v1 contract.
- **Suggested approach.** Investigate `~/.claude/sessions/<id>/`
  structure (or wherever the CLI stores resume state). Build a small
  read/write helper. The compaction prompt template per the AC: ~500
  tokens, instructs Sonnet to produce a structured summary preserving
  file paths, decisions, key tool outputs, and current goal. Validate
  the rewrite by spawning a `--resume` against the compacted file and
  confirming the agent retains key context.
- **Gotchas.** Original session must be preserved for audit (per AC#7).
  Don't overwrite — copy + rewrite + atomic-rename. Compaction itself
  costs ~1 turn's worth of input tokens; track this in agent-events so
  break-even (over 2-3 subsequent resumes) is measurable.

### P1.4 — Story 6.4 SES wiring

- **AC ref.** Story 6.4 AC#5: _"Uses AWS SES with a verified sender
  address."_
- **Current state.** `functions/cron/attention-digest.ts` aggregates
  unresolved items per user and **logs the would-be email** instead of
  sending. The cron is registered at `rate(1 hour)`.
- **Why deferred.** SES sandbox mode requires a verified sender + every
  recipient verified separately; this is operational config, not code.
- **Suggested approach.**
  1. Verify sender address (e.g. `notifications@futurator.ai`) in SES
     console. Verify the single user's recipient too.
  2. Add SES IAM permission to the AttentionDigest cron function in
     `sst.config.ts`:
     ```ts
     permissions: [{ actions: ['ses:SendEmail'], resources: ['*'] }],
     environment: { SES_FROM_ADDRESS: 'notifications@futurator.ai' }
     ```
  3. Replace the log call in `attention-digest.ts` with
     `SESClient.send(new SendEmailCommand({...}))`.
  4. Move out of SES sandbox once recipient list is dynamic.
- **Gotchas.** The cron currently runs every hour but doesn't dedupe
  if the same item was already emailed in a previous run. Add a
  `lastNotifiedAt` field on AttentionItem and filter on cutoff to avoid
  re-emailing the same items hour after hour.

### P1.5 — Story 2.3 event-driven 429 retry

- **AC ref.** Story 2.3 AC#1: _"On 429, parse the response body. Reasons:
  `concurrent_requests` → register a one-shot waiter on
  `SessionPool.slot_freed`. Add 0-2s jitter before retry."_
- **Current state.** Existing `daemon/lib/retry.mjs` uses fixed-delay
  exponential backoff (30s / 2m / 8m). Works, but retries against an
  unmoved wall — if the daemon's own concurrent jobs caused the 429,
  the retry will hit again until one of them naturally finishes.
- **Why deferred.** Parsing 429 body shapes (`type` field varies per
  Anthropic API version) wasn't worth the bake time given Story 2.1
  SessionPool already prevents most self-inflicted 429s upstream.
- **Suggested approach.** Replace `retry.mjs`'s timer-based wait with:
  ```js
  const waiter = new Promise((resolve) => sessionPool.once('slot_freed', resolve));
  await Promise.race([waiter, sleep(maxWaitMs)]);
  ```
  Then retry. Distinguish reasons:
  - `concurrent_requests` → wait on slot_freed, jitter
  - `daily_limit` / `monthly_limit` → no retry, mark NEEDS_ATTENTION
    with `triggeredBy: QUOTA_EXHAUSTED`
  - Unknown → fall back to existing exponential backoff, capped at 2 retries
- **Gotchas.** Anthropic occasionally returns 429 with no parseable
  reason. Default to the unknown-fallback path; don't crash on missing
  `type`. The 5-minute total wall-clock cap (AC#2) must hold even
  across multiple retries.

### P1.6 — Story 2.4 step-boundary preemption

- **AC ref.** Story 2.4 AC#2: _"Pipeline runner checks `pauseAfterCurrentStep`
  flag between steps. If set: releases the token, re-enqueues the job
  in PENDING state with `priority: 'now'`, clears the flag."_
- **Current state.** `pauseAfterCurrentStep` field exists on `AgentJob`.
  Nothing reads it. SessionPool's interactive-acquire path doesn't set
  it on the blocking background token either.
- **Why deferred.** The pre-emption logic touches both ends of the slot
  acquisition flow + the pipeline runner's step-loop. v1 traded this for
  the simpler "interactive class has reserved slot" baseline.
- **Suggested approach.** Two paired changes:
  1. **In `SessionPool.acquire('interactive', ...)`**: when queueing
     because all slots are taken AND the only blocking token is
     `background`, set `pauseAfterCurrentStep: true` on that job's row.
     Emit `pauseAfterCurrentStep` event for observability.
  2. **In `executePipeline`'s step loop**: at the top of each iteration,
     re-fetch `pauseAfterCurrentStep` from DDB. If true: release the
     SessionPool token, re-enqueue this job as PENDING with
     `priority: 'now'` and clear the flag. The interactive request
     immediately acquires the freed slot.
- **Gotchas.** Anti-thrash window per AC#4: a job that was just
  promoted out cannot be re-promoted for 60 s. Track `lastPromotedAt`
  on the job row. Cron's `wave-completion-check` should treat a paused
  job as "running" for wave-state purposes (current wave-reducer
  classifies it as non-terminal which is correct, but worth a regression
  test).

### P1.7 — Conversation events: write + filter + replay

- **AC ref.** Story 3.5 AC#3: _"Daemon's `agent-turn` pipeline writes
  structured events: conversation.user_message, conversation.agent_text,
  conversation.tool_use, conversation.turn_complete (with cost delta)."_
  Story 3.5 AC#2 (`since` query param replay).
- **Current state.** `agent-turn.mjs` calls `ctx.pushEvent` with a
  generic `'status'` type carrying the raw line. The endpoint returns
  `events: []`. So the panel never displays agent responses.
- **Why deferred.** Built the conversation panel UI optimistically,
  expecting events to populate. They don't yet.
- **Suggested approach.** In `agent-turn.mjs`'s stream handler, push
  typed events with the conversation context:
  ```js
  pushEvent(jobId, conversationId, 'agent-turn', 'conversation.agent_text', {
    text: delta,
    conversationId,
  });
  ```
  In `/api/conversations/:id/events`, query agent-events by
  `conversationId` (add a GSI or filter). Honor `?since=<seq>` by
  filtering `seq > since`.
- **Gotchas.** `agent-events` table is keyed by `(jobId, eventSeq)` —
  there's no `conversationId-index` GSI. Either add one (DDB schema
  change in `sst.config.ts`) or stash conversationId on `jobId` (already
  the case for agent-turn jobs since they're spawned per-conversation;
  could query by `jobId-startsWith`-conversation-prefix). The GSI is
  cleaner.

### P1.8 — Conversation panel cost meter + warmth-based mode preview

- **AC ref.** Story 3.7 AC#9: _"Shows running cost meter at top-right;
  turns red at 80% of cap, blocked at 100%."_ And AC#4: mode preview
  _"shows estimated cost per mode."_
- **Current state.** `conversation-panel.tsx` has a static mode-selector
  with hardcoded cost strings (`$0.01 (cold start)` / `$0.04 (warm)`).
  No live cost meter at the top-right.
- **Why deferred.** `getSessionWarmth` + `estimateResumeCostUsd` exist
  in `daemon/lib/session-warmth.mjs` but aren't exposed via API; the
  panel had no way to fetch warmth at create-time without an extra
  endpoint.
- **Suggested approach.**
  1. Add `GET /api/sessions/:sessionId/warmth` returning
     `{ warmth, costToResumeUsd }`.
  2. In the panel, when `mode === 'resume'` is selected, fetch warmth
     and replace the static text with the live estimate.
  3. Add a top-right meter showing `conversation.totalCostUsd /
conversation.costCeilingUsd`. Reuse the `<PlanCostMeter />` color
     thresholds (amber 80%, red 100%).
- **Gotchas.** The warmth call needs a session id, which only exists
  _after_ the conversation is created. For the pre-creation preview,
  use the _job's_ most-recent session via `findByJobAndStep`. For
  fresh-mode the cost is genuinely hard to predict — leave it at the
  static `$0.01` placeholder.

### P1.9 — Per-plan + per-day cost ceiling enforcement

- **AC ref.** Story 4.3 AC#2: _"At 80% of any: inject warning. At 100%
  of any: terminate."_
- **Current state.** FU-1 wired per-job ceiling enforcement in
  `runAgent`. **Per-plan and daily ceilings are accumulated but never
  acted on.** The `costMeter.aggregateBy()` helper exists but no daemon
  code calls it on the warn/terminate path.
- **Why deferred.** Per-plan enforcement requires looking up the plan id
  from the active job (epicId → planId resolution costs an extra DDB
  read per turn). v1 traded this for the simpler per-job-only cap.
- **Suggested approach.** In the `runAgent` cost-recording branch,
  after `recordTurn`:
  ```js
  const planCost = await costMeter.getPlanCost(planId);
  const planCeiling = plan.costCeilingUsd ?? DEFAULT_PER_PLAN_COST_CEILING_USD;
  const dailyCost = await costMeter.getDailyCost();
  // Pick the tightest binding ceiling.
  ```
  Throttle the per-plan + daily checks (every N turns or every minute)
  to keep the per-turn DDB cost manageable.
- **Gotchas.** Per-plan rollups run via `Scan` in `aggregateBy` — fine
  for v1 plan counts but quadratic in plan growth. When N plans > 50,
  switch to a denormalized `plan.costSoFarUsd` field updated on every
  turn (already present on the Plan type).

### P1.10 — Story 6.5 timezone-aware batch scheduler

- **AC ref.** Story 6.2 tech notes: _"'Local time' — pick a default
  timezone (e.g., user's TZ from a profile field, fallback UTC)."_
- **Current state.** `daemon/lib/batch-scheduler.mjs`'s `isInNightlyWindow`
  / `isInWeekendWindow` use `date.getUTCHours()` / `getUTCDay()`. Always
  UTC. The user's `timezone` field is persisted (Story 6.5 settings page)
  but never read.
- **Why deferred.** Timezone arithmetic in vanilla JS (without Intl
  or a tz library) is annoying. v1 shipped UTC default; the user-tz
  toggle was contract-level.
- **Suggested approach.** Use `Intl.DateTimeFormat` with the user's
  timezone:
  ```js
  function partsForTz(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hour12: false,
    });
    // parse fmt.formatToParts(date) into { hour, minute, weekday }
  }
  ```
  Daemon's poll loop reads `user.timezone` once at job-pickup time,
  passes it to `shouldPickUp(job, now, timezone)`.
- **Gotchas.** v1 is single-user. When scheduler goes multi-user, each
  job's effective timezone is the _creating user's_ tz, not the daemon's
  host tz — record `priorityTimezone` on the job row at creation so
  later changes to user.timezone don't retroactively shift windows.

---

## P2 — Cleanups & nice-to-haves

### P2.1 — Restructure dev/reviewer subagent templates for cache-friendliness

- **AC ref.** Story 5.5 audit, "medium ROI deferred" item.
- **Current state.** `dev-subagent-prompt.md.tpl` / `reviewer-
subagent-prompt.md.tpl` interpolate `{{storyId}}` at line 1. Every
  spawn produces a unique byte stream from the first byte; cache hit
  rate is ~0.
- **Suggested approach.** Reorder so the cache-stable rubric excerpt +
  tool reminders + project policy lead, and the per-story header
  (`Story: {{storyId}} — {{title}}`) lands at the bottom. Coordinate
  with the orchestrator's prompt-reading code (subagent prompts are
  consumed by the orchestrator's subagent-spawn; if the orchestrator
  parses by line position, that has to flip too).
- **Gotchas.** `daemon/pipelines/lib/inject-custom-agents.mjs` and the
  orchestrator's `Task`/`Agent` invocations may assume positional
  content. Audit with `grep -rn 'getline\|line === 0\|substring(0,'`
  before changing.

### P2.2 — Dedupe per-pipeline prompt boilerplate

- **AC ref.** Story 5.5 audit, "low ROI" item.
- **Current state.** `dev-subagent` and `reviewer-subagent` templates
  share several blocks (DISCOVERY guardrails, VERIFICATION rules, the
  `<run_command>` envelope). Cumulatively ~500 chars duplicated.
- **Suggested approach.** Extract shared blocks to
  `daemon/pipelines/templates/_shared.md.tpl` and concatenate at
  assembly time. Or use a simple `{{> sharedBlock}}` directive parsed
  by `template-substitution.mjs`.
- **Gotchas.** Don't introduce a heavy template engine for this — a
  3-line substitution helper beats Handlebars / Mustache.

### P2.3 — Story 1.6 retry chain copies more than `initialVariables`

- **AC ref.** Story 1.6 AC#3: _"Creates a new AgentJob with the same
  pipeline + step config and fresh `jobId`."_
- **Current state.** API endpoint copies the original job's
  `pipeline.initialVariables` and stamps `OPERATOR_HINT` into the new
  variables map. **Sibling-step session ids and prior-step results are
  not copied.** A retry that should `--resume` a sibling session can't
  see it.
- **Suggested approach.** Add `sessions: { ...originalJob.sessions }` to
  the createJob payload. Optionally copy `stepResults` for prior steps
  so a partial-progress retry can pick up mid-pipeline rather than
  restart from step 0.
- **Gotchas.** Sessions copied across jobs work for _resume_ but not
  for cost rollups — those are per-job. Decide whether retry-job
  costs accumulate against the chain (sum across `retryOf`) or fresh.
  v1 currently treats them as fresh (per-job ceiling per-job).

### P2.4 — Populate `agentSession.agentKind`

- **AC ref.** Story 3.1 AC#2: _"Fields: ..., `agentKind`, ..."_
- **Current state.** Type is defined; no code writes it. apply-output
  (P0.3) needs it for extractor lookup.
- **Suggested approach.** In `agent-turn.mjs`'s session-create path
  AND in the legacy `executePipeline` token-tracking path (P0.5), set
  `agentKind` from the pipeline step's `agentId` field.
- **Gotchas.** The `agentId` is just a string ("dev", "reviewer", "qa")
  — that's the right granularity for warmth + extractor lookup. Don't
  over-engineer.

### P2.5 — `OPERATOR_HINT` template-var usage docs

- **AC ref.** Story 1.6 tech notes: _"'Prepend hint to first turn' —
  define how the prompt template handles the hint. Suggested: a new
  template variable `${OPERATOR_HINT}` that's empty by default."_
- **Current state.** The retry endpoint sets `initialVariables.OPERATOR_HINT`.
  Any pipeline that wants the hint prepended must reference `{{OPERATOR_HINT}}`
  in its prompt. **No pipeline does this today.**
- **Suggested approach.** Add a one-liner to each agent prompt template:
  ```
  {{OPERATOR_HINT}}
  ```
  near the top. The substitution module already handles missing vars
  by leaving them as-is; safe to add even where the var is rarely set.
- **Gotchas.** Don't put it before `EXIT_SIGNALS_PROMPT_SUFFIX` (P0.1)
  — that breaks cache stability. Put it after the cache-stable head,
  before per-call body.

### P2.6 — Story 5.4 compact-resume triggers actual compaction

- **AC ref.** Story 5.4 AC#2: _"API enqueues a compaction job (Story 5.3
  logic, but on-demand instead of via the periodic sweep), waits for
  it (sync, with a 30s timeout), then opens the conversation against
  the compacted session."_
- **Current state.** `/api/jobs/:jobId/steps/:stepId/conversations` with
  `mode=compact-resume` synthesizes a placeholder compacted-session row
  with `tokenCount = oldCount * 0.4` and reuses the SAME `claudeSessionId`.
  No compaction job is enqueued; no transcript is rewritten.
- **Why deferred.** Depends on P1.3 (the actual compaction work).
- **Suggested approach.** After P1.3 lands: enqueue a one-shot
  daemon-side compaction job, wait for completion (poll DDB with 30s
  timeout), then create the conversation against the rewritten session.
  Cost preview accurately reflects compaction overhead + post-compact
  cheaper resume cost (per AC#3).

### P2.7 — Mount `<PlanCostMeter />` in plan dashboard header

- **AC ref.** Story 4.5 AC#1: _"Add cost meter component to plan
  dashboard header."_
- **Current state.** Component exists at
  `src/components/labs/plans/cost-meter.tsx` and works against the
  raise-cost-ceiling API. **It's not rendered anywhere.**
- **Suggested approach.** In `src/components/labs/plan-dashboard/labs-header.tsx`
  (or wherever the plan dashboard header lives), import and render:
  ```tsx
  <PlanCostMeter
    planId={plan.planId}
    costSoFarUsd={plan.totalCostUsd}
    costCeilingUsd={plan.costCeilingUsd}
  />
  ```
  next to the existing chips.
- **Gotchas.** `plan.totalCostUsd` is a denormalized rollup; verify it
  stays in sync with the per-job costSoFarUsd sum. P1.9 needs that
  invariant too.

### P2.8 — Mount `<DailyCostWidget />` in admin header

- **AC ref.** Story 4.6 AC#1.
- **Current state.** Component exists in `cost-meter.tsx`. Not rendered.
- **Suggested approach.** Add to `src/components/layout/header.tsx`
  next to `<ConcurrencyChip />`. Same pattern.

---

## Dev-correction 2nd iteration — wiring deferrals

| Field                         | Value                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stage corrected**           | **Developing** — specifically the per-story `DEV → REVIEWER → COMPILER → SYNC` pipeline that runs inside a wave during the Developing stage of a Plan                                                                                                                                          |
| **Source plan**               | `docs/concepts/epics-and-stories-pipelinev1-dev-correction.md` (28 stories across Epics A–E)                                                                                                                                                                                                   |
| **Pure-function libs landed** | 2026-04-27 across 5 commits: `85b399e` (A) → `e052ab0` (C) → `8851af3` (B) → `b34dfb0` (D) → `25926a4` (E)                                                                                                                                                                                     |
| **Deploy**                    | 2026-04-27 ~10:15 UTC: `git push origin main` (1465 objects, all 6 epic + doc commits live on origin/main) + `npx sst deploy --stage production` (Lambda + cron + admin static) + `bash scripts/rsync-daemon.sh` + `sudo systemctl restart futurator-daemon` (PID 48653, 32.9M RSS, 11 tasks). |
| **Tests landed**              | 366 passing — every library has co-located unit tests; cross-impl parity tests pin daemon `.mjs` and Lambda `.ts` parsers                                                                                                                                                                      |

### Post-deploy state (2026-04-27)

> **Most of the 1st-iteration "wiring" already shipped — but is not yet in git.**
>
> The original `daemon/agent-daemon.mjs` + `functions/api/index.ts` +
> `functions/shared/types/agent-orchestrator.ts` modifications I authored
> alongside Epics A/B/C were left in the working tree (not committed) when
> the library commits landed, to keep blast radius small. When the user
> ran `sst deploy` + `rsync-daemon.sh` on 2026-04-27, those uncommitted
> working-tree changes were bundled into the build and deployed to
> production. So the runtime has the wiring; git's origin/main does not.
>
> Concretely, **what's deployed but not committed to git** (= "git-divergent"):
>
> - `daemon/agent-daemon.mjs` — items #1–#7 below (visual-tests merge hook,
>   substituteTemplateLib import, jobStoryShortIds + withStoryPrefix,
>   context-pack resolver hook, persistStoryWorkSummary call,
>   REVIEW_CRITERIA parser hook, handleEscalation REVIEWER_NEEDS_HUMAN
>   branch).
> - `functions/api/index.ts` — item #12 (`/apply-output` parses operator's
>   REVIEW_CRITERIA reply when `triggeredBy === 'REVIEWER_NEEDS_HUMAN'`).
> - `functions/shared/types/agent-orchestrator.ts` — item #13
>   (`'REVIEWER_NEEDS_HUMAN'` in `JobTriggeredBy`).
>
> **Implication:** If anyone clones origin/main fresh and rebuilds,
> they'll get a DIFFERENT runtime than what's deployed. The 2nd iteration
> commit's first job is to commit the working tree to bring git back in
> sync with infrastructure.
>
> **What's still NOT deployed and NOT in working tree** (= truly deferred,
> need new wiring code): items #8 (D.4 scope-violation pre-fill),
> #9 (D.5 prework-check daemon routing), #10 + #11 (E.3 wave-compile
> prompt swap + atomic file writes), #14 (D.5 `COMPLETED_VIA_PREWORK`
> status enum), #15 (E.2 wave-compile cron dispatcher),
> #16 (D.3 `resolveWaves` plan-reducer integration),
> #17 (D.3 `assertWaveScopeNonOverlapping` launcher check).

### Why a single 2nd iteration?

The dev-correction plan was deliberately designed so each story's
**logic** lives in a pure module (deterministic, unit-tested) while the
**glue** — calling the module from `agent-daemon.mjs`, the API Lambda,
the cron, or the launcher — is a separate concern. The first iteration
shipped the logic. The 2nd iteration is the one focused PR that wires
every library into the runtime. Bundling the wiring this way:

- Avoids re-touching `agent-daemon.mjs` five separate times (once per
  Epic) and re-resolving the same merge conflicts with the parallel
  pipelinev1 sibling-track.
- Lets the integration test the whole "story arrives → DEV runs →
  REVIEWER runs → COMPILER runs → SYNC runs → wave-close compile"
  sequence end-to-end on one branch, with the feature flag on.
- Keeps the rollback story simple: revert the single wiring commit and
  every dev-correction library still type-checks and unit-tests cleanly
  against the prior pipeline shape.

The corrections all target the **Developing** stage. None of these touch
the Concept, Review, or Delivered stages, the Party Mode flow, the
Touch-Point inference pipeline (Epic 3), or the Plan-build pipeline.

### What to wire — by file

Status legend:

- ✅ **LIVE** — deployed to production runtime (Lambda or daemon-on-EC2) via the 2026-04-27 working-tree deploy. Code is on the running infrastructure but NOT yet on origin/main. The 2nd iteration commit needs to commit it so git matches runtime.
- ⏳ **DEFERRED** — not in working tree, not deployed. Requires new wiring code.

#### `daemon/agent-daemon.mjs`

The daemon already has the new module imports — they were added in
the deferred branch and never committed alongside the libraries. The
2nd iteration commit re-applies them and closes the loop. Hooks:

1. ✅ **LIVE — A.2 — visual-tests-writer merge hook.** After
   `runExtractors` returns `extracted.VISUAL_TESTS`, call
   `mergeVisualTestsBlock({ projectDir: workingDir, block: extracted.VISUAL_TESTS })`
   from `daemon/pipelines/lib/visual-tests-writer.mjs`. On success
   `pushEvent('status', …)`; on parse failure `writeAttentionItem` with
   `category: 'compile-sync-failed'`. Order matters: must complete
   BEFORE the reviewer step starts, so place inside the
   post-extraction loop in `executeStep`.

2. ✅ **LIVE — A.5 — `substituteTemplate` hoisted to lib.** Replace the inline
   `substituteTemplate` function with a thin wrapper around
   `substituteTemplateLib` from
   `daemon/pipelines/lib/template-substitution.mjs` (already shipped),
   passing the daemon's `log` as the `onMissing` callback. Behavior
   unchanged; testability improved.

3. ✅ **LIVE — A.7 — `storyShortId` log decoration.** Add a module-scope
   `jobStoryShortIds = new Map()`. Populate it in `executePipeline`
   from `pipeline.initialVariables.STORY_ID` (uppercased, first 6
   chars). Add helpers `storyShortIdForJob(jobId)` and
   `withStoryPrefix(shortId, msg)`. Decorate the dozen step-boundary
   `log()` calls (`Pipeline starting`, `STEP: …`, `Step done`, `LOOP
iteration`, `Pipeline COMPLETED`, etc.) with the prefix.
   `pushEvent` opportunistically tags every event with
   `storyShortId` so the Logs tab can render `[ABC123]` per row. Clear
   the map in `runJobAsync`'s `finally`.

4. ✅ **LIVE — B.2 — context-pack resolver hook.** Before the steps loop in
   `executePipeline`:

   ```js
   const resolved = await resolveAndSerializeContextPack({
     ddb,
     job,
     variables,
     logger: { info, warn, error },
   });
   variables.PROJECT_CONTEXT = resolved.body;
   ```

   The resolver lives at
   `daemon/pipelines/lib/context-pack-resolver.mjs`. It never throws —
   on any failure it returns a stub body so the pipeline still runs.
   This populates `{{PROJECT_CONTEXT}}` for the DEV/REVIEWER/COMPILER
   prompts (the prompts already reference it as of `25926a4`).

5. ✅ **LIVE — B.6 — `workSummary` persistence.** After
   `extractedVariables.WORK_SUMMARY` is captured AND `step.id` is
   `'dev'` or `'retry'` AND `variables.EPIC_ID` is set, call
   `epicRepo.persistStoryWorkSummary(epicId, storyId, workSummary)`.
   Best-effort: a failure here logs but does not derail the step.
   Module-scope `epicRepo = createEpicRepo({ ddb, tableName: EPICS_TABLE })`
   already exists for the daemon receiver — reuse the same instance.

6. ✅ **LIVE — C.2 — REVIEW_CRITERIA parser hook.** After extractors run, when
   `step.id === 'review'` AND `extracted.REVIEW_CRITERIA` is present:
   parse via `parseReviewCriteria` + `aggregateReviewVerdict` (from
   `daemon/pipelines/lib/review-criteria-parser.mjs`) and synthesize
   `variables.VERDICT` + `variables.FEEDBACK`:
   - `pass` → `VERDICT='PASS'`, FEEDBACK = approval note
   - `fail` → `VERDICT='FAIL'`, FEEDBACK = `formatFailedReasonsForRetry(reasons)`
   - `malformed` → `VERDICT='FAIL'`, FEEDBACK asks reviewer to re-emit;
     write a `'prompt-format'` attention item (already in the
     AttentionCategory union, committed in `e052ab0`)
   - `needs-human` → `throw new EscalationSignal({ triggeredBy:
'REVIEWER_NEEDS_HUMAN', escalationPayload: { … humanQuestion },
salvageableExtractors: ['REVIEW_CRITERIA', 'WORK_SUMMARY'] })`
     so `runJobAsync`'s catch routes to NEEDS_ATTENTION.

7. ✅ **LIVE — C.5 — `handleEscalation` recognizes `REVIEWER_NEEDS_HUMAN`.** Add
   the new triggeredBy as a category branch (`'reviewer-needs-human'`,
   already in the AttentionCategory union) with `severity: 'medium'`
   and a distinct title. Keeps the operator inbox UX consistent with
   the existing agent-escalated / agent-needs-human paths.

8. ⏳ **DEFERRED — D.4 — scope-violation pre-fill.** Before the C.2 parser runs,
   compute scope violations from the dev's diff and prepend
   auto-generated `scope-touchpoints-N: fail` / `scope-forbidden-N:
fail` lines to `extracted.REVIEW_CRITERIA`. Use
   `parseDiffFiles(variables.DIFF_MANIFEST)` +
   `detectScopeViolations({ modifiedFiles, touchPoints, forbiddenAreas })`
   from `daemon/pipelines/lib/scope-violation-detector.mjs`.
   `renderScopeViolationsAsCriteria(report, ctx)` formats them. The
   reviewer's own AC verdicts run through the same parser and join
   the daemon-prefilled scope ACs deterministically.

9. ⏳ **DEFERRED — D.5 — prework-check + COMPLETED_VIA_PREWORK routing.**
   - In `context-pack-resolver.mjs` (or a thin wrapper called before
     the resolver), invoke
     `collectRecentTouchPointWork({ projectDir, sinceTime: planStart, touchPoints })`
     from `daemon/pipelines/lib/prework-check.mjs`. If commits match,
     append `renderRecentWorkBlock(report)` to the context pack as a
     `<recent_work>` section.
   - After the DEV step's WORK_SUMMARY extraction, run
     `detectNoChangesRequired(extracted.WORK_SUMMARY)`. When
     `noChangesRequired` is true: skip the rest of the pipeline, mark
     the job `COMPLETED_VIA_PREWORK` (new status — see
     `agent-orchestrator.ts` below), persist the cited shas, advance
     the wave reducer.

10. ⏳ **DEFERRED — E.3 — wave-compile prompt swap.** When the daemon picks up a
    `pipelineKind: 'wave-compile'` job, it must replace the
    `WAVE_COMPILE_PROMPT_PLACEHOLDER` on the `wave-compile-knowledge`
    step with the real prompt from
    `daemon/pipelines/lib/wave-knowledge-output-parser.mjs::buildWaveCompilePrompt(input)`,
    where `input` is reconstructed from `pipeline.initialVariables`
    (`WAVE_STORY_MANIFEST`, `WAVE_NUMBER`, `EPIC_TITLE`, etc.) and the
    captured `WAVE_DIFF` from step 1. The placeholder string is a
    detectable sentinel so the daemon can hard-fail with a clear
    message if the wiring drifts.

11. ⏳ **DEFERRED — E.3 — atomic per-file write of WAVE_KNOWLEDGE_OUTPUT.** After
    the wave-compile-knowledge step, parse
    `variables.WAVE_KNOWLEDGE_OUTPUT` via `parseWaveKnowledgeOutput`
    (same library) and `fs.writeFile` each `entries[i].content` to
    `entries[i].filePath` (relative to `workingDir`). One writer →
    no parallel-write race. Errors → `compile-sync-failed` attention
    item.

#### `functions/api/index.ts`

12. ✅ **LIVE — C.5 — `/apply-output` parses operator's REVIEW_CRITERIA reply.**
    The endpoint already accepts an optional `output` field in the
    request body and is wired to call `parseReviewCriteria` +
    `aggregateReviewVerdict` from
    `functions/shared/services/review-criteria-parser.ts` (TypeScript
    port, committed in `e052ab0`). Re-applying the deferred change:
    when underlying step is `review` AND `triggeredBy ===
'REVIEWER_NEEDS_HUMAN'`, the parsed verdict drives `VERDICT` +
    `FEEDBACK` on the underlying job's `variables` before the
    COMPLETED_VIA_SALVAGE flip. Backward compat: omit `output` →
    existing trust-the-operator path.

#### `functions/shared/types/agent-orchestrator.ts`

13. ✅ **LIVE — C.5 — Add `'REVIEWER_NEEDS_HUMAN'` to `JobTriggeredBy`.**
    Single-line addition; the daemon's `handleEscalation` already
    branches on the literal in the deferred wiring (item 7 above).

14. ⏳ **DEFERRED — D.5 — Add `'COMPLETED_VIA_PREWORK'` to `AgentJobStatus`.** Also
    register it in `agent-job-state-machine.ts` `TERMINAL_STATUSES` +
    `SUCCESS_STATUSES` (wave reducers MUST go through those helpers).
    Allowed transition: `RUNNING → COMPLETED_VIA_PREWORK`.

#### `functions/cron/wave-completion-check.ts`

15. ⏳ **DEFERRED — E.2 — Wave-compile dispatcher.** When all stories in a wave are
    DONE AND build-check / server-check pass:
    ```ts
    import { generateWaveCompilePipeline } from '../shared/pipelines/wave-compile-pipeline';
    const pipeline = generateWaveCompilePipeline({
      workingDir: epic.workingDir,
      epicId: epic.epicId,
      epicTitle: epic.title,
      wave: completedWave,
      stories: epic.stories.filter((s) => s.wave === completedWave),
      waveStartSha, // captured at wave-start (epic.waveStartShas[wave])
    });
    await agentJobsRepo.createJob({
      jobId: uuid(),
      status: 'PENDING',
      workingDir: epic.workingDir,
      pipeline,
      epicId: epic.epicId,
      concurrencyClass: 'background', // E.4
    });
    ```
    Gate behind `WAVE_CLOSE_COMPILER_ENABLED` env var (matches the
    feature flag in `story-pipeline.ts::isWaveCloseCompilerEnabled`).
    On failure → `compile-sync-failed` attention item (high severity,
    no auto-retry per AC#4).

#### `functions/shared/services/plan-reducer.ts`

16. ⏳ **DEFERRED — D.3 — `resolveWaves` at plan-build.** When the plan reducer
    builds the initial wave assignment for a freshly-planned epic,
    call `resolveWaves(stories)` from
    `functions/shared/services/wave-conflict-resolver.ts` and write
    each `{ story, wave, reason }` back to the epic row. Replaces or
    augments the existing wave-from-`dependsOn` computation. Fails
    loud if a story carries the `<UNKNOWN>` sentinel and the planner
    forgot touchPoints.

#### `functions/shared/services/pipeline-launcher.ts`

17. ⏳ **DEFERRED — D.3 — Defensive runtime check.** At the top of
    `launchPipelineWave` after filtering `waveStories`, call
    `assertWaveScopeNonOverlapping(waveStories)` from
    `wave-conflict-resolver.ts`. Throws a structured
    `{ code: 'wave-conflict' }` error which the launcher converts to
    an attention item before re-throwing.

### Wiring sequence (recommended)

> **Update post-2026-04-27-deploy:** Steps 1–5 are already LIVE on
> infrastructure (deployed via working tree); the 2nd iteration
> commit just needs to commit those changes to git so origin/main
> matches runtime. Steps 6–8 are the genuinely-new wiring work.

The order keeps partial-rollback options:

1. **Commit-already-live (LIVE)** — single git commit that captures
   the working-tree changes that shipped on 2026-04-27 to
   `daemon/agent-daemon.mjs` (items 1, 2, 3, 4, 5, 6, 7),
   `functions/api/index.ts` (item 12), and
   `functions/shared/types/agent-orchestrator.ts` (item 13). Adds the
   `'REVIEWER_NEEDS_HUMAN'` JobTriggeredBy literal so type-checks pass.
   **Smoke**: `tsc --noEmit` clean; `npx vitest run` no regressions
   beyond the 4 pre-existing `epic-dev-pipeline.test.mjs` failures.

2. **D.5 type additions** — `'COMPLETED_VIA_PREWORK'` to
   `AgentJobStatus` + register in `agent-job-state-machine.ts`'s
   `TERMINAL_STATUSES` + `SUCCESS_STATUSES` (item 14). Pure type
   union extension; no runtime change yet. **Smoke**: `tsc --noEmit`
   clean; wave reducer's tests still green.

3. **D.3 wave-conflict integration** — `plan-reducer.ts` calls
   `resolveWaves()` at plan-build time (item 16) +
   `pipeline-launcher.ts` calls `assertWaveScopeNonOverlapping()` at
   wave launch (item 17). **Smoke**: synthetic plan with overlapping
   touchPoints serialises into different waves at plan-build; if the
   data ever drifts, the launcher's defensive throw surfaces it as a
   `wave-conflict` attention item.

4. **D.4 daemon scope-violation pre-fill** — daemon item 8. Pre-fills
   `scope-touchpoints-N: fail` / `scope-forbidden-N: fail` AC lines
   into the structured REVIEW_CRITERIA block before the C.2 parser
   runs. **Smoke**: a DEV diff that adds an out-of-scope file gets a
   `scope-touchpoints` AC failure on review without the reviewer
   having to notice.

5. **D.5 prework-check daemon routing** — daemon item 9. After step 2
   ships the COMPLETED_VIA_PREWORK enum, wire the prework path:
   `<recent_work>` enrichment in the context pack +
   `detectNoChangesRequired` post-DEV → status flip. **Smoke**: a
   story whose touchPoints are already covered by recent commits
   terminates via `COMPLETED_VIA_PREWORK` without spawning a full DEV
   turn (~$0.05 + ≤1 minute vs $0.30 + ~3 minutes today).

6. **E.2 + E.3 wave-close compiler activation** —
   `wave-completion-check.ts` cron dispatcher (item 15) +
   agent-daemon.mjs prompt swap + atomic file writes (items 10, 11).
   Keep `WAVE_CLOSE_COMPILER_ENABLED=false` until smoke passes. Then
   flip to `true` per-Lambda env var in `sst.config.ts`. **Smoke**:
   3-story wave runs to DONE without per-story compile; one
   wave-compile job dispatches; all knowledge articles produced
   atomically. Per-epic compile time should drop from ~33 min to
   ~5 min.

### What's already done vs deferred — post-deploy 2026-04-27

Three states in the runtime/git matrix:

- 🟢 **In git AND live in production**
- 🟡 **Live in production but not yet on origin/main** — deployed via 2026-04-27 working-tree `sst deploy` + `rsync-daemon.sh`. The 2nd iteration commit captures these so git matches runtime.
- 🔴 **Not deployed, not in working tree** — genuinely deferred, requires new wiring code.

| ID  | Stage      | Library/types (committed)                                                               | Runtime wiring                                                                                                                      |
| --- | ---------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A.1 | Developing | 🟢 `process.env.COMPILER_MODEL` in `story-pipeline.ts` (`85b399e`, `25926a4`)           | 🟢 live                                                                                                                             |
| A.2 | Developing | 🟢 `visual-tests-writer.mjs` (`85b399e`)                                                | 🟡 daemon hook live in production (item 1) — not in git                                                                             |
| A.3 | Developing | 🟢 `compile-commit-on-pass` + simplified `compile-diff` (`85b399e`)                     | 🟢 live                                                                                                                             |
| A.4 | Developing | 🟢 `compile-sync` verify + `compile-sync-failed` category (`85b399e`)                   | 🟢 live                                                                                                                             |
| A.5 | Developing | 🟢 `template-substitution.mjs` (`85b399e`)                                              | 🟡 daemon hoist live in production (item 2) — not in git                                                                            |
| A.6 | Developing | 🟢 DEV prompt DISCOVERY/VERIFICATION + `<run_command>` (`25926a4`)                      | 🟢 live                                                                                                                             |
| A.7 | Developing | 🟢 `AgentEvent.storyShortId` + UI render (`85b399e`)                                    | 🟡 daemon log decoration + event tagging live in production (item 3) — not in git                                                   |
| B.1 | Developing | 🟢 `story-context-pack.mjs` (`8851af3`)                                                 | 🟢 pure module                                                                                                                      |
| B.2 | Developing | 🟢 `context-pack-resolver.mjs` + DEV prompt `<project_context>` (`8851af3` + `25926a4`) | 🟡 daemon resolver call live in production (item 4) — not in git                                                                    |
| B.3 | Developing | 🟢 REVIEWER prompt (`25926a4`)                                                          | 🟢 live (consumes `PROJECT_CONTEXT` set by daemon's runtime resolver)                                                               |
| B.4 | Developing | 🟢 COMPILER prompt (`25926a4`)                                                          | 🟢 live                                                                                                                             |
| B.5 | Developing | 🟢 `parseKnowledgeIndex` + format spec in COMPILER prompt (`8851af3` + `25926a4`)       | 🟢 Compiler agent maintains the format on the next compile                                                                          |
| B.6 | Developing | 🟢 `workSummary` type + `persistStoryWorkSummary` helper (`8851af3`)                    | 🟡 daemon persistence call live in production (item 5) — not in git                                                                 |
| C.1 | Developing | 🟢 REVIEWER prompt + REVIEW_CRITERIA contract (`25926a4`)                               | 🟢 contract live                                                                                                                    |
| C.2 | Developing | 🟢 review-criteria-parser `.mjs` + `.ts` (`e052ab0`)                                    | 🟡 daemon parser hook live in production (item 6) — not in git                                                                      |
| C.3 | Developing | 🟢 REVIEWER CONSTRAINTS prompt (`25926a4`)                                              | 🟢 live                                                                                                                             |
| C.4 | Developing | 🟢 REVIEWER DISCOVERY language (`25926a4`)                                              | 🟢 live                                                                                                                             |
| C.5 | Developing | 🟢 AttentionCategory + TS port + `/apply-output` shape (`e052ab0`)                      | 🟡 `JobTriggeredBy` literal + `handleEscalation` branch + `/apply-output` re-wire live in production (items 7, 12, 13) — not in git |
| D.1 | Developing | 🟢 `forbiddenAreas` type (`b34dfb0`)                                                    | 🟢 live                                                                                                                             |
| D.2 | Developing | 🟢 planner workflow doc (`b34dfb0`)                                                     | 🟢 next plan run uses it                                                                                                            |
| D.3 | Developing | 🟢 `wave-conflict-resolver.ts` (`b34dfb0`)                                              | 🔴 `plan-reducer` + `pipeline-launcher` integration not yet wired (items 16, 17)                                                    |
| D.4 | Developing | 🟢 `scope-violation-detector.mjs` (`b34dfb0`)                                           | 🔴 daemon pre-fill into REVIEW_CRITERIA not yet wired (item 8)                                                                      |
| D.5 | Developing | 🟢 `prework-check.mjs` (`b34dfb0`)                                                      | 🔴 `AgentJobStatus` addition + context-pack enrichment + daemon detector not yet wired (items 9, 14)                                |
| E.1 | Developing | 🟢 feature flag + step gating (`25926a4`)                                               | 🟢 live (default OFF)                                                                                                               |
| E.2 | Developing | 🟢 `wave-compile-pipeline.ts` (`25926a4`)                                               | 🔴 cron dispatcher not yet wired (item 15)                                                                                          |
| E.3 | Developing | 🟢 `wave-knowledge-output-parser.mjs` + `buildWaveCompilePrompt` (`25926a4`)            | 🔴 daemon prompt swap + atomic file writes not yet wired (items 10, 11)                                                             |
| E.4 | Developing | 🟢 `concurrencyClass='background'` on pipeline (`25926a4`)                              | 🟢 pipeline declares it                                                                                                             |
| E.5 | Developing | 🟢 `find -newer` fallback removed (`85b399e`)                                           | 🟢 live                                                                                                                             |

**Summary of impact for the next test run:**

What's actually firing (24/28 stories): every prompt, every cache-stable `<project_context>` block, every visual-tests merge, every per-story commit, every storyShortId-prefixed log line, every REVIEW_CRITERIA-parsed verdict, every workSummary persistence, every reviewer-needs-human → NEEDS_ATTENTION + Talk-to-agent flow.

What's NOT firing (4 deferred items):

- D.3 wave-conflict serialization at plan-build (silent collisions possible if the planner emits overlapping touchPoints in the same wave)
- D.4 auto scope-violation in REVIEW_CRITERIA (reviewer agent must catch out-of-scope diffs manually)
- D.5 prework "no changes required" fast path (no-op stories still spawn a full DEV turn)
- E.2 + E.3 wave-close compiler (per-story compile-knowledge still runs; `WAVE_CLOSE_COMPILER_ENABLED` defaults to `false`)

### Concurrency tuning (post-deploy 2026-04-27)

**Symptom on dino4 first run:** Wave 0 with 4 parallel-eligible stories ran
only one at a time. Diagnosis below — and the env-var fix is now applied
on EC2.

The daemon has **two layered concurrency caps** and they must be in sync:

1. **Legacy poll-loop cap (`agent-daemon.mjs:330`):**

   ```
   MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10)
   ```

   Gates how many PENDING jobs the daemon's poll loop fetches per cycle.
   `availableSlots = MAX_CONCURRENT - activeJobs.size`.

2. **SessionPool slot ceiling (`daemon/lib/session-pool.mjs:13–15`)** —
   added by pipelinev1 sibling Story 2.1/2.5:
   ```
   total ceiling                  = MAX_CONCURRENT_TOTAL          (env, default 2)
   reserved for interactive       = MAX_CONCURRENT_INTERACTIVE_RESERVED  (env, default 1)
   critical + background combined = ceiling − reserved            = 1 (default!)
   ```

The defaults gave critical+background **only 1 slot** — so per-story dev
jobs (which class as `'background'` per the SessionPool's "everything
else → background" heuristic) ran sequentially even when the wave had 4
parallel-eligible stories.

**Applied fix (2026-04-27, ~11:13 UTC):** appended to
`/opt/futurator-daemon/.env`:

```
# Pipeline-v1 dev-correction tuning (2026-04-27)
MAX_CONCURRENT_TOTAL=4
MAX_CONCURRENT_INTERACTIVE_RESERVED=1
MAX_CONCURRENT=4
```

Restarted daemon via `sudo systemctl restart futurator-daemon`. Verified
in the heartbeat row: `ceiling: 4`, `freeSlots.background: 2`, and
3 simultaneous dev jobs running on dino4 within seconds of restart.

**Memory budget on t2.micro (live capture):**
| Configuration | Total claude RSS | System used | Available |
|---|---|---|---|
| 1 claude (default) | ~232 MB | ~700 MB | ~1.1 GB |
| 3 claudes (current cap) | ~730 MB | ~1055 MB | ~781 MB |
| 4 claudes (if `RESERVED=0`) | ~970 MB | ~1290 MB | ~547 MB (tight) |

**To unlock the full 4 simultaneous:** set
`MAX_CONCURRENT_INTERACTIVE_RESERVED=0`. Trade-off: a Talk-to-agent
request mid-wave has to wait for a dev slot to free. Acceptable when
the operator isn't actively chatting.

**To unlock more than 4** (typical wave size 5-8): upgrade `t2.micro`
→ `t3.medium` (4 GB RAM, on-demand ~$30/mo). Then ceiling=8,
RESERVED=2 runs 6 dev jobs comfortably.

**Operator decision tree:**

- "I'm only doing pipeline work, no Talk-to-agent right now" → set `RESERVED=0`, `ceiling=4`. Full 4 parallel.
- "Talk-to-agent is in flight or might be" → keep `RESERVED=1`, `ceiling=4`. 3 parallel + 1 reserved for the operator.
- "Wave sizes routinely 6+" → bump ceiling to 5-6 and watch for OOM in `journalctl -u futurator-daemon`.
- "OOM events appearing" → revert `MAX_CONCURRENT_TOTAL` to 3 immediately, then plan the t3.medium upgrade.

**Health check after every concurrency change:**

```bash
ssh -i ~/.ssh/debatator-memgraph.pem ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com \
  "sudo systemctl is-active futurator-daemon && \
   ps -eo rss,comm | grep claude && \
   free -m | head -2"
```

Expect `active`, N claude processes (one per simultaneous job), and
≥400 MB available. If available <300 MB, dial back.

---

### Smoke-test runbook for the first new plan post-deploy

Run a small (3–5 story) plan and watch for these signals to confirm the
2026-04-27 deploy is firing all the LIVE corrections:

#### Per-story signals (Logs tab + DDB)

- **Logs tab events carry `[ABC123]` prefix** (first 6 chars of the
  story UUID, uppercased). Two parallel stories' events should be easy
  to disambiguate. (Story A.7)
- **`extraction PROJECT_CONTEXT = ...` event** fires before the dev
  step starts; the `variableValue` preview should show
  `<!-- story-context-pack v1 -->` followed by sections for plan,
  story spec, project tree, recent diffs, prior summaries. (Story B.2)
- **`status visual-tests.md updated (N entries; +M new, ~K replaced)`**
  fires after the DEV step when the story has browser tests. The file
  should exist on the worker at `<projectDir>/visual-tests.md`. (Story A.2)
- **`extraction REVIEW_CRITERIA = ...`** fires after the reviewer step.
  Followed by a daemon log line:
  `REVIEW_CRITERIA → verdict=pass (pass=N, fail=0, needsHuman=0, malformed=0)`.
  (Story C.2)
- **`epic.stories[i].workSummary` populated** in DDB after each DEV
  step. (Story B.6)
- **One `git commit` per story** in the project repo on the worker.
  Author: `Daemon <daemon@futurator.local>`. Message: `story: <id> — <title>`.
  (Story A.3)
- **`compile-diff` exits 0 with a clean per-story file list.** No
  `find -newer` invocations. (Story A.3 + A.4)
- **`compile-sync` verifies S3 mirror** with
  `S3 mirror verified: N objects under knowledge-live/<projectId>/`.
  Failure → `compile-sync-failed` attention item. (Story A.4)

#### Reviewer needs-human flow (force one ambiguous AC)

To exercise C.5 end-to-end, write a story with at least one AC that's
deliberately subjective (e.g., "the colour palette feels game-show-ish").
The reviewer should emit `AC-N: needs-human — <question>` and you should see:

1. Job → `NEEDS_ATTENTION` with `triggeredBy: REVIEWER_NEEDS_HUMAN` in the row.
2. Inbox at `/inbox` shows a new item with category `reviewer-needs-human`.
3. Click "Talk to agent" → opens a fresh-mode conversation. Type a verdict
   reply (with or without an updated `---REVIEW_CRITERIA---` block).
4. Click "Apply output". If your reply contained a parseable
   `---REVIEW_CRITERIA---` block with the underlying step's verdict mapped,
   the response includes `appliedReviewVerdict: { verdict: 'pass', ... }`.
   The job flips to `COMPLETED_VIA_SALVAGE` and the wave advances.

#### Things that will NOT happen yet (4 deferred items)

- A story that touches a file outside its declared `touchPoints` will
  NOT auto-fail review. The reviewer agent might catch it; the daemon
  won't enforce it. (D.4)
- A story whose `touchPoints` are already covered by recent commits
  will still spawn a full DEV cycle. No `COMPLETED_VIA_PREWORK` short-
  circuit. (D.5)
- A wave's per-story `compile-knowledge` + `compile-sync` will run
  N times (one per story). The wave-close batched compile is gated
  on `WAVE_CLOSE_COMPILER_ENABLED=true` AND items 10/11/15. (E.2 + E.3)
- If the planner emits two stories with overlapping `touchPoints` in
  the same wave, they will run in parallel and silently overwrite each
  other's edits. (D.3) **Mitigation**: Plan with `dependsOn` between
  same-file stories until item 16/17 lands, OR force serialised waves
  by hand.

#### Health check before testing

```bash
# Local: make sure git is clean of unintended drift
git status -s | head

# EC2: confirm daemon is running with the post-deploy code
ssh -i ~/.ssh/debatator-memgraph.pem ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com \
  "sudo systemctl is-active futurator-daemon && sudo journalctl -u futurator-daemon --since '5 min ago' --no-pager | tail -20"
```

The daemon should be `active`, with no startup errors and a recent
`Agent daemon started` log line (or its equivalent).

### Out of scope for the 2nd iteration

The following are deliberately NOT in this iteration's scope:

- **The Concept stage** (PM agent / plan-build pipeline). Untouched.
- **The Review stage** (QA / Visual-QA / PO sign-off). Untouched —
  Visual-QA work is tracked in its own QA dev-track.
- **Touch-point inference** (Epic 3 / Haiku-based predicted
  touchPoints during plan creation). The new resolver in D.3 consumes
  whatever touchPoints the planner emits; it doesn't replace inference.
- **Party Mode** (Epic 15 BMAD). The DEV/REVIEWER/COMPILER context-pack
  block is per-story and doesn't apply to party-turn jobs (the
  resolver early-returns a stub for non-story jobs).
- **The orchestrator path** (`useEpicOrchestrator: true` jobs). Epic A's
  prompt hygiene + B's context pack target the per-story step pipeline.
  The orchestrator's subagent prompts (`.claude/agents/dev-*.md`) are a
  separate surface and were not modified.

### Gotchas discovered while authoring the libraries

- **Linter/formatter reverts.** Every time the library commits touched
  `functions/shared/pipelines/story-pipeline.ts`, a save-time hook
  reverted the prompt rewrites once, requiring a re-edit. The 2nd
  iteration should commit the hook-affecting files in one shot rather
  than across multiple edits.
- **`process.env` in Lambda.** `COMPILER_MODEL` (A.1) and
  `WAVE_CLOSE_COMPILER_ENABLED` (E.1) are read by `story-pipeline.ts`
  which runs in the API Lambda + cron Lambda. Set both as Lambda env
  vars in `sst.config.ts` when flipping the wave-close flag in prod.
- **`agentRepo` reuse.** `daemon/agent-daemon.mjs` already has a
  module-scope `epicRepo` instance for the receiver. The B.6 wiring
  (item 5) reuses that instance — don't create a second one.
- **Cross-impl parity test.** `functions/shared/services/__tests__/review-criteria-parser.test.ts`
  imports the daemon `.mjs` parser via a relative path
  (`../../../../daemon/pipelines/lib/review-criteria-parser.mjs`).
  When CI runs the Lambda test set, it pulls the `.mjs` file via that
  path — keep both files committed in the same PR if grammar changes.
- **`.mycelium/` is gone.** Story A.3 removed the `last-compile-marker`
  side-channel. If the project repo on EC2 has stale `.mycelium/`
  directories, the wave-compile sync (item 11) is fine — it doesn't
  read from there. Cleanup is purely cosmetic.

---

## Stretch / not-yet-prioritized

These came up during the v1 build but didn't make the AC. Worth
revisiting once the P0/P1 backlog drains:

- **Auto-resolve attention items on resolution actions.** Today,
  Salvage / Retry / Skip / Abort each individually call
  `updateAttentionStatus(planId, itemId, 'resolved')` for every linked
  item. If a job has many items, this is O(N) DDB writes. Could batch
  via `BatchWriteCommand` or fold into a single `resolveJobItems(jobId)`
  helper.
- **Inbox row aggregation.** When a single job has multiple attention
  items (e.g., preflight failed → operator retried → loop detected),
  the inbox shows them all. Consider collapsing per-job with a count
  badge.
- **Concurrency chip "queue position" indicator.** Current popover
  shows queued jobs but not their position in the priority order. A
  `position: N of M` chip would help operators decide whether to
  promote.
- **Failed-step panel "Show full log" → actual log.** Currently shows
  `job.errorMessage`. Could fetch the last N events from
  `agent-events` and render them inline.
- **Cost-attribution by agent kind.** Story 4.6 tech notes mention
  "per-agent-kind cost shaping" as future. Once tokenCount + agentKind
  are populated on sessions (P0.5 + P2.4), this is a single GROUP BY.

---

## Document conventions

- **Status field on each item:** add `Status: open | in-progress | done`
  inline as items move. Don't delete done items from this doc — they're
  the audit trail.
- **AC ref:** always link back to `epics-and-stories-pipelinev1.md`
  story id so the PR description is grep-able.
- **Gotchas:** record what you discover _during_ implementation, not
  after. Future-you reads this doc cold.
