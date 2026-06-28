/**
 * subsystem-decompose.test.mjs — locks B0: named/scoped subsystems derived from
 * recon outputs (parent-dir boundaries, cross-module depends, synthesized focus,
 * hotspot-first ranking + cap/sample, low-confidence flagging).
 */

import { describe, it, expect } from 'vitest';
import { buildSubsystems, boundaryOf, shardKeyForBoundary } from '../subsystem-decompose.mjs';

describe('buildSubsystems', () => {
  const edges = [
    { source: 'src/ui/button.tsx', target: 'src/lib/util.ts' },
    { source: 'src/app/page.tsx', target: 'src/ui/button.tsx' },
    { source: 'src/app/page.tsx', target: 'src/lib/util.ts' },
  ];
  const hubs = [
    { file: 'src/lib/util.ts', inDegree: 2 },
    { file: 'src/ui/button.tsx', inDegree: 1 },
  ];
  const hotspots = [
    { kind: 'god-object', score: 90, title: 'God-object: page.tsx', files: ['src/app/page.tsx'], evidence: { file: 'src/app/page.tsx' } },
  ];
  const fileRoles = { 'src/lib/util.ts': { role: 'infra' } };

  it('groups by parent-dir boundary with §sys keys', () => {
    const { shards } = buildSubsystems({ edges, hubs, hotspots, fileRoles });
    const keys = shards.map((s) => s.shardKey).sort();
    expect(keys).toContain('§sys:src--lib');
    expect(keys).toContain('§sys:src--ui');
    expect(keys).toContain('§sys:src--app');
  });

  it('computes cross-module depends + fan-in + roleMix', () => {
    const { shards } = buildSubsystems({ edges, hubs, hotspots, fileRoles });
    const app = shards.find((s) => s.name === 'src/app');
    expect(app.depends).toEqual(expect.arrayContaining(['§sys:src--ui', '§sys:src--lib']));
    const lib = shards.find((s) => s.name === 'src/lib');
    expect(lib.fanInTotal).toBe(2);
    expect(lib.roleMix).toContain('infra:1');
  });

  it('attaches hotspots to their shard and ranks hotspot shards first', () => {
    const { shards } = buildSubsystems({ edges, hubs, hotspots, fileRoles });
    expect(shards[0].name).toBe('src/app'); // the only hotspot-bearing shard ranks first
    expect(shards[0].hotspotCount).toBe(1);
    expect(shards[0].focus).toMatch(/Hotspots:.*God-object/);
  });

  it('synthesizes a focus line from hubs when no hotspots', () => {
    const { shards } = buildSubsystems({ edges, hubs, hotspots, fileRoles });
    const lib = shards.find((s) => s.name === 'src/lib');
    expect(lib.focus).toMatch(/Hubs:.*util\.ts/);
  });

  it('caps analyzers but always analyzes hotspot shards', () => {
    const big = buildSubsystems({ edges, hubs, hotspots, fileRoles, cap: 1 });
    const app = big.shards.find((s) => s.name === 'src/app');
    expect(app.analyze).toBe(true); // hotspot shard analyzed even under a tiny cap
    expect(big.analyzedCount + big.sampledCount).toBe(big.shards.length);
  });

  it('flags low-confidence on a single-boundary repo', () => {
    const flat = buildSubsystems({
      edges: [{ source: 'src/a.ts', target: 'src/b.ts' }],
      hubs: [{ file: 'src/b.ts', inDegree: 1 }],
    });
    expect(flat.lowConfidence).toBe(true);
    expect(flat.reason).toMatch(/single-boundary/);
  });
});

describe('boundary helpers', () => {
  it('boundaryOf + shardKeyForBoundary', () => {
    expect(boundaryOf('src/a/b/c.ts')).toBe('src/a/b');
    expect(shardKeyForBoundary('src/a/b')).toBe('§sys:src--a--b');
  });
});
