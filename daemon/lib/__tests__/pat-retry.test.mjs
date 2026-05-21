import { describe, it, expect, vi } from 'vitest';

import { isPatAuthError, createPatRetry } from '../pat-retry.mjs';

/**
 * Story 19.6 tests for `pat-retry.mjs` — the `isPatAuthError` heuristic
 * + the `createPatRetry` factory's retry-once-on-auth-fail semantics.
 */

describe('isPatAuthError', () => {
  it('returns false for falsy input', () => {
    expect(isPatAuthError(null)).toBe(false);
    expect(isPatAuthError(undefined)).toBe(false);
    expect(isPatAuthError('')).toBe(false);
  });

  it('returns true for status 401 or 403', () => {
    expect(isPatAuthError({ status: 401, message: 'unauth' })).toBe(true);
    expect(isPatAuthError({ status: 403, message: 'forbidden' })).toBe(true);
  });

  it('matches GitHub auth-error message bodies', () => {
    expect(isPatAuthError(new Error('Bad credentials'))).toBe(true);
    expect(isPatAuthError(new Error('Personal access token has expired'))).toBe(true);
    expect(isPatAuthError(new Error('remote: Authentication failed for https://github.com/x/y'))).toBe(
      true,
    );
    expect(isPatAuthError(new Error('Permission to org/repo denied to user'))).toBe(true);
    expect(isPatAuthError(new Error('Invalid username or token. Authentication failed.'))).toBe(true);
  });

  it('matches HTTP 401/403 token in plain-text error messages', () => {
    expect(isPatAuthError(new Error('git push failed: HTTP 401'))).toBe(true);
    expect(isPatAuthError(new Error('curl: (22) The requested URL returned error: 403'))).toBe(true);
  });

  it('returns false for non-auth errors (network blip, conflict, etc.)', () => {
    expect(isPatAuthError(new Error('ECONNRESET'))).toBe(false);
    expect(isPatAuthError(new Error('Updates were rejected because the tip of your current branch is behind'))).toBe(
      false,
    );
    expect(isPatAuthError(new Error('error: failed to push some refs'))).toBe(false);
    expect(isPatAuthError(new Error('502 Bad Gateway'))).toBe(false);
  });

  it('accepts string-only error inputs', () => {
    expect(isPatAuthError('Bad credentials')).toBe(true);
    expect(isPatAuthError('random message')).toBe(false);
  });
});

describe('createPatRetry — factory contract', () => {
  it('throws on missing loadPat', () => {
    expect(() => createPatRetry({})).toThrow(/loadPat/);
  });
});

describe('createPatRetry → withPatRetry — happy path', () => {
  it('passes the loaded PAT to the operation and returns its result without refreshing', async () => {
    const loadPat = vi.fn(async (name, opts) => {
      if (opts?.forceRefresh) return 'NEVER-REACHED';
      return 'pat-cached';
    });
    const operation = vi.fn(async (pat) => `did-thing-with:${pat}`);
    const withPatRetry = createPatRetry({ loadPat });

    const result = await withPatRetry('futurator/brownfield-pat/applicator', operation);

    expect(result).toBe('did-thing-with:pat-cached');
    expect(loadPat).toHaveBeenCalledTimes(1);
    expect(loadPat).toHaveBeenCalledWith('futurator/brownfield-pat/applicator');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith('pat-cached');
  });
});

describe('createPatRetry → withPatRetry — auth failure path', () => {
  it('force-refreshes and retries exactly once on a GitHub auth error', async () => {
    let callCount = 0;
    const loadPat = vi.fn(async (_name, opts) => {
      if (opts?.forceRefresh) return 'pat-new';
      return 'pat-stale';
    });
    const operation = vi.fn(async (pat) => {
      callCount += 1;
      if (pat === 'pat-stale') {
        const err = new Error('Bad credentials');
        throw err;
      }
      return `pushed-with:${pat}`;
    });
    const logger = { info: vi.fn() };
    const withPatRetry = createPatRetry({ loadPat, logger });

    const result = await withPatRetry('futurator/brownfield-pat/applicator', operation);

    expect(result).toBe('pushed-with:pat-new');
    expect(callCount).toBe(2);
    expect(loadPat).toHaveBeenNthCalledWith(1, 'futurator/brownfield-pat/applicator');
    expect(loadPat).toHaveBeenNthCalledWith(2, 'futurator/brownfield-pat/applicator', {
      forceRefresh: true,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('force-refreshing PAT'));
  });

  it('throws original error after second auth failure (no infinite retry)', async () => {
    const loadPat = vi.fn(async (_name, opts) => {
      if (opts?.forceRefresh) return 'pat-still-bad';
      return 'pat-also-bad';
    });
    const operation = vi.fn(async () => {
      throw new Error('Bad credentials');
    });
    const withPatRetry = createPatRetry({ loadPat });

    await expect(
      withPatRetry('futurator/brownfield-pat/applicator', operation),
    ).rejects.toThrow(/Bad credentials/);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('throws original error when force-refresh returns the same token (rotation never happened)', async () => {
    const loadPat = vi.fn(async () => 'pat-same');
    const operation = vi.fn(async () => {
      throw new Error('Bad credentials');
    });
    const withPatRetry = createPatRetry({ loadPat });

    await expect(
      withPatRetry('futurator/brownfield-pat/applicator', operation),
    ).rejects.toThrow(/Bad credentials/);
    // Only one operation attempt — refresh returned the same token, so we
    // don't even bother retrying.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('throws original error when force-refresh returns null', async () => {
    const loadPat = vi.fn(async (_name, opts) => (opts?.forceRefresh ? null : 'pat'));
    const operation = vi.fn(async () => {
      throw new Error('Bad credentials');
    });
    const withPatRetry = createPatRetry({ loadPat });

    await expect(
      withPatRetry('futurator/brownfield-pat/applicator', operation),
    ).rejects.toThrow(/Bad credentials/);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('createPatRetry → withPatRetry — non-auth errors propagate immediately', () => {
  it('does not retry on a network-level error', async () => {
    const loadPat = vi.fn(async () => 'pat-cached');
    const operation = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const withPatRetry = createPatRetry({ loadPat });

    await expect(
      withPatRetry('futurator/brownfield-pat/applicator', operation),
    ).rejects.toThrow(/ECONNRESET/);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(loadPat).toHaveBeenCalledTimes(1); // no forceRefresh follow-up
  });

  it('throws clear "no token available" when loadPat returns null on first call', async () => {
    const loadPat = vi.fn(async () => null);
    const operation = vi.fn();
    const withPatRetry = createPatRetry({ loadPat });

    await expect(
      withPatRetry('futurator/brownfield-pat/applicator', operation),
    ).rejects.toThrow(/no token available/);
    expect(operation).not.toHaveBeenCalled();
  });
});
