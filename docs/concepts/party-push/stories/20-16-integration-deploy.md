# Story 20.16: Integration test sweep + production deploy

Status: TODO
Depends on: all 20.1–20.15

## Story

As the implementing agent landing Epic 20,
I want a single ordered checklist of integration tests + the deploy commands to run them in,
so that PR 1 ships green and the operator can verify the worktree adoption end-to-end without rediscovering the steps.

## Acceptance Criteria

1. Full test sweep passes:
   - `npx vitest run` (entire suite)
   - Typecheck error count ≤ 79 (baseline)
   - Free-agent regression tests stay green (specifically: `functions/shared/services/__tests__/free-agent-*.test.ts` + `daemon/pipelines/__tests__/free-agent-session*.test.mjs`)
   - Pipeline-v2 regression: `npx vitest run functions/shared/pipelines/__tests__/story-pipeline-baseline.test.ts functions/shared/services/__tests__/wave-reducer.test.ts functions/shared/services/__tests__/plan-reducer.test.ts functions/shared/services/__tests__/pipeline-launcher.test.ts`
2. **`./scripts/rsync-daemon.sh` succeeds**: daemon restarts, log shows `Auth probe: OK`, new classifier files visible (`/opt/futurator-daemon/lib/cancel-poller.mjs`, `/opt/futurator-daemon/pipelines/lib/party-tool-hook.sh`, etc.).
3. **`sst deploy --stage production` succeeds**: AdminSite + API Lambda + cron updated.
4. **End-to-end manual scenario per Epic 20 acceptance**:
   - Create a brownfield project conversion (Story 20.4 endpoint) on a test project
   - Start a party debate on that project — bootstrap creates worktree at the expected path on the expected branch
   - Agent runs a turn, emits `[CHECKPOINT_SUMMARY]:` marker → checkpoint composed + committed (push deferred to Epic 21)
   - Verify `git log` on the party branch shows the commit with full v2.5 §23 trailers + co-authors
   - Concurrently start a pipeline-v2 plan on a DIFFERENT project (or the same one — assertWorktreeClean should pass) — both run without contention
   - Delete the party session via `curl -X DELETE /api/party/sessions/<id>` — response shows 6 cascade steps
   - Verify worktree gone, archive branch present, live branch dropped, session row gone
   - Trigger orphan reaper (via SSM `systemctl restart futurator-daemon`) — confirm `party N/M` line in summary
5. Hook adversarial smoke (manual): inside a running party session, ask the agent to attempt `git push origin party/x` via Bash. Hook denies with `DENIED: git mutation not allowed...`. Confirm event `party.tool.default-allow` does NOT fire (it's a hard-deny, not a fall-through).
6. **No regressions** in free-agent OR pipeline-v2 surfaces visible in the UI.
7. Final commit lands with a multi-line message describing what shipped (PR 0 + PR 1, story list, op blockers resolved before merge).

## Tasks / Subtasks

- [ ] Task 1: Full test sweep (AC: 1)
- [ ] Task 2: Rsync daemon (AC: 2)
- [ ] Task 3: Deploy Lambda + cron (AC: 3)
- [ ] Task 4: End-to-end manual scenario (AC: 4)
- [ ] Task 5: Hook adversarial smoke (AC: 5)
- [ ] Task 6: Regression sanity (AC: 6)
- [ ] Task 7: Land the commit + push (AC: 7)
- [ ] Task 8: Update `status.md` — mark all stories DONE, flip the epic to DONE, note the operator-pending Epic 21 work

## Dev Notes

- This story is the gate. If any acceptance fails, fix forward (or roll back) BEFORE merging.
- Keep the `PARTY_PUSH_V1_ENABLED` feature flag (Story 20.7) defaulted OFF for the first deploy. Flip it ON via env var only after the manual scenario passes. Gives a clean rollback path if something goes sideways.
- Once this story is DONE, the operator picks up Epic 21 planning (UI half — planner takes that).
