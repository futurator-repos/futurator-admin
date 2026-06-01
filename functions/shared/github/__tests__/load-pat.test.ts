import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runWithPat, loadPat } from '../load-pat';

describe('loadPat + runWithPat (per-request PAT override)', () => {
  const prev = process.env.GITHUB_PAT;
  beforeEach(() => {
    process.env.GITHUB_PAT = 'default-futurator-repos-pat';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.GITHUB_PAT;
    else process.env.GITHUB_PAT = prev;
  });

  it('returns the default PAT outside any override scope', () => {
    expect(loadPat()).toBe('default-futurator-repos-pat');
  });

  it('returns the override PAT inside runWithPat (brownfield, any org)', () => {
    const got = runWithPat('brownfield-get-really-real-pat', () => loadPat());
    expect(got).toBe('brownfield-get-really-real-pat');
  });

  it('the override is scoped — reverts to default after runWithPat returns', () => {
    runWithPat('brownfield-pat', () => loadPat());
    expect(loadPat()).toBe('default-futurator-repos-pat');
  });

  it('propagates the override across awaits inside the scope', async () => {
    const got = await runWithPat('brownfield-pat', async () => {
      await Promise.resolve();
      return loadPat();
    });
    expect(got).toBe('brownfield-pat');
  });
});
