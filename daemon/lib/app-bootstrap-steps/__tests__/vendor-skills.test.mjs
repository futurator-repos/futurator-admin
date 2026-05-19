/**
 * vendor-skills.test.mjs — Pipeline v2 Phase 3-C Epic 2 (Story 2.3,
 * 2026-05-19).
 *
 * Tests the vendor-skills bootstrap step with a mocked `spawn`
 * implementation, so we never shell out to a real `node scripts/skills-
 * sync.mjs` or hit the GitHub raw API. The mock returns canned stdout +
 * exit code per scenario.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runVendorSkills } from '../vendor-skills.mjs';

/**
 * Build a fake child process that emits canned stdout/stderr then exits
 * with the given code. Mirrors enough of node:child_process.spawn for
 * runVendorSkills's purposes (stdout, stderr, on('close'/'error'), kill).
 */
function makeFakeProc({ stdout = '', stderr = '', exitCode = 0, exitDelayMs = 0 }) {
  const ee = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = () => {};

  // Defer the emissions so callers can attach listeners first.
  queueMicrotask(() => {
    if (stdout) ee.stdout.emit('data', Buffer.from(stdout));
    if (stderr) ee.stderr.emit('data', Buffer.from(stderr));
    if (exitDelayMs > 0) {
      setTimeout(() => ee.emit('close', exitCode), exitDelayMs);
    } else {
      ee.emit('close', exitCode);
    }
  });

  return ee;
}

function makeFakeSpawn(setup) {
  return () => makeFakeProc(setup);
}

describe('runVendorSkills', () => {
  let workingDir;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'vendor-test-'));
    // skills-sync.mjs must exist for the step to even try spawning.
    mkdirSync(join(workingDir, 'scripts'), { recursive: true });
    writeFileSync(join(workingDir, 'scripts/skills-sync.mjs'), '// fixture\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('skips with stub-boilerplate when skip=true', async () => {
    const result = await runVendorSkills({
      worktreeDir: workingDir,
      skip: true,
      spawnImpl: makeFakeSpawn({ exitCode: 0 }),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('stub-boilerplate');
    expect(result.vendoredCount).toBe(0);
  });

  it('skips with sync-script-missing when scripts/skills-sync.mjs absent', async () => {
    rmSync(join(workingDir, 'scripts/skills-sync.mjs'));
    const result = await runVendorSkills({
      worktreeDir: workingDir,
      spawnImpl: makeFakeSpawn({ exitCode: 0 }),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('sync-script-missing');
  });

  it('counts WROTE lines from stdout on exit 0', async () => {
    const stdout = `[skills-sync] WROTE canvas-design@anthropic-official (a3f9c2e)
[skills-sync] WROTE frontend-design@anthropic-official (b1c2d3e)
[skills-sync] WROTE algorithmic-art@anthropic-official (4f5g6h7)
[skills-sync] all skills in sync
`;
    const result = await runVendorSkills({
      worktreeDir: workingDir,
      spawnImpl: makeFakeSpawn({ stdout, exitCode: 0 }),
    });
    expect(result.skipped).toBe(false);
    expect(result.vendoredCount).toBe(3);
    expect(result.drift).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.attentionCategory).toBeUndefined();
  });

  it('returns success-with-attention on exit 2 drift', async () => {
    const stdout = `[skills-sync] OK    frontend-design@anthropic-official
[skills-sync] DRIFT canvas-design@anthropic-official: local SHA aa11bbcc != remote dd22eeff
[skills-sync] 1 drift(s) — rerun with --resync to overwrite local, or run /skills audit to re-pin
`;
    const result = await runVendorSkills({
      worktreeDir: workingDir,
      spawnImpl: makeFakeSpawn({ stdout, exitCode: 2 }),
    });
    expect(result.skipped).toBe(false);
    expect(result.drift).toBe(1);
    expect(result.exitCode).toBe(2);
    expect(result.attentionCategory).toBe('skill-manifest-out-of-sync');
    expect(result.attentionSeverity).toBe('low');
  });

  it('returns sync-failed-exit-1 with medium severity on exit 1 fatal', async () => {
    const stderr = '[skills-sync] federation missing: /home/ubuntu/.futurator/skill-federation.yaml';
    const result = await runVendorSkills({
      worktreeDir: workingDir,
      spawnImpl: makeFakeSpawn({ stderr, exitCode: 1 }),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('sync-failed-exit-1');
    expect(result.attentionCategory).toBe('skill-sync-failed');
    expect(result.attentionSeverity).toBe('medium');
    expect(result.stderr).toContain('federation missing');
  });

  it('handles unknown non-zero exit codes (defensive)', async () => {
    const result = await runVendorSkills({
      worktreeDir: workingDir,
      spawnImpl: makeFakeSpawn({ exitCode: 137, stderr: 'oom?' }),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('sync-failed-exit-137');
    expect(result.attentionCategory).toBe('skill-sync-failed');
  });

  it('forwards spawn error as attention skip (e.g. ENOENT for node)', async () => {
    const spawnImpl = () => {
      const ee = new EventEmitter();
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.kill = () => {};
      queueMicrotask(() => ee.emit('error', new Error('spawn node ENOENT')));
      return ee;
    };
    const result = await runVendorSkills({ worktreeDir: workingDir, spawnImpl });
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/^spawn-error: spawn node ENOENT/);
    expect(result.attentionCategory).toBe('skill-sync-failed');
  });

  it('forwards onOutput tuples for stdout + stderr', async () => {
    const calls = [];
    await runVendorSkills({
      worktreeDir: workingDir,
      onOutput: (stream, data) => calls.push([stream, data]),
      spawnImpl: makeFakeSpawn({
        stdout: '[skills-sync] WROTE foo@anthropic-official\n',
        stderr: 'warn: something\n',
        exitCode: 0,
      }),
    });
    expect(calls).toContainEqual(['stdout', '[skills-sync] WROTE foo@anthropic-official\n']);
    expect(calls).toContainEqual(['stderr', 'warn: something\n']);
  });

  it('threads FUTURATOR_FEDERATION_PATH env to the spawned process', async () => {
    let capturedEnv;
    const spawnImpl = (_cmd, _args, opts) => {
      capturedEnv = opts.env;
      return makeFakeProc({ exitCode: 0 });
    };
    await runVendorSkills({
      worktreeDir: workingDir,
      federationPath: '/custom/path/skill-federation.yaml',
      spawnImpl,
    });
    expect(capturedEnv.FUTURATOR_FEDERATION_PATH).toBe('/custom/path/skill-federation.yaml');
  });

  it('runs the script with cwd = worktreeDir', async () => {
    let capturedCwd;
    const spawnImpl = (_cmd, _args, opts) => {
      capturedCwd = opts.cwd;
      return makeFakeProc({ exitCode: 0 });
    };
    await runVendorSkills({ worktreeDir: workingDir, spawnImpl });
    expect(capturedCwd).toBe(workingDir);
  });

  it('invokes `node scripts/skills-sync.mjs`', async () => {
    let capturedCmd;
    let capturedArgs;
    const spawnImpl = (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return makeFakeProc({ exitCode: 0 });
    };
    await runVendorSkills({ worktreeDir: workingDir, spawnImpl });
    expect(capturedCmd).toBe('node');
    expect(capturedArgs).toEqual(['scripts/skills-sync.mjs']);
  });

  it('kills process and reports timeout if exitDelayMs exceeds timeoutMs', async () => {
    const result = await runVendorSkills({
      worktreeDir: workingDir,
      timeoutMs: 50,
      spawnImpl: makeFakeSpawn({ exitCode: 0, exitDelayMs: 500 }),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('timeout');
    expect(result.attentionCategory).toBe('skill-sync-failed');
  });

  it('throws on missing worktreeDir', async () => {
    await expect(runVendorSkills({})).rejects.toThrow(/worktreeDir required/);
  });
});
