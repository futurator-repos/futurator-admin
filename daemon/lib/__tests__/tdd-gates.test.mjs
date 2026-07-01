import { describe, it, expect } from 'vitest';
import { detectTestTampering, assertRedFirst } from '../tdd-gates.mjs';

describe('detectTestTampering', () => {
  const owned = ['src/foo.test.ts', 'src/bar.test.ts'];

  it('ok when the implementer touched only source files', () => {
    const r = detectTestTampering(owned, ['src/foo.ts', 'src/bar.ts']);
    expect(r.ok).toBe(true);
    expect(r.tampered).toEqual([]);
  });

  it('flags an owned test file the implementer edited', () => {
    const r = detectTestTampering(owned, ['src/foo.ts', 'src/foo.test.ts']);
    expect(r.ok).toBe(false);
    expect(r.tampered).toEqual(['src/foo.test.ts']);
  });

  it('allows brand-new test files (not in the owned baseline)', () => {
    const r = detectTestTampering(owned, ['src/new.test.ts']);
    expect(r.ok).toBe(true);
  });

  it('normalizes ./ and duplicate slashes before comparing', () => {
    const r = detectTestTampering(['./src/foo.test.ts'], ['src//foo.test.ts']);
    expect(r.tampered).toEqual(['src/foo.test.ts']);
  });

  it('is deterministic (sorted) and dedupes', () => {
    const r = detectTestTampering(owned, ['src/bar.test.ts', 'src/foo.test.ts']);
    expect(r.tampered).toEqual(['src/bar.test.ts', 'src/foo.test.ts']);
  });
});

describe('assertRedFirst', () => {
  it('ok when every bound test failed before implementation', () => {
    const r = assertRedFirst({ ran: 3, passed: 0, failed: 3 });
    expect(r.ok).toBe(true);
  });

  it('rejects when a test passed before implementation (tautology)', () => {
    const r = assertRedFirst({ ran: 3, passed: 1, failed: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/passed before implementation/);
  });

  it('rejects when no bound tests ran at all', () => {
    const r = assertRedFirst({ ran: 0, passed: 0, failed: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no bound tests ran/);
  });

  it('tolerates a missing/partial summary', () => {
    expect(assertRedFirst().ok).toBe(false);
    expect(assertRedFirst({ failed: 2 }).ok).toBe(false); // ran defaulted to 0
  });
});
