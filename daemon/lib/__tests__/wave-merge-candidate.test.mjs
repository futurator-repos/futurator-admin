/**
 * Real-git acceptance tests for the Story B candidate-worktree flow
 * (agentic-integration, 2026-05-29).
 *
 * These exercise runWaveMerge end-to-end against a real bare repo with
 * injected non-sudo git/shell runners (production shells out as
 * `sudo -u ubuntu`; tests inject plain git). They pin the three properties
 * the pacman-2 fix depends on:
 *   1. clean merges advance `plan/<slug>` atomically to the built candidate;
 *   2. a conflicting story HALTS, leaves green UNTOUCHED, KEEPS the candidate
 *      worktree for the operator, and records a durable conflict event;
 *   3. the pacman-2 scenario (two stories rewriting the same hot file) no
 *      longer wedges — it surfaces as a real, recorded conflict.
 *
 * Env roots are redirected to a tmpdir BEFORE importing the module (the
 * module freezes WORKTREE_ROOT_DEFAULT / BARE_REPOS_ROOT at load).
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'wmr-cand-'));
process.env.FUTURATOR_WORKTREE_ROOT = join(TMP, 'worktrees');
process.env.FUTURATOR_BARE_REPOS_ROOT = join(TMP, 'repos');
process.env.FUTURATOR_LEGACY_PROJECTS_ROOT = join(TMP, 'projects');
mkdirSync(process.env.FUTURATOR_LEGACY_PROJECTS_ROOT, { recursive: true });

const { runWaveMerge, candidateWorktreeDir, composeQualityGate } = await import(
  '../wave-merge-runner.mjs'
);

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

// ── injected exec surface (no sudo) ──
const gitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return Promise.resolve({ code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' });
};
const shellRunner = (command, cwd) => {
  const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' });
  return Promise.resolve({ code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' });
};
const bareOpCwd = process.env.FUTURATOR_LEGACY_PROJECTS_ROOT;

// Synchronous git for test setup/assertions.
const g = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const bareRef = (bare, ref) => {
  const r = spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', ref], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
};

/**
 * Build a bare repo with `main` + the given wip branches. `files` per branch
 * is a map of relative path → content (applied on top of main's seed).
 */
function buildBareRepo(appId, wipBranches) {
  const seed = join(TMP, `seed-${appId}`);
  mkdirSync(seed, { recursive: true });
  g(['init', '-b', 'main'], seed);
  g(['config', 'user.email', 't@example.com'], seed);
  g(['config', 'user.name', 'Test'], seed);
  writeFileSync(join(seed, 'package.json'), '{"name":"app","version":"1.0.0"}\n');
  writeFileSync(join(seed, 'src-page.tsx'), 'export default function Page(){return null;}\n');
  g(['add', '-A'], seed);
  g(['commit', '-m', 'init'], seed);

  for (const { branch, files } of wipBranches) {
    g(['checkout', 'main'], seed);
    g(['checkout', '-b', branch], seed);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(seed, dirname(path)), { recursive: true });
      writeFileSync(join(seed, path), content);
    }
    g(['add', '-A'], seed);
    g(['commit', '-m', branch], seed);
  }
  g(['checkout', 'main'], seed);

  const bare = join(process.env.FUTURATOR_BARE_REPOS_ROOT, `${appId}.git`);
  mkdirSync(process.env.FUTURATOR_BARE_REPOS_ROOT, { recursive: true });
  g(['clone', '--bare', seed, bare], TMP);
  // Drop the origin remote so the non-blocking push is a fast no-op (and
  // never mutates the seed).
  spawnSync('git', ['--git-dir', bare, 'remote', 'remove', 'origin'], { encoding: 'utf8' });
  return bare;
}

const baseArgs = (appId, planSlug, storyIds, extra = {}) => ({
  appId,
  planId: `plan_${appId}`,
  planSlug,
  epicId: 'e1',
  waveNumber: 0,
  storyIds,
  postMergeValidationCmd: null, // skip the build gate — these test merge+advance
  writeAttention: async () => {},
  jobId: 'job-1',
  gitRunner,
  shellRunner,
  bareOpCwd,
  ...extra,
});

describe('runWaveMerge — candidate worktree + advance-on-green', () => {
  it('clean merges advance plan/<slug> to the built candidate SHA', { timeout: 30000 }, async () => {
    const appId = 'clean-app';
    const planSlug = 'clean-app-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
      { branch: 'wip/story-b', files: { 'feature-b.ts': 'export const b = 2;\n' } },
    ]);
    const greenBefore = bareRef(bare, 'refs/heads/main');
    expect(bareRef(bare, 'refs/heads/plan/clean-app-initial')).toBeNull();

    const result = await runWaveMerge(baseArgs(appId, planSlug, ['story-a', 'story-b']));

    expect(result.outcome).toBe('success');
    expect(result.mergedStoryIds).toEqual(['story-a', 'story-b']);
    // plan/<slug> now exists and points at the candidate HEAD (the result SHA).
    const greenAfter = bareRef(bare, 'refs/heads/plan/clean-app-initial');
    expect(greenAfter).toBe(result.pushSha);
    expect(greenAfter).not.toBe(greenBefore);
    // The throwaway candidate worktree is reaped on success.
    expect(existsSync(candidateWorktreeDir({ appId, planSlug, jobId: 'job-1' }))).toBe(false);
  });

  it('a conflict HALTS: green untouched, candidate kept, event recorded', { timeout: 30000 }, async () => {
    const appId = 'pacman-app';
    const planSlug = 'pacman-app-initial';
    // The pacman-2 villain: two stories rewrite the SAME hot file's only line.
    const bare = buildBareRepo(appId, [
      {
        branch: 'wip/story-a',
        files: { 'src-page.tsx': 'export default function Page(){return <A/>;}\n' },
      },
      {
        branch: 'wip/story-b',
        files: { 'src-page.tsx': 'export default function Page(){return <B/>;}\n' },
      },
    ]);
    const greenBefore = bareRef(bare, 'refs/heads/main');

    const conflictEvents = [];
    const attentions = [];
    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a', 'story-b'], {
        recordConflictEvent: async (e) => conflictEvents.push(e),
        writeAttention: async (a) => attentions.push(a),
      }),
    );

    expect(result.outcome).toBe('merge-conflict');
    expect(result.conflictedAtStoryId).toBe('story-b'); // story-a merged first, b collides
    expect(result.conflictedFiles).toContain('src-page.tsx');

    // GREEN IS UNTOUCHED — plan/<slug> was never created (this was wave 0).
    expect(bareRef(bare, 'refs/heads/plan/pacman-app-initial')).toBeNull();
    expect(bareRef(bare, 'refs/heads/main')).toBe(greenBefore);

    // The candidate worktree is KEPT for the operator to resolve in.
    expect(existsSync(result.coordinatorWorktree)).toBe(true);

    // A durable, judgeable conflict event was recorded — WITH the captured
    // pre-abort blob (markers intact).
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0].mode).toBe('halted');
    expect(conflictEvents[0].files).toContain('src-page.tsx');
    const blob = conflictEvents[0].blobs.find((b) => b.file === 'src-page.tsx');
    expect(blob?.content).toMatch(/<<<<<<</);
    expect(blob?.content).toMatch(/>>>>>>>/);

    // And an attention item was raised for the operator.
    expect(attentions).toHaveLength(1);
    expect(attentions[0].category).toBe('merge-conflict');
  });

  // Story E Tier 2 — auto-merge ON: the resolver integrates both sides, the
  // wave LANDS, green advances, and the event is recorded as auto-resolved.
  it('auto-merge ON: resolver lands the conflict, green advances, audited', { timeout: 30000 }, async () => {
    const appId = 'automerge-app';
    const planSlug = 'automerge-app-initial';
    const bare = buildBareRepo(appId, [
      {
        branch: 'wip/story-a',
        files: { 'src-page.tsx': 'export default function Page(){return <A/>;}\n' },
      },
      {
        branch: 'wip/story-b',
        files: { 'src-page.tsx': 'export default function Page(){return <B/>;}\n' },
      },
    ]);
    const greenBefore = bareRef(bare, 'refs/heads/main');

    const conflictEvents = [];
    // Fake resolver: integrate both sides by stripping markers + keeping both.
    const resolveConflict = async ({ worktreeDir, conflictedFiles }) => {
      const { readFileSync, writeFileSync } = await import('node:fs');
      for (const f of conflictedFiles) {
        const abs = `${worktreeDir}/${f}`;
        const merged = readFileSync(abs, 'utf8')
          .split('\n')
          .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l))
          .join('\n');
        writeFileSync(abs, merged + '\n// integrated both A and B\n');
      }
      return { resolved: true, reasoning: 'combined A + B renderers' };
    };

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a', 'story-b'], {
        recordConflictEvent: async (e) => conflictEvents.push(e),
        resolveConflict,
      }),
    );

    // The wave LANDED (no halt) and green advanced.
    expect(result.outcome).toBe('success');
    expect(result.mergedStoryIds).toEqual(['story-a', 'story-b']);
    const greenAfter = bareRef(bare, 'refs/heads/plan/automerge-app-initial');
    expect(greenAfter).toBe(result.pushSha);
    expect(greenAfter).not.toBe(greenBefore);

    // Audit: the conflict was recorded as auto-resolved with the reasoning.
    const autoEvent = conflictEvents.find((e) => e.mode === 'auto-resolved');
    expect(autoEvent).toBeTruthy();
    expect(autoEvent.files).toContain('src-page.tsx');
    expect(autoEvent.reasoning).toMatch(/combined/i);

    // Self-describing merge history (on the plan ref — the bare's default HEAD
    // is still `main`). dino1 (2026-06-13): the subject stays short and the
    // auto-resolved file list moved to the commit BODY, so read %B (full msg).
    const logOut = spawnSync(
      'git',
      ['--git-dir', bare, 'log', '--format=%B', '-n', '20', 'refs/heads/plan/automerge-app-initial'],
      { encoding: 'utf8' },
    ).stdout;
    expect(logOut).toMatch(/Auto-resolved: src-page\.tsx/);
    // Subject itself is now clean (no inline bracket dump).
    const subjOut = spawnSync(
      'git',
      ['--git-dir', bare, 'log', '--format=%s', '-n', '20', 'refs/heads/plan/automerge-app-initial'],
      { encoding: 'utf8' },
    ).stdout;
    expect(subjOut).toMatch(/merge story .* into wave$/m);
    expect(subjOut).not.toMatch(/\[auto-resolved/);

    // Candidate reaped on success.
    expect(existsSync(candidateWorktreeDir({ appId, planSlug, jobId: 'job-1' }))).toBe(false);
  });

  // Story E Tier 2 — a resolver that LEAVES markers must NOT land: halt + green
  // untouched (the marker-check backstop rejects a bad resolution).
  it('auto-merge ON but resolver leaves markers → halts, green untouched', { timeout: 30000 }, async () => {
    const appId = 'automerge-bad';
    const planSlug = 'automerge-bad-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'src-page.tsx': 'export const x = <A/>;\n' } },
      { branch: 'wip/story-b', files: { 'src-page.tsx': 'export const x = <B/>;\n' } },
    ]);
    const greenBefore = bareRef(bare, 'refs/heads/main');
    // Resolver claims success but doesn't actually remove markers.
    const resolveConflict = async () => ({ resolved: true, reasoning: 'lied' });

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a', 'story-b'], { resolveConflict }),
    );

    expect(result.outcome).toBe('merge-conflict');
    expect(bareRef(bare, 'refs/heads/plan/automerge-bad-initial')).toBeNull();
    expect(bareRef(bare, 'refs/heads/main')).toBe(greenBefore);
  });

  // pacman1 disease (2026-06-11) — conflicts on '@generated' files and
  // scratch paths resolve MECHANICALLY: no agent resolver spawn, the wave
  // lands, and the conflict event is audited as mechanical.
  it('mechanical resolution: @generated + .context conflicts land without the agent resolver', { timeout: 30000 }, async () => {
    const appId = 'mech-app';
    const planSlug = 'mech-app-initial';
    const GEN_A = '// @generated by scripts/generate-wiring.mjs — DO NOT EDIT.\nexport const page = "A";\n';
    const GEN_B = '// @generated by scripts/generate-wiring.mjs — DO NOT EDIT.\nexport const page = "B";\n';
    const bare = buildBareRepo(appId, [
      {
        branch: 'wip/story-a',
        files: { 'gen-page.tsx': GEN_A, '.context/notes.md': 'story A observations\n' },
      },
      {
        branch: 'wip/story-b',
        files: { 'gen-page.tsx': GEN_B, '.context/notes.md': 'story B observations\n' },
      },
    ]);

    let resolverCalls = 0;
    const conflictEvents = [];
    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a', 'story-b'], {
        resolveConflict: async () => {
          resolverCalls += 1;
          return { resolved: false, reasoning: 'should never be reached' };
        },
        recordConflictEvent: async (e) => conflictEvents.push(e),
      }),
    );

    expect(result.outcome).toBe('success');
    expect(resolverCalls).toBe(0);
    const greenAfter = bareRef(bare, 'refs/heads/plan/mech-app-initial');
    expect(greenAfter).toBe(result.pushSha);
    const mech = conflictEvents.find((e) => e.mode === 'auto-resolved');
    expect(mech).toBeTruthy();
    expect(mech.reasoning).toMatch(/mechanical/i);
    // @generated file kept HEAD's side (ours); scratch took the incoming side.
    const show = spawnSync(
      'git',
      ['--git-dir', bare, 'show', 'refs/heads/plan/mech-app-initial:gen-page.tsx'],
      { encoding: 'utf8' },
    ).stdout;
    expect(show).toContain('export const page = "A"');
  });

  // pacman1 (2026-06-11) — agentic build-fix: validation fails on the merged
  // union, the fixBuild hook repairs the candidate, revalidation passes, the
  // fix is committed with an audit trailer, and green advances.
  it('build-fix ON: agent repairs failing validation, fix committed, green advances', { timeout: 30000 }, async () => {
    const appId = 'buildfix-app';
    const planSlug = 'buildfix-app-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
      { branch: 'wip/story-b', files: { 'feature-b.ts': 'export const b = 2;\n' } },
    ]);

    const fixCalls = [];
    const fixBuild = async ({ worktreeDir, validationOutput }) => {
      fixCalls.push(validationOutput);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${worktreeDir}/contract.ts`, 'export type Fixed = true;\n');
      return { attempted: true, reasoning: 'created the missing contract module' };
    };

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a', 'story-b'], {
        // Fails until contract.ts exists — stands in for "merged union
        // doesn't typecheck because a story's contract file never shipped".
        postMergeValidationCmd: 'test -f contract.ts',
        fixBuild,
      }),
    );

    expect(result.outcome).toBe('success');
    expect(fixCalls).toHaveLength(1);
    const greenAfter = bareRef(bare, 'refs/heads/plan/buildfix-app-initial');
    expect(greenAfter).toBe(result.pushSha);

    // The fix landed as an audited commit on the advanced branch.
    const logOut = spawnSync(
      'git',
      ['--git-dir', bare, 'log', '--format=%s', '-n', '5', 'refs/heads/plan/buildfix-app-initial'],
      { encoding: 'utf8' },
    ).stdout;
    expect(logOut).toMatch(/agentic build-fix \(attempt 1\)/);
    const show = spawnSync(
      'git',
      ['--git-dir', bare, 'show', '--stat', 'refs/heads/plan/buildfix-app-initial'],
      { encoding: 'utf8' },
    ).stdout;
    expect(show).toMatch(/contract\.ts/);
  });

  // Build-fix attempted but the gate STILL fails → halt exactly like before
  // (wave-build-failed, green untouched, attention raised).
  it('build-fix attempted but validation still red → halts, green untouched', { timeout: 30000 }, async () => {
    const appId = 'buildfix-bad';
    const planSlug = 'buildfix-bad-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
    ]);
    const greenBefore = bareRef(bare, 'refs/heads/main');
    const attentions = [];
    let fixCalls = 0;

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        postMergeValidationCmd: 'false',
        fixBuild: async () => {
          fixCalls += 1;
          return { attempted: true, reasoning: 'tried, changed nothing useful' };
        },
        writeAttention: async (a) => attentions.push(a),
      }),
    );

    expect(result.outcome).toBe('wave-build-failed');
    // pacman1 F2 — bounded LOOP: exactly 2 attempts, then halt.
    expect(fixCalls).toBe(2);
    expect(bareRef(bare, 'refs/heads/plan/buildfix-bad-initial')).toBeNull();
    expect(bareRef(bare, 'refs/heads/main')).toBe(greenBefore);
    expect(attentions.some((a) => a.category === 'wave-build-failed')).toBe(true);
  });

  // pacman1 F2 (2026-06-12) — the EXACT pacman1 failure shape: the gate
  // fails TWO independent ways (test stage, then a lint error the original
  // one-shot fixer never saw). The bounded loop fixes failure #1, the
  // revalidation surfaces failure #2, attempt 2 receives THAT output and
  // fixes it → green. Pre-fix this halted with the partial fix reaped, and
  // Retry gate reproduced the loop forever.
  it('TWO-error sequence: attempt 1 fixes the first, attempt 2 sees + fixes the second → green', { timeout: 30000 }, async () => {
    const appId = 'buildfix-two';
    const planSlug = 'buildfix-two-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
    ]);

    const fixInputs = [];
    const fixBuild = async ({ worktreeDir, validationOutput }) => {
      fixInputs.push(validationOutput);
      const { writeFileSync } = await import('node:fs');
      if (validationOutput.includes('TEST-STAGE-RED')) {
        writeFileSync(`${worktreeDir}/fix1.ok`, '1\n');
        return { attempted: true, reasoning: 'fixed the failing unit test' };
      }
      writeFileSync(`${worktreeDir}/fix2.ok`, '1\n');
      return { attempted: true, reasoning: 'fixed the eslint error' };
    };

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        // Two failure classes with distinct signatures, like pacman1's
        // test-then-eslint: stage 1 red until fix1.ok, stage 2 red until
        // fix2.ok.
        qualityGate: {
          mechanical: [],
          blocking: {
            prototype: ['true'],
            mvp: [
              'test -f fix1.ok || { echo TEST-STAGE-RED; exit 1; }',
              'test -f fix2.ok || { echo LINT-STAGE-RED; exit 1; }',
            ],
            production: ['true'],
          },
        },
        rigor: 'mvp',
        coordinatorInstallFn: async () => {},
        fixBuild,
      }),
    );

    expect(result.outcome).toBe('success');
    expect(fixInputs).toHaveLength(2);
    // Attempt 1 saw the FIRST failure; attempt 2 saw the SECOND (the
    // original one-shot fixer never saw failure #2 at all).
    expect(fixInputs[0]).toContain('TEST-STAGE-RED');
    expect(fixInputs[1]).toContain('LINT-STAGE-RED');
    expect(fixInputs[1]).not.toContain('TEST-STAGE-RED');
    // Both fixes landed as audited commits on the advanced branch.
    const logOut = spawnSync(
      'git',
      ['--git-dir', bare, 'log', '--format=%s', '-n', '6', `refs/heads/plan/${planSlug}`],
      { encoding: 'utf8' },
    ).stdout;
    expect(logOut).toMatch(/agentic build-fix \(attempt 1\)/);
    expect(logOut).toMatch(/agentic build-fix \(attempt 2\)/);
    // QA-D stage truth on the success result: everything pass, fix audited.
    expect(result.stages.every((s) => s.status === 'pass')).toBe(true);
    expect(result.stages.some((s) => s.fixedByAgent)).toBe(true);
  });
});

// ── v2.6 M2 — wave-gate VQA hook (runVqa) ───────────────────────────────────
describe('runWaveMerge — wave VQA hook', () => {
  it('vqa env-blocked behaves EXACTLY like a build failure (green untouched)', { timeout: 30000 }, async () => {
    const appId = 'vqa-envblocked';
    const planSlug = 'vqa-envblocked-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
    ]);
    const greenBefore = bareRef(bare, 'refs/heads/main');
    const attentions = [];

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        runVqa: async () => ({ outcome: 'env-blocked', bootLogTail: 'Turbopack panic: cache corrupt' }),
        writeAttention: async (a) => attentions.push(a),
      }),
    );

    expect(result.outcome).toBe('wave-build-failed');
    expect(result.vqa.outcome).toBe('env-blocked');
    expect(bareRef(bare, 'refs/heads/plan/vqa-envblocked-initial')).toBeNull();
    expect(bareRef(bare, 'refs/heads/main')).toBe(greenBefore);
    const card = attentions.find((a) => a.category === 'wave-build-failed');
    expect(card).toBeTruthy();
    expect(JSON.stringify(card)).toContain('Turbopack panic');
    // The candidate was reaped — a retry mints a fresh one.
    expect(existsSync(candidateWorktreeDir({ appId, planSlug, jobId: 'job-1' }))).toBe(false);
  });

  it('vqa fix-forward NEVER blocks: green advances, vqa rides the result', { timeout: 30000 }, async () => {
    const appId = 'vqa-ff';
    const planSlug = 'vqa-ff-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
    ]);
    let sawCandidate = null;

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        runVqa: async ({ candidateDir, mergedStoryIds }) => {
          sawCandidate = { candidateDir, mergedStoryIds };
          return {
            outcome: 'fix-forward',
            verdicts: [{ storyId: 'story-a', acId: 'AC-1', result: 'FAIL' }],
            fixesApplied: [],
            fixForward: [{ storyId: 'story-a', acId: 'AC-1', expected: 'x', observed: 'y' }],
            unverifiable: [],
            reportPath: '.context/wave-0-vqa-report.md',
          };
        },
      }),
    );

    expect(result.outcome).toBe('success');
    expect(result.vqa.outcome).toBe('fix-forward');
    expect(result.vqa.fixForward).toHaveLength(1);
    expect(sawCandidate.mergedStoryIds).toEqual(['story-a']);
    expect(bareRef(bare, 'refs/heads/plan/vqa-ff-initial')).toBe(result.pushSha);
  });

  it('a CRASHING vqa hook is non-blocking: logged, green still advances', { timeout: 30000 }, async () => {
    const appId = 'vqa-crash';
    const planSlug = 'vqa-crash-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
    ]);

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        runVqa: async () => {
          throw new Error('judge stack melted');
        },
      }),
    );

    expect(result.outcome).toBe('success');
    expect(result.vqa.outcome).toBe('skipped');
    expect(result.vqa.reason).toContain('vqa-crashed');
    expect(bareRef(bare, 'refs/heads/plan/vqa-crash-initial')).toBe(result.pushSha);
  });
});

// ── v2.6 M4 — rigor-composed quality gates ──────────────────────────────────
describe('composeQualityGate', () => {
  const qualityGate = {
    mechanical: ['node scripts/generate-wiring.mjs', 'npm run format --if-present'],
    blocking: {
      prototype: ['npm run build'],
      mvp: ['npm run build', 'npm run test --if-present'],
      production: ['npm run build', 'npm run knip --if-present'],
    },
  };

  it('composes the tier for the given rigor as ONE &&-chain (existing machinery applies)', () => {
    const g = composeQualityGate({ qualityGate, rigor: 'mvp', postMergeValidationCmd: 'legacy' });
    expect(g.source).toBe('quality-gate');
    expect(g.blockingCmd).toBe('npm run build && npm run test --if-present');
    expect(g.mechanical).toEqual(qualityGate.mechanical);
  });

  it('tiers compose up: production adds enforcement on top of build', () => {
    const g = composeQualityGate({ qualityGate, rigor: 'production', postMergeValidationCmd: null });
    expect(g.blockingCmd).toContain('knip');
    const p = composeQualityGate({ qualityGate, rigor: 'prototype', postMergeValidationCmd: null });
    expect(p.blockingCmd).toBe('npm run build');
  });

  it('falls back to the legacy single command without qualityGate or rigor', () => {
    expect(
      composeQualityGate({ qualityGate: null, rigor: 'mvp', postMergeValidationCmd: 'npm test' }),
    ).toEqual({
      mechanical: [],
      blockingCmd: 'npm test',
      // QA-D — legacy command runs as a single recorded stage.
      blockingStages: ['npm test'],
      source: 'legacy',
    });
    expect(
      composeQualityGate({ qualityGate, rigor: null, postMergeValidationCmd: 'npm test' }).source,
    ).toBe('legacy');
    expect(
      composeQualityGate({ qualityGate, rigor: 'unknown-tier', postMergeValidationCmd: null })
        .blockingCmd,
    ).toBeNull();
  });

  // QA-D (pong1 2026-06-12) — the tier is also exposed stage-by-stage so the
  // runner can record one real outcome per command (truthful matrix).
  it('exposes blockingStages alongside the &&-chain for per-stage outcomes', () => {
    const g = composeQualityGate({ qualityGate, rigor: 'mvp', postMergeValidationCmd: null });
    expect(g.blockingStages).toEqual(['npm run build', 'npm run test --if-present']);
    const legacy = composeQualityGate({
      qualityGate: null,
      rigor: null,
      postMergeValidationCmd: null,
    });
    expect(legacy.blockingStages).toEqual([]);
  });
});

describe('runWaveMerge — quality stages', () => {
  it('mechanical output rides the regenerated-files commit; never fails the gate', { timeout: 30000 }, async () => {
    const appId = 'mech-stage-app';
    const planSlug = 'mech-stage-app-initial';
    const bare = buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
    ]);

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        rigor: 'mvp',
        qualityGate: {
          // First mechanical step auto-fixes a tracked file (stands in for
          // prettier --write); second one FAILS — and must be ignored.
          mechanical: ['echo "// formatted" >> feature-a.ts', 'exit 1'],
          blocking: { prototype: ['true'], mvp: ['true'], production: ['true'] },
        },
        coordinatorInstallFn: async () => {},
      }),
    );

    expect(result.outcome).toBe('success');
    const show = spawnSync(
      'git',
      ['--git-dir', bare, 'log', '--format=%s', '-n', '3', 'refs/heads/plan/mech-stage-app-initial'],
      { encoding: 'utf8' },
    ).stdout;
    expect(show).toContain('regenerated files from post-merge validation');
    const content = spawnSync(
      'git',
      ['--git-dir', bare, 'show', 'refs/heads/plan/mech-stage-app-initial:feature-a.ts'],
      { encoding: 'utf8' },
    ).stdout;
    expect(content).toContain('// formatted');
  });

  it('blocking tier is selected by rigor (production enforcement fails, mvp passes)', { timeout: 60000 }, async () => {
    const appId = 'rigor-app';
    const planSlug = 'rigor-app-initial';
    buildBareRepo(appId, [
      { branch: 'wip/story-a', files: { 'feature-a.ts': 'export const a = 1;\n' } },
    ]);
    const gateDef = {
      mechanical: [],
      blocking: { prototype: ['true'], mvp: ['true'], production: ['true', 'false'] },
    };

    const prod = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        rigor: 'production',
        qualityGate: gateDef,
        coordinatorInstallFn: async () => {},
      }),
    );
    expect(prod.outcome).toBe('wave-build-failed');
    // QA-D (pong1) — per-stage truth on the failure result: first stage
    // passed, second failed; nothing after it (stop-at-first-failure).
    expect(prod.stages.map((s) => s.status)).toEqual(['pass', 'fail']);

    const mvp = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        rigor: 'mvp',
        qualityGate: gateDef,
        coordinatorInstallFn: async () => {},
        jobId: 'job-2',
      }),
    );
    expect(mvp.outcome).toBe('success');
    // QA-D — success result carries the real outcomes too.
    expect(mvp.stages).toEqual([
      expect.objectContaining({ cmd: 'true', status: 'pass' }),
    ]);
  });
});

// QA-D (pong1 2026-06-12) — stage labels are lexical, used only as matrix
// column headers.
describe('stageLabel', () => {
  it('derives mechanical labels from common command shapes', async () => {
    const { stageLabel } = await import('../wave-merge-runner.mjs');
    expect(stageLabel('npm run build')).toBe('build');
    expect(stageLabel('npm run test --if-present')).toBe('test');
    expect(stageLabel('npx eslint . --max-warnings 200')).toBe('eslint');
    expect(stageLabel('npx tsc --noEmit')).toBe('tsc');
    expect(stageLabel('[ -f .eslintrc ] && npx eslint .')).toBe('eslint');
    expect(stageLabel('true')).toBe('true');
  });
});
