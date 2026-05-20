/**
 * skill-install-job-runner.test.mjs — Pipeline v2 Phase 3-C Epic 3
 * (Story 3.6, 2026-05-20).
 *
 * Hermetic tests with all spawn / installer deps injected.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  validateSkillInstallJob,
  runSkillInstallJob,
} from '../skill-install-job-runner.mjs';

function makeFakeProc({ stdout = '', stderr = '', exitCode = 0 } = {}) {
  const ee = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = () => {};
  queueMicrotask(() => {
    if (stdout) ee.stdout.emit('data', Buffer.from(stdout));
    if (stderr) ee.stderr.emit('data', Buffer.from(stderr));
    ee.emit('close', exitCode);
  });
  return ee;
}

function makeJobAndCtx(over = {}) {
  const job = {
    jobId: 'install-test-1',
    jobType: 'skill-install',
    workingDir: '/home/ubuntu/projects/snake-x',
    skillInstallPayload: {
      projectSlug: 'snake-x',
      appId: 'snake-x',
      output: {
        trigger: 'T2',
        projectSlug: 'snake-x',
        proposals: [
          {
            kind: 'add', source: 'anthropic-official', skill: 'canvas-design',
            manifestBucket: 'core', version: 'tag:v1', rationale: 'r',
            verifyNotes: 'v', confidence: 0.85,
          },
        ],
      },
      source: 'operator-confirm',
      originAttentionId: 'attn-1',
    },
    ...over,
  };

  const calls = { apply: [], attention: [], pushEvent: [], spawn: [] };
  const ctx = {
    applyConfirmedProposals: async (args) => {
      calls.apply.push(args);
      return { written: 1, added: 1, upgraded: 0, removed: 0, vendoredCount: 1, drift: 0 };
    },
    writeAttentionItem: async (item) => calls.attention.push(item),
    pushEvent: async (...args) => calls.pushEvent.push(args),
    getProjectPath: (slug) => `/home/ubuntu/projects/${slug}`,
    // Default fake spawn: every git command succeeds with empty output.
    // Test overrides via ctx.spawnImpl when needed.
    spawnImpl: (cmd, args) => {
      calls.spawn.push({ cmd, args });
      // `git diff --cached --name-only` returns staged files; we lie
      // and say there ARE changes so commit runs.
      const out = args && args[0] === 'diff' ? '.claude/skills.manifest.yaml\n' : '';
      return makeFakeProc({ stdout: out, exitCode: 0 });
    },
  };

  return { job, ctx, calls };
}

describe('validateSkillInstallJob', () => {
  it('accepts a well-formed job', () => {
    const { job } = makeJobAndCtx();
    expect(validateSkillInstallJob(job)).toEqual({ ok: true });
  });

  it.each([
    ['missing job', null, 'job-missing'],
    ['wrong jobType', { jobType: 'other' }, 'jobType-mismatch'],
    ['no jobId', { jobType: 'skill-install', skillInstallPayload: {} }, 'jobId-missing'],
  ])('rejects %s', (_label, j, reason) => {
    expect(validateSkillInstallJob(j)).toEqual({ ok: false, reason });
  });

  it('rejects missing payload', () => {
    expect(validateSkillInstallJob({ jobType: 'skill-install', jobId: 'x' }).reason).toBe(
      'skillInstallPayload-missing',
    );
  });

  it('rejects invalid source', () => {
    const job = {
      jobType: 'skill-install', jobId: 'x',
      skillInstallPayload: {
        projectSlug: 'a',
        output: { proposals: [] },
        source: 'rogue',
      },
    };
    expect(validateSkillInstallJob(job).reason).toBe('source-invalid');
  });
});

describe('runSkillInstallJob — happy path', () => {
  it('applies proposals + commits + returns success', async () => {
    const { job, ctx, calls } = makeJobAndCtx();
    const result = await runSkillInstallJob(job, ctx);
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(result.committed).toBe(true);
    expect(calls.apply).toHaveLength(1);
    expect(calls.apply[0].source).toBe('operator-confirm');
    expect(calls.attention).toHaveLength(0);
    // Should have called: git add, git diff, git commit, git push.
    // Note: git commit is invoked via `git -c user.email=… -c user.name=…
    // commit -m …`, so the verb may not be args[0] — scan the full args.
    const allArgs = calls.spawn.flatMap((c) => c.args);
    expect(allArgs).toContain('add');
    expect(allArgs).toContain('diff');
    expect(allArgs).toContain('commit');
    expect(allArgs).toContain('push');
  });

  it('skips commit when git diff --cached is empty (idempotency)', async () => {
    const { job, ctx } = makeJobAndCtx();
    ctx.spawnImpl = () => {
      // Return empty diff — nothing staged.
      return makeFakeProc({ stdout: '', exitCode: 0 });
    };
    const result = await runSkillInstallJob(job, ctx);
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(false); // skipped — no changes
  });
});

describe('runSkillInstallJob — error paths', () => {
  it('writes skill-install-failed attention when installer throws', async () => {
    const { job, ctx, calls } = makeJobAndCtx();
    ctx.applyConfirmedProposals = async () => {
      throw new Error('manifest parse failed');
    };
    const result = await runSkillInstallJob(job, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('apply-failed');
    expect(calls.attention[0].category).toBe('skill-install-failed');
    expect(calls.attention[0].body).toContain('manifest parse failed');
  });

  it('passes vendor-skills attention through when installer flags it', async () => {
    const { job, ctx, calls } = makeJobAndCtx();
    ctx.applyConfirmedProposals = async () => ({
      written: 1, added: 1, upgraded: 0, removed: 0,
      vendoredCount: 0,
      vendorAttention: { category: 'skill-sync-failed', severity: 'medium' },
    });
    const result = await runSkillInstallJob(job, ctx);
    expect(result.ok).toBe(true);
    expect(calls.attention.find((a) => a.category === 'skill-sync-failed')).toBeTruthy();
  });

  it('records commit-failed as a low-severity attention without failing install', async () => {
    const { job, ctx, calls } = makeJobAndCtx();
    ctx.spawnImpl = (cmd, args) => {
      // git add succeeds, diff shows changes, commit fails.
      // (commit is invoked via `git -c k=v -c k=v commit -m`, so the
      // verb is at args[args.indexOf('commit')] — just substring-match.)
      const argStr = args.join(' ');
      if (argStr.includes(' commit ')) {
        return makeFakeProc({ stderr: 'fatal: nothing to commit', exitCode: 1 });
      }
      const out = args[0] === 'diff' ? '.claude/skills.manifest.yaml\n' : '';
      return makeFakeProc({ stdout: out, exitCode: 0 });
    };
    const result = await runSkillInstallJob(job, ctx);
    expect(result.ok).toBe(true); // install completed despite commit failure
    const att = calls.attention.find((a) => a.category === 'skill-install-failed');
    expect(att).toBeTruthy();
    expect(att.severity).toBe('low');
    expect(att.title).toContain('git commit/push failed');
  });

  it('rejects malformed job via validation', async () => {
    const result = await runSkillInstallJob({ jobType: 'skill-install', jobId: 'x' }, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('skillInstallPayload-missing');
  });
});
