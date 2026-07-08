import { describe, it, expect } from 'vitest';
import { buildPlanCritiquePrompt, parsePlanCritique, hasCritical } from '../plan-critique.mjs';

const STORIES = [
  {
    storyId: 'contract', title: 'Define the contract types', intent: 'Own the shared state shape',
    touches: ['src/types.ts'], depends_on: [],
    acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }],
  },
  {
    storyId: 'assemble', title: 'Assemble the complete app', intent: 'Wire the seam',
    touches: ['src/app.tsx'], depends_on: ['contract'],
    acceptanceCriteria: [
      { text: 'runs end to end', verify: 'behavior', needsBrowser: true, when: 'user presses start', thenObservable: 'snapshot.status equals running' },
    ],
  },
];

describe('buildPlanCritiquePrompt', () => {
  const prompt = buildPlanCritiquePrompt({ intent: 'a pacman game', appSlug: 'pac1', stories: STORIES, planShape: 'sharded' });

  it('names all four critique dimensions', () => {
    expect(prompt).toMatch(/DROPPED.*CAPABILITIES/i);
    expect(prompt).toMatch(/GAMEABLE ACs/i);
    expect(prompt).toMatch(/WRONG SHAPE/i);
    expect(prompt).toMatch(/MISSING SEAM WIRING/i);
  });

  it('emits the <CRITIQUE> output contract', () => {
    expect(prompt).toContain('<CRITIQUE>');
    expect(prompt).toContain('</CRITIQUE>');
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
  });

  it('renders the plan (story titles, intents, touches, ACs) and echoes planShape', () => {
    expect(prompt).toContain('Define the contract types');
    expect(prompt).toContain('Assemble the complete app');
    expect(prompt).toContain('src/types.ts');
    expect(prompt).toContain('src/app.tsx');
    expect(prompt).toContain('runs end to end');
    expect(prompt).toContain('planShape: sharded');
  });

  it('includes the operator intent and app slug', () => {
    expect(prompt).toContain('a pacman game');
    expect(prompt).toContain('pac1');
  });

  it('falls back to "unknown" when planShape is omitted', () => {
    const p = buildPlanCritiquePrompt({ intent: 'x', appSlug: 'y', stories: [] });
    expect(p).toContain('planShape: unknown');
  });
});

describe('parsePlanCritique', () => {
  it('extracts findings from a <CRITIQUE> tagged block', () => {
    const text = `blah blah <CRITIQUE>${JSON.stringify({ findings: [
      { severity: 'critical', kind: 'dropped-capability', message: 'no scoring anywhere', storyId: 'assemble' },
    ] })}</CRITIQUE> trailing`;
    const { findings, critical } = parsePlanCritique(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({ severity: 'critical', kind: 'dropped-capability', message: 'no scoring anywhere', storyId: 'assemble' });
    expect(critical).toBe(true);
  });

  it('extracts findings from a fenced ```json block', () => {
    const text = '```json\n' + JSON.stringify({ findings: [{ severity: 'minor', kind: 'gameable-ac', message: 'weak observable' }] }) + '\n```';
    const { findings, critical } = parsePlanCritique(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('gameable-ac');
    expect(critical).toBe(false);
  });

  it('extracts findings from bare (untagged, unfenced) JSON text', () => {
    const text = `Here is my analysis: ${JSON.stringify({ findings: [{ severity: 'major', kind: 'wrong-shape', message: 'sharded a coherent loop' }] })} done.`;
    const { findings, critical } = parsePlanCritique(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('major');
    expect(critical).toBe(false);
  });

  it('coerces an invalid/missing severity to "minor"', () => {
    const text = `<CRITIQUE>${JSON.stringify({ findings: [{ severity: 'YOLO', kind: 'k', message: 'm' }, { kind: 'k2', message: 'm2' }] })}</CRITIQUE>`;
    const { findings } = parsePlanCritique(text);
    expect(findings.map((f) => f.severity)).toEqual(['minor', 'minor']);
  });

  it('fills defaults for missing kind/message and drops non-string storyId', () => {
    const text = `<CRITIQUE>${JSON.stringify({ findings: [{ severity: 'major', storyId: 42 }] })}</CRITIQUE>`;
    const { findings } = parsePlanCritique(text);
    expect(findings[0].kind).toBe('unspecified');
    expect(findings[0].message).toBe('(no message)');
    expect(findings[0]).not.toHaveProperty('storyId');
  });

  it('returns empty/false on garbage or prose-only output', () => {
    expect(parsePlanCritique('sorry, I have nothing to add')).toEqual({ findings: [], critical: false });
    expect(parsePlanCritique('')).toEqual({ findings: [], critical: false });
    expect(parsePlanCritique(null)).toEqual({ findings: [], critical: false });
  });

  it('returns empty/false when findings is missing or not an array', () => {
    expect(parsePlanCritique('<CRITIQUE>{"notFindings": []}</CRITIQUE>')).toEqual({ findings: [], critical: false });
    expect(parsePlanCritique('<CRITIQUE>{"findings": "nope"}</CRITIQUE>')).toEqual({ findings: [], critical: false });
  });

  it('sets critical:true when ANY finding is critical, even amongst minors/majors', () => {
    const text = `<CRITIQUE>${JSON.stringify({ findings: [
      { severity: 'minor', kind: 'a', message: 'a' },
      { severity: 'major', kind: 'b', message: 'b' },
      { severity: 'critical', kind: 'c', message: 'c' },
    ] })}</CRITIQUE>`;
    expect(parsePlanCritique(text).critical).toBe(true);
  });
});

describe('hasCritical', () => {
  it('is true when at least one finding is critical', () => {
    expect(hasCritical([{ severity: 'minor' }, { severity: 'critical' }])).toBe(true);
  });

  it('is false for an all-non-critical or empty list', () => {
    expect(hasCritical([{ severity: 'minor' }, { severity: 'major' }])).toBe(false);
    expect(hasCritical([])).toBe(false);
  });

  it('is false for non-array input', () => {
    expect(hasCritical(null)).toBe(false);
    expect(hasCritical(undefined)).toBe(false);
  });
});
