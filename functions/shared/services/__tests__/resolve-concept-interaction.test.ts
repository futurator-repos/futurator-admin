import { describe, it, expect } from 'vitest';
import {
  resolveConceptInteraction,
  defaultConceptInteractionForRigor,
  conceptChainStarted,
} from '../resolve-concept-interaction';
import type { Plan } from '../../types/plan';

/**
 * Concept v2 — Story E1.4 (W11): the interactivity axis default resolver.
 * Plumbing only — asserts the documented default + explicit override.
 */
describe('resolveConceptInteraction (Concept v2 — E1.4/W11)', () => {
  it('defaults prototype → autopilot', () => {
    expect(resolveConceptInteraction({ rigor: 'prototype' })).toBe('autopilot');
  });

  it('defaults mvp and production → interactive', () => {
    expect(resolveConceptInteraction({ rigor: 'mvp' })).toBe('interactive');
    expect(resolveConceptInteraction({ rigor: 'production' })).toBe('interactive');
  });

  it('defaults undefined rigor → interactive (treated as non-prototype)', () => {
    expect(resolveConceptInteraction({ rigor: undefined })).toBe('interactive');
  });

  it('an explicit value always wins over the rigor default', () => {
    expect(
      resolveConceptInteraction({ rigor: 'prototype', conceptInteraction: 'interactive' }),
    ).toBe('interactive');
    expect(
      resolveConceptInteraction({ rigor: 'production', conceptInteraction: 'autopilot' }),
    ).toBe('autopilot');
  });

  it('defaultConceptInteractionForRigor is the rigor-only helper', () => {
    expect(defaultConceptInteractionForRigor('prototype')).toBe('autopilot');
    expect(defaultConceptInteractionForRigor('mvp')).toBe('interactive');
  });
});

/**
 * Story 1.1 — the durable `conceptChainStarted` mode-lock predicate, derived
 * from generator FKs OR any artifact row advanced past genesis (rev>0).
 */
describe('conceptChainStarted (Concept v2 — E1.1 mode-lock predicate)', () => {
  it('is false for a freshly-seeded registry (all rev:0, no FKs)', () => {
    expect(
      conceptChainStarted({
        conceptArtifacts: [
          { kind: 'prd', rev: 0, contentHash: '', status: 'draft', dependsOn: [] },
        ],
      } as unknown as Plan),
    ).toBe(false);
  });

  it('is false for a prototype/legacy plan with no registry and no FKs', () => {
    expect(conceptChainStarted({} as unknown as Plan)).toBe(false);
  });

  it('is true once any generator FK is stamped', () => {
    expect(conceptChainStarted({ prdGenJobId: 'job-1' } as unknown as Plan)).toBe(true);
    expect(conceptChainStarted({ uxGenJobId: 'job-2' } as unknown as Plan)).toBe(true);
    expect(conceptChainStarted({ archGenJobId: 'job-3' } as unknown as Plan)).toBe(true);
  });

  it('is true once any artifact row advances past genesis (rev>0)', () => {
    expect(
      conceptChainStarted({
        conceptArtifacts: [
          { kind: 'prd', rev: 1, contentHash: 'sha256:x', status: 'draft', dependsOn: [] },
        ],
      } as unknown as Plan),
    ).toBe(true);
  });
});
