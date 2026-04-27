import { describe, it, expect } from 'vitest';
import {
  EXIT_SIGNALS_PROMPT_SUFFIX,
  UNIVERSAL_EXTRACTORS,
  UNIVERSAL_EXTRACTOR_NAMES,
  mergeUniversalExtractors,
  parseEscalationPayload,
  parseHumanQuestion,
  detectEscalation,
} from '../exit-signals.mjs';

describe('EXIT_SIGNALS_PROMPT_SUFFIX', () => {
  it('mentions all three exit signals', () => {
    expect(EXIT_SIGNALS_PROMPT_SUFFIX).toContain('---DONE---');
    expect(EXIT_SIGNALS_PROMPT_SUFFIX).toContain('---ESCALATE---');
    expect(EXIT_SIGNALS_PROMPT_SUFFIX).toContain('---NEED-HUMAN---');
  });

  it('lists the four recommended actions', () => {
    expect(EXIT_SIGNALS_PROMPT_SUFFIX).toContain('retry-with-hint');
    expect(EXIT_SIGNALS_PROMPT_SUFFIX).toContain('skip-step');
    expect(EXIT_SIGNALS_PROMPT_SUFFIX).toContain('ask-human');
    expect(EXIT_SIGNALS_PROMPT_SUFFIX).toContain('abort-job');
  });

  it('stays under a tight token-cost ceiling (sanity bound)', () => {
    // Every spawn pays this cost. Keep an upper bound so a regression that
    // bloats the prompt fails CI.
    expect(EXIT_SIGNALS_PROMPT_SUFFIX.length).toBeLessThan(800);
  });
});

describe('mergeUniversalExtractors', () => {
  it('returns the three universal extractors when step has none', () => {
    const merged = mergeUniversalExtractors(undefined);
    expect(Object.keys(merged).sort()).toEqual([...UNIVERSAL_EXTRACTOR_NAMES].sort());
  });

  it('preserves per-step extractors alongside the universal set', () => {
    const stepExtractors = {
      QA_REPORT: { type: 'between', startDelimiter: '---QA---', endDelimiter: '---END---' },
      VERDICT: { type: 'regex', pattern: 'VERDICT:\\s*(PASS|FAIL)' },
    };
    const merged = mergeUniversalExtractors(stepExtractors);
    expect(merged.QA_REPORT).toBe(stepExtractors.QA_REPORT);
    expect(merged.VERDICT).toBe(stepExtractors.VERDICT);
    for (const name of UNIVERSAL_EXTRACTOR_NAMES) {
      expect(merged[name]).toEqual(UNIVERSAL_EXTRACTORS[name]);
    }
  });

  it('overrides any per-step attempt to redefine reserved universal names', () => {
    const merged = mergeUniversalExtractors({
      EXIT_DONE: { type: 'regex', pattern: 'CUSTOM' },
    });
    // Universal definition wins; protocol stays stable across pipelines.
    expect(merged.EXIT_DONE).toEqual(UNIVERSAL_EXTRACTORS.EXIT_DONE);
  });

  it('does not mutate the input', () => {
    const stepExtractors = { FOO: { type: 'regex', pattern: 'foo' } };
    const merged = mergeUniversalExtractors(stepExtractors);
    expect(Object.keys(stepExtractors)).toEqual(['FOO']);
    expect(merged).not.toBe(stepExtractors);
  });
});

describe('parseEscalationPayload — well-formed', () => {
  const wellFormed = `
some preamble prose from the agent

---ESCALATE---
WHAT_FAILED: Couldn't locate the playwright browser binary
WHAT_I_TRIED:
  - Ran 'which playwright'
  - Searched node_modules/.bin
  - Read package.json
WHY_STUCK: The binary is reported missing despite npm ls showing it installed; the daemon's PATH may differ from expected.
RECOMMENDED_ACTION: ask-human
HUMAN_QUESTION: Should I install playwright globally or fix the daemon's PATH?
`;

  it('extracts whatFailed', () => {
    const out = parseEscalationPayload(wellFormed);
    expect(out?.whatFailed).toBe("Couldn't locate the playwright browser binary");
  });

  it('extracts whatTried as a bullet list (capped at 5)', () => {
    const out = parseEscalationPayload(wellFormed);
    expect(out?.whatTried).toEqual([
      "Ran 'which playwright'",
      'Searched node_modules/.bin',
      'Read package.json',
    ]);
  });

  it('extracts whyStuck as a paragraph', () => {
    const out = parseEscalationPayload(wellFormed);
    expect(out?.whyStuck).toMatch(/binary is reported missing/);
  });

  it('extracts recommendedAction', () => {
    expect(parseEscalationPayload(wellFormed)?.recommendedAction).toBe('ask-human');
  });

  it('extracts humanQuestion when ask-human', () => {
    expect(parseEscalationPayload(wellFormed)?.humanQuestion).toMatch(
      /Should I install playwright globally/,
    );
  });

  it('caps WHAT_I_TRIED at 5 bullets per FR-4', () => {
    const long = `---ESCALATE---
WHAT_FAILED: x
WHAT_I_TRIED:
  - one
  - two
  - three
  - four
  - five
  - six
  - seven
WHY_STUCK: y
RECOMMENDED_ACTION: skip-step
`;
    expect(parseEscalationPayload(long)?.whatTried.length).toBe(5);
  });
});

describe('parseEscalationPayload — partial / malformed', () => {
  it('returns null when marker is absent', () => {
    expect(parseEscalationPayload('plain output, no markers here')).toBeNull();
  });

  it('returns null when only the marker is present (no fields)', () => {
    expect(parseEscalationPayload('preamble\n---ESCALATE---\n')).toBeNull();
  });

  it('returns a partial payload when only some fields are present', () => {
    const partial = `---ESCALATE---
WHAT_FAILED: stuck
WHY_STUCK: not enough context to proceed
`;
    const out = parseEscalationPayload(partial);
    expect(out).toBeTruthy();
    expect(out.whatFailed).toBe('stuck');
    expect(out.whyStuck).toMatch(/not enough context/);
    expect(out.whatTried).toEqual([]);
    expect(out.recommendedAction).toBeUndefined();
    expect(out.humanQuestion).toBeUndefined();
  });

  it('ignores prose appearing AFTER the structured fields', () => {
    const trailing = `---ESCALATE---
WHAT_FAILED: oops
WHY_STUCK: see above
RECOMMENDED_ACTION: skip-step

I will now stop and wait for the operator.
`;
    const out = parseEscalationPayload(trailing);
    expect(out?.recommendedAction).toBe('skip-step');
    expect(out?.whyStuck).toBe('see above');
  });

  it('rejects an unknown RECOMMENDED_ACTION value', () => {
    const bad = `---ESCALATE---
WHAT_FAILED: x
WHY_STUCK: y
RECOMMENDED_ACTION: blow-up-the-world
`;
    const out = parseEscalationPayload(bad);
    expect(out?.recommendedAction).toBeUndefined();
  });

  it('handles non-string input gracefully', () => {
    expect(parseEscalationPayload(undefined)).toBeNull();
    expect(parseEscalationPayload(null)).toBeNull();
    expect(parseEscalationPayload(42)).toBeNull();
  });
});

describe('detectEscalation — daemon dispatch decision', () => {
  it('returns null when no marker fired', () => {
    const extracted = { QA_REPORT: '...', VERDICT: 'PASS' };
    expect(detectEscalation(extracted, 'all good, ---DONE---')).toBeNull();
  });

  it('returns null when only EXIT_DONE fired', () => {
    const extracted = { EXIT_DONE: '---DONE---', QA_REPORT: 'ok' };
    expect(detectEscalation(extracted, 'work complete\n---DONE---\n')).toBeNull();
  });

  it('routes ESCALATION marker to AGENT_ESCALATED with parsed payload', () => {
    const extracted = { ESCALATION: '---ESCALATE---', VERDICT: 'PARTIAL' };
    const text = `---ESCALATE---
WHAT_FAILED: build broke
WHY_STUCK: missing dep
RECOMMENDED_ACTION: ask-human
HUMAN_QUESTION: bump version?
`;
    const out = detectEscalation(extracted, text);
    expect(out?.triggeredBy).toBe('AGENT_ESCALATED');
    expect(out?.escalationPayload.whatFailed).toBe('build broke');
    expect(out?.escalationPayload.recommendedAction).toBe('ask-human');
    expect(out?.escalationPayload.humanQuestion).toBe('bump version?');
  });

  it('routes ---NEED-HUMAN--- shortcut to AGENT_NEEDS_HUMAN with humanQuestion populated', () => {
    const extracted = { HUMAN_QUESTION: '---NEED-HUMAN---', VERDICT: 'INDETERMINATE' };
    const text = `---NEED-HUMAN---
HUMAN_QUESTION: Should we use Postgres or DynamoDB here?
`;
    const out = detectEscalation(extracted, text);
    expect(out?.triggeredBy).toBe('AGENT_NEEDS_HUMAN');
    expect(out?.escalationPayload.humanQuestion).toBe(
      'Should we use Postgres or DynamoDB here?',
    );
    // Synthesized whatFailed/whyStuck so the inbox always renders something.
    expect(out?.escalationPayload.whatFailed).toMatch(/NEED-HUMAN/);
  });

  it('classifies non-universal extracted vars as salvageable', () => {
    const extracted = {
      ESCALATION: '---ESCALATE---',
      VERDICT: 'PARTIAL',
      QA_REPORT: '...',
    };
    const text = `---ESCALATE---
WHAT_FAILED: x
WHY_STUCK: y
`;
    const out = detectEscalation(extracted, text);
    expect(out?.salvageableExtractors.sort()).toEqual(['QA_REPORT', 'VERDICT']);
  });

  it('produces empty salvageableExtractors when no per-step extractors fired', () => {
    const extracted = { ESCALATION: '---ESCALATE---' };
    const text = `---ESCALATE---
WHAT_FAILED: x
WHY_STUCK: y
`;
    const out = detectEscalation(extracted, text);
    expect(out?.salvageableExtractors).toEqual([]);
  });

  it('prefers the structured ---ESCALATE--- payload over the shortcut when both markers appear', () => {
    const extracted = {
      ESCALATION: '---ESCALATE---',
      HUMAN_QUESTION: '---NEED-HUMAN---',
    };
    const text = `---ESCALATE---
WHAT_FAILED: dual signal
WHY_STUCK: testing precedence
RECOMMENDED_ACTION: ask-human
HUMAN_QUESTION: which one wins?
---NEED-HUMAN---
HUMAN_QUESTION: should not override
`;
    const out = detectEscalation(extracted, text);
    expect(out?.triggeredBy).toBe('AGENT_ESCALATED');
    // ---ESCALATE--- block's HUMAN_QUESTION wins (parsed first).
    expect(out?.escalationPayload.humanQuestion).toBe('which one wins?');
  });
});

describe('parseHumanQuestion', () => {
  it('extracts the question after ---NEED-HUMAN---', () => {
    const text = `working on this...
---NEED-HUMAN---
HUMAN_QUESTION: Which database should I migrate to?
`;
    expect(parseHumanQuestion(text)).toBe('Which database should I migrate to?');
  });

  it('returns null when marker absent', () => {
    expect(parseHumanQuestion('no markers')).toBeNull();
  });

  it('returns null when marker present but no HUMAN_QUESTION line', () => {
    expect(parseHumanQuestion('---NEED-HUMAN---\n\n')).toBeNull();
  });

  it('handles trailing prose after the question', () => {
    const text = `---NEED-HUMAN---
HUMAN_QUESTION: Approve the migration?
(I'll wait for your decision.)
`;
    expect(parseHumanQuestion(text)).toBe('Approve the migration?');
  });
});
