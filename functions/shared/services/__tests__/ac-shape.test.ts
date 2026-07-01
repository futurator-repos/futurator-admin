import { describe, it, expect } from 'vitest';
import { validateAcShape } from '../solutioning-gate';

describe('validateAcShape (TDD blueprint §9)', () => {
  it('passes an AC with a Given/When/Then scenario', () => {
    const out = validateAcShape([
      {
        id: 'AC-1',
        text: 'user can log in',
        when: 'the button is pressed',
        then: 'a token is issued',
      },
    ]);
    expect(out).toEqual([]);
  });

  it('passes an AC whose prose carries a normative SHALL/MUST', () => {
    const out = validateAcShape([
      { id: 'AC-2', text: 'The system SHALL reject an expired token.' },
    ]);
    expect(out).toEqual([]);
  });

  it('flags a bare-prose AC with no scenario and no normative keyword', () => {
    const out = validateAcShape([{ id: 'AC-3', text: 'it should feel fast' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/AC-3 is not test-shaped/);
  });

  it('exempts manual ACs (a human confirms them)', () => {
    const out = validateAcShape([{ id: 'AC-4', text: 'looks nice', verify: 'manual' }]);
    expect(out).toEqual([]);
  });

  it('is case-insensitive on shall/must', () => {
    expect(validateAcShape([{ id: 'AC-5', text: 'the API must return 200' }])).toEqual([]);
  });
});
