// case2-to-decision-real.mjs — the PRODUCTION-fidelity Case-2 projector (design §4, closes risk #4).
//
// Projects a planOutput THROUGH the real deployed services instead of the plain-JS slice port:
//   • functions/shared/services/story-waves.ts  → computeStoryWavesWithTouchPoints (real wave layering)
//   • functions/shared/pipelines/role-policy.ts → buildAgentConfig (real tool allowlist + maxTurns)
//
// Works because Node ≥23.6 strips TS types at import (verified on node v26.3.1). The real services
// are pure (type-only imports) + zod, so they load with no build step. The drift-guard test asserts
// this and the plain `case2ToDecision` agree on wave structure — so the fast hermetic unit tests stay
// trustworthy while the bench can score the REAL behavior.
//
// Async because it dynamically imports the TS services (and degrades to the plain port if stripping
// is unavailable, e.g. an older runtime).

import { case2ToDecision, waveInput } from './case2-to-decision.mjs';
import { makeDecisionPlan } from './decision-schema.mjs';

const SERVICES = {
  storyWaves: '../../../functions/shared/services/story-waves.ts',
  rolePolicy: '../../../functions/shared/pipelines/role-policy.ts',
};
const RIGOR_TIER = { prototype: 'L0', mvp: 'L1', production: 'L2' };

/**
 * @param {object} planOutput
 * @param {{target?:string, rigor?:'prototype'|'mvp'|'production', devModel?:string, boilerplateKind?:string, grounded?:boolean}} [ctx]
 * @returns {Promise<import('./decision-schema.mjs').DecisionPlan & {capability?:object}>}
 */
export async function case2ToDecisionReal(planOutput, ctx = {}) {
  let storyWaves, rolePolicy;
  try {
    storyWaves = await import(new URL(SERVICES.storyWaves, import.meta.url));
    rolePolicy = await import(new URL(SERVICES.rolePolicy, import.meta.url));
  } catch (err) {
    // runtime can't strip TS → fall back to the faithful plain port, tagged so it's auditable
    const plain = case2ToDecision(planOutput, ctx);
    plain.extraction.lossy.push(`real-services-unavailable: ${err?.code || err?.message} → used plain port`);
    return plain;
  }

  const rigor = ctx.rigor ?? 'mvp';
  const target = ctx.target ?? 'greenfield';
  const devModel = ctx.devModel ?? 'default';
  const testTier = RIGOR_TIER[rigor] ?? 'L1';
  const boilerplateKind = ctx.boilerplateKind ?? 'nextjs-base';

  const input = waveInput(planOutput); // SAME input the plain port uses → identical layering
  const waveMap = storyWaves.computeStoryWavesWithTouchPoints(input); // Map<storyId, wave>
  const storyMeta = new Map(
    (planOutput?.plan?.epics ?? []).flatMap((e) => (e.stories ?? []).map((s) => [s.id, s])),
  );

  // group storyIds by wave number
  const maxW = Math.max(0, ...[...waveMap.values()]);
  const capability = {}; // storyId → real AgentConfig (the genuine capability scoping)
  const phases = [];
  for (let w = 0; w <= maxW; w++) {
    const ids = [...waveMap.entries()].filter(([, wave]) => wave === w).map(([id]) => id);
    if (ids.length === 0) continue;
    const agents = ids.map((id) => {
      const cfg = rolePolicy.buildAgentConfig({ boilerplateKind, rigor, role: 'DEV', name: id, model: devModel });
      capability[id] = cfg;
      const s = storyMeta.get(id) ?? {};
      const tp = s.touchPoints ?? [];
      return {
        role: 'DEV',
        hasSchema: true,
        model: cfg.model ?? devModel,
        isolation: tp.length > 0 && !tp.includes('<EPIC_WIDE>') ? 'worktree' : 'none',
        agentType: 'DEV',
        testTier,
        skillBindings: (s.references ?? []).map((r) => r.source).filter(Boolean),
      };
    });
    phases.push({
      name: `wave-${phases.length + 1}`,
      mode: ids.length > 1 ? 'parallel-barrier' : 'sequential',
      fanOut: ids.length > 1 ? { axis: 'stories', width: ids.length } : null,
      agents,
      ...(ids.length > 1 ? { barrierReason: 'wave gate (real touch-point-collision layering)' } : {}),
    });
  }

  const phaseNames = phases.map((p) => p.name);
  const plan = makeDecisionPlan({
    pattern: target === 'brownfield' ? 'brownfield-harden' : 'greenfield-build',
    qualityPatterns: phases.some((p) => p.fanOut) ? ['fan-out-and-synthesize'] : [],
    phases,
    verify: rigor === 'production' ? { present: true, kind: 'adversarial' } : rigor === 'mvp' ? { present: true, kind: 'none' } : { present: false, kind: 'none' },
    reduceSteps: 0,
    earlyExit: false,
    edges: phaseNames.slice(0, -1).map((n, i) => [n, phaseNames[i + 1]]),
    source: 'case2-planspec',
    extraction: { lossy: ['real-services: computeStoryWavesWithTouchPoints + buildAgentConfig'] },
  });
  plan.capability = capability; // real per-story tool allowlist + maxTurns (feeds guardrail capability_scoping)
  return plan;
}
