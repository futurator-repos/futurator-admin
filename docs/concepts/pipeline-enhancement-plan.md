# Pipeline Enhancement — Resilience, Attention, and Tier 1 Tests

> Brainstorm source document, 2026-04-22
> Follow-up to [labs-ui-hierarchies-and-workflows.md](./labs-ui-hierarchies-and-workflows.md)
> Implements [tier-1-test-infrastructure.md](./tier-1-test-infrastructure.md) + hardens against real failure modes observed this sprint

---

## 1. Why — the three problems we keep hitting

### 1.1 Infrastructure interrupts kill real work

**2026-04-21 15:31:02** — pacman plan, story `Implement level progression and game state screens`. DEV agent had written working renderer.js changes (restart button, splash screen). Daemon got `systemctl restart` (likely from a parallel dev session rsync-ing new daemon code). SIGTERM hit the Claude subprocess. Job → `FAILED`. Story → `failed`. Plan → `fixing`. Operator has to manually retry.

**Root cause:** daemon treats "I was restarted" as "the job failed". Claude was in the middle of useful work; the restart is infrastructure noise unrelated to the story.

Today the daemon does not distinguish between:
- The job legitimately failed (agent errored, timeout exceeded, validation failed)
- The daemon was yanked out from under a healthy job

Both end up as `FAILED` with generic `errorMessage`. That pushes recoverable situations into the "needs attention" pile and wastes agent time when the operator retries.

### 1.2 Unbounded shell = runaway process

**2026-04-21** — CPU pegged at 50% for **26 hours**. Cause: `grep -rn "at least 10 rows required" /` running since Apr 20. An agent (or a manual session) started a recursive grep from filesystem root and walked off into `/proc`, `/sys`, mount points. Nothing stopped it.

**Root cause:** shell steps have no time budget, no no-progress watchdog, no guard on path roots. An unbounded command can run forever.

We pay for this on:
- t2.micro with 2 vCPUs — one stuck process is 50% of capacity
- Memory pressure if the process is greppy / leaky
- Daemon slot starvation if the process was spawned inside a job
- Bill (if we ever move to metered EC2)

### 1.3 Agents drift from protocol silently

Collected cases from this sprint:

| Agent | Expected output | What happened |
|---|---|---|
| OPS (dev-server) | `DEV_SERVER_URL: http://…` | Emitted `**DEV_SERVER_URL:** http://…` (markdown bold) → regex didn't match → UI got no URL |
| OPS (dev-server) | Public IP | Emitted private `172.31.x.x` (IMDSv2 quirk) → URL useless externally |
| QA | Screenshots persisted | Wrote to `/tmp/vt-screenshots/` → ephemeral, UI invisible |
| PM | Clean JSON | Wrapped in `---PLAN_JSON---` fences that my extractor retained — the fences broke `JSON.parse` |

Each was a ~1 hour round trip to diagnose + patch. The common pattern: **agent output assumes a format, extractor regex is strict, when the agent decorates nothing is captured, UI shows empty state, operator has to dig.**

There's no "agent deviated from protocol" signal — we only notice when the UI is empty and the operator asks "why?".

### 1.4 Common thread

All three are variants of the same meta-problem: **the system is not transparent about what's actually happening, and has no mechanism to surface "this needs your attention".**

Tier 1 tests will *increase* the number of attention-worthy events (test_tampering, test_authoring_weak, auto-reverts, etc.) — so we can't ship Tier 1 without the attention layer first.

---

## 2. The three pillars of this enhancement

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   PILLAR 1 — Resilience       PILLAR 2 — Attention              │
│   ─────────────────────       ─────────────────────             │
│   Prevent preventable         Surface the unpreventable         │
│   failures before they        so operator can intervene         │
│   surface to the operator     with confidence                   │
│                                                                 │
│                    PILLAR 3 — Tier 1 Tests                      │
│                    ───────────────────────                      │
│                    Make "done" mean something.                  │
│                    Multiplies attention events,                 │
│                    which is why pillars 1 + 2 come first.       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Sequence: **1 → 2 → 3.** Testing scaffolding is the most impactful but also the most failure-prone; shipping it without resilience + attention would bury the operator in red dots with no tools to navigate them.

---

## 3. PILLAR 1 — Resilience

Goal: no more "the infrastructure blinked and we lost an hour of agent work".

### 3.1 Daemon graceful shutdown

**Today:** systemd sends SIGTERM → daemon exits → in-flight jobs marked FAILED.

**Proposed:**

```
SIGTERM received
  │
  ▼
Daemon enters "drain" mode:
  ├─ stop polling for new PENDING jobs
  ├─ for each active Claude subprocess:
  │   ├─ send it `--stop-gracefully` signal (or wait for current step's exit)
  │   ├─ on clean exit → mark current step step_complete, write event
  │   │                  leave job in RUNNING (or PENDING if no steps started)
  │   └─ if the subprocess doesn't stop in N seconds → SIGKILL it, mark
  │       job STALE (not FAILED) with reason 'daemon-shutdown'
  ├─ persist daemon heartbeat with `shuttingDown: true`
  └─ exit

On next daemon start:
  ├─ scan for jobs in STALE with reason 'daemon-shutdown'
  │   → reset to PENDING
  │   → enqueue from the last successful step (steps are idempotent in spirit;
  │     for shell steps this is trivial; for agent steps this means re-running
  │     the prompt, which is acceptable)
  └─ resume normal polling
```

Key distinction: **STALE (recoverable) vs FAILED (requires operator).** Operator only sees attention items for FAILED; STALE ones get auto-resumed.

**Tradeoff:** agent steps aren't truly idempotent — a second prompt may produce different output. Mitigations:
- For shell steps: fully idempotent, safe to replay
- For agent steps: replay from the *start of the step*, not the middle. The current step gets re-run from scratch. That's acceptable — it's the same as a manual retry today, just automatic.

**New job status:** `STALE` already exists. Formalize it. Add a `staleReason` field: `'daemon-shutdown' | 'no-heartbeat' | 'timeout'`.

### 3.2 Per-step watchdog (bounded execution)

Every step already has a `timeout` field. Today it's enforced at the step level. Add:

**No-progress watchdog** (new):
- Daemon tracks the last stdout byte or last tool-use event timestamp per active step
- If `now - lastActivity > 60s`, emit `step_stall_warning` event (UI shows ⚠)
- If `now - lastActivity > 180s`, force-kill the step with `step_timeout` event
- Configurable per step-type (agent steps get longer windows than shell)

**Shell path guard** (new):
- For shell steps, enforce that any `find`, `grep -r`, `rm -rf`, `npm` operation targets paths starting with `${workingDir}/` or `/tmp/` or `/home/ubuntu/.claude/` (transcript scope)
- Rejection happens at command-dispatch time, before the subprocess spawns
- Violations emit `step_refused` event with the offending command

### 3.3 Tool allowlist hardening

This already exists in Tier 1's §3. Call it out separately because it prevents whole classes of failure *before* they reach the watchdog:

- **DEV** can't touch `tests/` (closes the test-tamper vector)
- **DEV** can't `sed`/`mv`/`rm` (closes the rename-as-workaround vector)
- **DEV** can't `grep -r` from `/` (closes the CPU-eater vector)
- **REVIEWER** can't write at all (closes the review-then-fix-then-approve vector)

Claude Code's CLI supports `--allowedTools` with path scopes. We pass these through the daemon's spawn logic.

### 3.4 Idempotent plan creation

Client generates a UUID per form submission (`Idempotency-Key` header). Server stores `{key → planId}` for 15 min. Second POST with the same key returns the first plan. Prevents the double-click scenario we hit on 2026-04-21.

Also enforces **workingDir uniqueness** at the API layer: if a non-archived plan already owns the folder, return 409 + the existing `planId`. UI surfaces "An active plan already targets this folder — open it?".

### 3.5 Summary of Pillar 1 additions

| # | Change | Prevents |
|---|---|---|
| 1 | Daemon drain on SIGTERM | Pacman-story-FAILED-on-restart case |
| 2 | STALE vs FAILED distinction + auto-resume | Same |
| 3 | No-progress watchdog | QA-stuck-forever, daemon hangs |
| 4 | Shell path guard | Runaway grep / rm -rf gun |
| 5 | Tool allowlists | Agent drift, test tampering |
| 6 | Idempotency + workingDir lock | Duplicate-plan-from-double-click |

---

## 4. PILLAR 2 — Attention Inbox

Goal: operator has ONE surface that aggregates every "this needs you" signal across all plans, with clear recommended actions.

Today the operator has to:
- Remember which plans they launched
- Poll each plan's status
- Drill into specific stories to see why they're red
- Figure out what action to take

That doesn't scale past 1-2 plans. With Tier 1 introducing many more attention-worthy events, it breaks.

### 4.1 The central abstraction — AttentionItem

```typescript
type AttentionItem = {
  id: string;
  createdAt: string;
  planId: string;
  epicId?: string;
  storyId?: string;
  jobId?: string;

  severity: 'info' | 'warning' | 'error' | 'action-required';
  category: AttentionCategory;
  title: string;           // "Story failed: review_rejected"
  description: string;     // 1-2 lines, human-readable
  suggestedActions: AttentionAction[];

  status: 'open' | 'snoozed' | 'dismissed' | 'resolved';
  snoozeUntil?: string;
  resolvedBy?: string;     // "operator" | "system" | "retry"
  resolvedAt?: string;
};

type AttentionCategory =
  | 'story-failed'                 // DEV can't implement
  | 'story-blocked'                // test_tampering, test_authoring_weak
  | 'story-review-rejected'
  | 'plan-fixing'                  // any component failed
  | 'plan-build-check-failed'
  | 'job-stalled'                  // >180s no heartbeat
  | 'job-stale-recovered'          // info: auto-resumed after daemon restart
  | 'agent-drift'                  // extractor returned empty; agent output didn't match protocol
  | 'budget-warning'               // plan approaching $X cap
  | 'daemon-unhealthy'             // heartbeat stale, slots saturated, etc.
  | 'deploy-pending-approval'      // production-rigor waiting for human
  | 'visual-qa-result-needs-review';

type AttentionAction = {
  label: string;                   // "Retry story", "Bump model", "Amend story", "Dismiss"
  kind: 'retry' | 'amend' | 'bump-model' | 'skip' | 'dismiss' | 'snooze' | 'navigate';
  payload?: unknown;               // endpoint-specific
};
```

Every attention-worthy event writes an AttentionItem to a new DDB table. The attention system is sources-of-truth-agnostic — it doesn't know about cron reducers or daemon internals, it just knows what humans need to do.

### 4.2 Sources of AttentionItems

| Source | When it writes | Severity |
|---|---|---|
| Wave-completion cron | Any epic → `fixing` | error |
| Wave-completion cron | Any plan → `fixing` | error |
| Wave-completion cron | plan-build-check FAILED | error |
| Daemon | Job → FAILED (not daemon-shutdown) | error |
| Daemon | Job step no-progress >60s | warning |
| Daemon | Job step killed by watchdog | error |
| Daemon | Shell path guard rejected a command | warning |
| Daemon | Successful daemon-shutdown auto-recovery | info |
| Daemon | Extractor matched nothing for a required variable | warning |
| Plan reducer | plan → review (ready for visual QA / approval) | action-required |
| Plan reducer | plan → delivered | info |
| Tamper-check step (Tier 1) | Tests modified | warning / error (2nd offense) |
| Test-gate-red | Retry budget exhausted | error |
| REVIEWER agent | Missing AC coverage | warning |
| Cost tracker | Plan passes 80% of budget | warning |
| Cost tracker | Plan exceeds budget | error |
| EC2 health cron | Daemon heartbeat stale >5m | error |
| EC2 health cron | Slots saturated >10m with queued work | warning |

Each source writes idempotently — same (planId, category, referenceId) → one item, not duplicates.

### 4.3 UI surface — the Attention Tray

**Location:** a badge in the top nav (always visible, across all screens), like a notification bell. Clicking opens a slide-in tray.

```
┌───────────────────────── ATTENTION (6) ─────────────────────┐
│                                                              │
│ Filter: [ Needs action ] [ Warnings ] [ Info ] [ Resolved ]  │
│                                                              │
│ ● pong / Epic E4 story S2 — review_rejected                  │
│   "REVIEWER failed: paddle speed not responsive"       3m    │
│   [ Bump model to Sonnet + retry ] [ Amend story ] [ ⋮ ]     │
│                                                              │
│ ● pacman-simple / plan-build-check — FAILED                  │
│   "npm run build: 3 TS errors in App.tsx integration"  12m   │
│   [ Retry build-check ] [ Edit plan ] [ Open workflow ]      │
│                                                              │
│ ⚠ portfolio / story S3 — job stalled 2m                      │
│   "No heartbeat in 2m 14s. Step qa-start-server."      now   │
│   [ Investigate logs ] [ Kill + retry ] [ Snooze 5m ]        │
│                                                              │
│ ⓘ pong — plan ready for review                               │
│   "All epics done + plan-build-check passed."          1h    │
│   [ Run Visual QA ] [ Publish ] [ Dismiss ]                  │
│                                                              │
│ ────────────────────────────────────────────────────────    │
│ 🔕 2 snoozed · 23 resolved today                            │
└──────────────────────────────────────────────────────────────┘
```

### 4.4 Per-plan attention strip

Inside a plan's detail page, show a compact attention strip at the top with only that plan's open items. Redundant with the tray but contextual — operator doesn't have to context-switch.

### 4.5 Real-time feel

Use long-poll or SSE (whichever fits the Lambda model) to push new attention items to the browser. With no open plans, polling interval could be 30s; when active plans exist, 5s.

Badge in top nav shows count of `action-required` items only. Warnings/info are in the tray but don't ping.

### 4.6 "Suggested action" logic

The attention item itself knows which actions make sense. Examples:

| Category | Default action | Context where it appears |
|---|---|---|
| story-failed (implementation_incomplete) | Bump model + retry | DEV iterated N times, can't solve with current model |
| story-failed (review_rejected) | Amend story OR Bump REVIEWER model | REVIEWER rejects; maybe AC is ambiguous |
| story-blocked (test_authoring_weak) | Amend story | TEST can't write red tests → AC is fuzzy |
| story-blocked (test_tampering 2nd) | Retry fresh (wipe state) | DEV got rattled |
| job-stalled | Investigate logs → then Kill + retry | Needs diagnosis first |
| plan-build-check-failed | Retry build-check OR Amend epic deps | Often a missing export |
| deploy-pending-approval | Publish | Literal one-click action |

"Suggested" doesn't mean automatic — operator still clicks.

### 4.7 Snooze + dismiss

- **Snooze** — hide for N minutes/hours. For acknowledgement-only items.
- **Dismiss** — resolve without action. System tracks dismissals to improve signal-to-noise (an item dismissed 3x in 24h should probably lower severity or stop firing).
- **Resolve** — system auto-resolves when the underlying state changes (e.g., job completes, plan leaves fixing state).

### 4.8 Event-agent-operator trace

Every AttentionItem links back to the chain that produced it:

```
AttentionItem (story-failed)
   └─ Job (FAILED, errorMessage)
       └─ Step (step_failed event)
           └─ Previous step_stdout / step_progress events
               └─ Agent model, tool_use events, tokens consumed
```

Clicking the item opens the log viewer at the relevant step, pre-filtered. The operator goes from "something's wrong" to "I see what happened" to "here's what to do" in three clicks.

---

## 5. PILLAR 3 — Tier 1 Tests (from the doc, contextualized)

Tier 1 is specified in full in [tier-1-test-infrastructure.md](./tier-1-test-infrastructure.md). This section covers how it lands *on top of* Pillars 1 + 2.

### 5.1 Tier 1 increases attention surface area

New AttentionItem categories from Tier 1:

- `tier1-test-authoring-weak` — TEST agent wrote tests that pass pre-implementation
- `tier1-implementation-incomplete` — DEV can't make red tests go green
- `tier1-test-tampering-warn` (1st offense) — auto-revert + warn
- `tier1-test-tampering-block` (2nd offense) — operator must decide
- `tier1-review-rejected-coverage` — REVIEWER says AC lacks tests
- `tier1-flaky-test-detected` (deferred to Tier 2)

Each lands in the Attention Tray with the right default action per §4.6.

### 5.2 Tier 1 needs Pillar 1's watchdog

The test-gate-red and test-verify steps are shell steps that run `npm test`. If `npm test` hangs (flaky infra, stuck watcher), the step hangs. Pillar 1's no-progress watchdog bounds this.

### 5.3 Tier 1 needs Pillar 1's tool allowlist

The whole anti-tampering story depends on DEV literally being unable to touch `tests/`. That's Pillar 1 §3.3.

### 5.4 Tier 1 events need Pillar 2 to surface

Without the Attention Inbox, a `test_tampering` flag is a database row nobody sees. With it, it's a yellow item that says "DEV tried to modify tests — auto-reverted. One more strike will block this story." + a button to open the diff.

### 5.5 Rigor dial interacts with Pillars 1 + 2

`prototype` rigor skips the TEST agent entirely. The attention inbox filters out Tier-1-only events for prototype plans. No false alarms.

`production` rigor adds one more attention category: `deploy-requires-manual-signoff` — plan reaches review, waits for operator to click Publish. Replaces auto-deploy.

### 5.6 Plan-level `rigor` field

One new field on Plan: `rigor: 'prototype' | 'mvp' | 'production'`, default `mvp`. UI selector at plan creation. Backfills existing plans to `mvp` on migration.

---

## 6. Cross-cutting — schema + event changes

### 6.1 New DDB table: `futurator-attention-items`

| Field | Type |
|---|---|
| `itemId` (PK) | string (UUID) |
| `planId` (GSI1 PK) | string |
| `category` | enum |
| `severity` | enum |
| `status` | `open | snoozed | dismissed | resolved` |
| `createdAt` (GSI1 SK) | ISO |
| `updatedAt` | ISO |
| `title`, `description`, `suggestedActions[]`, `resolveBy`, `snoozeUntil` | see §4.1 |

TTL on `resolvedAt + 30d` to auto-purge resolved history.

### 6.2 New events

Add to existing `futurator-agent-events`:

| Event | Emitted when |
|---|---|
| `step_progress` | Daemon heartbeat while step alive (every 10s) |
| `step_stall_warning` | No-progress >60s |
| `step_output` | Shell stdout chunks (4KB or 1s) |
| `step_refused` | Shell path guard rejected a command |
| `agent_drift` | Extractor matched nothing for a declared variable |
| `tamper_detected` | Tier 1 tamper-check fired |
| `test_auto_reverted` | Tier 1 auto-revert completed |

### 6.3 New plan/story/job statuses (or reasons)

- Job: introduce explicit `STALE` with `staleReason: 'daemon-shutdown' | 'no-heartbeat' | 'timeout'`
- Story: add `failure.reason: 'implementation_incomplete' | 'review_rejected' | 'test_authoring_weak' | 'test_tampering'`
- Plan: add `rigor: 'prototype' | 'mvp' | 'production'`

### 6.4 New cron: `attention-gc`

Daily. Auto-resolves stale items whose underlying state has moved on (e.g., story now done → close the `story-failed` item that referenced it). Removes snoozed items past their snoozeUntil.

---

## 7. Phased rollout

### Phase A — Pillar 1 Resilience core (≈3 days)

1. Daemon drain on SIGTERM + STALE status + auto-resume on next boot. **Day 1.**
2. No-progress watchdog at step level. **Day 2 morning.**
3. Shell path guard. **Day 2 afternoon.**
4. Idempotency key + workingDir lock on `POST /api/plans`. **Day 3 morning.**
5. Smoke test: pong plan, restart daemon mid-story, verify resumption. **Day 3 afternoon.**

No new UI. Users see fewer spurious failures.

### Phase B — Attention Inbox (≈4 days)

1. DDB table + AttentionItem type + API endpoints (list, dismiss, snooze, resolve). **Day 1.**
2. Emit from cron reducers + daemon for existing failure modes. **Day 2.**
3. UI: tray component + top-nav badge + per-plan strip. **Days 3-4.**
4. Polling / SSE wire-up. **End of day 4.**

Now the operator has one place to go. Existing plans benefit immediately.

### Phase C — Tier 1 Tests (≈2 days, matches the doc's estimate)

Follows the Tier 1 doc §10 sequence exactly, modified to:

1. TEST agent defined in registry. **Day 1 AM.**
2. Tool allowlists enforced (depends on Phase A §3.3). **Day 1 AM.**
3. New step types in pipeline builder. **Day 1 PM.**
4. Red-green-tamper cycle. **Day 2 AM.**
5. Rigor dial (Plan field + UI). **Day 2 AM.**
6. End-to-end tests at all three rigors. **Day 2 PM.**
7. Emit Tier 1 attention items (depends on Phase B). **Day 2 PM.**

### Phase D — Hardening iteration (≈2 days)

1. Agent-drift detection (extractor-matched-nothing events) + surfacing. **Day 1.**
2. Live log viewer wire-up (step_progress + step_output events). **Day 1-2.**
3. Budget tracking + attention items. **Day 2.**
4. Snooze + dismiss heuristics (auto-lower noisy items). **Day 2.**

Total: ~11 working days. Not sequential on the team side — UI/API split possible.

---

## 8. Open questions for the session

### On resilience

1. **Graceful shutdown window**: how many seconds do we give a Claude subprocess to finish its current step before SIGKILL on daemon restart? 30s? 60s? Different for shell vs agent steps?
2. **Auto-resume policy**: re-run from the beginning of the interrupted step, or require operator approval before re-running? My default: auto-resume for shell steps (idempotent), prompt for agent steps (may cost $).
3. **Shell path guard**: do we need per-tool path scopes (allow `grep` under workingDir, disallow anywhere else), or is the generic `commands touching paths outside allowed roots are refused` guard enough?

### On attention

4. **Where does the tray live**: top nav bell icon (compact), dedicated `/labs/attention` page (full screen), or both?
5. **Which events are `action-required` vs `warning`**: gut says `story-blocked` + `plan-fixing` + `deploy-pending-approval` are action-required; everything else is warning or info. Push back welcome.
6. **Auto-dismiss**: when should items auto-resolve without operator input? E.g., a `job-stalled` that later completes successfully — dismiss or keep as "resolved" for history?
7. **Notification outside the UI**: Slack / email / desktop push for `action-required` items? Or just in-app?
8. **Multi-plan triage**: when 5 plans are active + all have attention items, how does the operator prioritize? Auto-sort by severity + recency, or let operator pin their current focus plan?

### On Tier 1

9. **Rigor default**: my vote is `mvp` for new plans. Alternatives: `prototype` (faster onboarding), `production` (safer). Default should match the most common real use case.
10. **TEST agent model**: doc says Haiku. I lean Sonnet for the AC-to-test translation — Haiku has fumbled prompt protocols this sprint. Test it both ways.
11. **Tamper two-strike**: doc proposes auto-revert on 1st, block on 2nd. Operator toggle to make 1st an immediate block (stricter) for `production` rigor?
12. **Browser-test AC coverage**: Playwright tests are slow (~30s+ each). Do we run them in `test-gate-red` + `test-verify` inline, or only at wave-build time?

### On cross-cutting

13. **Shared ownership**: the daemon emits events + writes jobs; now it also writes attention items? Or does a cron reducer materialize attention items from events? Latter is cleaner but slower (up to 60s lag); former is faster but daemon grows more responsibilities.
14. **Budget enforcement**: if a plan exceeds budget, do we auto-archive, auto-pause, or just warn loudly?
15. **Prototype rigor deploy target**: the doc says `preview.futurator.ai/<name>/`. Do we actually want a separate subdomain or use the main `apps/` path with rigor visible in the UI?

### On UI surfaces (the concurrent effort)

16. **Where does the live log viewer go**: inline drawer when clicking a story, a dedicated panel on the Plan detail, or a full-screen "Labs terminal" view?
17. **Tray placement**: persistent right-side dock (always visible when open), or slide-in from top? The former is better for multi-plan triage; the latter is more modal.
18. **Attention item lifecycle in the UI**: when operator takes a suggested action, does the item go to "resolving" (optimistic) immediately, or stay `open` until the system confirms?

---

## 9. Reference

- [tier-1-test-infrastructure.md](./tier-1-test-infrastructure.md) — source for Pillar 3
- [labs-ui-hierarchies-and-workflows.md](./labs-ui-hierarchies-and-workflows.md) — hierarchy + status catalog, feeds Pillar 2 design
- [agentic-pipeline-forensic-report.md](./agentic-pipeline-forensic-report.md) — measured agent behavior on Chrome-Dino, informs watchdog thresholds
- Epic 16 (orchestration recovery) — established the step-based model these enhancements extend
- Epic 17 (plan-based labs) — established the Plan → Epic → Story model these enhancements target

---

## 10. Stretch goals (brainstorm, not commit)

- **Replay step N** — operator clicks a step in the log viewer, re-runs just that step. Useful when a compile-knowledge step fails but DEV's work is done.
- **Ask a question** — DEV agent can emit a `agent_question` event. Story pauses; attention item surfaces; operator answers; agent resumes. Turns blocks into conversations.
- **Persistent agent scratchpad** — each story has a rolling `scratch.md` the agent can read/write across retries. Preserves context across restarts.
- **Model escalation policy** — after N retries at Haiku, auto-bump to Sonnet without asking (configurable per rigor).
- **Attention feed subscription** — operator can opt into Slack pings for specific plans, not others.
- **"Confidence" score per story** — derived from number of retries, final tokens, REVIEWER strictness. Low confidence → extra Visual QA required, even at MVP rigor.

1: 30 segs
2: your recommendation
3: Generic path guard
4: both
5: yes, your gut
6: keep resolved for history, we might need to track afterwards for improving pipeline
7: just in app, lets keep mvp simple
8: Auto-sort by severity + recency
9: IMPORTANT: lets create for now a drop down before starting development with options (prototype, mvp, production)... we will change this later, but for now lets keep it, and affect whatever you are considering. Add a small explanation <small> under each option
10: leave test agent with sonnet as default, remember to include it in the select if i want to change to other model (eg haiku)
11: allow auto-revert and let agents correct.
12: Make playwright test be toggled from beggining, so i can see how they behave and affect (after selecting the development type, see question 9.)
13: daemon also writes attention, lets see what happens
14: we are prototyping, so write loud warning
15: lets keep it simple now, the same route, we are prototyping and we cna come back to this later
16: Check the new stories UI, the logs definitely should go there from each agents... create another tab called "logs" for full logs now, this will help me catch problems too and explore pipeline by pasting it to you, add a copy to clipboard button.
17: right side dock
18: switch to resolving.
