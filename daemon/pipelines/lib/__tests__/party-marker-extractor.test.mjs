import { describe, it, expect } from 'vitest';

import { extractMarkers } from '../party-marker-extractor.mjs';

/**
 * Story 20.1 — adversarial test suite for the party-marker extractor.
 * Each edge case from AC 5 + happy path from AC 7.
 */

describe('extractMarkers — happy path (AC 7)', () => {
  it('captures CHECKPOINT_SUMMARY title + multi-line body, leaves rest as displayText', () => {
    const input = [
      'Some prose before the marker.',
      '[CHECKPOINT_SUMMARY]: agreed on routing strategy',
      'BMad Master + PM aligned on hash-based routing.',
      'Trade-off accepted: SEO impact deferred to PR-43.',
      'No remaining open questions in this round.',
      '',
      'Closing thoughts the operator should read.',
    ].join('\n');

    const r = extractMarkers(input);

    expect(r.markers).toHaveLength(1);
    expect(r.markers[0].kind).toBe('CHECKPOINT_SUMMARY');
    expect(r.markers[0].title).toBe('agreed on routing strategy');
    expect(r.markers[0].body).toBe(
      [
        'BMad Master + PM aligned on hash-based routing.',
        'Trade-off accepted: SEO impact deferred to PR-43.',
        'No remaining open questions in this round.',
      ].join('\n'),
    );
    expect(r.markers[0].lineRange).toEqual([1, 4]);
    expect(r.displayText).toContain('Some prose before the marker.');
    expect(r.displayText).toContain('Closing thoughts the operator should read.');
    expect(r.displayText).not.toContain('[CHECKPOINT_SUMMARY]');
    expect(r.displayText).not.toContain('hash-based routing');
  });

  it('returns empty result for empty input', () => {
    expect(extractMarkers('')).toEqual({ displayText: '', markers: [] });
  });

  it('returns input verbatim and no markers when no markers present', () => {
    const text = 'just some prose\nwith multiple lines\nno markers here';
    expect(extractMarkers(text)).toEqual({ displayText: text, markers: [] });
  });
});

describe('extractMarkers — ASK_HUMAN (AC 4)', () => {
  it('captures a single-line question, no body', () => {
    const r = extractMarkers('[ASK_HUMAN]: should we use OAuth or magic-link?');
    expect(r.markers).toEqual([
      {
        kind: 'ASK_HUMAN',
        title: 'should we use OAuth or magic-link?',
        lineRange: [0, 0],
      },
    ]);
  });
});

describe('extractMarkers — mixed markers (AC 5: both extracted)', () => {
  it('extracts CHECKPOINT_SUMMARY and ASK_HUMAN from the same block', () => {
    const input = [
      '[CHECKPOINT_SUMMARY]: round complete',
      'Aligned on storage backend.',
      '',
      '[ASK_HUMAN]: should we prioritize SQLite or PG?',
      'Closing prose.',
    ].join('\n');
    const r = extractMarkers(input);

    expect(r.markers).toHaveLength(2);
    const cp = r.markers.find((m) => m.kind === 'CHECKPOINT_SUMMARY');
    const ask = r.markers.find((m) => m.kind === 'ASK_HUMAN');
    expect(cp?.title).toBe('round complete');
    expect(cp?.body).toBe('Aligned on storage backend.');
    expect(ask?.title).toBe('should we prioritize SQLite or PG?');
    expect(r.displayText).toBe('Closing prose.');
  });
});

describe('extractMarkers — adversarial edge cases (AC 5)', () => {
  it('IGNORES markers inside ``` fenced code blocks (documentation, not instruction)', () => {
    const input = [
      'Here is how the orchestrator emits a checkpoint:',
      '```',
      '[CHECKPOINT_SUMMARY]: example title',
      'Example body',
      '```',
      'End of explanation.',
    ].join('\n');
    const r = extractMarkers(input);

    expect(r.markers).toEqual([]);
    expect(r.displayText).toBe(input);
  });

  it('IGNORES markers inside ~~~ fenced code blocks too', () => {
    const input = ['~~~', '[ASK_HUMAN]: not a real question', '~~~'].join('\n');
    const r = extractMarkers(input);
    expect(r.markers).toEqual([]);
  });

  it('IGNORES markers with leading whitespace (must be column 0)', () => {
    const input = '  [CHECKPOINT_SUMMARY]: indented';
    const r = extractMarkers(input);
    expect(r.markers).toEqual([]);
    expect(r.displayText).toBe(input);
  });

  it('IGNORES markers missing the colon ([CHECKPOINT_SUMMARY] foo without colon)', () => {
    const input = '[CHECKPOINT_SUMMARY] foo bar';
    const r = extractMarkers(input);
    expect(r.markers).toEqual([]);
  });

  it('LAST-WINS for duplicate same-kind markers (per plan.md §3.4)', () => {
    const input = [
      '[CHECKPOINT_SUMMARY]: first attempt',
      'old body',
      '',
      '[CHECKPOINT_SUMMARY]: revised',
      'new body',
    ].join('\n');
    const r = extractMarkers(input);
    expect(r.markers).toHaveLength(1);
    expect(r.markers[0].title).toBe('revised');
    expect(r.markers[0].body).toBe('new body');
  });

  it('SANITIZES titles with zero-width / control chars (§12.1.3 fix)', () => {
    const input = '[CHECKPOINT_SUMMARY]: round\x00 with​ noise';
    const r = extractMarkers(input);
    expect(r.markers[0].title).toBe('round with noise');
  });

  it('CHECKPOINT_SUMMARY body separated from title by single newline is captured', () => {
    const input = ['[CHECKPOINT_SUMMARY]: title', 'body line one'].join('\n');
    const r = extractMarkers(input);
    expect(r.markers[0].body).toBe('body line one');
    expect(r.markers[0].lineRange).toEqual([0, 1]);
  });

  it('CHECKPOINT_SUMMARY body terminates at first blank line', () => {
    const input = [
      '[CHECKPOINT_SUMMARY]: title',
      'line one',
      'line two',
      '',
      'line after-blank (not body)',
    ].join('\n');
    const r = extractMarkers(input);
    expect(r.markers[0].body).toBe('line one\nline two');
    expect(r.markers[0].lineRange).toEqual([0, 2]);
    expect(r.displayText).toContain('line after-blank');
  });

  it('CHECKPOINT_SUMMARY body terminates at another marker', () => {
    const input = [
      '[CHECKPOINT_SUMMARY]: title',
      'body one',
      '[ASK_HUMAN]: side question',
      'prose after',
    ].join('\n');
    const r = extractMarkers(input);
    const cp = r.markers.find((m) => m.kind === 'CHECKPOINT_SUMMARY');
    expect(cp?.body).toBe('body one');
    expect(r.markers).toHaveLength(2);
  });

  it('CHECKPOINT_SUMMARY body terminates at a code-fence opening', () => {
    const input = [
      '[CHECKPOINT_SUMMARY]: title',
      'body line one',
      '```',
      'some code',
      '```',
    ].join('\n');
    const r = extractMarkers(input);
    expect(r.markers[0].body).toBe('body line one');
    expect(r.displayText).toContain('```');
    expect(r.displayText).toContain('some code');
  });

  it('handles ASK_HUMAN with empty question (title is empty string, not undefined)', () => {
    const input = '[ASK_HUMAN]:';
    const r = extractMarkers(input);
    expect(r.markers).toEqual([
      {
        kind: 'ASK_HUMAN',
        title: '',
        lineRange: [0, 0],
      },
    ]);
  });

  it('CHECKPOINT_SUMMARY with no body (next line blank) has body undefined', () => {
    const input = ['[CHECKPOINT_SUMMARY]: title', '', 'prose'].join('\n');
    const r = extractMarkers(input);
    expect(r.markers[0].body).toBeUndefined();
    expect(r.markers[0].lineRange).toEqual([0, 0]);
  });

  it('rejects non-string input gracefully', () => {
    // @ts-expect-error — intentional invalid input
    expect(extractMarkers(null)).toEqual({ displayText: '', markers: [] });
    // @ts-expect-error — intentional invalid input
    expect(extractMarkers(undefined)).toEqual({ displayText: '', markers: [] });
    // @ts-expect-error — intentional invalid input
    expect(extractMarkers(123)).toEqual({ displayText: '', markers: [] });
  });
});

describe('extractMarkers — displayText sanity', () => {
  it('collapses 3+ consecutive blank lines down to 2 after stripping markers', () => {
    const input = [
      'before',
      '[CHECKPOINT_SUMMARY]: title',
      'body',
      '',
      '',
      'after',
    ].join('\n');
    const r = extractMarkers(input);
    expect(r.displayText).toBe('before\n\nafter');
  });
});
