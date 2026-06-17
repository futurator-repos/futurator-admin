/**
 * skill-index-entry-schema.test.ts — Skills Institution, Story 2.1 (2026-06-17).
 *
 * Locks the backward-compatibility contract: a legacy 7-field entry must parse
 * unchanged, missing facets must migrate to the safe (most-conservative)
 * defaults, and the round-trip (parse → migrate) must never upgrade trust on its
 * own. Framework skills are the one inferred exception (platform-owned →
 * constitutional + trusted).
 */

import { describe, it, expect } from 'vitest';
import {
  SkillIndexEntrySchema,
  SkillIndexSchema,
  parseIndexEntry,
  migrateIndexEntry,
  migrateSkillIndex,
  FACET_MIGRATION_DEFAULTS,
} from '../skill-index-entry-schema';

const legacyEntry = {
  name: 'fix-flaky-tests',
  kind: 'core',
  framework: false,
  version: 'sha:HEAD',
  license: 'MIT',
  description: 'Find and fix flaky tests',
};

describe('SkillIndexEntrySchema — backward compatibility', () => {
  it('parses a legacy 7-field entry (no facets) unchanged', () => {
    const r = SkillIndexEntrySchema.safeParse(legacyEntry);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe('fix-flaky-tests');
      expect(r.data.trustTier).toBeUndefined();
      expect(r.data.securityStatus).toBeUndefined();
    }
  });

  it('parses an entry carrying the new facets', () => {
    const r = SkillIndexEntrySchema.safeParse({
      ...legacyEntry,
      provenanceClass: 'app-evolved',
      securityStatus: 'clean',
      qualityGrade: 'B',
      trustTier: 'trusted',
      maturity: 3,
      lineage: { adaptedFrom: 'write-tests', graduatedFrom: null, supersededBy: null },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.trustTier).toBe('trusted');
      expect(r.data.lineage?.adaptedFrom).toBe('write-tests');
    }
  });

  it('applies defaults for absent base fields but requires a name', () => {
    expect(SkillIndexEntrySchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(SkillIndexEntrySchema.safeParse({}).success).toBe(false);
    const parsed = SkillIndexEntrySchema.parse({ name: 'x' });
    expect(parsed.kind).toBe('core');
    expect(parsed.framework).toBe(false);
    expect(parsed.version).toBe('sha:HEAD');
    expect(parsed.license).toBe('UNKNOWN');
  });

  it('rejects an unknown facet value', () => {
    expect(
      SkillIndexEntrySchema.safeParse({ ...legacyEntry, trustTier: 'omnipotent' }).success,
    ).toBe(false);
    expect(
      SkillIndexEntrySchema.safeParse({ ...legacyEntry, securityStatus: 'maybe' }).success,
    ).toBe(false);
  });

  it('accepts numeric or letter quality grades', () => {
    expect(SkillIndexEntrySchema.safeParse({ ...legacyEntry, qualityGrade: 87 }).success).toBe(
      true,
    );
    expect(SkillIndexEntrySchema.safeParse({ ...legacyEntry, qualityGrade: 'A' }).success).toBe(
      true,
    );
  });
});

describe('parseIndexEntry', () => {
  it('returns the validated entry for a good row', () => {
    expect(parseIndexEntry(legacyEntry)?.name).toBe('fix-flaky-tests');
  });
  it('returns null for a row with no name (skip-not-throw contract)', () => {
    expect(parseIndexEntry({ kind: 'core' })).toBeNull();
    expect(parseIndexEntry('garbage')).toBeNull();
  });
});

describe('migrateIndexEntry — safe defaults', () => {
  it('stamps the most-conservative defaults on a legacy entry', () => {
    const m = migrateIndexEntry(legacyEntry);
    expect(m.provenanceClass).toBe('third-party');
    expect(m.securityStatus).toBe('unverified');
    expect(m.qualityGrade).toBe('ungraded');
    expect(m.trustTier).toBe('draft');
    expect(m.maturity).toBe(0);
    expect(m.lineage).toEqual({ adaptedFrom: null, graduatedFrom: null, supersededBy: null });
  });

  it('never downgrades a facet that is already set', () => {
    const m = migrateIndexEntry({
      ...legacyEntry,
      securityStatus: 'clean',
      trustTier: 'trusted',
    });
    expect(m.securityStatus).toBe('clean');
    expect(m.trustTier).toBe('trusted');
  });

  it('treats a framework skill as constitutional + trusted (never quarantines platform skills)', () => {
    const m = migrateIndexEntry({ ...legacyEntry, framework: true });
    expect(m.provenanceClass).toBe('constitutional');
    expect(m.trustTier).toBe('trusted');
    // but still unverified until actually scanned
    expect(m.securityStatus).toBe('unverified');
  });

  it('fills partial lineage to a complete shape', () => {
    const m = migrateIndexEntry({
      ...legacyEntry,
      lineage: { adaptedFrom: 'parent' } as never,
    });
    expect(m.lineage).toEqual({ adaptedFrom: 'parent', graduatedFrom: null, supersededBy: null });
  });

  it('does not mutate the input entry', () => {
    const input = { ...legacyEntry };
    migrateIndexEntry(input);
    expect(input).not.toHaveProperty('trustTier');
  });

  it('migration defaults are frozen + conservative', () => {
    expect(FACET_MIGRATION_DEFAULTS.trustTier).toBe('draft');
    expect(FACET_MIGRATION_DEFAULTS.securityStatus).toBe('unverified');
    expect(Object.isFrozen(FACET_MIGRATION_DEFAULTS)).toBe(true);
  });
});

describe('migrateSkillIndex — document level', () => {
  it('migrates every entry and preserves top-level keys', () => {
    const index = SkillIndexSchema.parse({
      skills: [legacyEntry, { ...legacyEntry, name: 'other', framework: true }],
      'index-version': 2,
      'generated-by': 'gen-skill-index',
    });
    const migrated = migrateSkillIndex(index);
    expect(migrated['index-version']).toBe(2);
    expect(migrated['generated-by']).toBe('gen-skill-index');
    expect(migrated.skills[0].trustTier).toBe('draft');
    expect(migrated.skills[1].trustTier).toBe('trusted'); // framework
  });

  it('is idempotent (migrating twice yields the same result)', () => {
    const index = SkillIndexSchema.parse({ skills: [legacyEntry] });
    const once = migrateSkillIndex(index);
    const twice = migrateSkillIndex(once);
    expect(twice).toEqual(once);
  });
});
