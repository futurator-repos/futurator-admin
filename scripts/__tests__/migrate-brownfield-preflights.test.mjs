import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveProjectNameFromUrl,
  checkPathProvided,
  checkPathIsDirectory,
  checkIsGitRepo,
  checkBmadInstalled,
  checkGitRemoteIsGithub,
  checkUnpushedCommits,
  checkResolveBranch,
  checkResolveName,
  checkPatFile,
  checkAdminToken,
  runPreflights,
} from '../lib/migrate-brownfield/preflights.mjs';

let repoPath;

function seedGitDir(path) {
  mkdirSync(`${path}/.git`, { recursive: true });
}

function seedBmadManifest(path, rows = 5) {
  mkdirSync(`${path}/bmad/_cfg`, { recursive: true });
  const lines = ['name,role,description'];
  for (let i = 0; i < rows; i++) lines.push(`agent-${i},analyst,Mock`);
  writeFileSync(`${path}/bmad/_cfg/agent-manifest.csv`, lines.join('\n') + '\n');
}

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'migrate-bf-preflight-'));
});

describe('deriveProjectNameFromUrl', () => {
  it('derives kebab-case from a basic HTTPS URL', () => {
    expect(deriveProjectNameFromUrl('https://github.com/foo/songster')).toBe('songster');
  });

  it('handles .git suffix', () => {
    expect(deriveProjectNameFromUrl('https://github.com/foo/Songster.git')).toBe('songster');
  });

  it('slugifies dots and underscores', () => {
    expect(deriveProjectNameFromUrl('https://github.com/foo/my_repo.name')).toBe('my-repo-name');
  });

  it('returns null on non-GitHub URLs', () => {
    expect(deriveProjectNameFromUrl('https://gitlab.com/foo/bar')).toBeNull();
  });
});

describe('checkPathProvided', () => {
  it('fails when path is null', () => {
    const r = checkPathProvided({ path: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--path is required/);
  });
  it('passes when path is set', () => {
    expect(checkPathProvided({ path: '/x' })).toEqual({ ok: true });
  });
});

describe('checkPathIsDirectory', () => {
  it('passes for an existing directory', () => {
    expect(checkPathIsDirectory({ path: repoPath })).toEqual({ ok: true });
  });
  it('fails for a missing path', () => {
    const r = checkPathIsDirectory({ path: '/nope/does-not-exist-xyz' });
    expect(r.ok).toBe(false);
  });
});

describe('checkIsGitRepo', () => {
  it('fails when .git is missing', () => {
    const r = checkIsGitRepo({ path: repoPath });
    expect(r.ok).toBe(false);
  });
  it('passes when .git exists', () => {
    seedGitDir(repoPath);
    expect(checkIsGitRepo({ path: repoPath })).toEqual({ ok: true });
  });
});

describe('checkBmadInstalled', () => {
  it('fails when no manifest is present', () => {
    const r = checkBmadInstalled({ path: repoPath });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/BMAD not installed/);
  });

  it('passes with the legacy bmad/_cfg layout', () => {
    seedBmadManifest(repoPath, 5);
    const r = checkBmadInstalled({ path: repoPath });
    expect(r.ok).toBe(true);
    expect(r.value.rowCount).toBe(5);
    expect(r.value.manifestPath).toContain('bmad/_cfg/agent-manifest.csv');
  });

  it('passes with the new _bmad/_config layout', () => {
    mkdirSync(`${repoPath}/_bmad/_config`, { recursive: true });
    writeFileSync(
      `${repoPath}/_bmad/_config/agent-manifest.csv`,
      'name,role,description\nagent-1,analyst,Mock\n',
    );
    expect(checkBmadInstalled({ path: repoPath }).ok).toBe(true);
  });

  it('fails when manifest is empty (header only)', () => {
    mkdirSync(`${repoPath}/bmad/_cfg`, { recursive: true });
    writeFileSync(`${repoPath}/bmad/_cfg/agent-manifest.csv`, 'name,role,description\n');
    const r = checkBmadInstalled({ path: repoPath });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/);
  });
});

describe('checkGitRemoteIsGithub', () => {
  it('passes for an HTTPS GitHub remote', () => {
    const runner = vi.fn(() => 'https://github.com/foo/bar.git');
    const r = checkGitRemoteIsGithub({ path: '/x' }, runner);
    expect(r.ok).toBe(true);
    expect(r.value.repoUrl).toBe('https://github.com/foo/bar.git');
  });

  it('rejects SSH GitHub remotes with a clear remediation hint', () => {
    const runner = vi.fn(() => 'git@github.com:foo/bar.git');
    const r = checkGitRemoteIsGithub({ path: '/x' }, runner);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SSH/);
    expect(r.error).toMatch(/git remote set-url/);
  });

  it('rejects non-GitHub HTTPS URLs', () => {
    const runner = vi.fn(() => 'https://gitlab.com/foo/bar.git');
    const r = checkGitRemoteIsGithub({ path: '/x' }, runner);
    expect(r.ok).toBe(false);
  });

  it('fails when there is no origin remote', () => {
    const runner = vi.fn(() => {
      throw new Error('no such remote');
    });
    const r = checkGitRemoteIsGithub({ path: '/x' }, runner);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/origin/);
  });
});

describe('checkUnpushedCommits', () => {
  it('warns when there are unpushed commits', () => {
    const runner = vi.fn(() => '3');
    const r = checkUnpushedCommits({ path: '/x' }, runner);
    expect(r.ok).toBe(true);
    expect(r.warn).toMatch(/3 commit/);
  });

  it('passes silently with 0 unpushed', () => {
    const runner = vi.fn(() => '0');
    const r = checkUnpushedCommits({ path: '/x' }, runner);
    expect(r).toEqual({ ok: true });
  });

  it('warns (non-fatal) when no upstream is configured', () => {
    const runner = vi.fn(() => {
      throw new Error('no upstream');
    });
    const r = checkUnpushedCommits({ path: '/x' }, runner);
    expect(r.ok).toBe(true);
    expect(r.warn).toMatch(/upstream/);
  });
});

describe('checkResolveBranch', () => {
  it('returns the explicit --branch when provided', () => {
    const r = checkResolveBranch({ path: '/x', branch: 'develop' }, vi.fn());
    expect(r.value.branch).toBe('develop');
  });

  it('derives from git when --branch is omitted', () => {
    const runner = vi.fn(() => 'feature/foo');
    const r = checkResolveBranch({ path: '/x' }, runner);
    expect(r.value.branch).toBe('feature/foo');
  });

  it('falls back to "main" when HEAD is detached', () => {
    const runner = vi.fn(() => 'HEAD');
    const r = checkResolveBranch({ path: '/x' }, runner);
    expect(r.value.branch).toBe('main');
  });

  it('falls back to "main" on git error', () => {
    const runner = vi.fn(() => {
      throw new Error('boom');
    });
    const r = checkResolveBranch({ path: '/x' }, runner);
    expect(r.value.branch).toBe('main');
  });
});

describe('checkResolveName', () => {
  it('uses explicit --name when valid', () => {
    expect(checkResolveName({ name: 'songster' }, 'https://github.com/x/y').value.name).toBe(
      'songster',
    );
  });

  it('rejects explicit --name violating the regex', () => {
    const r = checkResolveName({ name: 'UPPERCASE' }, 'https://github.com/x/y');
    expect(r.ok).toBe(false);
  });

  it('derives from URL when --name is missing', () => {
    const r = checkResolveName({}, 'https://github.com/foo/songster.git');
    expect(r.value.name).toBe('songster');
  });

  it('fails when URL is not derivable', () => {
    const r = checkResolveName({}, 'not-a-url');
    expect(r.ok).toBe(false);
  });
});

describe('checkPatFile', () => {
  it('fails when --pat-file is missing (and required)', () => {
    const r = checkPatFile({ patFile: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--pat-file is required/);
  });

  it('skips with null value when not required (refresh mode)', () => {
    const r = checkPatFile({ patFile: null }, { requirePat: false });
    expect(r.ok).toBe(true);
    expect(r.value.pat).toBeNull();
  });

  it('reads + trims the first line of the file', () => {
    const file = join(repoPath, 'pat');
    writeFileSync(file, 'github_pat_secret_token  \nsome trailing junk\n');
    const r = checkPatFile({ patFile: file });
    expect(r.ok).toBe(true);
    expect(r.value.pat).toBe('github_pat_secret_token');
  });

  it('rejects tokens without a recognized prefix', () => {
    const file = join(repoPath, 'pat');
    writeFileSync(file, 'not-a-real-token-xyz\n');
    const r = checkPatFile({ patFile: file });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not look like a GitHub token/);
  });

  it('fails when --pat-file does not exist', () => {
    const r = checkPatFile({ patFile: '/nope/missing-pat-file' });
    expect(r.ok).toBe(false);
  });

  it('fails when --pat-file is empty', () => {
    const file = join(repoPath, 'empty');
    writeFileSync(file, '\n');
    const r = checkPatFile({ patFile: file });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/);
  });
});

describe('checkAdminToken', () => {
  it('fails when token is null', () => {
    expect(checkAdminToken({ token: null }).ok).toBe(false);
  });

  it('fails for non-JWT shaped strings', () => {
    expect(checkAdminToken({ token: 'not-a-jwt' }).ok).toBe(false);
  });

  it('passes for a three-segment JWT', () => {
    expect(checkAdminToken({ token: 'aaaa.bbbb.cccc' }).ok).toBe(true);
  });
});

describe('runPreflights — happy aggregate', () => {
  it('passes all checks and returns derived values', () => {
    seedGitDir(repoPath);
    seedBmadManifest(repoPath, 6);
    const patFile = join(repoPath, 'pat');
    writeFileSync(patFile, 'github_pat_secret\n');

    const gitRunner = vi.fn((_p, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url')
        return 'https://github.com/foo/applicator.git';
      if (args[0] === 'rev-list') return '0';
      if (args[0] === 'rev-parse') return 'main';
      return '';
    });

    const r = runPreflights(
      {
        path: repoPath,
        patFile,
        name: null,
        branch: null,
        token: 'a.b.c',
        refresh: false,
      },
      { gitRunner },
    );

    expect(r.ok).toBe(true);
    expect(r.derived.repoUrl).toBe('https://github.com/foo/applicator.git');
    expect(r.derived.name).toBe('applicator');
    expect(r.derived.branch).toBe('main');
    expect(r.derived.pat).toBe('github_pat_secret');
  });

  it('exits early on first hard failure with that step name in results', () => {
    // Path missing → fails at first check.
    const r = runPreflights({ path: null }, { gitRunner: vi.fn() });
    expect(r.ok).toBe(false);
    expect(r.results[0].name).toBe('path provided');
    expect(r.results[0].ok).toBe(false);
  });

  it('skips PAT requirement when refresh=true', () => {
    seedGitDir(repoPath);
    seedBmadManifest(repoPath, 6);
    const gitRunner = vi.fn((_p, args) => {
      if (args[0] === 'remote') return 'https://github.com/foo/applicator.git';
      if (args[0] === 'rev-list') return '0';
      if (args[0] === 'rev-parse') return 'main';
      return '';
    });

    const r = runPreflights(
      { path: repoPath, patFile: null, token: 'a.b.c', refresh: true },
      { gitRunner },
    );
    expect(r.ok).toBe(true);
    expect(r.derived.pat).toBeUndefined();
  });
});
