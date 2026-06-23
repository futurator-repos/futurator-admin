// case2-to-decision.mjs — project a Futurator planOutput (the reused `planOutputSchema`) onto the
// shared DecisionPlan IR (design doc §4). Pure code, zero model tokens.
//
// SLICE SCOPE: wave-layering + rigor→tier are re-implemented here in plain JS so the spike stays
// dependency-light (it cannot `import` the real `.ts` services without a TS loader). The PRODUCTION
// version must project THROUGH the real `computePlanWaves` / `buildAgentConfig` / `resolveRolePolicy`
// (functions/shared/services + pipelines) so the bench scores the deployed behavior, not a copy.
// Until then, `extraction.lossy` records the reduce/verify fields a declarative plan cannot express,
// and the wave layering below mirrors `computePlanWaves` semantics (topological; throws on cycle).
//
// Input: a PlanOutput object — { plan: { name, description, epics: [...] } } — see
// functions/shared/schemas/plan-output-schema.ts. Plus { target, rigor } context.

import { makeDecisionPlan } from './decision-schema.mjs';

const RIGOR_TIER = { prototype: 'L0', mvp: 'L1', production: 'L2' };

/**
 * @param {object} planOutput   matches planOutputSchema: { plan: { epics: [...] } }
 * @param {{target?: 'greenfield'|'brownfield', rigor?: 'prototype'|'mvp'|'production', devModel?: string, grounded?: boolean}} [ctx]
 * @returns {import('./decision-schema.mjs').DecisionPlan}
 */
export function case2ToDecision(planOutput, ctx = {}) {
  const lossy = [
    'no-script-reduce: declarative plan has no plain-JS reduce steps',
    'no-barrier-reason: waves are structural, not cross-set joins',
  ];
  const rigor = ctx.rigor ?? 'mvp';
  const target = ctx.target ?? 'greenfield';
  const devModel = ctx.devModel ?? 'default';
  const testTier = RIGOR_TIER[rigor] ?? 'L1';

  const epics = planOutput?.plan?.epics ?? [];
  const stories = flattenStories(epics);

  // ── wave layering (mirrors computePlanWaves: topo layers; throw on cycle) ────
  const waves = computeWaves(stories);

  const phases = waves.map((wave, i) => {
    const agents = wave.map((s) => storyToAgent(s, { devModel, testTier }));
    return {
      name: `wave-${i + 1}`,
      mode: wave.length > 1 ? 'parallel-barrier' : 'sequential',
      fanOut: wave.length > 1 ? { axis: 'stories', width: wave.length } : null,
      agents,
      ...(wave.length > 1 ? { barrierReason: 'wave gate (all stories before next wave)' } : {}),
    };
  });

  const phaseNames = phases.map((p) => p.name);
  const edges = phaseNames.slice(0, -1).map((n, i) => /** @type {[string,string]} */ ([n, phaseNames[i + 1]]));

  return makeDecisionPlan({
    // Case 2 has no phase-name sequence to classify from; target + grounding decide the skeleton.
    pattern: defaultPatternFor(target, ctx.grounded),
    qualityPatterns: phases.some((p) => p.fanOut) ? ['fan-out-and-synthesize'] : [],
    phases,
    verify: inferVerify(rigor),
    reduceSteps: 0,
    earlyExit: false,
    edges,
    source: 'case2-planspec',
    extraction: { lossy },
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function defaultPatternFor(target, grounded) {
  if (target === 'brownfield') return 'brownfield-harden';
  return 'greenfield-build';
}

function inferVerify(rigor) {
  // The verify gate is a pipeline REVIEWER/QA role per story (role-policy.ts), not a field on the
  // plan object. Heuristic by rigor; production wraps stories adversarially (design §4).
  if (rigor === 'production') return { present: true, kind: 'adversarial' };
  if (rigor === 'mvp') return { present: true, kind: 'none' };
  return { present: false, kind: 'none' };
}

function flattenStories(epics) {
  const out = [];
  for (const e of epics) {
    for (const s of e.stories ?? []) {
      out.push({ ...s, epicId: e.id, epicDependsOn: e.dependsOn ?? [] });
    }
  }
  return out;
}

/** Per-story → DecisionPlan Agent, carrying the guardrails Case 2 wins on (design §8). */
function storyToAgent(s, { devModel, testTier }) {
  const tp = s.touchPoints ?? [];
  const isolation = tp.length > 0 && !tp.includes('<EPIC_WIDE>') ? 'worktree' : 'none';
  const skillBindings = (s.references ?? []).map((r) => r.source).filter(Boolean);
  return {
    role: 'DEV', // the implementing role (role-policy.ts); REVIEWER/TEST wrap per rigor
    hasSchema: true, // stories are schema-validated artifacts
    model: devModel,
    isolation,
    agentType: 'DEV', // guardrail: every story is typed — what Case 1 lacks
    testTier, // guardrail: rigor-driven L0/L1/L2
    skillBindings, // guardrail: bound references/skills
  };
}

/**
 * Topological wave layering over stories. A story's predecessors are its intra-epic `dependsOn`
 * plus every story whose epic is in this story's epic `dependsOn` (cross-epic ordering).
 * Throws on a dependency cycle — mirrors computePlanWaves (plan-waves.ts).
 */
export function computeWaves(stories) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const storiesByEpic = new Map();
  for (const s of stories) {
    if (!storiesByEpic.has(s.epicId)) storiesByEpic.set(s.epicId, []);
    storiesByEpic.get(s.epicId).push(s.id);
  }

  const preds = new Map(); // storyId → Set(predecessor storyIds)
  for (const s of stories) {
    const set = new Set();
    for (const d of s.dependsOn ?? []) if (byId.has(d)) set.add(d);
    for (const ep of s.epicDependsOn ?? []) for (const sid of storiesByEpic.get(ep) ?? []) set.add(sid);
    set.delete(s.id);
    preds.set(s.id, set);
  }

  const placed = new Set();
  const waves = [];
  let guard = stories.length + 1;
  while (placed.size < stories.length && guard-- > 0) {
    const layer = stories.filter((s) => !placed.has(s.id) && [...preds.get(s.id)].every((p) => placed.has(p)));
    if (layer.length === 0) throw new Error('case2ToDecision: dependency cycle in stories (no acyclic wave layering)');
    for (const s of layer) placed.add(s.id);
    waves.push(layer);
  }
  if (placed.size < stories.length) throw new Error('case2ToDecision: dependency cycle (guard tripped)');
  return waves;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const path = process.argv[2];
  if (!path) { console.error('usage: node case2-to-decision.mjs <planOutput.json> [target] [rigor]'); process.exit(2); }
  const planOutput = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log(JSON.stringify(case2ToDecision(planOutput, { target: process.argv[3], rigor: process.argv[4] }), null, 2));
}
