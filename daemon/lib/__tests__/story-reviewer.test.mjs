import { describe, it, expect } from 'vitest';
import { shouldReview, buildReviewerPrompt, parseReviewerVerdict } from '../story-reviewer.mjs';
import { handleStoryCompletion } from '../story-completion-handler.mjs';

describe('shouldReview', () => {
  it('triggers on a P0/P1 AC', () => {
    expect(shouldReview([{ id: 'a', riskTag: 'P0' }])).toBe(true);
    expect(shouldReview([{ id: 'a', riskTag: 'P2' }])).toBe(false);
  });
  it('triggers on a CONCERNS quality verdict', () => {
    expect(shouldReview([{ id: 'a', riskTag: 'P3' }], { verdict: 'CONCERNS' })).toBe(true);
    expect(shouldReview([{ id: 'a', riskTag: 'P3' }], { verdict: 'PASS' })).toBe(false);
  });
});

describe('buildReviewerPrompt / parseReviewerVerdict', () => {
  it('prompt is fresh-context + advisory-focused', () => {
    const p = buildReviewerPrompt({ storyTitle: 'X', acceptanceCriteria: [{ id: 'AC-1', text: 't' }], diff: 'd' });
    expect(p).toMatch(/INDEPENDENT reviewer/);
    expect(p).toMatch(/NOT seen the implementer/);
    expect(p).toMatch(/<REVIEW>/);
  });
  it('parses per-AC verdicts + needs-human, tolerant of junk', () => {
    const r = parseReviewerVerdict('blah <REVIEW>{"AC-1":"pass","AC-2":"fail"}</REVIEW> <NEEDS_HUMAN>["AC-3"]</NEEDS_HUMAN>');
    expect(r.verdicts).toEqual({ 'AC-1': 'pass', 'AC-2': 'fail' });
    expect(r.needsHuman).toEqual(['AC-3']);
  });
  it('malformed → empty (fail-open to no-block)', () => {
    expect(parseReviewerVerdict('no tags').verdicts).toEqual({});
    expect(parseReviewerVerdict('<REVIEW>not json</REVIEW>').verdicts).toEqual({});
  });
});

describe('handleStoryCompletion — reviewer gating', () => {
  // An advisory-security AC that the reviewer FAILS would block — but only when fed.
  const story = {
    storyId: 'S1',
    acceptanceCriteria: [
      { id: 'AC-1', riskTag: 'P0', acClass: 'advisory-security', testBinding: { status: 'bound', testKind: 'unit', testRef: 't' } },
    ],
  };
  const binding = '<BINDING>{"AC-1":{"testRef":"t","testKind":"unit"}}</BINDING>';
  const passingUnit = { unit: async () => ({ passed: true }) };
  const failReviewer = async () => ({ verdicts: { 'AC-1': 'fail' }, needsHuman: [] });

  it('shadow mode does NOT feed the reviewer verdict — completion byte-identical', async () => {
    const r = await handleStoryCompletion({ storyNode: story, devOutput: binding, headSha: 'sha', executors: passingUnit, qualityMode: 'shadow', spawnReviewer: failReviewer });
    expect(r.newState).toBe('done'); // advisory-security fail NOT fed → still done
    expect(r.qualityVerdict).toBeTruthy();
  });

  it('on mode feeds the reviewer — an advisory-security fail blocks', async () => {
    const r = await handleStoryCompletion({ storyNode: story, devOutput: binding, headSha: 'sha', executors: passingUnit, qualityMode: 'on', spawnReviewer: failReviewer });
    expect(r.verdict.status).toBe('blocked'); // advisory-security reviewer fail blocks
    expect(r.newState).toBe('failed');
  });

  it('on mode with no spawnReviewer → graceful no-op (done)', async () => {
    const r = await handleStoryCompletion({ storyNode: story, devOutput: binding, headSha: 'sha', executors: passingUnit, qualityMode: 'on' });
    expect(r.newState).toBe('done');
  });
});
