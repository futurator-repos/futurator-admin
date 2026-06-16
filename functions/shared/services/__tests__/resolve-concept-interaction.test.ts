import { describe, it, expect } from 'vitest';
import {
  resolveConceptInteraction,
  defaultConceptInteractionForRigor,
} from '../resolve-concept-interaction';

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
