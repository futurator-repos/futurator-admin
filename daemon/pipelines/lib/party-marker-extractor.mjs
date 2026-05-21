/**
 * party-marker-extractor.mjs — Story 20.1 (party-push Epic 20).
 *
 * Pure-function extractor for the two operator-facing party-mode markers
 * the orchestrator emits in assistant text:
 *
 *   [CHECKPOINT_SUMMARY]: <title>
 *   <body line 1>
 *   <body line 2>
 *
 *   [ASK_HUMAN]: <question>
 *
 * Contract:
 *   - Markers MUST be at column 0 (no leading whitespace). The orchestrator
 *     system-prompt (Story 20.8) tells BMad Master to emit them flush-left;
 *     anything indented is documentation/prose and ignored.
 *   - Markers inside fenced code blocks (``` … ```) are IGNORED. The agent's
 *     prose often shows example markers in a code fence; those are
 *     documentation, not instructions to the daemon.
 *   - Markers missing the trailing colon are IGNORED ([CHECKPOINT_SUMMARY] foo
 *     without `:` could be a chat-mention; we require the colon to disambiguate).
 *   - On duplicate same-kind markers in one assistant block, LAST WINS (per
 *     plan.md §3.4 — the orchestrator may revise the summary mid-stream, the
 *     final emission is canonical).
 *   - For CHECKPOINT_SUMMARY: title is everything after the colon on the same
 *     line; body is the following non-empty, non-marker lines, stopping at the
 *     first blank line OR another marker OR end of text.
 *   - For ASK_HUMAN: title is the rest of the line (the question); body is
 *     undefined (questions are single-line by orchestrator contract).
 *   - displayText is the assistant text with marker lines (and CHECKPOINT_SUMMARY
 *     body lines) stripped, so the UI's rendered prose doesn't show them. Code
 *     fences are preserved intact.
 *
 * The extractor is pure: no DDB, no fs, no side effects. Event emission lives
 * in `party-turn.mjs` (Story 20.7).
 */

import { sanitize } from './agent-commit-composer.mjs';

/** Marker kinds recognized by the extractor. */
const MARKER_KINDS = ['CHECKPOINT_SUMMARY', 'ASK_HUMAN'];

/** Strict prefix regex: column 0, then `[KIND]:` exactly. */
const MARKER_LINE_REGEX = /^\[(CHECKPOINT_SUMMARY|ASK_HUMAN)\]:(.*)$/;

/** Code-fence detection (``` or ~~~ at the start of a line). */
const FENCE_REGEX = /^(```|~~~)/;

/**
 * @typedef {object} Marker
 * @property {'CHECKPOINT_SUMMARY' | 'ASK_HUMAN'} kind
 * @property {string} [title]
 * @property {string} [body]
 * @property {[number, number]} lineRange — 0-indexed [startLine, endLineInclusive]
 *
 * @typedef {object} ExtractResult
 * @property {string} displayText
 * @property {Marker[]} markers
 */

/**
 * Extract party-mode markers from assistant text.
 *
 * @param {string} assistantText
 * @returns {ExtractResult}
 */
export function extractMarkers(assistantText) {
  if (typeof assistantText !== 'string' || assistantText.length === 0) {
    return { displayText: '', markers: [] };
  }

  const lines = assistantText.split('\n');
  const allMarkers = [];
  // Index of lines that should be stripped from displayText. Stored as a Set
  // so we can union marker-line + body-line indices cheaply.
  const stripLineIndices = new Set();
  let insideFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE_REGEX.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const m = MARKER_LINE_REGEX.exec(line);
    if (!m) continue;

    const kind = m[1];
    const titleRaw = m[2];
    // `titleRaw` always starts with the post-colon text. The regex
    // captures it raw — sanitize + trim handles leading space, control
    // chars, and zero-width Unicode (§12.1.3).
    const title = sanitize(titleRaw).trim();

    if (kind === 'ASK_HUMAN') {
      allMarkers.push({
        kind,
        title,
        lineRange: [i, i],
      });
      stripLineIndices.add(i);
      continue;
    }

    // CHECKPOINT_SUMMARY — scan forward for body until blank line, another
    // marker, fence boundary, or EOF.
    let bodyEnd = i;
    const bodyLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (FENCE_REGEX.test(next)) break; // body terminates at a fence; the fence itself is NOT consumed
      if (next.trim() === '') break;
      if (MARKER_LINE_REGEX.test(next)) break;
      bodyLines.push(next);
      bodyEnd = j;
    }
    const body = sanitize(bodyLines.join('\n')).replace(/\s+$/g, '') || undefined;
    allMarkers.push({
      kind,
      title,
      body,
      lineRange: [i, bodyEnd],
    });
    for (let k = i; k <= bodyEnd; k++) stripLineIndices.add(k);
  }

  // Last-wins dedup per kind. allMarkers preserves source order; we walk
  // backwards, keep the first occurrence of each kind we encounter (which
  // is the LAST occurrence in the source), and reverse.
  const kept = [];
  const seenKinds = new Set();
  for (let i = allMarkers.length - 1; i >= 0; i--) {
    const mk = allMarkers[i];
    if (seenKinds.has(mk.kind)) continue;
    seenKinds.add(mk.kind);
    kept.push(mk);
  }
  kept.reverse();
  // Restore canonical kind order (CHECKPOINT_SUMMARY before ASK_HUMAN) so
  // callers don't have to sort. Same kind can't appear twice after dedup.
  kept.sort((a, b) => MARKER_KINDS.indexOf(a.kind) - MARKER_KINDS.indexOf(b.kind));

  // Build displayText by joining the lines NOT in stripLineIndices. We don't
  // collapse the resulting blank gaps — preserving the assistant's intended
  // line breaks keeps the UI's rendered prose visually intact.
  const displayLines = lines.filter((_, idx) => !stripLineIndices.has(idx));
  const displayText = displayLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');

  return { displayText, markers: kept };
}
