/**
 * Hermetic tests for the QA-Review W2 Lane-2 (VQA judge) module.
 *
 * Covers: two-frame prompt shape (source diff + exactly two frame refs),
 * VERDICT/OBSERVATION parsing → LaneVerdict mapping (pass/fail/uncertain),
 * FAIL-OPEN degradation on judge throw/unavailable/unparseable output,
 * missing-frame precondition, and PARITY of the duplicated
 * parseJudgeOutput/judgeConsensus against the wave-vqa-runner.mjs originals.
 */

import { describe, expect, it } from 'vitest';
import {
  judgeVqaStep,
  buildTwoFrameJudgePrompt,
  parseJudgeOutput,
  judgeConsensus,
} from '../p3-vqa-judge.mjs';
import {
  parseJudgeOutput as originalParseJudgeOutput,
  judgeConsensus as originalJudgeConsensus,
} from '../wave-vqa-runner.mjs';

const spec = {
  id: 'AC-7',
  acText: 'the score counter increases after pressing ArrowUp',
  thenObservable: 'the score display transitions from 0 to a higher value',
};
const sourceDiff = '--- a/src/game.ts\n+++ b/src/game.ts\n+score += 1;\n';

// ── prompt shape ─────────────────────────────────────────────────────────

describe('buildTwoFrameJudgePrompt', () => {
  it('includes the source diff text', () => {
    const prompt = buildTwoFrameJudgePrompt({
      spec,
      sourceDiff,
      beforeFrame: '/tmp/before.png',
      afterFrame: '/tmp/after.png',
    });
    expect(prompt).toContain('score += 1;');
  });

  it('references exactly two frame paths (before once, after once)', () => {
    const prompt = buildTwoFrameJudgePrompt({
      spec,
      sourceDiff,
      beforeFrame: '/tmp/before.png',
      afterFrame: '/tmp/after.png',
    });
    const beforeCount = prompt.split('/tmp/before.png').length - 1;
    const afterCount = prompt.split('/tmp/after.png').length - 1;
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
  });

  it('mirrors the beforeAfter directive language (compare / expected CHANGE / PASS-only-if-differs)', () => {
    const prompt = buildTwoFrameJudgePrompt({
      spec,
      sourceDiff,
      beforeFrame: '/tmp/before.png',
      afterFrame: '/tmp/after.png',
    });
    expect(prompt).toMatch(/BEFORE the action/);
    expect(prompt).toMatch(/AFTER/);
    expect(prompt).toMatch(/expected CHANGE occurred/);
    expect(prompt).toMatch(/PASS only if frame 2 differs from frame 1/);
  });

  it('renders a placeholder fence rather than omitting the diff section when absent', () => {
    const prompt = buildTwoFrameJudgePrompt({
      spec,
      sourceDiff: '',
      beforeFrame: '/tmp/before.png',
      afterFrame: '/tmp/after.png',
    });
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('(no source diff provided)');
  });
});

// ── judgeVqaStep — happy paths ───────────────────────────────────────────

describe('judgeVqaStep', () => {
  const frames = { beforeFrame: '/tmp/before.png', afterFrame: '/tmp/after.png' };

  it('maps a confident PASS to verdict=pass', async () => {
    const spawnJudge = async () => ({
      ok: true,
      output: 'VERDICT: PASS [conf=high]\nOBSERVATION: score moved from 0 to 1',
    });
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('pass');
    expect(r.rationale).toContain('score moved');
  });

  it('maps a confident FAIL to verdict=fail (gates)', async () => {
    const spawnJudge = async () => ({
      ok: true,
      output: 'VERDICT: FAIL [conf=high]\nOBSERVATION: frames look identical, no score change',
    });
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('fail');
    expect(r.rationale).toContain('identical');
  });

  it('a LOW-confidence FAIL is non-blocking (uncertain), never fake-passes', async () => {
    const spawnJudge = async () => ({
      ok: true,
      output: 'VERDICT: FAIL [conf=low]\nOBSERVATION: hard to tell, maybe no change',
    });
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('uncertain');
  });

  it('UNCERTAIN judge output never blocks', async () => {
    const spawnJudge = async () => ({
      ok: true,
      output: 'VERDICT: UNCERTAIN\nOBSERVATION: image too dark to read',
    });
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('uncertain');
  });

  it('UNREACHABLE judge output never blocks (maps to uncertain, not pass)', async () => {
    const spawnJudge = async () => ({
      ok: true,
      output: 'VERDICT: UNREACHABLE\nOBSERVATION: wrong surface captured',
    });
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('uncertain');
  });

  it('passes both frame paths + the diff through to spawnJudge (never a single-frame call)', async () => {
    let seenPrompt = '';
    const spawnJudge = async ({ prompt }) => {
      seenPrompt = prompt;
      return { ok: true, output: 'VERDICT: PASS [conf=high]\nOBSERVATION: ok' };
    };
    await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge, cwd: '/tmp' });
    expect(seenPrompt).toContain('/tmp/before.png');
    expect(seenPrompt).toContain('/tmp/after.png');
    expect(seenPrompt).toContain('score += 1;');
  });

  // ── FAIL-OPEN / honesty contract ────────────────────────────────────────

  it('degrades to uncertain (non-blocking) when spawnJudge throws — never fake-passes', async () => {
    const spawnJudge = async () => {
      throw new Error('judge CLI crashed');
    };
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('uncertain');
    expect(r.rationale).toContain('judge CLI crashed');
  });

  it('degrades to uncertain when spawnJudge reports ok:false', async () => {
    const spawnJudge = async () => ({ ok: false, reason: 'timeout' });
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('uncertain');
    expect(r.rationale).toContain('timeout');
  });

  it('degrades to uncertain when the judge output is unparseable', async () => {
    const spawnJudge = async () => ({ ok: true, output: 'not a verdict at all' });
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge });
    expect(r.verdict).toBe('uncertain');
  });

  it('degrades to uncertain when either frame is missing (never a single-frame judgment)', async () => {
    const spawnJudge = async () => ({
      ok: true,
      output: 'VERDICT: PASS [conf=high]\nOBSERVATION: should never be reached',
    });
    const r1 = await judgeVqaStep({ spec, sourceDiff, beforeFrame: '', afterFrame: '/tmp/after.png', spawnJudge });
    const r2 = await judgeVqaStep({ spec, sourceDiff, beforeFrame: '/tmp/before.png', afterFrame: '', spawnJudge });
    expect(r1.verdict).toBe('uncertain');
    expect(r2.verdict).toBe('uncertain');
  });

  it('degrades to uncertain when no spawnJudge is injected', async () => {
    const r = await judgeVqaStep({ spec, sourceDiff, ...frames, spawnJudge: undefined });
    expect(r.verdict).toBe('uncertain');
  });
});

// ── parity with wave-vqa-runner.mjs (the duplicated logic must match) ────

describe('parity: duplicated parseJudgeOutput/judgeConsensus vs wave-vqa-runner.mjs', () => {
  const outputs = [
    'VERDICT: PASS [conf=high]\nOBSERVATION: looks good',
    'VERDICT: FAIL [conf=low]\nOBSERVATION: maybe wrong',
    'VERDICT: UNREACHABLE\nOBSERVATION: n/a',
    'VERDICT: UNCERTAIN\nOBSERVATION: unclear',
    'garbage, no verdict line',
    '',
  ];

  it('parseJudgeOutput is byte-identical to the original for the same inputs', () => {
    for (const output of outputs) {
      expect(parseJudgeOutput(output)).toEqual(originalParseJudgeOutput(output));
    }
  });

  it('judgeConsensus is byte-identical to the original for the same vote sets', () => {
    const voteSets = [
      [],
      [{ lens: 'a', verdict: 'PASS', confidence: 'high', observation: 'x' }],
      [{ lens: 'a', verdict: 'FAIL', confidence: 'high', observation: 'x' }],
      [{ lens: 'a', verdict: 'FAIL', confidence: 'low', observation: 'x' }],
      [
        { lens: 'a', verdict: 'FAIL', confidence: 'high', observation: 'x' },
        { lens: 'b', verdict: 'PASS', confidence: 'high', observation: 'y' },
      ],
      [
        { lens: 'a', verdict: 'UNREACHABLE', confidence: 'low', observation: 'x' },
        { lens: 'b', verdict: 'UNREACHABLE', confidence: 'low', observation: 'y' },
      ],
    ];
    for (const votes of voteSets) {
      expect(judgeConsensus(votes)).toEqual(originalJudgeConsensus(votes));
    }
  });
});
