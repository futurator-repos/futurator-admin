/**
 * Visual-tests file writer (Pipeline v1 dev-correction — Story A.2).
 *
 * The DEV agent emits a `---VISUAL_TESTS--- … ---END_VISUAL_TESTS---` block in
 * its WORK_SUMMARY containing one or more YAML-ish entries (one per browser-
 * testable acceptance criterion). The reviewer expects this block to exist on
 * disk at `<projectDir>/visual-tests.md` so it can verify the criteria.
 *
 * Before A.2 the reviewer would FAIL stories with "missing visual-tests file"
 * even when DEV had emitted a perfectly valid block — because nothing wrote it
 * to disk. This module fixes that: the daemon's extractor pipeline calls
 * `mergeVisualTestsBlock` after extracting `VISUAL_TESTS`, BEFORE the reviewer
 * step runs. Append semantics: each `criteriaRef` (e.g., `AC-1`) is unique.
 * New blocks for the same `criteriaRef` REPLACE existing entries; new
 * `criteriaRef`s APPEND. The on-disk file always carries a single envelope
 * `---VISUAL_TESTS--- … ---END_VISUAL_TESTS---` with all current entries.
 *
 * This is intentionally lightweight — we don't try to parse YAML strictly.
 * We just split on a `- id:` boundary and dedupe entries by their
 * `criteriaRef:` field.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENVELOPE_START = '---VISUAL_TESTS---';
const ENVELOPE_END = '---END_VISUAL_TESTS---';
const VISUAL_TESTS_FILE = 'visual-tests.md';

/**
 * Strip the envelope markers from a block and return the inner content.
 * Tolerates the block being passed in either with or without the markers.
 */
function unwrapEnvelope(block) {
  if (!block) return '';
  let inner = String(block);
  const startIdx = inner.indexOf(ENVELOPE_START);
  if (startIdx !== -1) {
    inner = inner.slice(startIdx + ENVELOPE_START.length);
  }
  const endIdx = inner.indexOf(ENVELOPE_END);
  if (endIdx !== -1) {
    inner = inner.slice(0, endIdx);
  }
  return inner.trim();
}

/**
 * Parse an entry's criteriaRef. Returns null if the entry has no
 * recognizable `criteriaRef:` line — caller should treat that as malformed.
 */
function entryCriteriaRef(entryText) {
  const m = entryText.match(/^\s*criteriaRef\s*:\s*(.+?)\s*$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * Split a block of YAML-ish entries on the `- id:` boundary. Returns an
 * array of strings (one per entry, with the leading `- id:` preserved on
 * each).
 */
function splitEntries(inner) {
  if (!inner.trim()) return [];
  // Match the leading `- id:` of each entry (anchored to start of line).
  const matches = [...inner.matchAll(/^- id\s*:/gm)];
  if (matches.length === 0) {
    // Block exists but has no entries. Treat as empty list (not malformed).
    return [];
  }
  const entries = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : inner.length;
    entries.push(inner.slice(start, end).trimEnd());
  }
  return entries;
}

/**
 * Merge the new VISUAL_TESTS block into <projectDir>/visual-tests.md.
 *
 * @param {object} args
 * @param {string} args.projectDir - absolute project working directory
 * @param {string} args.block - the captured `---VISUAL_TESTS--- … ---END_VISUAL_TESTS---` block
 *                              (with or without envelope markers)
 * @returns {{
 *   ok: boolean,
 *   path: string,
 *   reason?: string,
 *   replacedRefs?: string[],
 *   appendedRefs?: string[],
 *   totalEntries?: number,
 * }}
 *   ok=false on parse failure (any entry missing criteriaRef). On parse
 *   failure the on-disk file is NOT modified. Caller should write a
 *   `compile-sync-failed` attention item.
 */
export function mergeVisualTestsBlock({ projectDir, block }) {
  if (!projectDir) {
    return { ok: false, path: '', reason: 'projectDir required' };
  }
  const path = join(projectDir, VISUAL_TESTS_FILE);

  const incoming = splitEntries(unwrapEnvelope(block));
  if (incoming.length === 0) {
    // No entries to merge — leave file alone, report success with 0 ops.
    return { ok: true, path, replacedRefs: [], appendedRefs: [], totalEntries: 0 };
  }

  // Validate every incoming entry has a criteriaRef before touching the file.
  for (let i = 0; i < incoming.length; i++) {
    const ref = entryCriteriaRef(incoming[i]);
    if (!ref) {
      return {
        ok: false,
        path,
        reason: `Entry ${i + 1} has no criteriaRef field`,
      };
    }
  }

  // Read existing entries, if any.
  let existing = [];
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8');
      existing = splitEntries(unwrapEnvelope(raw));
    } catch (err) {
      return {
        ok: false,
        path,
        reason: `Failed to read existing file: ${err.message}`,
      };
    }
  }

  // Index existing by criteriaRef. Existing entries without a ref are kept
  // in-place (they're hand-edited or pre-A.2 legacy content).
  const existingByRef = new Map();
  const orderedRefs = [];
  const orphans = [];
  for (const entry of existing) {
    const ref = entryCriteriaRef(entry);
    if (ref) {
      if (!existingByRef.has(ref)) orderedRefs.push(ref);
      existingByRef.set(ref, entry);
    } else {
      orphans.push(entry);
    }
  }

  const replacedRefs = [];
  const appendedRefs = [];
  for (const entry of incoming) {
    const ref = entryCriteriaRef(entry);
    if (existingByRef.has(ref)) {
      existingByRef.set(ref, entry);
      replacedRefs.push(ref);
    } else {
      orderedRefs.push(ref);
      existingByRef.set(ref, entry);
      appendedRefs.push(ref);
    }
  }

  const merged = [
    ...orphans,
    ...orderedRefs.map((ref) => existingByRef.get(ref)),
  ].join('\n\n');

  const fileBody = `${ENVELOPE_START}\n${merged}\n${ENVELOPE_END}\n`;

  try {
    writeFileSync(path, fileBody, 'utf8');
  } catch (err) {
    return { ok: false, path, reason: `Failed to write file: ${err.message}` };
  }

  return {
    ok: true,
    path,
    replacedRefs,
    appendedRefs,
    totalEntries: orderedRefs.length,
  };
}
