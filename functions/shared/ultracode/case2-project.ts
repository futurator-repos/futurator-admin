/**
 * Case-2 projector (TypeScript) — projects a planOutput onto the DecisionPlan IR THROUGH the real
 * deployed services. TS port of `spikes/ultra-reverse/lib/case2-to-decision-real.mjs`, but cleaner:
 * it imports the real services directly (no Node type-strip hack), so it bundles into the Lambda.
 *
 *   - functions/shared/services/story-waves.ts  → computeStoryWavesWithTouchPoints (real layering)
 *   - functions/shared/pipelines/role-policy.ts → buildAgentConfig (real tool allowlist + maxTurns)
 */

import { computeStoryWavesWithTouchPoints } from '../services/story-waves';
import { buildAgentConfig } from '../pipelines/role-policy';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import {
  makeDecisionPlan,
  type DecisionPlan,
  type DecisionAgent,
  type DecisionPhase,
} from './decision-plan';

const EPIC_WIDE = '<EPIC_WIDE>';
const RIGOR_TIER: Record<PlanRigor, 'L0' | 'L1' | 'L2'> = {
  prototype: 'L0',
  mvp: 'L1',
  production: 'L2',
};

interface PlanStoryInput {
  id: string;
  dependsOn?: string[];
  touchPoints?: string[];
  references?: Array<{ source?: string }>;
}
interface PlanEpicInput {
  id: string;
  dependsOn?: string[];
  stories?: PlanStoryInput[];
}
export interface PlanOutputInput {
  plan?: { epics?: PlanEpicInput[] };
}

export interface Case2Ctx {
  target?: 'greenfield' | 'brownfield';
  rigor?: PlanRigor;
  devModel?: string;
  boilerplateKind?: BoilerplateType;
}

interface WaveStory {
  storyId: string;
  dependsOn: string[];
  touchPoints: string[];
  order: number;
}

/** Flatten plan stories + expand cross-epic deps into story-level dependsOn (identical to the .mjs). */
function waveInput(planOutput: PlanOutputInput): WaveStory[] {
  const epics = planOutput?.plan?.epics ?? [];
  const flat: Array<PlanStoryInput & { epicId: string; epicDependsOn: string[]; order: number }> =
    [];
  let order = 0;
  for (const e of epics) {
    for (const s of e.stories ?? []) {
      flat.push({ ...s, epicId: e.id, epicDependsOn: e.dependsOn ?? [], order: order++ });
    }
  }
  const ids = new Set(flat.map((s) => s.id));
  const byEpic = new Map<string, string[]>();
  for (const s of flat) {
    if (!byEpic.has(s.epicId)) byEpic.set(s.epicId, []);
    byEpic.get(s.epicId)!.push(s.id);
  }
  return flat.map((s) => {
    const deps = new Set<string>();
    for (const d of s.dependsOn ?? []) if (ids.has(d)) deps.add(d);
    for (const ep of s.epicDependsOn) for (const sid of byEpic.get(ep) ?? []) deps.add(sid);
    deps.delete(s.id);
    return {
      storyId: s.id,
      dependsOn: [...deps],
      touchPoints: s.touchPoints ?? [],
      order: s.order,
    };
  });
}

/**
 * Project a planOutput → DecisionPlan via the real wave layering + capability scoping.
 * Returns the plan plus the per-story real AgentConfig (the genuine capability-scoping evidence).
 */
export function case2Project(
  planOutput: PlanOutputInput,
  ctx: Case2Ctx = {},
): { plan: DecisionPlan; capability: Record<string, ReturnType<typeof buildAgentConfig>> } {
  const rigor: PlanRigor = ctx.rigor ?? 'mvp';
  const target = ctx.target ?? 'greenfield';
  const devModel = ctx.devModel ?? 'sonnet';
  const testTier = RIGOR_TIER[rigor] ?? 'L1';
  const boilerplateKind: BoilerplateType = ctx.boilerplateKind ?? 'nextjs-base';

  const input = waveInput(planOutput);
  const waveMap = computeStoryWavesWithTouchPoints(input); // Map<storyId, wave>
  const storyMeta = new Map<string, PlanStoryInput>(
    (planOutput?.plan?.epics ?? []).flatMap((e) =>
      (e.stories ?? []).map((s) => [s.id, s] as const),
    ),
  );

  const maxW = Math.max(0, ...[...waveMap.values()]);
  const capability: Record<string, ReturnType<typeof buildAgentConfig>> = {};
  const phases: DecisionPhase[] = [];
  for (let w = 0; w <= maxW; w++) {
    const ids = [...waveMap.entries()].filter(([, wave]) => wave === w).map(([id]) => id);
    if (ids.length === 0) continue;
    const agents: DecisionAgent[] = ids.map((id) => {
      const cfg = buildAgentConfig({
        boilerplateKind,
        rigor,
        role: 'DEV',
        name: id,
        model: devModel,
      });
      capability[id] = cfg;
      const s: Partial<PlanStoryInput> = storyMeta.get(id) ?? {};
      const tp = s.touchPoints ?? [];
      return {
        role: 'DEV',
        hasSchema: true,
        model: cfg.model ?? devModel,
        isolation: tp.length > 0 && !tp.includes(EPIC_WIDE) ? 'worktree' : 'none',
        agentType: 'DEV',
        testTier,
        skillBindings: (s.references ?? [])
          .map((r) => r.source)
          .filter((x): x is string => Boolean(x)),
      };
    });
    phases.push({
      name: `wave-${phases.length + 1}`,
      mode: ids.length > 1 ? 'parallel-barrier' : 'sequential',
      fanOut: ids.length > 1 ? { axis: 'stories', width: ids.length } : null,
      agents,
      ...(ids.length > 1
        ? { barrierReason: 'wave gate (real touch-point-collision layering)' }
        : {}),
    });
  }

  const phaseNames = phases.map((p) => p.name);
  const plan = makeDecisionPlan({
    pattern: target === 'brownfield' ? 'brownfield-harden' : 'greenfield-build',
    qualityPatterns: phases.some((p) => p.fanOut) ? ['fan-out-and-synthesize'] : [],
    phases,
    verify:
      rigor === 'production'
        ? { present: true, kind: 'adversarial' }
        : rigor === 'mvp'
          ? { present: true, kind: 'none' }
          : { present: false, kind: 'none' },
    reduceSteps: 0,
    earlyExit: false,
    edges: phaseNames.slice(0, -1).map((n, i) => [n, phaseNames[i + 1]] as [string, string]),
    source: 'case2-planspec',
    extraction: { lossy: ['real-services: computeStoryWavesWithTouchPoints + buildAgentConfig'] },
  });
  return { plan, capability };
}
