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
import { cosineSimilarity } from '../scripts/lib/embedding-knn.mjs';
import { embedText } from '../scripts/lib/voyage-embed.mjs';

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
 * A manifest entry counts as a genuine PIN only when it carries a SKILL-SCOUT
 * rationale (a project-specific, task-shaped reason the skill was curated).
 *
 * WHY (dossier B3, 2026-07-13): `prepin-default-skills@v1` and
 * `reconcile-skills-manifest@v1` write EVERY vendored/on-disk skill into the
 * manifest with only `{source, skill, version}` — no rationale. The old rule
 * (`pins.has(name)`) treated all ~58 of those rationale-less entries as pins,
 * so `rankLoadoutItems` placed them all FIRST unranked (alphabetical) and the
 * PUSH path shipped the same alphabetically-first 3 skills into every agent of
 * every story of every app — the cosine relevance ranking never applied.
 *
 * Read-side rule (mandatory — existing app manifests must behave correctly
 * WITHOUT regeneration): rationale-less entries mean the skill is INSTALLED /
 * AVAILABLE, not pinned. Only a rationale-carrying entry is a curated pin, and
 * even a pin gets a bounded relevance BOOST (not absolute precedence) downstream.
 *
 * @param {string | null | undefined} rationale
 * @returns {boolean}
 */
function isPinRationale(rationale) {
  return typeof rationale === 'string' && rationale.trim().length > 0;
}

/**
 * Read the manifest skill entries from `.claude/skills.manifest.yaml`, mapping
 * each skill name to its persisted SKILL-SCOUT rationale (or `null` when the
 * entry is a bare installed/available record). The rationale drives BOTH the
 * prompt text (project-specific beats the generic SKILL.md description) AND the
 * pin classification (see {@link isPinRationale}). Tolerant block-parse over
 * core/stack/domain/vendor; returns an empty Map on any failure.
 *
 * @param {string} workingDir
 * @returns {Map<string, string | null>}
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
 * Collect the loadout items (one per readable vendored skill) for a working
 * dir, with pins ordered first then alphabetical. Returns null when the dir
 * has no readable `.claude/skills/` loadout. Never throws.
 *
 * Shared by the sync `buildSkillsPromptLine` and the async relevance-ranked
 * variant so both see identical item extraction (pins, rationale-over-desc,
 * MAX_SKILLS cap). The relevance re-rank (F27) reorders the returned
 * non-pinned items before rendering; pins are never reordered.
 *
 * @param {string} workingDir
 * @returns {{ skillsDir: string, items: Array<{name:string, pinned:boolean, text:string}> } | null}
 */
function collectLoadout(workingDir) {
  const skillsDir = join(workingDir, '.claude', 'skills');
  const dirStat = statSync(skillsDir);
  if (!dirStat.isDirectory()) return null;

  const manifest = readManifestPins(workingDir);
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => {
      // Curated (rationale-carrying) pins sort first for the no-signal flat
      // fallback; the ranked PUSH path re-scores everything regardless.
      const ap = isPinRationale(manifest.get(a.name)) ? 0 : 1;
      const bp = isPinRationale(manifest.get(b.name)) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, MAX_SKILLS);

  const items = [];
  for (const e of entries) {
    try {
      const full = readFileSync(join(skillsDir, e.name, 'SKILL.md'), 'utf8');
      const raw = full.slice(0, 2000);
      // Prefer the manifest's scout rationale (project-specific,
      // task-shaped) over the upstream SKILL.md generic description.
      const rationale = manifest.get(e.name);
      const pinned = isPinRationale(rationale);
      const text = pinned ? `${e.name}: ${rationale}` : parseSkillMd(raw, e.name);
      // F24 — retain the SKILL.md BODY (truncated to the section budget) so
      // the PUSH variant can inject the top-ranked skills' instructions
      // verbatim, not just their name+description line.
      const body = full.slice(0, MAX_SECTION_CHARS);
      // pinned === true ONLY for rationale-carrying (SKILL-SCOUT-curated)
      // entries — a bare installed/available manifest record is NOT a pin
      // (dossier B3: prepin-everything must not defeat the ranking).
      items.push({ name: e.name, pinned, text, body });
    } catch {
      // skill dir without a readable SKILL.md — skip silently
    }
  }
  return { skillsDir, items };
}

/**
 * Render the loadout items into the --append-system-prompt section, or null
 * when there are no items. Pins render first (never truncated); the tail is
 * dropped whole-entry with a "+N more" note once the section cap is hit.
 *
 * @param {Array<{name:string, pinned:boolean, text:string}>} items
 * @returns {string | null}
 */
function renderLoadout(items) {
  if (!(items.length > 0)) return null;
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
  return out.trimEnd();
}

/**
 * Load the embeddings sidecar (`index.embeddings.json`) for a skills loadout,
 * or null when absent/unreadable. The sidecar is generated EXTERNALLY by
 * `scripts/ingest-skills.mjs --embed` and may not be vendored in-tree, so its
 * absence is a normal no-op (callers fall back to readdir ordering).
 *
 * Layout mirrors the ingest writer: SKILL.md dirs live at `<outDir>/skills/`
 * and the sidecar at `<outDir>/index.embeddings.json`, so relative to the
 * daemon's `<workingDir>/.claude/skills` dir the sidecar sits one level up at
 * `<workingDir>/.claude/index.embeddings.json`.
 *
 * @param {string} skillsDir — `<workingDir>/.claude/skills`
 * @returns {{ vectors: Record<string, number[]> } | null}
 */
function loadEmbeddingsSidecar(skillsDir) {
  // W1.1 (D1) — gate the ACTIVATION, not just the writer. Publishing the sidecar
  // otherwise silently lights up cosine BODY-push on the LIVE DEV/TEST/API_AUTHOR
  // path (agent-daemon.mjs step executor) → different generated code. Until an
  // operator sets SKILLS_EMBED_RANK=on, ranking stays inert (flat name list),
  // byte-identical to today, even if index.embeddings.json exists on disk.
  if (process.env.SKILLS_EMBED_RANK !== 'on') return null;
  try {
    const sidecarPath = join(skillsDir, '..', 'index.embeddings.json');
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    if (parsed && parsed.vectors && typeof parsed.vectors === 'object') {
      return { vectors: parsed.vectors };
    }
  } catch {
    // no sidecar / unreadable / malformed — fall back to readdir order
  }
  return null;
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
// W3.1 — the single canonical push-role policy, shared by the generic step
// executor (agent-daemon) and the P3 story pipeline (story-skills-inject). A
// code-PRODUCING role gets skill BODIES pushed; every other role (reviewers,
// compilers, reflectors) gets the flat name list (PULL). Includes both the
// legacy agentIds and the P3 role names so both seams agree.
export const SKILLS_PUSH_ROLES = new Set([
  'DEV', 'TEST', 'API_AUTHOR', // legacy step-pipeline agentIds
  'story-dev', 'test-author', 'implementer', // pipeline-3 role names
]);

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

    const loadout = collectLoadout(workingDir);
    const line = loadout ? renderLoadout(loadout.items) : null;

    cache.set(cacheKey, { mtimeMs: cacheStamp, line });
    return line;
  } catch {
    return null;
  }
}

/**
 * F27 — relevance-ranked variant of {@link buildSkillsPromptLine}.
 *
 * When an embeddings sidecar (`index.embeddings.json`) is available AND a
 * story/plan text context is provided, re-rank the NON-pinned loadout by
 * cosine similarity of the (query-embedded) story text vs each skill's
 * vendored embedding. Pins still render first and are never reordered.
 *
 * Falls back GRACEFULLY to the plain readdir ordering whenever:
 *   - no story text is provided, or
 *   - the sidecar is absent/unreadable, or
 *   - embedding the story text fails (no VOYAGE_API_KEY, network error, etc).
 * In every fallback path it returns the same string the sync builder would —
 * never throws, never returns a partial section.
 *
 * Intentionally NOT cached on the sidecar path: ranking depends on the
 * per-story text, so caching by skills-dir mtime would leak one story's order
 * into the next. The sync builder keeps its mtime cache for the no-context
 * fast path. F24 (next wave) injects the top-3 skill BODIES on top of this
 * ranking — it can read `items` order from the returned section.
 *
 * @param {string} workingDir — the agent's cwd (per-story worktree or trunk)
 * @param {string} [storyText] — story/plan text driving relevance ranking
 * @returns {Promise<string | null>}
 */
export async function buildSkillsPromptLineRanked(workingDir, storyText) {
  if (!workingDir) return null;
  // No context to rank on → identical to the cached sync builder.
  if (!storyText || typeof storyText !== 'string' || !storyText.trim()) {
    return buildSkillsPromptLine(workingDir);
  }
  try {
    const loadout = collectLoadout(workingDir);
    if (!loadout) return null;

    const sidecar = loadEmbeddingsSidecar(loadout.skillsDir);
    if (!sidecar) return renderLoadout(loadout.items);

    let queryVec;
    try {
      queryVec = await embedText(storyText.slice(0, 8000), 'query');
    } catch {
      // embedding unavailable (no key / network) — graceful fallback
      return renderLoadout(loadout.items);
    }
    if (!Array.isArray(queryVec) || queryVec.length === 0) {
      return renderLoadout(loadout.items);
    }

    // Re-rank only the non-pinned tail; pins keep their priority + order.
    const pinned = loadout.items.filter((i) => i.pinned);
    const others = loadout.items.filter((i) => !i.pinned);
    const scored = others.map((it, idx) => {
      const vec = sidecar.vectors[it.name];
      const score =
        Array.isArray(vec) && vec.length === queryVec.length
          ? cosineSimilarity(queryVec, vec)
          : -Infinity; // skills without a vendored vector sink to the tail
      return { it, idx, score };
    });
    // Stable: ties / unscored keep original readdir (alphabetical) order.
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const rankedItems = [...pinned, ...scored.map((s) => s.it)];
    return renderLoadout(rankedItems);
  } catch {
    // Any unexpected failure → fall back to the plain sync ordering.
    return buildSkillsPromptLine(workingDir);
  }
}

const MAX_PUSHED_BODIES = 3;

// Curated-pin nudge: a SKILL-SCOUT-rationale'd pin gets this ADDED to its
// cosine score so the project's curated conventions win close ties — but it is
// a bounded boost, never absolute precedence (dossier B3: pins that bypass the
// ranking are exactly what shipped 3 alphabetical skills into every agent). A
// clearly-irrelevant pin (cosine near 0) + 0.10 still loses to a clearly-
// relevant non-pin (cosine near 1), and still fails the relevance floor below.
const PIN_BOOST = 0.1;

// Relevance floor: only a skill whose FINAL score (cosine + any pin boost)
// clears this gets its body PUSHED into the agent's prompt. Nothing clears it →
// push nothing (flat name list, zero bodies). Voyage-3 cosine for a skill that
// is genuinely on-topic for the story text runs ~0.4-0.7; unrelated skills sit
// ~0.1-0.3, so 0.30 is a conservative "actually relevant" gate. Operator-
// overridable via P3_SKILLS_MIN_SCORE (e.g. lower to push more eagerly).
const DEFAULT_MIN_SCORE = 0.3;

/**
 * The relevance floor a skill's final score must clear to have its BODY pushed.
 * Reads P3_SKILLS_MIN_SCORE when it parses to a finite number; otherwise the
 * documented default. Read per-call so an operator can retune without a daemon
 * restart between jobs.
 *
 * @returns {number}
 */
function skillsMinScore() {
  const raw = process.env.P3_SKILLS_MIN_SCORE;
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_MIN_SCORE;
}

/**
 * From an already-ranked loadout + its per-name scores, pick the skills whose
 * body should be pushed: those clearing the relevance floor AND carrying a
 * readable body, capped at {@link MAX_PUSHED_BODIES}. `ordered` is sorted by
 * final score descending, so filter-then-slice keeps the top-N by relevance.
 * Shared by {@link buildSkillsPushPrompt} and {@link selectPushedSkillNames} so
 * the recorded loaded-set is EXACTLY the pushed set.
 *
 * @param {Array<{name:string, body?:string}>} ordered
 * @param {Map<string, number>} scores
 * @returns {Array<{name:string, body?:string}>}
 */
function selectPushBodies(ordered, scores) {
  const floor = skillsMinScore();
  return ordered
    .filter((i) => (scores.get(i.name) ?? -Infinity) >= floor && i.body && i.body.trim())
    .slice(0, MAX_PUSHED_BODIES);
}

/**
 * Rank the ENTIRE loadout by relevance to `storyText` and return the ordered
 * list plus each item's final score. Every item — pinned or not — is scored by
 * cosine similarity of the story text vs the skill's vendored embedding; a
 * rationale-carrying pin gets a bounded {@link PIN_BOOST} added so curated
 * conventions win close ties, but NEVER absolute precedence (dossier B3: pins
 * that bypassed the ranking are what shipped the same alphabetical 3 skills
 * into every agent). A skill with no vendored vector scores -Infinity and sinks.
 *
 * `ranked` reports whether a real relevance signal was used: false when there
 * is no sidecar, no embed key, or the embed call failed — in which case the
 * PUSH caller must NOT inject bodies of arbitrarily-ordered skills (it falls
 * back to the flat name list). `scores` is only meaningful when `ranked`.
 * Never throws.
 *
 * @param {{ skillsDir: string, items: Array<{name:string, pinned:boolean, text:string, body?:string}> }} loadout
 * @param {string} storyText
 * @returns {Promise<{ items: Array<{name:string, pinned:boolean, text:string, body?:string}>, ranked: boolean, scores: Map<string, number> }>}
 */
async function rankLoadoutItems(loadout, storyText) {
  const empty = new Map();
  const sidecar = loadEmbeddingsSidecar(loadout.skillsDir);
  if (!sidecar) return { items: loadout.items, ranked: false, scores: empty };

  let queryVec;
  try {
    queryVec = await embedText(storyText.slice(0, 8000), 'query');
  } catch {
    return { items: loadout.items, ranked: false, scores: empty };
  }
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    return { items: loadout.items, ranked: false, scores: empty };
  }

  // Score ALL items (pins included) so relevance — not manifest presence —
  // drives the order. Pins get the bounded additive boost; unscorable skills
  // (no vector) sink to -Infinity with no boost (can't manufacture relevance).
  const scores = new Map();
  const scored = loadout.items.map((it, idx) => {
    const vec = sidecar.vectors[it.name];
    const base =
      Array.isArray(vec) && vec.length === queryVec.length
        ? cosineSimilarity(queryVec, vec)
        : -Infinity;
    const score = base === -Infinity ? -Infinity : base + (it.pinned ? PIN_BOOST : 0);
    scores.set(it.name, score);
    return { it, idx, score };
  });
  // Stable: ties / unscored keep original readdir (pin-then-alphabetical) order.
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return { items: scored.map((s) => s.it), ranked: true, scores };
}

/**
 * F24 — PUSH the top-ranked skills' BODIES into a code-producing agent's
 * system prompt for THIS story, instead of relying on the model to PULL them
 * via name+description matching (which fired on only 5.2% of sessions).
 *
 * Builds, in order:
 *   1. A "Skills to apply now" section containing the FULL SKILL.md body of
 *      the top-{@link MAX_PUSHED_BODIES} skills ranked by cosine similarity of
 *      `storyText` (F27's ranking), each truncated to MAX_SECTION_CHARS, with
 *      a strict per-call token budget so the combined bodies never blow the
 *      prompt. Only skills clearing the relevance floor (P3_SKILLS_MIN_SCORE)
 *      are pushed; a curated pin gets a bounded score boost but must still be
 *      relevant to appear (dossier B3).
 *   2. The existing flat name+description loadout for the REMAINING skills, so
 *      the long tail is still discoverable via the Skill tool (fallback PULL).
 *
 * Falls back GRACEFULLY to the plain ranked name list (`buildSkillsPromptLineRanked`
 * output) whenever there is no story text, no readable loadout, or no skill
 * bodies could be assembled. Never throws.
 *
 * @param {string} workingDir — the agent's cwd (per-story worktree or trunk)
 * @param {string} storyText — the substituted story/step prompt for this step
 * @returns {Promise<string | null>}
 */
export async function buildSkillsPushPrompt(workingDir, storyText) {
  if (!workingDir) return null;
  if (!storyText || typeof storyText !== 'string' || !storyText.trim()) {
    return buildSkillsPromptLine(workingDir);
  }
  try {
    const loadout = collectLoadout(workingDir);
    if (!loadout || loadout.items.length === 0) return null;

    const { items: ordered, ranked, scores } = await rankLoadoutItems(loadout, storyText);
    if (ordered.length === 0) return renderLoadout(loadout.items);

    // Bodies are PUSHED only when there is a real relevance signal (sidecar +
    // query embedding). Without it there is no score to compare to the floor,
    // so injecting arbitrary readdir-order bodies would just waste the budget
    // on possibly-irrelevant skills — fall back to the flat name+desc list.
    if (!ranked) return renderLoadout(ordered);

    // Relevance floor: inject only the top-N skills whose final score clears
    // P3_SKILLS_MIN_SCORE. Nothing clears it → push NOTHING (flat list, zero
    // bodies) — a huge catalog with no on-topic skill for this story must not
    // force-feed the agent irrelevant instructions.
    const top = selectPushBodies(ordered, scores);
    if (top.length === 0) return renderLoadout(ordered);

    const topNames = new Set(top.map((i) => i.name));
    const header =
      '# Skills to apply now\n\n' +
      'The following project skills are the most relevant to THIS task. Their ' +
      'full instructions are inlined below — treat them as binding conventions ' +
      'your output must follow, and do NOT re-open them via the Skill tool ' +
      '(their content is already here).\n';

    let out = header;
    let budget = MAX_SECTION_CHARS;
    let injected = 0;
    for (const it of top) {
      // Per-body cap: split the section budget across the pushed bodies so a
      // single large SKILL.md can't starve the others.
      const perBodyCap = Math.max(0, Math.floor(budget / (top.length - injected)));
      const body = it.body.slice(0, perBodyCap).trimEnd();
      if (!body) break;
      const block = `\n## ${it.name}\n\n${body}\n`;
      out += block;
      budget -= block.length;
      injected += 1;
      if (budget <= 0) break;
    }
    if (injected === 0) return renderLoadout(ordered);

    // Keep the flat name+description list for everything NOT pushed, so the
    // long tail stays discoverable (fallback PULL via the Skill tool).
    const rest = ordered.filter((i) => !topNames.has(i.name));
    const restSection = renderLoadout(rest);
    return restSection ? `${out.trimEnd()}\n\n${restSection}` : out.trimEnd();
  } catch {
    return buildSkillsPromptLine(workingDir);
  }
}

/**
 * Which skills would {@link buildSkillsPushPrompt} inject the BODY of for this
 * story — i.e. the skills the dev agent is actually made to apply.
 *
 * PUSH-injected skills never fire a `Skill` tool_use event (the body is already
 * in the system prompt, and the header explicitly tells the agent NOT to re-open
 * them), so `trackSkillActivations` (which scans stream-json for tool_use) can't
 * see them. This mirrors the exact selection in `buildSkillsPushPrompt` so the
 * P3 glue can record the pushed set as the story's loaded skills — otherwise
 * every story reports zero skills even though a curated set was applied.
 *
 * Returns `{ pushed, ranked }` — `pushed` is the ordered top-N body skill names
 * (those clearing the relevance floor), `ranked` whether a real cosine relevance
 * signal picked them. Never throws; returns `{ pushed: [], ranked: false }` on
 * any failure or when no body would be pushed (mirrors the name-list fallback).
 *
 * @param {string} workingDir
 * @param {string} storyText
 * @returns {Promise<{ pushed: string[], ranked: boolean }>}
 */
export async function selectPushedSkillNames(workingDir, storyText) {
  const empty = { pushed: [], ranked: false };
  if (!workingDir || !storyText || typeof storyText !== 'string' || !storyText.trim()) {
    return empty;
  }
  try {
    const loadout = collectLoadout(workingDir);
    if (!loadout || loadout.items.length === 0) return empty;
    const { items: ordered, ranked, scores } = await rankLoadoutItems(loadout, storyText);
    if (ordered.length === 0) return empty;
    // Mirror buildSkillsPushPrompt EXACTLY: no ranking signal → nothing pushed;
    // otherwise the same floor-gated top-N (so the recorded loaded-set equals
    // the bodies actually injected).
    if (!ranked) return empty; // name-list fallback: nothing pushed
    const top = selectPushBodies(ordered, scores);
    return { pushed: top.map((i) => i.name), ranked };
  } catch {
    return empty;
  }
}
