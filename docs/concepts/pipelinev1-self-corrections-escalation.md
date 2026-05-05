# Pipeline v1 — Self-Correction, Escalation, and Multi-Agent Concurrency

**Status:** Draft plan, not yet sequenced into epics
**Authors:** Ricardo + Claude (planning session 2026-04-26)
**Triggering incident:** dino3 QA reviewer job emitted a perfect `---QA_REPORT---` (PASS, all 5 tests, screenshots uploaded), then a 429 from Anthropic killed the closeout call. Three exponential-backoff retries also 429'd. The work was preserved in `job.variables` but stranded — no UI to apply it. See `docs/concepts/pipelinev1-self-corrections-escalation.md` (this doc) for the broader fix.

---

## 1. Executive summary

Today's pipeline is a one-shot conveyor belt: each job runs, succeeds or fails, and on failure the only escape hatch is "delete the plan and start over." That breaks down across three pressures the system is now hitting:

1. **Concurrency** — a single Claude Code account caps at ~2 concurrent sessions. As soon as a Party Mode chat overlaps with a pipeline step, 429s start. The user's intent is to run **2+ apps in parallel pipelines + simultaneous interactive sessions**. Today's daemon won't survive that.
2. **No graceful failure path** — when a step fails, valid output already produced is thrown away. The dino3 incident is the canary.
3. **No conversational debug surface** — once a job fails, the human can read logs but can't ask the agent "what did you find" or "try this differently." The 5,000+ tokens of context inside the failed agent's session are inaccessible.

Three strategic moves that solve these together:

- **A. Slot-aware concurrency manager** — a single `SessionPool` that issues admission tokens by priority class (interactive > critical-path > background), with an OAuth-account / API-key fallback for capacity expansion.
- **B. Universal salvage + escalate protocol** — every agent step emits structured exit signals (`---DONE---`, `---ESCALATE---`, `---NEED-HUMAN---`); the daemon parses them; failed jobs become *resumable artifacts* rather than dead ends.
- **C. Talk-to-agent surface** — a generalized `agent-conversation` channel (built by decoupling the existing `party-turn` pipeline from BMAD-Party-Mode) so a human can chat with any session attached to any failed/active step.

Build order: **B (1 week) → A (1-2 weeks) → C (2 weeks)**. B unblocks the immediate pain. A prevents the next 429. C is the long-term moat.

---

## 2. Domain model — five things that are not the same thing

The system today conflates these. The plan separates them:

| Concept | Lifetime | Identity | Storage |
|---|---|---|---|
| **Plan** | Permanent | `planId` (UUID) | `futurator-plans` |
| **Job** | One pipeline run | `jobId` (UUID) | `futurator-agent-jobs` |
| **Step** | One pipeline stage | `stepId` (string in pipeline def) | nested in `job.steps[]` |
| **Session** | One Claude conversation | `claudeSessionId` (UUID from `system.init` event) | new: `futurator-agent-sessions` |
| **Conversation** | A human-driven chat | `conversationId` (UUID) | new: `futurator-agent-conversations` |

A job has many steps; a step has 0..1 sessions (some steps are pure shell, no Claude); a session can have 0..N human conversations (forks). A session is *the cache-bearing thing* — that's what `claude --resume` operates on. A conversation is *a UI-bound chat thread* on top of a session.

Today's code only models Plan + Job + Step explicitly. Sessions exist in `partySessions` for Party Mode and in `agentJob.sessions` (a `Record<stepId, sessionId>`) but aren't first-class. Conversations don't exist as a concept — Party Mode reuses the session itself as the chat. This conflation is why "talk to a QA agent" is currently impossible.

---

## 3. Cache & context management

Claude's prompt cache is the system's hidden tax. Every architectural decision below is partly a bet on cache behavior.

### 3.1 What we get for free
- 5-minute TTL on the default cache tier (1-hour tier exists with `cache_control: ephemeral` headers; Claude Code uses default).
- Up to 4 cache breakpoints per request.
- Cache hit = ~10% of base input cost; cache miss on a previously-cached prefix = full retokenization.
- Resuming a session via `claude --resume <sid>` after >5 min idle = full cold replay of the entire transcript.

### 3.2 Session warmth classification

| State | Idle time | Cache cost on next turn | Strategy |
|---|---|---|---|
| **HOT** | <2 min | Near-100% hit | Pipeline-natural. Don't interrupt. |
| **WARM** | 2-5 min | Partial hit, decaying | Eligible for resume. Cost spike acceptable. |
| **COLD** | 5-30 min | Full miss on conversation prefix | Resume only if continuity matters more than $$. |
| **STALE** | >30 min | Full miss + likely token bloat | Default to fresh session + handoff doc. |

The `SessionRegistry` (§9.2) tracks `lastTurnAt` and computes warmth on read. UI shows it as a chip ("warm — $0.04 to resume" vs "stale — $0.31 to resume").

### 3.3 Token bloat — the slow killer

A QA agent that ran for 30 min has a session containing:
- ~5k system prompt + tool definitions
- ~10k project context (file tree, recent files)
- ~50-200k tool results (file reads, bash outputs, screenshot reads — vision tokens are heavy)
- ~5-20k self-reasoning text deltas

Resuming a 100k-token session and adding one human turn costs ~$0.30 just for the cache miss on the prefix. Beyond ~150k tokens, model recall and instruction-following degrade noticeably (well-documented Anthropic behavior, not a Futurator-specific concern).

### 3.4 Three resume strategies

| Strategy | When | Cost | Continuity | Ergonomics |
|---|---|---|---|---|
| **A. Fresh + handoff** | Default for failed-step debug | Low | Low — agent doesn't "remember" trying X | Best — clean canvas |
| **B. Full resume** | Mid-debug, continuity-critical | High when cold | Full | Confusing if context is huge |
| **C. Compacted resume** | Sessions >80k tokens | Medium | Partial — older turns summarized | Best for long-running |

Default to **A** for "talk to a failed agent." Offer **B** as an opt-in toggle ("Open with full context"). Apply **C** automatically in the background whenever a session crosses 80k tokens — replaces turns 1..N with a synthesized summary block so the next resume is cheaper. Compaction itself runs as a one-shot Sonnet call; cost is amortized over future resumes.

### 3.5 Cache-warming

For high-value sessions (active Party Mode chats, debug conversations the user opened in the last hour), the daemon issues a no-op "ping" turn every ~4 minutes to keep the cache hot. Cost: ~1x of a normal turn. Savings: ~9x on the actual next user turn.

**Disable** cache-warming for background pipeline sessions — they're paid for by the pipeline run and don't benefit from cross-step warming.

### 3.6 Cross-session prefix sharing

The system prompt + tool definitions are identical across all agent jobs of the same kind (e.g., all QA agents). Anthropic's cache is keyed by exact prefix, so this naturally caches at the API level *if requests are close enough in time*. The daemon should:
- Issue same-kind jobs through the same execution channel when possible
- Avoid randomization in system prompts (timestamps, random IDs) that would invalidate the prefix

This is a free 30-50% cost reduction on background pipeline jobs. Audit the agent prompt templates for cache-busters.

---

## 4. Concurrency model

### 4.1 The wall

Anthropic's Claude Code rate limits are **per OAuth account**, with a small concurrent-session ceiling (today's daemon shows `1/2 concurrent`). The limit is not just RPM/TPM — it's literally "you can have N parallel turns in flight." Hit N+1 and you get the 429 the dino3 QA hit.

Two things drive demand:
- Pipeline jobs (PM, Dev, Reviewer, QA, Deploy) — each is one or more sequential agent calls
- Interactive sessions (Party Mode chats, talk-to-agent) — bursty, human-paced

The user's vision: "2+ apps in different pipeline stages + 1+ interactive chats." Realistic peak: 4-6 concurrent sessions. Single-account capacity: 2. Need a multiplier of ~3x.

### 4.2 Slot budgeting

Define a `SessionPool` with **typed slots**:

```
INTERACTIVE_SLOTS = 2     # Party chat, talk-to-agent, orchestration debate
CRITICAL_SLOTS    = 2     # Currently-blocking-the-user's-progress (e.g., the wave they're watching)
BACKGROUND_SLOTS  = 4     # Pipeline jobs the user isn't actively watching
```

Total = 8 slots. To get there from a current ceiling of 2 we need:

### 4.3 Capacity sources (ranked)

1. **API key fallback for background** — Pipeline jobs (PM, Dev, Reviewer, QA, Deploy) run on a raw Anthropic API key with strict per-job cost ceilings. Interactive sessions stay on the Claude Code OAuth subscription. Two independent rate-limit pools = ~doubled capacity, no extra subscriptions. **Recommended primary capacity move.** Cost: API metered usage, but capped per job.
2. **Multiple OAuth accounts (account pool)** — Each daemon instance authenticated to a separate Claude Code account; jobs round-robin across them. Linear scaling but expensive ($X/mo per account) and operationally fiddly. **Reserve for if (1) isn't enough.**
3. **Time-shifted batching** — Tag jobs `priority: nightly` and run them in a low-traffic window. Cheap, slow. Good for non-urgent retros, deploy-prep checks. **Implement as a quality-of-service knob, not the primary lever.**

### 4.4 Admission control

Every Claude spawn goes through `SessionPool.acquire(class, jobId)`:

```
acquire(class, jobId):
  if free_slot_in(class):
    return token
  if class == INTERACTIVE and any free slot in CRITICAL:
    promote, return token  # interactive can borrow from critical
  if class == BACKGROUND:
    queue indefinitely, FIFO
  if class in (INTERACTIVE, CRITICAL):
    queue with timeout = 30s; if still no slot, throw 429-equivalent immediately
```

Background jobs **never** preempt interactive. Interactive can steal from CRITICAL but not from BACKGROUND (different account / API path). Steals are non-destructive: the CRITICAL job pauses between its current step and the next step (jobs are step-decomposed; we already wait between steps in the daemon).

### 4.5 429 retry strategy (fix the immediate bug too)

Current retries: 30s → 2m → 8m, blind. Replace with **event-driven**:

- On 429, register a one-shot waiter on `SessionPool.slot_freed`
- When *any* concurrent session finishes, retry the queued job
- Add jitter (0-2s) so multiple queued jobs don't sync up
- Keep the 8m hard ceiling as a fallback in case the slot-freed event never fires (e.g., daemon restart)
- Distinguish 429 reasons: parse the response body. `concurrent_requests` → wait for slot. `daily_limit` → escalate to human immediately, don't retry.

### 4.6 Pre-flight 429 prediction

Before spawning a Claude session, the daemon checks:
- Active sessions on this account
- Time since last 429 (cool-off window)

If conditions look hot, it queues rather than spawns. Cheaper than letting Anthropic 429 us.

---

## 5. Agentic self-correction

### 5.1 What's safely automatable

| Class of error | Self-correctable? | Mechanism |
|---|---|---|
| Transient infra (429, 502, network) | Yes | Existing retry, but with §4.5 |
| Tool typo / wrong flag | Yes | Agent reads stderr, fixes, retries inside its own turn |
| Bad JSON output from agent | Yes | Re-prompt: "your last output didn't match schema X, please re-emit" |
| Compilation error after a code change | Yes | Agent reads error, edits, recompiles (pipeline already does this) |
| Test failure with clear cause | Often | Agent reads test, diagnoses, fixes |
| Conceptual / spec ambiguity | **No** — escalate |
| Two-true-requirements conflict | **No** — escalate |
| External system gone (S3 bucket missing, AWS down) | **No** — escalate |
| Cost / time ceiling exceeded | **No** — escalate |
| Loop detected (same tool 5x with no progress) | **No** — abort + escalate |

The principle: **self-correction is allowed when the error is local and the fix is observable**. Anything requiring a value judgment, anything that affects external state, anything where "did this actually work" can't be checked → escalate.

### 5.2 Universal exit-signal protocol

Every agent prompt (via a system prompt suffix) gets:

> **Exit signals.** When you finish, emit exactly one of:
> - `---DONE---` followed by your structured output (per pipeline schema)
> - `---ESCALATE---` followed by:
>   - `WHAT_FAILED:` one line
>   - `WHAT_I_TRIED:` bullet list (max 5)
>   - `WHY_STUCK:` one paragraph
>   - `RECOMMENDED_ACTION:` one of `retry-with-hint | skip-step | ask-human | abort-job`
>   - `HUMAN_QUESTION:` (only if RECOMMENDED_ACTION is ask-human) — single question to ask the human
> - `---NEED-HUMAN---` (drop-in shortcut for the common case) followed by `HUMAN_QUESTION:` only

The daemon parses these as extractors. `---DONE---` continues the pipeline. `---ESCALATE---` and `---NEED-HUMAN---` write to the AttentionInbox and pause the wave (without failing the job — see §6.3).

### 5.3 Loop detector

The daemon monitors the tool-use stream for each step:
- Hash each (tool_name, sorted(args)) tuple
- Maintain a sliding window of last 10 hashes
- If any hash appears 4+ times in the window → emit a synthetic system message: *"You appear to be retrying the same operation. Please escalate via `---ESCALATE---` if you cannot find a different approach."*
- If the loop continues past 6 occurrences → forcibly terminate the step and write to AttentionInbox with reason `LOOP_DETECTED`

This catches the dino3-style "I can't find playwright, let me grep more places" thrashing pattern early.

### 5.4 Pre-flight validators

Each pipeline step declares preconditions. Daemon checks them before spawning Claude:

```js
preconditions: [
  { check: 'folder-exists', path: '${workingDir}', writable_by: 'ubuntu' },
  { check: 'port-free', port: 5175 },
  { check: 'playwright-available' },
]
```

Failures surface as a structured pre-flight error — never as a wasted Claude turn. The chown bug we just fixed would have been a one-liner pre-flight check.

### 5.5 Validators on output

Each step also declares post-conditions on extracted variables:

```js
extractors: [
  { name: 'QA_REPORT', between: ['---QA_REPORT---', '---END_QA_REPORT---'], required: true },
  { name: 'OVERALL_VERDICT', regex: /OVERALL_VERDICT:\s*(PASS|FAIL)/, required: true },
],
postValidate: (vars) => vars.OVERALL_VERDICT === 'PASS' || vars.FAILED_TESTS?.length > 0,
```

A step whose extractors all fired but whose post-validator fails → re-prompt the same agent in-session ("your verdict was FAIL but you didn't list failed tests; please re-emit"). Bounded retry count = 2.

---

## 6. Escalation to human

### 6.1 Triggers

A job creates an attention item when:
1. Retry exhaustion (existing path, currently dead-end)
2. Agent emits `---ESCALATE---` or `---NEED-HUMAN---`
3. Loop detector forced termination
4. Pre-flight validator failed
5. Cost ceiling for this job/plan/day reached
6. Time ceiling for this step exceeded (configurable per step type)
7. Post-validator on extracted output failed twice
8. External validator failed (e.g., reviewer says PASS but `npm test` exits non-zero)

### 6.2 Attention item shape

An entry the human can act on without re-reading a 30-min log:

```
{
  attentionItemId,
  planId, jobId, stepId, sessionId,
  triggeredBy: 'RETRY_EXHAUSTED' | 'AGENT_ESCALATED' | 'LOOP_DETECTED' | ...,
  summary: string,           // one paragraph, agent- or daemon-generated
  whatAgentTried: string[],  // bullet list, from ---ESCALATE--- payload
  costSoFar: number,
  estimatedCostToResume: number,  // computed from session warmth + token count
  recommendedActions: ('retry' | 'salvage' | 'skip' | 'talk' | 'abort')[],
  humanQuestion?: string,    // populated by ---NEED-HUMAN--- payload
  rawLogUrl: string,         // for the curious
  createdAt, resolvedAt, resolvedBy, resolution
}
```

### 6.3 Pause vs fail

Today's failure is terminal: the job is `FAILED`, the wave is `BLOCKED`, no recovery. New behavior:

- `FAILED` → reserve for "this job will never succeed, abandon ship"
- New status `NEEDS_ATTENTION` → wave paused, work preserved, attention item in inbox
- `RUNNING` jobs that hit pre-flight failures → immediately `NEEDS_ATTENTION`, never `FAILED`
- A `NEEDS_ATTENTION` job is resumable; the human's chosen action transitions it back to `RUNNING` (retry) or `COMPLETED` (salvage/skip with manual verdict).

### 6.4 Resolution actions

| Action | What happens |
|---|---|
| **Retry** | Re-enqueue same step, same params. Counter increments. After N (configurable) consecutive retries the action becomes unavailable — must talk or abort. |
| **Salvage** | Apply already-extracted variables as if the step succeeded. Available only if extractors fired. Marks step `COMPLETED_VIA_SALVAGE` for traceability. |
| **Skip** | Mark step `MANUALLY_SKIPPED`. Wave advances. Variables left empty (downstream steps must tolerate this — pipeline definitions declare which steps are skip-tolerant). |
| **Talk** | Open a conversation with the session. See §7. |
| **Abort** | Mark job `FAILED`, mark plan `NEEDS_OPERATOR`. Hard stop. |

### 6.5 Channels

Phase 1: AttentionInbox in the admin UI (already partially built per `attention dock`).
Phase 2: optional email digest (configurable per user, default off).
Phase 3: webhook → Slack / Discord (one outbound message per attention item, with deeplink back to the inbox).

Push notifications via PWA (Phase 3+) for "the agent you're talking to has replied" — mobile case, not relevant for v1.

---

## 7. Talk-to-agent

### 7.1 The product

A chat panel attached to any **step** (failed or completed). User types; agent in that step's session responds. The session is the bearer of context — file tree, prior decisions, tool results, the works. The conversation is the *human-driven branch* off that session.

### 7.2 API surface

```
POST /api/jobs/:jobId/steps/:stepId/conversations
  body: { mode: 'fresh' | 'resume' | 'compact-resume' }
  response: { conversationId, sessionId, warmth, estimatedFirstTurnCost }

POST /api/conversations/:conversationId/messages
  body: { content }
  response: { messageId, jobId (party-turn-style backing job) }

GET /api/conversations/:conversationId/events
  (SSE stream of agent responses, similar to Party Mode events today)

POST /api/conversations/:conversationId/apply-output
  body: { extractWith: 'QA_REPORT' | 'PLAN_JSON' | ... }
  // re-runs an extractor against the conversation's last agent turn
  // and applies the result to the canonical job (advances wave, etc.)
```

### 7.3 Mode semantics

- **`fresh`** — new session, system prompt = "You previously failed step X for reason Y. Here's what you tried: [bullets from ESCALATE]. Here's the latest output you produced: [variables]. The human wants to discuss." Cheapest. Default.
- **`resume`** — `claude --resume <sessionId>`. Full continuity. Cost spike if cold (UI shows the estimate).
- **`compact-resume`** — runs a Sonnet compaction pass first, then resumes the compacted session. One-time cost, then cheap subsequent turns.

### 7.4 Session ↔ conversation lifecycle

A session can have multiple parallel conversations (different humans, different debug branches). The session itself is shared mutable state — turns from different conversations interleave. Default UI surfaces one conversation per (user, step) but allows opening additional ones.

When the human runs `apply-output`, the conversation's last turn is canonical: extractors run, the job's `variables` are updated, the wave advances. The conversation stays open after apply (for follow-ups) but is read-only with respect to the job state until reopened.

### 7.5 Generalization from `party-turn`

The existing `party-turn` pipeline already does 80% of this. To generalize:
- Drop the `/bmad-party-mode` prefix on first turn (the system prompt for non-party conversations comes from elsewhere)
- Lookup session by `(conversationId)` rather than by `(partyProjectsName, sessionId)` tuple
- Replace `partySessionsRepo.tryAcquireSessionLock` with a generic `conversationsRepo.tryAcquireConversationLock`
- Decouple the working directory: it comes from the *step's* job, not from a party-projects row

This is a substantial refactor (~3-5 days) but it deletes more code than it adds, because Party Mode becomes one consumer of the generic infrastructure rather than a parallel implementation.

### 7.6 What talk-to-agent isn't

- **Not a way to bypass the pipeline** — applied conversation outputs go through the same extractor + post-validator path as a normal step run.
- **Not a permanent override** — if the human re-runs the original step (via Retry), it spawns a new run; the conversation is parallel, not authoritative.
- **Not safe for high-cost work** — talking adds tokens. Show running cost in the UI; cap at a per-conversation ceiling (default $1, configurable).

---

## 8. Component sketch

### 8.1 New: `SessionPool`

In-process singleton on the daemon. Tracks active Claude sessions across all jobs. Issues admission tokens. Implements §4.2-4.5.

State:
```
{
  byClass: { interactive: Token[], critical: Token[], background: Token[] },
  queues: { interactive: Job[], critical: Job[], background: Job[] },
  recentRateLimits: { timestamp, accountId, reason }[],
  activeAccounts: { oauth: AccountState, apiKey: AccountState },
}
```

Persists nothing. On daemon restart, scans `agent-jobs` for `RUNNING` jobs and reconstructs the active set.

### 8.2 New: `SessionRegistry` (DDB)

Table `futurator-agent-sessions`:
- PK: `sessionId`
- GSI: `jobId-stepId-index`
- Fields: `claudeSessionId`, `accountId` (which account spawned it), `firstTurnAt`, `lastTurnAt`, `tokenCount`, `status` (`ACTIVE` | `IDLE` | `STALE` | `ARCHIVED`), `costUsd`, `cwd`, `agentKind` (`PM` | `DEV` | `QA` | …)

Populated on session start (from `system.init` event) and updated on every turn.

### 8.3 New: `Conversations` (DDB)

Table `futurator-agent-conversations`:
- PK: `conversationId`
- GSI: `sessionId-index`
- Fields: `sessionId`, `jobId`, `stepId`, `mode`, `openedBy` (userId), `openedAt`, `lastActivityAt`, `status` (`OPEN` | `APPLIED` | `CLOSED`), `messageCount`, `totalCostUsd`, `appliedToJobAt`

### 8.4 New: `AttentionInbox` (DDB, extends existing)

Table `futurator-attention-items` (likely already exists per Phase B work):
- PK: `attentionItemId`
- GSI: `planId-status-index`, `userId-status-index`
- Fields: per §6.2

### 8.5 Modified: `AgentJob`

Add fields:
- `status` enum gains `NEEDS_ATTENTION`
- `attentionItemIds: string[]`
- `salvageableExtractors: string[]` (set when extraction succeeded but step failed)
- `concurrencyClass: 'interactive' | 'critical' | 'background'`
- `accountUsed: 'oauth' | 'apikey'`

### 8.6 Modified: pipelines

Each pipeline step gains:
- `preconditions: PreflightCheck[]`
- `postValidate?: (vars) => boolean | { error: string }`
- `skipTolerant: boolean` (can downstream steps proceed if this is skipped)
- `concurrencyClass: 'interactive' | 'background'` (defaults to `background` for pipeline jobs)

Agent prompts (shared template) gain the §5.2 exit-signal block.

### 8.7 Modified: `party-turn` → `agent-turn`

Generalized per §7.5. `party-turn` becomes a thin wrapper that prepends `/bmad-party-mode` and routes through `agent-turn`.

### 8.8 New API routes

```
POST /api/jobs/:jobId/steps/:stepId/salvage       (§6.4 Salvage action)
POST /api/jobs/:jobId/steps/:stepId/retry         (§6.4 Retry action)
POST /api/jobs/:jobId/steps/:stepId/skip          (§6.4 Skip action)
POST /api/jobs/:jobId/steps/:stepId/conversations (§7.2)
POST /api/conversations/:conversationId/messages
GET  /api/conversations/:conversationId/events
POST /api/conversations/:conversationId/apply-output

GET  /api/attention                               (inbox list)
POST /api/attention/:itemId/resolve               (record resolution)
POST /api/attention/:itemId/reopen
```

### 8.9 New UI surfaces

- **Failed-step panel**: shows extractors fired, escalate payload (if any), action buttons (Salvage / Retry / Skip / Talk / Abort), live cost
- **Attention dock** (extend existing): grouped by plan, with badge count, sortable by age + recommendedAction
- **Conversation panel**: chat UI bound to a step, with session warmth indicator, mode toggle (fresh / resume / compact), live cost, "Apply this output" button when an extractor would match the last agent turn
- **Concurrency status bar**: small chip in the header showing "3/8 slots in use, 1 queued" so the user knows when they're saturating capacity

---

## 9. Schema changes summary

```diff
# DDB
+ futurator-agent-sessions
+ futurator-agent-conversations

# Existing
~ futurator-agent-jobs
  + status: NEEDS_ATTENTION
  + attentionItemIds: string[]
  + salvageableExtractors: string[]
  + concurrencyClass: enum
  + accountUsed: enum

~ futurator-attention-items
  (extend per §6.2 if not already shaped this way)
```

```diff
# TypeScript
~ AgentJob in functions/shared/types/agent-orchestrator.ts
~ PipelineStep in functions/shared/pipelines/*.ts
+ AgentSession, AgentConversation in functions/shared/types/agent-session.ts
+ AttentionItem (audit existing shape vs §6.2)
```

```diff
# Environment
+ ANTHROPIC_API_KEY (background-pool capacity, scoped to background jobs only)
+ MAX_CONCURRENT_INTERACTIVE (default 2)
+ MAX_CONCURRENT_BACKGROUND (default 4 when API key present, 0 otherwise)
+ MAX_CONCURRENT_CRITICAL (default 2)
+ DEFAULT_PER_JOB_COST_CEILING_USD (default 5)
+ DEFAULT_PER_PLAN_COST_CEILING_USD (default 50)
```

---

## 10. Phased rollout

Each phase ends with a deployable state and a measurable improvement. No phase blocks on a later phase.

### Phase 1 — Salvage & retry surface (3-5 days)
**Unblocks:** the dino3 incident, all future "agent succeeded but daemon stalled" cases.
- Add `NEEDS_ATTENTION` job status
- Universal `---ESCALATE---` / `---NEED-HUMAN---` extractors on every pipeline
- API: `POST /api/jobs/:jobId/steps/:stepId/{salvage,retry,skip}`
- UI: Failed-step panel with action buttons
- Loop detector (§5.3) — catches thrashing early
- Pre-flight validator framework (§5.4) — start with `folder-exists+writable` (would have caught the chown bug)

**Deliverable:** dino3 QA report applies in one click. Future EACCES-style failures self-diagnose.

### Phase 2 — Concurrency manager (5-7 days)
**Unblocks:** running 2+ apps + interactive sessions without 429s.
- `SessionPool` with typed slots (§4.2)
- API-key fallback for background jobs (§4.3.1)
- Event-driven retry on 429 (§4.5)
- Cost ceilings (per-job, per-plan, daily) — already wanted, not just a Phase 2 add
- Concurrency status chip in header (§8.9)

**Deliverable:** the daemon survives 2 concurrent apps + an interactive chat. 429 retries happen on slot-free, not blind backoff.

### Phase 3 — Talk-to-agent v1 (7-10 days)
**Unblocks:** conversational debugging, "ask the QA reviewer why."
- Decouple `party-turn` → `agent-turn` (§7.5)
- `SessionRegistry` + `Conversations` tables (§8.2-8.3)
- API + SSE per §7.2
- Conversation panel UI (§8.9)
- "Apply this output" bridge (§7.4)
- Default to `fresh + handoff` mode (§7.3)

**Deliverable:** click "Talk" on any failed step → chat with the agent → click "Apply" to re-run extractors against the conversation output.

### Phase 4 — Cache/context optimizations (3-5 days)
**Unblocks:** lower per-job cost, longer-lived sessions remain viable.
- Session warmth tracking + UI display
- Cache-warming for active conversations (§3.5)
- Auto-compaction at 80k tokens (§3.4 strategy C)
- Audit + dedupe agent prompt prefixes for cross-session caching (§3.6)

**Deliverable:** measurable 20-40% reduction in per-job cost on long-running plans.

### Phase 5 — Full self-correction loop (5-7 days)
**Unblocks:** fewer human escalations.
- Post-extractor validators with bounded re-prompt (§5.5)
- Pipeline preconditions library (§5.4) expanded — port-free, dependency-installed, dev-server-reachable
- "Forced escalation" telemetry to find under-validated steps

**Deliverable:** attention inbox volume drops as agents recover from more situations on their own.

### Phase 6 — Quality of service (3 days)
- Time-shifted batching (§4.3.3)
- Email digest for attention items (§6.5)
- Slack webhook for high-pri attention items

**Total:** ~5-7 weeks of focused work. Phase 1 is high-leverage and should ship within a week.

---

## 11. Risks & open questions

### Hard things this plan glosses over

- **API-key fallback prompts may diverge from Claude Code prompts.** Claude Code on the OAuth subscription has subtle differences (skill availability, default flags, MCP wiring). Background jobs running on raw API may need their own prompt template variants. Need to audit before shipping Phase 2.
- **Compaction is lossy.** A compacted session may "forget" the specific filename of a file it edited 30 turns ago. For long-running orchestrator-mode plans this is fine; for tight debugging sessions it's wrong. The mode toggle (fresh / resume / compact) puts the choice on the human — but the human needs guidance UI.
- **Pre-emption between steps requires graceful step boundaries.** A step that's mid-Bash-call can't be paused. In practice this means pre-emption only kicks in between pipeline steps, not within. Most steps are <60s, so the worst-case wait for an interactive promotion is bounded. Document this clearly.
- **Cost ceilings need teeth.** A "soft warning" ceiling that the agent can argue past is useless. Hard kill on ceiling = predictable but might abandon nearly-finished work. Compromise: at 80% of ceiling, daemon emits a system message to the agent ("you have $X left, finish or escalate"); at 100%, hard kill.

### Open questions for Ricardo

1. **API-key budget** — willing to spend metered API on background jobs? Rough cost estimate: a typical Dev step runs ~$0.50-2.00 today on the subscription; on metered API it's the same model so cost is identical, but billing changes from subscription to per-call.
2. **Default concurrency class for legacy jobs** — when Phase 2 ships, existing `RUNNING` jobs need a class assigned. Default to `background` (safest, lowest priority)?
3. **Talk-to-agent permission model** — should any logged-in admin user be able to open a conversation on any plan, or only the plan's `createdBy` user? Affects the `Conversations` table schema.
4. **Attention inbox shape** — assuming the existing `attention dock` work (Phase B per the recent commits) is the foundation; need to audit whether the existing schema covers §6.2 or needs extension. Worth a quick read of `docs/concepts/pipeline-enhancement-phases-a-c-handoff.md` before Phase 1 detailed design.
5. **Multi-account OAuth strategy** — if API-key fallback isn't enough, are we comfortable running multiple Claude Code accounts (operationally and per ToS)? Knowing the answer shapes Phase 2 vs a hypothetical Phase 2.5.

### Failure modes the plan explicitly accepts

- **Daemon crash mid-conversation** — conversations queue but their job (party-turn-style) survives in DDB; on restart, in-flight conversations are recoverable. New messages fail until daemon recovers (acceptable for v1).
- **Session goes stale during a long human pause** — conversation just costs more on next turn. UI shows the cost preview. Acceptable.
- **Two humans open conversations on the same session simultaneously** — turns interleave; can produce confusing transcripts. v1: single-conversation lock per session. v2: multi-tenancy with attribution.

---

## 12. Appendix — the dino3 incident, mapped to this plan

The exact failure walked through every gap this plan addresses:

| Step | What broke | Plan reference |
|---|---|---|
| QA agent emits perfect QA_REPORT | (worked) | — |
| Daemon makes follow-up call | 429 from Anthropic (concurrent with bmad party chat) | §4 — concurrency model would have queued this instead of failing |
| Retry 1, 2, 3 all 429 | Blind 30s/2m/8m backoff into same overload window | §4.5 — event-driven retry on slot-free |
| Step marked FAILED | No salvage path even though variables were extracted | §6.3 — `NEEDS_ATTENTION` instead of `FAILED` |
| User stares at error | No way to apply the report, no way to talk to the agent | §6.4 Salvage button + §7 Talk-to-agent |
| User considers re-running entire plan | Hours of Claude time wasted | All of the above |

If Phase 1 had shipped, the user clicks "Salvage" and the wave advances in 5 seconds. If Phase 2 had shipped, the 429 never happened in the first place (the QA closeout call would have queued behind the party chat instead of crashing). If Phase 3 had shipped, the user could have just *asked* the QA agent "what did you find" and gotten the report verbally without ever needing to click Salvage.

This plan exists so dino3 is the last time this happens.
