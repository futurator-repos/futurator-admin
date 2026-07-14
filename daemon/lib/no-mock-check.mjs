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
//
// Incident D (pacman3, 2026-07-14): the STRICT form above is correct for the
// invariant-validator gate (an invariant asserting real foundation data must
// never mock in-repo), but it is TOO BROAD for a state-AC's own unit test. The
// rule's INTENT is to forbid self-validation — mocking the MODULE UNDER TEST
// (foo.test.ts mocking foo.ts → circular). It WRONGLY rejected the universal,
// legitimate practice of mocking a DEPENDENCY to build a fixture: every batch-1
// system story (collisions/ghosts/pacman/progression) tests its OWN system and
// vi.mock('../maze') ONLY to inject small spawn-point fixtures — ../maze is the
// FOUNDATION's already-verified data module (a dependency), so the mock is
// legitimate isolation. All four were misbound → assemble blocked → app crashed.
//
// FIX: an OPTIONAL scope arg { testFilePath, underTest } narrows the check to
// flag ONLY a mock whose spec resolves to the module under test — the test
// file's sibling implementation OR a path in the story's `touches`. Mocking a
// dependency (esp. another story's frozen foundation module) is legitimate and
// PASSES. When NO scope is given the detector stays STRICT (back-compat; keeps
// the invariant gate strict). Narrowing must NOT open a self-validation hole:
// mocking the module under test is STILL a violation.

import { posix } from 'node:path';
import { globsIntersect } from '../pipelines/lib/glob-intersect.mjs';

// Capture the module spec inside vi.mock(...) / jest.mock(...) — single, double,
// or backtick quoted. Non-greedy up to the matching quote.
const MOCK_RE = /\b(?:vi|jest)\.mock\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

// Language extensions and the .test/.spec suffix are stripped for an
// extension-insensitive module-identity compare (a spec './x', './x.ts',
// './x.test.ts' all denote the same module id 'x').
const LANG_EXT_RE = /\.(tsx?|jsx?|mts|cts)$/i;
const TEST_SUFFIX_RE = /\.(test|spec)$/i;

/** Is a module spec IN-REPO (relative or repo-alias) vs an external package? */
function isInRepoSpec(spec) {
  return spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/');
}

/** Normalize path separators; a bare posix path passes through untouched. */
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Reduce a repo-relative path to its MODULE IDENTITY: drop a leading './', a
 * language extension (.ts/.tsx/.js/.jsx/.mts/.cts), and a trailing .test/.spec
 * suffix. So both sides of the under-test compare are extension-insensitive:
 * 'src/game/systems/collisions.test.ts' and './collisions' both → the id
 * 'src/game/systems/collisions'. PURE.
 */
function toModuleId(p) {
  let s = toPosix(p).replace(/^\.\//, '');
  s = s.replace(LANG_EXT_RE, '');
  s = s.replace(TEST_SUFFIX_RE, '');
  return s;
}

/**
 * Resolve a `vi.mock`/`jest.mock` module spec to a repo-relative module id,
 * relative to the test file that contains it. PURE + exported so the resolution
 * is unit-testable independent of the detector.
 *   - relative ('./x', '../x') → resolved against dirname(testFilePath)
 *   - alias    ('@/x', '~/x')  → 'src/x'
 *   - bare package             → null (external, never a self-mock)
 * The result is extension-insensitive (module id, no .ts/.test).
 * Examples (testFilePath = 'src/game/systems/collisions.test.ts'):
 *   '../maze'        → 'src/game/maze'
 *   './collisions'   → 'src/game/systems/collisions'
 *   '@/game/maze'    → 'src/game/maze'
 *
 * @param {string} spec
 * @param {string} [testFilePath]  repo-relative path of the test file
 * @returns {string|null}
 */
export function resolveMockSpec(spec, testFilePath) {
  if (typeof spec !== 'string' || !spec) return null;
  let repoRel;
  if (spec.startsWith('@/') || spec.startsWith('~/')) {
    repoRel = `src/${spec.slice(2)}`;
  } else if (spec.startsWith('.')) {
    // relative spec resolves against the test file's directory
    const dir = testFilePath ? posix.dirname(toPosix(testFilePath)) : '.';
    repoRel = posix.normalize(posix.join(dir, spec));
  } else {
    return null; // bare package — not in-repo
  }
  return toModuleId(repoRel);
}

/**
 * Detect in-repo `vi.mock`/`jest.mock` calls in test source text. PURE.
 *
 * @param {string} sourceText
 * @param {{ testFilePath?: string, underTest?: string[] }} [opts]
 *   When ABSENT (or with neither testFilePath nor a non-empty underTest) the
 *   detector is STRICT — every in-repo mock is a violation (back-compat; the
 *   invariant-validator gate relies on this). When a scope is given it is
 *   NARROW — a mock is a violation ONLY if its spec resolves to the module
 *   under test: the test file's sibling implementation (testFilePath minus
 *   .test/.spec) OR any path in underTest (the story's `touches`, repo-relative,
 *   extension-insensitive). Mocking a dependency then PASSES.
 * @returns {{ violation: boolean, hits: string[] }} hits are the offending specs
 */
export function detectInRepoMock(sourceText, opts) {
  if (typeof sourceText !== 'string') return { violation: false, hits: [] };

  const testFilePath = opts && typeof opts.testFilePath === 'string' ? opts.testFilePath : '';
  const underTest = opts && Array.isArray(opts.underTest) ? opts.underTest : [];
  // NARROW mode is engaged only when we actually have a scope to compare against
  // — a bare `{}` / `{ underTest: [] }` with no testFilePath falls back to the
  // STRICT check (fail-safe toward the self-validation invariant, never a hole).
  const narrow = Boolean(testFilePath) || underTest.length > 0;

  // Precompute the module ids that count as "under test" for narrow mode: the
  // bound test file's sibling implementation plus every `touches` entry, each
  // reduced to an extension-insensitive module id.
  //
  // Incident D review: a `touches` entry MAY be a GLOB — the planner is
  // explicitly allowed to emit patterns like 'src/game/systems/*.ts'
  // (quick-planspec / touch-point-inference). toModuleId only strips the
  // extension, so a glob stays a glob ('src/game/systems/*'); an exact
  // Set-membership test (`targets.has(resolved)`) could NEVER match a concrete
  // resolved mock id ('src/game/systems/collisions') against it → the
  // "OR a path in touches" half of the rule was silently disabled for
  // glob-touched stories, reopening a self-validation hole (a test could mock
  // the very glob-declared module it exercises and still pass). So match glob
  // entries with globsIntersect against the resolved concrete id; concrete
  // entries still compare by equality (globsIntersect reduces to === for two
  // wildcard-free paths). This errs STRICT — globsIntersect leans to false
  // positives, which for a no-mock gate means at worst a spurious misbound,
  // never a false green.
  const targets = narrow
    ? [
        ...(testFilePath ? [toModuleId(testFilePath)] : []),
        ...underTest.map((t) => toModuleId(t)),
      ]
    : null;

  // A resolved concrete mock id is "under test" if it equals a concrete target
  // or is matched by a glob target. (A concrete path never contains '*', so the
  // wildcard check is a safe discriminator between the two forms.)
  const isUnderTest = (resolved) =>
    targets.some((t) => (t.includes('*') ? globsIntersect(resolved, t) : t === resolved));

  const hits = [];
  MOCK_RE.lastIndex = 0;
  let m;
  while ((m = MOCK_RE.exec(sourceText)) !== null) {
    const spec = m[2];
    if (!isInRepoSpec(spec)) continue; // external package — always clean
    if (!narrow) {
      // STRICT: any in-repo mock is a violation.
      if (!hits.includes(spec)) hits.push(spec);
      continue;
    }
    // NARROW: only a mock resolving to the module UNDER TEST is a violation.
    const resolved = resolveMockSpec(spec, testFilePath);
    if (resolved != null && isUnderTest(resolved) && !hits.includes(spec)) {
      hits.push(spec);
    }
  }
  return { violation: hits.length > 0, hits };
}
