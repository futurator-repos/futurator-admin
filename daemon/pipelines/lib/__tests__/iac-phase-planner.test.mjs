/**
 * iac-phase-planner.test.mjs — locks the Infrastructure MIGRATION track (Part B):
 * stack-aware tooling divergence, gap-driven omission of satisfied dimensions,
 * import ordering by fan-in × churn, bounded nextThree, and deprecated-toolchain
 * remediation steps. Pure lib, no I/O.
 */

import { describe, it, expect } from 'vitest';
import { planIacTrack, detectStackTool } from '../iac-phase-planner.mjs';

// A maturity grade at Level 1 (target 2). governance is ALREADY at target with no
// gaps (→ must be omitted); every other dimension is gapped (→ must emit a step).
const maturity = (over = {}) => ({
  level: 1,
  levelName: 'Repeatable',
  dimensions: {
    state: { level: 0, evidence: 'local state', gaps: ['no remote backend'] },
    envSeparation: { level: 0, evidence: 'one env', gaps: ['no per-env stacks'] },
    modularity: { level: 0, evidence: 'root monolith', gaps: ['no modules'] },
    testing: { level: 0, evidence: 'no tests', gaps: ['no tftest'] },
    governance: { level: 3, evidence: 'CrossGuard pack present', gaps: [] },
    driftCost: { level: 0, evidence: 'no drift check', gaps: ['no scheduled plan'] },
  },
  deprecated: [],
  regions: ['us-east-1'],
  regionPinned: true,
  tagTaxonomy: { present: ['team'], missing: ['cost-center'], coveragePct: 25 },
  findings: [],
  ...over,
});

const inventory = (over = {}) => ({
  services: [
    { name: 'DynamoDB', kind: 'database', cloud: 'AWS', fanIn: 2, files: ['src/a.ts'] },
    { name: 'S3', kind: 'storage', cloud: 'AWS', fanIn: 3, files: ['src/b.ts'] },
  ],
  iac: [],
  deployScripts: [],
  clouds: ['AWS'],
  iacCoverage: { provisionable: 2, declared: 0, ratio: 0, undeclared: ['DynamoDB', 'S3'] },
  summary: { iacProviders: ['SST'] },
  iacMaturity: maturity(),
  ...over,
});

const git = { churnByFile: { 'src/a.ts': 5, 'src/b.ts': 1 } };

describe('planIacTrack — guard', () => {
  it('returns null when the inventory has no iacMaturity grade', () => {
    expect(planIacTrack({ services: [] }, {})).toBeNull();
    expect(planIacTrack({ iacMaturity: null }, {})).toBeNull();
  });

  it('reports current/target level and the destination level name', () => {
    const p = planIacTrack(inventory(), { gitEvolution: git });
    expect(p.currentLevel).toBe(1);
    expect(p.targetLevel).toBe(2);
    expect(p.levelName).toBe('Defined');
  });
});

describe('detectStackTool — stack-aware tool resolution', () => {
  it('Pulumi providers → pulumi', () => {
    expect(detectStackTool({ summary: { iacProviders: ['Pulumi'] }, clouds: ['AWS'] })).toBe('pulumi');
  });
  it('Terraform providers → terraform', () => {
    expect(detectStackTool({ summary: { iacProviders: ['Terraform'] }, clouds: ['AWS'] })).toBe('terraform');
  });
  it('AWS CDK → cdk, but Terraform CDK (cdktf) → terraform', () => {
    expect(detectStackTool({ summary: { iacProviders: ['AWS CDK'] }, clouds: ['AWS'] })).toBe('cdk');
    expect(detectStackTool({ summary: { iacProviders: ['Terraform CDK'] }, clouds: ['AWS'] })).toBe('terraform');
  });
  it('GCP-primary Terraform → gcp-im (Infrastructure Manager)', () => {
    expect(detectStackTool({ summary: { iacProviders: ['Terraform'] }, clouds: ['GCP'] })).toBe('gcp-im');
  });
});

describe('planIacTrack — stack-aware tooling divergence', () => {
  const stateCmds = (inv) => {
    const p = planIacTrack(inv, { gitEvolution: git });
    const s = p.track.find((t) => t.dimension === 'state');
    return { step: s, joined: s.commands.join('\n'), tool: s.tool };
  };

  it('Pulumi emits `pulumi import --file` bulk + CrossGuard governance', () => {
    const inv = inventory({ summary: { iacProviders: ['Pulumi'] } });
    const { joined, tool } = stateCmds(inv);
    expect(tool).toBe('pulumi');
    expect(joined).toMatch(/pulumi import --file/);
    const p = planIacTrack(inv, { gitEvolution: git });
    expect(p.track.find((t) => t.dimension === 'driftCost').commands.join('\n')).toMatch(/pulumi preview --expect-no-changes/);
  });

  it('Terraform emits import {} blocks + -generate-config-out and NEVER Terraformer-as-pipeline', () => {
    const inv = inventory({ summary: { iacProviders: ['Terraform'] } });
    const { joined, tool } = stateCmds(inv);
    expect(tool).toBe('terraform');
    expect(joined).toMatch(/import \{\}/);
    expect(joined).toMatch(/-generate-config-out/);
    // Terraformer may only appear as an explicit one-shot NOTE, never a runnable step.
    expect(joined).toMatch(/Terraformer .*one-shot|one-shot .*Terraformer/i);
    expect(joined).not.toMatch(/^\s*terraformer import/im);
  });

  it('CDK emits cdk migrate/import and warns on RemovalPolicy defaults', () => {
    const inv = inventory({ summary: { iacProviders: ['AWS CDK'] } });
    const { joined, tool } = stateCmds(inv);
    expect(tool).toBe('cdk');
    expect(joined).toMatch(/cdk migrate/);
    expect(joined).toMatch(/RemovalPolicy/);
  });
});

describe('planIacTrack — gap-driven omission', () => {
  it('a satisfied dimension (governance at/above target, no gaps) emits NO step', () => {
    const p = planIacTrack(inventory(), { gitEvolution: git });
    const dims = p.track.map((t) => t.dimension);
    expect(dims).not.toContain('governance');
    // the gapped dimensions are all present
    expect(dims).toEqual(expect.arrayContaining(['state', 'envSeparation', 'modularity', 'testing', 'driftCost']));
  });

  it('when EVERY dimension is satisfied the track carries no dimension steps', () => {
    const sat = maturity({
      level: 3,
      dimensions: Object.fromEntries(
        ['state', 'envSeparation', 'modularity', 'testing', 'governance', 'driftCost'].map((d) => [d, { level: 4, evidence: 'ok', gaps: [] }]),
      ),
    });
    const p = planIacTrack(inventory({ iacMaturity: sat }), { gitEvolution: git });
    expect(p.track.filter((t) => t.dimension !== 'deprecated')).toHaveLength(0);
  });
});

describe('planIacTrack — import ordering by fan-in × churn', () => {
  it('sorts import targets DESC by fanIn*churn (DynamoDB 2*5=10 before S3 3*1=3)', () => {
    const p = planIacTrack(inventory(), { gitEvolution: git });
    const state = p.track.find((t) => t.dimension === 'state');
    expect(state.imports).toBeDefined();
    expect(state.imports.map((i) => i.resource).slice(0, 2)).toEqual(['DynamoDB', 'S3']);
    expect(state.imports[0].priority).toBe(10);
    expect(state.imports[1].priority).toBe(3);
  });

  it('deploy-scripts become import targets seeded from what we already detect', () => {
    const inv = inventory({
      deployScripts: [{ file: 'scripts/deploy.sh', kind: 'shell-deploy', provisions: ['DynamoDB'] }],
    });
    const gitWithScript = { churnByFile: { 'src/a.ts': 5, 'src/b.ts': 1, 'scripts/deploy.sh': 4 } };
    const p = planIacTrack(inv, { gitEvolution: gitWithScript });
    const state = p.track.find((t) => t.dimension === 'state');
    const scriptImport = state.imports.find((i) => i.source === 'scripts/deploy.sh');
    expect(scriptImport).toBeDefined();
    // deploy.sh provisions DynamoDB (fanIn 2) × churn 4 = 8
    expect(scriptImport.priority).toBe(8);
  });

  it('with no git history, priority degrades to fan-in (multiplier 1)', () => {
    const p = planIacTrack(inventory(), {});
    const state = p.track.find((t) => t.dimension === 'state');
    // S3 fanIn 3 > DynamoDB fanIn 2 when churn is unavailable
    expect(state.imports.map((i) => i.resource)).toEqual(['S3', 'DynamoDB']);
    expect(state.imports[0].priority).toBe(3);
  });
});

describe('planIacTrack — nextThree + golden rule', () => {
  it('nextThree is bounded to <= 3 highest-leverage (foundations-first) actions', () => {
    const p = planIacTrack(inventory(), { gitEvolution: git });
    expect(p.nextThree.length).toBeLessThanOrEqual(3);
    expect(p.nextThree[0].dimension).toBe('state'); // foundations first
    for (const n of p.nextThree) {
      expect(typeof n.title).toBe('string');
      expect(typeof n.action).toBe('string');
    }
  });

  it('every track step carries a stack-appropriate goldenRule (zero-changes gate)', () => {
    const p = planIacTrack(inventory({ summary: { iacProviders: ['Pulumi'] } }), { gitEvolution: git });
    for (const step of p.track) {
      expect(step.goldenRule).toMatch(/no changes|No changes/);
    }
    expect(p.track[0].goldenRule).toMatch(/pulumi preview/);
  });
});

describe('planIacTrack — deprecated toolchain', () => {
  it('a deprecated tool produces a remediation step at the front (urgent)', () => {
    const inv = inventory({
      summary: { iacProviders: ['Terraform CDK'] },
      iacMaturity: maturity({
        deprecated: [
          { tool: 'CDKTF', status: 'archived', eolDate: '2025-12-10', remediation: 'migrate to Terraform/OpenTofu or Pulumi', severity: 'high' },
        ],
      }),
    });
    const p = planIacTrack(inv, { gitEvolution: git });
    const dep = p.track.find((t) => t.dimension === 'deprecated');
    expect(dep).toBeDefined();
    expect(dep.phase).toBe(0);
    expect(dep.commands.join('\n')).toMatch(/migrate to Terraform\/OpenTofu or Pulumi/);
    // urgent → surfaces in nextThree
    expect(p.nextThree[0].dimension).toBe('deprecated');
  });

  it('GCP Deployment Manager EOL → urgent DM-convert remediation, tool = gcp-im', () => {
    const inv = inventory({
      clouds: ['GCP'],
      summary: { iacProviders: [] },
      iacMaturity: maturity({
        deprecated: [
          { tool: 'GCP Deployment Manager', status: 'EOL', eolDate: '2026-03-31', remediation: 'DM Convert → Terraform/KRM, then import into Infrastructure Manager', severity: 'high' },
        ],
      }),
    });
    const p = planIacTrack(inv, {});
    const dep = p.track.find((t) => t.dimension === 'deprecated');
    expect(dep).toBeDefined();
    expect(dep.tool).toBe('gcp-im');
    expect(dep.commands.join('\n')).toMatch(/DM Convert/);
  });
});
