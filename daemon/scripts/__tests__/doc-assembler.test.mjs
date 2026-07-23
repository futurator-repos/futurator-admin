import { describe, it, expect } from 'vitest';
import { assembleProjection } from '../lib/doc-assembler.mjs';

const shardA = { shardKey: '§sys:src--auth', md: '# src/auth\n\n## Responsibility\n\nAuth.' };
const shardB = { shardKey: '§sys:src--ui', md: '# src/ui\n\n## Responsibility\n\nUI.' };
const shardC = { shardKey: '§sys:lib', md: '# lib\n\n## Responsibility\n\nShared.' };

describe('doc-assembler — assembleProjection (E4.2)', () => {
  it('concatenates shards with <!--§shardKey--> anchors whose ids === shard keys', () => {
    const { md, sectionsJson } = assembleProjection([shardA, shardB]);
    expect(md).toContain('<!--§§sys:src--auth-->');
    expect(md).toContain('<!--§§sys:src--ui-->');
    expect(sectionsJson.sections.map((s) => s.id)).toEqual(['§sys:src--auth', '§sys:src--ui']);
    // section ids are exactly the shard keys, in stable order.
    expect(sectionsJson.shardKeys).toEqual(['§sys:src--auth', '§sys:src--ui']);
  });

  it('orders shards in stable containment-backbone (ascending shardKey) order regardless of input order', () => {
    const a = assembleProjection([shardA, shardB, shardC]);
    const b = assembleProjection([shardC, shardB, shardA]);
    expect(a.md).toBe(b.md);
    expect(a.sectionsJson).toEqual(b.sectionsJson);
    // lib < src--auth < src--ui lexically.
    expect(a.sectionsJson.shardKeys).toEqual(['§sys:lib', '§sys:src--auth', '§sys:src--ui']);
  });

  it('reproduces an UNCHANGED shard byte-for-byte even when a neighbor changes', () => {
    const before = assembleProjection([shardA, shardB]);
    const changedB = { ...shardB, md: '# src/ui\n\n## Responsibility\n\nUI — REWRITTEN with much more text.' };
    const after = assembleProjection([shardA, changedB]);

    // Slice out shard A's region from each projection by its manifest line range.
    const sliceA = (proj) => {
      const sec = proj.sectionsJson.sections.find((s) => s.id === '§sys:src--auth');
      return proj.md.split('\n').slice(sec.lineStart - 1, sec.lineEnd).join('\n');
    };
    expect(sliceA(after)).toBe(sliceA(before));
    // And shard A's body bytes are present verbatim.
    expect(after.md).toContain(shardA.md);
  });

  it('manifest line ranges resolve each shard section deterministically', () => {
    const { md, sectionsJson } = assembleProjection([shardA, shardC]);
    const lines = md.split('\n');
    for (const sec of sectionsJson.sections) {
      const slice = lines.slice(sec.lineStart - 1, sec.lineEnd).join('\n');
      expect(slice.startsWith(`<!--§${sec.id}-->`)).toBe(true);
    }
  });

  it('contentHash is over the assembled md and re-assembly is idempotent', () => {
    const a = assembleProjection([shardA, shardB]);
    const b = assembleProjection([shardA, shardB]);
    expect(a.md).toBe(b.md);
    expect(a.sectionsJson.contentHash).toBe(b.sectionsJson.contentHash);
    expect(a.sectionsJson.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('empty shard set → empty projection (no crash)', () => {
    const { md, sectionsJson } = assembleProjection([]);
    expect(md).toBe('');
    expect(sectionsJson.sections).toEqual([]);
    expect(sectionsJson.shardKeys).toEqual([]);
  });
});
