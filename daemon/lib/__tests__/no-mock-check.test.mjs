import { describe, it, expect } from 'vitest';
import { detectInRepoMock } from '../no-mock-check.mjs';

describe('detectInRepoMock', () => {
  it('flags a relative in-repo mock', () => {
    const r = detectInRepoMock(`vi.mock('./levels');\nimport x from './levels';`);
    expect(r.violation).toBe(true);
    expect(r.hits).toEqual(['./levels']);
  });

  it('flags @/ and ~/ repo-alias mocks', () => {
    expect(detectInRepoMock(`vi.mock('@/game/state')`).violation).toBe(true);
    expect(detectInRepoMock(`vi.mock('~/lib/util')`).violation).toBe(true);
    expect(detectInRepoMock(`vi.mock('@/game/state')`).hits).toEqual(['@/game/state']);
  });

  it('flags jest.mock the same way', () => {
    expect(detectInRepoMock(`jest.mock('../store')`).violation).toBe(true);
    expect(detectInRepoMock(`jest.mock('../store')`).hits).toEqual(['../store']);
  });

  it('is clean for bare external packages and node builtins', () => {
    expect(detectInRepoMock(`vi.mock('react')`).violation).toBe(false);
    expect(detectInRepoMock(`vi.mock('node:fs')`).violation).toBe(false);
    expect(detectInRepoMock(`vi.mock('@scope/pkg')`).violation).toBe(false);
    expect(detectInRepoMock(`jest.mock('lodash')`).violation).toBe(false);
  });

  it('collects multiple distinct in-repo hits, dedup', () => {
    const src = `vi.mock('./a')\nvi.mock('./b')\nvi.mock('./a')\nvi.mock('react')`;
    const r = detectInRepoMock(src);
    expect(r.hits).toEqual(['./a', './b']);
  });

  it('handles double and backtick quotes', () => {
    expect(detectInRepoMock(`vi.mock("./x")`).hits).toEqual(['./x']);
    expect(detectInRepoMock('vi.mock(`./y`)').hits).toEqual(['./y']);
  });

  it('tolerates whitespace between mock and paren', () => {
    expect(detectInRepoMock(`vi . mock ( './z' )`).violation).toBe(false); // "vi . mock" is not vi.mock
    expect(detectInRepoMock(`vi.mock (  './z' )`).violation).toBe(true);
  });

  it('non-string input is clean', () => {
    expect(detectInRepoMock(undefined)).toEqual({ violation: false, hits: [] });
    expect(detectInRepoMock(null)).toEqual({ violation: false, hits: [] });
    expect(detectInRepoMock(42)).toEqual({ violation: false, hits: [] });
  });
});
