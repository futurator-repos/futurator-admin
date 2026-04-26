import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeVisualTestsBlock } from '../visual-tests-writer.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'vt-writer-'));
}

const SAMPLE_BLOCK = `---VISUAL_TESTS---
- id: VT-S1-1
  criteriaRef: AC-1
  description: "Title renders"
  setup: "Load the page"
  action: "none"
  expect: "h1 visible with text 'Hello'"
- id: VT-S1-2
  criteriaRef: AC-2
  description: "Button responds"
  setup: "Load the page"
  action: "click:.start"
  expect: "Game starts"
---END_VISUAL_TESTS---`;

describe('mergeVisualTestsBlock', () => {
  let dir;

  beforeEach(() => {
    dir = makeTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a fresh visual-tests.md with envelope when no file exists', () => {
    const result = mergeVisualTestsBlock({ projectDir: dir, block: SAMPLE_BLOCK });
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(2);
    expect(result.appendedRefs).toEqual(['AC-1', 'AC-2']);
    expect(result.replacedRefs).toEqual([]);

    const written = readFileSync(result.path, 'utf8');
    expect(written.startsWith('---VISUAL_TESTS---\n')).toBe(true);
    expect(written.trimEnd().endsWith('---END_VISUAL_TESTS---')).toBe(true);
    expect(written).toContain('AC-1');
    expect(written).toContain('AC-2');
  });

  it('replaces an existing entry with the same criteriaRef (no duplicate)', () => {
    // Seed the file with an old AC-1 entry plus an unrelated AC-3 entry.
    writeFileSync(
      join(dir, 'visual-tests.md'),
      `---VISUAL_TESTS---
- id: VT-OLD-1
  criteriaRef: AC-1
  description: "Old description"
  setup: "Old setup"
  action: "none"
  expect: "Old expectation"
- id: VT-OLD-3
  criteriaRef: AC-3
  description: "Untouched"
  setup: "Load page"
  action: "none"
  expect: "Status bar visible"
---END_VISUAL_TESTS---
`,
      'utf8',
    );

    const result = mergeVisualTestsBlock({ projectDir: dir, block: SAMPLE_BLOCK });
    expect(result.ok).toBe(true);
    expect(result.replacedRefs).toEqual(['AC-1']);
    expect(result.appendedRefs).toEqual(['AC-2']);

    const written = readFileSync(result.path, 'utf8');
    // AC-1 should appear exactly once and the new id should be VT-S1-1
    const ac1Matches = written.match(/criteriaRef\s*:\s*AC-1/g) || [];
    expect(ac1Matches.length).toBe(1);
    expect(written).toContain('VT-S1-1');
    expect(written).not.toContain('VT-OLD-1');
    // AC-3 (untouched) and AC-2 (newly appended) both present.
    expect(written).toContain('AC-3');
    expect(written).toContain('VT-OLD-3');
    expect(written).toContain('AC-2');
  });

  it('keeps a single envelope on disk after merge', () => {
    mergeVisualTestsBlock({ projectDir: dir, block: SAMPLE_BLOCK });
    const second = mergeVisualTestsBlock({ projectDir: dir, block: SAMPLE_BLOCK });
    expect(second.ok).toBe(true);
    const written = readFileSync(second.path, 'utf8');
    const startCount = (written.match(/---VISUAL_TESTS---/g) || []).length;
    const endCount = (written.match(/---END_VISUAL_TESTS---/g) || []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it('tolerates blocks passed without the envelope markers', () => {
    const naked = SAMPLE_BLOCK.replace('---VISUAL_TESTS---\n', '').replace(
      '\n---END_VISUAL_TESTS---',
      '',
    );
    const result = mergeVisualTestsBlock({ projectDir: dir, block: naked });
    expect(result.ok).toBe(true);
    expect(result.appendedRefs).toEqual(['AC-1', 'AC-2']);
  });

  it('returns ok:false WITHOUT writing the file when an entry has no criteriaRef', () => {
    const broken = `---VISUAL_TESTS---
- id: VT-BROKEN
  description: "Forgot criteriaRef!"
  setup: "x"
  expect: "y"
---END_VISUAL_TESTS---`;
    const result = mergeVisualTestsBlock({ projectDir: dir, block: broken });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/criteriaRef/);
    // File was not created.
    expect(() => readFileSync(join(dir, 'visual-tests.md'), 'utf8')).toThrow();
  });

  it('does not partial-write when a later entry is malformed', () => {
    writeFileSync(
      join(dir, 'visual-tests.md'),
      `---VISUAL_TESTS---
- id: VT-OLD
  criteriaRef: AC-9
  description: "Untouched"
  setup: "x"
  expect: "y"
---END_VISUAL_TESTS---
`,
      'utf8',
    );
    const mostlyValid = `---VISUAL_TESTS---
- id: VT-NEW-1
  criteriaRef: AC-1
  description: "Good entry"
  setup: "x"
  expect: "y"
- id: VT-NEW-2
  description: "Bad entry — no criteriaRef"
  setup: "x"
  expect: "y"
---END_VISUAL_TESTS---`;
    const result = mergeVisualTestsBlock({
      projectDir: dir,
      block: mostlyValid,
    });
    expect(result.ok).toBe(false);
    // File still contains only the original AC-9 entry — no partial write.
    const written = readFileSync(join(dir, 'visual-tests.md'), 'utf8');
    expect(written).toContain('AC-9');
    expect(written).not.toContain('AC-1');
  });

  it('returns ok:true with totalEntries=0 when block has no entries', () => {
    const empty = `---VISUAL_TESTS---
---END_VISUAL_TESTS---`;
    const result = mergeVisualTestsBlock({ projectDir: dir, block: empty });
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(0);
    expect(result.appendedRefs).toEqual([]);
  });
});
