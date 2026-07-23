import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractSubsystems,
  buildShards,
  shardKeyFor,
  boundaryOf,
  detectShardCycles,
  SHARD_KEY_PREFIX,
} from '../extractors/subsystem-extract.mjs';

function project() {
  return mkdtempSync(join(tmpdir(), 'subsystem-extract-'));
}

/** Write a minimal `.mycelium/ast-facts.json` with the given files + imports. */
function writeAstFacts(root, files) {
  mkdirSync(join(root, '.mycelium'), { recursive: true });
  writeFileSync(
    join(root, '.mycelium', 'ast-facts.json'),
    JSON.stringify({ root, files }),
    'utf8',
  );
}

describe('subsystem-extract — deterministic shard keys (E3.1)', () => {
  it('shardKeyFor reuses the touchPoint `/`→`--` encoding with the §sys prefix', () => {
    expect(shardKeyFor('src/auth')).toBe('§sys:src--auth');
    expect(shardKeyFor('functions')).toBe('§sys:functions');
    expect(SHARD_KEY_PREFIX).toBe('§sys:');
  });

  it('boundaryOf is the parent directory (module unit); root files fold under "."', () => {
    expect(boundaryOf('src/auth/login.ts')).toBe('src/auth');
    expect(boundaryOf('functions/api/index.ts')).toBe('functions/api');
    expect(boundaryOf('package.json')).toBe('.');
  });

  it('partitions files into one docShard per boundary, members sorted + nodeId-encoded', () => {
    const { shards } = buildShards(
      ['src/auth/login.ts', 'src/auth/token.ts', 'src/ui/button.tsx', 'package.json'],
      [],
    );
    const byKey = Object.fromEntries(shards.map((s) => [s.shardKey, s]));
    expect(Object.keys(byKey).sort()).toEqual(['§sys:.', '§sys:src--auth', '§sys:src--ui']);
    expect(byKey['§sys:src--auth'].members).toEqual([
      'code/src--auth--login.ts',
      'code/src--auth--token.ts',
    ]);
    expect(byKey['§sys:src--ui'].members).toEqual(['code/src--ui--button.tsx']);
  });

  it('is deterministic: identical inputs → identical shards (order-independent input)', () => {
    const a = buildShards(['src/b.ts', 'src/a.ts', 'lib/x.ts'], []);
    const b = buildShards(['lib/x.ts', 'src/a.ts', 'src/b.ts'], []);
    expect(a.shards).toEqual(b.shards);
  });

  it('cross-boundary relative imports become shard→shard DEPENDS_ON edges (intra-module dropped)', () => {
    const files = ['src/auth/login.ts', 'src/auth/token.ts', 'lib/crypto.ts'];
    const imports = [
      // cross-module: src/auth → lib
      { from: 'src/auth/token.ts', source: '../../lib/crypto' },
      // intra-module: src/auth → src/auth (must be dropped)
      { from: 'src/auth/login.ts', source: './token' },
    ];
    const { depEdges, shards } = buildShards(files, imports);
    expect(depEdges).toEqual([{ source: '§sys:src--auth', target: '§sys:lib' }]);
    const auth = shards.find((s) => s.shardKey === '§sys:src--auth');
    expect(auth.depends).toEqual(['§sys:lib']);
  });
});

describe('subsystem-extract — empty project (E3.2)', () => {
  it('no ast-facts → emptyEnvelope (nodeCount 0)', () => {
    const root = project();
    try {
      const env = extractSubsystems(root);
      expect(env.nodeCount).toBe(0);
      expect(env.nodes).toHaveLength(0);
      expect(env.edges).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ast-facts with zero usable files → emptyEnvelope', () => {
    const root = project();
    try {
      writeAstFacts(root, [{ path: 'x.ts', parseError: 'boom' }]);
      const env = extractSubsystems(root);
      expect(env.nodeCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('subsystem-extract — dependency cycle is reported, not crashed (E3.2)', () => {
  it('detectShardCycles returns the cycle members', () => {
    const cycles = detectShardCycles([
      { source: '§sys:a', target: '§sys:b' },
      { source: '§sys:b', target: '§sys:a' },
    ]);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const flat = cycles[0];
    expect(flat).toContain('§sys:a');
    expect(flat).toContain('§sys:b');
  });

  it('a cyclic import graph extracts cleanly and surfaces the cycle on ambiguous[] + extra.cycles', () => {
    const root = project();
    try {
      writeAstFacts(root, [
        { path: 'a/one.ts', imports: [{ source: '../b/two' }] },
        { path: 'b/two.ts', imports: [{ source: '../a/one' }] },
      ]);
      const env = extractSubsystems(root);
      // Does NOT throw; emits both shards.
      expect(env.nodes.map((n) => n.nodeId).sort()).toEqual(['§sys:a', '§sys:b']);
      expect(env.cycles.length).toBeGreaterThanOrEqual(1);
      expect(env.ambiguous.some((a) => a.reason === 'shard-dependency-cycle')).toBe(true);
      // The DEPENDS_ON edges both ways still exist (a cycle is a fact, not an error).
      const deps = env.edges.filter((e) => e.type === 'DEPENDS_ON').map((e) => `${e.source}→${e.target}`);
      expect(deps).toContain('§sys:a→§sys:b');
      expect(deps).toContain('§sys:b→§sys:a');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
