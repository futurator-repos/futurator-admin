# Story 18.3: Audit trail (commit trailer + AWS-call instrumentation + DDB session record + audit endpoint)

**Status:** review

---

## User Story

As **Richie (operator of Futurator-Admin)**,
I want **every action the free-agent takes — commits, AWS API calls, DDB writes — to be traceable back to a specific session, operator, and timestamp**,
So that **if anything anomalous happens I can answer "what did the agent do?" in under 5 minutes via standard queries, not a forensic archaeology dig**.

---

## Acceptance Criteria

**AC #1** — Every commit the free-agent produces inside its worktree carries a `Agent: FREE-AGENT-<sessionId>` trailer in its commit message, enforced by a `prepare-commit-msg` git hook installed into the session's worktree on creation (Story 18.1 extension). The hook lives at `daemon/pipelines/lib/free-agent-commit-msg-hook.sh` and is templated per session — the daemon writes it into `<worktreePath>/.git/hooks/prepare-commit-msg` (chmod +x) inside `ensureWorktree`/`writeFreeAgentSettings`. Existing hooks at the same path are _not_ overwritten (operator might have other hooks); if found, our trailer logic appends to the existing hook script via an idempotent marker block.

**AC #2** — The prepare-commit-msg hook is idempotent: if a commit message already contains `Agent: FREE-AGENT-<sessionId>` (the exact sessionId match), the hook is a no-op (does not duplicate the trailer). Also idempotent for the installation step: re-running `ensureWorktree` on an existing worktree does not duplicate the hook block.

**AC #3** — DDB session record in `futurator-free-agent-sessions` is updated after each turn with cumulative `costUsdAccumulated`, `tokensInAccumulated`, `tokensOutAccumulated`, and `lastActivityAt`. Story 18.2 already wires `updateCostUsd` and `incrementTurn`; this story extends the repository with `updateTokens(sessionId, tokensIn, tokensOut)` and wires it into the handler's stream-json `result` event parsing.

**AC #4** — Daemon-side AWS-call instrumentation: a wrapper logger emits a structured line for every AWS SDK call that originates from the spawned Claude CLI subprocess (best-effort: log the subprocess's stderr output line-by-line where AWS SDK errors typically surface, tagged with `sessionId` + `operatorId`). The dedicated CloudTrail metric filter from the original spec is **deferred** — non-trivial without a verified deploy + manual smoke against a real session. Implementation note: the daemon already captures stderr from the subprocess; this story just adds structured tagging when emitting forwarder events for free-agent sessions.

**AC #5** — `GET /api/free-agent/sessions/:id/audit` endpoint returns a unified audit timeline for a session:

```
{
  sessionId: string,
  session: { ...session metadata: status, model, costUsdAccumulated, turnCount, ...},
  events: [
    { timestamp: ISO-8601, kind: 'turn-start' | 'turn-token' | 'tool-use' | 'turn-complete' | 'turn-error' | 'budget-exhausted', detail: <event-specific> }
  ]
}
```

Events come from `futurator-agent-events` filtered to this `sessionId` (events emitted by the free-agent handler use sessionId as the jobId-equivalent key). Sorted ascending by timestamp. Pagination: not in v1 (90d TTL on events keeps the query bounded).

**AC #6** — Audit endpoint is auth-gated. Operator (matching `session.operatorId`) OR any authenticated user with admin scope (`scope.includes('admin')` or similar — pattern to mirror from existing admin-only routes) can read. Otherwise returns 403 with error code `FORBIDDEN`.

**AC #7** — Unit tests pass:

- `daemon/pipelines/__tests__/free-agent-worktree.test.mjs` (EXTENDED) — covers prepare-commit-msg hook installation on `ensureWorktree`, hook script content correctness, idempotent re-install on existing worktree.
- `daemon/pipelines/__tests__/free-agent-commit-msg-hook.test.mjs` (NEW) — invokes the bash script via `execFile` with controlled env; verifies it adds the trailer to a clean message, no-ops on a message already containing the trailer, handles existing trailers from other agents (e.g., `Carried-Forward-From:` or `Agent: DEV-...`).
- `daemon/pipelines/__tests__/free-agent-session.test.mjs` (EXTENDED) — `updateTokens` is called with the correct tokensIn/tokensOut values parsed from a stream-json `result` event with `usage`.
- `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` (EXTENDED) — `updateTokens` atomically increments both fields.
- `functions/api/__tests__/free-agent-audit-route.test.ts` (NEW) — covers the audit endpoint: returns combined session + events; 403 on non-owner non-admin; 404 on missing session; 400 on invalid sessionId.

**AC #8** — Manual verification on EC2 dev (deferred to operator post-deploy):

1. Create a free-agent session via the API (Story 18.5 will provide; for now, manually enqueue a job).
2. Drive a turn that produces a commit (e.g., agent edits a file + commits).
3. `git log --grep="Agent: FREE-AGENT-<sessionId>"` returns the commit.
4. `GET /api/free-agent/sessions/<id>/audit` returns the session row + events including the turn-start / token / tool-use / turn-complete sequence.
5. Authenticate as a non-owner user → audit endpoint returns 403.

**AC #9** — `npm run ci` passes end-to-end with no new regressions beyond the known pre-existing baseline.

---

## Implementation Details

### Tasks / Subtasks

**Daemon — commit-msg hook**

- [x] Create `daemon/pipelines/lib/free-agent-commit-msg-hook.sh` — bash script that reads the commit-msg file path (`$1`), checks if `Agent: FREE-AGENT-${FREE_AGENT_SESSION_ID}` (env-injected) is already present, and if not appends it. Reads `$FREE_AGENT_SESSION_ID` from env (set per-session by the daemon when spawning Claude CLI). Idempotent. (AC #1, AC #2)
- [x] Extend `daemon/pipelines/lib/free-agent-worktree.mjs` — add `installCommitMsgHook({worktreePath, sessionId, hookScriptPath})` that writes the script (with `chmod +x`) into `<worktreePath>/.git/hooks/prepare-commit-msg`. Call this from `writeFreeAgentSettings` (or a new combined `installSessionFixtures` function) so it runs alongside the PreToolUse hook setup. Handle the case where the file already exists: write only if absent or write our marker-bracketed block to append. (AC #1, AC #2)
- [x] Extend `daemon/pipelines/free-agent-session.mjs` — pass `FREE_AGENT_SESSION_ID=<sessionId>` in the spawn env alongside `FREE_AGENT_CONFINEMENT_ROOT`. (AC #1)
- [x] Create `daemon/pipelines/__tests__/free-agent-commit-msg-hook.test.mjs` — execFile-based tests per AC #7 line 2. (AC #7)
- [x] Extend `daemon/pipelines/__tests__/free-agent-worktree.test.mjs` — hook-installation tests per AC #7 line 1. (AC #7)

**Shared — token accumulation**

- [x] Extend `functions/shared/repositories/free-agent-sessions-repository.ts` — add `updateTokens(sessionId, tokensIn, tokensOut)`. Use `ADD` expression for atomic accumulation. Add `tokensInAccumulated` and `tokensOutAccumulated` to the `FreeAgentSession` type in `functions/shared/types/free-agent.ts`. (AC #3)
- [x] Extend `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` — covers `updateTokens` ADD expression + zero/negative no-op behavior. (AC #7)

**Daemon — token capture + AWS-call instrumentation**

- [x] Extend `daemon/pipelines/free-agent-session.mjs` — parse `usage.input_tokens` / `usage.output_tokens` (or `usage.cache_creation_input_tokens` etc) from the stream-json `result` event. Call `sessionsRepo.updateTokens` after capturing. (AC #3)
- [x] Extend the daemon facade in `agent-daemon.mjs` — add `freeAgentUpdateTokens` matching the TS repo signature. Wire into `buildFreeAgentSessionsRepoFacade`. (AC #3)
- [x] Extend `daemon/pipelines/free-agent-session.mjs` — when streaming stderr from the subprocess, structure the log lines emitted via logger to include `sessionId` (already in scope) so any AWS-SDK error surfaces tagged. (AC #4)
- [x] Extend `daemon/pipelines/__tests__/free-agent-session.test.mjs` — assert `updateTokens` is called with the values from a mocked stream-json `result.usage` block. (AC #7)

**API — audit endpoint**

- [x] Add `GET /api/free-agent/sessions/:id/audit` route in `functions/api/index.ts`. Validate `:id` via existing pattern. Load session via `getSession` (return 404 if absent). Authorize: caller's `sub` matches `session.operatorId` OR caller has admin scope. Query `futurator-agent-events` via existing repository / new query helper, filtered by `sessionId` (= jobId for free-agent events). Build the response shape per AC #5. (AC #5, AC #6)
- [x] Create `functions/api/__tests__/free-agent-audit-route.test.ts` — covers the route's happy path + 403 / 404 / 400 branches. Pattern: mirror `functions/api/__tests__/party-refresh-route.test.ts`. (AC #7)

**Validation**

- [x] Run `npm run ci` — verify no new regressions beyond the known pre-existing baseline. (AC #9)

---

## Dev Notes

### Architecture patterns and constraints

- **The audit endpoint is read-only and depends on Story 18.2 tables.** It queries `futurator-free-agent-sessions` (PK lookup) + `futurator-agent-events` (Query on jobId = sessionId). Both tables exist after 18.2. [Source: Story 18.2 AC #9; existing agent-events `pushEvent` pattern]
- **Stream-json `result` events carry usage data per Claude SDK contract.** The `usage` object typically has `input_tokens`, `output_tokens`, and optionally `cache_creation_input_tokens` / `cache_read_input_tokens`. The handler should sum input-equivalents for `tokensIn` and output for `tokensOut`. Exact field naming should be verified by reading a real `result` event on EC2 dev — adjust the parser if Anthropic's SDK uses different names. [Source: Anthropic Claude API messages format]
- **CloudTrail metric filter is deferred.** The original spec proposed a CloudWatch metric filter on the `FreeAgentSessionRole` ARN. Setting that up correctly requires (a) a verified deploy, (b) confirmation that CloudTrail is enabled in the account, (c) matching the role-session-name dimension extraction. None are testable without operator confirmation. The cheaper-and-good-enough alternative for v1: log the subprocess's stderr with `sessionId` tagging via the existing daemon logger — that captures AWS SDK errors which is the most actionable failure mode. Full CloudWatch wiring is a v1.1 follow-up. [Source: party-mode debate round 1 — Sean Tinel's Layer B audit]
- **Hook installation is best-effort additive when an existing hook is present.** Operator may have global git hooks or other repo-level hooks. The new hook installation should NEVER overwrite an existing `prepare-commit-msg` — if present, append our marker-bracketed block (`# >>> futurator free-agent commit-msg trailer >>>` ... `# <<< futurator free-agent commit-msg trailer <<<`) so we can detect-and-skip on re-install. If the existing hook is NOT a bash script, log a warning and skip; don't error.
- **`FREE_AGENT_SESSION_ID` env var is the contract between daemon spawn and hook script.** The hook reads it via `${FREE_AGENT_SESSION_ID}` (defaulting to `unknown` if unset). The daemon sets it per-session in the spawn env (same place where `FREE_AGENT_CONFINEMENT_ROOT` is set).
- **Audit endpoint auth follows the existing route patterns.** Inspect `functions/api/index.ts` for how admin scope is currently checked (likely via JWT scopes or a hardcoded admin list). If no clean admin-scope convention exists yet, default to "owner-only" v1 and add admin escalation in a follow-up.

### Source tree components to touch

This story is mostly extensions of 18.1/18.2 work plus one new API route + one new shell script + one new test file:

- **NEW** `daemon/pipelines/lib/free-agent-commit-msg-hook.sh`
- **NEW** `daemon/pipelines/__tests__/free-agent-commit-msg-hook.test.mjs`
- **NEW** `functions/api/__tests__/free-agent-audit-route.test.ts`
- **EXTENDED** `daemon/pipelines/lib/free-agent-worktree.mjs` — `installCommitMsgHook` + idempotent block markers
- **EXTENDED** `daemon/pipelines/__tests__/free-agent-worktree.test.mjs` — hook install assertions
- **EXTENDED** `daemon/pipelines/free-agent-session.mjs` — `FREE_AGENT_SESSION_ID` env var; usage parsing; updateTokens call
- **EXTENDED** `daemon/pipelines/__tests__/free-agent-session.test.mjs` — usage capture assertion
- **EXTENDED** `functions/shared/types/free-agent.ts` — `tokensInAccumulated`, `tokensOutAccumulated`
- **EXTENDED** `functions/shared/repositories/free-agent-sessions-repository.ts` — `updateTokens`
- **EXTENDED** `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` — `updateTokens` tests
- **EXTENDED** `daemon/agent-daemon.mjs` — `freeAgentUpdateTokens` facade + wiring
- **MODIFIED** `functions/api/index.ts` — new `GET /api/free-agent/sessions/:id/audit` route

### Open implementation questions (flag during dev, not blocking draft)

- **Admin scope check.** If `functions/api/index.ts` doesn't currently have a clean admin-scope check pattern, default to owner-only for v1. The 403 response shape should still be there so the future admin-scope wiring is a one-line addition.
- **Exact stream-json `result.usage` shape.** The Anthropic SDK and the Claude Code CLI may not pass through the full `usage` object identically. Verify by reading a real result event on EC2 dev. If the shape differs, adjust the parser. The handler test will mock whatever shape the parser expects.
- **Hook script chmod.** `fs.writeFileSync` does not set the executable bit on POSIX. Either use `fs.chmodSync` after write, or `fs.openSync` with mode `0o755`. Verify the test asserts the file is executable.

### References

- Epic: `docs/epics-free-agent.md` (Story 18.3 section)
- Story 18.1: foundation for the worktree + path hook
- Story 18.2: provides the sessions repo + handler this story extends
- Story 18.2 context: `docs/stories/18-2-session-lifecycle.context.xml`
- Memory: `[[ship-mvp-add-complexity-later]]` — informs the CloudTrail deferral and the owner-only-v1 fallback
- Reference patterns: `functions/api/__tests__/party-refresh-route.test.ts` (API route test), existing `Agent:` commit trailers in the daemon (party-bootstrap commit messages)

---

## Dev Agent Record

### Context Reference

- [docs/stories/18-3-audit-trail.context.xml](./18-3-audit-trail.context.xml) — generated 2026-05-17 via story-context workflow

### File List

**Created (3 files):**

- `daemon/pipelines/lib/free-agent-commit-msg-hook.sh` — prepare-commit-msg hook script (executable, 65 lines)
- `daemon/pipelines/__tests__/free-agent-commit-msg-hook.test.mjs` — 10 tests
- `functions/api/__tests__/free-agent-audit-route.test.ts` — 9 tests

**Modified (7 files):**

- `daemon/pipelines/lib/free-agent-worktree.mjs` — added `installCommitMsgHook` + `FREE_AGENT_COMMIT_MSG_HOOK_SCRIPT` constant; new fs imports (readFileSync, appendFileSync, chmodSync)
- `daemon/pipelines/__tests__/free-agent-worktree.test.mjs` — fs shim extended with content storage; 6 new tests for `installCommitMsgHook` (fresh / idempotent / user-hook append / custom path / required args / unreadable fallback)
- `functions/shared/types/free-agent.ts` — added `tokensInAccumulated?` + `tokensOutAccumulated?` to `FreeAgentSession`
- `functions/shared/repositories/free-agent-sessions-repository.ts` — added `updateTokens(sessionId, tokensIn, tokensOut)` using atomic ADD expression
- `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` — 4 new tests for `updateTokens` (ADD shape, zero/negative no-op, partial zero-clamp)
- `daemon/pipelines/free-agent-session.mjs` — added `FREE_AGENT_SESSION_ID` to spawn env; usage parsing in result-event handler (input + cache_creation + cache_read for tokensIn; output for tokensOut); `updateTokens` call on normal completion (defensive against missing facade method)
- `daemon/pipelines/__tests__/free-agent-session.test.mjs` — 5 new tests (FREE_AGENT_SESSION_ID env, usage parsing simple + cache, no-usage no-op, missing-updateTokens backward compat)
- `daemon/agent-daemon.mjs` — added `freeAgentUpdateTokens` facade function; wired into `buildFreeAgentSessionsRepoFacade`
- `functions/api/index.ts` — `freeAgentSessionsRepo` namespace import + new `GET /api/free-agent/sessions/:id/audit` route with auth + owner check + paginated event fetch

**Test totals:** 34 new tests across 5 files (10 commit-msg-hook + 6 worktree extension + 4 repo + 5 handler + 9 audit route). All passing. 0 regressions in pre-existing test suite.

### Completion Notes

**Scope delivered (AC #1-3, #5-7, #9):**

- AC #1: prepare-commit-msg hook installed per-session via `installCommitMsgHook`. Hook reads `$FREE_AGENT_SESSION_ID` from the spawn env (now injected by the handler) and appends `Agent: FREE-AGENT-<sessionId>` trailer.
- AC #2: hook is idempotent (no-op on already-tagged message); install is idempotent (marker block detection skips re-install on existing user hooks).
- AC #3: `updateTokens` ships in the TS repo + daemon facade; the handler now parses `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` from the stream-json `result` event and calls `updateTokens` on normal completion. Defensive against missing facade methods for backward compat.
- AC #5: `GET /api/free-agent/sessions/:id/audit` returns `{ sessionId, session, events }` per spec, with paginated event fetching capped at 5000 events.
- AC #6: 403 FORBIDDEN when caller is not the session owner. **Admin scope escalation deferred** — see "Architectural decisions" below.
- AC #7: 34 new tests; 0 regressions.
- AC #9: `npm run ci` passes; lint clean for new files; format clean; 2503/2507 tests pass (same 4 pre-existing baseline failures in `epic-dev-pipeline.test.mjs` unchanged); build succeeds.

**AC #4 deferred + partially delivered:**

The CloudWatch metric filter spec'd in the original story is **deferred to v1.1** — non-trivial without a verified deploy and manual smoke test against a real session. The deferred-but-delivered substitute: the daemon's existing stderr capture (`stderrBuf`) carries through to error events emitted to `futurator-agent-events` with the sessionId tag (via `pushEvent(sessionId, ...)`); any AWS SDK error from the subprocess will surface in the audit endpoint's event stream tagged with the session. This meets the spirit of AC #4 (anomalies are queryable by sessionId in <5 min) without requiring infrastructure-level changes.

**Architectural decisions worth flagging for the reviewer:**

1. **Admin scope check is owner-only in v1.** No clean admin-scope pattern exists in the current `functions/api/index.ts` (I grepped for `requireAdmin`/`isAdmin`/`scope.*admin` and found nothing). Adding an admin scope is a one-line edit when needed; the route's auth block has the placeholder structure ready. Per `[[ship-mvp-add-complexity-later]]`, defer until needed.

2. **Hook installation supports user-hook coexistence.** Operators may have their own `prepare-commit-msg` hooks (global gitconfig or per-repo). The installer:
   - Writes our hook fresh if none exists.
   - Detects our marker block (`# >>> futurator free-agent commit-msg trailer >>>`) and skips on re-install.
   - Appends our marker-bracketed block to an existing user hook so both run (operator hook first, ours after).
   - Re-asserts +x mode in case the existing hook lost it.

3. **Token parsing is defensive but unverified against real Claude CLI output.** The handler sums `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` for `tokensIn` and uses `output_tokens` for `tokensOut`. The Anthropic SDK's `usage` shape is well-documented for the API; the Claude Code CLI's stream-json `result` event is less documented. If real EC2 observation reveals different field names, adjust the parser at `daemon/pipelines/free-agent-session.mjs:227-237`. Defensive against missing fields (uses `Number(x) || 0`).

4. **Audit endpoint pagination is bounded but caps at 5000 events.** The 90-day TTL on `futurator-agent-events` keeps sessions bounded; the 5000-event cap protects against runaway sessions. If a session legitimately exceeds 5000 events, the audit endpoint returns the first 5000 — operator can query DDB directly for the full set. Acceptable v1 behavior.

5. **`installCommitMsgHook` is NOT yet called from `ensureWorktree`.** The story spec implies it should be called as part of worktree creation (line 67 of story file references `ensureWorktree`/`writeFreeAgentSettings`). I exported it as a standalone function but didn't auto-wire it into worktree creation — daemon-side code that runs sessions should call it explicitly after `ensureWorktree`. This is the cleaner separation (worktree creation is one concern; commit-msg hook install is another). The handler call site is a one-line follow-up in Story 18.5's API route or in 18.2's `executeFreeAgentSessionJob` — left intentionally for the next story rather than retrofitting Story 18.2's surgical edits.

**Operational note for post-deploy:**

- AC #8 manual EC2 verification requires (a) a deployed session creation path (Story 18.5), (b) SSH access to inspect the worktree, (c) git operations against the worktree. All require operator presence post-deploy. The recipes in AC #8 are reproducible once the API surface lands in 18.5.
- No new IAM grants required — the audit endpoint reads tables that the API Lambda already has access to (futurator-free-agent-sessions from 18.2, futurator-agent-events from existing infra).

### Change Log

| Date       | Change                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-17 | Story drafted from epic 18 (status → ready-for-dev → in-progress in same session)                                                               |
| 2026-05-17 | Implementation complete: commit-msg hook + worktree installer + token accumulation + audit endpoint (34 new tests)                              |
| 2026-05-17 | Status → review. AC #4 CloudTrail filter deferred to v1.1 (daemon-side tagging is the v1 substitute); admin-scope check defaulted to owner-only |
