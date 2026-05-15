/**
 * federation-loader.mjs — Pipeline v2 Phase 3 / Story 3-C-1-1.
 *
 * Loads the skill federation manifest from `~/.futurator/skill-federation.yaml`
 * (overridable via FUTURATOR_FEDERATION_PATH env). Hand-rolled shape check —
 * mirrors the Zod contract in `functions/shared/schemas/skill-federation-schema.ts`
 * because daemon is mjs and can't consume Zod types directly. Same daemon-side-
 * mirror pattern used by Phase 2 PR-32b for RolePolicy.
 *
 * Behavior:
 *  - File missing → embedded default + `source: 'fallback'` (no error).
 *  - File present, parses + validates → parsed manifest + `source: 'file'`.
 *  - File present, fails parse/validation → embedded default + `error` field
 *    (caller surfaces as `attention.federation-manifest-invalid`).
 *
 * Cache: in-memory; manualRefresh() forces re-read (called from SIGUSR1
 * multiplexed handler).
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

const DEFAULT_FEDERATION_PATH = join(homedir(), '.futurator', 'skill-federation.yaml');

/**
 * Embedded fallback. Kept in sync with `EMBEDDED_DEFAULT_FEDERATION` in
 * `functions/shared/schemas/skill-federation-schema.ts`. Three sources:
 * Anthropic-official + futurator-internal auto-trust, community at
 * priority 99 non-auto-trust.
 */
export const EMBEDDED_DEFAULT_FEDERATION = Object.freeze({
  'manifest-version': 1,
  sources: Object.freeze([
    Object.freeze({
      id: 'anthropic-official',
      url: 'https://github.com/anthropics/skills',
      'auto-trust': true,
      priority: 1,
    }),
    Object.freeze({
      id: 'futurator-internal',
      url: 'https://github.com/futurator/futurator-skills',
      'auto-trust': true,
      priority: 2,
    }),
    Object.freeze({
      id: 'community',
      url: 'https://github.com/anthropics/skills-community',
      'auto-trust': false,
      priority: 99,
    }),
  ]),
  'refresh-cadence': 'weekly',
});

const VALID_CADENCES = new Set(['daily', 'weekly', 'monthly']);

/**
 * Pure shape validator. Returns null if valid, error string otherwise.
 * Mirrors `SkillFederationSchema.safeParse` semantics in mjs.
 */
export function validateFederationShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'manifest must be an object';
  }
  if (parsed['manifest-version'] !== 1) {
    return `unsupported manifest-version: ${JSON.stringify(parsed['manifest-version'])} (only 1 supported)`;
  }
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    return 'sources must be a non-empty array';
  }
  for (let i = 0; i < parsed.sources.length; i++) {
    const src = parsed.sources[i];
    if (!src || typeof src !== 'object') return `sources[${i}] must be an object`;
    if (typeof src.id !== 'string' || src.id.length === 0) return `sources[${i}].id missing or empty`;
    if (typeof src.url !== 'string' || !/^https?:\/\//.test(src.url)) {
      return `sources[${i}].url must be an http(s) URL`;
    }
    if (typeof src['auto-trust'] !== 'boolean') {
      return `sources[${i}].auto-trust must be boolean`;
    }
    if (!Number.isInteger(src.priority) || src.priority <= 0) {
      return `sources[${i}].priority must be positive integer`;
    }
    if (src['refresh-cadence'] !== undefined && !VALID_CADENCES.has(src['refresh-cadence'])) {
      return `sources[${i}].refresh-cadence must be one of: daily|weekly|monthly`;
    }
  }
  if (!VALID_CADENCES.has(parsed['refresh-cadence'])) {
    return 'refresh-cadence must be one of: daily|weekly|monthly';
  }
  return null;
}

/**
 * Load federation manifest from disk (or embedded default on miss/error).
 *
 * @param {string} [filePath] override path (default: ~/.futurator/skill-federation.yaml)
 * @returns {{ manifest: object, source: 'file' | 'fallback', path: string, error?: string }}
 */
export function loadFederation(filePath = DEFAULT_FEDERATION_PATH) {
  if (!existsSync(filePath)) {
    return {
      manifest: EMBEDDED_DEFAULT_FEDERATION,
      source: 'fallback',
      path: filePath,
    };
  }
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return {
      manifest: EMBEDDED_DEFAULT_FEDERATION,
      source: 'fallback',
      path: filePath,
      error: `read failed: ${e.message}`,
    };
  }
  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return {
      manifest: EMBEDDED_DEFAULT_FEDERATION,
      source: 'fallback',
      path: filePath,
      error: `yaml parse failed: ${e.message}`,
    };
  }
  const err = validateFederationShape(parsed);
  if (err) {
    return {
      manifest: EMBEDDED_DEFAULT_FEDERATION,
      source: 'fallback',
      path: filePath,
      error: `validation failed: ${err}`,
    };
  }
  return {
    manifest: parsed,
    source: 'file',
    path: filePath,
  };
}

/** SHA-256 of the canonical-JSON-serialized manifest. Used for refresh-event logs. */
export function manifestSha(manifest) {
  const canonical = JSON.stringify(manifest, Object.keys(manifest || {}).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * In-memory cache + refresh helper. Wraps loadFederation so the daemon
 * doesn't re-read the file on every SKILL-SCOUT invocation.
 */
export function createFederationCache(filePath = DEFAULT_FEDERATION_PATH) {
  let current = loadFederation(filePath);
  return {
    get() {
      return current;
    },
    /** Re-read from disk. Returns new result with old/new SHA delta for log. */
    refresh() {
      const previousSha = manifestSha(current.manifest);
      current = loadFederation(filePath);
      const newSha = manifestSha(current.manifest);
      return {
        ...current,
        previousSha,
        newSha,
        changed: previousSha !== newSha,
      };
    },
  };
}
