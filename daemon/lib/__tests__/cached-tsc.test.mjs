import { describe, it, expect, beforeEach } from 'vitest';
import { runCachedTypecheck } from '../cached-tsc.mjs';

// Build an in-memory fake fs that satisfies the module's contract.
function makeFakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  return {
    files,
    api: {
      readFile: async (p) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p);
      },
      writeFile: async (p, content) => {
        files.set(p, String(content));
      },
      mkdir: async () => {},
      exists: async (p) => files.has(p),
    },
  };
}

function makeFakeShell({ output = 'OK', shouldFail = false, gitSha = 'abc123' } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      execSync: (cmd) => {
        calls.push(cmd);
        if (shouldFail) {
          const err = new Error('tsc failed');
          err.stdout = output;
          err.stderr = '';
          throw err;
        }
        return output;
      },
      gitSha: () => gitSha,
    },
  };
}

describe('runCachedTypecheck', () => {
  let fakeFs;
  let fakeShell;

  beforeEach(() => {
    fakeFs = makeFakeFs();
    fakeShell = makeFakeShell();
  });

  it('returns ok=false on missing projectDir', async () => {
    const result = await runCachedTypecheck({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('projectDir required');
  });

  it('runs the command and returns ok=true on success', async () => {
    const result = await runCachedTypecheck({
      projectDir: '/proj',
      runCommand: 'npx tsc --noEmit',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    expect(result.ok).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.gitSha).toBe('abc123');
    expect(fakeShell.calls).toEqual(['npx tsc --noEmit']);
  });

  it('returns ok=false on shell failure and captures output', async () => {
    fakeShell = makeFakeShell({ shouldFail: true, output: 'TS2322: type error\n' });
    const result = await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('TS2322');
  });

  it('persists cache after a successful run', async () => {
    await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    const cached = fakeFs.files.get('/proj/.context/tsc-baseline.json');
    expect(cached).toBeTruthy();
    const parsed = JSON.parse(cached);
    expect(parsed.gitSha).toBe('abc123');
    expect(parsed.ok).toBe(true);
  });

  it('reuses cache on second call when SHA unchanged', async () => {
    await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    expect(fakeShell.calls.length).toBe(1);

    const second = await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    expect(second.cached).toBe(true);
    expect(second.ok).toBe(true);
    // No additional shell call
    expect(fakeShell.calls.length).toBe(1);
  });

  it('re-runs the command when SHA changes', async () => {
    await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    expect(fakeShell.calls.length).toBe(1);

    // Simulate a new commit — different SHA
    fakeShell.api.gitSha = () => 'def456';
    const second = await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    expect(second.cached).toBe(false);
    expect(second.gitSha).toBe('def456');
    expect(fakeShell.calls.length).toBe(2);
  });

  it('respects force=true to bypass cache', async () => {
    await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    const second = await runCachedTypecheck({
      projectDir: '/proj',
      force: true,
      fs: fakeFs.api,
      shell: fakeShell.api,
    });
    expect(second.cached).toBe(false);
    expect(fakeShell.calls.length).toBe(2);
  });

  it('does not cache when git is unavailable (no SHA)', async () => {
    const noGitShell = makeFakeShell();
    noGitShell.api.gitSha = () => {
      throw new Error('not a git repo');
    };
    const result = await runCachedTypecheck({
      projectDir: '/proj',
      fs: fakeFs.api,
      shell: noGitShell.api,
    });
    expect(result.ok).toBe(true);
    expect(result.gitSha).toBe(null);
    // No cache file written
    expect(fakeFs.files.has('/proj/.context/tsc-baseline.json')).toBe(false);
  });
});
