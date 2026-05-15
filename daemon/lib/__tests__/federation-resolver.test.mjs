/**
 * federation-resolver.test.mjs — Pipeline v2 Phase 3 / Story 3-C-1-2.
 */

import { describe, it, expect, vi } from 'vitest';
import { createFederationResolver, indexUrlForSource } from '../federation-resolver.mjs';

function makeFederationCache(manifest) {
  return {
    get: () => ({ manifest, source: 'fixture', path: '/fixture' }),
  };
}

const MANIFEST = {
  'manifest-version': 1,
  sources: [
    {
      id: 'anthropic-official',
      url: 'https://github.com/anthropics/skills',
      'auto-trust': true,
      priority: 1,
    },
    {
      id: 'futurator-internal',
      url: 'https://github.com/futurator/futurator-skills',
      'auto-trust': true,
      priority: 2,
    },
    {
      id: 'community',
      url: 'https://github.com/anthropics/skills-community',
      'auto-trust': false,
      priority: 99,
    },
  ],
  'refresh-cadence': 'weekly',
};

describe('indexUrlForSource', () => {
  it('builds raw URL for github.com source', () => {
    expect(indexUrlForSource('https://github.com/anthropics/skills')).toBe(
      'https://raw.githubusercontent.com/anthropics/skills/main/index.json',
    );
  });

  it('handles trailing slash', () => {
    expect(indexUrlForSource('https://github.com/foo/bar/')).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/index.json',
    );
  });

  it('returns null for non-github URLs', () => {
    expect(indexUrlForSource('https://gitlab.com/foo/bar')).toBeNull();
    expect(indexUrlForSource('https://example.com/skills')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(indexUrlForSource('not-a-url')).toBeNull();
    expect(indexUrlForSource('https://github.com/just-owner')).toBeNull();
  });
});

describe('createFederationResolver.resolveSkill', () => {
  it('returns null when no source carries the skill', async () => {
    const fetchIndex = vi.fn().mockResolvedValue({ skills: [] });
    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });
    const result = await resolver.resolveSkill({ skillName: 'nonexistent' });
    expect(result).toBeNull();
    expect(fetchIndex).toHaveBeenCalledTimes(3);
  });

  it('returns first match in priority order', async () => {
    const fetchIndex = vi.fn().mockImplementation((url) => {
      if (url.includes('anthropics/skills/')) {
        return Promise.resolve({ skills: [{ name: 'frontend-design', kind: 'core', version: 'sha:a3f' }] });
      }
      if (url.includes('futurator-skills')) {
        // Also has frontend-design but lower priority — should not be picked
        return Promise.resolve({ skills: [{ name: 'frontend-design', kind: 'core', version: 'sha:zzz' }] });
      }
      return Promise.resolve({ skills: [] });
    });

    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });
    const result = await resolver.resolveSkill({ skillName: 'frontend-design' });
    expect(result).not.toBeNull();
    expect(result?.source).toBe('anthropic-official');
    expect(result?.priority).toBe(1);
    expect(result?.entry.version).toBe('sha:a3f');
    expect(result?.autoTrust).toBe(true);
  });

  it('flags non-auto-trust source with autoTrust=false', async () => {
    const fetchIndex = vi.fn().mockImplementation((url) => {
      if (url.includes('skills-community')) {
        return Promise.resolve({ skills: [{ name: 'experimental-helper', kind: 'process' }] });
      }
      return Promise.resolve({ skills: [] });
    });

    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });
    const result = await resolver.resolveSkill({ skillName: 'experimental-helper' });
    expect(result?.source).toBe('community');
    expect(result?.autoTrust).toBe(false);
  });

  it('caches index lookups within TTL', async () => {
    const fetchIndex = vi
      .fn()
      .mockResolvedValue({ skills: [{ name: 'frontend-design', kind: 'core' }] });

    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });

    await resolver.resolveSkill({ skillName: 'frontend-design' });
    await resolver.resolveSkill({ skillName: 'frontend-design' });
    await resolver.resolveSkill({ skillName: 'frontend-design' });

    // First lookup walks anthropic-official only (hits + returns). Subsequent
    // lookups should hit the cache — exactly 1 fetch total.
    expect(fetchIndex).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after invalidate()', async () => {
    const fetchIndex = vi
      .fn()
      .mockResolvedValue({ skills: [{ name: 'frontend-design' }] });

    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });

    await resolver.resolveSkill({ skillName: 'frontend-design' });
    expect(fetchIndex).toHaveBeenCalledTimes(1);

    resolver.invalidate();

    await resolver.resolveSkill({ skillName: 'frontend-design' });
    expect(fetchIndex).toHaveBeenCalledTimes(2);
  });

  it('expires cache after TTL elapses', async () => {
    let currentTime = 1_000_000;
    const fetchIndex = vi
      .fn()
      .mockResolvedValue({ skills: [{ name: 'frontend-design' }] });

    const resolver = createFederationResolver(makeFederationCache(MANIFEST), {
      fetchIndex,
      now: () => currentTime,
    });

    await resolver.resolveSkill({ skillName: 'frontend-design' });
    expect(fetchIndex).toHaveBeenCalledTimes(1);

    // 30 min later — still cached
    currentTime += 30 * 60 * 1000;
    await resolver.resolveSkill({ skillName: 'frontend-design' });
    expect(fetchIndex).toHaveBeenCalledTimes(1);

    // 90 min later — TTL crossed
    currentTime += 60 * 60 * 1000;
    await resolver.resolveSkill({ skillName: 'frontend-design' });
    expect(fetchIndex).toHaveBeenCalledTimes(2);
  });

  it('continues to next source when fetch fails', async () => {
    const fetchIndex = vi.fn().mockImplementation((url) => {
      if (url.includes('anthropics/skills/')) {
        return Promise.reject(new Error('network timeout'));
      }
      if (url.includes('futurator-skills')) {
        return Promise.resolve({ skills: [{ name: 'frontend-design' }] });
      }
      return Promise.resolve({ skills: [] });
    });

    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });
    const result = await resolver.resolveSkill({ skillName: 'frontend-design' });
    expect(result?.source).toBe('futurator-internal');

    const cache = resolver.inspectCache();
    expect(cache['anthropic-official'].error).toMatch(/network timeout/);
  });

  it('filters by kind when query.kind is set', async () => {
    const fetchIndex = vi.fn().mockImplementation((url) => {
      if (url.includes('anthropics/skills/')) {
        return Promise.resolve({ skills: [{ name: 'foo', kind: 'process' }] });
      }
      if (url.includes('futurator-skills')) {
        return Promise.resolve({ skills: [{ name: 'foo', kind: 'domain' }] });
      }
      return Promise.resolve({ skills: [] });
    });
    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });
    const result = await resolver.resolveSkill({ skillName: 'foo', kind: 'domain' });
    expect(result?.source).toBe('futurator-internal');
  });

  it('returns null on empty skillName', async () => {
    const fetchIndex = vi.fn();
    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });
    expect(await resolver.resolveSkill({ skillName: '' })).toBeNull();
    expect(await resolver.resolveSkill({})).toBeNull();
    expect(fetchIndex).not.toHaveBeenCalled();
  });
});

describe('createFederationResolver.inspectCache', () => {
  it('reports per-source skill counts after lookups', async () => {
    const fetchIndex = vi.fn().mockImplementation((url) => {
      if (url.includes('anthropics/skills/')) {
        return Promise.resolve({ skills: [{ name: 'a' }, { name: 'b' }] });
      }
      return Promise.resolve({ skills: [] });
    });
    const resolver = createFederationResolver(makeFederationCache(MANIFEST), { fetchIndex });
    await resolver.resolveSkill({ skillName: 'nonexistent' });
    const cache = resolver.inspectCache();
    expect(cache['anthropic-official'].skillCount).toBe(2);
    expect(cache['futurator-internal'].skillCount).toBe(0);
  });
});
