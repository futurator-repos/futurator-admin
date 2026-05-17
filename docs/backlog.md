# Engineering Backlog

This backlog collects cross-cutting or future action items that emerge from reviews and planning.

Routing guidance:

- Use this file for non-urgent optimizations, refactors, or follow-ups that span multiple stories/epics.
- Must-fix items to ship a story belong in that story's `Tasks / Subtasks`.
- Same-epic improvements may also be captured under the epic Tech Spec `Post-Review Follow-ups` section.

| Date       | Story | Epic | Type        | Severity | Owner  | Status   | Notes                                                                                                                                                                                                                                         |
| ---------- | ----- | ---- | ----------- | -------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-17 | 15.4  | 15   | Bug         | Med      | Amelia | Resolved | `party-refresh.mjs` event-taxonomy fix: added `party.refresh.step.started` + `party.refresh.step.output` to union; one-shot `.started` at pipeline entry; tests assert cardinalities. [party-refresh.mjs:54-75, types/party.ts:155-167]       |
| 2026-05-17 | 15.4  | 15   | Bug         | Med      | Amelia | Resolved | (Same fix as above — `step.output` was conflated with `step.completed`; now distinct event type.) [party-refresh.mjs:68-75]                                                                                                                   |
| 2026-05-17 | 15.4  | 15   | TechDebt    | Med      | Amelia | Resolved | API integration test added at `functions/api/__tests__/party-refresh-route.test.ts` — 8 tests covering 202/400/404/409/409 paths + lazy-migration legacy-row case.                                                                            |
| 2026-05-17 | 15.4  | 15   | Enhancement | Low      | TBD    | Open     | Add `kind: 'greenfield'` to greenfield bootstrap step-event payloads for symmetry. [party-bootstrap.mjs:75-79]                                                                                                                                |
| 2026-05-17 | 15.4  | 15   | TechDebt    | Low      | TBD    | Open     | Either split `BrownfieldProjectCard` into `src/components/labs/party/project-list.tsx` (matching original task path) or reword the task line.                                                                                                 |
| 2026-05-17 | 15.4  | 15   | Enhancement | Low      | TBD    | Open     | Switch `createPartyProjectInputSchema` from `z.union([...])` to `z.discriminatedUnion('kind', [...])` for faster parsing + better errors. [party-schema.ts:103-106]                                                                           |
| 2026-05-17 | 15.4  | 15   | Enhancement | Low      | TBD    | Open     | Defense-in-depth URL regex validation inside `createBrownfieldProjectRow` for callers bypassing the API zod layer. [party-projects-repository.ts:85-117]                                                                                      |
| 2026-05-17 | 15.4  | 15   | TechDebt    | Low      | TBD    | Open     | Pre-existing failures in `daemon/pipelines/__tests__/epic-dev-pipeline.test.mjs` (4 tests, `capturedPrompt` not populated, no `vi.mock` usage) block full `npm run ci` from passing green. Out of scope for Story 15.4 but should be tracked. |
