import { describe, it, expect } from 'vitest';
import { computeQualityInput } from '../quality-input.mjs';
import { handleStoryCompletion } from '../story-completion-handler.mjs';

const ac = (o) => ({ id: o.id, riskTag: o.riskTag, verify: o.verify, testBinding: o.tb });
const passing = { status: 'passing', testKind: 'unit' };
const failing = { status: 'failing', testKind: 'unit' };

describe('computeQualityInput — P-band math', () => {
  it('all passing → 100 across bands', () => {
    const r = computeQualityInput([
      ac({ id: 'a', riskTag: 'P0', tb: passing }),
      ac({ id: 'b', riskTag: 'P1', tb: passing }),
    ]);
    expect(r.coverage).toEqual({ p0: 100, p1: 100, overall: 100 });
    expect(r.pass).toEqual({ p0: 100, p1: 100, overall: 100 });
  });

  it('vacuous band (no P0 ACs) is 100, never 0 — no spurious FAIL', () => {
    const r = computeQualityInput([ac({ id: 'a', riskTag: 'P2', tb: passing })]);
    expect(r.coverage.p0).toBe(100);
    expect(r.pass.p0).toBe(100);
    expect(r.pass.overall).toBe(100);
  });

  it('missing riskTag entirely → bands vacuous, overall real', () => {
    const r = computeQualityInput([
      ac({ id: 'a', tb: passing }),
      ac({ id: 'b', tb: failing }),
    ]);
    expect(r.coverage.p0).toBe(100); // vacuous
    expect(r.pass.overall).toBe(50); // 1 of 2 passing
  });

  it('excludes manual ACs from the math', () => {
    const r = computeQualityInput([
      ac({ id: 'a', riskTag: 'P0', tb: passing }),
      ac({ id: 'm', verify: 'manual', tb: { status: 'unbound', testKind: 'manual' } }),
    ]);
    expect(r.pass.overall).toBe(100);
  });

  it('a failing P0 drives pass.p0 down', () => {
    const r = computeQualityInput([ac({ id: 'a', riskTag: 'P0', tb: failing })]);
    expect(r.pass.p0).toBe(0);
  });
});

describe('handleStoryCompletion — quality verdict is additive + dark', () => {
  const passingUnit = { unit: async () => ({ passed: true }) };
  const story = { storyId: 'S1', acceptanceCriteria: [{ id: 'AC-1', riskTag: 'P0', testBinding: { status: 'bound', testKind: 'unit', testRef: 't' } }] };
  const binding = '<BINDING>{"AC-1":{"testRef":"t","testKind":"unit"}}</BINDING>';

  it('qualityMode off (default) attaches NO qualityVerdict', async () => {
    const r = await handleStoryCompletion({ storyNode: story, devOutput: binding, headSha: 'sha', executors: passingUnit });
    expect(r.qualityVerdict).toBeUndefined();
    expect(r.newState).toBe('done');
  });

  it('qualityMode shadow attaches a verdict but newState is unchanged', async () => {
    const r = await handleStoryCompletion({ storyNode: story, devOutput: binding, headSha: 'sha', executors: passingUnit, qualityMode: 'shadow' });
    expect(r.qualityVerdict?.verdict).toBe('PASS');
    expect(r.newState).toBe('done'); // authoritative gate unchanged
  });
});
