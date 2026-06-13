/**
 * gen-skill-index.mjs — Skills Management Phase 0, Story 0.1 (2026-06-13).
 *
 * Walks a directory of skills (`<dir>/<name>/SKILL.md`) and emits a federation
 * `index.json` that satisfies the resolver contract in
 * `daemon/lib/federation-resolver.mjs`:
 *
 *   { "skills": [ { "name", "kind", "version", "license", "description" }, ... ] }
 *
 * The resolver keys the array by `entry.name` and reads `entry.kind`; the
 * remaining fields are surfaced by the catalog UI (Phase 1). This generator is
 * the seed tool for the canonical `futurator-skills` source (Option A): it
 * turns the real on-disk skill set (56 bmad-* + 3 anthropic, per the daemon
 * ground-truth in docs/concepts/skills-management/skills-management-plan.md)
 * into a resolvable index.
 *
 * Pure-data, non-outward-facing: it only reads SKILL.md files and writes a JSON
 * file. No network, no git, no daemon mutation.
 *
 * Frontmatter reality (verified on daemon 2026-06-13):
 *   - every SKILL.md has `name` + `description`
 *   - anthropic skills carry `license` (often "Complete terms in LICENSE.txt")
 *   - bmad-* skills carry no `license` field
 *   - no SKILL.md carries `kind` or `version` — both are inferred here
 *
 * Usage:
 *   node scripts/gen-skill-index.mjs --dir <skills-dir> [--out <index.json>]
 *   node scripts/gen-skill-index.mjs --dir ./skills --out ./index.json
 *   # omit --out to print to stdout
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Extract and parse the YAML frontmatter block from a SKILL.md body. Returns
 * an empty object when no frontmatter is present (we still index the skill by
 * its directory name in that case rather than dropping it).
 *
 * @param {string} md
 * @returns {Record<string, unknown>}
 */
export function parseFrontmatter(md) {
  if (typeof md !== 'string') return {};
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Malformed frontmatter: index by dir name, leave metadata empty. We do
    // not throw — one bad SKILL.md should not abort a 59-skill index build.
    return {};
  }
}

/**
 * Infer a skill's `kind`. We keep kinds aligned with the manifest buckets the
 * pipeline already understands (core/stack/domain/vendor — see
 * project-skill-manifest-schema.ts). bmad-* are dev-workflow framework skills;
 * we tag them `framework` via the separate `framework` flag but keep `kind`
 * as `core` so existing kind-filtered resolves keep working. Everything else
 * defaults to `core`.
 *
 * @param {string} name
 * @returns {{ kind: string, framework: boolean }}
 */
export function inferKind(name) {
  const framework = name.startsWith('bmad-');
  return { kind: 'core', framework };
}

/**
 * Resolve a skill's license. Prefer an explicit frontmatter `license`. If the
 * skill ships a LICENSE/LICENSE.txt file, report that the license lives there.
 * Otherwise `UNKNOWN` — kept honest so the Phase-1 catalog and SKILL-SCOUT's
 * permissive-license verify can flag unverified skills rather than assume MIT.
 *
 * @param {string} skillDir
 * @param {Record<string, unknown>} fm
 * @returns {string}
 */
export function resolveLicense(skillDir, fm) {
  if (typeof fm.license === 'string' && fm.license.trim()) return fm.license.trim();
  for (const f of ['LICENSE.txt', 'LICENSE', 'LICENSE.md']) {
    if (existsSync(join(skillDir, f))) return `See ${f}`;
  }
  return 'UNKNOWN';
}

/**
 * Build the federation index for a skills directory. Pure function over the
 * filesystem — returns the object; the caller decides where it goes.
 *
 * @param {string} skillsDir  directory containing `<name>/SKILL.md` subdirs
 * @returns {{ skills: Array<{ name: string, kind: string, framework: boolean, version: string, license: string, description: string }> }}
 */
export function buildSkillIndex(skillsDir) {
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    throw new Error(`gen-skill-index: not a directory: ${skillsDir}`);
  }
  const skills = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue; // not a skill dir

    const fm = parseFrontmatter(readFileSync(skillMd, 'utf8'));
    const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : entry.name;
    const { kind, framework } = inferKind(name);
    skills.push({
      name,
      kind,
      framework,
      version: 'sha:HEAD', // placeholder; vendor-skills resolves to source HEAD at sync (matches prepin-default-skills)
      license: resolveLicense(skillDir, fm),
      description: typeof fm.description === 'string' ? fm.description.trim() : '',
    });
  }
  // Deterministic order so the generated index.json diffs cleanly in git.
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills };
}

// ── CLI ──────────────────────────────────────────────────────────────────

/** Minimal flag parser: --dir <v> --out <v>. */
export function parseArgs(argv) {
  const out = { dir: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

// Only run the CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dir, out } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error('usage: node scripts/gen-skill-index.mjs --dir <skills-dir> [--out <index.json>]');
    process.exit(2);
  }
  const index = buildSkillIndex(dir);
  const json = `${JSON.stringify(index, null, 2)}\n`;
  if (out) {
    writeFileSync(out, json);
    console.error(`gen-skill-index: wrote ${index.skills.length} skill(s) → ${out}`);
  } else {
    process.stdout.write(json);
  }
}
