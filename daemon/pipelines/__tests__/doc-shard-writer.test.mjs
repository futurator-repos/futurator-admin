import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeShard,
  writeProjection,
  slugifyHeading as slugMjs,
  generateSectionManifest as genMjs,
  contentHash as hashMjs,
  shardFileBase,
} from '../lib/doc-shard-writer.mjs';
// TS source of truth — imported HERE (test only) to prove the daemon `.mjs`
// slugifier/contentHash never drift. Production daemon code must NOT import this.
import {
  generateSectionManifest as genTs,
  slugifyHeading as slugTs,
} from '../../../functions/shared/concept/section-manifest.ts';

const FIXTURE = [
  '# Subsystem',
  '',
  'Intro prose.',
  '',
  '## Responsibility',
  '',
  'Does the auth thing.',
  '',
  '## Key Modules',
  '',
  '| Module | Role |',
  '| --- | --- |',
  '| login.ts | entry |',
  '',
  '## Interfaces',
  '',
  'Exposes `login()`.',
  '',
  '## Responsibility', // duplicate heading → slug dedup path
  '',
  'Repeated to force a `-2` suffix.',
  '',
].join('\n');

describe('doc-shard-writer — manifest parity vs section-manifest.ts (E1.3)', () => {
  it('slugifyHeading + contentHash match the TS implementation', () => {
    for (const t of ['Responsibility', 'Key Modules', 'API / Data', '   ']) {
      expect(slugMjs(t)).toBe(slugTs(t));
    }
    const ts = genTs(FIXTURE, { artifact: 'architecture', rev: 1 });
    expect(hashMjs(ts.markdown)).toBe(ts.manifest.contentHash);
  });

  it('the .mjs manifest is byte-identical to the TS manifest for the shared fixture', () => {
    const mjs = genMjs(FIXTURE, { artifact: 'architecture', rev: 1 });
    const ts = genTs(FIXTURE, { artifact: 'architecture', rev: 1 });
    expect(mjs.markdown).toBe(ts.markdown);
    expect(mjs.manifest).toEqual(ts.manifest);
    const ids = mjs.manifest.sections.map((s) => s.id);
    expect(ids).toContain('responsibility');
    expect(ids).toContain('responsibility-2');
  });
});

describe('doc-shard-writer — writeShard atomic + idempotent (E1.3)', () => {
  it('lands <docType>/shards/<base>.md + .sections.json with shardKey-safe basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-write-'));
    try {
      const { mdPath, sidecarPath, manifest, base } = writeShard(
        dir,
        'architecture',
        '§sys:src--auth',
        FIXTURE,
        { rev: 2, provenance: 'EXTRACTED' },
      );
      expect(base).toBe('src--auth');
      expect(existsSync(mdPath)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);
      expect(mdPath).toContain(join('architecture', 'shards', 'src--auth.md'));
      // Sidecar carries shard identity + provenance + matches the TS hash.
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      expect(sidecar.shardKey).toBe('§sys:src--auth');
      expect(sidecar.provenance).toBe('EXTRACTED');
      const ts = genTs(FIXTURE, { artifact: 'architecture', rev: 2 });
      expect(sidecar.contentHash).toBe(ts.manifest.contentHash);
      expect(manifest.contentHash).toBe(sidecar.contentHash);
      // The written .md IS the annotated markdown the manifest hashes over.
      expect(readFileSync(mdPath, 'utf8')).toBe(ts.markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shardFileBase strips §sys: and keeps the --encoded tail', () => {
    expect(shardFileBase('§sys:src--auth')).toBe('src--auth');
    expect(shardFileBase('§sys:.')).toBe('.');
  });

  it('is idempotent + leaves no stray .tmp files (atomic write)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-idem-'));
    try {
      const first = writeShard(dir, 'architecture', '§sys:lib', FIXTURE, { rev: 1 });
      const md1 = readFileSync(first.mdPath, 'utf8');
      const side1 = readFileSync(first.sidecarPath, 'utf8');
      const second = writeShard(dir, 'architecture', '§sys:lib', FIXTURE, { rev: 1 });
      expect(readFileSync(second.mdPath, 'utf8')).toBe(md1);
      expect(readFileSync(second.sidecarPath, 'utf8')).toBe(side1);
      // No leftover tmp files in the shards dir.
      const stray = readdirSync(join(dir, 'architecture', 'shards')).filter((f) => f.includes('.tmp'));
      expect(stray).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doc-shard-writer — writeProjection (E1.3)', () => {
  it('writes <docType>/<docType>.md + sidecar with an honest contentHash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-write-'));
    try {
      const projection = {
        md: '<!--§§sys:a-->\n# a\n\nbody',
        sectionsJson: {
          artifact: 'godDoc',
          rev: 0,
          contentHash: 'sha256:stale',
          shardKeys: ['§sys:a'],
          sections: [{ id: '§sys:a', title: 'a', lineStart: 1, lineEnd: 4 }],
        },
      };
      const { mdPath, sidecarPath, manifest } = writeProjection(dir, 'architecture', projection, {
        rev: 3,
        provenance: 'EXTRACTED',
      });
      expect(mdPath).toContain(join('architecture', 'architecture.md'));
      expect(readFileSync(mdPath, 'utf8')).toBe(projection.md);
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      expect(sidecar.rev).toBe(3);
      // contentHash is recomputed over the bytes actually written (not the stale input).
      expect(sidecar.contentHash).toBe(hashMjs(projection.md));
      expect(manifest.contentHash).toBe(sidecar.contentHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
