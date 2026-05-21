# Story 19.4: PartySession type + repo extensions for cancel + worktree

Status: DONE (2026-05-21)

## Story

As an agent-runtime engineer,
I want `PartySession` to carry the new fields that party-push needs (`worktreePath`, `partyBranch`, `cancelRequested`, `cancelRequestedAt`, `updatedAt`),
so that the daemon's worktree setup + reaper + cancel-flow have a stable contract to write/read against.

## Acceptance Criteria

1. `functions/shared/types/party.ts::PartySession` gains optional fields:
   - `worktreePath?: string` — per-session worktree path (post-migration)
   - `partyBranch?: string` — `party/<projectId>/<sessionIdShort>`
   - `cancelRequested?: boolean`
   - `cancelRequestedAt?: string` (ISO 8601)
   - `updatedAt?: string` (ISO 8601)
2. The existing `projectPath` field stays — bootstrap will overwrite it to the worktree path post-migration; legacy sessions keep the original value (`/home/ubuntu/projects/<projectId>`).
3. JSDoc on `projectPath` explicitly notes the legacy-vs-post-migration distinction (per `plan.md` §11.2.4).
4. `functions/shared/repositories/party-sessions-repository.ts` gains three new exports:
   - `setCancelRequested(sessionId: string): Promise<void>` — `SET cancelRequested = true, cancelRequestedAt = now()`
   - `clearCancelFlag(sessionId: string): Promise<void>` — `REMOVE cancelRequested, cancelRequestedAt`
   - `setWorktreePath(sessionId: string, worktreePath: string): Promise<void>` — sets both `worktreePath` AND `projectPath` to the same value (the daemon's spawn cwd reads from `projectPath`)
5. All three functions log via the existing logger pattern; failures throw (caller treats as 500).
6. **Typecheck stays at baseline (≤79 errors).**

## Tasks / Subtasks

- [x] Task 1: Extend `PartySession` interface (AC: 1, 2, 3)
- [x] Task 2: Add `setCancelRequested`, `clearCancelFlag`, `setWorktreePath` to the repo (AC: 4, 5)
- [x] Task 3: Run `npm run typecheck`, confirm baseline maintained (AC: 6) — 4 pre-existing errors in `agent-job-state-machine.ts` + `timer-colors.ts`, none from this story; well under ≤79 baseline
- [x] Task 4: Add brief JSDoc examples to each new function

## Implementation notes (2026-05-21)

- `PartySession` extended with `worktreePath?`, `partyBranch?`, `cancelRequested?`, `cancelRequestedAt?`, `updatedAt?` (all optional — schema migration is a no-op).
- Doc comment on `projectPath` explains the legacy-vs-post-migration distinction so future engineers don't accidentally split-brain the field.
- Repo methods all use `attribute_exists(sessionId)` condition + always-write `updatedAt` ISO timestamp:
  - `setCancelRequested(sessionId)` — `SET cancelRequested = true, cancelRequestedAt = now, updatedAt = now`
  - `clearCancelFlag(sessionId)` — `REMOVE cancelRequested, cancelRequestedAt SET updatedAt = now` (idempotent — REMOVE of missing attr is no-op in DDB)
  - `setWorktreePath(sessionId, worktreePath)` — writes both `worktreePath` AND `projectPath` so the daemon's existing `cwd: session.projectPath` spawn line resolves to the new worktree without code change
- Typecheck after change: 4 errors (all pre-existing, unrelated to party).

## Dev Notes

- `setWorktreePath` writes BOTH fields atomically because `party-turn.mjs:205` reads `session.projectPath` for `cwd`. Keeping the legacy field as the source of truth for the spawn (and adding `worktreePath` as the explicit canonical name for the reaper + delete cascade) means the spawn code doesn't change.
- No DDB schema changes needed — DynamoDB is schemaless, the optional fields land on next write.
- `findBySessionIdShort` is a separate story (19.8) — keep the scope tight here.
