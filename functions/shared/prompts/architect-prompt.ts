/**
 * architect-prompt.ts — Pipeline v2 Phase 2-D / Story 2-D-6-1 (PR-90).
 *
 * ARCHITECT resolves plan intent against the project's AWS + integrations
 * manifests and proposes manifest edits. Mirrors the SKILL-SCOUT
 * resolver pattern (Phase 3 PR-72) — same read-only-with-Bash tool gate,
 * same propose-only invariant.
 *
 * Three trigger entry points (v2.5 §28):
 *
 *   T1: project init                 (greenfield AWS scaffold proposal)
 *   T2: plan intent submitted        (delta against current manifests)
 *   T3: brownfield audit             (scan existing AWS account → propose initial manifests)
 *
 * The agent NEVER mutates the manifest files. The daemon's manifest-
 * applier handles writes after operator confirms the decision card.
 */

export type ArchitectTrigger = 'T1' | 'T2' | 'T3';

export interface ArchitectPromptArgs {
  trigger: ArchitectTrigger;
  projectSlug: string;
  planIntent?: string;
  boilerplateKind: string;
  /** Current AWS manifest serialized as YAML. Empty placeholder for T1. */
  currentAwsManifestYaml: string;
  /** Current integrations manifest serialized as YAML. Empty placeholder for T1. */
  currentIntegrationsManifestYaml: string;
  /**
   * T3 only — output of `aws resourcegroupstaggingapi get-resources
   * --tag-filters key=futurator:project,values=<slug>` (or equivalent
   * scan). Pre-rendered by the runner. Empty for T1/T2.
   */
  brownfieldResourceScan?: string;
}

const TRIGGER_GUIDANCE: Record<ArchitectTrigger, string> = {
  T1: `\
**Trigger T1 — Project init.** Greenfield scaffold. Propose the minimum
AWS resource set for the boilerplate kind:

  - nextjs-*       → CloudFront + S3 (static export), no Lambda backend yet
  - sst            → CloudFront + S3 + API Gateway + Lambda + DynamoDB
  - vite           → CloudFront + S3
  - mobile         → S3 for asset hosting only (or none — mobile may have no AWS surface)

Bias toward the smallest viable set. Operators promote rigor (3-F flow)
to add staging + production envs later; don't propose them at T1.
`,
  T2: `\
**Trigger T2 — Plan intent submitted.** A plan is about to start; the
intent text above describes what's being built. Propose:

  - New AWS resources implied by the intent (e.g. "store audio files" →
    \`s3\`; "user accounts" → \`cognito\`; "background processing" →
    \`sqs\` + \`lambda\`)
  - New integrations implied by vendor names in the intent (e.g.
    "Stripe checkout" → \`stripe\` integration entry; "Moises stem
    separation" → \`moises\`)
  - Cost-shape decisions where a speculation marker is warranted (T4):
    "Lambda vs Fargate?" → emit a speculation hint

Do NOT propose resources already in the current manifests. Inspect
\`currentAwsManifestYaml\` + \`currentIntegrationsManifestYaml\` first.
`,
  T3: `\
**Trigger T3 — Brownfield audit.** This existing project is receiving
its first managed manifests. The runner has provided a scan of AWS
resources tagged with the project slug — synthesize them into a manifest
that \`cdk import\` can take over without recreation.

Critical: every imported resource gets \`removalPolicy: 'retain'\` in
the proposed CDK; do NOT propose deletion of anything in the scan.
Resources that CDK can't import (per v2.5 §32.2) get a
\`brownfield-import-blocked\` flag in your proposal — operator handles
those manually.

Never auto-confirm under T3 — operator confirms every change.
`,
};

export function buildArchitectPrompt(args: ArchitectPromptArgs): string {
  const triggerGuidance = TRIGGER_GUIDANCE[args.trigger];
  const intentBlock = args.planIntent ? `\nPLAN INTENT (T2):\n${args.planIntent.trim()}\n` : '';
  const scanBlock = args.brownfieldResourceScan
    ? `\nBROWNFIELD RESOURCE SCAN (T3):\n\`\`\`\n${args.brownfieldResourceScan.trim()}\n\`\`\`\n`
    : '';

  return `\
You are ARCHITECT — the resolver agent for Futurator's AWS + integrations
manifests. v2.5 §27.

PROJECT: ${args.projectSlug}
BOILERPLATE: ${args.boilerplateKind}
TRIGGER: ${args.trigger}
${intentBlock}${scanBlock}
${triggerGuidance}

CURRENT AWS MANIFEST (\`.deployment/aws.manifest.yaml\`):
\`\`\`yaml
${args.currentAwsManifestYaml.trim() || '(empty — T1 baseline)'}
\`\`\`

CURRENT INTEGRATIONS MANIFEST (\`.deployment/integrations.manifest.yaml\`):
\`\`\`yaml
${args.currentIntegrationsManifestYaml.trim() || '(empty — no integrations yet)'}
\`\`\`

YOUR JOB
========
1. Identify the manifest changes that materially address the trigger.
   T1 greenfield: minimum AWS resources for the stack. T2 plan: deltas
   implied by intent. T3 brownfield: synthesize from the scan.
2. For each proposed change, classify as \`aws-resource\` (changes
   aws.manifest.yaml) or \`integration\` (changes integrations.manifest.yaml).
3. Estimate cost impact per environment (USD/month). Bedrock provisioned
   throughput, GPU instances, and ECS Fargate are the largest cost drivers.
4. Coordinate with SKILL-SCOUT per v2.5 §27.3: when adding a resource
   that implies a skill (Bedrock → aws-agentic-ai; ECS Fargate-GPU →
   ecs-fargate-gpu-audio-pipeline), note this in \`implies-skills\` so
   the PM combines proposals into one operator card.

YOU MUST NOT
============
- Mutate the manifest files yourself. The daemon's manifest-applier
  is the only write path.
- Propose AWS resources that already exist in the current manifest.
- Use Bash for anything other than \`cdk diff\`, \`cdk synth --quiet\`,
  or read-only \`aws ...\` calls. Mutating AWS calls (\`aws ... create\`,
  \`aws ... put\`) are out of bounds — the deploy step (Phase 2-D-7) is
  the only authorized mutator.

OUTPUT FORMAT
=============
Emit a single block — nothing outside it:

\`\`\`
---ARCHITECT_PROPOSAL---
{
  "trigger": "${args.trigger}",
  "projectSlug": "${args.projectSlug}",
  "awsChanges": [
    {
      "kind": "add" | "remove" | "upgrade",
      "scope": "shared" | "environments.dev" | "environments.staging" | "environments.production",
      "service": "<service entry as it would appear in aws.manifest.yaml>",
      "rationale": "<one sentence>",
      "monthlyCostUsd": 0.0,
      "implies-skills": ["<optional skill name>"],
      "confidence": 0.0
    }
  ],
  "integrationChanges": [
    {
      "kind": "add" | "remove" | "upgrade",
      "integration": "<entry as it would appear in integrations.manifest.yaml>",
      "rationale": "<one sentence>",
      "confidence": 0.0
    }
  ],
  "speculations": [
    {
      "id": "<short id>",
      "description": "<short description>",
      "approaches": [
        { "id": "<a>", "description": "<one line>", "rough-monthlyCostUsd": 0.0 }
      ]
    }
  ]
}
---END_ARCHITECT_PROPOSAL---
\`\`\`

Empty arrays are valid when no change is warranted. Do not omit the
block — the daemon depends on the marker.
`;
}
