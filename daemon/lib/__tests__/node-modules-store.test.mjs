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
});
