import { describe, it, expect } from 'vitest';
import { substituteTemplate } from '../template-substitution.mjs';

/**
 * Story A.5 smoke test. Asserts that a sample reviewer text round-trips
 * through the FEEDBACK extractor regex and the daemon's substituteTemplate
 * with no `{{FEEDBACK}}` (or sibling) placeholders surviving in the rendered
 * retry prompt.
 *
 * The regex is mirrored verbatim from
 * `functions/shared/pipelines/story-pipeline.ts` review step. Keep in sync —
 * if that pattern changes, update the constant below.
 */

const FEEDBACK_PATTERN = '\\*{0,2}FEEDBACK\\*{0,2}\\s*:\\s*([\\s\\S]+?)$';
const VERDICT_PATTERN = 'VERDICT:\\s*\\*{0,2}(PASS|FAIL)\\*{0,2}';

// Mirror of the runExtractors logic for `regex` type (see agent-daemon.mjs).
function extractRegex(text, pattern) {
  const re = new RegExp(pattern, 's');
  const m = re.exec(text);
  if (!m) return null;
  return m[1] || m[0];
}

const RETRY_PROMPT_TEMPLATE = `The code reviewer checked your work (attempt {{ITERATION}} of {{MAX_ITERATIONS}}).

Feedback: {{FEEDBACK}}
Verdict: {{VERDICT}}

Fix the issues mentioned. Output only what you changed, then:
---WORK_SUMMARY---
[Updated summary of changes]
---END_WORK_SUMMARY---`;

describe('Story A.5 — FEEDBACK round-trip into retry prompt', () => {
  it('extracts and substitutes plain "FEEDBACK: text" form', () => {
    const reviewerOutput = `VERDICT: FAIL
FEEDBACK: The brick collision detection misses corner hits.
Add a small inset to the bounding box.`;
    const FEEDBACK = extractRegex(reviewerOutput, FEEDBACK_PATTERN);
    const VERDICT = extractRegex(reviewerOutput, VERDICT_PATTERN);
    expect(FEEDBACK).toContain('brick collision');
    expect(VERDICT).toBe('FAIL');

    const rendered = substituteTemplate(RETRY_PROMPT_TEMPLATE, {
      ITERATION: '2',
      MAX_ITERATIONS: '3',
      FEEDBACK,
      VERDICT,
    });
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain('brick collision');
    expect(rendered).toContain('Verdict: FAIL');
  });

  it('extracts "**FEEDBACK:**" markdown-bold form (the dino3 incident)', () => {
    const reviewerOutput = `**VERDICT: FAIL**

**FEEDBACK:**
- Score increment is off-by-one when the ball clears the last row.
- Game over screen shows but does not lock input.`;
    const FEEDBACK = extractRegex(reviewerOutput, FEEDBACK_PATTERN);
    expect(FEEDBACK).not.toBeNull();
    expect(FEEDBACK).toContain('off-by-one');
    expect(FEEDBACK).toContain('Game over');

    const rendered = substituteTemplate(RETRY_PROMPT_TEMPLATE, {
      ITERATION: '2',
      MAX_ITERATIONS: '3',
      FEEDBACK,
      VERDICT: 'FAIL',
    });
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain('off-by-one');
  });

  it('extracts "**FEEDBACK**:" (asterisks before the colon)', () => {
    const reviewerOutput = `VERDICT: FAIL
**FEEDBACK**: Missing the keypress handler for Space.`;
    const FEEDBACK = extractRegex(reviewerOutput, FEEDBACK_PATTERN);
    expect(FEEDBACK).toContain('keypress handler');
  });

  it('substituteTemplate leaves {{FEEDBACK}} literal AND fires onMissing when var absent', () => {
    let missing = null;
    const rendered = substituteTemplate(
      RETRY_PROMPT_TEMPLATE,
      { ITERATION: '2', MAX_ITERATIONS: '3', VERDICT: 'FAIL' },
      (varName) => { missing = varName; },
    );
    expect(rendered).toContain('{{FEEDBACK}}');
    expect(missing).toBe('FEEDBACK');
  });

  it('captures multi-line FEEDBACK to the end of the reviewer output', () => {
    const reviewerOutput = `VERDICT: FAIL
FEEDBACK:
- bullet one
- bullet two
- bullet three with trailing detail
final paragraph`;
    const FEEDBACK = extractRegex(reviewerOutput, FEEDBACK_PATTERN);
    expect(FEEDBACK).toContain('bullet one');
    expect(FEEDBACK).toContain('bullet three');
    expect(FEEDBACK).toContain('final paragraph');
  });
});
