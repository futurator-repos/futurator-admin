/**
 * Wave-knowledge output parser — Epic E.3 (pipeline-v1 dev correction).
 *
 * The wave-compile agent emits ALL knowledge articles for a wave in one
 * structured block. The daemon parses it deterministically, validates each
 * sub-block, and writes each file atomically (one `fs.writeFile` per file).
 * One writer → no parallel-write race on shared knowledge files.
 *
 * Block grammar:
 *
 *   ---WAVE_KNOWLEDGE_OUTPUT---
 *   ---FILE: knowledge/code/main.js.md---
 *   <full markdown content for main.js article>
 *   ---END_FILE---
 *
 *   ---FILE: knowledge/code/dino.js.md---
 *   <full markdown content for dino.js article>
 *   ---END_FILE---
 *
 *   ---FILE: knowledge/index.md---
 *   <full updated index>
 *   ---END_FILE---
 *   ---END_WAVE_KNOWLEDGE_OUTPUT---
 *
 * Tolerated deviations:
 *   - Outer envelope (`---WAVE_KNOWLEDGE_OUTPUT---` / `---END_WAVE_KNOWLEDGE_OUTPUT---`)
 *     may be omitted. Sub-blocks alone are enough.
 *   - Whitespace around the `FILE:` marker.
 *   - Free-form prose between sub-blocks (ignored).
 *
 * Rejected:
 *   - File paths that escape the project's `knowledge/` directory
 *     (absolute paths, paths starting with `..`, or paths not prefixed with
 *     `knowledge/`).
 *   - Empty content (zero-length article body).
 *   - Sub-block with no closing `---END_FILE---` marker.
 */

const OUTER_START = '---WAVE_KNOWLEDGE_OUTPUT---';
const OUTER_END = '---END_WAVE_KNOWLEDGE_OUTPUT---';
const FILE_START_RE = /^---FILE:\s*([^\s][^\n]*?)\s*---\s*$/m;
const FILE_END = '---END_FILE---';

/** Maximum knowledge-file size we'll accept from the compiler (defense). */
const MAX_FILE_BYTES = 200_000;

/**
 * Parse the full agent output into [{filePath, content}, ...] sub-blocks.
 * Returns separate `entries` and `errors` arrays so the caller can write
 * the valid entries while still surfacing parse problems for debugging.
 *
 * @param {string} blockText - the captured WAVE_KNOWLEDGE_OUTPUT (with or
 *                             without the outer envelope)
 * @returns {{
 *   entries: Array<{ filePath: string, content: string, bytes: number }>,
 *   errors: Array<{ raw?: string, filePath?: string, error: string }>,
 * }}
 */
export function parseWaveKnowledgeOutput(blockText) {
  if (typeof blockText !== 'string' || blockText.length === 0) {
    return { entries: [], errors: [{ error: 'empty input' }] };
  }
  const inner = unwrapOuter(blockText);

  const entries = [];
  const errors = [];

  // Walk through the body looking for `---FILE: <path>---` markers.
  let cursor = 0;
  while (cursor < inner.length) {
    const remaining = inner.slice(cursor);
    const startMatch = remaining.match(FILE_START_RE);
    if (!startMatch || startMatch.index === undefined) break;

    // Move cursor to the START_RE's position
    const startIdxAbs = cursor + startMatch.index;
    const filePathRaw = startMatch[1];
    const startLineEnd = inner.indexOf('\n', startIdxAbs + startMatch[0].length - 1);
    if (startLineEnd === -1) {
      errors.push({
        raw: filePathRaw,
        error: 'FILE marker has no line terminator',
      });
      break;
    }

    const contentStart = startLineEnd + 1;
    const endIdx = inner.indexOf(FILE_END, contentStart);
    // If a NEXT `---FILE:` marker appears before `---END_FILE---`, the
    // current sub-block was emitted without a closing marker. Skip it with
    // an error and resume parsing from that next marker so we don't lose
    // the recoverable sub-blocks that follow.
    const nextFileMatch = inner.slice(contentStart).match(FILE_START_RE);
    const nextFileIdxAbs =
      nextFileMatch && nextFileMatch.index !== undefined
        ? contentStart + nextFileMatch.index
        : -1;
    if (endIdx === -1 || (nextFileIdxAbs !== -1 && nextFileIdxAbs < endIdx)) {
      errors.push({
        filePath: filePathRaw,
        error: `no closing ${FILE_END} marker`,
      });
      if (nextFileIdxAbs !== -1) {
        cursor = nextFileIdxAbs;
        continue;
      }
      break;
    }
    const content = inner.slice(contentStart, endIdx).replace(/\n+$/, '');
    cursor = endIdx + FILE_END.length;

    const validation = validateFilePath(filePathRaw);
    if (!validation.ok) {
      errors.push({ filePath: filePathRaw, error: validation.error });
      continue;
    }
    if (content.length === 0) {
      errors.push({ filePath: validation.normalized, error: 'empty content' });
      continue;
    }
    if (content.length > MAX_FILE_BYTES) {
      errors.push({
        filePath: validation.normalized,
        error: `content exceeds MAX_FILE_BYTES (${content.length} > ${MAX_FILE_BYTES})`,
      });
      continue;
    }

    entries.push({
      filePath: validation.normalized,
      content,
      bytes: content.length,
    });
  }

  if (entries.length === 0 && errors.length === 0) {
    errors.push({ error: 'no FILE sub-blocks found' });
  }

  return { entries, errors };
}

/**
 * Build the wave-compile agent's prompt body. The caller wires this into
 * the wave-compile pipeline's agent step. Same structural pattern as
 * Epic B's per-story DEV/REVIEWER/COMPILER prompts: `<project_context>` at
 * a fixed prefix position so the prompt cache hits across all per-story
 * agents AND the wave-close compiler for the same plan.
 *
 * @param {{
 *   epicId?: string,
 *   epicTitle?: string,
 *   wave: number,
 *   stories: Array<{
 *     storyId: string,
 *     title?: string,
 *     description?: string,
 *     workSummary?: string,
 *     touchPoints?: string[],
 *   }>,
 *   waveStartSha?: string,
 *   waveEndSha?: string,
 * }} input
 * @returns {string}
 */
export function buildWaveCompilePrompt(input) {
  const {
    epicId = '(unknown)',
    epicTitle = '(unknown)',
    wave = 0,
    stories = [],
    waveStartSha = '(wave-start sha unknown)',
    waveEndSha = 'HEAD',
  } = input || {};

  const out = [];

  out.push('<project_context>');
  out.push('{{PROJECT_CONTEXT}}');
  out.push('</project_context>');
  out.push('');

  out.push(`You are the Wave Knowledge Compiler for the "${epicTitle}" project (epic ${epicId}, wave ${wave}).`);
  out.push('');
  out.push('You compile the knowledge articles for an ENTIRE WAVE of stories in one batched pass.');
  out.push('There is exactly one writer (you) — no per-story compile-knowledge step competes for the index.');
  out.push('Your context above is byte-identical to what the per-story DEV/REVIEWER agents saw, so the prompt cache hits.');
  out.push('');

  out.push('<wave_input>');
  out.push(`Wave: ${wave}`);
  out.push(`Wave diff range: \`git diff ${waveStartSha} ${waveEndSha}\``);
  out.push('');
  out.push(`## Stories in this wave (${stories.length})`);
  for (const s of stories) {
    out.push('');
    out.push(`### ${s.storyId} — ${s.title || '(untitled)'}`);
    if (Array.isArray(s.touchPoints) && s.touchPoints.length > 0) {
      out.push(`Touch points: ${s.touchPoints.join(', ')}`);
    }
    if (s.description) {
      out.push('');
      out.push('Description:');
      out.push(s.description.trim());
    }
    if (s.workSummary) {
      out.push('');
      out.push('WORK_SUMMARY (verbatim from DEV):');
      out.push(unwrapWorkSummary(s.workSummary).trim());
    }
  }
  out.push('');
  out.push('## Combined wave diff');
  out.push('```');
  out.push('{{WAVE_DIFF}}');
  out.push('```');
  out.push('</wave_input>');
  out.push('');

  out.push('## DISCOVERY');
  out.push("- Do NOT re-Read the source files the dev edited — their post-state is summarised in <wave_input> above.");
  out.push('- Do NOT Read every existing knowledge/code/*.md article — the index is in <project_context>.knowledgeIndex.');
  out.push('  Read an article only when you need to UPDATE it.');
  out.push('- Do NOT Glob, find, or Bash ls.');
  out.push('');

  out.push('## Compilation rules');
  out.push('');
  out.push('Produce ALL knowledge articles for this wave in ONE structured output block.');
  out.push('For each changed source file across the wave:');
  out.push('- If a `knowledge/code/<slug>.md` article exists → UPDATE it (revise Purpose, Dependencies, Dependents, Signals, Missing Signals; bump frontmatter `updated`, `lastMutatedByStory` to the most-recent story that touched the file).');
  out.push('- If no article exists → CREATE one following the standard format (frontmatter: `createdByStory`, `createdByEpic`, type, phase, status, maturity, tags).');
  out.push('- For deleted files → set article frontmatter `status: superseded`.');
  out.push('');
  out.push('Update `knowledge/system/dependency-map.md` with the wave\'s import-graph deltas.');
  out.push('Update `knowledge/index.md` — Story B.5 format `- <path> — <one-line-purpose>` per article. Migrate any pre-B.5 entries that lack the `—` separator.');
  out.push('Append a single compilation row per story to `knowledge/log.md`.');
  out.push('');

  out.push('─────────────────────────────────────────────────────────────────');
  out.push('OUTPUT CONTRACT — REQUIRED (Story E.3):');
  out.push('');
  out.push('Emit each article you write inside this envelope:');
  out.push('');
  out.push('  ---WAVE_KNOWLEDGE_OUTPUT---');
  out.push('  ---FILE: knowledge/code/<slug>.md---');
  out.push('  <full markdown body of the article>');
  out.push('  ---END_FILE---');
  out.push('');
  out.push('  ---FILE: knowledge/index.md---');
  out.push('  <full updated index>');
  out.push('  ---END_FILE---');
  out.push('  ---END_WAVE_KNOWLEDGE_OUTPUT---');
  out.push('');
  out.push('Rules:');
  out.push('- Every file path MUST start with `knowledge/`. Absolute paths or `..` segments are rejected.');
  out.push('- Empty bodies are rejected — emit at least the frontmatter block.');
  out.push('- The daemon writes each file atomically with one `fs.writeFile` call. Do NOT also use the Write tool for these paths.');
  out.push('─────────────────────────────────────────────────────────────────');

  return out.join('\n');
}

// ─── helpers ──────────────────────────────────────────────────────────────

function unwrapOuter(text) {
  let inner = text;
  const startIdx = inner.indexOf(OUTER_START);
  if (startIdx !== -1) inner = inner.slice(startIdx + OUTER_START.length);
  const endIdx = inner.indexOf(OUTER_END);
  if (endIdx !== -1) inner = inner.slice(0, endIdx);
  return inner;
}

function unwrapWorkSummary(text) {
  let inner = String(text);
  const s = inner.indexOf('---WORK_SUMMARY---');
  if (s !== -1) inner = inner.slice(s + '---WORK_SUMMARY---'.length);
  const e = inner.indexOf('---END_WORK_SUMMARY---');
  if (e !== -1) inner = inner.slice(0, e);
  return inner;
}

function validateFilePath(rawPath) {
  if (typeof rawPath !== 'string') {
    return { ok: false, error: 'file path must be a string' };
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return { ok: false, error: 'empty file path' };
  if (trimmed.startsWith('/')) return { ok: false, error: 'absolute paths are not allowed' };
  // Normalize backslashes; collapse leading `./`.
  const norm = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  // Reject any `..` segment to keep writes inside the project.
  if (norm.split('/').some((seg) => seg === '..')) {
    return { ok: false, error: '`..` segments are not allowed' };
  }
  if (!norm.startsWith('knowledge/')) {
    return {
      ok: false,
      error: `path must start with "knowledge/" (got "${norm}")`,
    };
  }
  return { ok: true, normalized: norm };
}
