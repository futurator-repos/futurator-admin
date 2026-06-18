import { describe, it, expect } from 'vitest';
import {
  buildPrdConvergencePrompt,
  buildUxConvergencePrompt,
  buildArchConvergencePrompt,
  buildConvergencePrompt,
} from '../convergence-prompt';
import {
  TEMPLATE_OUTPUT_START,
  TEMPLATE_OUTPUT_END,
  DECISION_CARD_START,
  DECISION_CARD_END,
  CONVERGENCE_CHECKPOINT,
  hasConvergenceCheckpoint,
  extractTemplateOutput,
  extractDecisionCards,
} from '../concept-markers';

const BASE = { intent: 'a task app', rigor: 'mvp' as const, depth: 'light' as const };

describe('convergence prompts (Story 4.1a — elicit→converge contract)', () => {
  it('PRD convergence pins the decision-card + template-output + checkpoint markers', () => {
    const p = buildPrdConvergencePrompt(BASE);
    expect(p).toContain(DECISION_CARD_START);
    expect(p).toContain(DECISION_CARD_END);
    expect(p).toContain(TEMPLATE_OUTPUT_START);
    expect(p).toContain(TEMPLATE_OUTPUT_END);
    expect(p).toContain(CONVERGENCE_CHECKPOINT);
    // distilled adv-elicit menu is inlined (not the BMAD XML engine).
    expect(p).toMatch(/Critique and Refine/);
    expect(p).toMatch(/Identify Risks/);
  });

  it('UX convergence requires the 9-section template + markers', () => {
    const p = buildUxConvergencePrompt(BASE);
    expect(p).toContain('Information Architecture');
    expect(p).toContain('Key User Journeys');
    expect(p).toContain(CONVERGENCE_CHECKPOINT);
  });

  it('Arch convergence requires the 7 implementation-pattern categories', () => {
    const p = buildArchConvergencePrompt({ ...BASE, depth: 'full', uiBearing: true });
    for (const cat of [
      'naming',
      'structure',
      'format',
      'communication',
      'lifecycle',
      'location',
      'consistency',
    ]) {
      expect(p).toContain(cat);
    }
    expect(p).toMatch(/Match the UX/);
  });

  it('production depth pulls in the full section set (NFR/Domain for PRD)', () => {
    const p = buildPrdConvergencePrompt({ ...BASE, rigor: 'production', depth: 'full' });
    expect(p).toContain('Non-Functional Requirements');
    expect(p).toContain('Domain Requirements');
  });

  it('buildConvergencePrompt dispatches by kind', () => {
    expect(buildConvergencePrompt('prd', { ...BASE, uiBearing: false })).toContain(
      'Product Manager (John)',
    );
    expect(buildConvergencePrompt('ux', { ...BASE, uiBearing: true })).toContain(
      'UX Designer (Sally)',
    );
    expect(buildConvergencePrompt('architecture', { ...BASE, uiBearing: true })).toContain(
      'Architect (Winston)',
    );
  });

  it('inlines priorArtifacts when supplied', () => {
    const p = buildArchConvergencePrompt({
      ...BASE,
      uiBearing: true,
      priorArtifacts: 'APPROVED PRD',
    });
    expect(p).toContain('APPROVED PRD');
  });
});

describe('concept-markers — extraction helpers (substring-extracted, typo-fatal)', () => {
  it('hasConvergenceCheckpoint detects the sentinel', () => {
    expect(hasConvergenceCheckpoint(`some text\n${CONVERGENCE_CHECKPOINT}\n`)).toBe(true);
    expect(hasConvergenceCheckpoint('no marker here')).toBe(false);
  });

  it('extractTemplateOutput returns the last finalized block', () => {
    const text = [
      `${TEMPLATE_OUTPUT_START}\n## A\nfirst\n${TEMPLATE_OUTPUT_END}`,
      `${TEMPLATE_OUTPUT_START}\n## Full Doc\nfinal\n${TEMPLATE_OUTPUT_END}`,
    ].join('\n\n');
    expect(extractTemplateOutput(text)).toBe('## Full Doc\nfinal');
    expect(extractTemplateOutput('nothing')).toBeNull();
  });

  it('extractDecisionCards returns every card body in order', () => {
    const text = [
      `${DECISION_CARD_START}\nScope?\n1. MVP\n2. Full\n${DECISION_CARD_END}`,
      `${DECISION_CARD_START}\nStorage?\n1. SQLite\n2. Postgres\n${DECISION_CARD_END}`,
    ].join('\n');
    const cards = extractDecisionCards(text);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('Scope?');
    expect(cards[1]).toContain('Storage?');
  });
});
