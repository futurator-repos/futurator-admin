/**
 * REVIEW_CRITERIA parser — Epic C.1 / C.2 (pipeline-v1 dev correction).
 *
 * The reviewer agent emits a structured `---REVIEW_CRITERIA--- … ---END_REVIEW_CRITERIA---`
 * block — one line per acceptance criterion with a verdict (`pass`/`fail`/
 * `needs-human`) and a reason for non-`pass` verdicts. The daemon parses
 * this block deterministically and aggregates the per-AC verdicts into one
 * step verdict, eliminating the inconsistent free-form `VERDICT: PASS/FAIL`
 * prose-wall pattern that drove ~80% of historical retry waste.
 *
 * Block grammar (one line per AC):
 *
 *     ---REVIEW_CRITERIA---
 *     AC-1: pass
 *     AC-2: pass
 *     AC-3: fail — <one-line reason, ≤120 chars>
 *     AC-4: needs-human — <one-line question>
 *     ---END_REVIEW_CRITERIA---
 *
 * Verdict aggregation (deterministic AND/OR):
 *   • all `pass`           → step PASS
 *   • any `fail`           → step FAIL (retry prompt sees ONLY failed-AC reasons)
 *   • any `needs-human`    → throw EscalationSignal (REVIEWER_NEEDS_HUMAN);
 *                            takes precedence over `fail` so the operator
 *                            decides before the dev burns another retry.
 *   • malformed block      → step FAIL with `prompt-format` attention item;
 *                            reviewer is asked to re-emit on the next loop.
 */

const BLOCK_START = '---REVIEW_CRITERIA---';
const BLOCK_END = '---END_REVIEW_CRITERIA---';

/** Verdicts the reviewer is allowed to emit per AC. */
export const REVIEW_VERDICTS = Object.freeze(['pass', 'fail', 'needs-human']);

/**
 * Extractor entry the daemon merges into the review step's `extractors` map.
 * Captures the whole block (including markers) into `variables.REVIEW_CRITERIA`
 * so the parser below can re-validate envelope presence without depending on
 * regex capture-group boundaries.
 */
export const REVIEW_CRITERIA_EXTRACTOR = Object.freeze({
  type: 'between',
  startDelimiter: BLOCK_START,
  endDelimiter: BLOCK_END,
});

/**
 * Prompt block embedded in the reviewer template. Required output contract.
 * Kept verbatim-friendly: every line in the example is a real grammar form
 * the parser accepts.
 */
export const REVIEW_CRITERIA_PROMPT_BLOCK = [
  '─────────────────────────────────────────────────────────────────',
  'OUTPUT CONTRACT — REQUIRED (Story C.1):',
  '',
  'Emit one line per acceptance criterion inside this envelope:',
  '',
  '  ---REVIEW_CRITERIA---',
  '  AC-1: pass',
  '  AC-2: fail — <one-line reason, ≤120 chars>',
  '  AC-3: needs-human — <one-line question to the operator>',
  '  ---END_REVIEW_CRITERIA---',
  '',
  'Verdict values: pass | fail | needs-human. Use `needs-human` for',
  'subjective acceptance criteria you cannot deterministically check',
  '(visual aesthetic, "is this enough?", domain judgement). The daemon',
  'aggregates: any fail → retry; any needs-human → operator handoff.',
  '',
  'Do NOT also emit "VERDICT: PASS/FAIL" prose — the daemon derives the',
  'overall verdict from the structured block above. Free-form prose',
  'after the envelope is fine for context but is ignored by the parser.',
  '─────────────────────────────────────────────────────────────────',
].join('\n');

/**
 * Parse the captured REVIEW_CRITERIA block. Tolerates the input being passed
 * with or without the envelope markers. Returns one entry per recognized
 * line preserving the order the reviewer emitted them.
 *
 * Each entry is `{ acId, verdict, reason }` for valid lines, or
 * `{ raw, error }` for unparseable lines.
 *
 * @param {string} block - raw captured block text
 * @returns {Array<{ acId?: string, verdict?: string, reason?: string, raw?: string, error?: string }>}
 */
export function parseReviewCriteria(block) {
  if (!block || typeof block !== 'string') return [];
  const inner = unwrapEnvelope(block);
  if (!inner) return [];

  const out = [];
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // tolerate comment lines

    // Form: "<acId>: <verdict>" or "<acId>: <verdict> — <reason>"
    // The em-dash is the separator; tolerate ASCII " - " too as a courtesy
    // (Haiku occasionally substitutes it).
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      out.push({ raw: line, error: 'no `:` separator between acId and verdict' });
      continue;
    }
    const acId = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (!acId) {
      out.push({ raw: line, error: 'empty acId before `:`' });
      continue;
    }

    // Find the verdict — first whitespace OR separator boundary after the colon.
    const sepMatch = rest.match(/\s*(?:—|\s-\s)\s*/);
    let verdictToken;
    let reason = '';
    if (sepMatch) {
      verdictToken = rest.slice(0, sepMatch.index).trim();
      reason = rest.slice(sepMatch.index + sepMatch[0].length).trim();
    } else {
      verdictToken = rest;
    }

    const verdict = normalizeVerdict(verdictToken);
    if (!verdict) {
      out.push({
        raw: line,
        acId,
        error: `unknown verdict "${verdictToken}" (expected pass | fail | needs-human)`,
      });
      continue;
    }

    if ((verdict === 'fail' || verdict === 'needs-human') && !reason) {
      out.push({
        raw: line,
        acId,
        verdict,
        error: `${verdict} verdict requires a reason after \`—\``,
      });
      continue;
    }

    out.push({ acId, verdict, reason });
  }
  return out;
}

/**
 * Aggregate parsed entries into a single step verdict + structured carry-over
 * for the daemon's downstream logic. Pure function.
 *
 * @param {ReturnType<typeof parseReviewCriteria>} entries
 * @returns {{
 *   verdict: 'pass' | 'fail' | 'needs-human' | 'malformed',
 *   reasons: { failed: Array<{ acId: string, reason: string }>, humans: Array<{ acId: string, question: string }> },
 *   parseErrors: Array<{ raw: string, acId?: string, error: string }>,
 *   counts: { pass: number, fail: number, needsHuman: number, malformed: number },
 * }}
 */
export function aggregateReviewVerdict(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      verdict: 'malformed',
      reasons: { failed: [], humans: [] },
      parseErrors: [{ raw: '', error: 'no AC entries parsed' }],
      counts: { pass: 0, fail: 0, needsHuman: 0, malformed: 0 },
    };
  }

  const failed = [];
  const humans = [];
  const parseErrors = [];
  const counts = { pass: 0, fail: 0, needsHuman: 0, malformed: 0 };

  for (const e of entries) {
    if (e.error) {
      parseErrors.push({ raw: e.raw || '', acId: e.acId, error: e.error });
      counts.malformed += 1;
      continue;
    }
    if (e.verdict === 'pass') counts.pass += 1;
    else if (e.verdict === 'fail') {
      counts.fail += 1;
      failed.push({ acId: e.acId, reason: e.reason });
    } else if (e.verdict === 'needs-human') {
      counts.needsHuman += 1;
      humans.push({ acId: e.acId, question: e.reason });
    }
  }

  // Decision precedence: malformed > needs-human > fail > pass.
  // Malformed beats everything because we don't know what the reviewer meant
  // for the offending line; safer to ask them to re-emit than to guess.
  let verdict;
  if (counts.malformed > 0 && counts.pass + counts.fail + counts.needsHuman === 0) {
    verdict = 'malformed';
  } else if (counts.malformed > 0) {
    // Some good lines, some malformed — treat as malformed to force re-emit.
    verdict = 'malformed';
  } else if (counts.needsHuman > 0) {
    verdict = 'needs-human';
  } else if (counts.fail > 0) {
    verdict = 'fail';
  } else {
    verdict = 'pass';
  }

  return { verdict, reasons: { failed, humans }, parseErrors, counts };
}

/**
 * Format the failed-AC reasons as a compact retry-prompt body. Used by the
 * daemon to populate `{{FEEDBACK}}` so the dev only sees what's broken,
 * never the full PASS/FAIL prose wall.
 *
 * @param {{ failed: Array<{ acId: string, reason: string }> }} reasons
 * @returns {string}
 */
export function formatFailedReasonsForRetry(reasons) {
  if (!reasons?.failed || reasons.failed.length === 0) {
    return '(no failed criteria captured)';
  }
  return reasons.failed
    .map((f) => `- ${f.acId}: ${f.reason}`)
    .join('\n');
}

/**
 * Format the needs-human questions for the operator's attention-item body.
 *
 * @param {{ humans: Array<{ acId: string, question: string }> }} reasons
 * @returns {string}
 */
export function formatHumanQuestionsForAttention(reasons) {
  if (!reasons?.humans || reasons.humans.length === 0) return '';
  return reasons.humans
    .map((h) => `- ${h.acId}: ${h.question}`)
    .join('\n');
}

// ── helpers ───────────────────────────────────────────────────────────────

function unwrapEnvelope(block) {
  let inner = String(block);
  const startIdx = inner.indexOf(BLOCK_START);
  if (startIdx !== -1) inner = inner.slice(startIdx + BLOCK_START.length);
  const endIdx = inner.indexOf(BLOCK_END);
  if (endIdx !== -1) inner = inner.slice(0, endIdx);
  return inner.trim();
}

function normalizeVerdict(token) {
  if (!token) return null;
  const lower = token.toLowerCase().replace(/[*_`]/g, '').trim();
  if (lower === 'pass') return 'pass';
  if (lower === 'fail') return 'fail';
  if (lower === 'needs-human' || lower === 'needs_human' || lower === 'needshuman') {
    return 'needs-human';
  }
  return null;
}
