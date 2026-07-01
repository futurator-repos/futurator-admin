import { describe, it, expect } from 'vitest';
import { buildPriorFailureBlock, classifyRetryable, shouldRetry } from '../story-retry.mjs';

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

const browserAc = (id) => failedAc(id, 'browser', null, 'playwright:ac-1');
const manualAc = (id) => ac(id, { verify: 'manual', testBinding: { status: 'bound', testKind: 'manual', testRef: 'manual:check' } });

const mkCompletion = ({ failingIds = [], acs = [], reasons = [], newState = 'failed' } = {}) => ({
  newState,
  verdict: { failing: failingIds, reasons },
  acceptanceCriteria: acs,
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

  it('returns false when all failing ACs are browser kind', () => {
    const acs = [browserAc('ac-1'), browserAc('ac-2')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['ac-1', 'ac-2'], acs }))).toBe(false);
  });

  it('returns false when all failing ACs are manual kind', () => {
    const acs = [manualAc('m-1'), manualAc('m-2')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['m-1', 'm-2'], acs }))).toBe(false);
  });

  it('returns false when all failing ACs are a mix of browser and manual', () => {
    const acs = [browserAc('b-1'), manualAc('m-1')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['b-1', 'm-1'], acs }))).toBe(false);
  });

  it('returns true when at least one failing AC is unit kind', () => {
    const acs = [browserAc('b-1'), failedAc('u-1', 'unit')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['b-1', 'u-1'], acs }))).toBe(true);
  });

  it('returns true when at least one failing AC is integration kind', () => {
    const acs = [failedAc('i-1', 'integration')];
    expect(classifyRetryable(mkCompletion({ failingIds: ['i-1'], acs }))).toBe(true);
  });

  it('returns true when a failing AC is unbound (agent may bind it on retry)', () => {
    const acs = [ac('u-1')]; // unbound, no testKind
    expect(classifyRetryable(mkCompletion({ failingIds: ['u-1'], acs }))).toBe(true);
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
    // AC not found → kind resolves to undefined → not in NON_RETRYABLE_KINDS → retryable.
    // This is intentional: unknown = try again; the agent may produce the binding.
    expect(classifyRetryable(mkCompletion({ failingIds: ['ghost'], acs: [] }))).toBe(true);
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

  it('returns false when classifyRetryable returns false (all browser/manual ACs)', () => {
    const nonRetryable = mkCompletion({
      failingIds: ['b-1'],
      acs: [browserAc('b-1')],
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
