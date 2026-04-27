import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runPreflight } from '../preflight.mjs';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot;
let writableDir;
let nonWritableDir;
let regularFile;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'preflight-'));
  writableDir = join(tmpRoot, 'writable');
  nonWritableDir = join(tmpRoot, 'nonwritable');
  regularFile = join(tmpRoot, 'a-file');
  mkdirSync(writableDir);
  mkdirSync(nonWritableDir);
  writeFileSync(regularFile, 'hello');
  chmodSync(nonWritableDir, 0o555); // r-x r-x r-x — owner cannot write
});

afterAll(() => {
  try {
    chmodSync(nonWritableDir, 0o755);
  } catch {
    // ignore
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runPreflight — empty / no-op', () => {
  it('passes when checks array is empty', async () => {
    expect(await runPreflight([])).toEqual({ ok: true });
  });

  it('passes when checks is undefined', async () => {
    expect(await runPreflight(undefined)).toEqual({ ok: true });
  });
});

describe('runPreflight — folder-exists', () => {
  it('passes when path exists, is a directory, and is writable', async () => {
    expect(await runPreflight([{ check: 'folder-exists', path: writableDir }])).toEqual({
      ok: true,
    });
  });

  it('fails when path does not exist', async () => {
    const out = await runPreflight([{ check: 'folder-exists', path: '/no/such/dir' }]);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/does not exist/);
  });

  it('fails when path is a file rather than a directory', async () => {
    const out = await runPreflight([{ check: 'folder-exists', path: regularFile }]);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not a directory/);
  });

  it('fails when path is not writable by the daemon (no writable_by specified)', async () => {
    // Skip on root — root can write to mode 0555 dirs.
    if (process.getuid && process.getuid() === 0) return;
    const out = await runPreflight([{ check: 'folder-exists', path: nonWritableDir }]);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not writable/);
  });

  it('fails when writable_by names a different owner than the path has', async () => {
    const out = await runPreflight([
      { check: 'folder-exists', path: writableDir, writable_by: 'definitelynotauser' },
    ]);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/owner/);
  });
});

describe('runPreflight — short-circuit', () => {
  it('returns the first failure and does not run subsequent checks', async () => {
    const out = await runPreflight([
      { check: 'folder-exists', path: '/no/such/dir' },
      { check: 'folder-exists', path: writableDir }, // would pass — should not be reached
    ]);
    expect(out.ok).toBe(false);
    expect(out.failedCheck.path).toBe('/no/such/dir');
  });
});

describe('runPreflight — unknown check type', () => {
  it('fails with an explanatory message for an unknown validator', async () => {
    const out = await runPreflight([{ check: 'port-free', port: 8080 }]);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Unknown preflight check type/);
  });
});
