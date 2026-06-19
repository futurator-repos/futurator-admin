// @workflow-invariants: v1
// @plan: Intervention ① (HEAVY) — production-rigor epic-elicitation swarm with doc-slicing + checkout
//
// The decisive experiment: at PRODUCTION rigor the per-story output is heavy (userStory +
// technicalNotes + tasks[] + BMAD criteria with verify/needsBrowser/given/when/then), faithful to
// functions/shared/prompts/pm-plan-prompt.ts. This is the regime where the single-shot is
// output-token-bound (serial decode of the whole plan) and the swarm's parallel decode should win.
//
// Two fixes over the lean E1 workflow:
//   (1) DOC-SLICING — each epic agent gets ONLY the spec sections it owns (by coversSpecIds) + the
//       frozen contract surface, not all three full docs. Less input/agent, cache-friendly.
//   (2) CHECKOUT (fan-in) — the script returns the assembled subtrees from script variables; the
//       bash runner does the deterministic build-once + the contract-conformance gate. The
//       orchestrator reassembles; no LLM re-reads everything (the ultracode fan-in model).
export const meta = {
  name: 'epic-elicitation-heavy',
  description: 'Production-rigor: breakdown + contract surface, then parallel per-epic decomposition with sliced docs',
  phases: [{ title: 'Breakdown' }, { title: 'Decompose' }],
}

const _args = typeof args === 'string' ? JSON.parse(args) : args
const intent = _args?.intent ?? ''
const docs = _args?.docs ?? ''

// ── in-script doc slicer: keep only doc lines naming an id in `ids` (+ the section header above) ──
function sliceDocs(full, ids) {
  if (!ids || ids.length === 0) return full
  const lines = full.split('\n')
  const keep = []
  let lastHeader = ''
  for (const ln of lines) {
    if (/^#{1,3}\s/.test(ln) || /^##\s/.test(ln)) lastHeader = ln
    if (ids.some((id) => ln.includes(id))) {
      if (lastHeader && keep[keep.length - 1] !== lastHeader) keep.push(lastHeader)
      keep.push(ln)
    }
  }
  return keep.length ? keep.join('\n') : full
}

phase('Breakdown')
const BREAKDOWN_SCHEMA = {
  type: 'object',
  required: ['stepId', 'contractSurface', 'epics'],
  properties: {
    stepId: { type: 'string' },
    contractSurface: { type: 'array', items: { type: 'string' } },
    epics: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['epicId', 'title', 'goal', 'dependsOnEpics', 'coversSpecIds'],
        properties: {
          epicId: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string' },
          dependsOnEpics: { type: 'array', items: { type: 'string' } },
          coversSpecIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const breakdown = await agent(
  `Decompose this build into EPICS (not stories yet) from the approved specs.
   INTENT: ${intent}
   APPROVED SPECS (PRD + UX + Architecture):
   ${docs}

   Return contractSurface (shared domain-type vocabulary — enum/interface/function names + signatures,
   named ONCE so no epic invents a divergent name) and epics[] (each: epicId kebab, title, goal,
   dependsOnEpics, coversSpecIds = the FR../SCREEN-../MOD-.. ids it owns — every spec id covered ≥once).
   Include stepId:"epic-breakdown".`,
  { label: 'epic-breakdown', phase: 'Breakdown', model: 'sonnet', schema: BREAKDOWN_SCHEMA }
)

phase('Decompose')
// PRODUCTION-rigor story schema — faithful to pm-plan-prompt.ts enriched output (heavy on purpose).
const STORY = {
  type: 'object',
  required: ['storyId', 'title', 'touchPoints', 'dependsOn', 'criteria', 'userStory', 'technicalNotes', 'tasks'],
  properties: {
    storyId: { type: 'string' },
    title: { type: 'string' },
    touchPoints: { type: 'array', items: { type: 'string' } },
    dependsOn: { type: 'array', items: { type: 'string' } },
    userStory: {
      type: 'object',
      required: ['role', 'action', 'benefit'],
      properties: { role: { type: 'string' }, action: { type: 'string' }, benefit: { type: 'string' } },
    },
    technicalNotes: { type: 'string' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'text', 'acRefs'],
        properties: { id: { type: 'string' }, text: { type: 'string' }, acRefs: { type: 'array', items: { type: 'string' } } },
      },
    },
    criteria: {
      type: 'array',
      minItems: 4, // production rigor: 4-6 ACs/story (pm-plan-prompt.ts:670)
      items: {
        type: 'object',
        required: ['id', 'text', 'needsBrowser', 'verify'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          needsBrowser: { type: 'boolean' },
          verify: { enum: ['build', 'appearance', 'state', 'behavior', 'manual'] },
          given: { type: 'string' },
          when: { type: 'string' },
          then: { type: 'string' },
        },
      },
    },
  },
}
const EPIC_SCHEMA = {
  type: 'object',
  required: ['stepId', 'epicId', 'stories'],
  properties: {
    stepId: { type: 'string' },
    epicId: { type: 'string' },
    stories: { type: 'array', minItems: 1, items: STORY },
  },
}

const subtrees = await parallel(
  breakdown.epics.map((e) => () =>
    agent(
      `Decompose ONE epic into PRODUCTION-rigor stories. Decompose ONLY this epic.
       EPIC ${e.epicId}: ${e.title}
       GOAL: ${e.goal}
       SHARED CONTRACT SURFACE (use these EXACT names; never redefine):
       ${(breakdown.contractSurface || []).map((c) => `  - ${c}`).join('\n')}
       RELEVANT SPEC SECTIONS (sliced to this epic):
       ${sliceDocs(docs, e.coversSpecIds)}

       Per story, production rigor: storyId (kebab), title (action-oriented), touchPoints (src/* it
       writes — never *.test.*), dependsOn (storyIds within THIS epic), 4-6 acceptance criteria each
       {id,text,needsBrowser,verify ∈ build|appearance|state|behavior|manual, +given/when/then for
       behavioral ACs}, a userStory {role,action,benefit}, technicalNotes (concrete), and tasks[]
       {id,text,acRefs} covering every AC. Stories with disjoint touchPoints can run in parallel.
       Include stepId:"decompose-${e.epicId}" and epicId:"${e.epicId}".`,
      { label: `decompose:${e.epicId}`, phase: 'Decompose', model: 'sonnet', schema: EPIC_SCHEMA }
    )
  )
)

// CHECKOUT (fan-in): return assembled subtrees from script variables. The bash runner does the
// deterministic build-once + contract-conformance gate. Orchestrator reassembles; no LLM re-read.
return {
  contractSurface: breakdown.contractSurface,
  epics: breakdown.epics,
  subtrees: subtrees.filter(Boolean),
}
