/**
 * vendor-skills.mjs — Pipeline v2 Phase 3-C Epic 2 (Story 2.3, 2026-05-19).
 *
 * Materializes the project's skill manifest into vendored SKILL.md files under
 * `.claude/skills/<name>/`, so the committed scaffold carries the loadout and
 * every per-story worktree (forked from committed content) sees the skills.
 *
 * 2026-06-01 — REWRITTEN to fetch DAEMON-SIDE instead of spawning the
 * in-worktree `scripts/skills-sync.mjs`. The in-project script had three
 * environmental blockers in a fresh app that left it silently soft-failing
 * (dino2 forensic): (1) it `import`s `yaml`, which the scaffold's node_modules
 * doesn't include → ERR_MODULE_NOT_FOUND; (2) it reads
 * `~/.futurator/skill-federation.yaml`, which doesn't exist (only the daemon
 * has an embedded fallback); (3) it fetched `<repo>/<ref>/<skill>/SKILL.md`
 * but Anthropic's repo nests skills under `skills/<name>/`. The daemon already
 * has `yaml`, the embedded federation, the PAT, and `fetch` — so it does the
 * vendoring directly. Result shape is unchanged (non-blocking, attention on
 * failure) so the app-bootstrap saga + tests are unaffected.
 *
 * Non-blocking by design: vendoring failure surfaces an attention item but
 * lets bootstrap complete (Epic 2). The post-commit `assert-skills-committed`
 * guard also warns (not throws) so a vendor miss never bricks the app.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EMBEDDED_DEFAULT_FEDERATION, loadFederation } from '../federation-loader.mjs';
import { isInstallable, installBlockReason } from '../skill-trust.mjs';

const MANIFEST_REL = '.claude/skills.manifest.yaml';
const SKILLS_DIR_REL = '.claude/skills';
const DEFAULT_TIMEOUT_MS = 120_000;
/** Anthropic + community repos nest skills under `skills/<name>/`. A source
 *  may override via a `path` field; default to this convention. */
const DEFAULT_SOURCE_SUBDIR = 'skills';

/** sha:HEAD → the repo default branch; sha:<40hex> → that SHA; else verbatim. */
function refForVersion(version) {
  if (!version || version === 'sha:HEAD') return 'main';
  if (version.startsWith('sha:')) return version.slice(4) || 'main';
  return version;
}

function repoPathFromUrl(url) {
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  } catch {
    return null;
  }
}

/**
 * Resolve the federation sources, preferring a real file (operator-authored)
 * and falling back to the embedded default. Returns a Map id→source.
 */
function resolveSources(federationPath) {
  let sources = EMBEDDED_DEFAULT_FEDERATION.sources;
  try {
    const loaded = loadFederation(federationPath);
    const fed = loaded?.federation ?? loaded;
    if (fed?.sources?.length) sources = fed.sources;
  } catch {
    /* fall back to embedded */
  }
  return new Map(sources.map((s) => [s.id, s]));
}

/**
 * Vendor the manifest-pinned skills into `<worktreeDir>/.claude/skills/<name>/`.
 * Daemon-side fetch; same return contract as before.
 *
 * @param {object}   args
 * @param {string}   args.worktreeDir
 * @param {boolean}  [args.skip]
 * @param {function} [args.onOutput]            — (stream, data) => void
 * @param {function} [args.fetchImpl]           — injectable for tests
 * @param {string}   [args.federationPath]
 * @param {string}   [args.pat]                 — defaults to env GITHUB_PAT
 * @param {number}   [args.timeoutMs]
 * @returns {Promise<{ skipped: boolean, reason?: string, vendoredCount: number,
 *   failed?: number, attentionCategory?: string, attentionSeverity?: string }>}
 */
export async function runVendorSkills({
  worktreeDir,
  skip = false,
  onOutput,
  fetchImpl = fetch,
  federationPath = process.env.FUTURATOR_FEDERATION_PATH,
  pat = process.env.GITHUB_PAT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!worktreeDir) throw new Error('runVendorSkills: worktreeDir required');
  const log = (msg) => onOutput?.('stdout', msg + '\n');

  if (skip) return { skipped: true, reason: 'stub-boilerplate', vendoredCount: 0 };

  const manifestPath = join(worktreeDir, MANIFEST_REL);
  if (!existsSync(manifestPath)) {
    return { skipped: true, reason: 'no-manifest', vendoredCount: 0 };
  }

  let manifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return {
      skipped: true,
      reason: `manifest-parse-failed: ${e.message}`,
      vendoredCount: 0,
      attentionCategory: 'skill-sync-failed',
      attentionSeverity: 'medium',
    };
  }

  const entries = [
    ...(manifest?.core || []),
    ...(manifest?.stack || []),
    ...(manifest?.domain || []),
    ...(manifest?.vendor || []),
  ].filter((e) => e && e.skill && e.source);

  if (entries.length === 0) {
    log('[vendor-skills] manifest declares no skills — nothing to vendor');
    return { skipped: true, reason: 'no-skills', vendoredCount: 0 };
  }

  const sourceById = resolveSources(federationPath);
  const deadline = Date.now() + timeoutMs;
  let vendored = 0;
  let failed = 0;
  let skippedOnDisk = 0;
  let blocked = 0; // Story 4.2 — entries refused by the trust gate.

  // Story 4.2 — per-source index.json cache (name→entry) so the trust gate can
  // read each candidate's trustTier. Fetched lazily, once per source. A failed
  // fetch yields an empty map → isInstallable falls back to the source's
  // auto-trust (auto-trust sources stay working; community sources fail closed).
  const sourceIndexCache = new Map();
  async function getSourceIndexEntry(src, repo, skillName) {
    if (!sourceIndexCache.has(src.id)) {
      const map = new Map();
      try {
        const headers = { Accept: 'application/json' };
        if (pat) headers.Authorization = `Bearer ${pat}`;
        const res = await fetchImpl(`https://raw.githubusercontent.com/${repo}/main/index.json`, {
          headers,
        });
        if (res.ok) {
          const body = await res.json();
          for (const e of Array.isArray(body?.skills) ? body.skills : []) {
            if (e && typeof e.name === 'string') map.set(e.name, e);
          }
        }
      } catch {
        // leave map empty → fail-safe per source auto-trust
      }
      sourceIndexCache.set(src.id, map);
    }
    return sourceIndexCache.get(src.id).get(skillName);
  }

  for (const entry of entries) {
    if (Date.now() > deadline) {
      log('[vendor-skills] timeout — stopping');
      failed += 1;
      break;
    }
    // Skills Mgmt 0.3 — idempotency / re-vendor guard: if the skill body is
    // already materialized on disk, don't re-fetch. This makes vendor-skills
    // safe to run over a reconciled manifest, where entries (e.g. the ~56 bmad
    // skills installed by bmad-bootstrap) are pinned to the index-only
    // `futurator-skills` source that carries no bodies — fetching would 404.
    if (existsSync(join(worktreeDir, SKILLS_DIR_REL, entry.skill, 'SKILL.md'))) {
      skippedOnDisk += 1;
      continue;
    }
    const src = sourceById.get(entry.source);
    if (!src) {
      log(`[vendor-skills] WARN ${entry.skill}: source '${entry.source}' not in federation`);
      failed += 1;
      continue;
    }
    const repo = repoPathFromUrl(src.url);
    if (!repo) {
      log(`[vendor-skills] WARN ${entry.skill}: bad source url ${src.url}`);
      failed += 1;
      continue;
    }
    // Story 4.2 — TRUSTED-ONLY install gate. A skill only reaches the app if it
    // is trusted (or a legacy entry on an auto-trust source). Checked here, at
    // the disk-write point, AFTER the on-disk skip above — so the 245 incumbents
    // already vendored are untouched; only NEW installs are gated.
    const autoTrust = src['auto-trust'] === true;
    const idxEntry = await getSourceIndexEntry(src, repo, entry.skill);
    if (!isInstallable(idxEntry, { autoTrust })) {
      log(
        `[vendor-skills] BLOCKED ${entry.skill}@${entry.source}: ${installBlockReason(idxEntry, { autoTrust })} (not trusted — install refused)`,
      );
      blocked += 1;
      continue;
    }
    const ref = refForVersion(entry.version);
    const subdir = src.path || DEFAULT_SOURCE_SUBDIR;
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${subdir}/${entry.skill}/SKILL.md`;
    try {
      const headers = { Accept: 'text/plain' };
      if (pat) headers.Authorization = `Bearer ${pat}`;
      const res = await fetchImpl(url, { headers });
      if (!res.ok) {
        log(`[vendor-skills] ERROR ${entry.skill}@${entry.source}: HTTP ${res.status} (${url})`);
        failed += 1;
        continue;
      }
      const skillMd = await res.text();
      const dir = join(worktreeDir, SKILLS_DIR_REL, entry.skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf-8');
      vendored += 1;
      log(`[vendor-skills] WROTE ${entry.skill}@${entry.source}`);
    } catch (e) {
      log(`[vendor-skills] ERROR ${entry.skill}@${entry.source}: ${e.message}`);
      failed += 1;
    }
  }

  if (failed > 0 && vendored === 0) {
    // Total failure — surface medium attention, but stay non-blocking.
    return {
      skipped: true,
      reason: `vendor-failed (${failed} skill(s))`,
      vendoredCount: 0,
      failed,
      attentionCategory: 'skill-sync-failed',
      attentionSeverity: 'medium',
    };
  }
  if (skippedOnDisk > 0) {
    log(`[vendor-skills] skipped ${skippedOnDisk} skill(s) already present on disk`);
  }
  if (blocked > 0) {
    log(`[vendor-skills] BLOCKED ${blocked} non-trusted skill(s) from install (Story 4.2)`);
  }
  return {
    skipped: false,
    vendoredCount: vendored,
    failed,
    skippedOnDisk,
    blocked,
    ...(failed > 0
      ? { attentionCategory: 'skill-manifest-out-of-sync', attentionSeverity: 'low' }
      : {}),
  };
}
