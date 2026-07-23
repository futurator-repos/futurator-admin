import { describe, it, expect } from 'vitest';
import { buildPriorFailureBlock, classifyRetryable, findGateDataGaps, shouldRetry } from '../story-retry.mjs';

// ---------------------------------------------------------------------------
// Helpers — mirror the shape produced by handleStoryCompletion
// ---------------------------------------------------------------------------

const ac = (id, over = {}) => ({
  id,
  text: `${id} description`,
  testBinding: { status: 'unbound' },
  ...over,
});

const failedAc = (id, testKind = 'unit', detail = null, testRef = 'tests/foo.test.ts') => ac(id, {
  testBinding: { status: 'failing', testRef, testKind, lastRunSha: 'sha123', ...(detail ? { detail } : {}) },
});

// un-wired browser AC: no snapshot detail ⇒ the probe never ran (D-fix-2) ⇒ retryable.
const browserAc = (id) => failedAc(id, 'browser', null, 'playwright:ac-1');
// ran-and-failed browser AC: detail carries generic harness `snapshot.<field>`
// evidence ⇒ the probe DID drive the app ⇒ escalate (do NOT loop).
const ranBrowserAc = (id) =>
  failedAc(id, 'browser', 'assertSnapshot snapshot.x expected > spawn, got equal', 'playwright:ac-1');
const manualAc = (id) => ac(id, { verify: 'manual', testBinding: { status: 'bound', testKind: 'manual', testRef: 'manual:check' } });

const mkCompletion = ({ failingIds = [], acs = [], reasons = [], newState = 'failed', invariants } = {}) => ({
  newState,
  verdict: { failing: failingIds, reasons },
  acceptanceCriteria: acs,
  ...(invariants ? { invariants } : {}),
});

// ---------------------------------------------------------------------------
// buildPriorFailureBlock
// ---------------------------------------------------------------------------

describe('buildPriorFailureBlock', () => {
  it('returns a fallback string when completion has no failing detail', () => {
    const block = buildPriorFailureBlock(mkCompletion());
    expect(block).toMatch(/no failing-test detail/);
  });

  it('returns a fallback string for null input', () => {
    const block = buildPriorFailureBlock(null);
    expect(block).toMatch(/no failing-test detail/);
  });

  it('includes AC id and description in the heading', () => {
    const acs = [failedAc('ac-1', 'unit', null, 'src/__tests__/foo.test.ts')];
    const block = buildPriorFailureBlock(mkCompletion({ failingIds: ['ac-1'], acs }));
    expect(block).toContain('### ac-1');
    expect(block).toContain('ac-1 description');
  });

  it('includes testRef and testKind when binding is present', () => {
    const acs = [failedAc('ac-1', 'unit', null, 'tests/foo.test.ts -t "my test"')];
    const block = buildPriorFailureBlock(mkCompletion({ failingIds: ['ac-1'], acs }));
    expect(block).toContain('testRef');
    expect(block).toContain('tests/foo.test.ts -t "my test"');
    expect(block).toContain('testKind**: unit');
  });

  it('renders test output in a fenced code block when detail is present', () => {
    const detail = 'AssertionError: expected 1 to equal 2\n  at Object.<anonymous> (foo.test.ts:5)';
    const acs = [failedAc('ac-2', 'integration', detail)];
    const block = buildPriorFailureBlock(mkCompletion({ failingIds: ['ac-2'], acs }));
    expect(block).toContain('test output');
    expect(block).toContain('```');
    expect(block).toContain('AssertionError');
    expect(block).toContain('at Object.<anonymous>');
  });

  it('signals unbound status when no testRef is present', () => {
    const acs = [ac('ac-3')]; // unbound: no testRef
    const block = buildPriorFailureBlock(mkCompletion({ failingIds: ['ac-3'], acs }));
    expect(block).toContain('unbound');
    expect(block).toContain('<BINDING>');
  });

  it('includes gate reasons section when reasons array is non-empty', () => {
    const reasons = ['ac-1: deterministic AC not passing (status=failing)', 'ac-2: stale-sha'];
    const block = buildPriorFailureBlock(mkCompletion({ reasons }));
    expect(block).toContain('Gate reasons');
    expect(block).toContain('deterministic AC not passing');
    expect(block).toContain('stale-sha');
  });

  it('handles multiple failing ACs in one block', () => {
    const acs = [
      failedAc('ac-1', 'unit', 'FAIL 1'),
      failedAc('ac-2', 'integration', 'FAIL 2'),
    ];
    const block = buildPriorFailureBlock(mkCompletion({ failingIds: ['ac-1', 'ac-2'], acs }));
    expect(block).toContain('### ac-1');
    expect(block).toContain('### ac-2');
    expect(block).toContain('FAIL 1');
    expect(block).toContain('FAIL 2');
  });

  it('gracefully skips detail for ACs not found in the acs list', () => {
    // failingIds references an id not in acceptanceCriteria — should not throw.
    const block = buildPriorFailureBlock(mkCompletion({ failingIds: ['missing-ac'], acs: [] }));
    expect(block).toContain('### missing-ac');
    expect(block).toContain('unbound');
  });
});

// ---------------------------------------------------------------------------
// classifyRetryable
// ---------------------------------------------------------------------------

describe('classifyRetryable', () => {
  it('returns false for null completion', () => {
    expect(classifyRetryable(null)).toBe(false);
  });

  it('returns false when failing list is empty (nothing for a re-run to fix)', () => {
    expect(classifyRetryable(mkCompletion())).toBe(false);
  });

  it('returns true when all failing ACs are UN-WIRED browser (probe never ran → a respawn can mount the seam)', () => {
    const acs = [browserAc('ac-1'), browserAc('ac-2')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['ac-1', 'ac-2'], acs }))).toBe(true);
  });

  it('returns false when all failing ACs are RAN-and-failed browser (escalate, do not loop)', () => {
    const acs = [ranBrowserAc('ac-1'), ranBrowserAc('ac-2')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['ac-1', 'ac-2'], acs }))).toBe(false);
  });

  it('returns false when all failing ACs are manual kind', () => {
    const acs = [manualAc('m-1'), manualAc('m-2')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['m-1', 'm-2'], acs }))).toBe(false);
  });

  it('returns false when all failing ACs are a mix of RAN-failed browser and manual (all escalate)', () => {
    const acs = [ranBrowserAc('b-1'), manualAc('m-1')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['b-1', 'm-1'], acs }))).toBe(false);
  });

  it('returns true for a mix of UN-WIRED browser and manual (the un-wired browser can retry)', () => {
    const acs = [browserAc('b-1'), manualAc('m-1')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['b-1', 'm-1'], acs }))).toBe(true);
  });

  it('returns true when at least one failing AC is unit kind', () => {
    const acs = [browserAc('b-1'), failedAc('u-1', 'unit')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['b-1', 'u-1'], acs }))).toBe(true);
  });

  it('returns true when at least one failing AC is integration kind', () => {
    const acs = [failedAc('i-1', 'integration')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['i-1'], acs }))).toBe(true);
  });

  // A6 taxonomy (dossier): an unbound AC is a gate-DATA failure — in the split
  // model only the test-author emits <BINDING>, so respawning the IMPLEMENTER
  // can never bind it. Fail fast instead of consuming the fix-forward attempt.
  // (This deliberately supersedes the old "agent may bind it on retry" rule.)
  it('returns false when a failing AC is unbound (gate-data: nothing for an implementer respawn to satisfy)', () => {
    const acs = [ac('u-1')]; // unbound, no testKind
    expect(classifyRetryable(mkCompletion({ failingIds: ['u-1'], acs }))).toBe(false);
  });

  it('returns false when a failing AC is misbound (gate-data: rebinding is test-author work)', () => {
    const acs = [ac('m-1', { testBinding: { status: 'misbound', testRef: 't.test.ts', testKind: 'unit' } })];
    expect(classifyRetryable(mkCompletion({ failingIds: ['m-1'], acs }))).toBe(false);
  });

  it('returns false when ANY failing entry is a gate-data failure, even beside an agent-fixable one', () => {
    // Completion needs EVERY entry to pass — one unfixable data gap makes the
    // re-spawn pure waste regardless of the fixable sibling.
    const acs = [ac('u-1'), failedAc('f-1', 'unit')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['u-1', 'f-1'], acs }))).toBe(false);
  });

  it('returns false for a failing invariant with no authored validator (gate-data)', () => {
    const invariants = [{ id: 'inv-1', description: 'd', validator: { status: 'failing', detail: 'no authored validator (declared) — fail-closed' } }];
    expect(classifyRetryable(mkCompletion({ failingIds: ['inv-1'], invariants }))).toBe(false);
  });

  it('returns true for an authored-but-failing invariant (a failing bound test — agent-fixable)', () => {
    const invariants = [{ id: 'inv-1', description: 'd', validator: { ref: 'src/inv-1.invariant.test.ts', kind: 'test', status: 'failing' } }];
    expect(classifyRetryable(mkCompletion({ failingIds: ['inv-1'], invariants }))).toBe(true);
  });

  it('returns true for pseudo-entries (test-tampering / green-trunk / foundation-gate)', () => {
    for (const pseudo of ['test-tampering', 'green-trunk', 'foundation-gate']) {
      expect(classifyRetryable(mkCompletion({ failingIds: [pseudo], acs: [] }))).toBe(true);
    }
  });

  it('returns true when a failing AC has an unknown/future testKind', () => {
    const acs = [failedAc('x-1', 'e2e')]; // 'e2e' is not in the non-retryable set
    expect(classifyRetryable(mkCompletion({ failingIds: ['x-1'], acs }))).toBe(true);
  });

  it('treats verify=manual on AC itself as non-retryable', () => {
    // manualAc sets verify='manual' directly on the AC object (not just testKind)
    const acs = [manualAc('m-1')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['m-1'], acs }))).toBe(false);
  });

  it('returns false when failing ids reference ACs not in acs list (unknown AC → unresolvable)', () => {
    // AC not found → treated as a pseudo-entry (not a data gap, kind unknown →
    // not in NON_RETRYABLE_KINDS) → retryable. Intentional: unknown = try again.
    expect(classifyRetryable(mkCompletion({ failingIds: ['ghost'], acs: [] }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findGateDataGaps (A6)
// ---------------------------------------------------------------------------

describe('findGateDataGaps', () => {
  it('returns [] for null / no failing entries', () => {
    expect(findGateDataGaps(null)).toEqual([]);
    expect(findGateDataGaps(mkCompletion())).toEqual([]);
  });

  it('names an unbound AC by id', () => {
    const gaps = findGateDataGaps(mkCompletion({ failingIds: ['u-1'], acs: [ac('u-1')] }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/^u-1: /);
    expect(gaps[0]).toMatch(/unbound/);
  });

  it('names a misbound AC with its binding detail', () => {
    const acs = [ac('m-1', { testBinding: { status: 'misbound', testRef: 't.test.ts', testKind: 'unit', detail: 'mocks in-repo module' } })];
    const gaps = findGateDataGaps(mkCompletion({ failingIds: ['m-1'], acs }));
    expect(gaps[0]).toMatch(/^m-1: /);
    expect(gaps[0]).toMatch(/misbound/);
    expect(gaps[0]).toMatch(/mocks in-repo module/);
  });

  it('names an unauthored invariant; skips authored-but-failing ones', () => {
    const invariants = [
      { id: 'inv-a', description: 'd', validator: { status: 'failing' } }, // no ref → gap
      { id: 'inv-b', description: 'd', validator: { ref: 'src/inv-b.invariant.test.ts', status: 'failing' } }, // authored → fixable
    ];
    const gaps = findGateDataGaps(mkCompletion({ failingIds: ['inv-a', 'inv-b'], invariants }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/^inv-a: /);
    expect(gaps[0]).toMatch(/no authored validator/);
  });

  it('ignores pseudo-entries and passing/bound failing ACs', () => {
    const acs = [failedAc('f-1', 'unit')];
    const gaps = findGateDataGaps(mkCompletion({ failingIds: ['f-1', 'green-trunk', 'test-tampering'], acs }));
    expect(gaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shouldRetry
// ---------------------------------------------------------------------------

describe('shouldRetry', () => {
  const retryableCompletion = mkCompletion({
    failingIds: ['ac-1'],
    acs: [failedAc('ac-1', 'unit')],
  });

  it('returns false for null completion', () => {
    expect(shouldRetry(null, 1, 3)).toBe(false);
  });

  it('returns false when newState is not "failed"', () => {
    const done = { ...retryableCompletion, newState: 'done' };
    expect(shouldRetry(done, 1, 3)).toBe(false);
  });

  it('returns false when attempt equals maxAttempts (exhausted)', () => {
    expect(shouldRetry(retryableCompletion, 3, 3)).toBe(false);
  });

  it('returns false when attempt exceeds maxAttempts', () => {
    expect(shouldRetry(retryableCompletion, 4, 3)).toBe(false);
  });

  it('returns false when classifyRetryable returns false (ran-failed browser / manual ACs)', () => {
    const nonRetryable = mkCompletion({
      failingIds: ['b-1'],
      acs: [ranBrowserAc('b-1')],
    });
    expect(shouldRetry(nonRetryable, 1, 3)).toBe(false);
  });

  it('returns true when failed + attempt < maxAttempts + retryable', () => {
    expect(shouldRetry(retryableCompletion, 1, 3)).toBe(true);
  });

  it('returns true at attempt=1 of maxAttempts=2 (last allowed retry)', () => {
    expect(shouldRetry(retryableCompletion, 1, 2)).toBe(true);
  });

  it('returns false at attempt=2 of maxAttempts=2 (threshold reached)', () => {
    expect(shouldRetry(retryableCompletion, 2, 2)).toBe(false);
  });
});
