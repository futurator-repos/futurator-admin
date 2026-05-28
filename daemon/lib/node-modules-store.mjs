/**
 * node-modules-store.mjs — Phase 1 worktree rollout (2026-05-19).
 *
 * Shared `node_modules/` store with refcounted symlinks.
 *
 * Layout:
 *
 *   /home/ubuntu/.node_modules_store/<appId>/<lockfileSha>/
 *     node_modules/         (full install — large)
 *     .refcount.json        ({ "count": N, "createdAt": ISO, "lastBumpedAt": ISO })
 *
 * Each per-story worktree symlinks its `<worktree>/node_modules` to the
 * matching `<store>/node_modules` directory, sharing the full install
 * across every worktree that has the same `package-lock.json` content.
 *
 * Refcount sidecar tracks how many worktrees reference each store entry.
 * The orphan reaper consults `.refcount.json` + a filesystem-symlink scan
 * before deleting an entry (refcount=0 AND no live symlink).
 *
 * See `docs/concepts/pipeline-v2/worktree-rollout-design.md` §1 for the
 * full design rationale.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const STORE_ROOT =
  process.env.FUTURATOR_NODE_MODULES_STORE_ROOT || '/home/ubuntu/.node_modules_store';

/**
 * Compute the lockfile fingerprint that keys the store. Tries
 * package-lock.json, then pnpm-lock.yaml, then yarn.lock. Returns the
 * fingerprint string or null if no lockfile exists.
 */
export function computeLockfileSha(worktreeDir) {
  if (!worktreeDir) throw new Error('computeLockfileSha: worktreeDir required');
  const candidates = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  for (const name of candidates) {
    const path = join(worktreeDir, name);
    if (existsSync(path)) {
      const content = readFileSync(path);
      const hash = createHash('sha256').update(content).digest('hex');
      return `${name.replace(/[^a-z0-9]/gi, '-')}-${hash.slice(0, 16)}`;
    }
  }
  return null;
}

/**
 * Path to a store entry's node_modules tree.
 */
export function storeNodeModulesPath(appId, lockfileSha) {
  assertSafeAppId(appId);
  assertSafeSha(lockfileSha);
  return join(STORE_ROOT, appId, lockfileSha, 'node_modules');
}

function storeRefcountPath(appId, lockfileSha) {
  assertSafeAppId(appId);
  assertSafeSha(lockfileSha);
  return join(STORE_ROOT, appId, lockfileSha, '.refcount.json');
}

function assertSafeAppId(appId) {
  if (typeof appId !== 'string' || !/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(appId)) {
    throw new Error(`node-modules-store: appId "${appId}" rejected (must be kebab-case slug)`);
  }
}

function assertSafeSha(sha) {
  if (typeof sha !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sha) || sha.includes('..')) {
    throw new Error(`node-modules-store: lockfileSha "${sha}" rejected`);
  }
}

/**
 * Read the refcount sidecar. Returns { count, createdAt, lastBumpedAt }
 * with default { count: 0, ... } when the file is absent or malformed.
 */
export function readRefcount(appId, lockfileSha) {
  const path = storeRefcountPath(appId, lockfileSha);
  if (!existsSync(path)) {
    return { count: 0, createdAt: null, lastBumpedAt: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      count: typeof parsed.count === 'number' ? parsed.count : 0,
      createdAt: parsed.createdAt || null,
      lastBumpedAt: parsed.lastBumpedAt || null,
    };
  } catch {
    // Corrupt sidecar: treat as zero, let caller decide.
    return { count: 0, createdAt: null, lastBumpedAt: null };
  }
}

function writeRefcount(appId, lockfileSha, value) {
  const path = storeRefcountPath(appId, lockfileSha);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/**
 * Bump refcount by `delta` (positive = setup, negative = teardown). Clamps
 * to zero — refcounts never go negative even if teardown over-fires.
 */
export function bumpRefcount(appId, lockfileSha, delta) {
  const current = readRefcount(appId, lockfileSha);
  const now = new Date().toISOString();
  const next = {
    count: Math.max(0, current.count + delta),
    createdAt: current.createdAt || now,
    lastBumpedAt: now,
  };
  writeRefcount(appId, lockfileSha, next);
  return next;
}

/**
 * Ensure a store entry exists. If the entry is absent, runs the supplied
 * `installFn(storeDir)` to populate node_modules into the store. `installFn`
 * is injectable for tests; in production the daemon passes a function that
 * runs `npm install --no-audit --no-fund --prefer-offline` from
 * `<sourceWorktree>/package.json`.
 *
 * Returns the absolute path to the store's node_modules tree (the symlink
 * target).
 */
export async function ensureStoreEntry({
  appId,
  lockfileSha,
  sourceWorktree,
  installFn,
}) {
  if (!lockfileSha) {
    throw new Error('ensureStoreEntry: lockfileSha required (project has no lockfile)');
  }
  if (typeof installFn !== 'function') {
    throw new Error('ensureStoreEntry: installFn required');
  }
  const storeNm = storeNodeModulesPath(appId, lockfileSha);
  const storeDir = dirname(storeNm);

  if (existsSync(storeNm)) {
    return storeNm;
  }

  // Bootstrap the store entry by installing into the SOURCE worktree first,
  // then moving its node_modules into the store. This keeps install-time
  // resolution against a real package.json + lockfile (the install needs to
  // see them) before we share the result.
  mkdirSync(storeDir, { recursive: true });
  await installFn(sourceWorktree);

  const sourceNm = join(sourceWorktree, 'node_modules');
  if (!existsSync(sourceNm)) {
    throw new Error(
      `ensureStoreEntry: installFn did not create ${sourceNm} — install must have failed silently`,
    );
  }
  // Move via rename (single inode change). If cross-device, fall back to cp -al.
  try {
    const { renameSync } = await import('node:fs');
    renameSync(sourceNm, storeNm);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      const r = spawnSync('cp', ['-al', sourceNm, storeNm], { stdio: 'pipe' });
      if (r.status !== 0) {
        throw new Error(`ensureStoreEntry: cp -al fallback failed: ${r.stderr?.toString()}`);
      }
      rmSync(sourceNm, { recursive: true, force: true });
    } else {
      throw err;
    }
  }

  return storeNm;
}

/**
 * Create the worktree -> store symlink and bump the refcount.
 *
 * If `<worktree>/node_modules` already exists as a directory (operator
 * pre-installed it manually, or a prior daemon run installed in-place),
 * it is replaced by the symlink — the daemon owns this path during a
 * Phase 1 plan run.
 */
export function linkWorktreeToStore({ worktreeDir, appId, lockfileSha }) {
  const storeNm = storeNodeModulesPath(appId, lockfileSha);
  if (!existsSync(storeNm)) {
    throw new Error(`linkWorktreeToStore: store entry missing at ${storeNm}`);
  }
  const linkPath = join(worktreeDir, 'node_modules');
  // If a symlink already points at the same target, no-op. Use unlinkSync
  // for symlinks (rmSync follows the link on macOS and tries to recurse
  // into the store, which is wrong); use rmSync for real directories.
  let exists = false;
  let st;
  try {
    st = lstatSync(linkPath);
    exists = true;
  } catch {
    /* absent */
  }
  if (exists && st.isSymbolicLink()) {
    const existingTarget = readlinkSync(linkPath);
    if (existingTarget === storeNm) {
      return { linked: false, reason: 'already-linked', target: storeNm };
    }
    unlinkSync(linkPath);
  } else if (exists) {
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(storeNm, linkPath, 'dir');
  bumpRefcount(appId, lockfileSha, 1);
  return { linked: true, target: storeNm };
}

/**
 * Remove the worktree's node_modules symlink and decrement the refcount.
 * Idempotent: safe to call when the symlink is already gone.
 */
export function unlinkWorktreeFromStore({ worktreeDir, appId, lockfileSha }) {
  const linkPath = join(worktreeDir, 'node_modules');
  let unlinked = false;
  let st;
  try {
    st = lstatSync(linkPath);
  } catch {
    /* absent */
  }
  if (st && st.isSymbolicLink()) {
    // unlinkSync removes the LINK itself; rmSync on macOS follows symlinks
    // and would try to recurse into the shared store, which is destructive.
    unlinkSync(linkPath);
    unlinked = true;
  }
  if (unlinked) {
    const next = bumpRefcount(appId, lockfileSha, -1);
    return { unlinked: true, refcount: next.count };
  }
  const current = readRefcount(appId, lockfileSha);
  return { unlinked: false, refcount: current.count };
}

/**
 * Setup convenience wrapper used by the per-story worktree helper.
 * Computes the lockfile sha from the source worktree, ensures the store
 * entry exists (installing via installFn if absent), and creates the
 * symlink in the destination worktree.
 *
 * Returns { lockfileSha, storeTarget, freshlyInstalled }.
 */
export async function setupNodeModulesSymlink({
  appId,
  sourceWorktree,
  destWorktree,
  installFn,
}) {
  const lockfileSha = computeLockfileSha(sourceWorktree);
  if (!lockfileSha) {
    return { lockfileSha: null, storeTarget: null, freshlyInstalled: false, skipped: true };
  }
  const storeNm = storeNodeModulesPath(appId, lockfileSha);
  const freshlyInstalled = !existsSync(storeNm);
  await ensureStoreEntry({ appId, lockfileSha, sourceWorktree, installFn });
  linkWorktreeToStore({ worktreeDir: destWorktree, appId, lockfileSha });
  return { lockfileSha, storeTarget: storeNm, freshlyInstalled };
}

// Marker file written into a materialized node_modules so we can tell, on
// a later wave, whether the existing copy still matches the current lockfile.
const STORE_SHA_MARKER = '.futurator-store-sha';

/**
 * 2026-05-28 — Materialize a REAL node_modules directory in `destWorktree`
 * (a `cp -a` copy of the store entry), NOT a symlink.
 *
 * Why a real copy instead of `setupNodeModulesSymlink`: Next.js 16's
 * Turbopack rejects a `node_modules` symlink that points outside the
 * project's filesystem root ("Symlink [project]/node_modules is invalid,
 * it points out of the filesystem root") — and the store lives at
 * `/home/ubuntu/.node_modules_store/...`, outside every worktree. So any
 * worktree that must run `next build` (the wave-merge coordinator, where
 * the post-merge validation gate runs) needs a real directory.
 *
 * `cp -a` preserves the store's INTERNAL relative symlinks (`.bin/*` →
 * `../<pkg>/...`), which stay valid inside the copy, while the top-level
 * `node_modules` is a real directory Turbopack accepts. (`cp -RL` would
 * deref the `.bin` shims and break `require('../server/...')` resolution —
 * verified on EC2 2026-05-28.)
 *
 * Idempotent + lockfile-aware: writes a `.futurator-store-sha` marker; on
 * re-invocation (e.g. wave N+1 after a story changed deps) it re-copies
 * only when the current lockfile sha differs from the marker.
 *
 * Returns { lockfileSha, materialized: boolean, skipped?: 'no-lockfile' | 'up-to-date' }.
 */
export async function materializeNodeModulesFromStore({
  appId,
  worktreeDir,
  installFn,
  log = () => {},
}) {
  const lockfileSha = computeLockfileSha(worktreeDir);
  if (!lockfileSha) {
    return { lockfileSha: null, materialized: false, skipped: 'no-lockfile' };
  }

  const destNm = join(worktreeDir, 'node_modules');
  const markerPath = join(destNm, STORE_SHA_MARKER);

  // Already materialized for this exact lockfile? Skip the copy.
  // (A symlink left by a prior code path is NOT a valid real dir for
  // Turbopack, so only a real dir with a matching marker counts.)
  if (existsSync(destNm) && !isSymlink(destNm) && existsSync(markerPath)) {
    try {
      if (readFileSync(markerPath, 'utf8').trim() === lockfileSha) {
        return { lockfileSha, materialized: false, skipped: 'up-to-date' };
      }
    } catch {
      /* fall through to re-materialize */
    }
  }

  // Ensure the store entry exists (install on miss).
  await ensureStoreEntry({ appId, lockfileSha, sourceWorktree: worktreeDir, installFn });
  const storeNm = storeNodeModulesPath(appId, lockfileSha);

  // Replace whatever is at destNm (symlink, stale dir, or nothing) with a
  // fresh real copy.
  if (existsSync(destNm) || isSymlink(destNm)) {
    rmSync(destNm, { recursive: true, force: true });
  }
  const cp = spawnSync('cp', ['-a', storeNm, destNm], { stdio: 'pipe' });
  if (cp.status !== 0) {
    throw new Error(
      `materializeNodeModulesFromStore: cp -a failed (${cp.status}): ${cp.stderr?.toString().slice(-300)}`,
    );
  }
  try {
    writeFileSync(markerPath, `${lockfileSha}\n`);
  } catch {
    // Marker is an optimization; a missing marker just forces a re-copy
    // next wave. Non-fatal.
  }
  log('info', `[node-modules] materialized real node_modules in ${worktreeDir} (sha ${lockfileSha})`);
  return { lockfileSha, materialized: true };
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Teardown convenience wrapper. Computes the lockfile sha from the
 * worktree (the lockfile is still in the working tree), unlinks, decrements
 * the refcount.
 */
export function teardownNodeModulesSymlink({ appId, worktreeDir }) {
  const lockfileSha = computeLockfileSha(worktreeDir);
  if (!lockfileSha) {
    return { lockfileSha: null, unlinked: false, refcount: null, skipped: true };
  }
  const result = unlinkWorktreeFromStore({ appId, worktreeDir, lockfileSha });
  return { lockfileSha, ...result };
}
