import { describe, it, expect } from 'vitest';
import {
  hasDoneAndWorkSummary,
  isStepOutputComplete,
  classifyCompletion,
} from '../done-detector.mjs';

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

describe('isStepOutputComplete — PR-6 generalized detector', () => {
  it('returns false on empty/non-string', () => {
    expect(isStepOutputComplete('')).toBe(false);
    expect(isStepOutputComplete(null)).toBe(false);
    expect(isStepOutputComplete(undefined)).toBe(false);
    expect(isStepOutputComplete(42)).toBe(false);
  });

  it('accepts DEV completion (DONE + WORK_SUMMARY)', () => {
    const text = `Done.

---DONE---

---WORK_SUMMARY---
Implemented X.
---END_WORK_SUMMARY---`;
    expect(isStepOutputComplete(text)).toBe(true);
    expect(classifyCompletion(text)).toBe('dev');
  });

  it('accepts REVIEWER completion (REVIEW_CRITERIA bracket pair)', () => {
    // The dino-N forensic shape: reviewer emits the verdict block, OAuth
    // expires AFTER the END marker.
    const text = `Looks good.

---REVIEW_CRITERIA---
AC-1: pass
AC-2: pass
---END_REVIEW_CRITERIA---`;
    expect(isStepOutputComplete(text)).toBe(true);
    expect(classifyCompletion(text)).toBe('reviewer');
  });

  it('accepts generic completion (DONE on own line, no WORK_SUMMARY)', () => {
    // COMPILER agent's contract — emits ---DONE--- without a structured summary.
    const text = `Compiled successfully.

---DONE---`;
    expect(isStepOutputComplete(text)).toBe(true);
    expect(classifyCompletion(text)).toBe('generic');
  });

  it('returns false on prose without any markers', () => {
    expect(isStepOutputComplete('Just some prose. No markers here.')).toBe(false);
    expect(classifyCompletion('Just some prose.')).toBe('none');
  });

  it('returns false when ---REVIEW_CRITERIA--- is opened but not closed', () => {
    // Real-world half-truncation — agent started the block but stream cut off.
    const text = `---REVIEW_CRITERIA---
AC-1: pass`;
    expect(isStepOutputComplete(text)).toBe(false);
  });

  it('rejects inline marker false-positives', () => {
    // Tool input containing the literal but not on its own line.
    const text = 'The agent ran ---DONE--- as a literal in an Edit call.';
    expect(isStepOutputComplete(text)).toBe(false);
  });

  it('reviewer match has priority over generic when both could fire', () => {
    // Both REVIEWER bracket pair AND a stray ---DONE--- present. The most
    // specific match wins for diagnostic purposes.
    const text = `---REVIEW_CRITERIA---
AC-1: pass
---END_REVIEW_CRITERIA---

---DONE---`;
    expect(classifyCompletion(text)).toBe('reviewer');
    expect(isStepOutputComplete(text)).toBe(true);
  });

  it('handles realistic dino-N OAuth-after-REVIEW shape', () => {
    // Excerpt copied from dino1 retry forensic (2026-04-29). REVIEWER fully
    // emitted the verdict, then OAuth expired ~291ms later.
    const text = `## Review: Collision Detection & Game-Over Flow

### Code Analysis

The implementation is clean...

---REVIEW_CRITERIA---
AC-1: pass
AC-2: pass
AC-3: pass
AC-4: needsan — hitbox forgiveness is subjective
AC-5: pass
---END_REVIEW_CRITERIA---

### Minor suggestion (non-blocking)
...`;
    expect(isStepOutputComplete(text)).toBe(true);
    expect(classifyCompletion(text)).toBe('reviewer');
  });
});
