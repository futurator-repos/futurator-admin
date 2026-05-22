# Story 22.4: Pipelines `sourceCommitSha + sourceBranch` extension

Status: DONE (2026-05-22)
Depends on: 20.12 (pipeline-launcher sourceCommitSha)

## Story

As the checkpoint card's "Start story-pipeline" action, I want `POST /api/epic-workflows/:id/start` to accept an optional `{ sourceCommitSha, sourceBranch }` body so the operator can launch a pipeline pinned to a debate checkpoint instead of the plan branch's HEAD.

## Acceptance Criteria

1. `POST /api/epic-workflows/:id/start` reads `sourceCommitSha?: string` + `sourceBranch?: string` from body (best-effort JSON parse — empty body still works).
2. Validates `sourceCommitSha` via `isValidSourceCommitSha`; 400 on malformed.
3. Pipeline mode launches with `launchPipelineWave(..., { sourceCommitSha, planSlug: undefined })` — Story 20.12's pin already does the rest.
4. Orchestrator mode is untouched (parameter ignored — orchestrator path doesn't have a per-story worktree to pin).
5. UI navigates to `/labs?createPlanForApp=<projectId>&sourceCommitSha=<sha>&sourceBranch=<branch>` from the checkpoint card; the plan-creation flow consumes the deep-link params (this part is a Story 22.5 UI nudge, not blocking 22.4).

## Notes

- No new endpoint; the existing /start route was the right surface.
- Story 20.12 enforced the SHA shape at the launcher boundary; this story just adds the API-edge plumbing.
