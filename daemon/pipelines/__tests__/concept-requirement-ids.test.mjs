import { describe, it, expect } from 'vitest';
import { extractRequirementIds } from '../lib/concept-artifact-writeback.mjs';

// Pipeline v3 (E1-S2) — the daemon extracts the PRD's functional-requirement
// ids from prd.md so the apply path can stamp `plan.prdRequirementIds`, the
// ground truth the readiness gate checks epic coverage against.
describe('extractRequirementIds (v3 E1-S2)', () => {
  it('pulls FR ids from the PRD prose, unique + numerically sorted', () => {
    const prd = [
      '# Product Requirements',
      '## Functional Requirements',
      'FR1. The app loads a board.',
      'FR2. The player moves with arrow keys.',
      'FR10. The score persists across reloads.',
      '',
      'Later prose references FR2 again and FR1.',
    ].join('\n');
    // FR10 sorts after FR2 (numeric, not lexicographic); dups collapsed.
    expect(extractRequirementIds(prd)).toEqual(['FR1', 'FR2', 'FR10']);
  });

  it('returns an empty list for a PRD with no FR ids (or empty input)', () => {
    expect(extractRequirementIds('# PRD\n\nNo numbered requirements here.')).toEqual([]);
    expect(extractRequirementIds('')).toEqual([]);
    expect(extractRequirementIds(null)).toEqual([]);
    expect(extractRequirementIds(undefined)).toEqual([]);
  });

  it('matches only FR<number> tokens, not lookalikes', () => {
    // FRED / FR-1 (hyphenated) / FRAME are not FR<digits> tokens.
    const md = 'FRED owns FR3. FRAME shows FR3 twice. Avoid FR. matching bare FR.';
    expect(extractRequirementIds(md)).toEqual(['FR3']);
  });
});
