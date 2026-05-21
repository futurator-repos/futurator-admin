# Story 20.9: Plan-folder-service party-\* cascade helpers

Status: TODO
Depends on: 19.4 (PartySession has worktreePath)

## Story

As the API layer wiring the party-session delete cascade,
I want `plan-folder-service.ts` (currently the home of `cleanupPlanBranch` / `reapPlanStoryWorktrees` / `countResidualPlanCommits` from Phase 1) to gain a parallel set of party-\* helpers,
so that the cascade composition in Story 20.10 + Story 20.11 reads as "one helper per logical concern" instead of inline shell-script generation.

## Acceptance Criteria

1. `functions/shared/services/plan-folder-service.ts` exports four new functions, each returning a `CleanupStep`:
   - `cleanupPartyBranch({ workingDirSlug, sessionIdShort }, deps)` — drops the local + remote `party/<projectId>/<sessionIdShort>` branch
   - `archivePartyBranch({ workingDirSlug, sessionIdShort }, deps)` — soft-delete: push the branch to `archive/party/<projectId>/<sessionIdShort>` BEFORE deletion (per `plan.md` §2.4 + Free Explorer §9.4)
   - `reapPartyWorktree({ workingDirSlug, sessionIdShort }, deps)` — `git worktree remove --force` + `rm -rf` the per-session worktree path
   - `countResidualPartyCommits({ workingDirSlug, sessionId }, deps)` — `git log <ref> --grep="Session-Id: <full-uuid>"` against main, returns count + sample SHAs
2. All four use the existing `PlanFolderDeps` shape (no new dependency types).
3. Each is best-effort + idempotent — missing branch / missing worktree / no residual commits → returns `{ status: 'skipped', detail: 'nothing-to-do' }` not an error.
4. **SSM shell scripts run as `sudo -u ubuntu`** (parity with the existing `cleanupPlanBranch`).
5. **Branch name composition**: takes `<workingDirSlug>` (= `appId`) and `<sessionIdShort>` (= 8-char prefix). Per `plan.md` §10.2's branch namespace.
6. `archivePartyBranch` semantics:
   - `git push origin party/<app>/<sid>:refs/heads/archive/party/<app>/<sid>` — fast-forward archive
   - `git push origin --delete party/<app>/<sid>` — drop the live branch
   - If archive fails (network blip): don't drop the live branch. Return `{ status: 'error', detail: 'archive-failed; live branch preserved' }`. The cascade caller decides whether to retry or surface to the operator.
7. Unit tests (`functions/shared/services/__tests__/party-cleanup-helpers.test.ts`):
   - Each helper has a happy-path test (mocked SSM)
   - Each helper has a "nothing-to-do" test (verify graceful skip)
   - `archivePartyBranch`: simulate archive-fail, assert live branch preserved
8. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Write the four helpers (AC: 1, 2, 3, 4, 5)
- [ ] Task 2: `archivePartyBranch` archive-then-drop semantics (AC: 6)
- [ ] Task 3: Tests (AC: 7)
- [ ] Task 4: Typecheck (AC: 8)

## Dev Notes

- Mirror the existing Phase 1 helpers (`cleanupPlanBranch` etc.) — same shape, same error-handling, same `CleanupStep` return type.
- `countResidualPartyCommits` searches for `Session-Id: <full-uuid>` (not `<sessionIdShort>` — the trailer always carries the full UUID per `agent-commit-composer`).
- This story is pure substrate. Stories 20.10 + 20.11 wire the helpers into the actual cascade routes.
- See `plan.md` §10.7 + §11.3.7.
