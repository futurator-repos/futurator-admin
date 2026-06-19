// @workflow-invariants: v1
// @plan: Intervention ① — epic-elicitation swarm (replaces the 20-min single-shot pm-plan)
//
// STATIC, committed, args-parameterized (NOT generated per run). The daemon launches this same
// script every plan; per-run variability arrives via `args` (the approved docs + intent).
//
// Shape:
//   ① epic-breakdown (one fast agent): docs → epics[] + cross-epic dependsOnEpics DAG
//      + the SHARED CONTRACT SURFACE (domain type names/signatures) + a spec-coverage map.
//      Small output → seconds. Freezing the shared vocabulary here is the A1 drift fix.
//   ② per-epic decomposition (parallel, one agent per epic): each gets its epic goal + the shared
//      contract surface + ONLY its relevant doc slices → that epic's stories/ACs/touchPoints/dependsOn.
//   The bash runner then does deterministic assembly (coverage/collision/acyclicity) + the existing
//   wave math. The LLM never computes waves.
export const meta = {
  name: 'epic-elicitation',
  description: 'Break a plan into epics + shared contract surface, then decompose every epic in parallel',
  phases: [{ title: 'Breakdown' }, { title: 'Decompose' }],
}

const _args = typeof args === 'string' ? JSON.parse(args) : args
const intent = _args?.intent ?? ''
const docs = _args?.docs ?? '' // concatenated PRD + UX + Architecture (the approved specs)

phase('Breakdown')
const BREAKDOWN_SCHEMA = {
  type: 'object',
  required: ['stepId', 'contractSurface', 'epics'],
  properties: {
    stepId: { type: 'string' },
    // the shared domain-type vocabulary every epic decomposes AGAINST (frozen here → no drift)
    contractSurface: {
      type: 'array',
      items: { type: 'string' }, // e.g. "TileType (enum)", "PacManState { col,row,dir,... }", "getTile(s,row,col): TileType"
    },
    epics: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['epicId', 'title', 'goal', 'dependsOnEpics', 'coversSpecIds'],
        properties: {
          epicId: { type: 'string' }, // kebab, e.g. "e1-domain-types"
          title: { type: 'string' },
          goal: { type: 'string' },
          dependsOnEpics: { type: 'array', items: { type: 'string' } },
          coversSpecIds: { type: 'array', items: { type: 'string' } }, // FR#/SCREEN-/MOD- ids this epic owns
        },
      },
    },
  },
}

const breakdown = await agent(
  `Decompose this build into EPICS (not stories yet) from the approved specs.
   INTENT: ${intent}
   APPROVED SPECS (PRD + UX + Architecture — the source of truth):
   ${docs}

   Return:
   - contractSurface: the shared domain-type vocabulary (enum/interface/function NAMES + signatures)
     that multiple epics will import. Name them ONCE here so no epic invents a divergent name.
   - epics[]: each with epicId (kebab), title, goal, dependsOnEpics (epicIds), and coversSpecIds —
     the list of spec ids (FR1.., SCREEN-.., MOD-..) that epic is responsible for. EVERY spec id in
     the docs must be covered by at least one epic.
   Include a stepId:"epic-breakdown".`,
  { label: 'epic-breakdown', phase: 'Breakdown', model: 'sonnet', schema: BREAKDOWN_SCHEMA }
)

phase('Decompose')
const EPIC_SCHEMA = {
  type: 'object',
  required: ['stepId', 'epicId', 'stories'],
  properties: {
    stepId: { type: 'string' },
    epicId: { type: 'string' },
    stories: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['storyId', 'title', 'touchPoints', 'dependsOn', 'acs'],
        properties: {
          storyId: { type: 'string' },
          title: { type: 'string' },
          touchPoints: { type: 'array', items: { type: 'string' } }, // src/* files this story writes
          dependsOn: { type: 'array', items: { type: 'string' } }, // storyIds within this epic
          acs: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
    },
  },
}

const subtrees = await parallel(
  breakdown.epics.map((e) => () =>
    agent(
      `Decompose ONE epic into stories. Decompose ONLY this epic; do not touch others.
       EPIC ${e.epicId}: ${e.title}
       GOAL: ${e.goal}
       SPEC IDS THIS EPIC OWNS: ${(e.coversSpecIds || []).join(', ')}
       SHARED CONTRACT SURFACE (use these EXACT names; do not redefine):
       ${(breakdown.contractSurface || []).map((c) => `  - ${c}`).join('\n')}
       RELEVANT SPECS:
       ${docs}

       Per story: storyId (kebab), title, touchPoints (src/* files it writes — a *.test.* path is NOT a source),
       dependsOn (storyIds within THIS epic), and 2-3 testable acceptance criteria.
       Stories with disjoint touchPoints can run in parallel — keep files non-overlapping where possible.
       Include stepId:"decompose-${e.epicId}" and epicId:"${e.epicId}".`,
      { label: `decompose:${e.epicId}`, phase: 'Decompose', model: 'sonnet', schema: EPIC_SCHEMA }
    )
  )
)

return {
  contractSurface: breakdown.contractSurface,
  epics: breakdown.epics,
  subtrees: subtrees.filter(Boolean),
}
