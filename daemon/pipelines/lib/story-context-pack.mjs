/**
 * Story Context Pack assembler — Epic B.1 (pipeline-v1 dev correction).
 *
 * Assembles a single canonical context block per story that is fed
 * byte-identically to DEV / REVIEWER / COMPILER prompts. Two payoffs:
 *
 *   1. Prompt-cache stability — Anthropic's prefix cache hits across the
 *      three roles for the same story, so REVIEWER/COMPILER's first turn
 *      is mostly cache reads instead of fresh inference.
 *   2. No re-discovery — every agent has the project tree, plan, story
 *      spec, adjacent file heads, recent diffs, and prior wave summaries
 *      already inlined; tools stop spamming `ls` / `find` / `Read`.
 *
 * Determinism contract: same inputs → byte-identical serialized output.
 * No timestamps, no random IDs, no per-process state. Sort everything.
 *
 * Size contract: serialized output is capped at `tokenBudget` (default
 * 30k tokens ≈ 120kB). When the pack would exceed the budget, file
 * digests are progressively trimmed (head50 → head20 → drop) and a
 * `context-truncated` warning is emitted via the optional `onWarning`
 * callback so the daemon can push it as an event.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { execSync } from 'node:child_process';

/** Pack format version. Bump when the serializer's output shape changes. */
export const STORY_CONTEXT_PACK_VERSION = 1;

/**
 * Default `<run_command>` when neither plan.runCommand nor opts.runCommand
 * is provided. Same default A.6 wired into story-pipeline.ts so the two
 * paths agree.
 */
export const DEFAULT_RUN_COMMAND = 'python3 -m http.server 8080';

const DEFAULT_TOKEN_BUDGET = 30_000;
const APPROX_BYTES_PER_TOKEN = 4;
const TREE_DEPTH = 2;
const TREE_EXCLUDE = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.mycelium',
  '.futurator',
  'knowledge',
]);
const TREE_EXCLUDE_FILE_EXT = new Set(['.lock', '.log', '.pid']);
// PR-15 — head-50 was too small. Most files in a starter pack grow past
// 50 lines after wave 0 (e.g. types.ts, reducer.ts), so DEV/REVIEWER
// re-Read every file from disk because the prompt only showed the first
// 50 lines. dino-runner-1 forensic counted 16 reads of types.ts alone.
// 300 lines covers ~95 % of game/utility files in a prototype run; the
// existing token-budget guard still drops the largest digests if we
// exceed `tokenBudget * APPROX_BYTES_PER_TOKEN`.
const HEAD_LINES_FULL = 300;
const HEAD_LINES_TRUNCATED = 100;
const PLAN_MD_REL = 'plan.md';
const KNOWLEDGE_INDEX_REL = 'knowledge/index.md';
const RECENT_DIFFS_LIMIT = 20;
const PREV_SUMMARIES_LIMIT = 5;
const PREV_SUMMARY_MAX_CHARS = 4000;

/**
 * Public entry point. I/O-light: only reads files under `projectDir` plus
 * one `git log` invocation. Caller (daemon) is responsible for passing the
 * pre-resolved `plan`, `story`, `prevStoriesInWave`, and `waveStartTime`
 * — those come from DynamoDB and aren't this module's concern.
 *
 * @param {{
 *   plan: {
 *     name?: string,
 *     displayName?: string,
 *     intent?: string,
 *     runCommand?: string,
 *     rigor?: string,
 *   },
 *   story: {
 *     storyId: string,
 *     title?: string,
 *     description?: string,
 *     criteria?: Array<{ id?: string, text: string, needsBrowser?: boolean }>,
 *     touchPoints?: string[],
 *     hasBrowserTests?: boolean,
 *     wave?: number,
 *   },
 *   prevStoriesInWave?: Array<{
 *     storyId: string,
 *     title?: string,
 *     workSummary?: string,
 *   }>,
 *   projectDir: string,
 *   waveStartTime?: string | Date,
 *   tokenBudget?: number,
 *   runCommandFallback?: string,
 *   onWarning?: (event: { type: string, detail?: string, key?: string }) => void,
 * }} input
 * @returns {Promise<{
 *   version: number,
 *   planMd: string,
 *   storySpec: object,
 *   projectTree: string,
 *   fileDigests: Record<string, { sha: string, head: string, lines: number, truncated?: boolean }>,
 *   recentDiffs: string,
 *   prevWorkSummaries: Array<{ storyId: string, title: string, summary: string }>,
 *   knowledgeIndex: string,
 *   runCommand: string,
 *   meta: { truncated: string[], waveStartTime: string | null, projectDir: string },
 * }>}
 */
export async function buildStoryContextPack(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('buildStoryContextPack: input is required');
  }
  const {
    plan = {},
    story,
    prevStoriesInWave = [],
    projectDir,
    waveStartTime,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
    runCommandFallback,
    onWarning,
  } = input;
  if (!story || !story.storyId) {
    throw new Error('buildStoryContextPack: story.storyId is required');
  }
  if (!projectDir || typeof projectDir !== 'string') {
    throw new Error('buildStoryContextPack: projectDir is required');
  }

  const truncated = [];
  const warn = (type, detail, key) => {
    truncated.push(key ?? type);
    if (typeof onWarning === 'function') {
      onWarning({ type, detail, key });
    }
  };

  const runCommand =
    plan.runCommand || runCommandFallback || DEFAULT_RUN_COMMAND;

  const planMd = readFileIfExists(join(projectDir, PLAN_MD_REL)) || '';
  const knowledgeIndex =
    readFileIfExists(join(projectDir, KNOWLEDGE_INDEX_REL)) || '';

  const projectTree = buildProjectTree(projectDir, TREE_DEPTH);

  const recentDiffs = collectRecentDiffs(projectDir, waveStartTime);

  const prevWorkSummaries = (prevStoriesInWave || [])
    .filter((s) => s && s.storyId && typeof s.workSummary === 'string')
    .slice(0, PREV_SUMMARIES_LIMIT)
    .map((s) => ({
      storyId: s.storyId,
      title: s.title || '',
      summary: s.workSummary.length > PREV_SUMMARY_MAX_CHARS
        ? `${s.workSummary.slice(0, PREV_SUMMARY_MAX_CHARS)}\n[…truncated]`
        : s.workSummary,
    }));
  if (prevStoriesInWave && prevStoriesInWave.length > PREV_SUMMARIES_LIMIT) {
    warn(
      'prev-summaries-truncated',
      `${prevStoriesInWave.length - PREV_SUMMARIES_LIMIT} older summary entries omitted`,
    );
  }

  const storySpec = normalizeStorySpec(story);

  // File digests for declared touch points. Determinism depends on file
  // contents alone (sha + head N lines) — no timestamps, no mtime.
  const touchPointPaths = (storySpec.touchPoints || [])
    .filter((p) => typeof p === 'string' && p.length > 0);

  let headLineCount = HEAD_LINES_FULL;
  let fileDigests = collectFileDigests(projectDir, touchPointPaths, headLineCount);

  // Cache-stable size guard: serialize, measure, retry with shorter heads
  // if over budget. Cheap (one extra serialize on overrun).
  const draftPack = {
    version: STORY_CONTEXT_PACK_VERSION,
    planMd,
    storySpec,
    projectTree,
    fileDigests,
    recentDiffs,
    prevWorkSummaries,
    knowledgeIndex,
    runCommand,
    meta: {
      truncated: [],
      waveStartTime: normalizeIsoOrNull(waveStartTime),
      projectDir,
    },
  };

  const budgetBytes = tokenBudget * APPROX_BYTES_PER_TOKEN;
  let serialized = serializeStoryContextPack(draftPack);
  if (serialized.length > budgetBytes && headLineCount > HEAD_LINES_TRUNCATED) {
    headLineCount = HEAD_LINES_TRUNCATED;
    fileDigests = collectFileDigests(projectDir, touchPointPaths, headLineCount);
    draftPack.fileDigests = fileDigests;
    for (const k of Object.keys(fileDigests)) {
      fileDigests[k].truncated = true;
    }
    warn(
      'context-truncated',
      `file digests reduced to head${HEAD_LINES_TRUNCATED} to fit ${tokenBudget} tokens`,
    );
    serialized = serializeStoryContextPack(draftPack);
  }
  if (serialized.length > budgetBytes) {
    // Last resort: drop the largest digest entries until under budget.
    const sortedKeys = Object.keys(fileDigests).sort(
      (a, b) => fileDigests[b].head.length - fileDigests[a].head.length,
    );
    while (serialized.length > budgetBytes && sortedKeys.length > 0) {
      const dropKey = sortedKeys.shift();
      delete fileDigests[dropKey];
      warn('context-truncated', `dropped file digest ${dropKey}`, dropKey);
      serialized = serializeStoryContextPack(draftPack);
    }
  }

  draftPack.meta.truncated = truncated.slice();
  return draftPack;
}

/**
 * Stable markdown serialization. Fixed section order, sorted maps, no
 * timestamps in the output (the wave-start is included as a stable ISO
 * string passed in by the caller).
 *
 * @param {ReturnType<typeof buildStoryContextPack>} pack
 * @returns {string}
 */
export function serializeStoryContextPack(pack) {
  const out = [];
  const story = pack.storySpec || {};
  out.push(`<!-- story-context-pack v${pack.version || STORY_CONTEXT_PACK_VERSION} -->`);
  out.push(`# Project context — story ${story.id || '(unknown)'}`);
  out.push('');

  out.push('## Run command');
  out.push('```');
  out.push(pack.runCommand || DEFAULT_RUN_COMMAND);
  out.push('```');
  out.push('');

  out.push('## Story spec');
  out.push(`**${story.title || '(untitled)'}**`);
  if (story.description) {
    out.push('');
    out.push(story.description.trim());
  }
  if (Array.isArray(story.acceptanceCriteria) && story.acceptanceCriteria.length > 0) {
    out.push('');
    out.push('### Acceptance criteria');
    for (const ac of story.acceptanceCriteria) {
      const flag = ac.needsBrowser ? ' [needs_browser=true]' : '';
      out.push(`- ${ac.id || '?'}: ${ac.text}${flag}`);
    }
  }
  if (Array.isArray(story.touchPoints) && story.touchPoints.length > 0) {
    out.push('');
    out.push('### Touch points');
    for (const tp of [...story.touchPoints].sort()) {
      out.push(`- ${tp}`);
    }
  }
  out.push('');

  out.push('## Plan');
  out.push('```markdown');
  out.push(pack.planMd ? pack.planMd.trimEnd() : '(plan.md not found)');
  out.push('```');
  out.push('');

  out.push(`## Project tree (depth ${TREE_DEPTH})`);
  out.push('```');
  out.push(pack.projectTree || '(tree unavailable)');
  out.push('```');
  out.push('');

  out.push('## Adjacent files (touch points)');
  const digestKeys = Object.keys(pack.fileDigests || {}).sort();
  if (digestKeys.length === 0) {
    out.push('_(no touch-point files digested — story may be brand new)_');
  } else {
    for (const path of digestKeys) {
      const d = pack.fileDigests[path];
      const trunc = d.truncated ? ' (truncated)' : '';
      out.push(`### \`${path}\` — sha:${d.sha}${trunc}`);
      out.push('```');
      out.push(d.head.trimEnd());
      out.push('```');
    }
  }
  out.push('');

  out.push('## Knowledge index');
  out.push('```');
  out.push(pack.knowledgeIndex ? pack.knowledgeIndex.trimEnd() : '(knowledge/index.md not found)');
  out.push('```');
  out.push('');

  out.push('## Recent diffs (since wave start)');
  out.push('```');
  out.push(pack.recentDiffs || '(no recent commits)');
  out.push('```');
  out.push('');

  out.push('## Prior story work summaries (this wave)');
  if (!pack.prevWorkSummaries || pack.prevWorkSummaries.length === 0) {
    out.push('_(no prior stories DONE in this wave yet)_');
  } else {
    const sorted = [...pack.prevWorkSummaries].sort((a, b) =>
      String(a.storyId).localeCompare(String(b.storyId)),
    );
    for (const s of sorted) {
      out.push(`### ${s.storyId} — ${s.title || '(untitled)'}`);
      out.push(s.summary.trimEnd());
      out.push('');
    }
  }
  return out.join('\n');
}

/**
 * Story B.5 helper: parse a `knowledge/index.md` body into structured
 * entries. Each non-blank, non-heading line is split on the first ` — `;
 * the left side is the path, the right side is the 1-line purpose.
 *
 * Lines that don't match the format are returned as `{ raw }`. Headings
 * (lines starting with `#`) are skipped entirely.
 *
 * @param {string} indexMarkdown
 * @returns {Array<{ path?: string, purpose?: string, raw?: string }>}
 */
export function parseKnowledgeIndex(indexMarkdown) {
  if (!indexMarkdown || typeof indexMarkdown !== 'string') return [];
  const out = [];
  for (const rawLine of indexMarkdown.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const stripped = line.replace(/^[-*]\s*/, '');
    const splitIdx = stripped.indexOf(' — ');
    if (splitIdx === -1) {
      out.push({ raw: stripped });
      continue;
    }
    const path = stripped.slice(0, splitIdx).trim();
    const purpose = stripped.slice(splitIdx + 3).trim();
    out.push({ path, purpose });
  }
  return out;
}

// ─── Internals ───

function readFileIfExists(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function buildProjectTree(projectDir, maxDepth) {
  const lines = [];
  const root = projectDir.replace(/\/+$/, '');
  function walk(absDir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const ent of entries) {
      if (TREE_EXCLUDE.has(ent.name)) continue;
      if (ent.isFile() && TREE_EXCLUDE_FILE_EXT.has(extname(ent.name))) continue;
      const abs = join(absDir, ent.name);
      const rel = relative(root, abs);
      const indent = '  '.repeat(depth);
      lines.push(`${indent}${ent.name}${ent.isDirectory() ? '/' : ''}`);
      if (ent.isDirectory()) walk(abs, depth + 1);
    }
  }
  walk(root, 0);
  return lines.join('\n');
}

function collectFileDigests(projectDir, touchPoints, headLineCount) {
  const digests = {};
  const sortedPaths = [...touchPoints].sort();
  for (const rel of sortedPaths) {
    if (rel.startsWith('/')) continue;
    if (rel.includes('..')) continue;
    const abs = join(projectDir, rel);
    let raw;
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) continue;
      raw = readFileSync(abs, 'utf8');
    } catch {
      digests[rel] = {
        sha: 'missing',
        head: '(file not found on disk yet — story may create it)',
        lines: 0,
      };
      continue;
    }
    const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const allLines = raw.split('\n');
    const headLines = allLines.slice(0, headLineCount);
    digests[rel] = {
      sha,
      head: headLines.join('\n'),
      lines: allLines.length,
    };
  }
  return digests;
}

function collectRecentDiffs(projectDir, waveStartTime) {
  const since = normalizeIsoOrNull(waveStartTime);
  const args = since
    ? `log --since=${shellQuote(since)} --pretty=format:%h\\ %s --name-status -n ${RECENT_DIFFS_LIMIT}`
    : `log --pretty=format:%h\\ %s --name-status -n ${RECENT_DIFFS_LIMIT}`;
  try {
    const out = execSync(`git ${args}`, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim();
  } catch {
    return '';
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeIsoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  // Tolerate strings that are already ISO; otherwise try to parse.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeStorySpec(story) {
  const ac = Array.isArray(story.criteria)
    ? story.criteria.map((c, i) => ({
        id: c.id || `AC-${i + 1}`,
        text: String(c.text || '').trim(),
        needsBrowser: !!c.needsBrowser,
      }))
    : [];
  return {
    id: story.storyId,
    title: story.title || '',
    description: story.description || '',
    acceptanceCriteria: ac,
    touchPoints: Array.isArray(story.touchPoints) ? story.touchPoints.slice() : [],
    hasBrowserTests: !!story.hasBrowserTests,
    wave: typeof story.wave === 'number' ? story.wave : null,
  };
}
