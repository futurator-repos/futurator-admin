# Story 20.10: `DELETE /api/party/sessions/:id` cascade route

Status: TODO
Depends on: 20.9 (party cleanup helpers)

## Story

As the operator deleting a party session,
I want a single API call that archives the branch, drops the live branch, reaps the worktree, reports residual commits, cleans inline questions, and removes the session row — returning a structured per-step result,
so that deleting a session is a single click in the UI with full observability of what landed and what didn't.

## Acceptance Criteria

1. New route in `functions/api/index.ts`: `DELETE /api/party/sessions/:id`, auth-required.
2. Pre-flight: load the session. 404 if absent. Refuse with 409 `SESSION_BUSY` if `status === 'PROCESSING'` (mirror the existing `/api/migrations/:id` semantics).
3. Cascade steps (each best-effort; failures land in `results[]` but don't abort the cascade):
   1. `archivePartyBranch` — push to `archive/party/<app>/<sid>`, then drop the live branch
   2. `cleanupPartyBranch` — defensive double-drop (idempotent if (1) already dropped)
   3. `reapPartyWorktree` — `git worktree remove --force` + `rm -rf`
   4. `countResidualPartyCommits` — informational (operator may have merged a PR with this Session-Id)
   5. `inlineQuestionsRepo.deleteBySession(sessionId)` — DDB cleanup for the unified inbox
   6. `partySessionsRepo.deleteSession(sessionId)` — final row delete
4. Response shape: `{ deleted: true, sessionId, results: CleanupStep[] }` matching the Phase 1 plan-delete shape.
5. Settings.json cleanup: if `/tmp/party-settings-<sid>.json` exists, `rm` it (the file is per-session and outside the worktree).
6. Audit event: `party.session.deleted` with operator id, session id, and the `results[]` summary written to `futurator-agent-events`.
7. Tests (`functions/api/__tests__/party-session-delete.test.ts`):
   - Happy path: all steps return done → response has 6 done steps
   - Missing session → 404
   - Session in PROCESSING → 409 `SESSION_BUSY`
   - One step errors (mock helper failure) → cascade continues, response has that step as `error` + others as `done`
   - Residual commits found → step status `done` with sample SHAs in detail
8. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Route handler (AC: 1, 2, 3)
- [ ] Task 2: Response shape (AC: 4)
- [ ] Task 3: Settings.json cleanup (AC: 5)
- [ ] Task 4: Audit event (AC: 6)
- [ ] Task 5: Tests (AC: 7)
- [ ] Task 6: Typecheck (AC: 8)

## Dev Notes

- The shape parallels Phase 1's `DELETE /api/plans/:id` cascade. Use that handler as the template.
- The `SESSION_BUSY` check uses the existing `hasProcessingSession` repo function (used by `DELETE /api/migrations/:id`).
- Per `plan.md` §10.7 + §11.3.8.
- This route's existence does NOT automatically wire it to the UI — Epic 22 builds the per-session delete button. Until then, operators can call it from `curl` / Postman.
