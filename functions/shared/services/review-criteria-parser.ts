/**
 * REVIEW_CRITERIA parser — Epic C.2 (TypeScript port for the API Lambda).
 *
 * Mirrors `daemon/pipelines/lib/review-criteria-parser.mjs` so the
 * `apply-output` endpoint can synthesize a verdict from the operator's
 * Talk-to-agent reply (Story C.5 AC5).
 *
 * The two implementations are intentionally kept in lock-step. If you
 * change the grammar here, mirror the change in the .mjs file (and vice
 * versa). The cross-implementation test in
 * `functions/shared/services/__tests__/review-criteria-parser.test.ts`
 * pins both to the same fixture set so drift is caught at CI time.
 */

const BLOCK_START = '---REVIEW_CRITERIA---';
const BLOCK_END = '---END_REVIEW_CRITERIA---';

export type ReviewVerdict = 'pass' | 'fail' | 'needs-human';

export interface ReviewCriterionEntry {
  acId?: string;
  verdict?: ReviewVerdict;
  reason?: string;
  raw?: string;
  error?: string;
}

export interface AggregatedReviewVerdict {
  verdict: ReviewVerdict | 'malformed';
  reasons: {
    failed: Array<{ acId: string; reason: string }>;
    humans: Array<{ acId: string; question: string }>;
  };
  parseErrors: Array<{ raw: string; acId?: string; error: string }>;
  counts: { pass: number; fail: number; needsHuman: number; malformed: number };
}

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = Object.freeze([
  'pass',
  'fail',
  'needs-human',
]);

export function parseReviewCriteria(block: string | null | undefined): ReviewCriterionEntry[] {
  if (!block || typeof block !== 'string') return [];
  const inner = unwrapEnvelope(block);
  if (!inner) return [];

  const out: ReviewCriterionEntry[] = [];
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

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

    const sepMatch = rest.match(/\s*(?:—|\s-\s)\s*/);
    let verdictToken: string;
    let reason = '';
    if (sepMatch && sepMatch.index !== undefined) {
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

export function aggregateReviewVerdict(
  entries: ReviewCriterionEntry[] | null | undefined,
): AggregatedReviewVerdict {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      verdict: 'malformed',
      reasons: { failed: [], humans: [] },
      parseErrors: [{ raw: '', error: 'no AC entries parsed' }],
      counts: { pass: 0, fail: 0, needsHuman: 0, malformed: 0 },
    };
  }

  const failed: Array<{ acId: string; reason: string }> = [];
  const humans: Array<{ acId: string; question: string }> = [];
  const parseErrors: Array<{ raw: string; acId?: string; error: string }> = [];
  const counts = { pass: 0, fail: 0, needsHuman: 0, malformed: 0 };

  for (const e of entries) {
    if (e.error) {
      parseErrors.push({ raw: e.raw || '', acId: e.acId, error: e.error });
      counts.malformed += 1;
      continue;
    }
    if (e.verdict === 'pass') counts.pass += 1;
    else if (e.verdict === 'fail' && e.acId) {
      counts.fail += 1;
      failed.push({ acId: e.acId, reason: e.reason || '' });
    } else if (e.verdict === 'needs-human' && e.acId) {
      counts.needsHuman += 1;
      humans.push({ acId: e.acId, question: e.reason || '' });
    }
  }

  let verdict: AggregatedReviewVerdict['verdict'];
  if (counts.malformed > 0 && counts.pass + counts.fail + counts.needsHuman === 0) {
    verdict = 'malformed';
  } else if (counts.malformed > 0) {
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

export function formatFailedReasonsForRetry(reasons: AggregatedReviewVerdict['reasons']): string {
  if (!reasons?.failed || reasons.failed.length === 0) {
    return '(no failed criteria captured)';
  }
  return reasons.failed.map((f) => `- ${f.acId}: ${f.reason}`).join('\n');
}

export function formatHumanQuestionsForAttention(
  reasons: AggregatedReviewVerdict['reasons'],
): string {
  if (!reasons?.humans || reasons.humans.length === 0) return '';
  return reasons.humans.map((h) => `- ${h.acId}: ${h.question}`).join('\n');
}

function unwrapEnvelope(block: string): string {
  let inner = block;
  const startIdx = inner.indexOf(BLOCK_START);
  if (startIdx !== -1) inner = inner.slice(startIdx + BLOCK_START.length);
  const endIdx = inner.indexOf(BLOCK_END);
  if (endIdx !== -1) inner = inner.slice(0, endIdx);
  return inner.trim();
}

function normalizeVerdict(token: string): ReviewVerdict | null {
  if (!token) return null;
  const lower = token.toLowerCase().replace(/[*_`]/g, '').trim();
  if (lower === 'pass') return 'pass';
  if (lower === 'fail') return 'fail';
  if (lower === 'needs-human' || lower === 'needs_human' || lower === 'needshuman') {
    return 'needs-human';
  }
  return null;
}
