/**
 * loaded-skills-tracker.mjs — Pipeline v2 Phase 3-C Epic 4 (2026-05-20).
 *
 * Tracks which skills an agent actually USED during a job run, so the
 * `Skills-Used:` commit trailer (PR-73 / Story 3-C-4-1) populates with
 * real content instead of the empty-label form.
 *
 * Signal source: Claude Code's built-in `Skill` tool. When an agent
 * activates a skill via prompt-content match, the stream-json emits a
 * `tool_use` block with `name: "Skill"` and `input: { skill: "<name>" }`.
 * The Story 2.0 probe confirmed this is the auto-activation contract
 * (see `docs/concepts/logs/skills-probe-2026-05-19/probe-2-relevance-activation.md`).
 *
 * Output: append-merged `<workingDir>/.context/loaded-skills.json`. The
 * commit-metadata shell (`functions/shared/pipelines/commit-metadata.ts::
 * buildCommitShellSnippet`) reads this file via `node -e ...` at story-
 * commit time and emits each entry as a `<skill>@<source>` token on the
 * `Skills-Used:` trailer line.
 *
 * Idempotency: re-running the same agent step over the same job does not
 * duplicate entries. The file is a Set keyed by `<skill>@<source>`.
 *
 * Source attribution: a skill's `@source` comes from
 * `<workingDir>/.claude/skills.manifest.yaml` — we look up the skill name
 * in core/stack/domain/vendor buckets to find which federation source
 * shipped it. If the skill is on disk but not in the manifest (rare;
 * could happen if `npx skills sync --resync` ran after a manifest revert),
 * we fall back to `source: 'unknown'`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const CONTEXT_DIR_REL = '.context';
const LOADED_SKILLS_REL = '.context/loaded-skills.json';
const MANIFEST_REL = '.claude/skills.manifest.yaml';

/**
 * Build a `<skill> → source` lookup from the project's manifest. Returns
 * an empty Map when the manifest is missing/malformed — the tracker
 * still records the skill name with `source: 'unknown'` so the commit
 * trailer at least shows what was activated.
 *
 * @param {string} workingDir
 * @returns {Map<string, string>}
 */
export function buildSkillSourceLookup(workingDir) {
  const manifestPath = join(workingDir, MANIFEST_REL);
  if (!existsSync(manifestPath)) return new Map();
  let manifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return new Map();
  }
  if (!manifest || typeof manifest !== 'object') return new Map();
  const out = new Map();
  for (const bucket of ['core', 'stack', 'domain', 'vendor']) {
    const arr = manifest[bucket];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (entry && typeof entry.skill === 'string' && typeof entry.source === 'string') {
        out.set(entry.skill, entry.source);
      }
    }
  }
  return out;
}

/**
 * Read the current `.context/loaded-skills.json` (or return empty array on
 * miss / parse error). Always returns an array of `{skill, source}` objs
 * sorted alphabetically so the commit shell's Set-based de-dup stays
 * deterministic.
 *
 * @param {string} workingDir
 * @returns {Array<{skill: string, source: string}>}
 */
export function readLoadedSkills(workingDir) {
  const path = join(workingDir, LOADED_SKILLS_REL);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) => e && typeof e.skill === 'string' && typeof e.source === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Append a skill activation to the project's loaded-skills file. Idempotent:
 * re-recording the same skill is a no-op (set semantics). Returns the new
 * total count after the upsert.
 *
 * @param {object} args
 * @param {string} args.workingDir
 * @param {string} args.skillName    — `block.input.skill` from the Skill tool_use
 * @param {Map<string,string>} [args.sourceLookup]  — pre-built lookup; tracker
 *                                  builds one lazily if absent (slower).
 * @returns {{ written: boolean, total: number, source: string }}
 */
export function recordSkillActivation({ workingDir, skillName, sourceLookup }) {
  if (!workingDir) throw new Error('recordSkillActivation: workingDir required');
  if (typeof skillName !== 'string' || skillName.length === 0) {
    throw new Error('recordSkillActivation: skillName required');
  }

  const lookup = sourceLookup ?? buildSkillSourceLookup(workingDir);
  const source = lookup.get(skillName) ?? 'unknown';

  const existing = readLoadedSkills(workingDir);
  const key = `${skillName}@${source}`;
  const already = existing.some((e) => `${e.skill}@${e.source}` === key);
  if (already) {
    return { written: false, total: existing.length, source };
  }

  const next = [...existing, { skill: skillName, source }].sort((a, b) =>
    `${a.skill}@${a.source}`.localeCompare(`${b.skill}@${b.source}`),
  );

  // Ensure .context/ exists. .context/.gitignore (shipped via the
  // baseline-diff augment) excludes the directory from commits — the
  // loaded-skills file stays local; the Skills-Used trailer is the
  // durable record.
  const contextDir = join(workingDir, CONTEXT_DIR_REL);
  if (!existsSync(contextDir)) {
    try {
      mkdirSync(contextDir, { recursive: true });
    } catch {
      // Best effort — if mkdir fails the writeFileSync below will too,
      // and we throw. Caller (the daemon's pushEvent path) catches all
      // tracker errors as non-fatal.
    }
  }

  writeFileSync(join(workingDir, LOADED_SKILLS_REL), JSON.stringify(next, null, 2), 'utf-8');
  return { written: true, total: next.length, source };
}

/**
 * Reset the loaded-skills file. Useful for the next story's reset point
 * — the daemon could call this between stories so each Skills-Used line
 * reflects ONLY the skills activated for that specific story (rather than
 * accumulating across all stories in the plan).
 *
 * v1 default: ACCUMULATE across the job lifetime. The story-pipeline
 * commits one row per story, so each row's trailer carries that story's
 * cumulative set up to that point. The plan-level accumulation can be
 * derived by `git log --grep="Skills-Used:"` analytics.
 *
 * @param {string} workingDir
 */
export function resetLoadedSkills(workingDir) {
  if (!workingDir) return;
  const path = join(workingDir, LOADED_SKILLS_REL);
  if (!existsSync(path)) return;
  try {
    writeFileSync(path, '[]', 'utf-8');
  } catch {
    // Non-fatal.
  }
}
