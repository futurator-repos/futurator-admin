import { describe, it, expect } from 'vitest';
import {
  parseReviewCriteria as parseTs,
  aggregateReviewVerdict as aggregateTs,
  formatFailedReasonsForRetry,
  formatHumanQuestionsForAttention,
} from '../review-criteria-parser';
// Import the daemon-side .mjs counterpart so a single fixture set proves
// both implementations agree. If they drift, this test fails first.
import {
  parseReviewCriteria as parseMjs,
  aggregateReviewVerdict as aggregateMjs,
} from '../../../../daemon/pipelines/lib/review-criteria-parser.mjs';

const FIXTURES = [
  {
    name: 'all pass',
    block: `---REVIEW_CRITERIA---
AC-1: pass
AC-2: pass
---END_REVIEW_CRITERIA---`,
  },
  {
    name: 'mixed pass / fail with em-dash reasons',
    block: `---REVIEW_CRITERIA---
AC-1: pass
AC-2: fail — Off-by-one on the score increment
---END_REVIEW_CRITERIA---`,
  },
  {
    name: 'needs-human takes precedence over fail',
    block: `---REVIEW_CRITERIA---
AC-1: fail — Has a bug
AC-2: needs-human — Is this aesthetic acceptable?
---END_REVIEW_CRITERIA---`,
  },
  {
    name: 'ASCII " - " separator',
    block: `---REVIEW_CRITERIA---
AC-1: fail - Missing handler
---END_REVIEW_CRITERIA---`,
  },
  {
    name: 'unknown verdict → malformed',
    block: `---REVIEW_CRITERIA---
AC-1: probably
AC-2: pass
---END_REVIEW_CRITERIA---`,
  },
  {
    name: 'envelope-less input still parses',
    block: 'AC-1: pass\nAC-2: pass\n',
  },
  {
    name: 'fail without reason → malformed entry',
    block: `---REVIEW_CRITERIA---
AC-1: fail
---END_REVIEW_CRITERIA---`,
  },
];

describe('TypeScript review-criteria-parser', () => {
  it('returns empty array on null/undefined/empty input', () => {
    expect(parseTs('')).toEqual([]);
    expect(parseTs(null)).toEqual([]);
    expect(parseTs(undefined)).toEqual([]);
  });

  it('aggregates an all-pass block to verdict=pass', () => {
    const v = aggregateTs(parseTs(FIXTURES[0].block));
    expect(v.verdict).toBe('pass');
    expect(v.counts.pass).toBe(2);
  });

  it('aggregates needs-human ahead of fail (operator decides first)', () => {
    const v = aggregateTs(parseTs(FIXTURES[2].block));
    expect(v.verdict).toBe('needs-human');
    expect(v.reasons.humans).toEqual([{ acId: 'AC-2', question: 'Is this aesthetic acceptable?' }]);
  });

  it('aggregates malformed line to verdict=malformed (force re-emit)', () => {
    const v = aggregateTs(parseTs(FIXTURES[4].block));
    expect(v.verdict).toBe('malformed');
    expect(v.parseErrors).toHaveLength(1);
  });

  it('formatFailedReasonsForRetry produces compact bullets', () => {
    const v = aggregateTs(parseTs(FIXTURES[1].block));
    expect(formatFailedReasonsForRetry(v.reasons)).toBe(
      '- AC-2: Off-by-one on the score increment',
    );
  });

  it('formatHumanQuestionsForAttention produces compact bullets', () => {
    const v = aggregateTs(parseTs(FIXTURES[2].block));
    expect(formatHumanQuestionsForAttention(v.reasons)).toBe(
      '- AC-2: Is this aesthetic acceptable?',
    );
  });
});

describe('cross-impl parity (TS vs .mjs)', () => {
  for (const fx of FIXTURES) {
    it(`agrees on parse output for "${fx.name}"`, () => {
      const ts = parseTs(fx.block);
      const mjs = parseMjs(fx.block);
      // Trim non-functional differences: TS objects vs mjs objects have the
      // same shape but compare via JSON to ignore object identity.
      expect(JSON.parse(JSON.stringify(ts))).toEqual(JSON.parse(JSON.stringify(mjs)));
    });

    it(`agrees on aggregate verdict for "${fx.name}"`, () => {
      const tsAgg = aggregateTs(parseTs(fx.block));
      const mjsAgg = aggregateMjs(parseMjs(fx.block));
      expect(tsAgg.verdict).toBe(mjsAgg.verdict);
      expect(tsAgg.counts).toEqual(mjsAgg.counts);
      expect(JSON.parse(JSON.stringify(tsAgg.reasons))).toEqual(
        JSON.parse(JSON.stringify(mjsAgg.reasons)),
      );
    });
  }
});
