/**
 * scan-engine-job-runner.test.mjs — locks the orchestration: recon trust-gate,
 * deterministic mapping, swarm parse + anchored-guard, dedupe, phasing, and a
 * planOutput that passes the real char-net gate. Fake deps — no recon, no agents.
 */

import { describe, it, expect } from 'vitest';
import { runScanEngine } from '../scan-engine-job-runner.mjs';
import { findCharacterizationGateViolations } from '../refactor-audit-job-runner.mjs';

const job = {
  workingDir: '/repo',
  scanEnginePayload: { projectId: 'demo', projectPath: '/repo', src: 'src' },
};

function baseDeps(over = {}) {
  return {
    projectName: 'demo',
    concurrency: 4,
    runRecon: async () => ({ code: 0 }),
    runDecompose: async () => ({ code: 0 }),
    readArtifacts: async () => ({
      hotspots: [
        { kind: 'god-object', score: 90, severity: 'critical', title: 'God-object: store', files: ['src/lib/store.ts'], evidence: { methods: 40, file: 'src/lib/store.ts' }, suggestedAction: 'split' },
        { kind: 'dead-code', score: 40, severity: 'medium', title: 'Dead: old.ts', files: ['src/lib/old.ts'], evidence: { confidence: 'safe-candidate' }, suggestedAction: 'delete old.ts' },
      ],
      shards: { shards: [{ shardKey: '§sys:src--lib', name: 'src/lib', members: ['src/lib/store.ts'], depends: [], focus: 'Hotspots: store', analyze: true }], lowConfidence: false },
      privacySummary: { byRegulation: { gdpr: { categories: [{ category: 'Personal Data Store', severity: 'high', fileCount: 5, remediation: 'encrypt', citation: [], sampleFiles: [{ file: 'src/lib/store.ts' }] }] } } },
      anchoredPaths: new Set(['src/lib/store.ts', 'src/api/route.ts']),
      hubs: [{ file: 'src/lib/store.ts', inDegree: 38 }],
    }),
    spawnAgent: async ({ role }) => {
      if (role === 'scan-report-writer') return '# demo — Refactoring & System-Design Scan\n\n> assessment';
      if (role.startsWith('scan-xcut:error-handling')) {
        // one anchored finding + one hallucinated (unanchored) finding
        return `---FINDINGS---{"findings":[
          {"dimension":"correctness","severity":"High","effort":"Medium","location":"src/api/route.ts:12","issue":"fetch never checks res.ok","suggestion":"route through apiFetch<T>"},
          {"dimension":"correctness","severity":"High","effort":"Small","location":"src/ghost/nope.ts:1","issue":"hallucinated finding","suggestion":"n/a"}
        ]}---END_FINDINGS---`;
      }
      return '---FINDINGS---{"findings":[]}---END_FINDINGS---';
    },
    checkGate: (planOutput) => findCharacterizationGateViolations(planOutput),
    pushEvent: () => {},
    log: () => {},
    ...over,
  };
}

describe('runScanEngine', () => {
  it('aborts on recon trust-gate failures with a clear reason', async () => {
    expect((await runScanEngine(job, baseDeps({ runRecon: async () => ({ code: 2 }) }))).reason).toBe('graphify-missing');
    expect((await runScanEngine(job, baseDeps({ runRecon: async () => ({ code: 3 }) }))).reason).toBe('degenerate-build');
  });

  it('runs end-to-end: deterministic + LLM findings, dropping the hallucination', async () => {
    const r = await runScanEngine(job, baseDeps());
    expect(r.ok).toBe(true);
    const locs = r.findings.map((f) => f.location);
    // deterministic god-object + dead-code + privacy category present
    expect(locs).toContain('src/lib/store.ts:1');
    // anchored LLM finding kept
    expect(locs).toContain('src/api/route.ts:12');
    // hallucinated (unanchored) LLM finding dropped
    expect(locs).not.toContain('src/ghost/nope.ts:1');
    // a compliance finding from privacy
    expect(r.findings.some((f) => f.dimension === 'compliance')).toBe(true);
    expect(r.counts.byDimension.compliance).toBe(1);
  });

  it('produces a phased plan that passes the real characterization gate', async () => {
    const r = await runScanEngine(job, baseDeps());
    expect(r.phases.length).toBeGreaterThan(0);
    expect(findCharacterizationGateViolations(r.planOutput)).toEqual([]);
    expect(r.gateViolations).toEqual([]);
    // dead-code lands in Phase 0; god-object in Phase 4
    const phaseOf = (substr) => r.phases.find((p) => p.items.some((id) => id.includes(substr)))?.phase;
    expect(phaseOf('dead-code')).toBe(0);
    expect(phaseOf('god-object')).toBe(4);
  });

  it('emits the report markdown from the aggregator', async () => {
    const r = await runScanEngine(job, baseDeps());
    expect(r.reportMarkdown).toMatch(/Refactoring & System-Design Scan/);
  });
});
