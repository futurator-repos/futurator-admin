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

  const storyById = new Map(flattenStories(planOutput?.plan?.epics ?? []).map((s) => [s.id, s]));

  // ── wave layering (faithful port of the real collision-aware computeStoryWavesWithTouchPoints) ──
  const waves = computeWaves(waveInput(planOutput));

  const phases = waves.map((wave, i) => {
    const agents = wave.map((id) => storyToAgent(storyById.get(id), { devModel, testTier }));
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
  let order = 0;
  for (const e of epics) {
    for (const s of e.stories ?? []) {
      out.push({ ...s, epicId: e.id, epicDependsOn: e.dependsOn ?? [], order: order++ });
    }
  }
  return out;
}

/**
 * Shared wave-layering INPUT: flatten plan stories and expand cross-epic dependencies into
 * story-level `dependsOn` (a story in epic E2 that depends on E1 depends on all of E1's stories).
 * Both `computeWaves` (plain) and `case2-to-decision-real.mjs` (real services) consume THIS, so the
 * two layerings are identical-by-construction — the drift-guard test asserts it.
 * @returns {Array<{storyId:string, dependsOn:string[], touchPoints:string[], order:number}>}
 */
export function waveInput(planOutput) {
  const stories = flattenStories(planOutput?.plan?.epics ?? []);
  const byId = new Set(stories.map((s) => s.id));
  const storiesByEpic = new Map();
  for (const s of stories) {
    if (!storiesByEpic.has(s.epicId)) storiesByEpic.set(s.epicId, []);
    storiesByEpic.get(s.epicId).push(s.id);
  }
  return stories.map((s) => {
    const deps = new Set();
    for (const d of s.dependsOn ?? []) if (byId.has(d)) deps.add(d);
    for (const ep of s.epicDependsOn ?? []) for (const sid of storiesByEpic.get(ep) ?? []) deps.add(sid);
    deps.delete(s.id);
    return { storyId: s.id, dependsOn: [...deps], touchPoints: s.touchPoints ?? [], order: s.order };
  });
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
 * Wave layering — a faithful plain-JS PORT of the real `computeStoryWavesWithTouchPoints`
 * (functions/shared/services/story-waves.ts). Two constraints, earliest wave satisfying both:
 *   1. dependency order — strictly after every dep's placed wave;
 *   2. touch-point disjointness — no two stories in a wave share a file; a `<EPIC_WIDE>` story
 *      gets a wave to itself.
 * Cycle-SAFE (caps at wave 0, does not throw) — matching the real fn; cycle detection is a
 * validator concern (solutioning-gate / computePlanWaves), surfaced via guardrail validator_conformance.
 * `case2-to-decision-real.mjs` calls the real fn on the same `waveInput`; the drift-guard test asserts
 * this port and the real fn agree.
 *
 * @param {ReturnType<typeof waveInput>} input   from waveInput(planOutput)
 * @returns {string[][]}  array of waves, each an array of storyIds, in wave order
 */
export function computeWaves(input, opts = {}) {
  const sentinel = opts.epicWideSentinel ?? '<EPIC_WIDE>';
  const byId = new Map(input.map((s) => [s.storyId, s]));

  // dependsOn-only waves (cycle-safe walk, cap 0) — mirrors computeStoryWaves
  const depWave = new Map();
  const walk = (id, visited = new Set()) => {
    if (depWave.has(id)) return depWave.get(id);
    if (visited.has(id)) return 0; // cycle safety
    visited.add(id);
    const s = byId.get(id);
    if (!s || !s.dependsOn || s.dependsOn.length === 0) { depWave.set(id, 0); return 0; }
    const dw = s.dependsOn.filter((d) => byId.has(d)).map((d) => walk(d, visited));
    const w = dw.length === 0 ? 0 : Math.max(...dw) + 1;
    depWave.set(id, w);
    return w;
  };
  for (const s of input) walk(s.storyId);

  // collision-aware placement — mirrors computeStoryWavesWithTouchPoints
  const normalize = (p) => p.trim().replace(/^\.\//, '');
  const placed = new Map();
  const claims = new Map();
  const claimFor = (w) => { if (!claims.has(w)) claims.set(w, { paths: new Set(), epicWide: false, count: 0 }); return claims.get(w); };
  const sorted = [...input].sort((a, b) => {
    const dw = (depWave.get(a.storyId) ?? 0) - (depWave.get(b.storyId) ?? 0);
    return dw !== 0 ? dw : (a.order ?? 0) - (b.order ?? 0);
  });
  for (const s of sorted) {
    const raw = (s.touchPoints ?? []).map(normalize).filter(Boolean);
    const isEpicWide = raw.includes(sentinel);
    const paths = raw.filter((p) => p !== sentinel);
    let w = 0;
    for (const dep of s.dependsOn ?? []) { const dwp = placed.get(dep); if (dwp !== undefined) w = Math.max(w, dwp + 1); }
    const collides = (wave) => {
      const c = claims.get(wave);
      if (!c) return false;
      if (c.epicWide) return true;
      if (isEpicWide) return c.count > 0;
      for (const p of paths) if (c.paths.has(p)) return true;
      return false;
    };
    while (collides(w)) w += 1;
    placed.set(s.storyId, w);
    const c = claimFor(w);
    c.count += 1;
    if (isEpicWide) c.epicWide = true;
    for (const p of paths) c.paths.add(p);
  }

  const maxW = Math.max(0, ...[...placed.values()]);
  const waves = [];
  for (let w = 0; w <= maxW; w++) {
    const layer = input.filter((s) => placed.get(s.storyId) === w).map((s) => s.storyId);
    if (layer.length) waves.push(layer);
  }
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
