import { describe, it, expect } from 'vitest';
import { buildInjection, claudeCodeAppendArgs, buildSubagentInjectionArgs } from '../subagent-start.mjs';
import { resolveMode, getLazyInstructions, lazyArgs } from '../inject-lazy.mjs';

/** Phase 1B — ponytail laziness + the single-source SubagentStart seam. */

describe('inject-lazy (promoted spike)', () => {
  it('resolves unknown/off to full; known modes pass through', () => {
    expect(resolveMode('')).toBe('full');
    expect(resolveMode('off')).toBe('full'); // off is not a lazy intensity; full is the safe default
    expect(resolveMode('ULTRA')).toBe('ultra');
    expect(resolveMode('lite')).toBe('lite');
  });
  it('getLazyInstructions embeds the level + the skill body', () => {
    const text = getLazyInstructions('lite');
    expect(text).toMatch(/level: lite/);
    expect(text).toMatch(/minimum code to pass/i);
  });
  it('lazyArgs returns an append-system-prompt pair', () => {
    const a = lazyArgs('full');
    expect(a[0]).toBe('--append-system-prompt');
    expect(a[1]).toMatch(/LAZY DEV MODE/);
  });
});

describe('buildInjection (single source)', () => {
  it('is empty when nothing is active', () => {
    expect(buildInjection({})).toBe('');
    expect(buildInjection({ p3Flags: { P3_LAZY_MODE: 'off' } })).toBe('');
  });
  it('includes laziness when P3_LAZY_MODE is on', () => {
    const text = buildInjection({ p3Flags: { P3_LAZY_MODE: 'full' } });
    expect(text).toMatch(/LAZY DEV MODE ACTIVE/);
  });
  it('composes laziness + facts + instincts with separators', () => {
    const text = buildInjection({
      p3Flags: { P3_LAZY_MODE: 'lite' },
      facts: 'touched: src/a.ts\nAC: a1 must pass',
      instincts: ['never edit generated files', 'prefer existing helper'],
    });
    expect(text).toMatch(/LAZY DEV MODE/);
    expect(text).toMatch(/STORY FACTS/);
    expect(text).toMatch(/touched: src\/a\.ts/);
    expect(text).toMatch(/ACTIVE INSTINCTS/);
    expect(text).toMatch(/never edit generated files/);
    expect(text.split('---').length).toBeGreaterThanOrEqual(3);
  });
});

describe('adapters', () => {
  it('claudeCodeAppendArgs is [] when injection is empty, pair otherwise', () => {
    expect(claudeCodeAppendArgs('')).toEqual([]);
    expect(claudeCodeAppendArgs('hello')).toEqual(['--append-system-prompt', 'hello']);
  });
  it('claudeCodeAppendArgs accepts an opts object and builds from it', () => {
    expect(claudeCodeAppendArgs({ p3Flags: { P3_LAZY_MODE: 'off' } })).toEqual([]);
    const a = claudeCodeAppendArgs({ p3Flags: { P3_LAZY_MODE: 'full' } });
    expect(a[0]).toBe('--append-system-prompt');
  });
  it('buildSubagentInjectionArgs: off → [], on → append pair', () => {
    expect(buildSubagentInjectionArgs({ p3Flags: { P3_LAZY_MODE: 'off' } })).toEqual([]);
    expect(buildSubagentInjectionArgs({})).toEqual([]);
    expect(buildSubagentInjectionArgs({ p3Flags: { P3_LAZY_MODE: 'ultra' } })[0]).toBe('--append-system-prompt');
  });
});
