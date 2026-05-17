# Futurator-Admin — Epic: Free Claude Code Agent (Pipeline v2 enhancement)

**Date:** 2026-05-17
**Project Level:** 2 (Multi-story feature, 6 stories v1, ~22 story points; sibling Epic 19 deferred)
**Tech-Spec:** None (drafted directly from party-mode debate 2026-05-17; design rationale captured inline)
**Epic Number:** 18 (continues sequential Labs/Pipeline numbering: 15-party, 16-recovery, 17-plan-based-labs)
**Source debate:** Party-mode session "exploration-free-mode" (2026-05-17) — Rick, Ludwig, Sean, Maya, Sally, Sue, Murat, Winston, paige, John, Bob, Amelia, Pedrock contributed.

---

## Epic 18: Free Claude Code Agent (v1)

**Slug:** `free-agent`

### Goal

Give Richie a personal, on-demand Claude Code agent that he can summon from any page of the Futurator-Admin app via a floating chat widget. The agent has full Claude Code tool access (Read/Write/Edit/Bash/Grep/etc.) but operates **outside** the pipeline's correctness gates — it can investigate stuck plans, run forensics, fix-restart broken jobs, write throwaway diagnostic code, and produce investigation documents that help debug pipeline failures. The agent is **operator-initiated only** (no auto-spawn); it summons into either project-scope or plan-scope context depending on where the operator opens the widget; and it runs under tight security and cost guardrails so a runaway session cannot damage shared infrastructure or burn unbounded credits.

The acute problem this solves: the recent `plan_dino-7_mp8t4wak` forensic took ~3 hours of manual `aws dynamodb scan`, `git log`, and EC2-shell work to discover that a stale wave-completion Lambda was emitting the wrong pipeline shape for 11 of 13 stories. A free-agent session scoped to that plan, with read access to DDB + S3 + the project worktree, would have surfaced the same finding in minutes.

### Scope

**In Scope (Epic 18, v1):**

- Floating Action Button (FAB) widget mounted globally; expands into a bottom-right chat panel (~400×600px) that coexists with the dashboard (not modal).
- **Context-aware on open**: widget opens with `project` or `plan` scope based on the route at open-time. Header label shows the current lens (e.g., `Assistant — Plan: dino-7`).
- Per-session AWS IAM role assumed via STS with session tags `${project}` and `${sessionId}`; 1h native session expiry; re-AssumeRole on operator activity. Read-scoped policy with explicit-deny on destructive actions (full policy in Story 18.1).
- Path-confined worktree isolation: each session runs in `/home/ubuntu/free-agent-worktrees/<project>/<sessionId>/` via daemon-managed `git worktree`. Never shares the pipeline's worktrees or branches.
- Daemon-spawned `claude -p` subprocess as the agent runtime (reuses the existing `agent-daemon.mjs` Claude CLI invocation pattern); new `jobType: 'free-agent-session'` in the job router.
- SSE streaming on `POST /api/free-agent/sessions/:id/stream` from Lambda ↔ daemon ↔ widget for live token output.
- Manual model selector in the widget header: three labeled options (Haiku / Sonnet / Opus) — default Sonnet 4.6, last-used-sticky per operator. Per-session cost cap (`--max-budget-usd`, default $10, operator-adjustable from the panel header). Live cost-burn displayed.
- Conversation persistence in a new `futurator-free-agent-conversations` DDB table (90-day TTL); thread list accessible via a hamburger menu in the panel header. Per `[[dynamodb-multi-table-preference]]` memory, one table per concern.
- Audit trail: every commit the agent makes carries an `Agent: FREE-AGENT-<sessionId>` trailer (matching the `Agent: REVIEWER-*` / `Agent: DEV-*` pattern already used by pipeline agents); CloudTrail filter rule for the per-session role; DDB session record with `operatorId`, `scope`, `tokensIn`, `tokensOut`, `costUsd`.
- Branch namespace `assist/<project>/<sessionId>` for any commits the agent produces; daemon GC reaps abandoned worktrees on a daily cron.

**Out of Scope (Epic 18 v1, deferred to v1.1 or later):**

- **Motion polish** (breathing pulse, open/close spring animations, reduced-motion fallback — Sue Render's full spec). v1 ships a static FAB; visual feel deferred to follow-up story.
- **Reactive triggers / breathing-pulse signal** for "the plan has new attention items the agent could help with." v1 is purely operator-initiated; widget is always quiet unless opened.
- **Layer C (per-session AWS write credentials).** v1 agent role is read-scoped + own-conversation writes only. If the operator needs the agent to do AWS writes (Lambda updates, S3 puts outside knowledge-live), they run those commands in their own terminal.
- **Reactive auto-spawn on pipeline failures.** Killed in party-mode (round 2); revisited if usage demand emerges.

**Out of Scope (Epic 19 — separate sibling epic, deferred to v2):**

- New `kind: exploration` plan type + new `rigor: exploration` tier on the existing rigor matrix.
- REFLECTOR-FINDINGS mode generating `.findings/findings.md` + manifest deltas at exploration-plan close.
- `findings-validator` step (Murat's cheap Haiku call for findings-doc well-formedness).
- `informed-by:` field on subsequent plans + `Carried-Forward-From:` commit trailer.
- Mirror of findings docs to `docs/findings/<plan-slug>.md` on main.
- Source: `~/Downloads/futurator-pipeline-exploration-rigor-addendum.md` is the design baseline; Epic 19 will reference it as the spec.

### Success Criteria

1. Operator can click the FAB on any page; widget opens within 440ms; panel header correctly reflects current scope (`Project: <id>` vs `Plan: <id>`).
2. Operator can send a message; agent's first token streams within 5 seconds; full responses stream progressively without buffering at the Lambda.
3. Agent has read access to DDB (plans, jobs, attention-items, conversations), S3 (knowledge-live prefix for the current project), and the project repo via git; can call all Claude Code native tools (Read, Grep, Glob, Bash, Edit, Write) within its path-confined worktree; explicit-deny block prevents `iam:*`, `lambda:UpdateFunctionCode`, `secretsmanager:*`.
4. Each session runs under its own STS-issued credentials with session tags `${project}` and `${sessionId}`; credentials expire after 1h; re-AssumeRole fires automatically when the operator sends a new message in an expired session.
5. Worktree path-confinement is enforced by daemon-side `cwd` setting plus a settings.json hook in the worktree that rejects `Bash` invocations escaping the worktree root.
6. Conversation persists across browser refreshes; operator can list prior conversations for the current scope via the panel-header hamburger; resuming a thread re-spawns the same model.
7. Cost cap is enforced by the `--max-budget-usd` flag on the `claude -p` subprocess; live cost burn ($X.XX / $Y.YY) appears in the panel header and updates each turn; on cap hit, the panel shows a "Budget exhausted — raise cap or end session" callout.
8. Every commit the agent produces ends up on a branch matching `assist/<project>/<sessionId>` (never on `main`, `wip/`, or `experiment/`); commit trailers include `Agent: FREE-AGENT-<sessionId>`.
9. No regression in any existing Labs feature (Party, Plan dashboard, Project Hub still function identically).
10. `npm run ci` passes end-to-end (lint zero warnings, typecheck, test, build).

### Dependencies

**External / operational:**

- AWS account already configured (existing futurator-admin SST stack).
- EC2 daemon (`agent-daemon.mjs`) already polling DDB for jobs — same dispatch shape as Party.
- Claude CLI (`claude`) already installed on EC2 with OAuth credentials (`/home/ubuntu/.claude/.credentials.json`); already verified by daemon startup health-check.
- Identity Broker + JWT auth unchanged; existing `auth-middleware.ts` gates all new routes.

**Internal:**

- Reuses existing patterns from Epic 15 (Party): `claude -p` subprocess spawn from daemon, NDJSON event forwarder, job-router dispatch, repository pattern.
- Reuses `futurator-agent-jobs` and `futurator-agent-events` DDB tables for job dispatch + event streaming.
- Reuses `Ec2Toggle` component (free agent requires EC2 mode active; gracefully degrades to "Switch to EC2 to use the agent" when in local mode).
- Reuses `api-client.ts` token-refresh pattern; new SSE handling is additive.

**No forward dependencies between stories** — each story leaves the system in a working state. 18.1–18.3 are architectural (no UI); 18.4–18.6 are progressively user-visible.

---

## Story Map — Epic 18

```
Epic 18: Free Claude Code Agent (v1)
├── Story 18.1: Per-session IAM role + path-confined worktree (5 pts)
│   Dependencies: None (foundational architecture)
│   Delivers: STS role template + worktree isolation pattern; verifiable via AWS CLI + filesystem
│
├── Story 18.2: Session lifecycle (spawn / TTL / cost-cap / reap) (3 pts)
│   Dependencies: Story 18.1 (needs worktree + role)
│   Delivers: Daemon-side `free-agent-session` job handler; full lifecycle without UI
│
├── Story 18.3: Audit trail (commit trailer + CloudTrail + DDB session record) (3 pts)
│   Dependencies: Story 18.2 (needs sessions to record)
│   Delivers: Provenance + observability layer; verifiable via DDB + CloudTrail queries
│
├── Story 18.4: Widget shell (FAB + panel + lens header) (3 pts)
│   Dependencies: None — pure UI story, mockable backend
│   Delivers: User-visible widget; toggles open/close; shows lens; no agent yet
│
├── Story 18.5: Widget ↔ session wire-up (SSE streaming + model selector) (5 pts)
│   Dependencies: Stories 18.2, 18.3, 18.4 (needs runtime + audit + UI)
│   Delivers: End-to-end working agent in the widget
│
└── Story 18.6: Conversation persistence + thread list (3 pts)
    Dependencies: Story 18.5 (needs working sessions to persist)
    Delivers: New DDB table + hamburger thread list + resume

Deferred to v1.1 (will be promoted from below or split into Epic 18.1 follow-up):
├── Story 18.7: Motion polish (breathing pulse, open/close springs, reduced-motion) (2 pts)
└── Story 18.8: Pulse trigger semantics (which attention items pulse the FAB) (3 pts)
```

**Total Story Points (v1):** 22
**Estimated Timeline:** ~2–3 sprints (10–15 working days depending on testing depth and SSE plumbing complexity).

---

## Stories — Epic 18

### Story 18.1: Per-session IAM role + path-confined worktree

As **Richie (operator)**,
I want **each free-agent session to run under its own short-lived AWS IAM credentials inside a path-confined git worktree**,
so that **a runaway or compromised session cannot damage shared infrastructure or escape its project's scope, even though the agent has full Claude Code tool access**.

**Acceptance Criteria:**

- **AC #1** — A new SST-managed IAM role `FreeAgentSessionRole` is provisioned (via `sst.config.ts`) with a trust policy allowing STS AssumeRole _only_ from the futurator-admin API Lambda's execution role. The role's permissions policy implements the read-scoped + explicit-deny pattern: `s3:GetObject`/`s3:ListBucket` confined to `s3://futurator-ai-website/knowledge-live/${project}/*` (resource condition on `s3:prefix`); `dynamodb:GetItem`/`Query`/`Scan` on `futurator-agent-jobs` (+ GSIs), `futurator-attention-items`, `futurator-plans`, `futurator-free-agent-conversations`; `dynamodb:PutItem`/`UpdateItem` on `futurator-free-agent-conversations` with `dynamodb:LeadingKeys` condition restricted to `${sessionId}`; an explicit `Deny` block on `iam:*`, `lambda:UpdateFunctionCode`, `lambda:DeleteFunction`, `secretsmanager:GetSecretValue`, `secretsmanager:PutSecretValue`, `s3:DeleteObject`, `s3:PutBucketPolicy`, `dynamodb:DeleteTable`, `dynamodb:UpdateTable`.
- **AC #2** — `${project}` and `${sessionId}` in the policy resolve via STS session tags. `POST /api/free-agent/sessions` (introduced in Story 18.5; AC #2 here covers the AssumeRole code path only) constructs the AssumeRole call with `Tags: [{Key:'project', Value:projectId},{Key:'sessionId', Value:sessionId}]` and `DurationSeconds: 3600`. Returned credentials (AccessKeyId, SecretAccessKey, SessionToken, Expiration) are streamed to the daemon over the existing job-dispatch payload — never logged, never written to event payloads, never persisted in DDB.
- **AC #3** — Re-AssumeRole on activity: when the operator sends a message in a session whose credentials are <5 minutes from expiry or already expired, the API Lambda re-runs AssumeRole with the same session tags and replaces the credentials in the daemon's in-memory session state. The Claude CLI subprocess does not need to be killed — daemon writes refreshed credentials into the subprocess's env via `process.env` patching before spawning the next turn, OR rotates them via a credential file the CLI re-reads.
- **AC #4** — Path-confined worktree: each session gets a worktree at `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/` created via `git worktree add -b assist/<projectId>/<sessionId> <path> origin/main` (or the project's default branch). The worktree is created lazily on first message in the session. A new helper `daemon/pipelines/lib/free-agent-worktree.mjs` owns the create / `cwd` / reap lifecycle.
- **AC #5** — Worktree path-confinement is enforced by writing `.claude/settings.json` into the worktree on create, with a PreToolUse hook that rejects `Bash` invocations whose `cwd` (or detected target) escapes `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/`. The hook implementation lives at `daemon/pipelines/lib/free-agent-path-hook.mjs`; the settings file is templated and written atomically per session.
- **AC #6** — Daemon GC: a new cron Lambda `daemon-free-agent-gc` (or extension of an existing cron) runs daily at 03:00 UTC and reaps worktrees older than 7 days with no recent activity. Reaping: `git worktree remove --force <path>`, `git branch -D assist/<projectId>/<sessionId>`. GC is no-op if the session record in DDB shows `status='ACTIVE'` within the last 7 days.
- **AC #7** — Idempotent worktree creation: if `free-agent-worktree.mjs` is called for a session whose worktree already exists, it returns the existing path without re-cloning or erroring. If the path exists on disk but no corresponding session record exists in DDB, the path is treated as orphaned and removed.
- **AC #8** — Unit tests (`functions/shared/__tests__/free-agent-iam.test.ts`, `daemon/pipelines/__tests__/free-agent-worktree.test.mjs`): cover (a) AssumeRole call shape with correct session tags and 3600s duration, (b) re-AssumeRole triggered when expiry < 5min, (c) worktree create on fresh session, (d) worktree create idempotent on existing session, (e) GC reaping a 7+ day idle worktree, (f) GC NOT reaping a recently-active session, (g) PreToolUse hook rejecting an escape attempt, (h) PreToolUse hook allowing in-scope `Bash`.
- **AC #9** — Manual verification on EC2 dev: provision the role via `sst deploy`; manually call AssumeRole from the API Lambda console; verify returned credentials are scoped (try `aws iam list-users` → AccessDenied, `aws dynamodb get-item futurator-attention-items` → success, `aws lambda update-function-code` → AccessDenied); create a worktree manually via the helper; verify `cd /tmp && ls` from inside the worktree fails the hook.
- **AC #10** — `npm run ci` passes end-to-end (lint zero warnings, typecheck, test, build).

**Prerequisites:** None (foundational story). Operational one-time: confirm `/home/ubuntu/free-agent-worktrees/` directory exists on EC2 with daemon-user write access; confirm git is configured with the existing daemon identity (already set up for Pipeline v1).

**Technical Notes:**

- Files created: `daemon/pipelines/lib/free-agent-worktree.mjs`, `daemon/pipelines/lib/free-agent-path-hook.mjs`, `daemon/pipelines/__tests__/free-agent-worktree.test.mjs`, `functions/shared/lib/free-agent-iam.ts` (AssumeRole + re-AssumeRole helpers), `functions/shared/__tests__/free-agent-iam.test.ts`.
- Files modified: `sst.config.ts` (new `FreeAgentSessionRole` with trust policy + permissions policy; new cron schedule for `daemon-free-agent-gc` OR extend an existing cron), `daemon/agent-daemon.mjs` (add GC entry point if cron-dispatched).
- IAM policy structure: see party-mode session capture (Sean Tinel, round 5) for the exact JSON; this story implements it verbatim with one adjustment — the `s3:prefix` condition on `ListBucket` may need to be `s3:prefix: knowledge-live/${aws:PrincipalTag/project}/`.
- The PreToolUse hook in `.claude/settings.json` follows the standard hook contract: shell script returns non-zero to deny, zero to allow. Hook reads `$CLAUDE_TOOL_NAME` and `$CLAUDE_TOOL_INPUT` env vars (Bash tool only) and validates `cwd` resolution.
- Layer C (per-session AWS write credentials) is **NOT** implemented in this story per Epic scope. The role grants no write capabilities except own-conversation DDB writes.
- Reference: party-mode debate captured in conversation 2026-05-17 (Sean Tinel layered security spec; Rick's "v2-shaped posture from day one" reminder).

**Estimated Effort:** 5 points (~5 days)

---

### Story 18.2: Session lifecycle (spawn / TTL / cost-cap / reap)

As **Richie (operator)**,
I want **the daemon to manage free-agent sessions with a strict lifecycle — spawn on first message, enforce a per-session cost cap and idle TTL, reap on close or timeout**,
so that **no runaway session can silently burn Anthropic credits or hold an EC2 process indefinitely while I'm away from my desk**.

**Acceptance Criteria:**

- **AC #1** — New job type `free-agent-session` registered in `daemon/pipelines/job-router.mjs` (constant `JOB_HANDLER_FREE_AGENT_SESSION`, validator `validateFreeAgentSessionJob`). Job payload shape: `{ jobType: 'free-agent-session', sessionId, projectId, scope: {kind, id}, model, costCapUsd, credentials: {accessKeyId, secretAccessKey, sessionToken, expiration}, messages: [{role, content}] }`.
- **AC #2** — Job handler `daemon/pipelines/free-agent-session.mjs` ensures the worktree exists (via Story 18.1's helper), then spawns `claude -p <last-user-message> --model <model> --max-budget-usd <costCapUsd> --output-format stream-json --verbose --session-id <sessionId> --add-dir <worktreePath>` with `cwd=<worktreePath>` and the session credentials in `process.env` (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN).
- **AC #3** — Subsequent turns in the same session use `--resume <claudeSessionId>` (captured from the first turn's `system.init` event) — matching the Party turn-loop pattern. Subprocess stdout is parsed as NDJSON and each event is forwarded to `futurator-agent-events` keyed by sessionId, with event prefix `free-agent.turn.*`.
- **AC #4** — Idle TTL: if no message is received for a session within 30 minutes, the daemon marks the session `status='IDLE'`. After 2 hours idle, it transitions to `status='EXPIRED'` and any future message in the session creates a new session record (forking; old conversation remains in DDB for history).
- **AC #5** — Cost-cap enforcement: when the Claude CLI subprocess exits non-zero with `is_error=true` and the error message contains "budget exhausted" (or the `--max-budget-usd` flag's documented exit signature), the daemon transitions session to `status='BUDGET_EXHAUSTED'` and emits `free-agent.budget.exhausted` event. The next message attempt returns 402 Payment Required from the API with error code `BUDGET_EXHAUSTED`; operator must raise the cap or end the session.
- **AC #6** — Watchdog: if a single turn runs longer than 600 seconds, the child process is killed, session transitions to `status='ERROR'`, `free-agent.turn.error` event emitted with reason `TIMEOUT`. (Longer than Party's 180s because forensic investigations can legitimately take longer.)
- **AC #7** — Session lock: while a session is `status='PROCESSING'`, a second message returns 409 `SESSION_BUSY` from the API (handled at the route level in Story 18.5; this AC just specifies the daemon-side lock primitive — atomic conditional update transitioning `ACTIVE → PROCESSING` only succeeds when starting from `ACTIVE`).
- **AC #8** — Session repository `functions/shared/repositories/free-agent-sessions-repository.ts` exposes: `createSession`, `getSession`, `acquireProcessingLock`, `releaseProcessingLock`, `setClaudeSessionId`, `markIdle`, `markExpired`, `markBudgetExhausted`, `markError`, `incrementTurn`, `updateCostUsd`. Persistence in a new DDB table `futurator-free-agent-sessions` (added to sst.config.ts in this story).
- **AC #9** — DDB table `futurator-free-agent-sessions` schema: PK `sessionId`, attrs `operatorId, projectId, scope, status, model, costCapUsd, costUsdAccumulated, claudeSessionId?, turnCount, createdAt, lastActivityAt, lastTurnAt?`. GSI `operator-recent-index` on `(operatorId, lastActivityAt)`. GSI `scope-recent-index` on `(scopeIdComposite, lastActivityAt)` where scopeIdComposite = `<scope.kind>#<scope.id>`. 90-day TTL on `expiresAt = createdAt + 90d` for completed/idle sessions.
- **AC #10** — Unit tests (`daemon/pipelines/__tests__/free-agent-session.test.mjs`, `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts`): cover (a) first-turn spawn-args assertion, (b) follow-up turn `--resume` arg assertion, (c) cost-cap exit detection and status transition, (d) timeout watchdog kill path, (e) idle → expired transitions, (f) lock acquire success + conflict paths, (g) `claudeSessionId` capture from mocked stream-json `system.init` event.
- **AC #11** — `npm run ci` passes end-to-end.

**Prerequisites:** Story 18.1 complete (needs worktree helper, IAM role, credentials shape).

**Technical Notes:**

- Files created: `daemon/pipelines/free-agent-session.mjs`, `daemon/pipelines/__tests__/free-agent-session.test.mjs`, `functions/shared/repositories/free-agent-sessions-repository.ts`, `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts`, `functions/shared/types/free-agent.ts`, `functions/shared/schemas/free-agent-schema.ts`.
- Files modified: `daemon/pipelines/job-router.mjs` (add `JOB_HANDLER_FREE_AGENT_SESSION` + `validateFreeAgentSessionJob`), `daemon/agent-daemon.mjs` (dispatch new job type), `sst.config.ts` (add `FreeAgentSessionsTable`).
- **Investigation point:** existing tables `agentSessionsTable` (`futurator-agent-sessions`) and `agentConversationsTable` (`futurator-agent-conversations`) appear to be dormant Pipeline v1 leftovers (referenced in sst.config.ts:371-408 with comment "Pipeline v1 — Epic 3 (Talk-to-agent) tables"). Before creating new tables, dev should verify these are truly unused (`grep -r 'futurator-agent-sessions'` across the codebase + check DDB row count in production). If unused, the cleaner long-term path is to either repurpose them OR delete them and create the new ones; if used, create the new dedicated tables as specified. Default decision for this story: **create new tables** (`futurator-free-agent-sessions`, `futurator-free-agent-conversations`) and add a follow-up cleanup ticket if the dormant ones are confirmed unused.
- Cost-cap exit detection: investigate the actual exit shape from `claude -p --max-budget-usd` — the daemon's existing health-check at line 298 of `agent-daemon.mjs` shows the JSON output format; the budget-exhausted exit may surface as a specific `is_error: true` with a recognizable error string. AC #5 implementation may need adjustment based on actual observed CLI behavior.
- Cost accumulation: `costUsdAccumulated` is updated after each turn from the Claude CLI's reported `total_cost_usd` field in its final `result` event (existing pattern — see how Party-mode session-cost tracking works).

**Estimated Effort:** 3 points (~3 days)

---

### Story 18.3: Audit trail (commit trailer + CloudTrail + DDB session record)

As **Richie (operator)**,
I want **every action the free-agent takes — commits, AWS API calls, DDB writes — to be traceable back to a specific session, operator, and timestamp**,
so that **if anything anomalous happens I can answer "what did the agent do?" in under 5 minutes via standard queries, not a forensic archaeology dig**.

**Acceptance Criteria:**

- **AC #1** — Every commit the free-agent produces (via `Bash(git commit ...)` or any tool that triggers a commit) carries a `Agent: FREE-AGENT-<sessionId>` trailer in its commit message. This is enforced by a `prepare-commit-msg` git hook installed into the session's worktree on creation (Story 18.1 extension — add the hook write to `free-agent-worktree.mjs`).
- **AC #2** — The prepare-commit-msg hook is idempotent: if a commit message already contains `Agent: FREE-AGENT-<sessionId>`, the hook is a no-op (handles the case where the agent itself wrote the trailer).
- **AC #3** — DDB session record in `futurator-free-agent-sessions` is updated after each turn with cumulative `costUsdAccumulated`, `tokensInAccumulated`, `tokensOutAccumulated`, and `lastActivityAt`. Per-turn costs are also recorded as individual events in `futurator-agent-events` for granular forensic queries.
- **AC #4** — A CloudWatch Logs metric filter is created (via sst.config.ts) on the CloudTrail log group for the `FreeAgentSessionRole` ARN, matching any API call. The filter populates a CloudWatch namespace `FreeAgent/SessionApiCalls` with dimensions `(sessionId, operatorId, projectId)` extractable from the role session name `<projectId>--<sessionId>--<operatorId>`. **Note:** if CloudTrail filtering by role session name is non-trivial in SST, fall back to a simpler approach — daemon-side logging of every AWS SDK call from the subprocess (via env var `AWS_SDK_LOAD_CONFIG_DEBUG` or similar instrumentation).
- **AC #5** — `GET /api/free-agent/sessions/:id/audit` endpoint returns a unified audit timeline for a session: list of all DDB writes (from conversation/session tables), git commits produced (from `git log --grep='Agent: FREE-AGENT-<sessionId>'` against `assist/<projectId>/<sessionId>`), and AWS API calls (from CloudWatch metrics or daemon logs per AC #4). Response shape: `{sessionId, events: [{timestamp, kind, action, target, detail}]}` sorted ascending.
- **AC #6** — Audit endpoint is auth-gated; only the operator who owns the session OR an admin role can read it.
- **AC #7** — Unit tests cover: (a) prepare-commit-msg hook adds trailer to a fresh commit, (b) hook no-ops when trailer already present, (c) session-record update after a mocked turn correctly accumulates cost/tokens, (d) audit endpoint aggregates DDB writes + git log + AWS calls correctly with mocked data, (e) audit endpoint returns 403 for non-owner non-admin.
- **AC #8** — Manual verification: run a free-agent session that makes 2-3 commits + 5-10 DDB reads + 1-2 AWS calls; query the audit endpoint; verify all events present and timestamps consistent.
- **AC #9** — `npm run ci` passes end-to-end.

**Prerequisites:** Story 18.2 complete (needs session lifecycle + DDB table to record against).

**Technical Notes:**

- Files created: `daemon/pipelines/lib/free-agent-commit-hook.sh` (the prepare-commit-msg hook script template), tests for the audit aggregator.
- Files modified: `daemon/pipelines/lib/free-agent-worktree.mjs` (write commit-msg hook on worktree create — extends Story 18.1), `functions/api/index.ts` (add `GET /api/free-agent/sessions/:id/audit` route), `sst.config.ts` (CloudWatch metric filter on CloudTrail).
- The CloudTrail filter approach (AC #4) is best-effort — if the role-session-name dimension extraction is brittle, daemon-side AWS SDK call instrumentation is the fallback. Either way, the goal is "queryable record of what the agent touched outside the worktree."
- Existing `Agent: REVIEWER-*` / `Agent: DEV-*` trailers in the daemon use the same pattern — see how `daemon/pipelines/compile-*` writes those for reference.

**Estimated Effort:** 3 points (~3 days)

---

### Story 18.4: Widget shell (FAB + panel + lens header)

As **Richie (operator)**,
I want **a floating chat button always visible in the bottom-right corner of the app, that expands into a chat panel when I click it**,
so that **the free-agent is always one click away from any page without occupying screen real estate when I'm not using it**.

**Acceptance Criteria:**

- **AC #1** — A new component `<FreeAgentWidget />` is mounted globally from `src/app/layout.tsx` (or whichever layout currently contains the AuthGuard) so it renders on every authenticated page. Hidden when the user is not authenticated.
- **AC #2** — At rest, the widget renders as a circular FAB: 56×56px, fixed `bottom: 24px; right: 24px;`, `z-index: 50`, soft shadow, semantic accent color (use existing `accent-blue` token). Icon: chat bubble + small sparkle/wand (use Lucide `MessageSquareCode` or compose `MessageSquare` + `Sparkles`). Tooltip on hover: "Open free agent".
- **AC #3** — Clicking the FAB expands it into a chat panel anchored bottom-right, **~400×600px on desktop** (≥1024px), full-width drawer up to 90vh on mobile (<768px). Panel does NOT use a modal backdrop — the dashboard behind remains interactable.
- **AC #4** — Panel structure top-to-bottom: (a) **Header** showing the current lens label `Assistant — <Scope-Label>` where `<Scope-Label>` is `Project: <projectId>` when route matches `/labs/projects/:id` or `/labs/party/:id`, or `Plan: <planId>` when route matches `/labs?planId=*` or `/labs/plans/:id`, or `App: <appId>` when route matches `/apps/:id`; otherwise falls back to `Workspace`. Header also contains: model selector dropdown (placeholder for Story 18.5), cost-burn display (placeholder), hamburger menu (placeholder for Story 18.6 thread list), close button (X).
- **AC #5** — Panel body (b) **Message thread area**: scrollable, shows placeholder text "Send a message to start" when empty. Each message renders as a bubble — user messages right-aligned (accent color), agent messages left-aligned (muted background). Streaming tokens render progressively (Story 18.5 wires the actual stream; this story just verifies the rendering shell).
- **AC #6** — Panel footer (c) **Composer**: textarea (auto-grows to 6 lines max), `Cmd+Enter` to send, `Shift+Enter` for newline. Send button disabled when text empty or while a turn is processing. Footer also shows a small "$X.XX / $Y.YY" cost display (placeholder values).
- **AC #7** — Widget state managed by a new Zustand store `src/stores/free-agent-store.ts` with fields: `isOpen`, `currentScope: {kind: 'project'|'plan'|'app'|'workspace', id?: string}`, `activeSessionId: string|null`, `composerText: string`. Scope is derived from the current Next.js route via a `useFreeAgentScope()` hook that reads `usePathname()` and `useSearchParams()`.
- **AC #8** — Widget opens with the lens already correctly set (no flicker). If the operator navigates between pages while the widget is open, the lens updates AND the panel header shows a small "Scope changed — start new conversation?" callout (does NOT auto-fork the session; explicit user action only).
- **AC #9** — When EC2 mode is local (per existing `Ec2Toggle`), the widget renders disabled with FAB greyed out and tooltip "Switch to EC2 to use the free agent." Clicking it shows a small toast, doesn't open the panel.
- **AC #10** — Playwright smoke test (`tests/e2e/free-agent-widget.smoke.spec.ts`): (a) FAB visible on a generic authenticated page, (b) clicking opens the panel with `Workspace` lens, (c) navigating to a mock plan route updates the lens to `Plan: ...`, (d) close button closes the panel, (e) re-opening preserves composer text.
- **AC #11** — All new files conform to existing conventions: file naming kebab-case, named exports only, `@/...` imports, Prettier defaults, ESLint zero warnings.
- **AC #12** — `npm run ci` passes end-to-end.

**Prerequisites:** None (pure UI; backend mocked for this story).

**Technical Notes:**

- Files created (frontend): `src/components/free-agent/widget.tsx`, `src/components/free-agent/fab.tsx`, `src/components/free-agent/panel.tsx`, `src/components/free-agent/panel-header.tsx`, `src/components/free-agent/message-thread.tsx`, `src/components/free-agent/composer.tsx`, `src/components/free-agent/use-free-agent-scope.ts` (the route-based scope hook), `src/stores/free-agent-store.ts`, `src/types/free-agent.ts` (frontend types re-exported from backend in Story 18.5), `tests/e2e/free-agent-widget.smoke.spec.ts`.
- Files modified: `src/app/layout.tsx` (mount the widget globally, conditional on auth).
- Reused components: `src/components/ui/button.tsx`, `card.tsx`, `textarea.tsx`, `dropdown-menu.tsx`. Reused tokens: existing accent/muted/semantic CSS variables.
- No backend changes in this story.
- **Motion/animation is intentionally minimal in this story** — Sue Render's full spec (breathing pulse, spring open/close, staggered reveal) is deferred to Story 18.7. v1 ships with default `transition: all 0.2s ease` on the open/close, which is acceptable.

**Estimated Effort:** 3 points (~3 days)

---

### Story 18.5: Widget ↔ session wire-up (SSE streaming + model selector)

As **Richie (operator)**,
I want **the chat panel to actually spawn a free-agent session when I send my first message, stream Claude's response live, and let me pick which model to use**,
so that **the widget is functionally usable as an end-to-end working agent**.

**Acceptance Criteria:**

- **AC #1** — Four new API routes registered in `functions/api/index.ts` (JWT-gated):
  - `POST /api/free-agent/sessions` — body `{scope: {kind, id}, model, costCapUsd?}`, returns `{sessionId, ...}`. Creates the session record, calls AssumeRole (Story 18.1), enqueues a `free-agent-session` job placeholder (no message yet; session is created in `ACTIVE` status with `turnCount=0`).
  - `POST /api/free-agent/sessions/:id/messages` — body `{content: string}`. Validates content (UTF-8, ≤8192 bytes), acquires the processing lock (Story 18.2), enqueues a `free-agent-session` job with the message; returns immediately with `{enqueued: true}`.
  - `GET /api/free-agent/sessions/:id/stream` — SSE endpoint. Holds the connection open, streams events from `futurator-agent-events` filtered to this sessionId, terminates when the session returns to `ACTIVE` (turn complete) or `ERROR` / `BUDGET_EXHAUSTED`.
  - `GET /api/free-agent/sessions/:id` — returns the current session state (status, model, costUsdAccumulated, turnCount).
- **AC #2** — SSE implementation: Lambda function URL supports SSE per existing pipeline event-streaming pattern (see how Party's `GET /api/party/sessions/:id/events` works — adapt to long-poll SSE rather than polling endpoint). Events forwarded include `free-agent.turn.start`, `free-agent.turn.token` (incremental tokens), `free-agent.turn.tool_use`, `free-agent.turn.complete`, `free-agent.turn.error`, `free-agent.budget.exhausted`. Each event is `data: <json>\n\n`.
- **AC #3** — Widget composer wired to `POST /messages` and SSE `GET /stream` via a new hook `src/hooks/use-free-agent-session.ts`. The hook manages: session creation on first send (calls POST sessions), message send (POST messages), SSE subscription (EventSource), incremental token rendering into the active assistant message bubble, error/budget-exhausted handling.
- **AC #4** — Model selector in the panel header (Story 18.4 placeholder now wired): dropdown with three options labeled `Haiku (fast/cheap)`, `Sonnet (default)`, `Opus (deep work)` mapping to model aliases `haiku`, `sonnet`, `opus`. Tooltip on each option shows the full model ID (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`).
- **AC #5** — Default model is **Sonnet 4.6**. Last-used model is persisted to operator preferences (use existing `usersTable` if it has a preferences blob, OR add a `freeAgentPreferences` field via a small migration; OR store in localStorage as the simplest v1 — pick the lightest option that works). On opening a new conversation, the dropdown defaults to last-used.
- **AC #6** — Changing the model mid-conversation does NOT migrate the existing conversation — it starts a new session (creates a fresh `sessionId`, fresh worktree, fresh credentials). The old conversation remains accessible via the thread list (Story 18.6). A small "Started new conversation with Opus" system message is rendered in the thread on model change.
- **AC #7** — Cost cap: per-session default `$10` USD (constant in `functions/shared/types/free-agent.ts`). Operator can adjust via a small inline editor in the panel header (click the "$X.XX / $Y.YY" display → inline input → enter to save). Adjustment updates the session's `costCapUsd` field; the daemon's next turn re-spawns the CLI with the new `--max-budget-usd` value.
- **AC #8** — Live cost-burn display in the panel header ticks up after each turn based on `costUsdAccumulated` from the session record. When `costUsdAccumulated / costCapUsd > 0.8`, the display turns amber; at 1.0, it turns red and a "Budget exhausted — raise cap or end session" callout appears above the composer.
- **AC #9** — Unit tests: (a) `POST /sessions` creates a record with correct AssumeRole call, (b) `POST /messages` enforces 8192-byte limit, (c) `POST /messages` returns 409 on `SESSION_BUSY`, (d) `POST /messages` returns 402 on `BUDGET_EXHAUSTED`, (e) SSE stream forwards events correctly per sessionId, (f) model selector mapping correct (alias → CLI flag), (g) `use-free-agent-session.ts` hook correctly subscribes/unsubscribes from EventSource on mount/unmount.
- **AC #10** — Playwright e2e (`tests/e2e/free-agent-widget.smoke.spec.ts` extended): (a) opening widget + sending "say hello" with mocked SSE returns visible streamed tokens, (b) changing model mid-conversation starts new session, (c) cost-cap adjust inline editor functions.
- **AC #11** — Manual verification on EC2 dev: open widget, send "scan the agent-jobs table for the latest 3 failed jobs", verify (a) session created in DDB, (b) tokens stream live, (c) agent actually queries DDB and returns real data, (d) cost-burn updates in panel header.
- **AC #12** — `npm run ci` passes end-to-end.

**Prerequisites:** Stories 18.1, 18.2, 18.3, 18.4 complete (needs full backend runtime + audit + UI shell).

**Technical Notes:**

- Files created: `src/hooks/use-free-agent-session.ts`, `src/hooks/use-free-agent-models.ts` (model list as a static constant, but a hook makes it future-proof for fetching from `/api/free-agent/models`), tests.
- Files modified: `functions/api/index.ts` (4 new routes), `src/components/free-agent/panel-header.tsx` (model dropdown + cost editor), `src/components/free-agent/composer.tsx` (wired to send hook), `src/components/free-agent/message-thread.tsx` (wired to SSE stream).
- SSE pattern: Lambda function URL with streaming response (`Content-Type: text/event-stream`, flush per event). Investigate whether SST's Lambda function URL supports streaming responses natively or requires the `awslambda.streamifyResponse` wrapper.
- Model alias → CLI flag mapping: pass-through. `--model haiku` works directly per the verified CLI doc (party-mode round 7). Full model IDs also work.
- Cost-cap UX detail: the inline editor is intentionally lightweight — click number, edit, enter to save. No modal, no settings page. Matches the `[[ship-mvp-add-complexity-later]]` preference.

**Estimated Effort:** 5 points (~5 days)

---

### Story 18.6: Conversation persistence + thread list

As **Richie (operator)**,
I want **my free-agent conversations to persist across browser refreshes and be listed in a thread picker so I can resume prior sessions**,
so that **the agent feels like a continuous collaborator across days/weeks, not a fresh ephemeral chat every time I open the widget**.

**Acceptance Criteria:**

- **AC #1** — New DDB table `futurator-free-agent-conversations` (added to sst.config.ts) with schema: PK `sessionId`, SK `messageIndex` (zero-padded 6-digit int as string, e.g., `000001`), attrs `role` (user/assistant/system), `content`, `tokensIn?`, `tokensOut?`, `costUsd?`, `createdAt`, `toolCalls?` (JSON array). TTL `expiresAt = createdAt + 90 days` on each message row.
- **AC #2** — Conversation repository `functions/shared/repositories/free-agent-conversations-repository.ts` exposes: `appendMessage(sessionId, message)`, `getMessages(sessionId)`, `listSessionsByOperator(operatorId, limit?)` (returns session-record summaries from `futurator-free-agent-sessions` via the `operator-recent-index` GSI from Story 18.2), `listSessionsByScope(scopeKind, scopeId, limit?)` (via the `scope-recent-index` GSI).
- **AC #3** — Every user message and assistant response is persisted to `futurator-free-agent-conversations` as it's generated. The daemon appends user message immediately on receipt; assistant message is built incrementally during streaming and finalized on `free-agent.turn.complete` event (single Put with the full content + token counts + cost).
- **AC #4** — New API routes (JWT-gated):
  - `GET /api/free-agent/conversations` — query params `?scope=<kind>:<id>&limit=20`. Returns the operator's recent sessions for the given scope, or all scopes if omitted. Response shape: `[{sessionId, scope, status, model, costUsdAccumulated, turnCount, lastActivityAt, firstUserMessagePreview}]`. The `firstUserMessagePreview` is the first 80 chars of the first user message (for the thread list display).
  - `GET /api/free-agent/sessions/:id/messages` — returns the full message history for a session (`[{role, content, createdAt, tokensIn?, tokensOut?, costUsd?}]`).
- **AC #5** — Panel header hamburger menu (Story 18.4 placeholder now wired) opens a small dropdown showing the operator's 10 most recent conversations for the current scope. Each row: `{firstUserMessagePreview}` (truncated to one line) + relative time (`12m ago`, `3h ago`, `Yesterday`). Click a row → resume that session: widget loads `GET /sessions/:id/messages` into the thread, sets `activeSessionId` to the loaded id, the dropdown closes.
- **AC #6** — "New conversation" entry at the top of the dropdown clears the active session (`activeSessionId = null`) and resets the thread to empty. Next send creates a fresh session.
- **AC #7** — Resuming a session that is `IDLE` or `EXPIRED`: a small system message in the thread shows "Session resumed — credentials refreshed". The next user message triggers re-AssumeRole (Story 18.1 AC #3) and a fresh worktree path-confine check.
- **AC #8** — Resuming a session that is `BUDGET_EXHAUSTED`: the thread loads but the composer is disabled with the budget callout shown; operator must raise the cap (Story 18.5 inline editor) before sending.
- **AC #9** — Unit tests: (a) message append + read round-trip, (b) listSessionsByOperator returns most-recent first via GSI, (c) listSessionsByScope correctly filters, (d) thread list dropdown renders sessions, (e) clicking a session loads its messages into the thread, (f) "New conversation" resets the active session.
- **AC #10** — Playwright e2e (`tests/e2e/free-agent-widget.smoke.spec.ts` extended): (a) send 2 messages → close widget → reopen → previous messages re-render, (b) open dropdown → see prior conversation listed, (c) click prior conversation → messages load.
- **AC #11** — `npm run ci` passes end-to-end.

**Prerequisites:** Stories 18.2 and 18.5 complete (needs session lifecycle + working send/stream).

**Technical Notes:**

- Files created: `functions/shared/repositories/free-agent-conversations-repository.ts`, tests, `src/components/free-agent/thread-list-dropdown.tsx`.
- Files modified: `sst.config.ts` (add `FreeAgentConversationsTable`), `functions/api/index.ts` (2 new routes), `src/components/free-agent/panel-header.tsx` (hamburger triggers dropdown), `src/hooks/use-free-agent-session.ts` (loadSession action), `src/hooks/use-free-agent-conversations.ts` (NEW — TanStack Query hook for the thread list).
- 90-day TTL on conversation messages is the cost-control floor; operator can manually export important conversations via a future "Export thread" action (deferred to v1.1 or v2).
- Thread list returns 10 by default; "Show more" pagination is deferred.

**Estimated Effort:** 3 points (~3 days)

---

## Deferred to v1.1 (out of Epic 18 scope)

The following two stories are recognized as desirable but explicitly cut from v1 to preserve a 2–3 sprint ship target. Promote to a follow-up sprint after v1 lands in production and operator usage validates the core experience.

### Story 18.7: Motion polish (breathing pulse + spring open/close + reduced-motion)

**Source spec:** Party-mode debate (Sue Render, round 3). Custom keyframe for breathing pulse (1.0 → 1.06 → 1.0, 2200ms period, cubic-bezier ease-in-out), spring open animation (320ms `cubic-bezier(0.16, 1, 0.3, 1)`), staggered content reveal (3 regions × 40ms), 240ms snap close, `prefers-reduced-motion` static glow fallback. ~40 lines of CSS + a `useReducedMotion()` hook. Estimated: 2 points (~2 days).

### Story 18.8: Pulse trigger semantics

**Source spec:** Party-mode debate (Dr. Quinn round 3 trigger taxonomy + Sally round 3 badge states). Defines which attention-item events cause the breathing pulse to activate on the FAB. Includes: hard-fault attention items (immediate pulse), self-healing-failed-3x items (pulse after retry exhaustion), conversation-unread (red number badge separate from pulse). Implementation: new daemon-side event observer that updates a `pulseState` field on the free-agent store via SSE on `/api/free-agent/pulse` endpoint. Estimated: 3 points (~3 days).

---

## Implementation Timeline — Epic 18

**Total Story Points:** 22 (v1) + 5 (v1.1 deferred) = 27 if both ship in one push

**Estimated Timeline:**

- v1 (stories 18.1–18.6): ~2–3 sprints (10–15 working days)
- v1.1 (stories 18.7–18.8): ~1 additional week if/when promoted

**Sequencing rationale:**

1. **Stories 18.1, 18.2, 18.3 first (architectural)** — IAM role + worktree, session lifecycle, audit trail. Zero user-visible value but unblocks everything else. Ship as one PR or three small PRs depending on review appetite. Per Rick's reminder (party-mode round 5): build the v2-shaped security/audit posture from day one even though v1 features don't yet exercise it.
2. **Story 18.4 in parallel with 18.1–18.3** — pure UI story with mocked backend; can be developed by a frontend-focused dev in parallel with the daemon/IAM work.
3. **Story 18.5** — first user-visible end-to-end milestone. Brings 18.1–18.4 together into a working chat.
4. **Story 18.6** — persistence + thread list closes the v1 loop. Without this the widget feels ephemeral and forgets you between refreshes.

**Dependency validation:** ✅ Valid sequence — 18.1–18.3 can ship without UI; 18.4 can ship with mocked backend; 18.5 brings them together; 18.6 builds on 18.5. Each story leaves the system in a deployable (if partial) state.

---

## Epic 19: Exploration Rigor + Findings Pipeline (v2 — deferred placeholder)

**Status:** Deferred. Will be expanded into full stories after Epic 18 ships to production and operator usage validates the free-agent runtime as a reusable foundation.

**Slug:** `exploration-rigor`

### Goal (summary)

Add a fourth rigor tier (`exploration`) and a corresponding plan kind (`exploration`) to Pipeline v2.5, enabling friction-free spikes on `experiment/<plan-slug>` branches that never auto-merge. At plan close, REFLECTOR-FINDINGS (running on Epic 18's free-agent runtime in a special prompt mode) produces `.findings/findings.md` + manifest-delta YAMLs + reproduction notes. Subsequent feature plans reference experiments via an `informed-by:` field; their PM / ARCHITECT / SKILL-SCOUT agents read the findings doc + manifest deltas as starting proposals.

### Source spec

`~/Downloads/futurator-pipeline-exploration-rigor-addendum.md` (read 2026-05-17 during party-mode debate; serves as the design baseline).

### Refinements from party-mode debate (Murat, Winston, paige rounds 4)

To be incorporated when Epic 19 is expanded into stories:

1. **Findings-validator step** (Murat) — a cheap Haiku call between REFLECTOR-FINDINGS and the Reflection Inbox that validates the findings doc is well-formed (template sections populated, manifest-delta YAMLs parse, every "What worked" bullet cites at least one commit SHA, reproduction-notes commands exist in the repo). Does not judge content quality — judges that downstream agents can trust the artifact.

2. **paige's findings-doc improvements**:
   - Machine-readable YAML front-matter at the top (verdict, recommended-stack, key-tradeoffs, open-questions, manifest-deltas-summary) — single source of truth, two facets (prose for operator, structured for agents).
   - Inverted pyramid in the prose section (lead with recommended approach, then evidence, then open questions).
   - DEV inbox conventions during the spike (`inboxes/dev-decisions.md` — one short bullet per pivot, with commit SHA) so REFLECTOR has a high-quality input spine.
   - Mirror findings doc to `docs/findings/<plan-slug>.md` on main (queryable knowledge library; git history of experiments stays on `experiment/` branches).

3. **Single-axis rigor matrix** (Winston debated; operator decided) — DO NOT split into `rigor × ship-intent` two-axis. Keep the single-axis matrix; `exploration` is a fourth value with `experiment/` branch namespace and `never auto-merge` semantics baked in. Two-axis refactor deferred until a real third combination is needed.

4. **Rick's runtime collapse** — REFLECTOR-FINDINGS is implemented as a special prompt mode of Epic 18's free-agent runtime, NOT as a separate orchestrator. Saves ~80% of the plumbing work and prevents two-similar-systems drift.

5. **Sean's allowlist note** — exploration rigor keeps tool allowlists _on_, just very permissive (e.g., everything except `iam:*`, `secretsmanager:*`, `lambda:UpdateFunctionCode`). The IAM role for an exploration plan's DEV agent reuses Epic 18's `FreeAgentSessionRole` (read-scoped + own-conversation writes) extended with project-repo write capability scoped to the `experiment/` branch namespace.

### Expected story decomposition (high-level, to be refined)

Approximately 8–10 stories per the addendum's §13 effort estimate, modified to reuse Epic 18 runtime:

- 19.1 — New `exploration` rigor + `exploration` plan kind in `pipeline-rigor.ts` + plan-kind matrix
- 19.2 — Daemon: branch-namespace + worktree handling for `experiment/<plan-slug>`
- 19.3 — REFLECTOR-FINDINGS prompt mode (reuses Epic 18 runtime)
- 19.4 — `.findings/` directory convention + manifest-delta YAML schemas
- 19.5 — Findings-validator step (Haiku call)
- 19.6 — PM input extension: read `findings.md` from `informed-by:` experiments
- 19.7 — ARCHITECT / SKILL-SCOUT T2 extension: read manifest deltas as proposals
- 19.8 — `informed-by:` field on plan card schema + UI rendering
- 19.9 — `Carried-Forward-From:` commit metadata field
- 19.10 — `docs/findings/` mirror + queryable index

**Estimated effort (when promoted):** ~11–14 days per the addendum, possibly less if Epic 18 runtime reuse is clean.

---

## Tech-Spec Reference

No standalone tech-spec exists for Epic 18 — this epic file IS the spec, drafted directly from the party-mode session per the operator's `[[ship-mvp-add-complexity-later]]` preference. If during implementation a section becomes large enough to warrant extraction, create `docs/tech-spec-free-agent.md` and reference it from the relevant story's Technical Notes.

For Epic 19 the canonical source remains `~/Downloads/futurator-pipeline-exploration-rigor-addendum.md` until the epic is expanded.
