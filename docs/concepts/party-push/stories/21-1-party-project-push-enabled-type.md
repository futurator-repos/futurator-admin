# Story 21.1: PartyProject.pushEnabled type + repo plumbing

Status: DONE (2026-05-22)
Depends on: Epic 20 shipped

## Story

As the per-project Push toggle, I want `PartyProject.pushEnabled?: boolean` plus a repo helper that flips it, so subsequent stories (UI + checkpoint script) can read a single canonical source-of-truth field.

## Acceptance Criteria

1. `functions/shared/types/party.ts::PartyProject` carries optional `pushEnabled?: boolean`.
2. `functions/shared/repositories/party-projects-repository.ts::updateProjectPushEnabled(projectId, pushEnabled)` writes the field with `attribute_exists(projectId)` guard and bumps `updatedAt`.
3. `src/types/migration.ts::Migration.pushEnabled: boolean` (always-present in API responses; defaults false for legacy rows).
4. `src/types/party.ts::PartyProject.pushEnabled?: boolean` mirrored from the shared type.
5. Tests for the repo helper green; typecheck baseline 79 maintained.

## Implementation

- `functions/shared/types/party.ts` adds the field.
- `functions/shared/repositories/party-projects-repository.ts::updateProjectPushEnabled` ships.
- 2 new tests in `party-projects-repository.test.ts` (push=true + push=false).

## Notes

- `pushEnabled` is undefined for legacy rows; the API surfaces it as `false` to keep the frontend type narrower.
