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

  // ── Granular (targeted) re-scan — merge into the persisted scan ──
  // A prior scan with attributable LLM findings (producedBy = task key) + a
  // deterministic one. Targeting a single pass re-runs only that pass.
  const priorScan = {
    scannedSha: 'aaaa1111',
    findings: [
      { id: 'p-eh-1', source: 'llm', producedBy: 'error-handling', dimension: 'correctness', severity: 'High', effort: 'Small', location: 'src/api/route.ts:12', issue: 'fetch never checks res.ok', suggestion: 'route through apiFetch' },
      { id: 'p-ss-1', source: 'llm', producedBy: 'safety-security', dimension: 'safety-security', severity: 'High', effort: 'Medium', location: 'src/lib/store.ts:5', issue: 'stale security finding to be replaced', suggestion: 'x' },
      { id: 'p-sys-1', source: 'llm', producedBy: '§sys:src--lib', dimension: 'architecture', severity: 'Medium', effort: 'Medium', location: 'src/lib/store.ts:99', issue: 'subsystem finding kept untouched', suggestion: 'y' },
      { id: 'p-det-1', source: 'deterministic', producedBy: 'deterministic', dimension: 'code-quality-refactoring', severity: 'Medium', effort: 'Small', location: 'src/lib/old.ts:1', issue: 'prior deterministic finding', suggestion: 'z' },
    ],
  };

  function targetedDeps(over = {}) {
    return baseDeps({
      readPriorScan: async () => priorScan,
      reconAvailable: () => true,
      spawnAgent: async ({ role }) => {
        if (role === 'scan-xcut:safety-security') {
          return `---FINDINGS---{"findings":[
            {"dimension":"safety-security","severity":"High","effort":"Small","location":"src/lib/store.ts:5","issue":"FRESH security finding from re-run","suggestion":"sanitize"}
          ]}---END_FINDINGS---`;
        }
        return '---FINDINGS---{"findings":[]}---END_FINDINGS---';
      },
      ...over,
    });
  }
  const targetedJob = (payload) => ({ ...job, scanEnginePayload: { ...job.scanEnginePayload, ...payload } });

  it('targeted re-run swaps the targeted task, keeps the rest, reuses recon', async () => {
    let reconCalls = 0;
    const deps = targetedDeps({ runRecon: async () => { reconCalls++; return { code: 0 }; } });
    const r = await runScanEngine(targetedJob({ targets: ['safety-security'] }), deps);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('targeted');
    expect(reconCalls).toBe(0); // reuseRecon (default) skipped recon entirely
    const issues = r.findings.map((f) => f.issue);
    // fresh safety finding replaced the stale one
    expect(issues).toContain('FRESH security finding from re-run');
    expect(issues).not.toContain('stale security finding to be replaced');
    // untargeted prior findings preserved
    expect(issues).toContain('fetch never checks res.ok'); // error-handling pass
    expect(issues).toContain('subsystem finding kept untouched'); // §sys:src--lib
    expect(issues).toContain('prior deterministic finding'); // deterministic layer
    // report regenerated deterministically (no writer agent)
    expect(r.reportMarkdown).toMatch(/targeted/);
  });

  it('a targeted re-run with zero fresh findings REMOVES the targeted task\'s old findings', async () => {
    const deps = targetedDeps({ spawnAgent: async () => '---FINDINGS---{"findings":[]}---END_FINDINGS---' });
    const r = await runScanEngine(targetedJob({ targets: ['safety-security'] }), deps);
    const issues = r.findings.map((f) => f.issue);
    expect(issues).not.toContain('stale security finding to be replaced'); // vanished = "fixed"
    expect(issues).toContain('fetch never checks res.ok'); // others untouched
  });

  it('auto-target diffs the changed files onto the owning subsystems', async () => {
    let changedSinceSha = null;
    const deps = targetedDeps({
      runRecon: async () => ({ code: 0 }), // autoTarget refreshes recon
      changedFiles: async (sha) => { changedSinceSha = sha; return ['src/lib/store.ts']; },
    });
    const r = await runScanEngine(targetedJob({ autoTargetChanged: true }), deps);
    expect(r.ok).toBe(true);
    expect(changedSinceSha).toBe('aaaa1111'); // diffed against the recorded SHA
    // src/lib/store.ts belongs to §sys:src--lib → that shard's analyzer re-ran; the
    // untargeted error-handling pass is preserved from the prior scan.
    expect(r.findings.map((f) => f.issue)).toContain('fetch never checks res.ok');
  });

  it('targeted with NO prior scan degrades to a full scan', async () => {
    // baseDeps' full swarm (error-handling returns the anchored route.ts finding).
    const deps = baseDeps({ readPriorScan: async () => null, reconAvailable: () => true });
    const r = await runScanEngine(targetedJob({ targets: ['safety-security'] }), deps);
    expect(r.ok).toBe(true);
    // full swarm ran → the anchored error-handling finding from baseDeps is present
    expect(r.findings.map((f) => f.location)).toContain('src/api/route.ts:12');
  });

  it("deterministic mode skips the swarm (no LLM agents) but still maps + plans", async () => {
    let agentCalls = 0;
    const deps = baseDeps({ spawnAgent: async () => { agentCalls++; return '---FINDINGS---{"findings":[]}---END_FINDINGS---'; } });
    const detJob = { ...job, scanEnginePayload: { ...job.scanEnginePayload, mode: 'deterministic' } };
    const r = await runScanEngine(detJob, deps);
    expect(r.ok).toBe(true);
    expect(agentCalls).toBe(0); // NO swarm + NO report-writer LLM call
    expect(r.counts.llm).toBe(0);
    // deterministic findings (hotspots + privacy) still present + planned
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.phases.length).toBeGreaterThan(0);
    expect(r.reportMarkdown).toMatch(/deterministic/);
  });
});
