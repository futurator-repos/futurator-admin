# Story 17.3: PM agent — generate Plan JSON

**Status:** Backlog

---

## User Story

As **Richie (operator)**,
I want **the PM agent to produce a structured Plan with 1..N epics and inter-epic dependencies from my raw intent**,
So that **large intents (auth + dashboard + billing) decompose into a proper multi-epic plan instead of being crammed into one oversized epic**.

---

## Acceptance Criteria

**AC #1** — New PM prompt at `functions/shared/prompts/pm-plan-prompt.ts`. Key differences vs today's epic prompt:
- Explicitly instructs "output 1..N epics, grouped by independent concern, with dependsOn pointing at prior epic IDs"
- Demands JSON output inside `---PLAN_JSON---` / `---END_PLAN_JSON---` fences (reuses the extractor pattern from existing prompts)
- Provides example output with 3 epics (scaffold, features, assembly) showing the dep graph

**AC #2** — Zod schema `planOutputSchema` in `functions/shared/schemas/plan-output-schema.ts`:

```ts
z.object({
  plan: z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
    description: z.string(),
    epics: z.array(z.object({
      id: z.string(),                        // local ID for deps, e.g. "E1"
      title: z.string(),
      goal: z.string(),
      acceptanceCriteria: z.string(),
      dependsOn: z.array(z.string()),        // local IDs referencing earlier epics
      stories: z.array(z.object({
        id: z.string(),                      // local ID, e.g. "S1"
        title: z.string(),
        description: z.string(),
        dependsOn: z.array(z.string()),      // local IDs within this epic
        criteria: z.array(z.object({
          id: z.string(),
          text: z.string(),
          needsBrowser: z.boolean(),
        })),
      })).min(1),
    })).min(1),
  }),
});
```

Schema-level validations: epic `dependsOn` IDs must reference epics earlier in the array; story `dependsOn` IDs must reference stories earlier in the same epic; no cycles (enforced by ordering rule).

**AC #3** — `POST /api/plans/from-intent` endpoint:
- Input: `{ name, intent, devModel?, reviewerModel?, devEffort?, reviewerEffort?, yoloMode?, executionMode? }`.
- Validates plan name (Story 17.1 schema) and checks no non-archived plan exists with that name (409).
- Creates a PENDING `pm-plan` job using `agentJobsRepo.createJob`.
- Returns 202 `{ planJobId }` — client polls via existing `GET /api/agent-jobs/:id`.
- When the PM job completes successfully (daemon side), a post-job handler in the daemon or a follow-up cron tick creates the Plan row + epic rows, bootstraps the folder, writes plan.md, and sets the job's `variables.planId` so the client can navigate.

**AC #4** — PM agent pipeline definition in `functions/shared/pipelines/pm-plan-pipeline.ts`:
- Single agent `PM` with Sonnet model.
- One step running the prompt + capturing the JSON via `extractors` using the fence markers.
- `validations`: JSON parse + Zod schema check. On failure, `loopTo: 'pm'` with `{{ERROR}}` injected so the agent can self-correct.
- `maxIterations: 2` — cheap regeneration.

**AC #5** — `PATCH /api/plans/:id/regenerate` re-runs the PM agent with the current Plan's intent, overwrites its epic tree + `plan.md` on success.

**AC #6** — JSON parse failures → 400 with `{ error, rawOutput }` for debugging.

**AC #7** — Unit tests in `__tests__/plan-generation-service.test.ts`:
- Valid JSON passes.
- Missing `name` rejected.
- Invalid `dependsOn` ID (references future epic) rejected.
- Empty stories array rejected.
- Round-trip: schema-valid input → `createPlan` → retrievable.

**AC #8** — `npm run ci` passes.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Write `pm-plan-prompt.ts` with the instruction + example JSON.
- [ ] Write `plan-output-schema.ts` with Zod validations.
- [ ] Write `plan-generation-service.ts` — wraps prompt + validation + plan creation.
- [ ] Write `pm-plan-pipeline.ts` in `functions/shared/pipelines/`.
- [ ] Register `pm-plan` pipeline type in the daemon's `job-router.mjs` (or confirm it's transparent via the step-based execution path).
- [ ] Wire endpoints in `functions/api/index.ts`: `POST /api/plans/from-intent`, `PATCH /api/plans/:id/regenerate`.
- [ ] Wire post-completion plan-creation (either in daemon or via cron tick that inspects completed pm-plan jobs).
- [ ] Unit tests.
- [ ] `npm run ci` passes.

### Technical Notes

- PM agent output must include the `name` per the schema, but the request input also includes it (user-provided). On mismatch, prefer the user's name (it was validated for kebab-case + uniqueness at request time).
- Story IDs from PM output (`S1`, `S2`, ...) are local. On persistence, generate real UUID `storyId` and map the local IDs for `dependsOn` resolution.

### Key Code References

- Existing `generateEpicPrompt` in `functions/shared/prompts/` — pattern to extend/replace.
- `functions/shared/pipelines/story-pipeline.ts` — reference for pipeline shape.
- `daemon/pipelines/job-router.mjs` — where pipeline types are dispatched.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md).
**Previous story:** [17-2-plan-folder-bootstrap-and-plan-md.md](./17-2-plan-folder-bootstrap-and-plan-md.md).

---

## Dev Agent Record

<!-- -->
