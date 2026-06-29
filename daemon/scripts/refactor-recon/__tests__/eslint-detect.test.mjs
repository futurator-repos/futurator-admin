/**
 * eslint-detect.test.mjs — locks the eslint summarizer's weighting (code > tests
 * > warnings), so the maturity axis floats on production-code lint health.
 */

import { describe, it, expect } from 'vitest';
import { summarizeEslint } from '../eslint-detect.mjs';

describe('summarizeEslint', () => {
  it('counts errors/warnings and excludes node_modules', () => {
    const r = summarizeEslint([
      { filePath: '/repo/src/a.ts', errorCount: 3, warningCount: 2 },
      { filePath: '/repo/node_modules/x/y.js', errorCount: 99, warningCount: 99 },
      { filePath: '/repo/src/b.ts', errorCount: 0, warningCount: 0 },
    ]);
    expect(r.errors).toBe(3);
    expect(r.warnings).toBe(2);
    expect(r.filesWithIssues).toBe(1); // b.ts (clean) + node_modules excluded
    expect(r.runnable).toBe(true);
  });

  it('weights test-file errors lower than code errors', () => {
    const code = summarizeEslint([{ filePath: '/r/src/x.ts', errorCount: 10, warningCount: 0 }]);
    const test = summarizeEslint([{ filePath: '/r/src/x.test.ts', errorCount: 10, warningCount: 0 }]);
    expect(test.weighted).toBeLessThan(code.weighted); // 0.3×10=3 < 10
    expect(code.weighted).toBe(10);
    expect(test.weighted).toBe(3);
  });

  it('separates code vs test error counts', () => {
    const r = summarizeEslint([
      { filePath: '/r/src/a.ts', errorCount: 5, warningCount: 0 },
      { filePath: '/r/src/a.test.ts', errorCount: 4, warningCount: 0 },
    ]);
    expect(r.codeErrors).toBe(5);
    expect(r.testErrors).toBe(4);
  });
});
