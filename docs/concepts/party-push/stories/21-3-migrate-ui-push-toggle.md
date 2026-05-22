# Story 21.3: Migrate UI "Push enabled" toggle + modal

Status: DONE (2026-05-22)
Depends on: 21.2

## Story

As an operator, I want a per-project "Push: on/off" toggle on each migration card so I can enable push for a specific brownfield without touching CLI / DDB; the enable path must surface the branch-protection prerequisite + prompt for a fresh PAT.

## Acceptance Criteria

1. `src/components/migrate/push-enabled-modal.tsx` ships:
   - Enable mode: collects `pat` (validated against `^(github_pat_|ghp_|github_token_)`); requires an ackBranchProtection checkbox; calls `useUpdateMigration({ pushEnabled: true, pat })`.
   - Disable mode: one-click confirm; calls `useUpdateMigration({ pushEnabled: false })`.
2. `MigrationsList` renders a `Push: on/off` button per card; clicking opens the modal in the appropriate intent.
3. Toggle button color reflects state: success-tinted when on, muted when off.
4. Error states surface inline in the modal; success closes the modal + refetches the list.

## Tests

No new unit tests (UI surface). The hook layer (`useUpdateMigration`) is covered by Story 21.2's schema tests; the modal is exercised via e2e smoke in Story 20.16.

## Notes

- Per `plan.md` §1 decision 2, opt-in is per-project, never default-on.
- Branch protection ack is a checkbox (not a separate confirmation modal) — keeps the friction low while putting the warning in front of the operator.
