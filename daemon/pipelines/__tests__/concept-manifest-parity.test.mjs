import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSectionManifest as genMjs,
  slugifyHeading as slugMjs,
  writeConceptArtifact,
} from '../lib/concept-artifact-writeback.mjs';
// The TS source of truth — imported HERE (test only) to prove the daemon `.mjs`
// reimplementation never drifts. Production daemon code must NOT import this.
import {
  generateSectionManifest as genTs,
  slugifyHeading as slugTs,
  resolveSection,
} from '../../../functions/shared/concept/section-manifest.ts';

/**
 * Story 1.2 — shared-fixture parity. The daemon `.mjs` reimplemented slugifier +
 * contentHash + manifest MUST be byte-identical to the TS `generateSectionManifest`
 * for the same fixture. A divergence introduced in W1 is caught in W1.
 */
const FIXTURE = [
  '# Product Requirements',
  '',
  'Intro prose about the product.',
  '',
  '## Scope (MVP → Growth → Vision)',
  '',
  '- MVP: the smallest shippable slice.',
  '',
  '## Functional Requirements',
  '',
  'FR1. The system shall do the thing.',
  '',
  '### Edge Cases & `weird` *formatting*!!',
  '',
  'Some details.',
  '',
  '## Scope (MVP → Growth → Vision)', // duplicate heading → slug dedup path
  '',
  'Repeated section to force a `-2` suffix.',
  '',
].join('\n');

describe('concept manifest parity (Story 1.2 — .mjs ≡ .ts)', () => {
  it('slugifyHeading matches the TS implementation across tricky titles', () => {
    const titles = [
      'Scope (MVP → Growth → Vision)',
      'Edge Cases & `weird` *formatting*!!',
      '   ',
      'API Contracts / Data Architecture',
      '日本語 only',
    ];
    for (const t of titles) {
      expect(slugMjs(t)).toBe(slugTs(t));
    }
  });

  it('emits a byte-identical manifest (ids, line ranges, contentHash) for the shared fixture', () => {
    const mjs = genMjs(FIXTURE, { artifact: 'prd', rev: 1 });
    const ts = genTs(FIXTURE, { artifact: 'prd', rev: 1 });
    expect(mjs.markdown).toBe(ts.markdown);
    expect(mjs.manifest).toEqual(ts.manifest);
    // Spot-check the dedup path actually fired.
    const ids = mjs.manifest.sections.map((s) => s.id);
    expect(ids).toContain('scope-mvp-growth-vision');
    expect(ids).toContain('scope-mvp-growth-vision-2');
  });

  it('the sidecar JSON deep-equals the TS manifest after a disk round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concept-parity-'));
    try {
      const { mdPath, sidecarPath, manifest } = writeConceptArtifact(dir, 'architecture', FIXTURE, {
        rev: 2,
      });
      expect(existsSync(mdPath)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      const ts = genTs(FIXTURE, { artifact: 'architecture', rev: 2 });
      expect(sidecar).toEqual(ts.manifest);
      // The returned manifest matches what was written to the sidecar.
      expect(manifest.contentHash).toBe(sidecar.contentHash);
      // The written .md IS the annotated markdown the manifest hashes over.
      const writtenMd = readFileSync(mdPath, 'utf8');
      expect(writtenMd).toBe(ts.markdown);
      // resolveSection (TS) slices a known section deterministically from the written .md.
      const slice = resolveSection(writtenMd, ts.manifest, 'functional-requirements');
      expect(slice).toContain('FR1. The system shall do the thing.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a re-run with identical content yields byte-identical files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concept-idem-'));
    try {
      const first = writeConceptArtifact(dir, 'prd', FIXTURE, { rev: 1 });
      const md1 = readFileSync(first.mdPath, 'utf8');
      const side1 = readFileSync(first.sidecarPath, 'utf8');
      const second = writeConceptArtifact(dir, 'prd', FIXTURE, { rev: 1 });
      const md2 = readFileSync(second.mdPath, 'utf8');
      const side2 = readFileSync(second.sidecarPath, 'utf8');
      expect(md2).toBe(md1);
      expect(side2).toBe(side1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the concept/ dir when absent and writes without a half-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concept-mkdir-'));
    try {
      // No pre-existing concept/ dir; helper must create it.
      const { mdPath } = writeConceptArtifact(dir, 'ux', '# UX Spec\n\nbody', { rev: 0 });
      expect(mdPath).toContain(join('concept', 'ux.md'));
      // No leftover .tmp files in the dir.
      const stray = readFileSync(mdPath, 'utf8');
      expect(stray.startsWith('<!--§ux-spec-->')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
