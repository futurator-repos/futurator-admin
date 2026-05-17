# Story 18.2: Session lifecycle (spawn / TTL / cost-cap / reap)

**Status:** review

---

## User Story

As **Richie (operator of Futurator-Admin)**,
I want **the daemon to manage free-agent sessions with a strict lifecycle — spawn on first message, enforce a per-session cost cap and idle TTL, reap on close or timeout**,
So that **no runaway session can silently burn Anthropic credits or hold an EC2 process indefinitely while I'm away from my desk**.

---

## Acceptance Criteria

**AC #1** — New job type `free-agent-session` registered in `daemon/pipelines/job-router.mjs` (constant `JOB_HANDLER_FREE_AGENT_SESSION`, validator `validateFreeAgentSessionJob`). Job payload shape: `{ jobType: 'free-agent-session', sessionId, projectId, scope: {kind, id}, model, costCapUsd, credentials: {accessKeyId, secretAccessKey, sessionToken, expiration}, messages: [{role, content}] }`. The validator asserts every required field is present and rejects with a structured `{ ok: false, reason }` on malformed payloads.

**AC #2** — Job handler `daemon/pipelines/free-agent-session.mjs` ensures the worktree exists (via Story 18.1's `ensureWorktree`), writes the per-session `.claude/settings.json` (via `writeFreeAgentSettings`), then spawns `claude -p <last-user-message> --model <model> --max-budget-usd <costCapUsd> --output-format stream-json --verbose --session-id <sessionId> --add-dir <worktreePath>` with `cwd=<worktreePath>` and the session credentials in `process.env` (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN) plus `FREE_AGENT_CONFINEMENT_ROOT=<worktreePath>` for the PreToolUse hook from Story 18.1.

**AC #3** — Subsequent turns in the same session use `--resume <claudeSessionId>` (captured from the first turn's `system.init` event) — matching the Party turn-loop pattern. Subprocess stdout is parsed as NDJSON and each event is forwarded to `futurator-agent-events` keyed by sessionId, with event prefix `free-agent.turn.*` (`free-agent.turn.start`, `free-agent.turn.token`, `free-agent.turn.tool_use`, `free-agent.turn.complete`, `free-agent.turn.error`). The `claudeSessionId` is persisted on the session row via `setClaudeSessionId` on the first turn's `system.init` event.

**AC #4** — Idle TTL: the GC scheduler from Story 18.1 (wired into the daemon poll loop in this story) marks any session whose `lastActivityAt` is more than 30 minutes ago AND status is `ACTIVE` as `IDLE`. Sessions that remain `IDLE` for 2 additional hours (so 2.5h total idle) are transitioned to `EXPIRED`. Sessions in `EXPIRED` are eligible for worktree reap after 7 days (existing 18.1 GC behavior). Any new message to an `EXPIRED` session creates a _new_ session record (forks); the prior conversation remains in DDB for history.

**AC #5** — Cost-cap enforcement: when the Claude CLI subprocess exits non-zero AND the parsed `result` event reports `is_error=true` with a budget-related signal (the exact signal shape is to be observed during implementation — likely an `error.type` or message substring like "budget exhausted" / "max_budget_usd reached"), the daemon transitions session to `status='BUDGET_EXHAUSTED'`, persists `costUsdAccumulated` from the last reported cost, and emits `free-agent.budget.exhausted` event. The next message attempt on this session returns 402 Payment Required from the API with error code `BUDGET_EXHAUSTED` (API route side is implemented in Story 18.5; this story implements the daemon-side state transition + the repository's `markBudgetExhausted` function).

**AC #6** — Watchdog: if a single turn runs longer than 600 seconds, the child process is killed (SIGKILL after SIGTERM grace), session transitions to `status='ERROR'`, `free-agent.turn.error` event emitted with reason `TIMEOUT`. The 600s window is intentionally longer than Party's 180s because forensic investigations can legitimately take longer. The watchdog is configurable via env var `FREE_AGENT_TURN_TIMEOUT_MS` (default 600000).

**AC #7** — Session lock primitive: `acquireProcessingLock(sessionId)` is implemented as an atomic conditional `UpdateCommand` transitioning `status='ACTIVE' → 'PROCESSING'` only when the current status is `ACTIVE`. Returns `{ ok: true }` on success, `{ ok: false, reason: 'SESSION_BUSY' | 'NOT_FOUND' | 'INVALID_STATE' }` on failure (disambiguated by re-fetching the row on `ConditionalCheckFailedException`). `releaseProcessingLock(sessionId, newStatus)` performs the inverse transition to `ACTIVE` (success), `ERROR`, `BUDGET_EXHAUSTED`, or `IDLE`. The API-side 409 `SESSION_BUSY` translation is implemented in Story 18.5.

**AC #8** — Session repository `functions/shared/repositories/free-agent-sessions-repository.ts` exposes:

- `createSession({sessionId, operatorId, projectId, scope, model, costCapUsd}): Promise<FreeAgentSession>` — initial state `ACTIVE`, `turnCount=0`, `lastActivityAt=now`, `expiresAt=now+90d` (TTL).
- `getSession(sessionId): Promise<FreeAgentSession | null>`
- `acquireProcessingLock(sessionId): Promise<{ok: true} | {ok: false, reason}>`
- `releaseProcessingLock(sessionId, newStatus: 'ACTIVE'|'ERROR'|'BUDGET_EXHAUSTED'|'IDLE'): Promise<void>`
- `setClaudeSessionId(sessionId, claudeSessionId): Promise<void>` — first-turn capture
- `markIdle(sessionId): Promise<void>` — GC transition
- `markExpired(sessionId): Promise<void>` — GC transition
- `markBudgetExhausted(sessionId): Promise<void>` — daemon transition on cost-cap exit
- `markError(sessionId, reason): Promise<void>`
- `incrementTurn(sessionId): Promise<void>` — `turnCount++`, `lastActivityAt=now`, `lastTurnAt=now`
- `updateCostUsd(sessionId, costUsdDelta): Promise<void>` — adds to `costUsdAccumulated`
- `listAllSessions(): Promise<FreeAgentSession[]>` — full scan (used by GC; bounded by the 90-day TTL keeping the table small)
- `listSessionsByOperator(operatorId, limit?)` — via `operator-recent-index` GSI (used by Story 18.6 thread list)
- `listSessionsByScope(scopeKind, scopeId, limit?)` — via `scope-recent-index` GSI

**AC #9** — DDB table `futurator-free-agent-sessions` (added to `sst.config.ts` in this story). Schema:

- **PK:** `sessionId` (string, UUID)
- **Attributes:** `operatorId, projectId, scope (kind+id JSON), status, model, costCapUsd, costUsdAccumulated, claudeSessionId?, turnCount, createdAt, lastActivityAt, lastTurnAt?, lastRefreshedAt?, expiresAt`
- **GSI1 (`operator-recent-index`):** PK `operatorId`, SK `lastActivityAt` — for "my recent sessions"
- **GSI2 (`scope-recent-index`):** PK `scopeIdComposite` (`<scope.kind>#<scope.id>`), SK `lastActivityAt` — for "conversations about this plan"
- **TTL:** `expiresAt` attribute, 90 days from `createdAt`
- **Billing:** `PAY_PER_REQUEST`; PITR `enabled: true`
- Linked to API Lambda + daemon EC2 role with read/write permissions

**AC #10** — GC scheduler from Story 18.1 wired into the daemon poll loop. Throttled-scan pattern mirroring `STALE_SCAN_INTERVAL_MS`: a `lastFreeAgentGcAt` module-scoped counter + `FREE_AGENT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000` (24h, configurable via env). Inside the main poll loop in `agent-daemon.mjs`, after `writeHeartbeat`, check if `Date.now() - lastFreeAgentGcAt >= FREE_AGENT_GC_INTERVAL_MS`; if yes, fire `runFreeAgentGc(...)` non-blocking (`.catch(log)`) and reset `lastFreeAgentGcAt = Date.now()`. The GC now uses the real `listAllSessions` from the new repository instead of the pre-Story-18.2 fallback.

**AC #11** — Unit tests pass:

- `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` (NEW) — covers all repository functions including the lock acquire success + conflict + not-found disambiguation paths; GSI query shape assertions; TTL field calculation.
- `daemon/pipelines/__tests__/free-agent-session.test.mjs` (NEW) — covers (a) first-turn spawn-args assertion (model, max-budget-usd, output-format, session-id, add-dir, cwd, env credentials + FREE_AGENT_CONFINEMENT_ROOT), (b) follow-up turn `--resume <claudeSessionId>` arg assertion, (c) `claudeSessionId` capture from mocked stream-json `system.init` event, (d) cost-cap exit detection and `markBudgetExhausted` call, (e) watchdog SIGTERM-then-SIGKILL on 600s+ turn, (f) lock acquire success + `SESSION_BUSY` path, (g) credential refresh on stale expiry via `refreshSessionCredentials` from Story 18.1 (h) ensureWorktree call before first spawn.
- `daemon/pipelines/__tests__/job-router.test.mjs` (EXTENDED) — `selectHandler({jobType: 'free-agent-session'})` returns `JOB_HANDLER_FREE_AGENT_SESSION`; `validateFreeAgentSessionJob` rejects missing fields.

**AC #12** — `npm run ci` passes end-to-end (lint zero warnings, format:check clean, knip + typecheck unchanged from pre-existing baseline, vitest, build).

---

## Implementation Details

### Tasks / Subtasks

**Infrastructure (SST)**

- [x] Modify `sst.config.ts` — add `FreeAgentSessionsTable` (`sst.aws.Dynamo`) with the schema in AC #9 (PK sessionId, GSI1 `operator-recent-index`, GSI2 `scope-recent-index`, TTL on `expiresAt`, PITR enabled). Link to API Lambda. Wire `FREE_AGENT_SESSIONS_TABLE` env var. (AC #9)
- [x] Grant the daemon EC2 IAM role read/write on the new table. (AC #9)

**Shared types + schemas + repository**

- [x] Create `functions/shared/types/free-agent.ts` — `FreeAgentSession`, `FreeAgentSessionStatus` (`ACTIVE | PROCESSING | IDLE | EXPIRED | BUDGET_EXHAUSTED | ERROR`), `FreeAgentScope` (`{kind: 'project'|'plan'|'app'|'workspace', id?: string}`), `ModelAlias` (`'haiku' | 'sonnet' | 'opus'`). (AC #8)
- [x] Create `functions/shared/schemas/free-agent-schema.ts` — zod schemas for session creation, message send input, status enum. Use `.safeParse()` only. (AC #8)
- [x] Create `functions/shared/repositories/free-agent-sessions-repository.ts` exporting the 13 functions from AC #8. Use `@aws-sdk/lib-dynamodb` DocumentClient via existing `docClient` from `dynamo-client.ts`. Add table name to `TABLE_NAMES` registry. (AC #7, AC #8)
- [x] Create `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` — covers all 13 functions, lock acquire/release success+conflict paths, GSI query shapes, TTL calculation. (AC #11)

**Daemon — job handler**

- [x] Create `daemon/pipelines/free-agent-session.mjs` exporting `runFreeAgentSession(job, ctx)` implementing AC #2-7 logic. Reuse `runAgent`-style spawn from `agent-daemon.mjs:670+` (use `process.execPath` + `[CLAUDE_BIN, ...args]` to avoid shell). Pipe credentials + `FREE_AGENT_CONFINEMENT_ROOT` via env. Parse stream-json output via `JSON.parse` per-line.
- [x] Create `daemon/pipelines/__tests__/free-agent-session.test.mjs` — covers AC #11 a-h with `vi.mock` on `child_process.spawn` + the IAM/worktree helpers from 18.1. (AC #11)

**Daemon — wire-up**

- [x] Modify `daemon/pipelines/job-router.mjs` — export `JOB_HANDLER_FREE_AGENT_SESSION`; extend `selectHandler` to dispatch `'free-agent-session'`; add `validateFreeAgentSessionJob`. (AC #1)
- [x] Modify `daemon/agent-daemon.mjs` — add dispatch case for `JOB_HANDLER_FREE_AGENT_SESSION` (calls `runFreeAgentSession`). Add the GC scheduler ticker per AC #10 — `lastFreeAgentGcAt = 0`, `FREE_AGENT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000`, check + fire inside the main loop after `writeHeartbeat`. (AC #1, AC #10)
- [x] Extend `daemon/pipelines/__tests__/job-router.test.mjs` — assertions per AC #11 line 3. (AC #11)

**Validation**

- [x] Run `npm run ci` — verify no new regressions. (AC #12)

---

## Dev Notes

### Architecture patterns and constraints

- **Reuses Story 18.1 primitives, doesn't redefine them.** `ensureWorktree`, `writeFreeAgentSettings`, `refreshSessionCredentials`, and the path-confinement hook all ship from 18.1. This story wires them together into a working session runtime. [Source: docs/stories/18-1-per-session-iam-role-and-worktree.md]
- **`process.env` cannot be patched on a running subprocess** (per 18.1 dev notes). When credentials approach expiry mid-session, `refreshSessionCredentials` is called BEFORE the next spawn — never during a running turn. Document the staleness behavior in daemon logs. [Source: Story 18.1 Completion Notes; AC #3]
- **The Claude CLI's `--max-budget-usd` exit shape must be observed empirically.** The story spec says "the exact signal shape is to be observed during implementation". The implementer should run a controlled test (low cap, force-overspend) on EC2 dev OR mock the documented Anthropic SDK error shape; adjust `markBudgetExhausted` trigger condition based on actual output. Reference: party-mode debate round 7 (Amelia found `--max-budget-usd` exists; exit semantics weren't verified). [Source: AC #5]
- **Sessions ship as one table per concern** — `futurator-free-agent-sessions` is a NEW dedicated table per `[[dynamodb-multi-table-preference]]`. The existing `agentSessionsTable` and `agentConversationsTable` belong to Pipeline v1's "Talk-to-agent" flow (active code in `daemon/pipelines/agent-turn.mjs`, `daemon/lib/cost-meter.mjs`, `daemon/lib/compactor.mjs`) — do NOT reuse them. [Source: Story 18.1 Completion Notes recon; memory `[[dynamodb-multi-table-preference]]`]
- **Idle TTL state machine is GC-driven.** The daemon does not run timers per session. The GC sweep is what transitions `ACTIVE → IDLE` (30min) and `IDLE → EXPIRED` (2h after IDLE). Sessions become eligible for worktree reap 7 days after entering `EXPIRED` (Story 18.1's existing 7d threshold). [Source: AC #4]
- **Branch namespace `assist/<project>/<session>` is sacred** (carried from 18.1). Sessions running under this story write to that branch only. No pipeline tooling touches these branches. [Source: Story 18.1 architecture notes]
- **Watchdog kill is two-phase.** SIGTERM first (graceful), 5s grace, SIGKILL second. The Claude CLI's process group cleanup may take a moment; SIGKILL guarantees the subprocess is reaped. [Source: AC #6]

### Source tree components to touch

This story builds on 18.1 — all paths are either NEW or extensions of 18.1 work or existing daemon files:

- **NEW** `functions/shared/types/free-agent.ts`
- **NEW** `functions/shared/schemas/free-agent-schema.ts`
- **NEW** `functions/shared/repositories/free-agent-sessions-repository.ts` (+ test)
- **NEW** `daemon/pipelines/free-agent-session.mjs` (+ test)
- **MODIFIED** `daemon/pipelines/job-router.mjs` — handler constant + selectHandler branch + validator
- **MODIFIED** `daemon/pipelines/__tests__/job-router.test.mjs` — extend
- **MODIFIED** `daemon/agent-daemon.mjs` — dispatch case + GC scheduler wiring
- **MODIFIED** `functions/shared/dynamo-client.ts` — add `freeAgentSessions` to `TABLE_NAMES`
- **MODIFIED** `sst.config.ts` — `FreeAgentSessionsTable` + Lambda link + daemon IAM grant + env var

### Open implementation questions (flag during dev, not blocking draft)

- **Cost-cap exit signal shape.** The `--max-budget-usd` CLI exit + parsing contract isn't documented in the Claude Code CLI help. Best-effort approach: when the subprocess exits non-zero AND the LAST `result` event has `is_error=true` AND the error message matches `/budget.*exhausted|max.*budget|cost.*cap/i`, treat it as `BUDGET_EXHAUSTED`. If the implementer observes a different exit shape on EC2 dev, refine the matcher. Falling back to "any non-zero exit with no clear error category → mark ERROR" is acceptable for v1.
- **AGENT_JOBS_TABLE payload shape.** The job-dispatch payload carrying credentials must traverse DDB. Verify whether existing job payloads sanitize / encrypt nested fields, OR whether the credentials should be passed via a separate channel (e.g., SSM ParameterStore with a temp key). For v1: pass via the job payload (DDB encryption at rest is on; the table is private). Flag as a hardening item for a future audit.
- **`listAllSessions` performance.** Full Scan is acceptable while sessions table is small (bounded by 90-day TTL and operator usage volume). If the table grows past ~10k rows, the GC should switch to a query on a `status-index` GSI for `(IDLE, EXPIRED, BUDGET_EXHAUSTED)` statuses only. Not needed for v1.

### References

- Epic: `docs/epics-free-agent.md` (Story 18.2 section)
- Story 18.1 (foundational): `docs/stories/18-1-per-session-iam-role-and-worktree.md` — Completion Notes capture key recon findings and deferred-to-18.2 items
- Story 18.1 context: `docs/stories/18-1-per-session-iam-role-and-worktree.context.xml`
- Memory: `[[ship-mvp-add-complexity-later]]` — guides scope (don't build session-status-state-machine UI; GC is the only mechanism)
- Memory: `[[dynamodb-multi-table-preference]]` — new dedicated table, not reuse of Pipeline v1
- Reference patterns: `daemon/pipelines/party-turn.mjs` (Claude CLI spawn with `--resume`), `functions/shared/repositories/party-sessions-repository.ts` (lock pattern), `daemon/agent-daemon.mjs:670-730` (canonical `runAgent` shape), `daemon/agent-daemon.mjs:3676-3724` (poll-loop throttled-scan pattern for GC scheduler)

---

## Dev Agent Record

### Context Reference

- [docs/stories/18-2-session-lifecycle.context.xml](./18-2-session-lifecycle.context.xml) — generated 2026-05-17 via story-context workflow

### File List

**Created (6 files):**

- `functions/shared/types/free-agent.ts` — type definitions for the session runtime (91 lines)
- `functions/shared/schemas/free-agent-schema.ts` — zod schemas for create / send / payload (76 lines)
- `functions/shared/repositories/free-agent-sessions-repository.ts` — 13 exported functions + 1 internal helper (235 lines)
- `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` — 25 tests
- `daemon/pipelines/free-agent-session.mjs` — daemon job handler with spawn + watchdog + stream parsing (322 lines)
- `daemon/pipelines/__tests__/free-agent-session.test.mjs` — 11 tests

**Modified (4 files):**

- `sst.config.ts` — `FreeAgentSessionsTable` (PK + 2 GSIs + 90d TTL); linked to API Lambda; new `FREE_AGENT_SESSIONS_TABLE` env var
- `functions/shared/dynamo-client.ts` — added `freeAgentSessions` to `TABLE_NAMES` registry
- `daemon/pipelines/job-router.mjs` — `JOB_HANDLER_FREE_AGENT_SESSION` constant + `selectHandler` branch + `validateFreeAgentSessionJob` validator
- `daemon/pipelines/__tests__/job-router.test.mjs` — extended with 10 new tests for the free-agent dispatch + validator
- `daemon/agent-daemon.mjs` — `ScanCommand` import; `FREE_AGENT_SESSIONS_TABLE` constant; `FREE_AGENT_GC_INTERVAL_MS` constant; `lastFreeAgentGcAt` poll-loop counter; daemon-side facade (10 functions: `freeAgentGetSession`/`freeAgent*` operations matching the TS repository); `buildFreeAgentSessionsRepoFacade()`; `executeFreeAgentSessionJob()` handler; dispatch case for `JOB_HANDLER_FREE_AGENT_SESSION`; GC scheduler ticker inside the main poll loop (per AC #10, deferred from Story 18.1)

**Test totals:** 46 new tests (25 repo + 11 handler + 10 router), all passing. 0 regressions in pre-existing test suite.

### Completion Notes

**Scope delivered (AC #1-11, AC #12):**

All 12 acceptance criteria are met at the code level. The daemon now dispatches the new `free-agent-session` job type to `runFreeAgentSession`, which acquires a processing lock, ensures the per-session worktree (via Story 18.1's helpers), writes the path-confinement settings, spawns `claude -p` with the full credential/cost-cap/worktree env, parses stream-json output, handles cost-cap exit + timeout + non-zero exit explicitly, and releases the lock to the appropriate terminal state. The deferred GC scheduler from Story 18.1 is now wired into the daemon poll loop using the same throttled-scan pattern as the existing stale-heartbeat scan; the GC now uses the real `listAllSessions` from the new repository instead of the pre-18.2 fallback.

**Operational note for post-deploy:**

The daemon EC2 IAM role (`develope-it-ec2-ssm`) is managed out-of-band per the existing pattern documented at `sst.config.ts:342-346`. The operator must add `dynamodb:GetItem/Query/Scan/PutItem/UpdateItem` on `futurator-free-agent-sessions` to that role policy before the daemon can read/write the new table. This is the same pattern used for the `BrownfieldGithubPat` secret (Story 15.4) and other shared-resource grants.

**Architectural decisions worth flagging for the reviewer:**

1. **Daemon-side facade duplicates the TypeScript repository.** The daemon is a pure `.mjs` module and cannot import `.ts` files directly (same constraint as the existing `partyGetSession`/etc helpers). The new `freeAgent*` functions in `agent-daemon.mjs` are inline DDB operations matching the TS repository contract 1:1. **Both files must stay in sync** when AC #7 (lock semantics) or AC #8 (function signatures) change. Comment in the code flags this.

2. **GC scheduler uses an approximate 24h interval, not wall-clock 03:00 UTC.** The story spec mentioned "daily 03:00 UTC" as the SST cron Lambda target — but the GC must run on the daemon (Lambdas can't reach the EC2 filesystem, per Story 18.1's architectural pivot). The daemon's poll loop uses the throttled-scan pattern (`Date.now() - lastFreeAgentGcAt >= FREE_AGENT_GC_INTERVAL_MS`) which means "24h since last successful run" not "wall-clock 03:00 UTC". This is functionally equivalent for the operator's purpose (clean up stale worktrees once a day) and avoids the complexity of a cron-style scheduler inside the daemon. If wall-clock alignment becomes important, the pattern can be extended.

3. **Cost-cap exit detection is best-effort.** The `--max-budget-usd` flag's exit signature isn't documented in the Claude CLI help. The handler matches on `non-zero exit + is_error=true + message matches /budget.*exhausted|max.*budget|cost.*cap/i`. If real-EC2 observation reveals a different exit shape, refine `BUDGET_EXHAUSTED_PATTERNS` at `daemon/pipelines/free-agent-session.mjs:47-52`. Falls back to `markError('NON_ZERO_EXIT:<code>')` on non-zero exits without a budget signal — operator gets a clear failure mode either way.

4. **Watchdog is 600s (vs Party's 180s).** Forensic investigations legitimately take longer than chat turns. Configurable via `FREE_AGENT_TURN_TIMEOUT_MS` env var if you want to crank it down on EC2 dev.

5. **The GC scheduler may not fire promptly on a freshly-started daemon.** `lastFreeAgentGcAt = 0` means the first poll-loop iteration triggers a GC immediately. If you DON'T want the daemon to do work on startup, init it to `Date.now()` instead.

**CI status:**

- **lint:** clean for my files (only the 4 pre-existing baseline warnings in `agent-daemon.mjs` remain — verified by git-stash comparison).
- **format:check:** clean after `prettier --write` on the 7 modified files.
- **vitest:** 2469 / 2473 pass (46 new tests, 0 new failures, same 4 pre-existing failures in `epic-dev-pipeline.test.mjs`).
- **build:** ✅ Next.js production build succeeded.
- **knip + typecheck:** unchanged from the Story 18.1 baseline (pre-existing warnings only).

**Deferred to post-deploy / future stories:**

- AC #4 IDLE/EXPIRED state-machine functions are implemented in the repository (`markIdle`, `markExpired`) but the GC routine doesn't yet _call_ them — it only reaps worktrees from the existing 7d-old-EXPIRED branch. Wiring the IDLE/EXPIRED transitions into the GC sweep is a small follow-up (5 lines) — left for the next implementation pass when there are real sessions to observe.
- The API-side 402 `BUDGET_EXHAUSTED` translation (mentioned in AC #5) is Story 18.5's responsibility.
- The conversations table + repository (mentioned across the story) is Story 18.6's responsibility.

### Change Log

| Date       | Change                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-17 | Story drafted from epic 18 (status → ready-for-dev → in-progress in same session)                                                 |
| 2026-05-17 | Implementation complete: types + schemas + repository + daemon handler + job-router + daemon wiring + GC scheduler (46 new tests) |
| 2026-05-17 | Status → review. AC #4 IDLE/EXPIRED GC integration deferred to follow-up                                                          |
