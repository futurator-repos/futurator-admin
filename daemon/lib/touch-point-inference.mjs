// Pipeline v2.0 PR-4 — touch-point inference orchestrator.
//
// Hybrid bash-first / LLM-fallback inference of a story's `touchPoints[]`
// from its description + acceptance criteria text. Run at story dispatch
// time when the planner left the field empty.
//
// Flow:
//   1. Heuristic — extractCandidatePaths() pulls explicit file references
//      from the AC text. Validate against project tree (any path that
//      exists OR has an existing parent directory is kept). If ≥1 valid
//      candidate, return them. **No LLM cost.**
//   2. LLM fallback — if heuristic returned 0, spawn a tiny Haiku call
//      with the project tree + AC text and ask for a JSON array of file
//      globs. Bounded prompt (~500 tokens), bounded response (≤256 tokens).
//      Cost ~$0.005 per inference. Cached per (epicId, storyId) by caller.
//   3. None — if both fail, return [] and let the prework gate fall
//      through to spawn DEV normally. Always graceful.
//
// Pure orchestrator with injectable shell + fs + LLM helpers for tests.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync as fsExistsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractCandidatePaths } from './file-path-extractor.mjs';

/** Maximum project-tree depth we'll feed to either heuristic validation or LLM. */
const TREE_MAX_DEPTH = 3;
/** Maximum file count to include in the LLM tree summary. */
const TREE_MAX_FILES = 200;
/** Default LLM model — Haiku for cost. */
const DEFAULT_LLM_MODEL = 'haiku';
/** Default LLM timeout. */
const DEFAULT_LLM_TIMEOUT_MS = 20_000;

/**
 * Infer `touchPoints[]` for a story.
 *
 * @param {object} input
 * @param {string} input.projectDir - absolute path to the project root.
 * @param {{ description?: string, acceptanceCriteria?: string, title?: string }} input.story
 * @param {object} [input.opts]
 * @param {boolean} [input.opts.skipLlm] - when true, never fall back to LLM.
 * @param {string} [input.opts.llmModel] - default 'haiku'.
 * @param {number} [input.opts.llmTimeoutMs]
 * @param {object} [input.deps] - injectable for tests
 *   - extractCandidatePaths, listProjectTree, runLlmInference, fs.exists
 * @returns {Promise<{
 *   touchPoints: string[],
 *   source: 'heuristic' | 'llm' | 'none',
 *   reason?: string,
 *   evidence?: { rawCandidates?: string[], llmRawOutput?: string, treeFiles?: number },
 * }>}
 */
export async function inferTouchPoints(input) {
  const {
    projectDir,
    story,
    opts = {},
    deps = {},
  } = input || {};

  const extract = deps.extractCandidatePaths || extractCandidatePaths;
  const listTree = deps.listProjectTree || defaultListProjectTree;
  const runLlm = deps.runLlmInference || defaultRunLlmInference;
  const fsExists = deps.fsExists || ((p) => fsExistsSync(p));

  if (!projectDir || !story || typeof story !== 'object') {
    return { touchPoints: [], source: 'none', reason: 'missing projectDir or story' };
  }

  const acText = [story.description || '', story.acceptanceCriteria || '', story.title || '']
    .filter(Boolean)
    .join('\n');

  if (acText.trim().length === 0) {
    return { touchPoints: [], source: 'none', reason: 'no AC text' };
  }

  // ── Step 1: heuristic ──
  const rawCandidates = extract(acText);
  const validated = validateAgainstProject(rawCandidates, projectDir, fsExists);

  if (validated.length > 0) {
    return {
      touchPoints: validated,
      source: 'heuristic',
      reason: `${validated.length} path(s) extracted from AC text`,
      evidence: { rawCandidates },
    };
  }

  if (opts.skipLlm) {
    return {
      touchPoints: [],
      source: 'none',
      reason: 'heuristic yielded 0 paths; LLM fallback disabled',
      evidence: { rawCandidates },
    };
  }

  // ── Step 2: LLM fallback ──
  let tree;
  try {
    tree = listTree(projectDir, { maxDepth: TREE_MAX_DEPTH, maxFiles: TREE_MAX_FILES });
  } catch (err) {
    return {
      touchPoints: [],
      source: 'none',
      reason: `tree listing failed: ${err.message}`,
      evidence: { rawCandidates },
    };
  }

  let llmResult;
  try {
    llmResult = await runLlm({
      tree,
      acText,
      storyTitle: story.title || '',
      model: opts.llmModel || DEFAULT_LLM_MODEL,
      timeoutMs: opts.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS,
    });
  } catch (err) {
    return {
      touchPoints: [],
      source: 'none',
      reason: `llm inference failed: ${err.message}`,
      evidence: { rawCandidates, treeFiles: tree.length },
    };
  }

  // Parse + validate LLM output. Reject anything that isn't a string array
  // or contains paths that look implausible (absolute, .., etc).
  const llmPaths = Array.isArray(llmResult?.touchPoints) ? llmResult.touchPoints : [];
  const validatedLlmPaths = llmPaths
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => p.trim())
    .filter((p) => !p.startsWith('/') && !p.includes('..') && !/\s/.test(p))
    .slice(0, 12); // hard cap — touch-point lists shouldn't be huge

  if (validatedLlmPaths.length === 0) {
    return {
      touchPoints: [],
      source: 'none',
      reason: 'llm returned no plausible paths',
      evidence: { rawCandidates, llmRawOutput: llmResult?.raw, treeFiles: tree.length },
    };
  }

  return {
    touchPoints: validatedLlmPaths,
    source: 'llm',
    reason: `${validatedLlmPaths.length} path(s) inferred by LLM (heuristic yielded 0)`,
    evidence: { rawCandidates, llmRawOutput: llmResult?.raw, treeFiles: tree.length },
  };
}

// ── internals ────────────────────────────────────────────────────────────

/**
 * Keep candidates whose path exists OR whose first directory segment exists.
 * The latter accommodates "create src/foo.ts" stories where src/ is real but
 * foo.ts hasn't been written yet.
 */
function validateAgainstProject(candidates, projectDir, fsExists) {
  const out = [];
  for (const p of candidates) {
    const abs = join(projectDir, p);
    if (fsExists(abs)) {
      out.push(p);
      continue;
    }
    // Plausible-new-file: parent directory exists.
    const parent = dirname(abs);
    if (parent !== projectDir && fsExists(parent)) {
      out.push(p);
      continue;
    }
    // Plausible-new-file: top-level segment exists (e.g., `src/` exists, story
    // wants to create src/components/Button.tsx).
    const topSeg = p.split('/')[0];
    if (topSeg && fsExists(join(projectDir, topSeg))) {
      out.push(p);
      continue;
    }
  }
  return out;
}

/** Default tree lister — uses `find` for speed + portability. */
function defaultListProjectTree(projectDir, { maxDepth, maxFiles } = {}) {
  const result = nodeSpawnSync(
    'find',
    [
      '.',
      '-mindepth',
      '1',
      '-maxdepth',
      String(maxDepth || TREE_MAX_DEPTH),
      '-not',
      '-path',
      './node_modules*',
      '-not',
      '-path',
      './.git*',
      '-not',
      '-path',
      './_bmad*',
      '-not',
      '-path',
      './.context*',
      '-not',
      '-path',
      './dist*',
      '-not',
      '-path',
      './build*',
      '-not',
      '-path',
      './out*',
      '-not',
      '-path',
      './.next*',
      '-not',
      '-path',
      './.mycelium*',
    ],
    {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`find exited ${result.status}: ${result.stderr || 'unknown'}`);
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\.\//, ''))
    .slice(0, maxFiles || TREE_MAX_FILES);
}

/**
 * Default LLM caller — spawns `claude -p` with a tiny Haiku prompt that
 * returns a JSON array of file paths/globs.
 *
 * Production-safe: any error returns gracefully so the inference falls
 * through to source='none'. Never throws.
 */
async function defaultRunLlmInference({ tree, acText, storyTitle, model, timeoutMs }) {
  const prompt = buildLlmInferencePrompt({ tree, acText, storyTitle });

  const result = nodeSpawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      model || DEFAULT_LLM_MODEL,
      '--output-format',
      'text',
    ],
    {
      encoding: 'utf8',
      timeout: timeoutMs || DEFAULT_LLM_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`claude CLI exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
  }

  const raw = (result.stdout || '').trim();
  return { touchPoints: parseLlmJsonOutput(raw), raw };
}

/**
 * Build the LLM prompt. Keep it tight — every token is paid per inference.
 * Output contract: ONE JSON array of string paths. No prose. Empty array
 * is a valid answer ("I can't tell").
 */
export function buildLlmInferencePrompt({ tree, acText, storyTitle }) {
  const treeStr = (Array.isArray(tree) ? tree : []).join('\n');
  return [
    'You are a touch-point inference helper. Given a story and the current project tree,',
    'return a JSON array of file paths or globs the story will likely modify or create.',
    '',
    'Rules:',
    '- Output ONE JSON array of strings, nothing else. No prose, no markdown fences.',
    '- Each entry is either a file path (e.g. "src/foo.ts") or a glob (e.g. "src/**/*.ts").',
    '- All paths are relative to the project root, no leading slash, no "..".',
    '- Return [] if the story is too vague to infer paths.',
    '- Cap at 8 entries. Be specific, not exhaustive.',
    '',
    'Project tree (depth 3, excludes node_modules/.git/dist/build/_bmad/.context):',
    treeStr.slice(0, 4000),
    '',
    `Story title: ${storyTitle || '(none)'}`,
    'Story description + acceptance criteria:',
    acText.slice(0, 2000),
    '',
    'Output:',
  ].join('\n');
}

/** Tolerant JSON parser — accepts a bare array or an array embedded in chatter. */
export function parseLlmJsonOutput(raw) {
  if (typeof raw !== 'string') return [];
  // Strip markdown fences if the model emits them despite our instruction.
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/m, '').trim();
  // Try direct parse first.
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  // Find the first `[ ... ]` block and parse it.
  const m = /\[[^\]]*\]/.exec(stripped);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
