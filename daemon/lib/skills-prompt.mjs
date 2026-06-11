/**
 * Step-0.9 (2026-06-05) — dynamic skills line for --append-system-prompt.
 *
 * Ground truth from the skills forensic (DDB futurator-agent-events): every
 * recorded session loads the project's skills (skillCount 66, hasSkillTool
 * true) yet `skill_activated` is ZERO table-wide — no pipeline agent has
 * ever invoked the Skill tool. Root cause is behavioral: vendored SKILL.md
 * descriptions are human-utterance-shaped ("Use when the user says ...")
 * which never match the daemon's prescriptive machine-generated step
 * prompts, so the model's description-relevance matching never fires.
 *
 * Fix: surface the loadout to the model explicitly. At spawn time the
 * daemon appends ONE dynamic section listing each project skill's
 * name + description, with an instruction to invoke the relevant skill
 * before implementing related work. Fully per-project (driven by whatever
 * the manifest vendored into `.claude/skills/`), domain-agnostic, zero
 * hardcoded skill names.
 *
 * Cached per skills-dir mtime so the ~60 SKILL.md reads happen once per
 * loadout change, not once per step.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const MAX_SKILLS = 80;
const MAX_DESC_CHARS = 140;
const MAX_SECTION_CHARS = 8000;

/** @type {Map<string, { mtimeMs: number, line: string | null }>} */
const cache = new Map();

/**
 * Parse `name:` + `description:` out of a SKILL.md frontmatter block.
 * Tolerant: missing frontmatter falls back to the directory name.
 */
function parseSkillMd(raw, fallbackName) {
  let name = fallbackName;
  let desc = '';
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const nm = fm[1].match(/^name:\s*(.+)$/m);
    const dm = fm[1].match(/^description:\s*(.+)$/m);
    if (nm) name = nm[1].trim().replace(/^['"]|['"]$/g, '');
    if (dm)
      desc = dm[1]
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .slice(0, MAX_DESC_CHARS);
  }
  return desc ? `${name}: ${desc}` : name;
}

/**
 * Read the manifest-pinned skill names from `.claude/skills.manifest.yaml`.
 * The manifest is the project's curated loadout (prepin defaults +
 * SKILL-SCOUT confirmations) — those skills get priority in the prompt
 * section over the long tail of vendored federation skills. Tolerant
 * line-parse (`skill: <name>` entries under core/stack/domain/vendor);
 * returns an empty Set on any failure.
 *
 * @param {string} workingDir
 * @returns {Set<string>}
 */
function readManifestPins(workingDir) {
  /** @type {Map<string, string | null>} skill name → scout rationale (when persisted) */
  const pins = new Map();
  try {
    const raw = readFileSync(join(workingDir, '.claude', 'skills.manifest.yaml'), 'utf8');
    // Entry-block parse: each `- source:` opens an entry; capture its
    // `skill:` and optional `rationale:` lines. Step-0.9c — the installer
    // persists the SKILL-SCOUT rationale (project-specific, task-shaped),
    // which beats the upstream SKILL.md's generic utterance-shaped
    // description for prompt-relevance matching.
    const blocks = raw.split(/^\s*-\s+source:/m).slice(1);
    for (const block of blocks) {
      const skill = block.match(/^\s*skill:\s*(\S+)\s*$/m)?.[1];
      if (!skill) continue;
      // The YAML writer line-wraps long rationales as indented continuation
      // lines (dragon1 forensic 2026-06-10: single-line parse cut "…with
      // seeded randomness" right before the half that actually matched the
      // story prompts — "directly apply to pixel-art dragon animations…").
      // Capture the first line plus every following MORE-indented line.
      let rationale = null;
      const rm = block.match(/^([ \t]*)rationale:[ \t]*(.*)$/m);
      if (rm && rm.index !== undefined) {
        const parts = [rm[2].trim()];
        const keyIndent = rm[1].length;
        const rest = block.slice(rm.index + rm[0].length).split('\n').slice(1);
        for (const ln of rest) {
          const cm = ln.match(/^([ \t]+)(\S.*)$/);
          if (!cm || cm[1].length <= keyIndent) break;
          if (/^[ \t]*[\w-]+:/.test(ln)) break; // next mapping key, not a continuation
          parts.push(cm[2].trim());
        }
        rationale = parts.join(' ').replace(/^['"]|['"]$/g, '').trim() || null;
      }
      pins.set(skill, rationale ? rationale.slice(0, 300) : null);
    }
  } catch {
    // no manifest — every vendored skill ranks equally
  }
  return pins;
}

/**
 * Build the skills section for --append-system-prompt, or null when the
 * working dir has no readable `.claude/skills/` loadout. Never throws.
 *
 * Manifest-pinned skills are listed FIRST and never truncated (horse-runner1
 * probe 2026-06-05: readdir order put 40+ bmad-* skills ahead of the pinned
 * `frontend-design`, which the 8KB cap then cut — the most relevant skill
 * was absent from the prompt). Overflow drops whole tail entries with an
 * explicit "+N more" note, never a mid-line cut.
 *
 * @param {string} workingDir — the agent's cwd (per-story worktree or trunk)
 * @returns {string | null}
 */
export function buildSkillsPromptLine(workingDir) {
  if (!workingDir) return null;
  try {
    const skillsDir = join(workingDir, '.claude', 'skills');
    const dirStat = statSync(skillsDir);
    if (!dirStat.isDirectory()) return null;

    let manifestMtimeMs = 0;
    try {
      manifestMtimeMs = statSync(join(workingDir, '.claude', 'skills.manifest.yaml')).mtimeMs;
    } catch {
      // no manifest
    }
    const cacheKey = skillsDir;
    const cacheStamp = dirStat.mtimeMs + manifestMtimeMs;
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === cacheStamp) return cached.line;

    const pins = readManifestPins(workingDir);
    const entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => {
        const ap = pins.has(a.name) ? 0 : 1;
        const bp = pins.has(b.name) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .slice(0, MAX_SKILLS);

    const items = [];
    for (const e of entries) {
      try {
        const raw = readFileSync(join(skillsDir, e.name, 'SKILL.md'), 'utf8').slice(0, 2000);
        // Prefer the manifest's scout rationale (project-specific,
        // task-shaped) over the upstream SKILL.md generic description.
        const rationale = pins.get(e.name);
        const text = rationale ? `${e.name}: ${rationale}` : parseSkillMd(raw, e.name);
        items.push({ name: e.name, pinned: pins.has(e.name), text });
      } catch {
        // skill dir without a readable SKILL.md — skip silently
      }
    }

    let line = null;
    if (items.length > 0) {
      const header =
        '# Project skills\n\n' +
        'This project vendors the following skills, available via the Skill tool. ' +
        'Before implementing work a skill covers (UI/design systems, canvas/visual ' +
        'work, testing, framework conventions, domain workflows), invoke the ' +
        'relevant skill FIRST — these encode project-pinned conventions your ' +
        'output must follow.\n';
      const pinnedHeader = '\nPinned for this project (most relevant):\n';
      const otherHeader = '\nAlso vendored:\n';
      const pinnedItems = items.filter((i) => i.pinned);
      const otherItems = items.filter((i) => !i.pinned);

      let out = header;
      if (pinnedItems.length > 0)
        out += pinnedHeader + pinnedItems.map((i) => `- ${i.text}`).join('\n') + '\n';
      if (otherItems.length > 0) {
        out += otherHeader;
        let included = 0;
        for (const i of otherItems) {
          const entry = `- ${i.text}\n`;
          if (out.length + entry.length > MAX_SECTION_CHARS - 60) break;
          out += entry;
          included += 1;
        }
        const dropped = otherItems.length - included;
        if (dropped > 0) out += `(+${dropped} more vendored skills not listed)\n`;
      }
      line = out.trimEnd();
    }

    cache.set(cacheKey, { mtimeMs: cacheStamp, line });
    return line;
  } catch {
    return null;
  }
}
