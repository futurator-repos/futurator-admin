/**
 * Ultracode-Reverse — the DecisionPlan IR, in TypeScript.
 *
 * The normalization target both engines reduce to. This is the TS port of
 * `spikes/ultra-reverse/lib/decision-schema.mjs` so the API Lambda (esbuild-bundled,
 * cannot run the .mjs / type-strip path) and the daemon share one typed engine.
 * The `.mjs` prototype stays as the standalone CLI harness; a cross-check test
 * asserts this port and the prototype agree.
 */

export type Pattern =
  | 'build-verify-fix'
  | 'plan-synthesis-critique'
  | 'greenfield-build'
  | 'brownfield-harden'
  | 'research'
  | 'other';

export type QualityPattern =
  | 'fan-out-and-synthesize'
  | 'adversarial-verification'
  | 'perspective-diverse-verify'
  | 'tournament'
  | 'generate-and-filter'
  | 'loop-until-done'
  | 'classify-and-act';

export type VerifyKind = 'adversarial' | 'perspective-diverse' | 'judge-panel' | 'none';
export type PhaseMode = 'sequential' | 'parallel-barrier' | 'streaming';

export interface DecisionAgent {
  role: string;
  hasSchema: boolean;
  model: string;
  isolation: 'none' | 'worktree';
  agentType?: string | null;
  testTier?: 'L0' | 'L1' | 'L2' | null;
  skillBindings?: string[];
}

export interface DecisionPhase {
  name: string;
  mode: PhaseMode;
  fanOut: { axis: string; width: number | 'dynamic' } | null;
  agents: DecisionAgent[];
  barrierReason?: string;
}

export interface DecisionPlan {
  pattern: Pattern;
  qualityPatterns: QualityPattern[];
  phases: DecisionPhase[];
  verify: { present: boolean; kind: VerifyKind };
  reduceSteps: number;
  earlyExit: boolean;
  edges: Array<[string, string]>;
  source: 'case1-script' | 'case2-planspec';
  extraction: { lossy: string[] };
}

export function makeDecisionPlan(partial: Partial<DecisionPlan> = {}): DecisionPlan {
  return {
    pattern: partial.pattern ?? 'other',
    qualityPatterns: partial.qualityPatterns ?? [],
    phases: partial.phases ?? [],
    verify: partial.verify ?? { present: false, kind: 'none' },
    reduceSteps: partial.reduceSteps ?? 0,
    earlyExit: partial.earlyExit ?? false,
    edges: partial.edges ?? [],
    source: partial.source ?? 'case1-script',
    extraction: partial.extraction ?? { lossy: [] },
  };
}
