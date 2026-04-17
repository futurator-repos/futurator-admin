import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { buildCodebaseIndex } from '../codebase-index.mjs';

function initGit(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.futurator/\n');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
}

describe('buildCodebaseIndex', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codebase-index-'));
  });
  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('reads Mycelium knowledge/code/*.md articles when present', async () => {
    mkdirSync(join(root, 'knowledge', 'code'), { recursive: true });
    writeFileSync(
      join(root, 'knowledge', 'code', 'src--hooks--use-costs.ts.md'),
      [
        '---',
        'path: src/hooks/use-costs.ts',
        '---',
        '',
        '## Purpose',
        '',
        'TanStack Query hook for cost aggregation rows.',
        '',
        '## Key Exports',
        '',
        'useCosts(range)',
        '',
        '## Dependencies',
        '',
        'api-client, cost-repository contract',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'knowledge', 'code', 'functions--api--index.ts.md'),
      '## Purpose\n\nSingle-file Hono handler.\n\n## Key Exports\n\nhandler\n',
    );
    initGit(root);

    const result = await buildCodebaseIndex(root);
    expect(result).toContain('src/hooks/use-costs.ts');
    expect(result).toContain('TanStack Query hook for cost aggregation rows.');
    expect(result).toContain('Exports: useCosts(range)');
    expect(result).toContain('Depends on: api-client, cost-repository contract');
    expect(result).toContain('functions/api/index.ts');
    expect(result).toContain('Single-file Hono handler.');
  });

  it('falls back to directory walk when knowledge/code is missing', async () => {
    mkdirSync(join(root, 'src', 'hooks'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'hooks', 'use-costs.ts'),
      '// TanStack Query hook for costs\nexport function useCosts() {}\n',
    );
    writeFileSync(
      join(root, 'src', 'index.ts'),
      '/**\n * App entry point\n */\nexport {};\n',
    );
    initGit(root);

    const result = await buildCodebaseIndex(root);
    expect(result).toContain('src/hooks/use-costs.ts');
    expect(result).toContain('TanStack Query hook for costs');
    expect(result).toContain('src/index.ts');
  });

  it('falls back when knowledge/code exists but is empty', async () => {
    mkdirSync(join(root, 'knowledge', 'code'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// Alpha module\nexport {};\n');
    initGit(root);

    const result = await buildCodebaseIndex(root);
    expect(result).toContain('src/a.ts');
    expect(result).toContain('Alpha module');
  });

  it('respects maxBytes cap', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(root, 'src', `mod-${i}.ts`), `// module ${i}\nexport {};\n`);
    }
    initGit(root);

    const result = await buildCodebaseIndex(root, { maxBytes: 200 });
    expect(result.length).toBeLessThanOrEqual(220);
  });

  it('caches per git SHA and serves from cache on second call', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// Alpha\nexport {};\n');
    initGit(root);

    const first = await buildCodebaseIndex(root);
    const sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' })
      .trim()
      .slice(0, 12);
    const cachePath = join(root, '.futurator', `codebase-index-${sha}.md`);
    expect(existsSync(cachePath)).toBe(true);

    // Mutate source; cache should still serve old index.
    writeFileSync(join(root, 'src', 'a.ts'), '// Beta rewrite\nexport {};\n');
    const second = await buildCodebaseIndex(root);
    expect(second).toBe(first);
    expect(second).toContain('Alpha');
    expect(second).not.toContain('Beta rewrite');
  });

  it('rebuilds when git SHA changes', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// First\nexport {};\n');
    initGit(root);

    const first = await buildCodebaseIndex(root);
    expect(first).toContain('First');

    writeFileSync(join(root, 'src', 'a.ts'), '// Second\nexport {};\n');
    execSync('git add -A && git commit -q -m second', { cwd: root });

    const second = await buildCodebaseIndex(root);
    expect(second).toContain('Second');
    expect(second).not.toContain('First');
  });

  it('skips cache when cache:false passed', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// Alpha\nexport {};\n');
    initGit(root);

    await buildCodebaseIndex(root);
    writeFileSync(join(root, 'src', 'a.ts'), '// Overwritten\nexport {};\n');
    const fresh = await buildCodebaseIndex(root, { cache: false });
    expect(fresh).toContain('Overwritten');
  });

  it('throws when workingDir is missing', async () => {
    await expect(() => buildCodebaseIndex('')).rejects.toThrow(/workingDir is required/);
  });

  it('produces output even outside a git repo (no-cache mode)', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// No git here\nexport {};\n');

    const out = await buildCodebaseIndex(root);
    expect(out).toContain('No git here');
    expect(existsSync(join(root, '.futurator'))).toBe(false);
  });

  it('excludes node_modules and build artefacts from fallback walk', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// Alpha\nexport {};\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'b.ts'), '// From dep\nexport {};\n');
    writeFileSync(join(root, 'dist', 'c.js'), '// Built\nexport {};\n');
    initGit(root);

    const out = await buildCodebaseIndex(root);
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('dist/c.js');
  });
});
