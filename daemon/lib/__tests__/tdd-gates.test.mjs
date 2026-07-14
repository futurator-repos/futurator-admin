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
  it('ok when every bound test failed before implementation (all-RED)', () => {
    const r = assertRedFirst({ ran: 3, passed: 0, failed: 3 });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/3\/3 bound test\(s\) RED/);
  });

  it('B2 (Incident F): ok when SOME already pass but at least one is RED', () => {
    // An integration/skeleton story: 2 ACs already satisfied by the live
    // foundation, 1 genuinely RED — real new work, not a tautology → accept.
    const r = assertRedFirst({ ran: 3, passed: 2, failed: 1 });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/1\/3 bound test\(s\) RED/);
    expect(r.reason).toMatch(/2 already satisfied by a dependency/);
  });

  it('B2: rejects when ALL bound tests already pass (nothing to implement)', () => {
    const r = assertRedFirst({ ran: 3, passed: 3, failed: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nothing to implement/);
    expect(r.reason).toMatch(/already pass before implementation/);
  });

  it('F3: an ERRORED binding is a BINDING FAULT, not a valid RED (surfaced loudly)', () => {
    // a binding that could not be executed proves nothing — even though it "failed"
    const r = assertRedFirst({ ran: 1, passed: 0, failed: 1, errored: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/binding fault/);
    expect(r.reason).toMatch(/not a valid RED/);
  });

  it('F3: errored is checked FIRST — a fault blocks even when the run tallies look RED', () => {
    const r = assertRedFirst({ ran: 3, passed: 0, failed: 3, errored: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/binding fault/);
  });

  it('a genuine ran-and-failed RED (errored:0) stays a valid RED', () => {
    const r = assertRedFirst({ ran: 3, passed: 0, failed: 3, errored: 0 });
    expect(r.ok).toBe(true);
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
