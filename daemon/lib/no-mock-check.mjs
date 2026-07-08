// no-mock-check — the shared in-repo-mock detector (redesign Part 3 §1, Part 4).
//
// A gate may only consume evidence produced by executing the REAL artifact.
// A test that mocks the very in-repo module it claims to verify is a self-report,
// not reality. This one detector backs both the Spine no-mock rule (state ACs in
// test-binding-runner) and the invariant-validator gate — ONE implementation.
//
// Rule: flag `vi.mock('<spec>')` / `jest.mock('<spec>')` where <spec> is an
// IN-REPO module — a spec that starts with '.', '@/', or '~/'. Bare package
// names ('react', 'node:fs', '@scope/pkg') are external and clean.

// Capture the module spec inside vi.mock(...) / jest.mock(...) — single, double,
// or backtick quoted. Non-greedy up to the matching quote.
const MOCK_RE = /\b(?:vi|jest)\.mock\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

/** Is a module spec IN-REPO (relative or repo-alias) vs an external package? */
function isInRepoSpec(spec) {
  return spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/');
}

/**
 * Detect in-repo `vi.mock`/`jest.mock` calls in test source text. PURE.
 *
 * @param {string} sourceText
 * @returns {{ violation: boolean, hits: string[] }} hits are the offending specs
 */
export function detectInRepoMock(sourceText) {
  if (typeof sourceText !== 'string') return { violation: false, hits: [] };
  const hits = [];
  MOCK_RE.lastIndex = 0;
  let m;
  while ((m = MOCK_RE.exec(sourceText)) !== null) {
    const spec = m[2];
    if (isInRepoSpec(spec) && !hits.includes(spec)) hits.push(spec);
  }
  return { violation: hits.length > 0, hits };
}
