/**
 * release-tags.mjs — Pipeline v2 Phase 2-B / Story 2-B-5-1 (PR-93).
 *
 * Tag-name builders + parsers for the v2.5 §29 plan/release flow:
 *
 *   <project>-plan-<plan-slug>     ← every plan completion tags this
 *   <project>-v<semver>            ← operator-promoted production release
 *   <project>-rigor-upgrade-v<semver>  ← Story 3-F-3 rigor-upgrade plan close
 *   <project>-skill-<name>-v<semver>   ← Story 3-C-7 skill-creator sub-plan
 *
 * The plan tag is the **intermediate artifact**; the semver tag is the
 * production identity. A release contains one or more plan tags; a plan
 * tag may eventually graduate into a release.
 */

const SLUG_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const SEMVER_RE = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.+-]+)?$/;

function assertSlug(label, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`release-tags: ${label} must match slug regex, got ${JSON.stringify(slug)}`);
  }
}

function assertSemver(semver) {
  if (typeof semver !== 'string' || !SEMVER_RE.test(semver)) {
    throw new Error(`release-tags: semver must match v<major>.<minor>.<patch>[-pre], got ${JSON.stringify(semver)}`);
  }
}

/**
 * Plan-completion tag. Emitted by the daemon when the last wave of a
 * plan reaches `delivered` per v2.5 §29.
 */
export function planCompletionTag({ project, planSlug }) {
  assertSlug('project', project);
  assertSlug('planSlug', planSlug);
  return `${project}-plan-${planSlug}`;
}

/**
 * Production-release semver tag. Emitted when the operator clicks
 * Publish in the Labs UI per v2.5 §29.
 */
export function productionReleaseTag({ project, semver }) {
  assertSlug('project', project);
  assertSemver(semver);
  return `${project}-${semver}`;
}

/** Rigor-upgrade plan close tag (Story 3-F-3). */
export function rigorUpgradeTag({ project, semver }) {
  assertSlug('project', project);
  assertSemver(semver);
  return `${project}-rigor-upgrade-${semver}`;
}

/** Skill-creator sub-plan close tag (Story 3-C-7). */
export function skillAuthorTag({ project, skillName, semver }) {
  assertSlug('project', project);
  assertSlug('skillName', skillName);
  assertSemver(semver);
  return `${project}-skill-${skillName}-${semver}`;
}

/**
 * Classify a tag string. Returns the kind + the parsed parts.
 *
 * @param {string} tag
 * @returns {
 *   | { kind: 'plan-completion', project: string, planSlug: string }
 *   | { kind: 'production-release', project: string, semver: string }
 *   | { kind: 'rigor-upgrade', project: string, semver: string }
 *   | { kind: 'skill-author', project: string, skillName: string, semver: string }
 *   | { kind: 'unknown' }
 * }
 */
export function classifyTag(tag) {
  if (typeof tag !== 'string') return { kind: 'unknown' };

  // skill-author: <project>-skill-<name>-v<semver>
  let m = tag.match(/^([a-z][a-z0-9-]*?)-skill-([a-z][a-z0-9-]*?)-(v\d+\.\d+\.\d+(?:-[A-Za-z0-9.+-]+)?)$/);
  if (m) return { kind: 'skill-author', project: m[1], skillName: m[2], semver: m[3] };

  // rigor-upgrade: <project>-rigor-upgrade-v<semver>
  m = tag.match(/^([a-z][a-z0-9-]*?)-rigor-upgrade-(v\d+\.\d+\.\d+(?:-[A-Za-z0-9.+-]+)?)$/);
  if (m) return { kind: 'rigor-upgrade', project: m[1], semver: m[2] };

  // plan-completion: <project>-plan-<slug>
  m = tag.match(/^([a-z][a-z0-9-]*?)-plan-([a-z][a-z0-9-]*)$/);
  if (m) return { kind: 'plan-completion', project: m[1], planSlug: m[2] };

  // production-release: <project>-v<semver>
  m = tag.match(/^([a-z][a-z0-9-]*?)-(v\d+\.\d+\.\d+(?:-[A-Za-z0-9.+-]+)?)$/);
  if (m) return { kind: 'production-release', project: m[1], semver: m[2] };

  return { kind: 'unknown' };
}

/**
 * Pick the next semver given an existing list of tags for a project.
 * Defaults: v0.1.0 when no tag exists; otherwise bump patch.
 */
export function nextSemver(existingTags, bumpKind = 'patch') {
  const versions = existingTags
    .map((t) => classifyTag(t))
    .filter((c) => c.kind === 'production-release' || c.kind === 'rigor-upgrade')
    .map((c) => c.semver)
    .filter(Boolean);

  if (versions.length === 0) return 'v0.1.0';

  const parsed = versions.map((v) => {
    const m = v.match(/^v(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  });

  parsed.sort((a, b) => {
    if (a[0] !== b[0]) return b[0] - a[0];
    if (a[1] !== b[1]) return b[1] - a[1];
    return b[2] - a[2];
  });

  const [maj, min, pat] = parsed[0];
  if (bumpKind === 'major') return `v${maj + 1}.0.0`;
  if (bumpKind === 'minor') return `v${maj}.${min + 1}.0`;
  return `v${maj}.${min}.${pat + 1}`;
}
