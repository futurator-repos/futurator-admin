/**
 * skill-trust.mjs — Skills Institution, Story 4.2 (2026-06-17).
 *
 * The hard invariant for success criterion #2: NO unvetted skill reaches an app.
 * SKILL-SCOUT / the vendor step install a skill ONLY when this predicate says so.
 *
 * The rule, designed to enforce the invariant WITHOUT breaking the live pipeline
 * (the 245 incumbents have no trustTier until the retro-scan, Story 4.1, stamps
 * them):
 *
 *   trustTier 'trusted'                       → installable (anywhere)
 *   trustTier set but not 'trusted'           → NOT installable
 *     (reviewed = browsable shelf; draft = pre-ratify; deprecated = retired)
 *   trustTier absent (legacy, un-stamped)     → installable ONLY from an
 *                                               auto-trust source (the operator's
 *                                               own curated federation), i.e. the
 *                                               established working set is
 *                                               grandfathered; a non-auto-trust
 *                                               (community) source needs explicit
 *                                               'trusted'.
 *
 * Once the retro-scan stamps the incumbents, clean auto-trust-source skills are
 * marked 'trusted' (not 'reviewed'), so this predicate keeps them installable
 * while a freshly-pulled community skill stays blocked until ratified.
 *
 * Pure + dependency-free; importable by the resolver, the vendor step, and tests.
 */

/**
 * @param {{ trustTier?: string } | null | undefined} entry — the index entry.
 * @param {{ autoTrust?: boolean }} [source]
 * @returns {boolean}
 */
export function isInstallable(entry, source = {}) {
  const tier = entry?.trustTier;
  if (tier === 'trusted') return true;
  if (tier) return false; // reviewed | draft | deprecated — explicitly gated
  return source?.autoTrust === true; // legacy: grandfather only on trusted sources
}

/**
 * Why an entry is blocked (null when installable) — for operator-facing logs.
 * @returns {string | null}
 */
export function installBlockReason(entry, source = {}) {
  const tier = entry?.trustTier;
  if (tier === 'trusted') return null;
  if (tier === 'deprecated') return 'deprecated';
  if (tier === 'reviewed') return 'reviewed-not-trusted';
  if (tier === 'draft') return 'draft-not-ratified';
  if (tier) return `untrusted-tier:${tier}`;
  return source?.autoTrust === true ? null : 'untrusted-source';
}
