/**
 * iac-phase-planner.test.mjs — locks the stack-aware IaC migration track. In
 * particular the `seq` display-ordinal contract: the canonical `phase` anchors skip
 * (a satisfied dimension is omitted) and repeat (envSep + modularity both = playbook
 * phase 3), so rendering `phase` raw produced "Phase 1, 3, 3, 4, 5, 6". `seq` must be
 * a clean 1..N sequence regardless.
 */

import { describe, it, expect } from 'vitest';
import { planIacTrack } from '../lib/iac-phase-planner.mjs';

// A Mycelium-shaped grade: state already at L2 (satisfied → skipped), the rest below
// target, and the data plane mostly undeclared (adoption step fires).
const myceliumLike = () => ({
  iacMaturity: {
    level: 1,
    dimensions: {
      state: { level: 2, gaps: [] }, // satisfied at target L2 → step omitted (the gap)
      envSeparation: { level: 1, gaps: ['separate stages'] }, // playbook phase 3
      modularity: { level: 1, gaps: ['extract modules'] }, //     playbook phase 3 (dup)
      testing: { level: 0, gaps: ['add tests'] },
      governance: { level: 0, gaps: ['add policy'] },
      driftCost: { level: 0, gaps: ['add drift check'] },
    },
  },
  iacCoverage: { resourceRatio: 0.06, undeclared: ['DynamoDB', 'S3'] },
  services: [{ name: 'SST', kind: 'iac', detectedBy: ['iac-declared'] }],
});

describe('planIacTrack — seq display ordinal', () => {
  it('emits a clean 1..N seq even when canonical phases skip and repeat', () => {
    const plan = planIacTrack(myceliumLike());
    expect(plan).toBeTruthy();
    const seqs = plan.track.map((s) => s.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // strictly 1..N, no gaps/dupes
  });

  it('keeps the canonical `phase` anchors (which DO skip/repeat) distinct from seq', () => {
    const plan = planIacTrack(myceliumLike());
    // no Phase 2 (state satisfied), and two playbook-phase-3 steps — the divergence seq fixes
    const phases = plan.track.map((s) => s.phase);
    expect(phases).not.toContain(2);
    expect(phases.filter((p) => p === 3).length).toBe(2);
  });

  it('leads with adoption (data-plane undeclared) and unlocks the downstream modules', () => {
    const plan = planIacTrack(myceliumLike());
    expect(plan.track[0].dimension).toBe('adoption');
    expect(plan.track[0].seq).toBe(1);
    expect(plan.track[0].unlocks).toEqual(
      expect.arrayContaining(['finops', 'privacy', 'policy-as-code']),
    );
    // the satisfied `state` dimension never appears as a step
    expect(plan.track.some((s) => s.dimension === 'state')).toBe(false);
  });
});

// A graph-sync-shaped inventory: DynamoDB + S3 are the live data plane; Memgraph carries a
// code-readable retirement signal and lives in infra/graph-sync/ alongside a Lambda; a
// sibling deploy script in the shared scripts/ dir provisions the stack's SQS.
const retiringStackInv = () => ({
  iacMaturity: {
    level: 1,
    dimensions: {
      state: { level: 2, gaps: [] },
      envSeparation: { level: 1, gaps: ['x'] },
      modularity: { level: 1, gaps: ['x'] },
      testing: { level: 0, gaps: ['x'] },
      governance: { level: 0, gaps: ['x'] },
      driftCost: { level: 0, gaps: ['x'] },
    },
  },
  iacCoverage: { resourceRatio: 0.1, undeclared: ['DynamoDB', 'Memgraph', 'S3', 'Lambda'] },
  services: [
    {
      name: 'DynamoDB',
      kind: 'database',
      dataStore: true,
      fanIn: 5,
      files: ['infra/graph-sync/custom-policy.json', 'src/lib/dynamo.ts'],
    },
    {
      name: 'Memgraph',
      kind: 'database',
      dataStore: true,
      orphanCandidate: true,
      orphanReason: 'retirement signal near this resource',
      files: ['infra/graph-sync/index.mjs', 'docs/concepts/server.mjs'],
    },
    { name: 'S3', kind: 'storage', dataStore: true, fanIn: 2, files: ['sst.config.ts'] },
    { name: 'Lambda', kind: 'compute', fanIn: 3, files: ['infra/graph-sync/deploy.sh'] },
  ],
  deployScripts: [
    { file: 'scripts/create-agents-table.sh', provisions: ['DynamoDB'], kind: 'deploy' },
    { file: 'scripts/deploy-graph-sync.sh', provisions: ['SQS'], kind: 'deploy' },
    // empty-provisions IAM-policy file, co-located in the retiring stack dir — mirrors the
    // real Mycelium shape (custom-policy.json) that retire-sequencing must order LAST.
    { file: 'infra/graph-sync/custom-policy.json', provisions: [], kind: 'iam-policy' },
  ],
});

describe('planIacTrack — keep/retire classifier + honest sourcing', () => {
  const adopt = (plan) => plan.track.find((s) => s.dimension === 'adoption');

  it('routes retiring resources to retire[] and NEVER lists them as import targets', () => {
    const plan = planIacTrack(retiringStackInv());
    const retired = new Set((plan.retire || []).map((r) => r.resource));
    const imported = new Set((adopt(plan).imports || []).map((im) => im.resource));
    // the explicitly-retired store + its whole stack are retire, not adopt
    expect(retired.has('Memgraph')).toBe(true);
    expect(retired.has('Lambda')).toBe(true); // co-located in infra/graph-sync/
    expect(retired.has('SQS')).toBe(true); // sibling script names the stack ("graph-sync")
    for (const r of retired) expect(imported.has(r)).toBe(false);
    // the live data plane is still adopted, from a shared scripts/ dir that must NOT propagate
    expect(imported.has('DynamoDB')).toBe(true);
    expect(imported.has('S3')).toBe(true);
  });

  it('sources each import from its DEFINING file, never an IAM policy or docs file', () => {
    const plan = planIacTrack(retiringStackInv());
    const dyn = (adopt(plan).imports || []).find((im) => im.resource === 'DynamoDB');
    // deploy script that creates it wins over the IAM policy (custom-policy.json) it appears in
    expect(dyn.source).toBe('scripts/create-agents-table.sh');
    expect(dyn.source).not.toMatch(/policy\.json|docs\//);
  });

  it('dedupes: a service provisioned by multiple scripts is ONE import entry', () => {
    const inv = retiringStackInv();
    inv.deployScripts.push({
      file: 'scripts/create-agents-table2.sh',
      provisions: ['DynamoDB'],
      kind: 'deploy',
    });
    const plan = planIacTrack(inv);
    const dynEntries = (adopt(plan).imports || []).filter((im) => im.resource === 'DynamoDB');
    expect(dynEntries).toHaveLength(1);
  });

  it('emits a pre-import data-protection gate when live stores are present', () => {
    const plan = planIacTrack(retiringStackInv());
    const pf = adopt(plan).preflight || [];
    expect(pf.some((p) => /point-in-time recovery|deletion protection/i.test(p))).toBe(true);
    expect(pf.some((p) => /versioning/i.test(p))).toBe(true);
  });

  it('attaches the golden rule ONLY to mutating steps', () => {
    const plan = planIacTrack(retiringStackInv());
    const g = Object.fromEntries(plan.track.map((s) => [s.dimension, !!s.goldenRule]));
    expect(g.adoption).toBe(true);
    expect(g.envSeparation).toBe(true);
    expect(g.modularity).toBe(true);
    expect(g.testing).toBe(false);
    expect(g.driftCost).toBe(false);
    expect(g.governance).toBe(false);
  });

  it('does NOT propagate retirement from a shared/root dir (no over-fire)', () => {
    // A retire signal whose only source is a shared scripts/ file (depth 2) or the repo
    // root must not tar unrelated resources.
    const inv = retiringStackInv();
    inv.services = inv.services.map((s) =>
      s.name === 'Memgraph' ? { ...s, files: ['scripts/old.sh'] } : s,
    );
    const plan = planIacTrack(inv);
    const retired = new Set((plan.retire || []).map((r) => r.resource));
    expect(retired.has('Memgraph')).toBe(true); // still retired (its own flag)
    expect(retired.has('DynamoDB')).toBe(false); // shared scripts/ never propagates
    expect(retired.has('S3')).toBe(false);
  });
});

// Full-shape inventory for the final-iteration surfaces: resources[] with PII, external
// 3rd-party services, tag taxonomy, an intentional-separation signal, and metering
// artifacts — mirrors the real Mycelium re-scan shape closely enough to exercise every
// new code path together.
const fullShapeInv = () => ({
  iacMaturity: {
    level: 1,
    dimensions: {
      state: { level: 2, gaps: [] },
      envSeparation: { level: 1, gaps: ['x'] },
      modularity: { level: 1, gaps: ['x'] },
      testing: { level: 0, gaps: ['x'] },
      governance: { level: 0, gaps: ['x'] },
      driftCost: { level: 0, gaps: ['x'] },
    },
    tagTaxonomy: { coveragePct: 0, missing: ['team', 'environment', 'cost-center'] },
  },
  iacCoverage: { resourceRatio: 0.1, undeclared: ['DynamoDB'] },
  iac: [{ provider: 'sst', tier: 'resource' }],
  intentionalSeparation: { present: true, evidence: '"SCOPE BOUNDARY" found in sst.config.ts' },
  meteringArtifacts: [{ kind: 'file', name: 'src/lib/usage.ts' }],
  external: [{ provider: 'Anthropic (Claude API)' }],
  services: [
    {
      name: 'DynamoDB',
      kind: 'database',
      dataStore: true,
      fanIn: 5,
      files: ['scripts/create-table.sh'],
      detectedBy: ['sdk-import'],
      costModel: 'metered',
      resources: [
        { name: 'App_Auth', declared: false, contains_pii: true },
        { name: 'App_Projects', declared: false, contains_pii: false },
      ],
    },
    { name: 'SST', kind: 'iac', detectedBy: ['iac-declared'], files: ['sst.config.ts'] },
    {
      name: 'Anthropic (Claude API)',
      kind: 'ai',
      cloud: '3rd-party',
      costModel: 'connectivity',
      declares: ['ANTHROPIC_API_KEY'],
      detectedBy: ['sdk-import', 'env-key'],
    },
  ],
  deployScripts: [{ file: 'scripts/create-table.sh', provisions: ['DynamoDB'], kind: 'deploy' }],
});

describe('Final iteration item 1/2/3 — targetArtifacts + manifest schema/preview', () => {
  it('emits a stack-aware targetArtifacts[] naming the concrete artifact set', () => {
    const plan = planIacTrack(fullShapeInv());
    const ids = plan.targetArtifacts.map((a) => a.id);
    expect(ids).toEqual([
      'compute-stack',
      'data-plane-stack',
      'tag-module',
      'policy-pack',
      'infra-manifest',
    ]);
    // SST's companion data-plane substrate is Pulumi (never hardcoded — derived from tool)
    expect(plan.targetArtifacts.find((a) => a.id === 'data-plane-stack').tool).toBe('pulumi');
    expect(plan.targetArtifacts.find((a) => a.id === 'infra-manifest').status).toBe('missing');
  });

  it('exposes a generic manifestSchema (never mentions Mycelium/any app name)', () => {
    const plan = planIacTrack(fullShapeInv());
    expect(plan.manifestSchema.node).toHaveProperty('id');
    expect(plan.manifestSchema.node).toHaveProperty('depends_on');
    expect(plan.manifestSchema.node).toHaveProperty('verification_status');
    expect(JSON.stringify(plan.manifestSchema)).not.toMatch(/mycelium/i);
  });

  it('manifestPreview reshapes real detections into node schema, honestly (arn null, depends_on [] when no graph)', () => {
    const plan = planIacTrack(fullShapeInv());
    const pii = plan.manifestPreview.nodes.find((n) => n.id === 'App_Auth');
    expect(pii.pii).toBe(true);
    expect(pii.tags.data_classification).toBe('PII');
    expect(pii.arn).toBeNull(); // not derivable from code alone — never fabricated
    expect(pii.depends_on).toEqual([]); // this fixture carries no serviceDependencyEdges
    expect(pii.verification_status).toBe('declared');
  });

  it('depends_on is populated from inventory.serviceDependencyEdges at SERVICE granularity', () => {
    const inv = fullShapeInv();
    inv.serviceDependencyEdges = { DynamoDB: ['Anthropic (Claude API)'] };
    const plan = planIacTrack(inv);
    // a resource-level node inherits its PARENT SERVICE's edge list
    const pii = plan.manifestPreview.nodes.find((n) => n.id === 'App_Auth');
    const other = plan.manifestPreview.nodes.find((n) => n.id === 'App_Projects');
    expect(pii.depends_on).toEqual(['Anthropic (Claude API)']);
    expect(other.depends_on).toEqual(['Anthropic (Claude API)']);
    // a service with no entry in serviceDependencyEdges stays honestly empty
    const sst = plan.manifestPreview.nodes.find((n) => n.id === 'SST');
    expect(sst.depends_on).toEqual([]);
  });

  it('3rd-party services are first-class manifestPreview.thirdParty nodes, not AWS IaC', () => {
    const plan = planIacTrack(fullShapeInv());
    const anthropic = plan.manifestPreview.thirdParty.find(
      (n) => n.id === 'Anthropic (Claude API)',
    );
    expect(anthropic.cost_model).toBe('connectivity');
    expect(anthropic.env_key).toBe('ANTHROPIC_API_KEY');
    expect(anthropic.dpa_required).toBe(true);
    expect(anthropic.dpa_verified).toBe(false); // code can never confirm a signed DPA
    expect(anthropic.metering_source.present).toBe(true);
    expect(anthropic.metering_source.candidates).toContain('src/lib/usage.ts');
  });

  it('metering_source.present is false when no usage/pricing/billing artifact was detected', () => {
    const inv = fullShapeInv();
    inv.meteringArtifacts = [];
    const plan = planIacTrack(inv);
    expect(plan.manifestPreview.thirdParty[0].metering_source.present).toBe(false);
  });
});

describe('Final iteration item 4 — import-substrate fork decision', () => {
  it('presents the fork (not one opinionated command) when intentionalSeparation is present', () => {
    const plan = planIacTrack(fullShapeInv());
    const adopt = plan.track.find((s) => s.dimension === 'adoption');
    expect(adopt.importDecision).toBeTruthy();
    expect(adopt.importDecision.options).toHaveLength(2);
    expect(adopt.importDecision.options.find((o) => o.id === 'separate-project').recommended).toBe(
      true,
    );
    // the opinionated "adopt in sst.config.ts" line is gone; only the golden-rule check remains
    expect(adopt.commands.some((c) => /adopt existing resources/i.test(c))).toBe(false);
    expect(adopt.commands.some((c) => /MUST show/i.test(c))).toBe(true);
  });

  it('keeps the existing single-recommendation behavior when no separation signal exists (default case)', () => {
    const inv = fullShapeInv();
    inv.intentionalSeparation = { present: false, evidence: null };
    const plan = planIacTrack(inv);
    const adopt = plan.track.find((s) => s.dimension === 'adoption');
    expect(adopt.importDecision).toBeUndefined();
    expect(adopt.commands.some((c) => /adopt existing resources/i.test(c))).toBe(true);
  });
});

describe('Final iteration item 5 — retire sequencing', () => {
  it('orders teardown compute -> messaging -> IAM, excludes data-store kinds from auto-sequencing', () => {
    const plan = planIacTrack(retiringStackInv());
    const adopt = plan.track.find((s) => s.dimension === 'adoption');
    const seq = adopt.retireSequence;
    expect(seq).toBeTruthy();
    const orderOf = (re) => seq.steps.findIndex((s) => re.test(s.action));
    const computeIdx = orderOf(/Delete compute/);
    const messagingIdx = orderOf(/Delete messaging/);
    const iamIdx = orderOf(/Delete IAM/);
    expect(computeIdx).toBeGreaterThanOrEqual(0);
    expect(computeIdx).toBeLessThan(messagingIdx);
    expect(messagingIdx).toBeLessThan(iamIdx);
    // Memgraph (kind: database) is never auto-sequenced — a separate human decision
    expect(seq.excludedFromSequencing.some((r) => r.resource === 'Memgraph')).toBe(true);
    expect(seq.steps.some((s) => /Memgraph/.test(s.action))).toBe(false);
  });

  it('returns null when nothing is retiring', () => {
    const inv = fullShapeInv(); // no orphan/retire signal
    const plan = planIacTrack(inv);
    const adopt = plan.track.find((s) => s.dimension === 'adoption');
    expect(adopt.retireSequence).toBeUndefined();
  });
});

describe('Final iteration item 6 — FinOps-readiness testable DoD', () => {
  it('lists the exact unmet conditions, never asserts ready=true prematurely', () => {
    const plan = planIacTrack(fullShapeInv());
    expect(plan.finopsReadiness.ready).toBe(false);
    expect(plan.finopsReadiness.basis).toBe('declared');
    const blocked = plan.finopsReadiness.blockedBy.join(' | ');
    expect(blocked).toMatch(/DynamoDB/); // still-undeclared resource named
    expect(blocked).toMatch(/tag taxonomy incomplete/);
    expect(blocked).toMatch(/manifest not yet generated/); // honest permanent blocker today
  });

  it('does NOT block on metering when an artifact was detected for the only external service', () => {
    const plan = planIacTrack(fullShapeInv());
    const blocked = plan.finopsReadiness.blockedBy.join(' | ');
    expect(blocked).not.toMatch(/metering-source/);
  });

  it('DOES block on metering when externals exist but nothing was detected', () => {
    const inv = fullShapeInv();
    inv.meteringArtifacts = [];
    const plan = planIacTrack(inv);
    expect(plan.finopsReadiness.blockedBy.join(' | ')).toMatch(/metering-source/);
  });

  it('drops the still-undeclared blocker once imports[] is empty (fully adopted)', () => {
    const inv = fullShapeInv();
    inv.iacCoverage = { resourceRatio: 1, undeclared: [] };
    inv.deployScripts = []; // buildImports also seeds from deployScripts independently
    const plan = planIacTrack(inv);
    expect(plan.finopsReadiness.blockedBy.some((b) => /still undeclared/.test(b))).toBe(false);
  });
});

describe('Growth rule (birth certificate) — the authority invariant on the plan', () => {
  it('every plan carries the static, tool-agnostic IaC growth rule + how it is enforced', () => {
    const plan = planIacTrack(fullShapeInv());
    expect(plan.growthRule.authority).toBe('iac');
    expect(plan.growthRule.rule).toMatch(/BORN declared/);
    expect(plan.growthRule.rule).toMatch(/tag taxonomy/);
    expect(plan.growthRule.enforcedBy).toMatch(/policy pack/);
  });

  it('is identical regardless of detected tool (contract-enforced, not tool-enforced)', () => {
    const sstPlan = planIacTrack(fullShapeInv());
    const inv = fullShapeInv();
    inv.iac = [{ provider: 'terraform', tier: 'resource' }];
    const tfPlan = planIacTrack(inv);
    expect(tfPlan.growthRule).toEqual(sstPlan.growthRule);
  });
});
