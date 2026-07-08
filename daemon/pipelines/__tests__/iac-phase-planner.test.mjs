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
