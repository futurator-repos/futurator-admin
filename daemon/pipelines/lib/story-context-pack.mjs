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

/**
 * Pack format version. Bump when the serializer's output shape changes.
 * v2 (Concept v2 E3.4): story spec now renders the user-story triple, BDD
 * Given/When/Then ACs with a `verify` tag, an AC-mapped Tasks checklist, and a
 * Technical notes block. The reserved probe/seam section (E8) slots in without a
 * further bump. The real invariant is intra-story cross-role identity.
 */
export const STORY_CONTEXT_PACK_VERSION = 2;

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
// Concept v2 (E7.7) — upstream artifacts live here, written by the artifact-gen
// jobs (E7.4/E12). Each `<source>.md` ships a `<source>.sections.json` sidecar
// (E4.1 locked manifest) that lets us inline the EXACT cited section.
const CONCEPT_DIR_REL = 'concept';
const CITED_DOC_SOURCES = ['prd', 'architecture', 'ux'];
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

  // PR-42 (Story 2-A-2-2) — auto-populate existingTests + publicExports
  // per v2.5 §11.1. The TEST prompt template renders existingTests as
  // "immutable contracts" so TEST never re-authors a test that already
  // covers a story's AC. publicExports gives DEV the canonical type/
  // constant names without re-Reading them from disk.
  const existingTests = collectExistingTests(projectDir);
  const publicExports = collectPublicExports(projectDir);

  // Cache-stable size guard: serialize, measure, retry with shorter heads
  // if over budget. Cheap (one extra serialize on overrun).
  // Concept v2 (E7.7) — inline the artifact sections this story cites. Part of
  // the non-trimmable floor (E4.3): the contract is never dropped to fit budget.
  const citedSections = resolveCitedSections(projectDir, storySpec.references);

  const draftPack = {
    version: STORY_CONTEXT_PACK_VERSION,
    planMd,
    storySpec,
    citedSections,
    projectTree,
    fileDigests,
    existingTests,
    publicExports,
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

  // Concept v2 (E4.3 / W3) — priority waterfall: the story spec + any inlined
  // cited artifact sections (references[], wired in E7.7) are a NON-TRIMMABLE
  // FLOOR; file digests are the trimmable remainder above. If, after dropping
  // every digest, the floor ALONE still exceeds the budget, we do NOT silently
  // ship an over-budget pack (which would truncate the contract the DEV agent
  // relies on) — we emit a distinct, blocking-grade `references-over-budget`
  // signal so the caller surfaces it instead of dropping the contract.
  if (serialized.length > budgetBytes) {
    const overByTokens = Math.ceil((serialized.length - budgetBytes) / APPROX_BYTES_PER_TOKEN);
    warn(
      'references-over-budget',
      `story-spec + cited-section floor exceeds ${tokenBudget} tokens by ~${overByTokens}; not silently truncating the contract`,
    );
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
  // Concept v2 (E3.3) — user-story triple as a one-liner header.
  if (
    story.userStory &&
    (story.userStory.role || story.userStory.action || story.userStory.benefit)
  ) {
    out.push('');
    out.push(
      `_As a ${story.userStory.role}, I want ${story.userStory.action}, so that ${story.userStory.benefit}._`,
    );
  }
  if (story.description) {
    out.push('');
    out.push(story.description.trim());
  }
  // Concept v2 (E3.3) — technical notes block.
  if (story.technicalNotes) {
    out.push('');
    out.push('### Technical notes');
    out.push(story.technicalNotes.trim());
  }
  if (Array.isArray(story.acceptanceCriteria) && story.acceptanceCriteria.length > 0) {
    out.push('');
    out.push('### Acceptance criteria');
    for (const ac of story.acceptanceCriteria) {
      const flag = ac.needsBrowser ? ' [needs_browser=true]' : '';
      // Concept v2 (E3.3) — verify tag; manual carries its reason.
      const verifyTag = ac.verify
        ? ` [verify=${ac.verify}${ac.verify === 'manual' && ac.manualReason ? `:${ac.manualReason}` : ''}]`
        : '';
      if (ac.given || ac.when || ac.then) {
        // BDD form — fall back to `text` only when no triple is present.
        out.push(`- ${ac.id || '?'}${verifyTag}${flag}`);
        if (ac.given) out.push(`  - Given ${ac.given}`);
        if (ac.when) out.push(`  - When ${ac.when}`);
        if (ac.then) out.push(`  - Then ${ac.then}`);
      } else {
        out.push(`- ${ac.id || '?'}: ${ac.text}${verifyTag}${flag}`);
      }
    }
  }
  // Concept v2 (E3.3) — AC-mapped task checklist.
  if (Array.isArray(story.tasks) && story.tasks.length > 0) {
    out.push('');
    out.push('### Tasks');
    for (const t of story.tasks) {
      const refs = Array.isArray(t.acRefs) && t.acRefs.length > 0 ? ` (${t.acRefs.join(', ')})` : '';
      out.push(`- [${t.done ? 'x' : ' '}] ${t.id}: ${t.text}${refs}`);
    }
  }
  // Concept v2 (E7.7) — inlined cited artifact sections (the consistency
  // contract the DEV agent is held to). Rendered verbatim from the artifact's
  // manifest slice; part of the non-trimmable floor.
  if (Array.isArray(pack.citedSections) && pack.citedSections.length > 0) {
    out.push('');
    out.push('### Cited contract sections');
    for (const c of pack.citedSections) {
      out.push(`#### ${c.source} › ${c.title}`);
      out.push('```markdown');
      out.push(String(c.text || '').trimEnd());
      out.push('```');
    }
  }
  // Concept v2 (E3.5) — RESERVED probe/seam slot. Epic E8 (VQA H9) inserts the
  // dedicated, sorted probe/seam section HERE, inside the serializer and before
  // the appended <ground_truth> block (context-pack-resolver), so the locked
  // section order holds without a further version bump.
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

  // PR-51 (2026-05-07) — split touch-point files into "existing" (on disk
  // with digestible content) and "to create" (declared in touchPoints but
  // not yet on disk). Previously both were rendered in the same section
  // and DEV agents sometimes mistook the `(file not found)` placeholder
  // for an actual file at that path → confused Read attempts +
  // hallucinated content.
  //
  // brick-breaker-3 forensic showed DEV in story 1 doing 17+ Reads
  // because the context-pack didn't make it visually clear which paths
  // were existing files vs paths to create. Split sections give DEV an
  // unambiguous signal.
  const digestKeys = Object.keys(pack.fileDigests || {}).sort();
  const existingKeys = digestKeys.filter((k) => pack.fileDigests[k].sha !== 'missing');
  const pendingKeys = digestKeys.filter((k) => pack.fileDigests[k].sha === 'missing');

  out.push('## Adjacent files (existing on disk)');
  if (existingKeys.length === 0) {
    out.push('_(no existing touch-point files — story may be brand new)_');
  } else {
    for (const path of existingKeys) {
      const d = pack.fileDigests[path];
      const trunc = d.truncated ? ' (truncated)' : '';
      out.push(`### \`${path}\` — sha:${d.sha}${trunc}`);
      out.push('```');
      out.push(d.head.trimEnd());
      out.push('```');
    }
  }
  out.push('');

  // PR-51 — explicit "to create" section. DEV agent reads this and knows
  // these paths are EXPECTED to be empty; it should CREATE them, not
  // attempt to Read them.
  if (pendingKeys.length > 0) {
    out.push('## Adjacent files (to create — these do NOT exist yet)');
    out.push(
      'These paths are declared in `storySpec.touchPoints` but are not on ' +
        'disk yet. DEV is expected to CREATE them. Do NOT use the Read tool ' +
        'on these paths — Read will fail and waste a turn.',
    );
    out.push('');
    for (const path of pendingKeys) {
      out.push(`- \`${path}\``);
    }
    out.push('');
  }

  // PR-42 (Story 2-A-2-2) — existingTests + publicExports per v2.5 §11.1.
  // The TEST prompt template treats `existingTests` entries as immutable
  // contracts; DEV uses `publicExports` to get the canonical names without
  // re-Reading the files from disk.
  out.push('## Existing tests (immutable contracts)');
  const tests = pack.existingTests || [];
  if (tests.length === 0) {
    out.push('_(no test files yet — TEST will author the first ones)_');
  } else {
    out.push(
      'These test files are the source of truth for function names, field names, and signatures.',
    );
    out.push('TEST must NOT re-author tests that already cover a story\'s AC. DEV must conform.');
    out.push('');
    for (const t of tests) {
      out.push(`- ${t}`);
    }
  }
  out.push('');

  out.push('## Public exports');
  const types = pack.publicExports?.types || [];
  const constants = pack.publicExports?.constants || [];
  if (types.length === 0 && constants.length === 0) {
    out.push('_(no public exports yet — types/constants directories empty or missing)_');
  } else {
    if (types.length > 0) {
      out.push('### Types');
      out.push('```ts');
      for (const line of types) {
        out.push(line);
      }
      out.push('```');
    }
    if (constants.length > 0) {
      out.push('### Constants');
      out.push('```ts');
      for (const line of constants) {
        out.push(line);
      }
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

/**
 * Concept v2 (E7.7) — resolve a story's `references[]` into inlined artifact
 * sections so the DEV agent reads the CONTRACT, not a path. For each doc-source
 * reference, read `concept/<source>.md` + `<source>.sections.json` and slice the
 * cited section by its manifest line range (the E4.1 resolve, reimplemented here
 * because this `.mjs` can't import the `.ts` at runtime — the format is locked).
 *
 * `harness` refs are skipped (resolved by VQA's probe compiler, E8). A cited
 * artifact missing from disk is skipped gracefully — the §8 gate (E9.3) is what
 * blocks a dangling reference; the pack degrades rather than throws.
 */
export function resolveCitedSections(projectDir, references) {
  const out = [];
  const cache = new Map(); // source -> { md, manifest } | null
  for (const ref of references || []) {
    if (!ref || ref.source === 'harness') continue;
    if (!CITED_DOC_SOURCES.includes(ref.source)) continue;
    if (!cache.has(ref.source)) {
      const md = readFileIfExists(join(projectDir, CONCEPT_DIR_REL, `${ref.source}.md`));
      const raw = readFileIfExists(join(projectDir, CONCEPT_DIR_REL, `${ref.source}.sections.json`));
      let manifest = null;
      if (raw) {
        try {
          manifest = JSON.parse(raw);
        } catch {
          manifest = null;
        }
      }
      cache.set(ref.source, md && manifest ? { md, manifest } : null);
    }
    const art = cache.get(ref.source);
    if (!art) continue;
    const entry = (art.manifest.sections || []).find((s) => s && s.id === ref.section);
    if (!entry) continue;
    const lines = art.md.split('\n');
    const text = lines.slice(entry.lineStart - 1, entry.lineEnd).join('\n');
    out.push({ source: ref.source, section: ref.section, title: entry.title || ref.section, text });
  }
  return out;
}

/**
 * Concept v2 (E3 / Story 3.2a) — assemble the inlined upstream artifact bodies
 * for a generator's `{{PRIOR_ARTIFACTS}}` placeholder. The Lambda CANNOT read
 * EC2 disk, so it enqueues ux-gen/arch-gen with the placeholder and the daemon
 * fills it here from the APPROVED on-disk docs (the same `.mjs/.ts` boundary as
 * `resolveCitedSections`).
 *
 * The chain is prd → ux → architecture. The upstreams for a generator are every
 * artifact earlier in the chain that exists on disk:
 *   - ux-gen  → prd
 *   - arch-gen → prd (+ ux when uiBearing, i.e. ux-spec.md exists)
 *
 * Returns inlined markdown (section bodies), never paths. Missing upstreams
 * degrade to a short skeleton instruction so the generator still produces a
 * valid doc (defensive — shouldn't happen post-gate).
 *
 * @param {string} projectDir
 * @param {'prd'|'ux'|'architecture'} currentKind
 * @returns {string}
 */
const CONCEPT_CHAIN_ORDER = ['prd', 'ux', 'architecture'];

export function loadPriorArtifacts(projectDir, currentKind) {
  const idx = CONCEPT_CHAIN_ORDER.indexOf(currentKind);
  const upstreamKinds = idx > 0 ? CONCEPT_CHAIN_ORDER.slice(0, idx) : [];
  const blocks = [];
  for (const kind of upstreamKinds) {
    const md = readFileIfExists(join(projectDir, CONCEPT_DIR_REL, `${kind}.md`));
    if (!md || !md.trim()) continue;
    const label = kind === 'prd' ? 'PRD' : kind === 'ux' ? 'UX Specification' : 'Architecture';
    blocks.push(`### ${label} (approved upstream — stay consistent; cite, do not contradict)\n\n${md.trim()}`);
  }
  if (blocks.length === 0) {
    return 'No approved upstream artifacts are available on disk; produce a valid document from the intent and stay within a reasonable MVP scope.';
  }
  return blocks.join('\n\n---\n\n');
}

/**
 * Concept v2 (E5.2) — read the closed-set citable section ids from the approved
 * concept manifests on disk and format them for the pm-plan `{{CITABLE_SECTIONS}}`
 * placeholder. The Lambda can't read EC2 disk, so it enqueues the placeholder and
 * the daemon fills the REAL, current-rev ids here (closing the E7.8 gap).
 *
 * Returns lines like `prd: fr-3, fr-4` for each present source (sorted source
 * keys, manifest-order ids). When no manifests exist (prototype/legacy) it
 * returns the defer-references instruction so the PM emits no citations.
 *
 * @param {string} projectDir
 * @returns {string}
 */
export function loadCitableSections(projectDir) {
  const lines = [];
  for (const source of CITED_DOC_SOURCES.slice().sort()) {
    const raw = readFileIfExists(join(projectDir, CONCEPT_DIR_REL, `${source}.sections.json`));
    if (!raw) continue;
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      continue;
    }
    const ids = (manifest.sections || []).map((s) => s && s.id).filter(Boolean);
    if (ids.length > 0) lines.push(`${source}: ${ids.join(', ')}`);
  }
  if (lines.length === 0) {
    return 'No upstream artifact manifests are available — do NOT emit references[] for this plan.';
  }
  return lines.join('\n      ');
}

/**
 * Concept v2 (Round 1.1) — inline ALL approved concept docs (PRD + UX +
 * Architecture, in chain order) for the pm-plan's `{{PRIOR_ARTIFACTS}}`
 * placeholder. Unlike loadPriorArtifacts (which returns the UPSTREAMS of a given
 * generator), the planner consumes the WHOLE approved spec set — it shards them
 * into epics/stories. Missing docs are skipped; empty set degrades to a short
 * instruction so the PM still produces a valid plan from the intent.
 *
 * @param {string} projectDir
 * @returns {string}
 */
export function loadAllConceptArtifacts(projectDir) {
  const blocks = [];
  for (const kind of CONCEPT_CHAIN_ORDER) {
    const md = readFileIfExists(join(projectDir, CONCEPT_DIR_REL, `${kind}.md`));
    if (!md || !md.trim()) continue;
    const label = kind === 'prd' ? 'PRD' : kind === 'ux' ? 'UX Specification' : 'Architecture';
    blocks.push(`### ${label} (approved — shard this into epics/stories; cite, do not contradict)\n\n${md.trim()}`);
  }
  if (blocks.length === 0) {
    return 'No approved concept documents are available on disk; plan from the intent within a reasonable MVP scope.';
  }
  return blocks.join('\n\n---\n\n');
}

/** Map a concept generator step id → the artifact kind it produces. */
export function conceptKindForStepId(stepId) {
  if (stepId === 'prd-gen') return 'prd';
  if (stepId === 'ux-gen') return 'ux';
  if (stepId === 'arch-gen') return 'architecture';
  return null;
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

/**
 * PR-42 — collect every test file the project ships, sorted. Used by the
 * TEST prompt to know which test files are "immutable contracts" (v2.5
 * §11.1). Falls back to a recursive readdir scan when not in a git tree.
 *
 * @param {string} projectDir
 * @returns {string[]} relative paths, sorted alphabetically, capped at 200
 */
function collectExistingTests(projectDir) {
  // Prefer git ls-files for speed + ignore-rule honoring.
  try {
    const out = execSync(
      'git ls-files "*.test.ts" "*.test.tsx" "*.test.js" "*.spec.ts" "*.spec.tsx" "*.spec.js"',
      {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      },
    );
    const files = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    return files.slice(0, 200);
  } catch {
    return [];
  }
}

/**
 * PR-42 — extract `^export` lines from `src/types/*.ts` and
 * `src/constants/*.ts`. Each entry is the full source line so DEV can
 * see the exported names + types without re-Reading the file. v2.5 §11.1.
 *
 * @param {string} projectDir
 * @returns {{ types: string[], constants: string[] }}
 */
function collectPublicExports(projectDir) {
  const out = { types: [], constants: [] };
  for (const [key, sub] of [
    ['types', 'src/types'],
    ['constants', 'src/constants'],
  ]) {
    try {
      const subDir = join(projectDir, sub);
      if (!existsSync(subDir)) continue;
      const entries = readdirSync(subDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.ts')) continue;
        const abs = join(subDir, e.name);
        try {
          const raw = readFileSync(abs, 'utf8');
          const exportLines = raw
            .split('\n')
            .filter((l) => /^export\s+(type|interface|const|function|class|enum)\b/.test(l))
            .map((l) => l.trim())
            // Strip trailing block-open `{` so output stays single-line.
            .map((l) => l.replace(/\s*\{\s*$/, ''))
            .slice(0, 50);
          out[key].push(...exportLines);
        } catch {
          // skip unreadable file
        }
      }
      out[key].sort();
    } catch {
      // skip on any error — pack still useful
    }
  }
  return out;
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
    ? story.criteria.map((c, i) => {
        const out = {
          id: c.id || `AC-${i + 1}`,
          text: String(c.text || '').trim(),
          needsBrowser: !!c.needsBrowser,
        };
        // Concept v2 (E3.2) — carry BDD + verify intent when present (fixed key
        // order; present-only so the serialization stays byte-stable).
        if (c.given != null) out.given = String(c.given);
        if (c.when != null) out.when = String(c.when);
        if (c.then != null) out.then = String(c.then);
        if (c.thenObservable != null) out.thenObservable = String(c.thenObservable);
        if (c.verify != null) out.verify = c.verify;
        if (c.manualReason != null) out.manualReason = c.manualReason;
        return out;
      })
    : [];
  const spec = {
    id: story.storyId,
    title: story.title || '',
    description: story.description || '',
    acceptanceCriteria: ac,
    touchPoints: Array.isArray(story.touchPoints) ? story.touchPoints.slice() : [],
    hasBrowserTests: !!story.hasBrowserTests,
    wave: typeof story.wave === 'number' ? story.wave : null,
  };
  // Concept v2 (E3.2) — BMAD-grade story fields, carried only when present so
  // legacy/prototype stories serialize byte-identically to before.
  if (story.userStory && typeof story.userStory === 'object') {
    spec.userStory = {
      role: String(story.userStory.role || ''),
      action: String(story.userStory.action || ''),
      benefit: String(story.userStory.benefit || ''),
    };
  }
  if (story.technicalNotes != null) spec.technicalNotes = String(story.technicalNotes);
  if (Array.isArray(story.tasks)) {
    spec.tasks = story.tasks.map((t, i) => {
      const task = {
        id: t.id || `T${i + 1}`,
        text: String(t.text || ''),
        acRefs: Array.isArray(t.acRefs) ? t.acRefs.slice() : [],
      };
      if (t.done != null) task.done = !!t.done;
      return task;
    });
  }
  if (Array.isArray(story.references)) {
    spec.references = story.references.map((r) => {
      const ref = { source: r.source, section: String(r.section || '') };
      if (r.note != null) ref.note = String(r.note);
      return ref;
    });
  }
  return spec;
}
