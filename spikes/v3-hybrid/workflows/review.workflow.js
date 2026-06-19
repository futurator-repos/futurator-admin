// @workflow-invariants: v1
// @plan: v3-hybrid spike — final review gate (adversarial)
export const meta = {
  name: 'spike-review',
  description: 'Refute the merged result against the acceptance criteria; PASS only if every AC holds',
  phases: [{ title: 'Review' }],
}

// args may arrive as a JSON string in this harness; coerce to an object before use.
const _args = typeof args === 'string' ? JSON.parse(args) : args
const stories = _args?.stories ?? []

phase('Review')
const V = {
  type: 'object',
  required: ['verdict', 'notes'],
  properties: {
    verdict: { enum: ['PASS', 'FAIL'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const r = await agent(
  `Read the merged diff at ${_args?.diffPath} and the vitest summary at ${_args?.testSummaryPath}.
   For each story below, try to REFUTE that the merged code satisfies its acceptance criteria
   before approving. Do not run or modify anything.
   STORIES:
${stories.map((s) => `   - ${s.id}: ${s.contract}\n     ACs: ${(s.acs || []).join(' | ')}`).join('\n')}
   Return {verdict, notes}. verdict = PASS only if every AC holds AND the vitest summary is green.`,
  { label: 'review', phase: 'Review', model: 'sonnet', schema: V } // gate role → sonnet floor (I7)
)

return r
