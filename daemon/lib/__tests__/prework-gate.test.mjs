import { describe, it, expect } from 'vitest';
import { evaluatePreworkGate, renderGateEvidence } from '../prework-gate.mjs';

// Build injectable fakes for each of the three signal helpers so the
// orchestrator can be tested without touching the real fs / git / shell.
function makeDeps({
  commits = [],
  candidates = ['applyGravity'],
  exportsPresent = ['applyGravity'],
  exportsMissing = [],
  tscOk = true,
  tscOutput = '',
  tscCached = false,
} = {}) {
  return {
    collectRecentTouchPointWork: () => ({ skipped: false, commits }),
    extractCandidateExports: () => candidates,
    checkExportsPresent: async () => ({
      allPresent: exportsMissing.length === 0 && exportsPresent.length > 0,
      present: exportsPresent,
      missing: exportsMissing,
      filesScanned: ['src/dino.ts'],
    }),
    runCachedTypecheck: async () => ({
      ok: tscOk,
      gitSha: 'abc123',
      output: tscOutput,
      cached: tscCached,
      ranAtMs: 0,
    }),
  };
}

const baseInput = {
  projectDir: '/proj',
  planStartTime: '2026-04-28T10:00:00Z',
  touchPoints: ['src/dino.ts'],
  acText: 'Implements `applyGravity`.',
};

describe('evaluatePreworkGate — decision matrix', () => {
  it('skips gate when projectDir is missing', async () => {
    const v = await evaluatePreworkGate({ ...baseInput, projectDir: '' });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('projectDir');
  });

  it('skips gate when no touchPoints declared', async () => {
    const v = await evaluatePreworkGate({ ...baseInput, touchPoints: [] });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('touchPoints');
  });

  it('skips gate when no AC text provided', async () => {
    const v = await evaluatePreworkGate({ ...baseInput, acText: '' });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('AC text');
  });

  it('fails when no recent commits in scope (Signal 1)', async () => {
    const deps = makeDeps({ commits: [] });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('no recent commits');
    expect(v.evidence.recentCommits).toEqual([]);
  });

  it('fails when no candidate exports extractable (Signal 2 input)', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init', files: ['src/dino.ts'] }],
      candidates: [],
    });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('extractable named exports');
  });

  it('fails when one or more exports missing from touchPoints (Signal 2)', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init', files: ['src/dino.ts'] }],
      candidates: ['applyGravity', 'startJump'],
      exportsPresent: ['applyGravity'],
      exportsMissing: ['startJump'],
    });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('not found');
    expect(v.reason).toContain('startJump');
  });

  it('fails when typecheck fails (Signal 3)', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init', files: ['src/dino.ts'] }],
      tscOk: false,
      tscOutput: 'TS2322: type error',
    });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('typecheck not clean');
    expect(v.evidence.typecheck.output).toContain('TS2322');
  });

  it('passes when all three signals green', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init dino', files: ['src/dino.ts'] }],
      candidates: ['applyGravity'],
      exportsPresent: ['applyGravity'],
      tscOk: true,
    });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(false);
    expect(v.reason).toContain('gate-passed');
    expect(v.evidence.recentCommits.length).toBe(1);
    expect(v.evidence.exportsPresent).toEqual(['applyGravity']);
    expect(v.evidence.typecheck.ok).toBe(true);
  });

  it('honors skipTypecheck flag (e.g., for tests)', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init', files: ['src/dino.ts'] }],
      tscOk: false, // even with tsc=fail, skipTypecheck bypasses Signal 3
    });
    const v = await evaluatePreworkGate({ ...baseInput, skipTypecheck: true, deps });
    expect(v.shouldSpawnDev).toBe(false);
  });

  it('mentions cached state in the success reason', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init', files: ['src/dino.ts'] }],
      tscOk: true,
      tscCached: true,
    });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.reason).toContain('cached');
  });
});

describe('renderGateEvidence', () => {
  it('returns empty string for missing input', () => {
    expect(renderGateEvidence(null, 'story-1')).toBe('');
  });

  it('renders all sections when populated', () => {
    const v = {
      shouldSpawnDev: false,
      reason: 'gate-passed',
      evidence: {
        recentCommits: [{ sha: 'abc1234', subject: 'init dino', files: ['src/dino.ts'] }],
        candidateExports: ['applyGravity', 'startJump'],
        exportsPresent: ['applyGravity', 'startJump'],
        exportsMissing: [],
        typecheck: { ok: true, cached: true, output: '' },
      },
    };
    const md = renderGateEvidence(v, 'story-abc');
    expect(md).toContain('story-abc');
    expect(md).toContain('skip-dev');
    expect(md).toContain('Recent commits in scope');
    expect(md).toContain('abc1234 — init dino');
    expect(md).toContain('AC-derived candidate exports');
    expect(md).toContain('applyGravity');
    expect(md).toContain('Typecheck');
    expect(md).toContain('OK: true (cached)');
  });

  it('includes typecheck output when typecheck failed', () => {
    const v = {
      shouldSpawnDev: true,
      reason: 'gate-failed: typecheck not clean',
      evidence: {
        recentCommits: [],
        candidateExports: [],
        exportsPresent: [],
        exportsMissing: [],
        typecheck: { ok: false, cached: false, output: 'TS2322: bad types' },
      },
    };
    const md = renderGateEvidence(v, 'story-abc');
    expect(md).toContain('OK: false');
    expect(md).toContain('TS2322');
  });
});
