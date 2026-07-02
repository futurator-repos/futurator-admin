import { describe, it, expect } from 'vitest';
import {
  normalizeCriteria,
  normalizeCriterion,
  deriveRiskTag,
  normalizeText,
} from '../ac-cartographer';
import type { AcceptanceCriterion } from '../../types/epic-workflow';

const ac = (o: Partial<AcceptanceCriterion>): AcceptanceCriterion =>
  ({ id: 'AC-1', text: '', needsBrowser: false, ...o }) as AcceptanceCriterion;

describe('deriveRiskTag', () => {
  it('security-critical → P0', () => {
    expect(deriveRiskTag({ ...ac({}), acClass: 'advisory-security' } as AcceptanceCriterion)).toBe(
      'P0',
    );
  });
  it('user-facing behavior/appearance/browser → P1', () => {
    expect(deriveRiskTag(ac({ verify: 'behavior' }))).toBe('P1');
    expect(deriveRiskTag(ac({ needsBrowser: true }))).toBe('P1');
  });
  it('structured (BDD) → P2, plain → P3', () => {
    expect(deriveRiskTag(ac({ when: 'x', then: 'y' }))).toBe('P2');
    expect(deriveRiskTag(ac({ text: 'plain' }))).toBe('P3');
  });
});

describe('normalizeText (EARS)', () => {
  it('keeps already-normative text', () => {
    expect(normalizeText(ac({ text: 'The system MUST reject nulls' }))).toMatch(/MUST/);
  });
  it('builds When…shall from when+then', () => {
    expect(normalizeText(ac({ when: 'the button is pressed', then: 'a token is issued' }))).toBe(
      'When the button is pressed, the system shall a token is issued.',
    );
  });
});

describe('normalizeCriterion — SHADOW fields only (never overwrite)', () => {
  it('adds shadow fields, leaves text/given/when/then untouched', () => {
    const input = ac({ text: 'user logs in', given: 'g', when: 'w', then: 't' });
    const out = normalizeCriterion(input);
    // originals preserved
    expect(out.text).toBe('user logs in');
    expect(out.given).toBe('g');
    expect(out.when).toBe('w');
    expect(out.then).toBe('t');
    // shadow fields added
    expect(out.normalizedText).toBeTruthy();
    expect(out.normalizedGwt).toEqual({ given: 'g', when: 'w', then: 't' });
    expect(out.riskTag).toBe('P2');
  });

  it('manual ACs get a risk tag only (no normalizedText/Gwt)', () => {
    const out = normalizeCriterion(ac({ verify: 'manual', text: 'looks nice' }));
    expect(out.riskTag).toBeTruthy();
    expect(out.normalizedText).toBeUndefined();
    expect(out.normalizedGwt).toBeUndefined();
  });

  it('normalizeCriteria is immutable (input unchanged)', () => {
    const input = [ac({ text: 'a' })];
    const out = normalizeCriteria(input);
    expect(input[0].normalizedText).toBeUndefined();
    expect(out[0].normalizedText).toBeTruthy();
  });
});
