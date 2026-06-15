/**
 * skill-catalog.ts — Skills Management Phase 1, Story 1.1 (2026-06-15).
 *
 * Flattens the skill federation into one catalog for the admin Skills Registry
 * UI. The daemon's `federation-resolver.mjs` resolves a *single* skill name on
 * demand; this helper fetches every source's `index.json` and returns the whole
 * catalog so the operator can browse/search all skills.
 *
 * Source of sources: the federation manifest lives on the daemon
 * (`~/.futurator/skill-federation.yaml`) and isn't readable from the API
 * Lambda. Rather than couple the Lambda to S3/IAM, the catalog fetches each
 * source's `index.json` directly over HTTPS (the same `raw.githubusercontent`
 * URL the resolver uses). The source list defaults to the live canonical
 * source (`Futurator-ai/futurator-skills`, wired in Phase 0.2) and can be
 * overridden via the `SKILL_FEDERATION_SOURCES` env (JSON) without a redeploy
 * of this logic — Phase 3 (federation CRUD) will replace the default with the
 * S3-backed manifest.
 *
 * Pure + fetch-injectable so it unit-tests without network.
 */

/** A federation source the catalog fetches an index from. */
export interface FederationSourceLite {
  id: string;
  url: string; // github.com/<owner>/<repo>
  priority: number;
  autoTrust: boolean;
}

/** One catalog row surfaced to the UI. */
export interface CatalogSkill {
  name: string;
  kind: string;
  framework: boolean;
  version: string;
  license: string;
  description: string;
  source: string; // federation source id that carries it
  autoTrust: boolean;
}

export interface SkillCatalog {
  skills: CatalogSkill[];
  sources: Array<{ id: string; url: string; ok: boolean; skillCount: number; error?: string }>;
  fetchedAt: string;
}

/**
 * The live default — the canonical source stood up in Phase 0.2. Kept here (not
 * imported from EMBEDDED_DEFAULT_FEDERATION) because that embedded default still
 * points at the dead `futurator/futurator-skills` placeholder.
 */
export const DEFAULT_FEDERATION_SOURCES: FederationSourceLite[] = [
  {
    id: 'futurator-skills',
    url: 'https://github.com/Futurator-ai/futurator-skills',
    priority: 1,
    autoTrust: true,
  },
];

/** Resolve sources from env override, else the live default. */
export function resolveSources(env: NodeJS.ProcessEnv = process.env): FederationSourceLite[] {
  const raw = env.SKILL_FEDERATION_SOURCES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((s, i) => ({
          id: String(s.id ?? `source-${i}`),
          url: String(s.url),
          priority: Number(s.priority ?? i + 1),
          autoTrust: s.autoTrust === true || s['auto-trust'] === true,
        }));
      }
    } catch {
      // fall through to default — a malformed env should not break the catalog
    }
  }
  return DEFAULT_FEDERATION_SOURCES;
}

/**
 * Convert a source's GitHub URL to its raw `index.json` URL on `main`.
 * Mirrors `daemon/lib/federation-resolver.mjs::indexUrlForSource`.
 */
export function indexUrlForSource(sourceUrl: string): string | null {
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

const FETCH_TIMEOUT_MS = 15_000;

type FetchFn = typeof fetch;

/**
 * Fetch + flatten the federation catalog. Sources are walked in priority order;
 * when two sources carry the same skill name, the higher-priority (lower
 * number) source wins — matching the resolver's first-match semantics.
 *
 * Never throws on a single bad source: a source that 404s / times out / has a
 * bad shape is reported in `sources[].error` and contributes no skills, so the
 * catalog degrades gracefully instead of failing whole.
 */
export async function fetchSkillCatalog(
  opts: {
    sources?: FederationSourceLite[];
    fetchImpl?: FetchFn;
    now?: () => number;
  } = {},
): Promise<SkillCatalog> {
  const sources = (opts.sources ?? resolveSources())
    .slice()
    .sort((a, b) => a.priority - b.priority);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.now ?? Date.now;

  const byName = new Map<string, CatalogSkill>();
  const sourceReports: SkillCatalog['sources'] = [];

  for (const source of sources) {
    const indexUrl = indexUrlForSource(source.url);
    if (!indexUrl) {
      sourceReports.push({
        id: source.id,
        url: source.url,
        ok: false,
        skillCount: 0,
        error: 'unsupported source URL',
      });
      continue;
    }
    let count = 0;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let body: unknown;
      try {
        const res = await fetchImpl(indexUrl, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.json();
      } finally {
        clearTimeout(timer);
      }
      const list = (body as { skills?: unknown })?.skills;
      if (!Array.isArray(list)) throw new Error('index.skills not an array');
      for (const raw of list) {
        const e = raw as Record<string, unknown>;
        if (typeof e.name !== 'string' || !e.name) continue;
        if (byName.has(e.name)) continue; // higher-priority source already claimed it
        byName.set(e.name, {
          name: e.name,
          kind: typeof e.kind === 'string' ? e.kind : 'core',
          framework: e.framework === true,
          version: typeof e.version === 'string' ? e.version : 'sha:HEAD',
          license: typeof e.license === 'string' ? e.license : 'UNKNOWN',
          description: typeof e.description === 'string' ? e.description : '',
          source: source.id,
          autoTrust: source.autoTrust,
        });
        count += 1;
      }
      sourceReports.push({ id: source.id, url: source.url, ok: true, skillCount: count });
    } catch (err) {
      sourceReports.push({
        id: source.id,
        url: source.url,
        ok: false,
        skillCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, sources: sourceReports, fetchedAt: new Date(nowMs()).toISOString() };
}

/**
 * Reconciliation diff between what an app actually loaded on disk (from the
 * daemon's `skills_available` event) and the federation catalog. Surfaces the
 * three-way-disconnect drift the operator needs to see (Phase 1, Story 1.2):
 *
 *  - managed:            on-disk skills the catalog knows about (healthy)
 *  - unmanaged:          on-disk skills NOT in the catalog (drift — the agent
 *                        loaded something the federation can't resolve)
 *  - availableNotLoaded: catalog skills this app hasn't loaded
 *
 * Pure set math over names — no I/O — so it unit-tests trivially.
 */
export interface SkillReconciliation {
  onDiskCount: number;
  catalogCount: number;
  managed: string[];
  unmanaged: string[];
  availableNotLoaded: string[];
  inSync: boolean; // no unmanaged drift
}

export function diffSkillReconciliation(
  onDiskNames: string[],
  catalog: Pick<CatalogSkill, 'name'>[],
): SkillReconciliation {
  const onDisk = [...new Set(onDiskNames)].sort((a, b) => a.localeCompare(b));
  const catalogNames = new Set(catalog.map((s) => s.name));
  const onDiskSet = new Set(onDisk);

  const managed = onDisk.filter((n) => catalogNames.has(n));
  const unmanaged = onDisk.filter((n) => !catalogNames.has(n));
  const availableNotLoaded = [...catalogNames]
    .filter((n) => !onDiskSet.has(n))
    .sort((a, b) => a.localeCompare(b));

  return {
    onDiskCount: onDisk.length,
    catalogCount: catalogNames.size,
    managed,
    unmanaged,
    availableNotLoaded,
    inSync: unmanaged.length === 0,
  };
}
