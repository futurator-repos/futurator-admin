import { describe, it, expect } from 'vitest';
import { redactToken } from '../lib/migrate-brownfield/redact.mjs';

describe('redact (runner re-export of daemon helper)', () => {
  it('redacts tokenized URLs to https://***@', () => {
    const raw = 'cloning https://x-access-token:ghp_secret@github.com/foo/bar.git ok';
    const out = redactToken(raw, 'ghp_secret');
    expect(out).not.toContain('ghp_secret');
    expect(out).toContain('https://***@github.com/foo/bar.git');
  });

  it('masks bare occurrences of the raw token', () => {
    const out = redactToken('header reported ghp_secret in trace', 'ghp_secret');
    expect(out).toBe('header reported *** in trace');
  });

  it('is a no-op on empty strings', () => {
    expect(redactToken('', 'ghp_secret')).toBe('');
  });
});
