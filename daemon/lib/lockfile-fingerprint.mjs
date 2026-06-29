// lockfile-fingerprint — the read-only-deps safety gate (development-plan §5.2).
//
// The worktree dep-cache shares one installed node_modules across story worktrees
// via symlink. The open t2.micro question is corruption under parallel writes; the
// baked-in mitigation is "read-only-deps": a worktree gets the shared symlink ONLY
// when its dependency fingerprint (package.json + lockfile) matches the cached
// install — so the install step is skipped entirely (NO writes into the shared
// tree). A story that needs a new dependency won't match → it gets an independent
// install, never a stale symlink. This module computes the fingerprint and makes
// that decision; the flip to live is still gated on the 1-wave host spike.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];

/**
 * Fingerprint a worktree's dependency inputs: the manifest + whichever lockfile
 * exists. Returns a hex SHA-256, or null when there is no manifest at all (can't
 * fingerprint → must install independently). Injectable fs for tests.
 */
export function computeDepsFingerprint(worktreeDir, { fs = { readFileSync, existsSync } } = {}) {
  const manifest = join(worktreeDir, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  const hash = createHash('sha256');
  hash.update('manifest:');
  hash.update(fs.readFileSync(manifest));
  let sawLock = false;
  for (const name of LOCKFILES) {
    const p = join(worktreeDir, name);
    if (fs.existsSync(p)) {
      hash.update(`\nlock:${name}:`);
      hash.update(fs.readFileSync(p));
      sawLock = true;
    }
  }
  // No lockfile → fingerprint the manifest alone; the absence is itself part of
  // the identity (it differs from a worktree that DOES have one).
  if (!sawLock) hash.update('\nlock:none');
  return hash.digest('hex');
}

/** True when two fingerprints denote identical dependency inputs. */
export function depsMatch(prev, cur) {
  return Boolean(prev) && Boolean(cur) && prev === cur;
}

/**
 * Decide a worktree's dep-cache mode against the cached/shared install.
 *   • 'symlink-ro'  — fingerprints match → share the install read-only, skip npm.
 *   • 'independent' — mismatch / unknown → install into the worktree's own dir.
 *   • 'shared'      — explicit legacy fallback when caching is disabled.
 *
 * @returns {'symlink-ro'|'independent'}
 */
export function resolveDepCacheMode({ sharedFingerprint, worktreeFingerprint }) {
  return depsMatch(sharedFingerprint, worktreeFingerprint) ? 'symlink-ro' : 'independent';
}
