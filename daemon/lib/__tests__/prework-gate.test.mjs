import { describe, it, expect } from 'vitest';
import { evaluatePreworkGate, renderGateEvidence } from '../prework-gate.mjs';

// Build injectable fakes for the two signal helpers so the orchestrator can be
// tested without touching the real fs / git / shell. D2-1 (2026-06-22) deleted
// the former AC-prose export-name heuristic; the gate is now Signal 1 (recent
// commits in scope) + Signal 2 (whole-project typecheck clean).
function makeDeps({
  commits = [],
  tscOk = true,
  tscOutput = '',
  tscCached = false,
} = {}) {
  return {
    collectRecentTouchPointWork: () => ({ skipped: false, commits }),
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

  it('fails when no recent commits in scope (Signal 1)', async () => {
    const deps = makeDeps({ commits: [] });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(true);
    expect(v.reason).toContain('no recent commits');
    expect(v.evidence.recentCommits).toEqual([]);
  });

  it('fails when typecheck fails (Signal 2)', async () => {
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

  it('passes when both signals green', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init dino', files: ['src/dino.ts'] }],
      tscOk: true,
    });
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(false);
    expect(v.reason).toContain('gate-passed');
    expect(v.evidence.recentCommits.length).toBe(1);
    expect(v.evidence.typecheck.ok).toBe(true);
  });

  it('does not require AC text (heuristic removed in D2-1)', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init dino', files: ['src/dino.ts'] }],
      tscOk: true,
    });
    // No acText key at all — gate must still evaluate on its two real signals.
    const v = await evaluatePreworkGate({ ...baseInput, deps });
    expect(v.shouldSpawnDev).toBe(false);
  });

  it('honors skipTypecheck flag (e.g., for tests)', async () => {
    const deps = makeDeps({
      commits: [{ sha: 'abc1234', subject: 'init', files: ['src/dino.ts'] }],
      tscOk: false, // even with tsc=fail, skipTypecheck bypasses Signal 2
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
        typecheck: { ok: true, cached: true, output: '' },
      },
    };
    const md = renderGateEvidence(v, 'story-abc');
    expect(md).toContain('story-abc');
    expect(md).toContain('skip-dev');
    expect(md).toContain('Recent commits in scope');
    expect(md).toContain('abc1234 — init dino');
    expect(md).toContain('Typecheck');
    expect(md).toContain('OK: true (cached)');
  });

  it('includes typecheck output when typecheck failed', () => {
    const v = {
      shouldSpawnDev: true,
      reason: 'gate-failed: typecheck not clean',
      evidence: {
        recentCommits: [],
        typecheck: { ok: false, cached: false, output: 'TS2322: bad types' },
      },
    };
    const md = renderGateEvidence(v, 'story-abc');
    expect(md).toContain('OK: false');
    expect(md).toContain('TS2322');
  });
});
