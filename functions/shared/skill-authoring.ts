/**
 * skill-authoring.ts — Skills Management Phase 2 (2026-06-15).
 *
 * Add / edit / remove operator-authored skills in the canonical federation
 * source (`futurator-repos/futurator-skills`). A skill is two files in that
 * repo, kept in lockstep:
 *
 *   skills/<name>/SKILL.md   — the body the agent loads (frontmatter + prose)
 *   index.json               — the catalog entry the resolver + Registry read
 *
 * The pure functions (`buildSkillMd`, `upsertIndexEntry`, `removeIndexEntry`)
 * are unit-tested directly; `putSkill`/`deleteSkill` orchestrate the GitHub
 * Contents API around them. Writes are two sequential commits (SKILL.md then
 * index.json) — non-atomic but acceptable for a single-operator low-traffic
 * registry; index.json is written LAST so a half-write never advertises a skill
 * whose body is missing.
 *
 * Authoring is restricted to operator-owned skills (framework=false). bmad
 * skills (framework=true) are catalogued from the bmad-method package and are
 * not editable here — the endpoints enforce that guard.
 */

import { getFileContent, putFile, deleteFile } from './github/connector';
import { SKILL_SOURCE_OWNER, SKILL_SOURCE_REPO } from './skill-catalog';
import type {
  SkillIndexEntry,
  SkillIndex,
  ProvenanceClass,
  SecurityStatus,
  TrustTier,
  QualityGrade,
  SkillLineage,
} from './schemas/skill-index-entry-schema';

// The entry/index shapes are now defined as zod contracts in
// `schemas/skill-index-entry-schema.ts` (Story 2.1) so the curation facets have
// a single source of truth. Re-export them here so existing importers keep
// working unchanged.
export type {
  SkillIndexEntry,
  SkillIndex,
  ProvenanceClass,
  SecurityStatus,
  TrustTier,
  QualityGrade,
  SkillLineage,
};

/** A slug usable as a directory name + skill id. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Double-quote + escape a YAML scalar so free-text descriptions stay valid. */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Assemble a SKILL.md from its parts: YAML frontmatter (name + description) and
 * the markdown body. Mirrors the shape every existing SKILL.md uses.
 */
export function buildSkillMd(input: { name: string; description: string; body: string }): string {
  const fm = `---\nname: ${input.name}\ndescription: ${yamlQuote(input.description)}\n---\n`;
  const body = input.body.trim();
  return `${fm}\n${body}\n`;
}

/** Reverse `yamlQuote`: strip surrounding quotes + unescape `\"` and `\\`. */
function yamlUnquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return t;
}

/**
 * Inverse of `buildSkillMd`: split a SKILL.md into its frontmatter `name` /
 * `description` and the prose `body`. Tolerant of skills NOT authored here
 * (unquoted descriptions, extra frontmatter keys, no frontmatter at all) — for
 * those it returns what it can and treats the rest as body. `buildSkillMd` of a
 * parsed result round-trips to the canonical shape (re-quotes the description,
 * re-emits the fence), so edit→save→re-read is idempotent.
 */
export function parseSkillMd(md: string): {
  name: string | null;
  description: string | null;
  body: string;
} {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!fence) {
    return { name: null, description: null, body: md.trim() };
  }
  const frontmatter = fence[1];
  const body = md.slice(fence[0].length).trim();
  const nameLine = /^name:[ \t]*(.*)$/m.exec(frontmatter);
  const descLine = /^description:[ \t]*(.*)$/m.exec(frontmatter);
  return {
    name: nameLine ? nameLine[1].trim() : null,
    description: descLine ? yamlUnquote(descLine[1]) : null,
    body,
  };
}

/**
 * Read a skill's SKILL.md from the canonical repo and return its parsed body.
 * Returns `body: null` when the file is absent (framework/bmad skills live in
 * the bmad-method package, not here) or too large — callers degrade gracefully
 * instead of erroring.
 */
export async function getSkillBody(
  name: string,
  opts: { owner?: string; repo?: string } = {},
): Promise<{ body: string | null; sha: string | null }> {
  const owner = opts.owner ?? SKILL_SOURCE_OWNER;
  const repo = opts.repo ?? SKILL_SOURCE_REPO;
  try {
    const { data } = await getFileContent(owner, repo, skillMdPath(name), BRANCH);
    if ('tooLarge' in data) return { body: null, sha: null };
    return { body: parseSkillMd(data.content).body, sha: data.sha };
  } catch {
    return { body: null, sha: null };
  }
}

/** Insert or replace an index entry by name; keep the list name-sorted. */
export function upsertIndexEntry(index: SkillIndex, entry: SkillIndexEntry): SkillIndex {
  const skills = (index.skills ?? []).filter((s) => s.name !== entry.name);
  skills.push(entry);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { ...index, skills };
}

/** Remove an index entry by name (no-op if absent). */
export function removeIndexEntry(index: SkillIndex, name: string): SkillIndex {
  return { ...index, skills: (index.skills ?? []).filter((s) => s.name !== name) };
}

const BRANCH = 'main';
const INDEX_PATH = 'index.json';
const skillMdPath = (name: string) => `skills/${name}/SKILL.md`;

/** Fetch + parse the source's index.json (throws if unreadable/malformed). */
async function readIndex(owner: string, repo: string): Promise<SkillIndex> {
  const { data } = await getFileContent(owner, repo, INDEX_PATH, BRANCH);
  if ('tooLarge' in data) throw new Error('index.json too large to read');
  const parsed = JSON.parse(data.content) as SkillIndex;
  if (!Array.isArray(parsed.skills)) throw new Error('index.json: skills is not an array');
  return parsed;
}

export interface PutSkillInput {
  name: string;
  description: string;
  body: string;
  kind?: string;
  license?: string;
  /**
   * Curation facets (Story 2.1). Optional and additive: when omitted, an
   * existing entry's facets are preserved on update, and a brand-new entry is
   * left facet-free (the catalog/migration applies safe defaults on read). The
   * gate (Story 3.5 ratify) supplies real facets — notably `trustTier` — when
   * publishing a vetted skill.
   */
  facets?: Partial<
    Pick<
      SkillIndexEntry,
      'provenanceClass' | 'securityStatus' | 'qualityGrade' | 'trustTier' | 'maturity' | 'lineage'
    >
  >;
}

/** Pick only the facet keys from an entry (drops the seven base fields). */
function pickFacets(entry: SkillIndexEntry | undefined): Partial<SkillIndexEntry> {
  if (!entry) return {};
  const { provenanceClass, securityStatus, qualityGrade, trustTier, maturity, lineage } = entry;
  const facets: Partial<SkillIndexEntry> = {};
  if (provenanceClass !== undefined) facets.provenanceClass = provenanceClass;
  if (securityStatus !== undefined) facets.securityStatus = securityStatus;
  if (qualityGrade !== undefined) facets.qualityGrade = qualityGrade;
  if (trustTier !== undefined) facets.trustTier = trustTier;
  if (maturity !== undefined) facets.maturity = maturity;
  if (lineage !== undefined) facets.lineage = lineage;
  return facets;
}

/**
 * Create or update an operator-authored skill: write SKILL.md, then upsert the
 * index.json entry. Returns whether it was a create vs update + the commit shas.
 */
export async function putSkill(
  input: PutSkillInput,
  opts: { owner?: string; repo?: string } = {},
): Promise<{ name: string; created: boolean; skillCommit: string; indexCommit: string }> {
  const owner = opts.owner ?? SKILL_SOURCE_OWNER;
  const repo = opts.repo ?? SKILL_SOURCE_REPO;
  if (!SKILL_NAME_RE.test(input.name)) {
    throw new Error(`invalid skill name "${input.name}" (must match ${SKILL_NAME_RE})`);
  }

  const index = await readIndex(owner, repo);
  const existing = index.skills.find((s) => s.name === input.name);
  const created = !existing;

  // 1. body first
  const md = buildSkillMd({ name: input.name, description: input.description, body: input.body });
  const { commitSha: skillCommit } = await putFile(
    owner,
    repo,
    skillMdPath(input.name),
    md,
    `${created ? 'add' : 'update'} skill: ${input.name}`,
    BRANCH,
  );

  // 2. index entry last (so a half-write never advertises a bodyless skill).
  // Facets carry over from the prior entry on update, then any explicit input
  // facets win — so ratify (Story 3.5) can stamp trustTier without clobbering
  // an existing securityStatus, and a plain edit never silently downgrades trust.
  const entry: SkillIndexEntry = {
    name: input.name,
    kind: input.kind ?? 'core',
    framework: false,
    version: 'sha:HEAD',
    license: input.license ?? 'UNKNOWN',
    description: input.description,
    provenance: 'operator-authored',
    ...pickFacets(existing),
    ...(input.facets ?? {}),
  };
  const nextIndex = upsertIndexEntry(index, entry);
  const { commitSha: indexCommit } = await putFile(
    owner,
    repo,
    INDEX_PATH,
    `${JSON.stringify(nextIndex, null, 2)}\n`,
    `${created ? 'add' : 'update'} index entry: ${input.name}`,
    BRANCH,
  );

  return { name: input.name, created, skillCommit, indexCommit };
}

/**
 * Remove an operator-authored skill: drop the index entry first (so it stops
 * being advertised immediately), then delete the SKILL.md body.
 */
export async function deleteSkill(
  name: string,
  opts: { owner?: string; repo?: string } = {},
): Promise<{ name: string; removedFromIndex: boolean; bodyDeleted: boolean }> {
  const owner = opts.owner ?? SKILL_SOURCE_OWNER;
  const repo = opts.repo ?? SKILL_SOURCE_REPO;

  const index = await readIndex(owner, repo);
  const present = index.skills.some((s) => s.name === name);
  if (present) {
    const nextIndex = removeIndexEntry(index, name);
    await putFile(
      owner,
      repo,
      INDEX_PATH,
      `${JSON.stringify(nextIndex, null, 2)}\n`,
      `remove index entry: ${name}`,
      BRANCH,
    );
  }
  const { deleted } = await deleteFile(
    owner,
    repo,
    skillMdPath(name),
    `remove skill: ${name}`,
    BRANCH,
  );
  return { name, removedFromIndex: present, bodyDeleted: deleted };
}
