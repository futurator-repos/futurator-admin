# Story 21.2: PATCH /api/migrations/:id pushEnabled toggle

Status: DONE (2026-05-22)
Depends on: 21.1

## Story

As the operator-controlled push toggle, I want `PATCH /api/migrations/:id` to accept `pushEnabled: boolean` and (when flipping ON) require a fresh contents:write PAT in the same body, so we never end up in a state where push is enabled but the PAT is still read-only.

## Acceptance Criteria

1. `updateMigrationInputSchema` adds `pushEnabled?: boolean` field.
2. Schema-level `.refine` enforces: `pushEnabled: true` REQUIRES `pat` to be present.
3. `pushEnabled: false` does NOT require `pat` (operator can demote).
4. PATCH route writes `pushEnabled` via `updateProjectPushEnabled` AFTER the PAT rotation (so a daemon that reads the new secret sees contents:write scope).
5. `GET /api/migrations` response surfaces `pushEnabled: boolean` (defaults false).
6. `UpdateMigrationResponse` carries `pushEnabled` so the UI can confirm.

## Tests

5 new schema tests in `party-schema.test.ts`:

- pushEnabled=true + pat → accepted
- pushEnabled=true without pat → rejected with "contents:write PAT" message
- pushEnabled=false alone → accepted
- pushEnabled bundled with pat + envVars → accepted
- empty body still rejected
