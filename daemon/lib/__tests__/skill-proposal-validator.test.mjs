/**
 * skill-proposal-validator.test.mjs — Pipeline v2 Phase 3-C Epic 3
 * (Story 3.1, 2026-05-20).
 *
 * Keeps the daemon-side validator in sync with the TS Zod schema
 * (`functions/shared/pipelines/skill-scout-pipeline.ts::SkillScoutOutputSchema`).
 * If the TS schema gains/loses a field, this test should break first.
 */

import { describe, it, expect } from 'vitest';
import { validateSkillProposalsBlock } from '../skill-proposal-validator.mjs';

const VALID_PROPOSAL = {
  kind: 'add',
  source: 'anthropic-official',
  skill: 'canvas-design',
  manifestBucket: 'core',
  version: 'tag:v1.2.3',
  rationale: 'pixel-art canvas game would benefit',
  verifyNotes: 'fetched, SHA matches, LICENSE OK',
  confidence: 0.95,
};

const VALID_OUTPUT = {
  trigger: 'T1',
  projectSlug: 'dino-test-3',
  proposals: [VALID_PROPOSAL],
};

describe('validateSkillProposalsBlock — happy path', () => {
  it('accepts a well-formed output', () => {
    const r = validateSkillProposalsBlock(JSON.stringify(VALID_OUTPUT));
    expect(r.ok).toBe(true);
    expect(r.output.proposals).toHaveLength(1);
  });

  it('accepts empty proposals[]', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({ trigger: 'T2', projectSlug: 'x', proposals: [] }),
    );
    expect(r.ok).toBe(true);
    expect(r.output.proposals).toHaveLength(0);
  });

  it('accepts sha:<40-hex> version pin', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({
        ...VALID_OUTPUT,
        proposals: [{ ...VALID_PROPOSAL, version: 'sha:' + 'a'.repeat(40) }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('accepts all eight trigger values', () => {
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']) {
      const r = validateSkillProposalsBlock(
        JSON.stringify({ trigger: t, projectSlug: 'x', proposals: [] }),
      );
      expect(r.ok, t).toBe(true);
    }
  });
});

describe('validateSkillProposalsBlock — rejection paths', () => {
  it('rejects empty string', () => {
    expect(validateSkillProposalsBlock('').ok).toBe(false);
    expect(validateSkillProposalsBlock('  ').ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const r = validateSkillProposalsBlock('{not json}');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('JSON parse failed');
  });

  it('rejects non-object top level', () => {
    const r = validateSkillProposalsBlock('"hello"');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('must be an object');
  });

  it('rejects invalid trigger', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({ trigger: 'T99', projectSlug: 'x', proposals: [] }),
    );
    expect(r.error).toContain('trigger');
  });

  it('rejects empty projectSlug', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({ trigger: 'T1', projectSlug: '', proposals: [] }),
    );
    expect(r.error).toContain('projectSlug');
  });

  it('rejects non-array proposals', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({ trigger: 'T1', projectSlug: 'x', proposals: 'nope' }),
    );
    expect(r.error).toContain('proposals: must be an array');
  });

  it('rejects invalid proposal.kind', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({
        ...VALID_OUTPUT,
        proposals: [{ ...VALID_PROPOSAL, kind: 'bogus' }],
      }),
    );
    expect(r.error).toContain('proposals.0.kind');
  });

  it('rejects invalid manifestBucket', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({
        ...VALID_OUTPUT,
        proposals: [{ ...VALID_PROPOSAL, manifestBucket: 'plan' }],
      }),
    );
    expect(r.error).toContain('manifestBucket');
  });

  it('rejects malformed version pin', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({
        ...VALID_OUTPUT,
        proposals: [{ ...VALID_PROPOSAL, version: 'sha:short' }],
      }),
    );
    expect(r.error).toContain('version');
  });

  it('rejects out-of-range confidence', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({
        ...VALID_OUTPUT,
        proposals: [{ ...VALID_PROPOSAL, confidence: 1.5 }],
      }),
    );
    expect(r.error).toContain('confidence');
  });

  it('rejects empty rationale', () => {
    const r = validateSkillProposalsBlock(
      JSON.stringify({
        ...VALID_OUTPUT,
        proposals: [{ ...VALID_PROPOSAL, rationale: '' }],
      }),
    );
    expect(r.error).toContain('rationale');
  });
});
