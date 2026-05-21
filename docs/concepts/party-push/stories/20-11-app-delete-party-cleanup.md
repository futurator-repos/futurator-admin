# Story 20.11: App-delete cascade — party-cleanup step

Status: DONE (2026-05-21)
Depends on: 20.9 (party helpers), 20.10 (per-session cascade)

## Story

As the operator deleting an entire App,
I want the existing App-delete cascade (`cleanupAppArtifacts` from Phase 1) to ALSO reap every party session's branches + worktrees BEFORE the folder rm-rf step,
so that no stray `/home/ubuntu/worktrees/<app>/_party/*` directories or `party/<app>/*` branches survive the delete.

## Acceptance Criteria

1. `functions/shared/services/app-artifact-service.ts::cleanupAppArtifacts` gains a new step BEFORE `deleteAppFolder`:
   - `party-cleanup` step iterates `listPartySessionsByProject(appId)`, calls `archivePartyBranch` + `reapPartyWorktree` for each
2. Step result: `{ step: 'party-cleanup', status: 'done', detail: '<N> sessions (<A> archived, <R> reaped)' }` — counts surface in the cascade summary.
3. Best-effort per session: a single session's archive/reap failure doesn't block siblings. Counts reflect successes.
4. New dependency on `AppArtifactDeps`: `listPartySessionsByProject: (appId: string) => Promise<PartySession[]>` — wire to `partySessionsRepo.listSessionsByProject` at the API call site.
5. Test (`functions/shared/services/__tests__/app-artifact-service-party.test.ts`):
   - Mocked listSessionsByProject returns 3 sessions → `party-cleanup` step shows `3 sessions (3 archived, 3 reaped)`
   - One archive fails → status remains `done` (best-effort) with `2 archived`
6. Existing App-delete cascade tests stay green.
7. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Add the `party-cleanup` step to `cleanupAppArtifacts` (AC: 1, 2, 3)
- [ ] Task 2: Extend `AppArtifactDeps` type + wire the dep at the call site (AC: 4)
- [ ] Task 3: Tests (AC: 5)
- [ ] Task 4: Regression: existing App-delete tests stay green (AC: 6)
- [ ] Task 5: Typecheck (AC: 7)

## Dev Notes

- Per `plan.md` §10.7 + §11.3.9. The step lands BEFORE folder rm because folder rm doesn't see worktrees outside `/home/ubuntu/projects/<app>`.
- Branches on GitHub: `archivePartyBranch` pushes to archive AND drops the live branch. When the App-delete then runs `deleteGithubRepo`, the whole repo (archive branches included) is deleted. The archive is meaningful for per-session delete (Story 20.10) but redundant on App-delete; it still runs because it's the cleanest no-special-case path.
- Per `app-artifact-service.ts`, the cascade is sequential — no async-await `Promise.all` needed.
