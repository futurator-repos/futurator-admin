import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn so we can inspect args and drive stdout/stderr/exit.
// Use vi.hoisted so the mock fn is defined before the vi.mock factory runs.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } };
});

import { cloneRepo, buildTokenizedUrl, redactToken } from '../lib/git-clone.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('redactToken', () => {
  it('masks tokenized URLs to https://***@... regardless of token', () => {
    const raw = 'cloning from https://x-access-token:ghp_secret123@github.com/foo/bar.git ok';
    expect(redactToken(raw, 'ghp_secret123')).not.toContain('ghp_secret123');
    expect(redactToken(raw, 'ghp_secret123')).toContain('https://***@github.com/foo/bar.git');
  });

  it('masks any bare occurrence of the raw token, even outside a URL', () => {
    const raw = 'curl reported ghp_secret123 in header somehow';
    expect(redactToken(raw, 'ghp_secret123')).toBe('curl reported *** in header somehow');
  });

  it('handles multiple x-access-token URLs in the same string', () => {
    const raw =
      'a https://x-access-token:tkA@github.com/x/y.git b https://x-access-token:tkB@github.com/x/z.git';
    const out = redactToken(raw, 'tkA');
    expect(out).not.toContain('tkA');
    expect(out).not.toContain('tkB');
    expect((out.match(/https:\/\/\*\*\*@/g) || []).length).toBe(2);
  });

  it('is a no-op on empty or non-string input', () => {
    expect(redactToken('', 'abc')).toBe('');
    expect(redactToken(undefined, 'abc')).toBeUndefined();
  });
});

describe('buildTokenizedUrl', () => {
  it('builds the x-access-token URL form with .git', () => {
    expect(buildTokenizedUrl('https://github.com/foo/bar', 'tk')).toBe(
      'https://x-access-token:tk@github.com/foo/bar.git',
    );
  });

  it('normalizes a .git suffix to a single .git', () => {
    expect(buildTokenizedUrl('https://github.com/foo/bar.git', 'tk')).toBe(
      'https://x-access-token:tk@github.com/foo/bar.git',
    );
  });

  it('rejects non-GitHub URLs', () => {
    expect(() => buildTokenizedUrl('https://gitlab.com/foo/bar', 'tk')).toThrow(/HTTPS GitHub URL/);
  });

  it('rejects missing inputs', () => {
    expect(() => buildTokenizedUrl('', 'tk')).toThrow(/repoUrl is required/);
    expect(() => buildTokenizedUrl('https://github.com/x/y', '')).toThrow(/token is required/);
  });
});

describe('cloneRepo', () => {
  function setupChild() {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    return child;
  }

  it('spawns git clone with the tokenized URL and resolves on exit code 0', async () => {
    const child = setupChild();
    const emit = vi.fn(async () => {});

    const promise = cloneRepo({
      repoUrl: 'https://github.com/foo/bar',
      branch: 'main',
      token: 'ghp_secret',
      targetPath: '/tmp/proj',
      depth: 50,
      ctx: { emit },
    });

    // Wait a tick so the child handlers are registered.
    await Promise.resolve();
    child.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();

    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual([
      'clone',
      '--branch',
      'main',
      '--depth',
      '50',
      'https://x-access-token:ghp_secret@github.com/foo/bar.git',
      '/tmp/proj',
    ]);
  });

  it('redacts the raw token before emitting captured stdout', async () => {
    const child = setupChild();
    const captured = [];
    const emit = vi.fn(async (stream, data) => {
      captured.push([stream, data]);
    });

    const promise = cloneRepo({
      repoUrl: 'https://github.com/foo/bar',
      branch: 'main',
      token: 'ghp_secret',
      targetPath: '/tmp/proj',
      ctx: { emit },
    });

    await Promise.resolve();
    child.stdout.emit(
      'data',
      Buffer.from('Cloning into https://x-access-token:ghp_secret@github.com/foo/bar.git\n'),
    );
    child.stderr.emit('data', Buffer.from('progress: fetching pack ghp_secret token marker\n'));
    child.emit('close', 0);
    await promise;

    for (const [, data] of captured) {
      expect(data).not.toContain('ghp_secret');
    }
    expect(
      captured.some(([stream, data]) => stream === 'stdout' && data.includes('https://***@')),
    ).toBe(true);
    expect(captured.some(([stream, data]) => stream === 'stderr' && data.includes('***'))).toBe(
      true,
    );
  });

  it('rejects with redacted message on non-zero exit code', async () => {
    const child = setupChild();
    const promise = cloneRepo({
      repoUrl: 'https://github.com/foo/bar',
      branch: 'main',
      token: 'ghp_secret',
      targetPath: '/tmp/proj',
      ctx: { emit: vi.fn() },
    });

    await Promise.resolve();
    child.stderr.emit(
      'data',
      Buffer.from(
        'fatal: could not read Username for https://x-access-token:ghp_secret@github.com/foo/bar.git\n',
      ),
    );
    child.emit('close', 128);

    await expect(promise).rejects.toThrow(/exited with code 128/);
    await expect(promise.catch((e) => e.message)).resolves.not.toContain('ghp_secret');
  });

  it('rejects when spawn itself errors', async () => {
    const child = setupChild();
    const promise = cloneRepo({
      repoUrl: 'https://github.com/foo/bar',
      branch: 'main',
      token: 'ghp_secret',
      targetPath: '/tmp/proj',
      ctx: { emit: vi.fn() },
    });
    await Promise.resolve();
    child.emit('error', new Error('ENOENT: git not found ghp_secret'));
    await expect(promise).rejects.toThrow(/failed to spawn/);
    await expect(promise.catch((e) => e.message)).resolves.not.toContain('ghp_secret');
  });

  it('does not crash when ctx.emit throws', async () => {
    const child = setupChild();
    const emit = vi.fn(async () => {
      throw new Error('downstream emit failed');
    });
    const promise = cloneRepo({
      repoUrl: 'https://github.com/foo/bar',
      branch: 'main',
      token: 'ghp_secret',
      targetPath: '/tmp/proj',
      ctx: { emit },
    });
    await Promise.resolve();
    child.stdout.emit('data', Buffer.from('Cloning into\n'));
    child.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('throws if branch or targetPath is missing', async () => {
    await expect(
      cloneRepo({ repoUrl: 'https://github.com/foo/bar', token: 'tk', targetPath: '/tmp/x' }),
    ).rejects.toThrow(/branch is required/);
    await expect(
      cloneRepo({ repoUrl: 'https://github.com/foo/bar', branch: 'main', token: 'tk' }),
    ).rejects.toThrow(/targetPath is required/);
  });
});
