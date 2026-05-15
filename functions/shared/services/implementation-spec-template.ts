/**
 * implementation-spec-template.ts — Pipeline v2 Phase 2-D / Story 2-D-8-1 (PR-101).
 *
 * `Plan.kind: implementation-spec` template per v2.5 §27.3. AWS-only plans
 * that materialize a manifest delta into infrastructure. Five epics,
 * deterministic — PM doesn't decompose; the template emits the epic
 * shape verbatim.
 *
 *   1. ARCHITECT — manifest delta proposal
 *   2. COMPILER  — generate CDK from delta
 *   3. CDK synth — verify shape parses (no apply)
 *   4. CDK diff  — show operator the AWS-level delta
 *   5. CDK deploy — apply (gated on operator confirm at production rigor)
 *
 * After plan close, drift detection (Story 3-S-3) takes over.
 */

export type ImplementationSpecEpic = {
  id: string;
  title: string;
  description: string;
  /** Which agent role drives the epic (mapped to RolePolicy). */
  primaryRole: 'ARCHITECT' | 'COMPILER' | 'DEV' | 'DEPLOY';
  /** Operator confirmation gate before next epic starts. */
  confirmationGate: 'auto' | 'operator-prototype-mvp' | 'operator-production' | 'operator-always';
  /** Estimated effort (S/M/L) — informational. */
  effort: 'S' | 'M' | 'L';
};

const TEMPLATE_EPICS: ImplementationSpecEpic[] = [
  {
    id: 'arch-1',
    title: 'ARCHITECT — manifest delta proposal',
    description:
      'ARCHITECT T2 runs against the plan intent. Outputs a proposed change set ' +
      'to .deployment/aws.manifest.yaml and .deployment/integrations.manifest.yaml. ' +
      'Decision card surfaces with cost-delta line per env (v2.5 §46).',
    primaryRole: 'ARCHITECT',
    confirmationGate: 'operator-always',
    effort: 'M',
  },
  {
    id: 'arch-2',
    title: 'COMPILER — generate CDK from manifest delta',
    description:
      'COMPILER reads the confirmed manifest delta + generates `deployment/cdk/lib/' +
      '<project>-<env>-stack.ts` per env. Existing CDK is overwritten (manifest is ' +
      'the source of truth; CDK is derived per v2.5 §25.1).',
    primaryRole: 'COMPILER',
    confirmationGate: 'auto',
    effort: 'S',
  },
  {
    id: 'arch-3',
    title: 'CDK synth — verify shape parses',
    description:
      'Daemon runs `cdk synth --quiet`. Failure → attention item ' +
      '`cdk-synth-failed` + roll back to previous manifest state. Success → ' +
      'CloudFormation templates land under cdk.out/.',
    primaryRole: 'DEPLOY',
    confirmationGate: 'auto',
    effort: 'S',
  },
  {
    id: 'arch-4',
    title: 'CDK diff — operator reviews AWS-level delta',
    description:
      'Daemon runs `cdk diff` per env. The diff body is attached to a decision ' +
      'card. Operator confirms or aborts. Production rigor: explicit operator ' +
      'approval required even if the diff is small.',
    primaryRole: 'DEPLOY',
    confirmationGate: 'operator-production',
    effort: 'S',
  },
  {
    id: 'arch-5',
    title: 'CDK deploy — apply to AWS',
    description:
      'Daemon runs `cdk deploy --require-approval never` (gated by the prior ' +
      'operator confirm step). Production rigor additionally requires the ' +
      'aws.manifest.yaml deploy-gate.requires entries (24h soak, security audit) ' +
      'before this step runs. Failure → attention item `cdk-deploy-failed`.',
    primaryRole: 'DEPLOY',
    confirmationGate: 'operator-production',
    effort: 'M',
  },
];

/**
 * Build the implementation-spec plan epic list. Snapshot of the template
 * — callers don't mutate. If a future tuning is needed, fork the
 * template at call site.
 */
export function getImplementationSpecEpics(): ImplementationSpecEpic[] {
  return TEMPLATE_EPICS.map((epic) => ({ ...epic }));
}

/**
 * Build the plan-creation payload for an implementation-spec plan.
 * Caller passes the operator's intent + the boilerplate kind + rigor;
 * this returns the plan shape the plan-creation API consumes.
 */
export function buildImplementationSpecPlanPayload(args: {
  appSlug: string;
  intent: string;
  planSlug: string;
  rigor: 'prototype' | 'mvp' | 'production';
}): {
  appSlug: string;
  name: string;
  intent: string;
  kind: 'implementation-spec';
  rigor: 'prototype' | 'mvp' | 'production';
  epics: ImplementationSpecEpic[];
  templated: true;
} {
  return {
    appSlug: args.appSlug,
    name: args.planSlug,
    intent: args.intent,
    kind: 'implementation-spec',
    rigor: args.rigor,
    epics: getImplementationSpecEpics(),
    templated: true,
  };
}

/**
 * Which gates fire under which rigor. Operators reading the plan
 * dashboard see this matrix to know when to expect a decision card.
 */
export function gateFiresUnder(
  gate: ImplementationSpecEpic['confirmationGate'],
  rigor: 'prototype' | 'mvp' | 'production',
): boolean {
  switch (gate) {
    case 'auto':
      return false;
    case 'operator-always':
      return true;
    case 'operator-production':
      return rigor === 'production';
    case 'operator-prototype-mvp':
      return rigor !== 'production';
  }
}
