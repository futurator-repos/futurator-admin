import { describe, it, expect } from 'vitest';
import { parseMergeTreeOutput, predictConflicts } from '../merge-tree.mjs';
import { createMergeQueue } from '../merge-queue.mjs';
import { computeDepsFingerprint, depsMatch, resolveDepCacheMode } from '../lockfile-fingerprint.mjs';

describe('parseMergeTreeOutput', () => {
  it('exit 0 → clean, captures tree oid', () => {
    expect(parseMergeTreeOutput('abc123treeoid\n', 0)).toEqual({ clean: true, conflicts: [], treeOid: 'abc123treeoid' });
  });
  it('exit 1 → conflicts list', () => {
    const r = parseMergeTreeOutput('treeoid\nsrc/a.ts\nsrc/b.ts\n', 1);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('other exit → unknown (attempt the merge)', () => {
    expect(parseMergeTreeOutput('', 128)).toEqual({ clean: null, conflicts: [] });
  });
});

describe('predictConflicts', () => {
  it('reports clean on exit 0', () => {
    const exec = () => ({ status: 0, stdout: 'oid\n', stderr: '' });
    expect(predictConflicts({ repoDir: '/r', ours: 'a', theirs: 'b', exec }).clean).toBe(true);
  });
  it('reports conflicts on exit 1', () => {
    const exec = () => ({ status: 1, stdout: 'oid\nsrc/x.ts\n', stderr: '' });
    const r = predictConflicts({ repoDir: '/r', ours: 'a', theirs: 'b', exec });
    expect(r.clean).toBe(false);
    expect(r.conflicts).toEqual(['src/x.ts']);
  });
  it('exit >1 → unknown with reason (never silently skips)', () => {
    const exec = () => ({ status: 128, stdout: '', stderr: 'not a tree' });
    const r = predictConflicts({ repoDir: '/r', ours: 'a', theirs: 'b', exec });
    expect(r.clean).toBe(null);
    expect(r.reason).toMatch(/128/);
  });
  it('exec error → unknown', () => {
    const exec = () => ({ error: new Error('ENOENT git') });
    expect(predictConflicts({ repoDir: '/r', ours: 'a', theirs: 'b', exec }).clean).toBe(null);
  });
});

describe('merge-queue (single-consumer FIFO)', () => {
  it('drains in FIFO order, clean before dirty', async () => {
    const order = [];
    const q = createMergeQueue({ onMerge: async (i) => { order.push(i.storyId); return { merged: true }; } });
    q.enqueue({ storyId: 's1', dirty: true });
    q.enqueue({ storyId: 's2', dirty: false });
    q.enqueue({ storyId: 's3', dirty: false });
    const res = await q.run();
    expect(order).toEqual(['s2', 's3', 's1']); // clean (s2,s3 by seq) then dirty (s1)
    expect(res.every((r) => r.merged)).toBe(true);
  });
  it('a failing merge is recorded, not thrown', async () => {
    const q = createMergeQueue({ onMerge: async (i) => { if (i.storyId === 'bad') throw new Error('conflict'); return { merged: true }; } });
    q.enqueue({ storyId: 'ok' });
    q.enqueue({ storyId: 'bad' });
    const res = await q.run();
    expect(res.find((r) => r.storyId === 'bad').merged).toBe(false);
    expect(res.find((r) => r.storyId === 'ok').merged).toBe(true);
  });
  it('is a single consumer — concurrent run() calls do not double-process', async () => {
    let active = 0; let maxActive = 0;
    const q = createMergeQueue({ onMerge: async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return { merged: true }; } });
    for (let i = 0; i < 5; i++) q.enqueue({ storyId: `s${i}` });
    await Promise.all([q.run(), q.run()]);
    expect(maxActive).toBe(1);
  });
});

describe('lockfile-fingerprint', () => {
  const fakeFs = (files) => ({
    existsSync: (p) => p in files,
    readFileSync: (p) => files[p],
  });
  it('fingerprints manifest + lockfile; identical inputs → identical hash', () => {
    const files = { '/wt/package.json': '{"deps":1}', '/wt/package-lock.json': 'lock-a' };
    const a = computeDepsFingerprint('/wt', { fs: fakeFs(files) });
    const b = computeDepsFingerprint('/wt', { fs: fakeFs(files) });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
  it('a changed lockfile changes the fingerprint', () => {
    const a = computeDepsFingerprint('/wt', { fs: fakeFs({ '/wt/package.json': 'm', '/wt/package-lock.json': 'L1' }) });
    const b = computeDepsFingerprint('/wt', { fs: fakeFs({ '/wt/package.json': 'm', '/wt/package-lock.json': 'L2' }) });
    expect(a).not.toBe(b);
  });
  it('no manifest → null (must install independently)', () => {
    expect(computeDepsFingerprint('/wt', { fs: fakeFs({}) })).toBe(null);
  });
  it('resolveDepCacheMode: match → symlink-ro, mismatch → independent', () => {
    expect(resolveDepCacheMode({ sharedFingerprint: 'x', worktreeFingerprint: 'x' })).toBe('symlink-ro');
    expect(resolveDepCacheMode({ sharedFingerprint: 'x', worktreeFingerprint: 'y' })).toBe('independent');
    expect(resolveDepCacheMode({ sharedFingerprint: null, worktreeFingerprint: 'y' })).toBe('independent');
    expect(depsMatch('a', 'a')).toBe(true);
    expect(depsMatch(null, null)).toBe(false);
  });
});
