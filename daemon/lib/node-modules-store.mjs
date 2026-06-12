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
  readdirSync,
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

/**
 * dino1 ENOSPC (2026-06-12) — volatile per-build cache dirs that must NEVER
 * be shared between worktrees. `node_modules/.vite` (vite/vitest dep cache)
 * and `node_modules/.cache` (misc tools) get REWRITTEN IN PLACE by builds;
 * with hardlink materialization an in-place write would corrupt the shared
 * store copy for every sibling worktree. They are also the reason store
 * entries carried stale caches (ensureStoreEntry renames the source
 * worktree's node_modules AFTER dev/test may have populated them). Stripped
 * at store creation and from every materialized copy — each worktree's
 * first build recreates its own.
 */
const VOLATILE_CACHE_DIRS = ['.vite', '.cache'];

function stripVolatileCaches(nodeModulesDir) {
  for (const d of VOLATILE_CACHE_DIRS) {
    rmSync(join(nodeModulesDir, d), { recursive: true, force: true });
  }
}

/**
 * dino1 ENOSPC (2026-06-12) — cross-app store seeding. Two apps scaffolded
 * from the same boilerplate have byte-identical lockfiles; pre-fix each got
 * its own full `npm install` (~minutes) and its own ~700M physical store
 * entry. On a store miss, scan SIBLING apps for the same lockfileSha and
 * hardlink-clone it (`cp -al`: directories recreated, files hardlinked —
 * megabytes + seconds, and blocks are freed only when the last app's links
 * go, so per-app `rm -rf <store>/<appId>` delete semantics are preserved).
 * Returns the sibling's node_modules path or null.
 */
function findSiblingStoreEntry(appId, lockfileSha) {
  assertSafeSha(lockfileSha);
  let apps;
  try {
    apps = readdirSync(STORE_ROOT);
  } catch {
    return null;
  }
  for (const sibling of apps) {
    if (sibling === appId) continue;
    const candidate = join(STORE_ROOT, sibling, lockfileSha, 'node_modules');
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

  mkdirSync(storeDir, { recursive: true });

  // dino1 ENOSPC (2026-06-12) — before paying for a full npm install, check
  // whether a SIBLING app already has this exact lockfile in the store
  // (same boilerplate ⇒ identical lockfile). Hardlink-clone it: megabytes
  // and seconds instead of ~700M and minutes.
  const sibling = findSiblingStoreEntry(appId, lockfileSha);
  if (sibling) {
    const r = spawnSync('cp', ['-al', sibling, storeNm], { stdio: 'pipe' });
    if (r.status === 0) {
      stripVolatileCaches(storeNm);
      return storeNm;
    }
    // Clone failed (cross-device store roots?) — fall through to install.
    rmSync(storeNm, { recursive: true, force: true });
  }

  // Bootstrap the store entry by installing into the SOURCE worktree first,
  // then moving its node_modules into the store. This keeps install-time
  // resolution against a real package.json + lockfile (the install needs to
  // see them) before we share the result.
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

  // The source worktree may have run dev/test before this move — its
  // node_modules can carry volatile build caches that must not be shared.
  stripVolatileCaches(storeNm);

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
 * 2026-05-28 — Materialize a REAL node_modules directory in `destWorktree`,
 * NOT a symlink.
 *
 * Why a real directory instead of `setupNodeModulesSymlink`: Next.js 16's
 * Turbopack rejects a `node_modules` symlink that points outside the
 * project's filesystem root ("Symlink [project]/node_modules is invalid,
 * it points out of the filesystem root") — and the store lives at
 * `/home/ubuntu/.node_modules_store/...`, outside every worktree. So any
 * worktree that must run `next build` (the wave-merge coordinator, where
 * the post-merge validation gate runs) needs a real directory.
 *
 * dino1 ENOSPC (2026-06-12) — THE COPY IS NOW A HARDLINK FARM (`cp -al`),
 * not a physical copy (`cp -a`). The physical copy cost ~700M of disk and
 * ~30-60s PER WORKTREE; with N parallel stories + the gate candidate the
 * footprint scaled linearly with parallelism (dino1 wave 1: store 679M +
 * 2×679M story copies + candidate copy = ENOSPC on a 19G disk, setup-failed
 * gate). `cp -al` recreates the directory tree but hardlinks every file:
 * megabytes + ~2s per worktree, and Turbopack accepts it — hardlinked files
 * are indistinguishable from regular files (it objected to the symlinked
 * top-level dir, not to shared inodes). This is pnpm's proven model.
 *
 * In-place-mutation safety: npm replaces package files via
 * extract-to-temp + rename (breaks the link, store untouched); the known
 * in-place writers are the volatile cache dirs (`.vite`, `.cache`), which
 * are stripped from store entries and never shared (VOLATILE_CACHE_DIRS).
 * CAVEAT for future boilerplates: a tool that GENERATES into node_modules
 * in place (e.g. `prisma generate` → @prisma/client) would corrupt the
 * shared store — add such paths to VOLATILE_CACHE_DIRS or regenerate
 * post-materialize.
 *
 * Both internal relative symlinks (`.bin/*` → `../<pkg>/...`) and file
 * hardlinks stay valid inside the copy. Falls back to `cp -a` if the
 * hardlink copy fails (e.g. store and worktree on different filesystems).
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
  // fresh hardlink-farm copy (removing a prior hardlinked copy only drops
  // link counts — the store entry is untouched).
  if (existsSync(destNm) || isSymlink(destNm)) {
    rmSync(destNm, { recursive: true, force: true });
  }
  let mode = 'hardlink';
  let cp = spawnSync('cp', ['-al', storeNm, destNm], { stdio: 'pipe' });
  if (cp.status !== 0) {
    // Hardlinks need the same filesystem; fall back to a physical copy.
    rmSync(destNm, { recursive: true, force: true });
    mode = 'copy';
    cp = spawnSync('cp', ['-a', storeNm, destNm], { stdio: 'pipe' });
  }
  if (cp.status !== 0) {
    throw new Error(
      `materializeNodeModulesFromStore: cp -a failed (${cp.status}): ${cp.stderr?.toString().slice(-300)}`,
    );
  }
  // Belt-and-suspenders: never share volatile caches even if an old store
  // entry (pre-strip) still carries them.
  stripVolatileCaches(destNm);
  try {
    // Unlink first: writeFileSync truncates IN PLACE, and if a stale marker
    // rode along as a hardlink from the store, truncating would mutate the
    // shared inode. Unlink breaks the link; the write creates a fresh file.
    rmSync(markerPath, { force: true });
    writeFileSync(markerPath, `${lockfileSha}\n`);
  } catch {
    // Marker is an optimization; a missing marker just forces a re-copy
    // next wave. Non-fatal.
  }
  log(
    'info',
    `[node-modules] materialized real node_modules in ${worktreeDir} (sha ${lockfileSha}, ${mode})`,
  );
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
