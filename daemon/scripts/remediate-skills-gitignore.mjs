#!/usr/bin/env node
/**
 * remediate-skills-gitignore.mjs — Story F.4 one-time remediation (2026-05-30).
 *
 * Repairs projects bootstrapped BEFORE the skills .gitignore fix. Those repos
 * committed a broken .claude/skills/.gitignore (a bare star that shadowed the
 * SKILL.md un-ignore rule), so their SKILL.md/meta.json were never committed
 * and every worktree got zero skills. The forward fix (registry.ts) only helps
 * NEW bootstraps; this script fixes the already-committed repos.
 *
 * For each target app's bare repo it, in a throwaway temp worktree on main:
 *   1. rewrites .claude/skills/.gitignore to the fixed pattern (adds the
 *      directory re-include line),
 *   2. re-vendors the manifest-pinned skills (re-fetches SKILL.md/meta.json),
 *   3. commits + pushes to origin/main if anything changed,
 *   4. tears the temp worktree down.
 *
 * Idempotent: a repo already on the fixed pattern with skills committed is a
 * clean no-op (nothing to commit).
 *
 * Usage (on the EC2 daemon host):
 *   node daemon/scripts/remediate-skills-gitignore.mjs <appId> [<appId> ...]
 *   node daemon/scripts/remediate-skills-gitignore.mjs --all
 *   node daemon/scripts/remediate-skills-gitignore.mjs --all --dry-run
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runVendorSkills } from '../lib/app-bootstrap-steps/vendor-skills.mjs';
import { bareRepoPath, BARE_REPOS_ROOT } from '../lib/story-worktree.mjs';

const FIXED_GITIGNORE = [
  '# Skill bodies are vendored via scripts/skills-sync.mjs (Story 3-C-2-1).',
  '# Skill manifests + meta.json are the source of truth and are committed;',
  '# the full skill content is fetched on demand from federation sources.',
  '#',
  '# 2026-05-30 (Story F) — the !*/ line re-includes the skill subdirectories',
  '# so the deeper SKILL.md / meta.json un-ignore rules are reachable. Without',
  '# it the bare * ignores the directories and git never descends into them.',
  '*',
  '!*/',
  '!.gitignore',
  '!*/SKILL.md',
  '!*/meta.json',
  '',
].join('\n');

const GITIGNORE_REL = '.claude/skills/.gitignore';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function log(msg) {
  console.log(`[remediate-skills] ${msg}`);
}

// True if the gitignore content lacks the directory re-include line (the
// `!` + `*` + `/` rule). Detected via regex so we don't reformat repos that
// are already fixed.
function isBrokenGitignore(content) {
  return !/^\s*!\*\/\s*$/m.test(content);
}

async function remediateApp(appId, { dryRun }) {
  const bare = bareRepoPath(appId);
  if (!existsSync(bare)) {
    log(`SKIP ${appId}: no bare repo at ${bare}`);
    return { appId, skipped: true, reason: 'no-bare-repo' };
  }

  const tmp = mkdtempSync(join(tmpdir(), `remediate-${appId}-`));
  const wt = join(tmp, 'wt');
  try {
    const add = git(['--git-dir', bare, 'worktree', 'add', '--force', wt, 'main'], BARE_REPOS_ROOT);
    if (add.code !== 0) {
      log(`SKIP ${appId}: worktree add failed: ${add.stderr.trim()}`);
      return { appId, skipped: true, reason: 'worktree-add-failed' };
    }

    const giPath = join(wt, GITIGNORE_REL);
    if (!existsSync(giPath)) {
      log(`SKIP ${appId}: no ${GITIGNORE_REL} (stub boilerplate or no skills)`);
      return { appId, skipped: true, reason: 'no-skills-gitignore' };
    }

    const before = readFileSync(giPath, 'utf8');
    const wasBroken = isBrokenGitignore(before);
    if (wasBroken) {
      log(`${appId}: gitignore is BROKEN — ${dryRun ? 'WOULD fix + re-vendor + commit' : 'fixing'}`);
      if (dryRun) return { appId, skipped: false, changed: true, dryRun: true, wasBroken };
      writeFileSync(giPath, FIXED_GITIGNORE);
    } else {
      log(`${appId}: gitignore already fixed`);
      if (dryRun) return { appId, skipped: false, changed: false, dryRun: true };
    }

    // Re-vendor so the on-disk SKILL.md/meta.json exist to be committed (they
    // were never committed under the broken pattern, and a fresh main checkout
    // doesn't have them). Idempotent: skills-sync writes byte-identical bodies.
    if (!dryRun) {
      const vend = await runVendorSkills({ worktreeDir: wt, onOutput: () => {} });
      log(`${appId}: vendor-skills → ${JSON.stringify(vend)}`);
    }

    const status = git(['status', '--porcelain'], wt);
    const hasChanges = status.stdout.trim().length > 0;
    if (!hasChanges) {
      log(`${appId}: nothing to commit (already remediated)`);
      return { appId, skipped: false, changed: false };
    }
    if (dryRun) {
      log(`${appId}: [dry-run] WOULD commit:\n${status.stdout}`);
      return { appId, skipped: false, changed: true, dryRun: true };
    }

    git(['add', '-A'], wt);
    const commit = git(
      ['commit', '-m', 'fix(skills): remediate .gitignore + commit vendored SKILL.md (Story F.4)'],
      wt,
    );
    if (commit.code !== 0) {
      log(`${appId}: commit failed: ${commit.stderr.trim()}`);
      return { appId, skipped: false, changed: true, committed: false };
    }
    const push = git(['push', 'origin', 'main'], wt);
    if (push.code !== 0) {
      log(`${appId}: push failed (commit landed locally): ${push.stderr.trim()}`);
      return { appId, skipped: false, changed: true, committed: true, pushed: false };
    }
    log(`${appId}: ✅ remediated + pushed`);
    return { appId, skipped: false, changed: true, committed: true, pushed: true };
  } finally {
    // Tear down the temp worktree + git metadata.
    git(['--git-dir', bare, 'worktree', 'remove', '--force', wt], BARE_REPOS_ROOT);
    git(['--git-dir', bare, 'worktree', 'prune'], BARE_REPOS_ROOT);
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  let appIds = args.filter((a) => !a.startsWith('--'));

  if (all) {
    if (!existsSync(BARE_REPOS_ROOT)) {
      log(`no bare repos root at ${BARE_REPOS_ROOT}`);
      process.exit(1);
    }
    appIds = readdirSync(BARE_REPOS_ROOT)
      .filter((d) => d.endsWith('.git'))
      .map((d) => d.replace(/\.git$/, ''));
  }
  if (appIds.length === 0) {
    log('usage: remediate-skills-gitignore.mjs <appId> [...] | --all [--dry-run]');
    process.exit(1);
  }

  log(`${dryRun ? '[DRY RUN] ' : ''}remediating ${appIds.length} app(s): ${appIds.join(', ')}`);
  const results = [];
  for (const appId of appIds) {
    try {
      results.push(await remediateApp(appId, { dryRun }));
    } catch (err) {
      log(`${appId}: ERROR ${err.message}`);
      results.push({ appId, error: err.message });
    }
  }
  const changed = results.filter((r) => r.changed && r.committed).length;
  const skipped = results.filter((r) => r.skipped).length;
  const errored = results.filter((r) => r.error).length;
  log(`done: ${changed} remediated, ${skipped} skipped, ${errored} errored`);
  process.exit(errored > 0 ? 1 : 0);
}

main();
