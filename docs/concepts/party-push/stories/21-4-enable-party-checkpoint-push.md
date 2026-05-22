# Story 21.4: Enable party-checkpoint.sh push step (gated)

Status: DONE (2026-05-22)
Depends on: 21.1, 21.2, 20.2 (party-checkpoint.sh body)

## Story

As the daemon, when the operator opts a project into push (Story 21.2) AND the global kill-switch is set, I want `party-checkpoint.sh` to actually push the party branch to GitHub at round-end, so checkpoints flow to the remote and downstream automation (other agents, CI) can pick them up.

## Acceptance Criteria

1. `party-checkpoint.sh` accepts a `--push` positional flag and reads `PARTY_PUSH_ENABLED` env. Push runs ONLY when both are true.
2. Exit code 5 (new): push attempted but failed (commit DID land locally; daemon emits `party.checkpoint.failed` with `pushed: false`).
3. Stderr classifies push failures: AUTH_DENIED / NETWORK / BRANCH_PROTECTED / OTHER (never echoes the token-bearing output verbatim).
4. Stdout on success: `PUSHED: origin <branch> @ <sha>` followed by the SHA on its own line.
5. Stdout when skipped: `PUSH_SKIPPED: <reason>` (env-off or flag-absent).
6. `party-turn.mjs` post-extraction block:
   - Resolves `project.pushEnabled` via `getProject(session.projectId)`.
   - Composes commit via `composeAgentCommit({ kind: 'party', ... })`.
   - Spawns the script with `--push` iff `pushEnabled === true`.
   - Maps exit code → event type: 0+push → `party.checkpoint.pushed`; 0 → `.composed`; 2 → `.blocked`; else → `.failed`.
7. Tests: 4 new push-gating tests in `party-checkpoint.test.mjs`; 6 new tests in `party-turn-checkpoint.test.mjs` covering the event-emit branches.

## Notes

- Story 20.2's `PUSH_DEFERRED` line is replaced by `PUSH_SKIPPED`. The existing happy-path test is updated to match.
- Two-gate design (env + flag): the env kill-switch lets the operator instantly disable ALL pushes (e.g., during a security incident) without touching DDB.
