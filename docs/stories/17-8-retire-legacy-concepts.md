# Story 17.8: Retire legacy concepts

**Status:** Backlog

---

## User Story

As **Richie (operator)**,
I want **the old "Generate Epic" / "Start Epic" / `activeAppName` / `useEpicOrchestrator` concepts removed from the codebase and UI**,
So that **the Plan-based model is the single source of truth and future contributors aren't confused by two parallel hierarchies coexisting**.

---

## Acceptance Criteria

**AC #1** — Delete component `src/components/labs/agentic-workflow/epic-generator.tsx`. The intent-capture flow is now exclusively in `<NewPlanForm>` (Story 17.5).

**AC #2** — `src/stores/labs-store.ts`:
- Remove `activeAppName`, `setActiveAppName`.
- Add `activePlanId: string | null`, `setActivePlanId: (id) => void` — but note: route-driven is preferred. The store is only for cross-component sidebar/header context if needed.

**AC #3** — Remove the `useEpicOrchestrator` toggle from any remaining component. `Plan.executionMode` owns this now. The toggle is in the New Plan form's Advanced section (Story 17.5).

**AC #4** — Legacy endpoints:
- `POST /api/epic-workflows/:id/start` → returns 301 redirect to `/api/plans/<plan.id>/start` (using `epic.planId`) for one sprint, then is deleted in the next release.
- `POST /api/epic-workflows/from-xml` → returns 410 Gone with `{ error: 'replaced-by-plans', see: '/api/plans/from-intent' }`.

**AC #5** — File-explorer trash button: already moved to Admin Tools in Story 17.7. This story verifies the removal from the main projects grid and updates any docs/screenshots.

**AC #6** — Text/label sweeps:
- "Generate Epic" → "Generate Plan"
- "Start Epic" → "Start Plan Development"
- "Epic" in user-facing copy → "Plan" where the user means the plan (e.g. "Delete Epic" → "Delete Plan")
- "Epic" is still the internal term for a sub-unit of a plan and stays in code.
- "New Project" dropdown item → removed (subsumed by "+ New Plan").

**AC #7** — Documentation updates:
- `CLAUDE.md` — mention Plan as the top-level unit; update any references that say "epic" where they mean "plan".
- `docs/sprint-status.yaml` — no schema change; just cosmetic comments if any reference legacy terms.

**AC #8** — `npm run ci` passes. Repo-wide search: no remaining references to `activeAppName`, `EpicGenerator`, `useEpicOrchestrator`, `createEpicFromXml` in `src/` or `functions/`.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Delete `epic-generator.tsx`.
- [ ] Clean up `labs-store.ts`.
- [ ] Remove `useEpicOrchestrator` toggle UI.
- [ ] Add redirect/gone stubs for legacy endpoints.
- [ ] Sweep text strings across components.
- [ ] Update CLAUDE.md.
- [ ] Update any docs referencing old terms.
- [ ] Verify no stale references via `grep -r activeAppName\|EpicGenerator\|useEpicOrchestrator src/ functions/`.
- [ ] `npm run ci` passes.

### Timing

Ship this story only **after** the operator has shipped 3+ plans through the new flow without regressions. Keeps legacy as a fallback until confidence is high.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md).
**Depends on:** 17.1–17.7 all shipped and proven.

---

## Dev Agent Record

<!-- -->
