/**
 * memory-store.test.mjs — Pipeline v2 Phase 3 / Story 3-E-1-1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createMemoryStore,
  provisionMemoryRoot,
  resolveScopeDir,
  MemoryStoreError,
  INBOX_FILES,
} from '../memory-store.mjs';

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mem-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveScopeDir', () => {
  it('maps "org" to futurator-org subdir', () => {
    expect(resolveScopeDir('/root', 'org')).toBe('/root/futurator-org');
  });

  it('maps "inbox" to inbox subdir', () => {
    expect(resolveScopeDir('/root', 'inbox')).toBe('/root/inbox');
  });

  it('maps project scope to project-<slug>', () => {
    expect(resolveScopeDir('/root', { kind: 'project', slug: 'songster' })).toBe(
      '/root/project-songster',
    );
  });

  it('rejects unknown scope', () => {
    expect(() => resolveScopeDir('/root', 'unknown')).toThrow(MemoryStoreError);
    expect(() => resolveScopeDir('/root', null)).toThrow(MemoryStoreError);
  });

  it('rejects malformed project slug', () => {
    expect(() => resolveScopeDir('/root', { kind: 'project', slug: 'BAD' })).toThrow(
      /invalid project slug/,
    );
    expect(() => resolveScopeDir('/root', { kind: 'project', slug: '' })).toThrow();
    expect(() => resolveScopeDir('/root', { kind: 'project', slug: '..' })).toThrow();
    expect(() => resolveScopeDir('/root', { kind: 'project', slug: 'has spaces' })).toThrow();
  });
});

describe('provisionMemoryRoot', () => {
  it('creates the three top-level scope dirs', () => {
    const result = provisionMemoryRoot({ root: tmpRoot });
    expect(existsSync(join(tmpRoot, 'futurator-org'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'inbox'))).toBe(true);
    expect(result.created.length).toBeGreaterThan(0);
  });

  it('is idempotent — second call reports no new dirs', () => {
    provisionMemoryRoot({ root: tmpRoot });
    const second = provisionMemoryRoot({ root: tmpRoot });
    expect(second.created).toHaveLength(0);
  });

  it('seeds empty inbox files with frontmatter', () => {
    provisionMemoryRoot({ root: tmpRoot });
    for (const f of INBOX_FILES) {
      const path = join(tmpRoot, 'inbox', f);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content).toMatch(/last-seen-sha/);
    }
  });

  it('provisions per-project dirs when slugs provided', () => {
    provisionMemoryRoot({ root: tmpRoot, projectSlugs: ['dino-runner-1', 'songster'] });
    expect(existsSync(join(tmpRoot, 'project-dino-runner-1'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'project-songster'))).toBe(true);
  });

  it('silently skips malformed slugs', () => {
    expect(() =>
      provisionMemoryRoot({ root: tmpRoot, projectSlugs: ['valid-1', 'BAD!'] }),
    ).not.toThrow();
    expect(existsSync(join(tmpRoot, 'project-valid-1'))).toBe(true);
  });
});

describe('createMemoryStore — read/write semantics', () => {
  it('returns null when file missing', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(store.read('inbox', 'missing.md')).toBeNull();
  });

  it('appendLine appends a newline-terminated line', () => {
    const store = createMemoryStore({ root: tmpRoot });
    store.appendLine('inbox', 'log.md', 'first');
    store.appendLine('inbox', 'log.md', 'second\n');
    expect(store.read('inbox', 'log.md')).toBe('first\nsecond\n');
  });

  it('writeAtomic overwrites the file', () => {
    const store = createMemoryStore({ root: tmpRoot });
    store.writeAtomic('inbox', 'replace.md', 'v1');
    store.writeAtomic('inbox', 'replace.md', 'v2');
    expect(store.read('inbox', 'replace.md')).toBe('v2');
  });

  it('writeAtomic does not leak .tmp-* files on success', () => {
    const store = createMemoryStore({ root: tmpRoot });
    store.writeAtomic('inbox', 'safe.md', 'content');
    const files = readdirSync(join(tmpRoot, 'inbox'));
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('exists() reports presence', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(store.exists('inbox', 'absent.md')).toBe(false);
    store.appendLine('inbox', 'present.md', 'x');
    expect(store.exists('inbox', 'present.md')).toBe(true);
  });
});

describe('createMemoryStore — scope isolation', () => {
  it('project scope writes land in project-<slug>', () => {
    const store = createMemoryStore({ root: tmpRoot });
    store.writeAtomic({ kind: 'project', slug: 'songster' }, 'decisions.md', 'D1');
    expect(existsSync(join(tmpRoot, 'project-songster', 'decisions.md'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'project-dino', 'decisions.md'))).toBe(false);
  });

  it('two project scopes do not see each other', () => {
    const store = createMemoryStore({ root: tmpRoot });
    store.writeAtomic({ kind: 'project', slug: 'proj-a' }, 'note.md', 'A only');
    expect(store.read({ kind: 'project', slug: 'proj-b' }, 'note.md')).toBeNull();
  });
});

describe('createMemoryStore — org scope is read-only', () => {
  it('rejects appendLine to org scope', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(() => store.appendLine('org', 'brand-voice.md', 'x')).toThrow(/READ-ONLY/);
  });

  it('rejects writeAtomic to org scope', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(() => store.writeAtomic('org', 'brand-voice.md', 'x')).toThrow(/READ-ONLY/);
  });

  it('allows read of org scope', () => {
    provisionMemoryRoot({ root: tmpRoot });
    // Manually populate (simulating a git-synced REFLECTOR-APPLY commit).
    writeFileSync(join(tmpRoot, 'futurator-org', 'brand-voice.md'), 'be terse', 'utf-8');
    const store = createMemoryStore({ root: tmpRoot });
    expect(store.read('org', 'brand-voice.md')).toBe('be terse');
  });
});

describe('createMemoryStore — path-traversal protection', () => {
  it('rejects .. in path', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(() => store.read('inbox', '../futurator-org/known-pitfalls.md')).toThrow(
      /path traversal/,
    );
    expect(() => store.writeAtomic('inbox', '../escape.md', 'x')).toThrow(/path traversal/);
  });

  it('rejects absolute paths', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(() => store.read('inbox', '/etc/passwd')).toThrow(/path traversal/);
  });

  it('rejects null bytes', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(() => store.read('inbox', 'file\0.md')).toThrow(/null byte/);
  });

  it('rejects empty path', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(() => store.read('inbox', '')).toThrow(/file path required/);
  });

  it('accepts nested-but-bounded paths', () => {
    const store = createMemoryStore({ root: tmpRoot });
    store.writeAtomic('inbox', 'sub/dir/note.md', 'nested');
    expect(store.read('inbox', 'sub/dir/note.md')).toBe('nested');
  });

  it('rejects a `..` segment buried inside a longer path', () => {
    const store = createMemoryStore({ root: tmpRoot });
    expect(() => store.read('inbox', 'sub/../../escape.md')).toThrow(/path traversal/);
  });
});
