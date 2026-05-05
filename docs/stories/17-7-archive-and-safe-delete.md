# Story 17.7: Archive + hard-delete with confirmation modal

**Status:** Backlog

---

## User Story

As **Richie (operator creating many throwaway prototypes)**,
I want **Archive as the default destructive path with restore-within-14-days, and Hard-Delete behind a typing confirmation showing cost + cascade impact**,
So that **I can rapid-prototype without fear of a misclick losing 20 minutes of agent work**.

---

## Acceptance Criteria

**AC #1** — `POST /api/plans/:id/archive`:
- Idempotent (archiving an already-archived plan returns 200 with no-op).
- Sets `status = 'archived'`, stores current status in `preArchiveStatus`.
- Cancels all running jobs for any epic under this plan (marks FAILED with `errorMessage: 'cancelled-by-archive'`).
- SSM-moves `/home/ubuntu/projects/<name>/` → `/home/ubuntu/.trash/plans/<name>-<iso-ts>/`. Stores `archivedAt` + `archivePath`.
- Returns 200 `{ plan }`.

**AC #2** — `POST /api/plans/:id/restore`:
- Only valid when `status === 'archived'` AND `archivePath` is set AND the folder still exists on disk (SSM verifies).
- SSM-moves folder back to `/home/ubuntu/projects/<name>/`.
- Resets `status = preArchiveStatus`, clears `archivedAt`, `archivePath`, `preArchiveStatus`.
- Returns 200 `{ plan }`.

**AC #3** — `DELETE /api/plans/:id` (hard-delete cascade):
- Cascades (all best-effort, results collected into `results: [{step, status, detail}]`):
  1. Cancel all running jobs for this plan's epics.
  2. Delete all `agent-events` rows for this plan's jobs (paginated).
  3. Delete all `agent-jobs` rows for this plan's jobs.
  4. Delete all epic rows where `planId === :id`.
  5. SSM rm-rf `/home/ubuntu/projects/<name>` OR `.trash/plans/<name>-<ts>` if archived.
  6. SSM rm-rf the `/home/ubuntu/.claude/projects/-home-ubuntu-projects-<name>` transcript folder (reuse the existing pattern from the current DELETE /ec2/files handler).
  7. Delete `s3://futurator-ai-website/apps/<name>/*` objects.
  8. Delete `s3://futurator-ai-website/knowledge-live/<name>/*` objects.
  9. CloudFront invalidation for `/apps/<name>/*` if Plan had `deployUrl`.
  10. Delete the Plan DDB row.
- Returns 200 `{ planId, name, results }`.

**AC #4** — `<DeletePlanModal>` component:
- Shown when user clicks Delete in any plan overflow menu.
- Pre-fetches impact summary via `GET /api/plans/:id/delete-preview` (new endpoint that tallies: epics count, jobs count, events count, running jobs count, cost spent, deployment URL, has `.trash/` folder).
- Displays impact as a bulleted list.
- Requires exact plan-name match typed into a confirmation input.
- `[Cancel]` + `[Delete forever]` (red, disabled until name matches).
- On confirm → calls `DELETE /api/plans/:id`, shows toast with cascade results, invalidates `['plans']` query.

**AC #5** — `<ArchiveConfirmDialog>` component:
- Lightweight — just "Archive <name>? Its folder will move to .trash and running jobs will be cancelled. You can restore within 14 days.".
- `[Cancel]` + `[Archive]`.

**AC #6** — Nightly cron `purge-archived-plans` at `functions/cron/purge-archived-plans.ts`:
- Schedule: `cron(0 3 * * ? *)` — 3am UTC daily.
- Scans plans with `status === 'archived'` AND `archivedAt < now - 14d`.
- For each: calls the same hard-delete cascade as `DELETE /api/plans/:id` internally.
- Logs `purged N plans, K failures`.
- Registered in `sst.config.ts` with 512MB + 300s timeout + DDB RW on plans/epics/jobs/events + SSM send + S3 + CloudFront.

**AC #7** — File-explorer trash icon moved: `src/components/development/file-explorer.tsx` — remove the trash icon from each row, add a collapsed "Admin Tools" section at the bottom of the page with a "Delete folder by path" input + button + warning copy "Low-level operation — prefer the Archive action on a Plan.".

**AC #8** — Unit tests:
- `useArchivePlan` mutation invalidates `['plans']`.
- `<DeletePlanModal>` disables Delete button until name matches.
- Cron scans archived plans, calls cascade.
- Archive idempotency.

**AC #9** — `npm run ci` passes.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Extend `functions/shared/services/plan-folder-service.ts` with `movePlanFolderToTrash` + `restorePlanFolder` (Story 17.2 stubbed these).
- [ ] Add `POST /api/plans/:id/archive`, `POST /api/plans/:id/restore`, `DELETE /api/plans/:id`, `GET /api/plans/:id/delete-preview` endpoints.
- [ ] Implement the cascade helper `deletePlanCascade(planId, deps)` in `functions/shared/services/plan-delete-service.ts` — deps-injected so cron + endpoint share it.
- [ ] Create `functions/cron/purge-archived-plans.ts` + register in `sst.config.ts`.
- [ ] Create `<DeletePlanModal>` + `<ArchiveConfirmDialog>` React components.
- [ ] Update `src/hooks/use-plans.ts` with `useArchivePlan`, `useRestorePlan`, `useDeletePlan`, `useDeletePreview`.
- [ ] Relocate file-explorer trash icon into Admin Tools section.
- [ ] Unit tests.
- [ ] Manual smoke: create → start → archive → restore → delete → verify folder gone.
- [ ] `npm run ci` passes.

### Key Code References

- `functions/api/index.ts:2214 DELETE /api/ec2/files` — guarded SSM rm-rf pattern; reuse.
- `functions/api/index.ts:~1440 DELETE /api/epic-workflows/:id` — existing cascade pattern for inspiration.
- `daemon/agent-daemon.mjs` — job cancellation patterns.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md).
**Depends on:** 17.1–17.6. This is the safety net layered over a working flow.

---

## Dev Agent Record

<!-- -->
