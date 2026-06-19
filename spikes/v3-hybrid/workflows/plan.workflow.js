// @workflow-invariants: v1
// @plan: v3-hybrid spike — planning (+ optional graph scout)
export const meta = {
  name: 'spike-plan',
  description: 'Decompose a tiny feature into independent stories with contracts + ACs',
  phases: [{ title: 'Scout' }, { title: 'Plan' }],
}

// args may arrive as a JSON string in this harness; coerce to an object before use.
const _args = typeof args === 'string' ? JSON.parse(args) : args
const feature = _args?.feature ?? 'a tiny pricing utility module'
const withGraph = !!_args?.withGraph

let brief = ''
if (withGraph) {
  phase('Scout')
  brief = await agent(
    `Use the Mycelium graph MCP (load tools via ToolSearch, query "mycelium graph") to produce a COMPACT
     brief (<=120 words) of this repo's modules, public symbols, layering + naming conventions.
     If the graph is empty or the MCP is unreachable, return exactly: GRAPH-EMPTY.`,
    { label: 'scout:graph', phase: 'Scout', model: 'sonnet' }
  )
}

phase('Plan')
const PLAN_SCHEMA = {
  type: 'object',
  required: ['stories'],
  properties: {
    stories: {
      type: 'array', minItems: 2, maxItems: 2,
      items: {
        type: 'object',
        required: ['id', 'title', 'file', 'contract', 'acs'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          contract: { type: 'string' },
          acs: { type: 'array', minItems: 2, items: { type: 'string' } },
        },
      },
    },
  },
}

const plan = await agent(
  `Decompose "${feature}" into EXACTLY 2 INDEPENDENT stories, each in its own source file under src/
   (no shared files — they must build in parallel and merge cleanly).
   Per story: id (kebab-case), title, file (src/*.ts — NEVER a *.test.* path),
   contract (the exact exported signature + behaviour in 1-2 sentences),
   and 2-3 testable acceptance criteria.
   ${withGraph && brief !== 'GRAPH-EMPTY' ? `Respect these repo conventions:\n${brief}` : ''}`,
  { label: 'plan', phase: 'Plan', model: 'sonnet', schema: PLAN_SCHEMA }
)

return { feature, withGraph, brief, stories: plan.stories }
