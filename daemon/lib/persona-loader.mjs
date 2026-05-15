/**
 * persona-loader.mjs — Pipeline v2 Phase 3 / Story 3-E-8-1 (PR-82).
 *
 * Loads a BMAD persona's content at agent session start. The persona
 * file lives in the operator's local mirror of the `futurator-personas`
 * org repo (path overridable via `FUTURATOR_PERSONAS_ROOT` env).
 *
 * v2.5 §42 invariants:
 *   - Personas are versioned independently with semver tags per file
 *   - Plans pin a version at creation; updates to the repo don't
 *     retroactively change running plans
 *   - Persona changes require operator approval regardless of confidence
 *     (the Reflection Inbox `target: agent-persona` flow already
 *     enforces this since PR-74; the Inbox UI from PR-76 surfaces it)
 *   - No persona forking — capability variation lives in the skill
 *     manifest, not in the persona prompt
 *
 * This module handles the **read side**: given `Plan.personaPinned` and
 * a persona name, return the content of that persona at that version.
 * The write side (operator-confirmed REFLECTOR-APPLY → PR against
 * `futurator-personas`) is Story 3-E-8 follow-on.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DEFAULT_PERSONAS_ROOT =
  process.env.FUTURATOR_PERSONAS_ROOT || join(process.env.HOME || '/home/ubuntu', 'personas');

/**
 * Normalize a semver pin string. Accepts:
 *   "v1.2.0", "1.2.0", "bedrock-v1.2.0"
 * Returns the canonical `<persona>-v<semver>` form when persona is
 * supplied; otherwise the bare semver `v1.2.0`.
 */
export function canonicalPersonaTag(personaName, pin) {
  const p = String(pin).trim();
  const stripped = p.startsWith(`${personaName}-`) ? p.slice(personaName.length + 1) : p;
  const withV = stripped.startsWith('v') ? stripped : `v${stripped}`;
  return `${personaName}-${withV}`;
}

/**
 * Resolve a persona file's on-disk path given the personas-root layout:
 *
 *   <root>/<persona>/<persona>-v<semver>.md       ← pinned version
 *   <root>/<persona>/latest.md                    ← floating; fallback when no pin
 *
 * @param {string} personaName e.g. "bedrock"
 * @param {string | undefined} pinnedSemver from Plan.personaPinned[personaName]
 * @param {{ root?: string }} [opts]
 * @returns {{ path: string, source: 'pinned' | 'latest' | 'missing' }}
 */
export function resolvePersonaPath(personaName, pinnedSemver, opts = {}) {
  const root = opts.root || DEFAULT_PERSONAS_ROOT;
  const personaDir = join(root, personaName);

  if (pinnedSemver) {
    const tag = canonicalPersonaTag(personaName, pinnedSemver);
    const pinnedPath = join(personaDir, `${tag}.md`);
    if (existsSync(pinnedPath)) {
      return { path: pinnedPath, source: 'pinned' };
    }
  }

  const latestPath = join(personaDir, 'latest.md');
  if (existsSync(latestPath)) {
    return { path: latestPath, source: 'latest' };
  }

  return { path: '', source: 'missing' };
}

/**
 * Load persona content for an agent session. Returns `null` when the
 * persona isn't installed (operator hasn't synced the `futurator-personas`
 * repo yet); the caller falls back to a non-personalized prompt.
 *
 * @param {{
 *   personaName: string,
 *   plan?: { personaPinned?: Record<string, string> },
 *   root?: string,
 * }} args
 * @returns {{ content: string, version: string, source: 'pinned' | 'latest' } | null}
 */
export function loadPersona({ personaName, plan, root }) {
  if (!personaName) return null;
  const pinned = plan?.personaPinned?.[personaName];
  const { path, source } = resolvePersonaPath(personaName, pinned, { root });
  if (source === 'missing') return null;
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  // Extract version from filename for the forensic event. For `latest.md`,
  // we don't know the actual version — return 'latest'.
  let version = 'latest';
  if (source === 'pinned' && pinned) {
    version = canonicalPersonaTag(personaName, pinned);
  }
  return { content, version, source };
}

/**
 * Snapshot the latest tag per persona — used at plan creation time to
 * populate `Plan.personaPinned`. Reads each persona dir, finds the
 * highest-semver tag file, returns `Record<personaName, semver>`.
 *
 * Returns empty object when personas root is missing (operator hasn't
 * synced the repo yet); plan creation logs the implicit pin = "latest"
 * and proceeds.
 */
export function snapshotLatestPersonaVersions(opts = {}) {
  const root = opts.root || DEFAULT_PERSONAS_ROOT;
  if (!existsSync(root)) return {};
  const out = {};
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return {};
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const personaName = entry.name;
    const tag = findHighestVersionTag(join(root, personaName), personaName);
    if (tag) out[personaName] = tag;
  }
  return out;
}

function findHighestVersionTag(personaDir, personaName) {
  let files;
  try {
    files = readdirSync(personaDir);
  } catch {
    return null;
  }
  const re = new RegExp(`^${personaName}-v(\\d+)\\.(\\d+)\\.(\\d+)\\.md$`);
  let highest = null;
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const parts = [+m[1], +m[2], +m[3]];
    if (!highest || compareSemver(parts, highest.parts) > 0) {
      highest = { parts, tag: `v${parts.join('.')}` };
    }
  }
  return highest?.tag || null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
