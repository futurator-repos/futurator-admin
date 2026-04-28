import { describe, it, expect } from 'vitest';
import { hasDoneAndWorkSummary } from '../done-detector.mjs';

describe('hasDoneAndWorkSummary — T0.1 cost-ceiling-after-DONE detector', () => {
  it('returns false on empty/non-string inputs', () => {
    expect(hasDoneAndWorkSummary('')).toBe(false);
    expect(hasDoneAndWorkSummary(null)).toBe(false);
    expect(hasDoneAndWorkSummary(undefined)).toBe(false);
    expect(hasDoneAndWorkSummary(42)).toBe(false);
    expect(hasDoneAndWorkSummary({})).toBe(false);
  });

  it('returns false when only ---DONE--- is present', () => {
    expect(hasDoneAndWorkSummary('Some prose\n---DONE---\nMore prose')).toBe(false);
  });

  it('returns false when only ---WORK_SUMMARY--- is present', () => {
    expect(hasDoneAndWorkSummary('---WORK_SUMMARY---\nDid stuff\n---END_WORK_SUMMARY---')).toBe(
      false,
    );
  });

  it('returns true when both markers are present on their own lines', () => {
    const text = `
The implementation is complete.

---DONE---

---WORK_SUMMARY---
No changes needed — already implemented in the scaffold.
---END_WORK_SUMMARY---
`;
    expect(hasDoneAndWorkSummary(text)).toBe(true);
  });

  it('returns true even when ---END_WORK_SUMMARY--- is missing', () => {
    // Real-world COST_HARD truncation: agent emits ---DONE--- and starts
    // ---WORK_SUMMARY--- but the CLI kills the process before END marker.
    // We still want to accept the work — the agent signaled completion.
    const text = `
---DONE---

---WORK_SUMMARY---
Halfway through the summary when the process was terminated...
`;
    expect(hasDoneAndWorkSummary(text)).toBe(true);
  });

  it('returns false when markers appear inline (not on their own line)', () => {
    // Defends against false-positives from tool inputs (e.g. an Edit call
    // whose old_string or new_string contains the literal `---DONE---`).
    const text = 'The agent ran ---DONE--- as part of an inline literal.';
    expect(hasDoneAndWorkSummary(text)).toBe(false);
  });

  it('returns true even with trailing whitespace after the markers', () => {
    expect(hasDoneAndWorkSummary('---DONE---  \n---WORK_SUMMARY---\t\nx')).toBe(true);
  });

  it('handles realistic dino1 cost-ceiling-after-DONE log shape', () => {
    // Excerpt copied from dino1 logs (E2W0S1, 2026-04-28 11:43:42).
    const text = `The code compiles cleanly. The implementation already exists and is complete.

---DONE---

---WORK_SUMMARY---
**No changes needed.** The dino physics story was already fully implemented in the scaffold:

- \`src/game/dino.ts\` — Contains all required pure functions
- \`src/game/types.ts\` — Dino interface
- \`src/game/constants.ts\` — Physics constants

All functions are pure, return new Dino objects, and the dino stays above GROUND_Y. TypeScript compiles cleanly.
---END_WORK_SUMMARY---
`;
    expect(hasDoneAndWorkSummary(text)).toBe(true);
  });
});
