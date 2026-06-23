// assess-codebase.workflow.js — Refactoring Assessment Module, L3 (Epic C).
//
// The optional agentic stage that runs AFTER the deterministic recon. It reads
// graphify-out/hotspots.json (top-N), adversarially adjudicates each hotspot
// from the code (a deterministic finding contradicted by code is DROPPED, not
// passed through — the `primitives` false-positive guard), then a judge fuses
// the CONFIRMED findings into a sequenced extract→repoint→delete plan in
// planOutputSchema shape, ingestible by create-story / dev-story.
//
// Token law: the LLM spend is bounded by hotspot COUNT (~6-40), not file count.
// The version-adjudicator subagent is read-only (Read/Grep/Glob/Bash, NO Write)
// so "find, don't fix" is mechanical.
//
// Run by the daemon in cwd = the brownfield clone (so agents can Read the tree +
// graphify-out/). args (optional): { topN?: number }.

export const meta = {
  name: 'assess-codebase',
  description: 'L3 adjudication: verify recon hotspots from code, then judge into a sequenced refactor plan',
  phases: [
    { title: 'Load' },
    { title: 'Adjudicate' },
    { title: 'Verify' },
    { title: 'Judge' },
  ],
}

const _args = typeof args === 'string' ? (args ? JSON.parse(args) : {}) : args || {}
const TOP = Number.isFinite(_args.topN) ? _args.topN : 40

// ── schemas ──
const HOTSPOTS_SCHEMA = {
  type: 'object',
  required: ['hotspots'],
  properties: {
    counts: { type: 'object' },
    hotspots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'title'],
        properties: {
          kind: { type: 'string' },
          score: { type: 'number' },
          severity: { type: 'string' },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          suggestedAction: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['hotspotTitle', 'kind', 'verdict', 'rationale'],
  properties: {
    hotspotTitle: { type: 'string' },
    kind: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'rejected'] },
    rationale: { type: 'string' },
    confidence: { type: 'number' },
    canonicalTarget: { type: ['string', 'null'] },
    safeSteps: { type: 'array', items: { type: 'string' } },
  },
}

const REFUTE_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

// planOutputSchema (functions/shared/schemas/plan-output-schema.ts) — the judge
// emits this so the audit's Create-plan is ingestible by the dev pipeline.
const PLAN_SCHEMA = {
  type: 'object',
  required: ['plan'],
  properties: {
    plan: {
      type: 'object',
      required: ['name', 'description', 'epics'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        epics: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title', 'goal', 'stories'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              goal: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              stories: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'touchPoints', 'criteria'],
                  properties: {
                    id: { type: 'string' },
                    dependsOn: { type: 'array', items: { type: 'string' } },
                    touchPoints: { type: 'array', items: { type: 'string' } },
                    criteria: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'text'],
                        properties: {
                          id: { type: 'string' },
                          text: { type: 'string' },
                          needsBrowser: { type: 'boolean' },
                          verify: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
}

// ── Load: an agent reads the recon artifact (the workflow script has no fs). ──
phase('Load')
const loaded = await agent(
  `Read ./graphify-out/hotspots.json in the current working directory and return its
   { counts, hotspots } verbatim. Do not editorialize — just parse and return the JSON.`,
  { label: 'load:hotspots', phase: 'Load', schema: HOTSPOTS_SCHEMA },
)
const top = (loaded?.hotspots || []).slice(0, TOP)
log(`Loaded ${top.length} hotspots (top ${TOP}) for adjudication`)

if (top.length === 0) {
  return { verdicts: [], confirmed: [], plan: null, note: 'no hotspots to adjudicate' }
}

// ── Adjudicate → Verify, pipelined per hotspot (no barrier between stages). ──
//   stage 1 (C2): a read-only version-adjudicator confirms/rejects from code.
//   stage 2 (C3): if confirmed, an INDEPENDENT refuter tries to refute it; a
//                 successful refutation flips it to rejected (adversarial gate).
const adjudicated = await pipeline(
  top,
  (h) =>
    agent(
      `Adjudicate this recon hotspot against the actual code. Hotspot:\n${JSON.stringify(h, null, 2)}\n\n` +
        `Read the implicated files + their real importers (prefer graphify-out/graph.resolved.json + ` +
        `resolved-imports.json for trustworthy fan-in). Decide confirmed vs rejected and emit the ---VERDICT--- block.`,
      { label: `adjudicate:${h.kind}`, phase: 'Adjudicate', agentType: 'version-adjudicator', schema: VERDICT_SCHEMA },
    ),
  (verdict, h) => {
    if (!verdict || verdict.verdict !== 'confirmed') return verdict
    // adversarial verify — an independent skeptic must fail to refute it.
    return agent(
      `An adjudicator CONFIRMED this refactoring finding:\n` +
        `Hotspot: ${verdict.hotspotTitle} (${verdict.kind})\nRationale: ${verdict.rationale}\n` +
        `Files: ${JSON.stringify(h.files || [])}\n\n` +
        `Try to REFUTE it from the code. Is it actually a name collision, a separate concern, ` +
        `alias-resolution noise, or otherwise NOT a real refactor target? Read the code. Default to ` +
        `refuted=true if you cannot independently re-confirm it. Return {refuted, reason}.`,
      { label: `verify:${h.kind}`, phase: 'Verify', agentType: 'version-adjudicator', schema: REFUTE_SCHEMA },
    ).then((ref) => ({
      ...verdict,
      verdict: ref && ref.refuted ? 'rejected' : 'confirmed',
      rationale: ref && ref.refuted ? `[refuted on verify] ${ref.reason}` : verdict.rationale,
    }))
  },
)

const verdicts = adjudicated.filter(Boolean)
const confirmed = verdicts.filter((v) => v.verdict === 'confirmed')
log(`${confirmed.length}/${verdicts.length} hotspots survived adversarial verification`)

if (confirmed.length === 0) {
  return { verdicts, confirmed: [], plan: null, note: 'all hotspots rejected on adjudication/verify' }
}

// ── Judge (C4): fuse the CONFIRMED findings into a sequenced plan. ──
phase('Judge')
const plan = await agent(
  `You are the L4 judge for a refactoring assessment. The following hotspots were CONFIRMED by an ` +
    `adversarial adjudicator (rejected ones are excluded — do NOT reintroduce them):\n\n` +
    `${JSON.stringify(confirmed, null, 2)}\n\n` +
    `Produce a draft plan in planOutputSchema shape. Rules:\n` +
    `- Sequence every refactor as a Strangler-Fig: extract shared core → repoint dependents → ` +
    `delete the old path. A deletion story MUST dependsOn its extract/repoint stories.\n` +
    `- Before any deletion/repoint on a route lacking tests, add a characterization-net story first ` +
    `(a thin Playwright net over the affected routes) and make the repoint/delete dependsOn it.\n` +
    `- touchPoints MUST be REAL existing relative paths from the hotspots' files (or <EPIC_WIDE> for a ` +
    `genuinely cross-cutting refactor). NEVER list package.json / tsconfig / lockfiles / absolute paths.\n` +
    `- Each story needs ≥1 criterion; for UI-bearing changes emit ≥1 needsBrowser:true criterion.\n` +
    `- name is kebab-case; description ≥20 chars. Epic/story ids are E1/E2…, S1/S2… and dependsOn only ` +
    `references earlier siblings.\n` +
    `Emit ONLY the plan object.`,
  { label: 'judge:plan', phase: 'Judge', schema: PLAN_SCHEMA },
)

return { verdicts, confirmed, plan }
