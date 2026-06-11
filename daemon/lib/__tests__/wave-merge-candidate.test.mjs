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

const { runWaveMerge, candidateWorktreeDir } = await import('../wave-merge-runner.mjs');

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

    // Self-describing commit trailer in the merge history (on the plan ref —
    // the bare's default HEAD is still `main`).
    const logOut = spawnSync(
      'git',
      ['--git-dir', bare, 'log', '--format=%s', '-n', '20', 'refs/heads/plan/automerge-app-initial'],
      { encoding: 'utf8' },
    ).stdout;
    expect(logOut).toMatch(/\[auto-resolved: src-page\.tsx\]/);

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
    expect(logOut).toMatch(/agentic build-fix after merge/);
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

    const result = await runWaveMerge(
      baseArgs(appId, planSlug, ['story-a'], {
        postMergeValidationCmd: 'false',
        fixBuild: async () => ({ attempted: true, reasoning: 'tried, changed nothing useful' }),
        writeAttention: async (a) => attentions.push(a),
      }),
    );

    expect(result.outcome).toBe('wave-build-failed');
    expect(bareRef(bare, 'refs/heads/plan/buildfix-bad-initial')).toBeNull();
    expect(bareRef(bare, 'refs/heads/main')).toBe(greenBefore);
    expect(attentions.some((a) => a.category === 'wave-build-failed')).toBe(true);
  });
});
