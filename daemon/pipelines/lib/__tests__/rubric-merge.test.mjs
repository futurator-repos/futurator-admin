import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { mergeRubric, parseRuleIds } from '../rubric-merge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => resolve(here, 'fixtures', name);
const defaultPath = fx('default.md');
const overlayPath = fx('overlay.md');
const collisionOverlayPath = fx('overlay-collision.md');
const missingOverlayPath = fx('does-not-exist.md');

describe('parseRuleIds', () => {
  it('extracts rule IDs from level-2 headings', () => {
    const md = readFileSync(defaultPath, 'utf8');
    expect(parseRuleIds(md)).toEqual(['R-CORR-001', 'R-CORR-002', 'R-SEC-001']);
  });

  it('returns empty array for empty or non-string input', () => {
    expect(parseRuleIds('')).toEqual([]);
    expect(parseRuleIds(undefined)).toEqual([]);
    expect(parseRuleIds(null)).toEqual([]);
  });

  it('ignores non-rule headings', () => {
    const md = '# Title\n\n## Not A Rule\n\n## R-CORR-001 — foo\n';
    expect(parseRuleIds(md)).toEqual(['R-CORR-001']);
  });

  it('resets internal regex state between calls (idempotent)', () => {
    const md = '## R-CORR-001 — foo\n## R-TEST-001 — bar\n';
    expect(parseRuleIds(md)).toEqual(['R-CORR-001', 'R-TEST-001']);
    expect(parseRuleIds(md)).toEqual(['R-CORR-001', 'R-TEST-001']);
  });
});

describe('mergeRubric — happy path', () => {
  it('emits Global Defaults then Project Overlay section headers', () => {
    const merged = mergeRubric({ defaultPath, overlayPath });
    expect(merged).toContain('## Global Defaults');
    expect(merged).toContain('## Project Overlay');
    expect(merged.indexOf('## Global Defaults')).toBeLessThan(
      merged.indexOf('## Project Overlay')
    );
  });

  it('includes rule bodies from both files', () => {
    const merged = mergeRubric({ defaultPath, overlayPath });
    expect(merged).toContain('R-CORR-001 — Story acceptance criteria');
    expect(merged).toContain('R-ARCH-001 — DynamoDB Multi-Table Only');
    expect(merged).toContain('R-SAFE-001');
  });

  it('strips the leading H1 title from each input file', () => {
    const merged = mergeRubric({ defaultPath, overlayPath });
    expect(merged).not.toMatch(/^#\s+Global Default Review Rubric/m);
    expect(merged).not.toMatch(/^#\s+Futurator-Admin Review Rubric/m);
  });
});

describe('mergeRubric — missing overlay', () => {
  it('prepends `// no project overlay` and returns default unchanged', () => {
    const merged = mergeRubric({ defaultPath, overlayPath: missingOverlayPath });
    expect(merged.startsWith('// no project overlay')).toBe(true);
    const originalDefault = readFileSync(defaultPath, 'utf8');
    expect(merged).toContain(originalDefault);
  });

  it('treats undefined overlayPath the same as a missing file', () => {
    const merged = mergeRubric({ defaultPath });
    expect(merged.startsWith('// no project overlay')).toBe(true);
  });
});

describe('mergeRubric — duplicate rule IDs', () => {
  it('logs a warning per collision; overlay appears after default (wins by order)', () => {
    const warn = vi.fn();
    const merged = mergeRubric(
      { defaultPath, overlayPath: collisionOverlayPath },
      { logger: { warn } }
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain('R-CORR-001');
    expect(msg).toContain('overlay wins');

    const defaultIdx = merged.indexOf('Story acceptance criteria');
    const overlayIdx = merged.indexOf('Overlay override of default correctness rule');
    expect(defaultIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(defaultIdx);
  });

  it('does not warn when no IDs collide', () => {
    const warn = vi.fn();
    mergeRubric({ defaultPath, overlayPath }, { logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('mergeRubric — errors', () => {
  it('throws when defaultPath is missing from opts', () => {
    expect(() => mergeRubric({})).toThrow(/defaultPath is required/);
  });

  it('throws when the default rubric file does not exist', () => {
    expect(() =>
      mergeRubric({ defaultPath: fx('does-not-exist-default.md') })
    ).toThrow(/default rubric not found/);
  });
});
