# Story 20.6: Per-session party worktree setup (`setupPartyWorktree`)

Status: DONE (2026-05-21)
Depends on: 19.4 (PartySession has worktreePath field), 20.5 (bootstrap topology check)

## Story

As the daemon creating a new party session,
I want a `setupPartyWorktree({ projectId, sessionId })` helper that creates `/home/ubuntu/worktrees/<projectId>/_party/<sessionIdShort>/` checked out on `party/<projectId>/<sessionIdShort>` branch (off main),
so that each debate runs in an isolated worktree without contending with the legacy `/home/ubuntu/projects/<projectId>/` shared worktree.

## Acceptance Criteria

1. New function exported from `daemon/pipelines/lib/party-worktree.mjs` (new file):
   - `setupPartyWorktree({ projectId, sessionId }) → Promise<{ worktreePath, branch, created: boolean }>`
2. Behavior:
   - Compute `sessionIdShort = sessionId.slice(0, 8)`
   - Compute `worktreePath = /home/ubuntu/worktrees/<projectId>/_party/<sessionIdShort>`
   - Compute `branch = party/<projectId>/<sessionIdShort>`
   - If `worktreePath` already exists AND the worktree's `HEAD` is on `branch`: return `{ created: false }` (idempotent reuse)
   - If `worktreePath` exists but wrong branch (defensive cleanup): `git worktree remove --force` + `rm -rf`, then recreate
   - Otherwise: `mkdir -p` the parent + `git --git-dir=/home/ubuntu/repos/<projectId>.git worktree add -B <branch> <worktreePath> main` (creates the branch off main)
3. All git invocations use `sudo -u ubuntu` (parity with `story-worktree.mjs` from Phase 1).
4. Throws `BootstrapError('WORKTREE_SETUP_FAILED', <stderr>)` on git failure; caller decides whether to abort the session or retry.
5. **No node_modules symlink**: party debates don't run `npm test`, so the node_modules store from Phase 1 is irrelevant. Worktree disk cost is ~5–10 MB.
6. After successful setup, the caller (`party-bootstrap.mjs` or `party-turn.mjs` first-turn path) calls `partySessionsRepo.setWorktreePath(sessionId, worktreePath)` to persist the path on the session row.
7. Test (`daemon/pipelines/lib/__tests__/party-worktree.test.mjs`):
   - Fresh setup against a fixture bare repo → worktree created, branch is on `party/...`
   - Idempotent re-call against the same session → `created: false`, no error
   - Wrong-branch recovery → worktree removed + recreated
   - Bare repo missing → throws `WORKTREE_SETUP_FAILED` (defensive fallback if Story 20.5's check is bypassed)
8. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Write `setupPartyWorktree` (AC: 1–5)
- [ ] Task 2: Caller-side persistence (AC: 6) — wire into the bootstrap flow
- [ ] Task 3: Tests (AC: 7)
- [ ] Task 4: Typecheck (AC: 8)

## Dev Notes

- The helper file is named `party-worktree.mjs` (singular) vs Phase 1's `story-worktree.mjs` to keep the naming parallel.
- Per `plan.md` §11.3.1 second-half — this is the per-session function that runs ONCE per session lifetime (at bootstrap or first-turn detection).
- `bareRepoPath()` from `daemon/lib/story-worktree.mjs` is reusable here for the bare repo path computation.
