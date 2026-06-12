/**
 * Unit tests for node-modules-store.mjs (Phase 1 worktree rollout).
 *
 * Pure-function coverage of the refcount sidecar + safety regex. The
 * integration of `ensureStoreEntry` + `linkWorktreeToStore` needs a
 * real filesystem; we test via mkdtemp tmpdirs.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let originalStoreRoot;
let storeRoot;
let workDir;

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), 'nms-store-'));
  workDir = mkdtempSync(join(tmpdir(), 'nms-wt-'));
  originalStoreRoot = process.env.FUTURATOR_NODE_MODULES_STORE_ROOT;
  process.env.FUTURATOR_NODE_MODULES_STORE_ROOT = storeRoot;
});

afterEach(() => {
  if (storeRoot && existsSync(storeRoot)) rmSync(storeRoot, { recursive: true, force: true });
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  if (originalStoreRoot === undefined) {
    delete process.env.FUTURATOR_NODE_MODULES_STORE_ROOT;
  } else {
    process.env.FUTURATOR_NODE_MODULES_STORE_ROOT = originalStoreRoot;
  }
});

describe('computeLockfileSha', () => {
  it('returns a stable hash for package-lock.json', async () => {
    const { computeLockfileSha } = await import('../node-modules-store.mjs');
    writeFileSync(join(workDir, 'package-lock.json'), '{"name": "x"}');
    const a = computeLockfileSha(workDir);
    const b = computeLockfileSha(workDir);
    expect(a).toBe(b);
    expect(a).toMatch(/^package-lock-json-[a-f0-9]{16}$/);
  });

  it('returns a different hash for different lockfile content', async () => {
    const { computeLockfileSha } = await import('../node-modules-store.mjs');
    writeFileSync(join(workDir, 'package-lock.json'), '{"name": "a"}');
    const a = computeLockfileSha(workDir);
    writeFileSync(join(workDir, 'package-lock.json'), '{"name": "b"}');
    const b = computeLockfileSha(workDir);
    expect(a).not.toBe(b);
  });

  it('falls back to pnpm-lock.yaml when package-lock.json is absent', async () => {
    const { computeLockfileSha } = await import('../node-modules-store.mjs');
    writeFileSync(join(workDir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0');
    const sha = computeLockfileSha(workDir);
    expect(sha).toMatch(/^pnpm-lock-yaml-[a-f0-9]{16}$/);
  });

  it('returns null when no lockfile is found', async () => {
    const { computeLockfileSha } = await import('../node-modules-store.mjs');
    expect(computeLockfileSha(workDir)).toBeNull();
  });

  it('throws on missing worktreeDir argument', async () => {
    const { computeLockfileSha } = await import('../node-modules-store.mjs');
    expect(() => computeLockfileSha()).toThrow(/worktreeDir required/);
  });
});

describe('refcount sidecar', () => {
  it('returns zero when sidecar is absent', async () => {
    const { readRefcount } = await import('../node-modules-store.mjs');
    expect(readRefcount('snake-4', 'package-lock-json-abc123')).toEqual({
      count: 0,
      createdAt: null,
      lastBumpedAt: null,
    });
  });

  it('bumps up + tracks createdAt across calls', async () => {
    const { bumpRefcount, readRefcount } = await import('../node-modules-store.mjs');
    const first = bumpRefcount('snake-4', 'package-lock-json-abc123', 1);
    expect(first.count).toBe(1);
    expect(first.createdAt).toBeTruthy();
    const second = bumpRefcount('snake-4', 'package-lock-json-abc123', 1);
    expect(second.count).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(readRefcount('snake-4', 'package-lock-json-abc123').count).toBe(2);
  });

  it('clamps at zero on over-teardown', async () => {
    const { bumpRefcount } = await import('../node-modules-store.mjs');
    bumpRefcount('snake-4', 'package-lock-json-abc123', 1);
    bumpRefcount('snake-4', 'package-lock-json-abc123', -5);
    const after = bumpRefcount('snake-4', 'package-lock-json-abc123', -1);
    expect(after.count).toBe(0);
  });
});

describe('safety regex', () => {
  it('rejects appIds with shell-meta', async () => {
    const { storeNodeModulesPath } = await import('../node-modules-store.mjs');
    expect(() => storeNodeModulesPath('../etc', 'sha')).toThrow(/appId/);
    expect(() => storeNodeModulesPath('foo;rm', 'sha')).toThrow(/appId/);
  });

  it('rejects shas with path-traversal', async () => {
    const { storeNodeModulesPath } = await import('../node-modules-store.mjs');
    expect(() => storeNodeModulesPath('snake-4', '../etc')).toThrow(/lockfileSha/);
    expect(() => storeNodeModulesPath('snake-4', 'sha/..')).toThrow(/lockfileSha/);
  });
});

describe('linkWorktreeToStore + unlinkWorktreeFromStore', () => {
  it('creates a symlink + bumps refcount, idempotent', async () => {
    const { linkWorktreeToStore, readRefcount, storeNodeModulesPath } = await import(
      '../node-modules-store.mjs'
    );
    const appId = 'snake-4';
    const sha = 'package-lock-json-fake1234';
    // Bootstrap store entry by hand.
    const storeNm = storeNodeModulesPath(appId, sha);
    mkdirSync(storeNm, { recursive: true });

    const dest = mkdtempSync(join(tmpdir(), 'nms-dest-'));
    const r1 = linkWorktreeToStore({ worktreeDir: dest, appId, lockfileSha: sha });
    expect(r1.linked).toBe(true);
    expect(lstatSync(join(dest, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, 'node_modules'))).toBe(storeNm);
    expect(readRefcount(appId, sha).count).toBe(1);

    // Second call is a no-op (already linked to same target).
    const r2 = linkWorktreeToStore({ worktreeDir: dest, appId, lockfileSha: sha });
    expect(r2.linked).toBe(false);
    expect(readRefcount(appId, sha).count).toBe(1);

    rmSync(dest, { recursive: true, force: true });
  });

  it('unlink decrements refcount + removes symlink, idempotent', async () => {
    const { linkWorktreeToStore, unlinkWorktreeFromStore, readRefcount, storeNodeModulesPath } =
      await import('../node-modules-store.mjs');
    const appId = 'snake-4';
    const sha = 'package-lock-json-fake5678';
    mkdirSync(storeNodeModulesPath(appId, sha), { recursive: true });

    const dest = mkdtempSync(join(tmpdir(), 'nms-dest-'));
    linkWorktreeToStore({ worktreeDir: dest, appId, lockfileSha: sha });
    expect(readRefcount(appId, sha).count).toBe(1);

    const r = unlinkWorktreeFromStore({ worktreeDir: dest, appId, lockfileSha: sha });
    expect(r.unlinked).toBe(true);
    expect(r.refcount).toBe(0);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);

    // Second call: idempotent.
    const r2 = unlinkWorktreeFromStore({ worktreeDir: dest, appId, lockfileSha: sha });
    expect(r2.unlinked).toBe(false);
    expect(r2.refcount).toBe(0);

    rmSync(dest, { recursive: true, force: true });
  });
});

// 2026-05-28 — Turbopack rejects an out-of-root node_modules symlink, so
// the wave-merge coordinator needs a REAL directory. materializeNode
// ModulesFromStore cp -a's the store entry into the worktree.
describe('materializeNodeModulesFromStore', () => {
  it('skips when the worktree has no lockfile', async () => {
    const { materializeNodeModulesFromStore } = await import('../node-modules-store.mjs');
    const r = await materializeNodeModulesFromStore({
      appId: 'pacman-1',
      worktreeDir: workDir,
      installFn: async () => {},
    });
    expect(r).toMatchObject({ lockfileSha: null, materialized: false, skipped: 'no-lockfile' });
  });

  it('materializes a REAL node_modules dir (not a symlink) from the store', async () => {
    const { materializeNodeModulesFromStore } = await import('../node-modules-store.mjs');
    // Unique lockfile content → unique store sha (STORE_ROOT is frozen at
    // module-import, so store entries persist across tests in this file;
    // distinct content avoids cross-test collisions).
    writeFileSync(join(workDir, 'package-lock.json'), '{"name":"pacman-mat","lockfileVersion":3}');
    // installFn seeds node_modules in the source worktree; ensureStoreEntry
    // then moves it into the store.
    const installFn = async (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'), '#!/usr/bin/env node\n');
      writeFileSync(join(cwd, 'node_modules', 'marker.txt'), 'real-dep');
    };
    const r = await materializeNodeModulesFromStore({
      appId: 'pacman-mat',
      worktreeDir: workDir,
      installFn,
    });
    expect(r.materialized).toBe(true);
    const nm = join(workDir, 'node_modules');
    // It's a REAL directory, NOT a symlink (the whole point — Turbopack).
    expect(lstatSync(nm).isSymbolicLink()).toBe(false);
    expect(lstatSync(nm).isDirectory()).toBe(true);
    expect(existsSync(join(nm, 'marker.txt'))).toBe(true);
    // Marker written for idempotence.
    expect(existsSync(join(nm, '.futurator-store-sha'))).toBe(true);
  });

  it('is idempotent — second call with the same lockfile skips the copy', async () => {
    const { materializeNodeModulesFromStore } = await import('../node-modules-store.mjs');
    writeFileSync(join(workDir, 'package-lock.json'), '{"name":"pacman-idem","lockfileVersion":3}');
    let installs = 0;
    const installFn = async (cwd) => {
      installs += 1;
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'marker.txt'), 'x');
    };
    await materializeNodeModulesFromStore({ appId: 'pacman-idem', worktreeDir: workDir, installFn });
    const r2 = await materializeNodeModulesFromStore({
      appId: 'pacman-idem',
      worktreeDir: workDir,
      installFn,
    });
    expect(r2).toMatchObject({ materialized: false, skipped: 'up-to-date' });
    // Store was only seeded once.
    expect(installs).toBe(1);
  });

  it('re-materializes when the lockfile sha changes (deps added mid-plan)', async () => {
    const { materializeNodeModulesFromStore } = await import('../node-modules-store.mjs');
    writeFileSync(join(workDir, 'package-lock.json'), '{"app":"pacman-remat","v":1}');
    const installFn = async (cwd) => {
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'marker.txt'), 'x');
    };
    await materializeNodeModulesFromStore({ appId: 'pacman-remat', worktreeDir: workDir, installFn });
    // Lockfile changes (a story added a dependency).
    writeFileSync(join(workDir, 'package-lock.json'), '{"app":"pacman-remat","v":2}');
    const r = await materializeNodeModulesFromStore({
      appId: 'pacman-remat',
      worktreeDir: workDir,
      installFn,
    });
    expect(r.materialized).toBe(true);
  });

  // ── dino1 ENOSPC (2026-06-12) — hardlink-farm materialization ─────────
  // cp -a cost ~700M + 30-60s PER WORKTREE; N parallel stories + the gate
  // candidate exhausted the 19G disk. cp -al hardlinks files (megabytes,
  // seconds) and Turbopack accepts it (real top-level dir, shared inodes).

  it('HARDLINKS files from the store instead of copying (same inode)', async () => {
    const { materializeNodeModulesFromStore, storeNodeModulesPath, computeLockfileSha } =
      await import('../node-modules-store.mjs');
    const { statSync } = await import('node:fs');
    writeFileSync(join(workDir, 'package-lock.json'), '{"app":"pacman-hard","v":1}');
    const installFn = async (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'react'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'react', 'index.js'), 'module.exports = {};\n');
    };
    await materializeNodeModulesFromStore({ appId: 'pacman-hard', worktreeDir: workDir, installFn });
    const sha = computeLockfileSha(workDir);
    const storeFile = join(storeNodeModulesPath('pacman-hard', sha), 'react', 'index.js');
    const destFile = join(workDir, 'node_modules', 'react', 'index.js');
    // Same inode = hardlink farm, not a physical copy.
    expect(statSync(destFile).ino).toBe(statSync(storeFile).ino);
    expect(statSync(storeFile).nlink).toBeGreaterThanOrEqual(2);
    // The top-level dir is REAL (Turbopack contract preserved).
    expect(lstatSync(join(workDir, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('strips volatile cache dirs (.vite/.cache) from store AND materialized copy', async () => {
    const { materializeNodeModulesFromStore, storeNodeModulesPath, computeLockfileSha } =
      await import('../node-modules-store.mjs');
    writeFileSync(join(workDir, 'package-lock.json'), '{"app":"pacman-vol","v":1}');
    // The source worktree ran dev/test before the store move: its
    // node_modules carries vitest's .vite cache (the in-place-write class
    // that must never be shared between hardlinked worktrees).
    const installFn = async (cwd) => {
      mkdirSync(join(cwd, 'node_modules', '.vite', 'deps'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', '.vite', 'deps', '_metadata.json'), '{}');
      mkdirSync(join(cwd, 'node_modules', '.cache'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'real-dep.txt'), 'keep');
    };
    await materializeNodeModulesFromStore({ appId: 'pacman-vol', worktreeDir: workDir, installFn });
    const sha = computeLockfileSha(workDir);
    const storeNm = storeNodeModulesPath('pacman-vol', sha);
    expect(existsSync(join(storeNm, '.vite'))).toBe(false);
    expect(existsSync(join(storeNm, '.cache'))).toBe(false);
    expect(existsSync(join(workDir, 'node_modules', '.vite'))).toBe(false);
    expect(existsSync(join(workDir, 'node_modules', 'real-dep.txt'))).toBe(true);
  });

  it('marker write breaks any hardlink first (never truncates a shared inode)', async () => {
    const { materializeNodeModulesFromStore, storeNodeModulesPath, computeLockfileSha } =
      await import('../node-modules-store.mjs');
    const { statSync, readFileSync: read } = await import('node:fs');
    writeFileSync(join(workDir, 'package-lock.json'), '{"app":"pacman-mark","v":1}');
    // Pathological store: a stale marker is already INSIDE the store entry
    // (e.g. a pre-fix source worktree was renamed in after materialize).
    const installFn = async (cwd) => {
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', '.futurator-store-sha'), 'stale-sha\n');
    };
    await materializeNodeModulesFromStore({ appId: 'pacman-mark', worktreeDir: workDir, installFn });
    const sha = computeLockfileSha(workDir);
    const storeMarker = join(storeNodeModulesPath('pacman-mark', sha), '.futurator-store-sha');
    const destMarker = join(workDir, 'node_modules', '.futurator-store-sha');
    // The dest marker carries the CURRENT sha; the store's stale marker is
    // untouched (different inode — the unlink-before-write broke the link).
    expect(read(destMarker, 'utf8').trim()).toBe(sha);
    expect(read(storeMarker, 'utf8').trim()).toBe('stale-sha');
    expect(statSync(destMarker).ino).not.toBe(statSync(storeMarker).ino);
  });
});

// ── dino1 ENOSPC (2026-06-12) — cross-app store seeding ────────────────
// Two apps from the same boilerplate have identical lockfiles; the second
// app's store entry hardlink-clones the first instead of re-installing.
describe('ensureStoreEntry — cross-app sibling seeding', () => {
  it('clones a sibling app store entry with the same lockfileSha (no install)', async () => {
    const { ensureStoreEntry, computeLockfileSha, storeNodeModulesPath } = await import(
      '../node-modules-store.mjs'
    );
    const { statSync } = await import('node:fs');
    const LOCK = '{"boilerplate":"nextjs-base","lockfileVersion":3}';
    // App 1 (pong-x) installs for real.
    const wt1 = mkdtempSync(join(tmpdir(), 'nms-app1-'));
    writeFileSync(join(wt1, 'package-lock.json'), LOCK);
    const sha = computeLockfileSha(wt1);
    let installs = 0;
    const installFn = async (cwd) => {
      installs += 1;
      mkdirSync(join(cwd, 'node_modules', 'next'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'next', 'package.json'), '{"name":"next"}');
    };
    await ensureStoreEntry({ appId: 'pong-x', lockfileSha: sha, sourceWorktree: wt1, installFn });
    expect(installs).toBe(1);

    // App 2 (dino-x), same boilerplate ⇒ same lockfile sha: NO install.
    const wt2 = mkdtempSync(join(tmpdir(), 'nms-app2-'));
    writeFileSync(join(wt2, 'package-lock.json'), LOCK);
    await ensureStoreEntry({ appId: 'dino-x', lockfileSha: sha, sourceWorktree: wt2, installFn });
    expect(installs).toBe(1); // still 1 — seeded from the sibling

    // And the seed is a hardlink clone (same inode), so it costs ~nothing
    // and per-app `rm -rf store/<app>` semantics hold (blocks freed when
    // the last app's links go).
    const f1 = join(storeNodeModulesPath('pong-x', sha), 'next', 'package.json');
    const f2 = join(storeNodeModulesPath('dino-x', sha), 'next', 'package.json');
    expect(statSync(f1).ino).toBe(statSync(f2).ino);

    rmSync(wt1, { recursive: true, force: true });
    rmSync(wt2, { recursive: true, force: true });
  });
});
