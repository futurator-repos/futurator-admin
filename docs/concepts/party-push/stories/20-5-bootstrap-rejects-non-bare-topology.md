# Story 20.5: Party-bootstrap rejects non-bare-topology projects

Status: TODO
Depends on: 20.4 (admin migration endpoint exists)

## Story

As the daemon's party-bootstrap pipeline,
I want to refuse to start a debate on a brownfield project that hasn't been converted to the bare+worktree topology yet,
so that the conversion stays an explicit operator action (Story 20.4) and never surprises someone as a side-effect of clicking "Start Debate."

## Acceptance Criteria

1. `daemon/pipelines/party-bootstrap.mjs` adds a topology check at the start of `runBrownfieldBootstrap`:
   - If `/home/ubuntu/repos/<projectId>.git` does NOT exist, the bootstrap **aborts** with `BootstrapError('TOPOLOGY_NOT_MIGRATED', 'Brownfield project <projectId> has not been converted to bare+worktree topology. Operator must POST /api/admin/migrate-brownfield/<projectId> first.')`
2. The error surfaces in the UI as a `party.bootstrap.step.failed` event with `step: 'topology-check'` and a `suggestedAction: 'run-admin-migrate'` field.
3. Greenfield bootstrap (`app-bootstrap.mjs`) is NOT affected — it already produces the bare+worktree topology.
4. **Compatibility**: existing brownfield sessions (created before this story) on a non-bare topology continue working — the check only fires for NEW session creation.
5. Test (`daemon/pipelines/__tests__/party-bootstrap-topology-check.test.mjs`):
   - Project has no bare repo at expected path → bootstrap fails with `TOPOLOGY_NOT_MIGRATED`
   - Project has the bare repo + working-tree-as-worktree → bootstrap proceeds normally
6. Backward-compat: the UI's "Start Debate" button surfaces the `TOPOLOGY_NOT_MIGRATED` error with an actionable message and a deep-link to the `/migrate` admin page where Story 20.4's button lives.

## Tasks / Subtasks

- [ ] Task 1: Add topology check to `runBrownfieldBootstrap` (AC: 1)
- [ ] Task 2: Emit event with `suggestedAction` (AC: 2)
- [ ] Task 3: Tests (AC: 5)
- [ ] Task 4: UI: surface the error with the deep-link in `src/components/labs/party/.../start-debate-modal.tsx` (AC: 6)

## Dev Notes

- This is the safety guard for §12.3.3. Without it, the implicit-conversion-at-bootstrap path could regress and we'd lose the operator's explicit control.
- Greenfield projects (snake-4 et al.) created post-Phase-1 already have the bare topology — they pass the check trivially.
- See `plan.md` §12.3.3 + Free Explorer §13.7.
