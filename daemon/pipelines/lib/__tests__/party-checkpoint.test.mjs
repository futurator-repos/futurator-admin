import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 20.2 tests — party-checkpoint.sh against ephemeral git fixtures.
 *
 * Each test builds a fresh git repo in $TMPDIR, configures user.email +
 * user.name (required for `git commit`), and exercises the script with
 * `PARTY_CHECKPOINT_SUDO=""` so it runs as the current user instead of
 * the production `sudo -u ubuntu` prefix.
 */

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../party-checkpoint.sh');

let repoDir;

function sh(cmd, cwd) {
  return spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf-8' });
}

function setupRepo({ branch }) {
  repoDir = mkdtempSync(join(tmpdir(), 'party-checkpoint-'));
  sh('git init -q', repoDir);
  sh('git config user.email party@test.local && git config user.name TestUser', repoDir);
  sh('git config commit.gpgsign false', repoDir);
  // Stamp a baseline commit so HEAD exists.
  writeFileSync(join(repoDir, 'README.md'), '# initial\n');
  sh('git add README.md && git commit -q -m "baseline"', repoDir);
  // Move to the party branch.
  sh(`git checkout -q -b ${branch}`, repoDir);
  return repoDir;
}

function runScript({ branch, dir, message }) {
  const result = spawnSync('bash', [SCRIPT, branch, dir], {
    env: { ...process.env, PARTY_CHECKPOINT_SUDO: '' },
    input: message ?? '',
    encoding: 'utf-8',
  });
  return {
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

beforeEach(() => {
  repoDir = null;
});

afterEach(() => {
  if (repoDir && existsSync(repoDir)) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('party-checkpoint.sh — happy path', () => {
  it('commits staged changes and echoes the new SHA', () => {
    const dir = setupRepo({ branch: 'party/applicator/c6b86fee' });
    spawnSync('mkdir', ['-p', join(dir, 'docs')], { cwd: dir });
    writeFileSync(join(dir, 'docs/architecture.md'), '# v0.1\n');

    const r = runScript({
      branch: 'party/applicator/c6b86fee',
      dir,
      message:
        'party(applicator/round-1): initial architecture\n\nFirst sketch.\n\nAgent: PARTY-ORCHESTRATOR\nSession-Id: c6b86fee-1111-2222-3333-444455556666\n',
    });

    expect(r.code).toBe(0);
    // Last line of stdout should be a 40-char SHA.
    const lines = r.stdout.split('\n').filter(Boolean);
    const sha = lines[lines.length - 1];
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(r.stdout).toContain('PUSH_DEFERRED:');
  });
});

describe('party-checkpoint.sh — empty porcelain', () => {
  it('exits 0 silently when nothing to commit', () => {
    const dir = setupRepo({ branch: 'party/applicator/c6b86fee' });
    const r = runScript({
      branch: 'party/applicator/c6b86fee',
      dir,
      message: 'unused',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('STATUS_PORCELAIN_EMPTY');
  });
});

describe('party-checkpoint.sh — branch mismatch', () => {
  it('exits 3 when HEAD is on a different branch than expected', () => {
    const dir = setupRepo({ branch: 'party/applicator/c6b86fee' });
    // Move OFF the party branch back to whatever the init branch was (main/master).
    sh('git checkout -q HEAD~0 2>/dev/null; git checkout -q -B not-the-party', dir);
    const r = runScript({
      branch: 'party/applicator/c6b86fee',
      dir,
      message: 'unused',
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/BRANCH_MISMATCH/);
  });
});

describe('party-checkpoint.sh — secrets hit', () => {
  it('exits 2 with SECRETS_HIT when a staged file contains an AWS key', () => {
    const dir = setupRepo({ branch: 'party/applicator/c6b86fee' });
    // AKIA + 16 uppercase alphanumeric — matches the deny-list pattern.
    writeFileSync(join(dir, 'leak.txt'), 'AKIAABCDEFGHIJKLMNOP\n');
    const r = runScript({
      branch: 'party/applicator/c6b86fee',
      dir,
      message:
        'party(applicator/round-1): would have leaked\n\nAgent: PARTY-ORCHESTRATOR\nSession-Id: c6b86fee-1111-2222-3333-444455556666\n',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/SECRETS_HIT:/);
    // The secret value itself MUST NOT appear in stderr (would re-expose
    // the leaked content in daemon logs).
    expect(r.stderr).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

describe('party-checkpoint.sh — worktree missing', () => {
  it('exits 4 when the worktree path does not exist', () => {
    const r = runScript({
      branch: 'party/applicator/c6b86fee',
      dir: '/nonexistent/path/no/way',
      message: 'unused',
    });
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/WORKTREE_MISSING/);
  });

  it('exits 4 when the path exists but is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'party-checkpoint-nogit-'));
    repoDir = dir; // for cleanup
    const r = runScript({
      branch: 'party/applicator/c6b86fee',
      dir,
      message: 'unused',
    });
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/WORKTREE_MISSING/);
  });
});

describe('party-checkpoint.sh — usage validation', () => {
  it('exits 1 when args are missing', () => {
    const r = spawnSync('bash', [SCRIPT], {
      env: { ...process.env, PARTY_CHECKPOINT_SUDO: '' },
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/USAGE:/);
  });
});

describe('party-checkpoint.sh — empty commit message', () => {
  it('exits 1 when stdin produces an empty message', () => {
    const dir = setupRepo({ branch: 'party/applicator/c6b86fee' });
    writeFileSync(join(dir, 'changed.txt'), 'change\n');
    const r = runScript({
      branch: 'party/applicator/c6b86fee',
      dir,
      message: '',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/EMPTY_COMMIT_MESSAGE/);
  });
});
