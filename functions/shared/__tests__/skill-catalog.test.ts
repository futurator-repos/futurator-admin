/**
 * skill-catalog.test.ts — Skills Management Phase 1, Story 1.1 (2026-06-15).
 *
 * Hermetic Vitest run with an injected fetch. Covers index URL derivation,
 * env source resolution, flatten + priority-dedupe, and graceful degradation
 * when a source fails.
 */

import { describe, it, expect } from 'vitest';
import {
  indexUrlForSource,
  resolveSources,
  fetchSkillCatalog,
  diffSkillReconciliation,
  DEFAULT_FEDERATION_SOURCES,
} from '../skill-catalog';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('indexUrlForSource', () => {
  it('maps a github repo url to its raw index.json', () => {
    expect(indexUrlForSource('https://github.com/futurator-repos/futurator-skills')).toBe(
      'https://raw.githubusercontent.com/futurator-repos/futurator-skills/main/index.json',
    );
  });
  it('returns null for non-github or malformed urls', () => {
    expect(indexUrlForSource('https://example.com/x/y')).toBeNull();
    expect(indexUrlForSource('not a url')).toBeNull();
    expect(indexUrlForSource('https://github.com/only-owner')).toBeNull();
  });
});

describe('resolveSources', () => {
  it('defaults to the live futurator-skills source', () => {
    expect(resolveSources({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_FEDERATION_SOURCES);
  });
  it('parses SKILL_FEDERATION_SOURCES env override', () => {
    const env = {
      SKILL_FEDERATION_SOURCES: JSON.stringify([
        { id: 'a', url: 'https://github.com/o/a', priority: 2, 'auto-trust': true },
      ]),
    } as unknown as NodeJS.ProcessEnv;
    const got = resolveSources(env);
    expect(got).toEqual([{ id: 'a', url: 'https://github.com/o/a', priority: 2, autoTrust: true }]);
  });
  it('falls back to default on malformed env', () => {
    const env = { SKILL_FEDERATION_SOURCES: '{bad json' } as unknown as NodeJS.ProcessEnv;
    expect(resolveSources(env)).toEqual(DEFAULT_FEDERATION_SOURCES);
  });
});

describe('fetchSkillCatalog', () => {
  const sources = [
    { id: 'primary', url: 'https://github.com/o/primary', priority: 1, autoTrust: true },
    { id: 'secondary', url: 'https://github.com/o/secondary', priority: 2, autoTrust: false },
  ];

  it('flattens, dedupes by name (priority wins), sorts', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/primary/')) {
        return jsonResponse({
          skills: [
            {
              name: 'zed',
              kind: 'core',
              framework: true,
              version: 'sha:HEAD',
              license: 'MIT',
              description: 'z',
            },
            { name: 'shared', license: 'MIT', description: 'from primary' },
          ],
        });
      }
      return jsonResponse({
        skills: [
          { name: 'shared', license: 'MIT', description: 'from secondary' }, // dup — primary wins
          { name: 'alpha', description: 'a' },
        ],
      });
    }) as unknown as typeof fetch;

    const cat = await fetchSkillCatalog({ sources, fetchImpl, now: () => 0 });

    expect(cat.skills.map((s) => s.name)).toEqual(['alpha', 'shared', 'zed']); // sorted
    expect(cat.skills.find((s) => s.name === 'shared')!.description).toBe('from primary'); // priority dedupe
    expect(cat.skills.find((s) => s.name === 'shared')!.source).toBe('primary');
    // defaults applied for sparse entries
    const alpha = cat.skills.find((s) => s.name === 'alpha')!;
    expect(alpha).toMatchObject({
      kind: 'core',
      framework: false,
      version: 'sha:HEAD',
      license: 'UNKNOWN',
      source: 'secondary',
      autoTrust: false,
    });
    expect(cat.sources).toEqual([
      { id: 'primary', url: 'https://github.com/o/primary', ok: true, skillCount: 2 },
      { id: 'secondary', url: 'https://github.com/o/secondary', ok: true, skillCount: 1 },
    ]);
  });

  it('degrades gracefully when a source fails (404 / bad shape / throw)', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/primary/')) return jsonResponse({ skills: [{ name: 'ok-skill' }] });
      return jsonResponse({}, false, 404); // secondary 404s
    }) as unknown as typeof fetch;

    const cat = await fetchSkillCatalog({ sources, fetchImpl, now: () => 0 });
    expect(cat.skills.map((s) => s.name)).toEqual(['ok-skill']);
    const sec = cat.sources.find((s) => s.id === 'secondary')!;
    expect(sec.ok).toBe(false);
    expect(sec.error).toContain('HTTP 404');
  });

  it('reports unsupported source URLs without throwing', async () => {
    const fetchImpl = (async () => jsonResponse({ skills: [] })) as unknown as typeof fetch;
    const cat = await fetchSkillCatalog({
      sources: [{ id: 'bad', url: 'https://example.com/x', priority: 1, autoTrust: false }],
      fetchImpl,
      now: () => 0,
    });
    expect(cat.skills).toEqual([]);
    expect(cat.sources[0]).toMatchObject({ ok: false, error: 'unsupported source URL' });
  });
});

describe('diffSkillReconciliation', () => {
  const catalog = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'extra' }];

  it('classifies managed / unmanaged / availableNotLoaded', () => {
    // on disk: a, b (managed), zzz (unmanaged — not in catalog)
    const r = diffSkillReconciliation(['b', 'a', 'zzz'], catalog);
    expect(r.managed).toEqual(['a', 'b']); // sorted
    expect(r.unmanaged).toEqual(['zzz']);
    expect(r.availableNotLoaded).toEqual(['c', 'extra']); // catalog minus on-disk, sorted
    expect(r.onDiskCount).toBe(3);
    expect(r.catalogCount).toBe(4);
    expect(r.inSync).toBe(false); // has unmanaged drift
  });

  it('inSync when every on-disk skill is in the catalog (post-reconcile state)', () => {
    const r = diffSkillReconciliation(['a', 'b', 'c', 'extra'], catalog);
    expect(r.unmanaged).toEqual([]);
    expect(r.availableNotLoaded).toEqual([]);
    expect(r.inSync).toBe(true);
  });

  it('dedupes on-disk names', () => {
    const r = diffSkillReconciliation(['a', 'a', 'b'], catalog);
    expect(r.onDiskCount).toBe(2);
    expect(r.managed).toEqual(['a', 'b']);
  });
});
