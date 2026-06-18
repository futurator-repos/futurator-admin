/**
 * federation-resolver.mjs — Pipeline v2 Phase 3 / Story 3-C-1-2.
 *
 * Walks the federation manifest sources in priority order, looks up a skill
 * in each source's `index.json`, returns the first match. The resolver is
 * read-only — never mutates the manifest; never fetches the skill body
 * itself. That work belongs to SKILL-SCOUT (Story 3-C-3-1), which calls
 * this resolver and then orchestrates verify + install.
 *
 * Source index fetching:
 *  - URL pattern: `https://raw.githubusercontent.com/<owner>/<repo>/main/index.json`
 *  - Each source's index lists `{ skills: [{ name, kind, version, license, ... }] }`.
 *  - Indexes are cached in memory with a 1h TTL. SIGUSR1 (multiplexed with
 *    OAuth + federation reload) invalidates the cache via `invalidate()`.
 *  - Private sources (e.g. `futurator-internal` org repo) authenticate via
 *    `GITHUB_PAT` env var if present. Public sources work anonymously.
 *
 * The resolver returns a `null` when no source carries the skill. Non-auto-
 * trust matches still return a result but with `autoTrust: false` so the
 * caller (SKILL-SCOUT) knows to require operator confirmation.
 */

import { isInstallable, installBlockReason } from './skill-trust.mjs';

const INDEX_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Convert a federation source's URL (`https://github.com/owner/repo`) to its
 * raw `index.json` URL on the main branch. Returns null for unsupported URL
 * shapes — the daemon logs a warning and skips that source rather than
 * crashing the resolve.
 */
export function indexUrlForSource(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (u.hostname !== 'github.com') return null;
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/index.json`;
  } catch {
    return null;
  }
}

/**
 * Default HTTP fetcher. Replaceable via the resolver factory's options for
 * testability. Sends `Authorization: Bearer ${GITHUB_PAT}` when the env var
 * is present so private federation sources resolve under the daemon's
 * existing PAT.
 */
async function defaultFetchIndex(indexUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = { Accept: 'application/json' };
    if (process.env.GITHUB_PAT) {
      headers.Authorization = `Bearer ${process.env.GITHUB_PAT}`;
    }
    const res = await fetch(indexUrl, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const body = await res.json();
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function validateIndexShape(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return 'index must be object';
  if (!Array.isArray(index.skills)) return 'index.skills must be array';
  return null;
}

/**
 * Create a federation resolver bound to a manifest cache (from
 * `createFederationCache()` in federation-loader.mjs). The resolver carries
 * its own per-source index cache with TTL eviction.
 *
 * @param {{ get: () => { manifest: object } }} federationCache
 * @param {{ fetchIndex?: (url: string) => Promise<object>, now?: () => number }} [options]
 */
export function createFederationResolver(federationCache, options = {}) {
  const fetchIndex = options.fetchIndex || defaultFetchIndex;
  const now = options.now || (() => Date.now());

  // sourceId → { fetchedAt, skills: Map<skillName, entry>, error? }
  const indexCache = new Map();

  function isFresh(entry) {
    return entry && entry.fetchedAt && now() - entry.fetchedAt < INDEX_TTL_MS;
  }

  async function fetchAndCacheIndex(source) {
    const cached = indexCache.get(source.id);
    if (isFresh(cached)) return cached;

    const indexUrl = indexUrlForSource(source.url);
    if (!indexUrl) {
      const entry = { fetchedAt: now(), skills: new Map(), error: `unsupported source URL: ${source.url}` };
      indexCache.set(source.id, entry);
      return entry;
    }
    try {
      const body = await fetchIndex(indexUrl);
      const shapeErr = validateIndexShape(body);
      if (shapeErr) {
        const entry = { fetchedAt: now(), skills: new Map(), error: `bad index shape: ${shapeErr}` };
        indexCache.set(source.id, entry);
        return entry;
      }
      const skills = new Map();
      for (const entry of body.skills) {
        if (entry && typeof entry.name === 'string') {
          skills.set(entry.name, entry);
        }
      }
      const cacheEntry = { fetchedAt: now(), skills };
      indexCache.set(source.id, cacheEntry);
      return cacheEntry;
    } catch (err) {
      const entry = { fetchedAt: now(), skills: new Map(), error: err.message || String(err) };
      indexCache.set(source.id, entry);
      return entry;
    }
  }

  function sortedSources(manifest) {
    return [...manifest.sources].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Resolve a skill name against the federation. Walks sources in priority
   * order, returns the first source whose index lists the skill.
   *
   * @param {{ skillName: string, kind?: string }} query
   * @returns {Promise<{
   *   source: string,        // source id ('anthropic-official', 'futurator-internal', etc.)
   *   skillName: string,
   *   entry: object,         // raw index entry (full skill metadata)
   *   priority: number,      // source's priority value
   *   autoTrust: boolean,    // false for community-style sources
   * } | null>}
   */
  async function resolveSkill(query) {
    if (!query || typeof query.skillName !== 'string' || !query.skillName) {
      return null;
    }
    const { manifest } = federationCache.get();
    const sources = sortedSources(manifest);
    for (const source of sources) {
      const index = await fetchAndCacheIndex(source);
      const entry = index.skills.get(query.skillName);
      if (!entry) continue;
      if (query.kind && entry.kind && entry.kind !== query.kind) continue;
      const autoTrust = source['auto-trust'] === true;
      // Skills Institution Story 4.2 — ADVISORY trust annotation. Resolve is the
      // discovery API (it still surfaces non-trusted matches so the scout can
      // ask for operator confirmation); the HARD install gate lives in
      // vendor-skills. `installable`/`blockReason` let callers prefer trusted.
      return {
        source: source.id,
        skillName: query.skillName,
        entry,
        priority: source.priority,
        autoTrust,
        installable: isInstallable(entry, { autoTrust }),
        blockReason: installBlockReason(entry, { autoTrust }),
      };
    }
    return null;
  }

  /**
   * Drop the per-source index cache. Called from the SIGUSR1 multiplexed
   * handler in `agent-daemon.mjs` after the federation cache itself reloads.
   */
  function invalidate() {
    indexCache.clear();
  }

  /** Inspector for tests / debug log line. */
  function inspectCache() {
    const out = {};
    for (const [id, entry] of indexCache.entries()) {
      out[id] = {
        fetchedAt: entry.fetchedAt,
        skillCount: entry.skills.size,
        error: entry.error,
      };
    }
    return out;
  }

  return {
    resolveSkill,
    invalidate,
    inspectCache,
  };
}
