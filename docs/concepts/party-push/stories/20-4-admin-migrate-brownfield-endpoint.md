# Story 20.4: `POST /api/admin/migrate-brownfield/:projectId` endpoint

Status: TODO
Depends on: ship-blocker §12.3.3 resolved (recommended: explicit admin action)

## Story

As the operator,
I want an explicit admin endpoint to convert a brownfield project's working-tree clone to the bare+worktree topology (`/home/ubuntu/repos/<projectId>.git` + `/home/ubuntu/projects/<projectId>` as a worktree),
so that I can run the migration during a quiet window (no active sessions, no active plans, no dirty tree) rather than have it surprise me as a side-effect of "Start Debate."

## Acceptance Criteria

1. New route in `functions/api/index.ts`: `POST /api/admin/migrate-brownfield/:projectId`, auth-required.
2. Pre-flight checks (all must pass; any failure returns 409 `BROWNFIELD_CONVERT_BLOCKED` with a detailed reason):
   - Project is brownfield (`partyProjectsRepo.getProject(projectId).kind === 'brownfield'`)
   - No active pipeline-v2 plans on this app (`listActivePlansByApp(projectId).length === 0`)
   - No active free-agent sessions on this project
   - No active party sessions on this project (`hasProcessingSession(projectId) === false`)
   - Working tree at `/home/ubuntu/projects/<projectId>/` is clean (`git status --porcelain` empty) — confirmed via SSM
3. On all checks pass: spawn a `migrate-brownfield` job (new `jobType` if needed, or inline SSM script via the API) that:
   - Bare-clones the GitHub repo to `/home/ubuntu/repos/<projectId>.git` using the existing PAT
   - Removes the old working-tree clone at `/home/ubuntu/projects/<projectId>/`
   - Runs `git worktree add /home/ubuntu/projects/<projectId> <gitBranch>` from the bare repo
   - Verifies the new working tree's HEAD matches the pre-conversion HEAD (no content change, only topology)
   - Returns a structured result `{ converted: true, bareRepoPath, worktreePath, headSha }`
4. **Idempotent**: if `/home/ubuntu/repos/<projectId>.git` already exists AND the existing `/home/ubuntu/projects/<projectId>/` is already worktree-attached to it, return `{ converted: false, reason: 'already-bare-topology', headSha }` with 200.
5. On any failure mid-conversion: leave the original working tree intact (don't half-convert), emit `brownfield-migrate-failed` attention item, return 500.
6. Audit: every conversion logs to a new DDB row in `futurator-admin-audits` (existing table, see `migrate-module` for shape) with operator id + timestamp + result.
7. Manual test: run against `applicator` during a confirmed quiet window. Verify:
   - Pre: `ls /home/ubuntu/projects/applicator/.git` shows a directory
   - Post: `ls /home/ubuntu/projects/applicator/.git` shows a file (worktree pointer) + `ls /home/ubuntu/repos/applicator.git` shows a bare repo
   - `git log` inside the worktree shows the same HEAD as before
8. UI exposure: add a button to the `/migrate` per-project card "Convert to worktree topology" that POSTs this endpoint. Disabled if pre-flight checks would fail (UI calls a GET endpoint for status check first).

## Tasks / Subtasks

- [ ] Task 1: Implement the endpoint (AC: 1, 2, 3)
- [ ] Task 2: Idempotence check (AC: 4)
- [ ] Task 3: Failure rollback (AC: 5)
- [ ] Task 4: Audit logging (AC: 6)
- [ ] Task 5: Add UI button + status check endpoint (AC: 8)
- [ ] Task 6: Manual test on `applicator` after operator approves a quiet window

## Dev Notes

- This story exists because of ship-blocker §12.3.3. Free Explorer §13.7 recommends explicit admin action; operator confirms in `status.md` before this story starts.
- The actual conversion logic is the same shell sequence sketched in `plan.md` §11.3.1 — that sketch was for "implicit conversion at bootstrap time"; this story is just exposing it via an admin endpoint with the §12.1.4 guard built-in instead of after-the-fact.
- The `snake-4` project is already bare-topology from greenfield bootstrap; running this endpoint against snake-4 hits the idempotence early-return.
- This story is a prerequisite for Story 20.5 (party-bootstrap refusing to start a debate on a non-bare-topology project) — the operator must convert each brownfield once before first debate.
