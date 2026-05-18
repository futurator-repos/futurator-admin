import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureWorktree,
  writeFreeAgentSettings,
  reapWorktree,
  installCommitMsgHook,
  branchNameFor,
  worktreePathFor,
  FREE_AGENT_PATH_HOOK_SCRIPT,
  FREE_AGENT_COMMIT_MSG_HOOK_SCRIPT,
} from '../lib/free-agent-worktree.mjs';

// We test against an in-memory `fs` shim plus a vi.fn `execGit` so the suite
// runs hermetically — no real git, no real /home/ubuntu/... touches.

function makeFsShim(paths) {
  // paths is a Map<string, string|undefined> — key = path, value = file contents
  // (undefined for directories). Accept Set for backward compat with older tests.
  const fileMap = paths instanceof Set ? new Map([...paths].map((p) => [p, undefined])) : paths;
  return {
    existsSync: vi.fn((p) => fileMap.has(p)),
    mkdirSync: vi.fn((p) => {
      fileMap.set(p, undefined);
    }),
    writeFileSync: vi.fn((p, content) => {
      fileMap.set(p, typeof content === 'string' ? content : String(content ?? ''));
    }),
    readFileSync: vi.fn((p) => {
      if (!fileMap.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return fileMap.get(p) ?? '';
    }),
    appendFileSync: vi.fn((p, content) => {
      const prev = fileMap.get(p) ?? '';
      fileMap.set(p, prev + (typeof content === 'string' ? content : String(content ?? '')));
    }),
    chmodSync: vi.fn(),
    renameSync: vi.fn((from, to) => {
      const v = fileMap.get(from);
      fileMap.delete(from);
      fileMap.set(to, v);
    }),
    rmSync: vi.fn((p) => {
      for (const key of [...fileMap.keys()]) {
        if (key === p || key.startsWith(p + '/')) {
          fileMap.delete(key);
        }
      }
    }),
  };
}

describe('branchNameFor / worktreePathFor (helpers)', () => {
  it('branchNameFor returns assist/<projectId>/<sessionId>', () => {
    expect(branchNameFor('dino-7', 'sess-abc')).toBe('assist/dino-7/sess-abc');
  });

  it('worktreePathFor returns <root>/<projectId>/<sessionId>', () => {
    expect(worktreePathFor('dino-7', 'sess-abc', '/tmp/wt')).toBe('/tmp/wt/dino-7/sess-abc');
  });
});

describe('ensureWorktree (AC #4, AC #7)', () => {
  it('creates a fresh worktree when none exists (AC #4)', async () => {
    const paths = new Set(['/home/ubuntu/repos/dino-7.git']);
    const fs = makeFsShim(paths);
    const execGit = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const result = await ensureWorktree({
      projectId: 'dino-7',
      sessionId: 'sess-abc',
      fs,
      execGit,
    });

    expect(result.skipped).toBe(false);
    expect(result.worktreePath).toBe('/home/ubuntu/free-agent-worktrees/dino-7/sess-abc');
    expect(result.branchName).toBe('assist/dino-7/sess-abc');

    expect(execGit).toHaveBeenCalledTimes(1);
    expect(execGit).toHaveBeenCalledWith([
      '-C',
      '/home/ubuntu/repos/dino-7.git',
      'worktree',
      'add',
      '-b',
      'assist/dino-7/sess-abc',
      '/home/ubuntu/free-agent-worktrees/dino-7/sess-abc',
      'main',
    ]);
    // Parent dir was created
    expect(fs.mkdirSync).toHaveBeenCalledWith('/home/ubuntu/free-agent-worktrees/dino-7', {
      recursive: true,
    });
  });

  it('honors a non-default defaultBranch argument (AC #4)', async () => {
    const paths = new Set(['/home/ubuntu/repos/dino-7.git']);
    const fs = makeFsShim(paths);
    const execGit = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    await ensureWorktree({
      projectId: 'dino-7',
      sessionId: 'sess-abc',
      defaultBranch: 'develop',
      fs,
      execGit,
    });

    expect(execGit).toHaveBeenCalledWith(expect.arrayContaining(['develop']));
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['origin/develop']));
  });

  it('returns the existing worktree without re-cloning when already present (AC #7)', async () => {
    const wtPath = '/home/ubuntu/free-agent-worktrees/dino-7/sess-abc';
    const paths = new Set(['/home/ubuntu/repos/dino-7.git', wtPath, join(wtPath, '.git')]);
    const fs = makeFsShim(paths);
    const execGit = vi.fn();

    const result = await ensureWorktree({
      projectId: 'dino-7',
      sessionId: 'sess-abc',
      fs,
      execGit,
    });

    expect(result.skipped).toBe(true);
    expect(result.worktreePath).toBe(wtPath);
    expect(result.branchName).toBe('assist/dino-7/sess-abc');
    expect(execGit).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when the bare repo is missing', async () => {
    const paths = new Set(); // no bare repo
    const fs = makeFsShim(paths);
    const execGit = vi.fn();

    await expect(
      ensureWorktree({ projectId: 'dino-7', sessionId: 'sess-abc', fs, execGit }),
    ).rejects.toThrow(/bare repo not found/);
    expect(execGit).not.toHaveBeenCalled();
  });

  it('requires projectId and sessionId', async () => {
    await expect(ensureWorktree({ sessionId: 's' })).rejects.toThrow(/projectId/);
    await expect(ensureWorktree({ projectId: 'p' })).rejects.toThrow(/sessionId/);
  });
});

describe('writeFreeAgentSettings (AC #5 atomicity)', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'free-agent-settings-test-'));
  });

  it('writes a valid settings.json with the PreToolUse hook for Bash', () => {
    writeFreeAgentSettings({
      worktreePath: workDir,
      projectId: 'dino-7',
      sessionId: 'sess-abc',
    });

    const settingsPath = join(workDir, '.claude/settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(parsed).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: FREE_AGENT_PATH_HOOK_SCRIPT,
              },
            ],
          },
        ],
      },
    });
  });

  it('writes atomically (temp file in same directory, then rename)', () => {
    const paths = new Set([workDir]);
    const fs = makeFsShim(paths);

    writeFreeAgentSettings({
      worktreePath: workDir,
      projectId: 'dino-7',
      sessionId: 'sess-abc',
      fs,
    });

    // writeFileSync called with a path under .claude/ matching the temp prefix
    const writeCall = fs.writeFileSync.mock.calls[0];
    expect(writeCall[0]).toMatch(
      new RegExp(`^${workDir}/\\.claude/\\.settings\\.json\\.tmp-[a-f0-9]+$`),
    );

    // renameSync moves the temp to the final settings.json
    const renameCall = fs.renameSync.mock.calls[0];
    expect(renameCall[0]).toBe(writeCall[0]); // same temp path
    expect(renameCall[1]).toBe(join(workDir, '.claude/settings.json'));
  });

  it('creates the .claude/ subdirectory if missing', () => {
    const paths = new Set([workDir]);
    const fs = makeFsShim(paths);

    writeFreeAgentSettings({
      worktreePath: workDir,
      projectId: 'p',
      sessionId: 's',
      fs,
    });

    expect(fs.mkdirSync).toHaveBeenCalledWith(join(workDir, '.claude'), {
      recursive: true,
    });
  });

  it('accepts a custom hookScriptPath', () => {
    writeFreeAgentSettings({
      worktreePath: workDir,
      projectId: 'p',
      sessionId: 's',
      hookScriptPath: '/custom/hook.sh',
    });

    const parsed = JSON.parse(readFileSync(join(workDir, '.claude/settings.json'), 'utf8'));
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('/custom/hook.sh');
  });
});

describe('reapWorktree (AC #6 cleanup primitive)', () => {
  it('removes both the worktree and the branch via git', async () => {
    const wtPath = '/home/ubuntu/free-agent-worktrees/dino-7/sess-abc';
    const paths = new Set(['/home/ubuntu/repos/dino-7.git', wtPath]);
    const fs = makeFsShim(paths);
    const execGit = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    await reapWorktree({ projectId: 'dino-7', sessionId: 'sess-abc', fs, execGit });

    expect(execGit).toHaveBeenCalledWith([
      '-C',
      '/home/ubuntu/repos/dino-7.git',
      'worktree',
      'remove',
      '--force',
      wtPath,
    ]);
    expect(execGit).toHaveBeenCalledWith([
      '-C',
      '/home/ubuntu/repos/dino-7.git',
      'branch',
      '-D',
      'assist/dino-7/sess-abc',
    ]);
  });

  it('ignores git errors (idempotent) and falls back to rmSync for orphans', async () => {
    const wtPath = '/home/ubuntu/free-agent-worktrees/dino-7/sess-abc';
    const paths = new Set(['/home/ubuntu/repos/dino-7.git', wtPath]);
    const fs = makeFsShim(paths);
    const execGit = vi.fn().mockRejectedValue(new Error('not a working tree'));

    await reapWorktree({ projectId: 'dino-7', sessionId: 'sess-abc', fs, execGit });

    // Despite git failing twice (worktree remove + branch -D), the directory
    // is still cleaned up via rmSync fallback.
    expect(fs.rmSync).toHaveBeenCalledWith(wtPath, { recursive: true, force: true });
  });

  it('handles missing bare repo gracefully (orphan removal still runs)', async () => {
    const wtPath = '/home/ubuntu/free-agent-worktrees/dino-7/sess-abc';
    const paths = new Set([wtPath]); // no bare repo
    const fs = makeFsShim(paths);
    const execGit = vi.fn();

    await reapWorktree({ projectId: 'dino-7', sessionId: 'sess-abc', fs, execGit });

    expect(execGit).not.toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalledWith(wtPath, { recursive: true, force: true });
  });

  it('no-op when neither worktree nor bare repo exists', async () => {
    const paths = new Set();
    const fs = makeFsShim(paths);
    const execGit = vi.fn();

    await reapWorktree({ projectId: 'dino-7', sessionId: 'sess-abc', fs, execGit });

    expect(execGit).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('cleans up real on-disk temp dirs (integration-shape)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'reap-worktree-real-'));
    const wtPath = join(tmpRoot, 'dino-7/sess-abc');
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, 'sentinel'), 'present');

    // No bare repo → execGit skipped; orphan rmSync path exercised.
    await reapWorktree({
      projectId: 'dino-7',
      sessionId: 'sess-abc',
      worktreesRoot: tmpRoot,
      reposRoot: '/nonexistent-base',
      execGit: vi.fn(),
    });

    expect(existsSync(wtPath)).toBe(false);

    // Cleanup the temp root we created
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe('installCommitMsgHook (Story 18.3 AC #1, #2)', () => {
  it('writes our hook fresh when no prepare-commit-msg exists', () => {
    const fileMap = new Map([['/wt/dino/sess-abc', undefined]]);
    const fs = makeFsShim(fileMap);

    const result = installCommitMsgHook({
      worktreePath: '/wt/dino/sess-abc',
      sessionId: 'sid-1',
      fs,
    });

    expect(result).toEqual({ installed: true, mode: 'fresh' });
    expect(fs.mkdirSync).toHaveBeenCalledWith('/wt/dino/sess-abc/.git/hooks', {
      recursive: true,
    });
    const writeCall = fs.writeFileSync.mock.calls.find(
      (c) => c[0] === '/wt/dino/sess-abc/.git/hooks/prepare-commit-msg',
    );
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain('#!/usr/bin/env bash');
    expect(writeCall[1]).toContain(FREE_AGENT_COMMIT_MSG_HOOK_SCRIPT);
    expect(writeCall[1]).toContain('# >>> futurator free-agent commit-msg trailer >>>');
    expect(writeCall[1]).toContain('# <<< futurator free-agent commit-msg trailer <<<');
    expect(fs.chmodSync).toHaveBeenCalledWith(
      '/wt/dino/sess-abc/.git/hooks/prepare-commit-msg',
      0o755,
    );
  });

  it('is idempotent on a worktree that already has our marker block', () => {
    const existingHook = [
      '#!/usr/bin/env bash',
      '# Installed by futurator free-agent (Story 18.3)',
      '# >>> futurator free-agent commit-msg trailer >>>',
      'exec "/some/path/free-agent-commit-msg-hook.sh" "$@"',
      '# <<< futurator free-agent commit-msg trailer <<<',
    ].join('\n');

    const fileMap = new Map([
      ['/wt/p/s', undefined],
      ['/wt/p/s/.git/hooks', undefined],
      ['/wt/p/s/.git/hooks/prepare-commit-msg', existingHook],
    ]);
    const fs = makeFsShim(fileMap);

    const result = installCommitMsgHook({
      worktreePath: '/wt/p/s',
      sessionId: 'sid-1',
      fs,
    });

    expect(result).toEqual({ installed: false, mode: 'already-present' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });

  it('appends our marker-bracketed block when a user hook is present', () => {
    const userHook = [
      '#!/usr/bin/env bash',
      '# user-defined prepare-commit-msg',
      'echo "user logic here" >&2',
    ].join('\n');

    const fileMap = new Map([
      ['/wt/p/s', undefined],
      ['/wt/p/s/.git/hooks', undefined],
      ['/wt/p/s/.git/hooks/prepare-commit-msg', userHook],
    ]);
    const fs = makeFsShim(fileMap);

    const result = installCommitMsgHook({
      worktreePath: '/wt/p/s',
      sessionId: 'sid-1',
      fs,
    });

    expect(result).toEqual({ installed: true, mode: 'appended' });
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);

    const appendCall = fs.appendFileSync.mock.calls[0];
    expect(appendCall[0]).toBe('/wt/p/s/.git/hooks/prepare-commit-msg');
    expect(appendCall[1]).toContain('# >>> futurator free-agent commit-msg trailer >>>');
    expect(appendCall[1]).toContain(FREE_AGENT_COMMIT_MSG_HOOK_SCRIPT);
    expect(appendCall[1]).toContain('# <<< futurator free-agent commit-msg trailer <<<');
    // chmod called to reassert +x even on append
    expect(fs.chmodSync).toHaveBeenCalledWith('/wt/p/s/.git/hooks/prepare-commit-msg', 0o755);
  });

  it('honors a custom hookScriptPath argument', () => {
    const fileMap = new Map([['/wt/p/s', undefined]]);
    const fs = makeFsShim(fileMap);

    installCommitMsgHook({
      worktreePath: '/wt/p/s',
      sessionId: 'sid-1',
      hookScriptPath: '/custom/my-hook.sh',
      fs,
    });

    const writeCall = fs.writeFileSync.mock.calls[0];
    expect(writeCall[1]).toContain('/custom/my-hook.sh');
  });

  it('requires worktreePath and sessionId', () => {
    expect(() => installCommitMsgHook({ sessionId: 's' })).toThrow(/worktreePath/);
    expect(() => installCommitMsgHook({ worktreePath: '/wt' })).toThrow(/sessionId/);
  });

  it('handles unreadable existing hook without modifying the filesystem', () => {
    const fileMap = new Map([
      ['/wt/p/s', undefined],
      ['/wt/p/s/.git/hooks', undefined],
      ['/wt/p/s/.git/hooks/prepare-commit-msg', undefined], // simulate "exists but unreadable" via undefined content + readFileSync throwing
    ]);
    const fs = makeFsShim(fileMap);
    // Override readFileSync to throw EACCES
    fs.readFileSync = vi.fn(() => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    });

    const result = installCommitMsgHook({
      worktreePath: '/wt/p/s',
      sessionId: 'sid-1',
      fs,
    });

    expect(result).toEqual({ installed: false, mode: 'unreadable' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });
});
