import { describe, it, expect } from 'vitest';
import {
  parseReviewCriteria,
  aggregateReviewVerdict,
  formatFailedReasonsForRetry,
  formatHumanQuestionsForAttention,
  REVIEW_CRITERIA_EXTRACTOR,
  REVIEW_VERDICTS,
} from '../review-criteria-parser.mjs';

describe('parseReviewCriteria', () => {
  it('parses a clean all-pass block', () => {
    const block = `---REVIEW_CRITERIA---
AC-1: pass
AC-2: pass
AC-3: pass
---END_REVIEW_CRITERIA---`;
    const entries = parseReviewCriteria(block);
    expect(entries).toEqual([
      { acId: 'AC-1', verdict: 'pass', reason: '' },
      { acId: 'AC-2', verdict: 'pass', reason: '' },
      { acId: 'AC-3', verdict: 'pass', reason: '' },
    ]);
  });

  it('parses mixed pass/fail/needs-human with em-dash reasons', () => {
    const block = `---REVIEW_CRITERIA---
AC-1: pass
AC-2: fail — Score increment is off-by-one when the ball clears row N.
AC-3: needs-human — Is the orange-on-charcoal palette acceptable for prototype rigor?
---END_REVIEW_CRITERIA---`;
    const entries = parseReviewCriteria(block);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toEqual({
      acId: 'AC-2',
      verdict: 'fail',
      reason: 'Score increment is off-by-one when the ball clears row N.',
    });
    expect(entries[2].verdict).toBe('needs-human');
    expect(entries[2].reason).toContain('palette');
  });

  it('tolerates ASCII " - " separator (Haiku occasionally substitutes)', () => {
    const block = `---REVIEW_CRITERIA---
AC-1: fail - Missing keypress handler
---END_REVIEW_CRITERIA---`;
    const entries = parseReviewCriteria(block);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ acId: 'AC-1', verdict: 'fail', reason: 'Missing keypress handler' });
  });

  it('tolerates the input being passed without envelope markers', () => {
    const naked = 'AC-1: pass\nAC-2: pass\n';
    expect(parseReviewCriteria(naked)).toHaveLength(2);
  });

  it('flags lines without a `:` separator as parse errors', () => {
    const block = `---REVIEW_CRITERIA---
AC-1 pass
AC-2: pass
---END_REVIEW_CRITERIA---`;
    const entries = parseReviewCriteria(block);
    expect(entries[0].error).toMatch(/no `:` separator/);
    expect(entries[1].verdict).toBe('pass');
  });

  it('flags unknown verdict tokens', () => {
    const block = `---REVIEW_CRITERIA---
AC-1: probably
AC-2: pass
---END_REVIEW_CRITERIA---`;
    const entries = parseReviewCriteria(block);
    expect(entries[0].error).toMatch(/unknown verdict "probably"/);
    expect(entries[1].verdict).toBe('pass');
  });

  it('requires a reason for fail / needs-human verdicts', () => {
    const block = `---REVIEW_CRITERIA---
AC-1: fail
AC-2: needs-human
---END_REVIEW_CRITERIA---`;
    const entries = parseReviewCriteria(block);
    expect(entries[0].error).toMatch(/fail verdict requires a reason/);
    expect(entries[1].error).toMatch(/needs-human verdict requires a reason/);
  });

  it('returns [] on empty / non-string input', () => {
    expect(parseReviewCriteria('')).toEqual([]);
    expect(parseReviewCriteria(null)).toEqual([]);
    expect(parseReviewCriteria(undefined)).toEqual([]);
  });

  it('exposes the right extractor shape for the daemon to merge', () => {
    expect(REVIEW_CRITERIA_EXTRACTOR.type).toBe('between');
    expect(REVIEW_CRITERIA_EXTRACTOR.startDelimiter).toBe('---REVIEW_CRITERIA---');
    expect(REVIEW_CRITERIA_EXTRACTOR.endDelimiter).toBe('---END_REVIEW_CRITERIA---');
  });

  it('exposes the canonical verdict list', () => {
    expect(REVIEW_VERDICTS).toEqual(['pass', 'fail', 'needs-human']);
  });
});

describe('aggregateReviewVerdict', () => {
  it('all pass → pass', () => {
    const entries = parseReviewCriteria(`---REVIEW_CRITERIA---
AC-1: pass
AC-2: pass
---END_REVIEW_CRITERIA---`);
    const v = aggregateReviewVerdict(entries);
    expect(v.verdict).toBe('pass');
    expect(v.counts).toEqual({ pass: 2, fail: 0, needsHuman: 0, malformed: 0 });
    expect(v.reasons.failed).toEqual([]);
  });

  it('any fail → fail; failed reasons are collected for the retry prompt', () => {
    const entries = parseReviewCriteria(`---REVIEW_CRITERIA---
AC-1: pass
AC-2: fail — Off-by-one on score
AC-3: pass
AC-4: fail — Missing space-key handler
---END_REVIEW_CRITERIA---`);
    const v = aggregateReviewVerdict(entries);
    expect(v.verdict).toBe('fail');
    expect(v.reasons.failed).toEqual([
      { acId: 'AC-2', reason: 'Off-by-one on score' },
      { acId: 'AC-4', reason: 'Missing space-key handler' },
    ]);
  });

  it('any needs-human takes precedence over fail (operator decides first)', () => {
    const entries = parseReviewCriteria(`---REVIEW_CRITERIA---
AC-1: fail — Has a bug
AC-2: needs-human — Is this aesthetic OK for prototype?
---END_REVIEW_CRITERIA---`);
    const v = aggregateReviewVerdict(entries);
    expect(v.verdict).toBe('needs-human');
    expect(v.reasons.humans).toEqual([
      { acId: 'AC-2', question: 'Is this aesthetic OK for prototype?' },
    ]);
    expect(v.reasons.failed).toEqual([{ acId: 'AC-1', reason: 'Has a bug' }]);
  });

  it('any malformed line forces malformed verdict (re-emit)', () => {
    const entries = parseReviewCriteria(`---REVIEW_CRITERIA---
AC-1: pass
AC-2: probably
---END_REVIEW_CRITERIA---`);
    const v = aggregateReviewVerdict(entries);
    expect(v.verdict).toBe('malformed');
    expect(v.parseErrors).toHaveLength(1);
    expect(v.parseErrors[0].error).toMatch(/unknown verdict/);
  });

  it('empty parsed array → malformed', () => {
    const v = aggregateReviewVerdict([]);
    expect(v.verdict).toBe('malformed');
  });
});

describe('formatters', () => {
  it('formatFailedReasonsForRetry produces a compact bullet list', () => {
    const out = formatFailedReasonsForRetry({
      failed: [
        { acId: 'AC-1', reason: 'one' },
        { acId: 'AC-3', reason: 'three' },
      ],
    });
    expect(out).toBe('- AC-1: one\n- AC-3: three');
  });

  it('formatFailedReasonsForRetry on empty input returns a placeholder', () => {
    expect(formatFailedReasonsForRetry({ failed: [] })).toMatch(/no failed criteria/);
  });

  it('formatHumanQuestionsForAttention produces a compact bullet list', () => {
    const out = formatHumanQuestionsForAttention({
      humans: [
        { acId: 'AC-2', question: 'Is the palette OK?' },
        { acId: 'AC-5', question: 'Is the difficulty fair?' },
      ],
    });
    expect(out).toBe('- AC-2: Is the palette OK?\n- AC-5: Is the difficulty fair?');
  });
});
