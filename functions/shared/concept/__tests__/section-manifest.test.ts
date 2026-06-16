import { describe, it, expect } from 'vitest';
import {
  generateSectionManifest,
  resolveSection,
  sectionIds,
  hasSection,
  slugifyHeading,
} from '../section-manifest';

/**
 * Concept v2 — Story E4.1 (W2): the locked, shared section-manifest format —
 * `<!--§id-->` anchors + `{id,title,lineStart,lineEnd}` sidecar, deterministic
 * line-range resolve, immutable slugs across revs.
 */
const RAW = `# Architecture

Intro prose.

## Error Handling Strategy

Wrap everything in AppError.

## State Model

The store is a single reducer.`;

describe('generateSectionManifest (Concept v2 — E4.1)', () => {
  it('AC1 — emits a sidecar + mirrors each id as a <!--§id--> anchor above its heading', () => {
    const { markdown, manifest } = generateSectionManifest(RAW, {
      artifact: 'architecture',
      rev: 1,
    });
    expect(manifest.artifact).toBe('architecture');
    expect(manifest.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sectionIds(manifest)).toEqual([
      'architecture',
      'error-handling-strategy',
      'state-model',
    ]);
    // Each id is mirrored as an anchor immediately above its heading.
    expect(markdown).toContain('<!--§error-handling-strategy-->\n## Error Handling Strategy');
    expect(markdown).toContain('<!--§state-model-->\n## State Model');
  });

  it('AC2 — resolveSection slices the exact line range, no regex', () => {
    const { markdown, manifest } = generateSectionManifest(RAW, {
      artifact: 'architecture',
      rev: 1,
    });
    const section = resolveSection(markdown, manifest, 'error-handling-strategy');
    expect(section).toContain('## Error Handling Strategy');
    expect(section).toContain('Wrap everything in AppError.');
    // It stops before the next section.
    expect(section).not.toContain('State Model');
    expect(resolveSection(markdown, manifest, 'nonexistent')).toBeNull();
  });

  it('AC3 — slugs are stable across a regenerate that keeps the section', () => {
    const a = generateSectionManifest(RAW, { artifact: 'architecture', rev: 1 });
    const edited = RAW.replace(
      'Wrap everything in AppError.',
      'Wrap everything in AppError. Edited.',
    );
    const b = generateSectionManifest(edited, { artifact: 'architecture', rev: 2 });
    expect(sectionIds(b.manifest)).toEqual(sectionIds(a.manifest)); // ids survive an in-section edit
    expect(b.manifest.contentHash).not.toBe(a.manifest.contentHash); // but the hash moves
  });

  it('dedupes collided heading slugs deterministically', () => {
    const dup = `## Notes\n\nfoo\n\n## Notes\n\nbar`;
    const { manifest } = generateSectionManifest(dup, { artifact: 'prd', rev: 1 });
    expect(sectionIds(manifest)).toEqual(['notes', 'notes-2']);
  });

  it('hasSection is the set-membership predicate (decompose + gate reuse it)', () => {
    const { manifest } = generateSectionManifest(RAW, { artifact: 'architecture', rev: 1 });
    expect(hasSection(manifest, 'state-model')).toBe(true);
    expect(hasSection(manifest, 'made-up')).toBe(false);
  });

  it('slugifyHeading produces kebab-case, stripping markdown emphasis', () => {
    expect(slugifyHeading('Error Handling Strategy')).toBe('error-handling-strategy');
    expect(slugifyHeading('`State` Model!')).toBe('state-model');
    expect(slugifyHeading('   ')).toBe('section');
  });
});
