/**
 * triage-pipeline.test.ts — Pipeline v2 Phase 3 / Story 3-E-6-1 (PR-81).
 */

import { describe, it, expect } from 'vitest';
import {
  generateTriagePipeline,
  validateTriageProposalBlock,
  TriageProposalSchema,
} from '../triage-pipeline';

const BASE_ARGS = {
  feedback: {
    id: 'fb-123',
    projectSlug: 'dino-runner-1',
    summary: 'Dino sometimes clips through cactus on respawn',
    severity: 'medium' as const,
    reportedAt: '2026-05-15T20:00:00Z',
  },
  priors: [
    {
      caseId: 'S-old',
      project: 'dino-runner-1',
      summary: 'collision-detection off-by-one on respawn',
      resolution: 'fix bounding-box reset',
      tier: 'same-project' as const,
      score: 0.92,
    },
  ],
  boilerplateKind: 'nextjs-canvas-game' as const,
  rigor: 'mvp' as const,
};

describe('generateTriagePipeline', () => {
  it('builds a single-step pipeline with the TRIAGE agent', () => {
    const pipe = generateTriagePipeline(BASE_ARGS);
    expect(Object.keys(pipe.agents)).toEqual(['TRIAGE']);
    expect(pipe.steps).toHaveLength(1);
    expect(pipe.steps[0]?.id).toBe('triage-rank');
  });

  it('TRIAGE agent gets Sonnet by default', () => {
    const pipe = generateTriagePipeline(BASE_ARGS);
    expect(pipe.agents.TRIAGE?.model).toBe('sonnet');
  });

  it('allowedTools = Read / Grep / Glob; Bash + Write + Edit denied', () => {
    const pipe = generateTriagePipeline(BASE_ARGS);
    const allowed = pipe.agents.TRIAGE?.allowedTools ?? '';
    const disallowed = pipe.agents.TRIAGE?.disallowedTools ?? '';
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Grep');
    expect(allowed).not.toContain('Bash');
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Edit');
  });

  it('maxTurns from rigor matrix', () => {
    expect(
      generateTriagePipeline({ ...BASE_ARGS, rigor: 'prototype' }).agents.TRIAGE?.maxTurns,
    ).toBe(4);
    expect(generateTriagePipeline(BASE_ARGS).agents.TRIAGE?.maxTurns).toBe(6);
    expect(
      generateTriagePipeline({ ...BASE_ARGS, rigor: 'production' }).agents.TRIAGE?.maxTurns,
    ).toBe(8);
  });

  it('extractor captures between TRIAGE_PROPOSAL markers', () => {
    const pipe = generateTriagePipeline(BASE_ARGS);
    const ex = pipe.steps[0]?.extractors?.TRIAGE_PROPOSAL_JSON;
    expect(ex?.type).toBe('between');
    expect((ex as { startDelimiter: string }).startDelimiter).toBe('---TRIAGE_PROPOSAL---');
  });

  it('prompt includes feedback summary + priors', () => {
    const pipe = generateTriagePipeline(BASE_ARGS);
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('Dino sometimes clips through cactus');
    expect(prompt).toContain('collision-detection off-by-one');
    expect(prompt).toContain('same-project');
  });

  it('prompt renders "no relevant priors" placeholder when empty', () => {
    const pipe = generateTriagePipeline({ ...BASE_ARGS, priors: [] });
    expect(pipe.steps[0]?.prompt).toContain('no relevant prior cases');
  });
});

describe('validateTriageProposalBlock', () => {
  it('parses a well-formed proposal', () => {
    const raw = JSON.stringify({
      feedbackId: 'fb-1',
      projectSlug: 'dino',
      planKind: 'bugfix',
      planTitle: 'Fix dino collision on respawn',
      planIntent: 'reset bounding box to entity origin before re-spawning',
      severity: 'medium',
      citedPriors: ['S-old'],
      confidence: 0.85,
    });
    const result = validateTriageProposalBlock(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.planKind).toBe('bugfix');
      expect(result.output.citedPriors).toEqual(['S-old']);
    }
  });

  it('rejects unknown planKind', () => {
    const raw = JSON.stringify({
      feedbackId: 'fb',
      projectSlug: 'x',
      planKind: 'experiment',
      planTitle: 't',
      planIntent: 'i',
      severity: 'low',
      confidence: 0.5,
    });
    expect(validateTriageProposalBlock(raw).ok).toBe(false);
  });

  it('rejects unknown severity', () => {
    const raw = JSON.stringify({
      feedbackId: 'fb',
      projectSlug: 'x',
      planKind: 'bugfix',
      planTitle: 't',
      planIntent: 'i',
      severity: 'cosmic',
      confidence: 0.5,
    });
    expect(validateTriageProposalBlock(raw).ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect(validateTriageProposalBlock('{not json').ok).toBe(false);
  });

  it('defaults citedPriors to empty array when omitted', () => {
    const raw = JSON.stringify({
      feedbackId: 'fb',
      projectSlug: 'x',
      planKind: 'bugfix',
      planTitle: 't',
      planIntent: 'i',
      severity: 'low',
      confidence: 0.5,
    });
    const result = validateTriageProposalBlock(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.citedPriors).toEqual([]);
  });
});

describe('TriageProposalSchema sanity', () => {
  it('exports individually-validatable schema', () => {
    expect(
      TriageProposalSchema.safeParse({
        feedbackId: 'a',
        projectSlug: 'b',
        planKind: 'maintenance',
        planTitle: 'c',
        planIntent: 'd',
        severity: 'high',
        citedPriors: [],
        confidence: 0.7,
      }).success,
    ).toBe(true);
  });
});
