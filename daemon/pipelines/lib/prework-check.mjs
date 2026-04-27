/**
 * Pre-work check — Epic D.5 (pipeline-v1 dev correction).
 *
 * Two pure helpers that together give the daemon a "story already done?"
 * fast-path for stories whose declared `touchPoints` were already modified
 * by recent commits in the same plan:
 *
 *   1. `collectRecentTouchPointWork({ projectDir, sinceTime, touchPoints })`
 *      — scans `git log --since=<sinceTime>` for commits that touched any of
 *      the story's `touchPoints` and returns a structured summary the daemon
 *      can splice into the Story Context Pack as `<recent_work>`.
 *
 *   2. `detectNoChangesRequired(workSummary)` — parses a DEV-emitted
 *      `---WORK_SUMMARY---` block for the canonical "No changes required —
 *      AC already satisfied by <commit-shas>" sentinel and returns
 *      `{ noChangesRequired: boolean, citedShas: string[] }`. The daemon
 *      uses this to route the story to a `COMPLETED_VIA_PREWORK` outcome
 *      without burning a REVIEWER turn.
 *
 * Both helpers are I/O-light (a single `git log` invocation; no DDB, no
 * agent spawn) and deterministic — same git tree → same result.
 */

import { execSync } from 'node:child_process';

const DEFAULT_RECENT_COMMIT_LIMIT = 25;

/** Sentinels the prework path skips (touchPoints-aware logic doesn't apply). */
const TOUCH_POINTS_EPIC_WIDE = '<EPIC_WIDE>';
const TOUCH_POINTS_UNKNOWN = '<UNKNOWN>';

/**
 * Collect commits in `projectDir` since `sinceTime` whose changed files
 * intersect the story's `touchPoints`. Returns a deterministic structure
 * the caller can serialize into the dev's `<project_context>` as a
 * `<recent_work>` block.
 *
 * @param {{
 *   projectDir: string,
 *   sinceTime?: string | Date | null,   // ISO; passed verbatim to `git log --since=`
 *   touchPoints?: string[] | null,
 *   limit?: number,
 *   exec?: typeof execSync,             // injectable for tests
 * }} input
 * @returns {{
 *   skipped: boolean,
 *   reason?: string,
 *   commits: Array<{ sha: string, subject: string, files: string[] }>,
 * }}
 */
export function collectRecentTouchPointWork(input) {
  const {
    projectDir,
    sinceTime,
    touchPoints,
    limit = DEFAULT_RECENT_COMMIT_LIMIT,
    exec = execSync,
  } = input || {};

  if (!projectDir) {
    return { skipped: true, reason: 'projectDir required', commits: [] };
  }
  const tp = (touchPoints || []).filter(isNonEmptyString);
  if (tp.length === 0) {
    return { skipped: true, reason: 'no touchPoints declared', commits: [] };
  }
  if (tp.includes(TOUCH_POINTS_EPIC_WIDE) || tp.includes(TOUCH_POINTS_UNKNOWN)) {
    return { skipped: true, reason: 'sentinel touchPoints — prework not applicable', commits: [] };
  }

  // Collect commits + their changed files in a single git invocation.
  // Format: "----<sha>\t<subject>" per commit followed by name-only file lines.
  // Choosing `\t` and a unique sentinel (`----`) so subjects with `:` don't
  // confuse the parser.
  const sinceFlag = normalizeIsoOrNull(sinceTime);
  const args = [
    'log',
    sinceFlag ? `--since=${sinceFlag}` : '',
    `--pretty=format:----%h%x09%s`,
    '--name-only',
    `-n`,
    String(limit),
  ].filter(Boolean);

  let raw;
  try {
    raw = exec(`git ${args.map(shellQuote).join(' ')}`, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
  } catch (err) {
    return {
      skipped: true,
      reason: `git log failed: ${err.message || 'unknown error'}`,
      commits: [],
    };
  }

  const allCommits = parseGitLogOutput(raw);
  const matched = [];
  for (const commit of allCommits) {
    const intersecting = commit.files.filter((f) => tp.some((p) => fileMatchesGlob(f, p)));
    if (intersecting.length > 0) {
      matched.push({ sha: commit.sha, subject: commit.subject, files: intersecting });
    }
  }

  return { skipped: false, commits: matched };
}

/**
 * Parse the DEV agent's WORK_SUMMARY for the canonical "No changes
 * required" sentinel. Tolerant of:
 *   • envelope present or absent
 *   • leading bullet / asterisk styling
 *   • case variations on "no changes required"
 *   • commit shas listed inline OR on their own line(s)
 *
 * Recognized shapes (all return `noChangesRequired: true`):
 *
 *   "No changes required — AC already satisfied by abc1234, def5678"
 *   "**No changes required.** AC already satisfied by abc1234"
 *   "no changes required: ac already satisfied by [abc1234][def5678]"
 *
 * `citedShas` is the deduplicated list of 4–40-char hex tokens found in the
 * sentinel paragraph. Empty if the dev forgot to cite any.
 *
 * @param {string} workSummary
 * @returns {{ noChangesRequired: boolean, citedShas: string[] }}
 */
export function detectNoChangesRequired(workSummary) {
  if (typeof workSummary !== 'string' || workSummary.length === 0) {
    return { noChangesRequired: false, citedShas: [] };
  }
  const inner = stripEnvelope(workSummary);
  const re = /no\s+changes\s+required/i;
  if (!re.test(inner)) {
    return { noChangesRequired: false, citedShas: [] };
  }
  // Pull the paragraph that contains the sentinel so we don't pick up
  // unrelated hex tokens elsewhere in the summary.
  const sentinelLine = pickSentinelParagraph(inner);
  const shaRe = /\b([a-f0-9]{4,40})\b/gi;
  const shas = new Set();
  let m;
  while ((m = shaRe.exec(sentinelLine)) !== null) {
    shas.add(m[1].toLowerCase());
  }
  return { noChangesRequired: true, citedShas: [...shas] };
}

/**
 * Render a `<recent_work>` block ready to splice into the Story Context Pack.
 * Section-ordered, deterministic, no timestamps. Empty string when there's
 * nothing to show.
 *
 * @param {ReturnType<typeof collectRecentTouchPointWork>} report
 * @returns {string}
 */
export function renderRecentWorkBlock(report) {
  if (!report || report.skipped) return '';
  if (!report.commits || report.commits.length === 0) return '';
  const lines = [];
  lines.push('<!-- recent_work — commits since plan-start that touched this story\'s touchPoints -->');
  for (const c of report.commits) {
    lines.push(`### ${c.sha} — ${c.subject}`);
    for (const f of c.files) lines.push(`- ${f}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ── internals ────────────────────────────────────────────────────────────

function parseGitLogOutput(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out = [];
  let current = null;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.startsWith('----')) {
      if (current) out.push(current);
      const rest = line.slice(4);
      const tabIdx = rest.indexOf('\t');
      const sha = tabIdx === -1 ? rest : rest.slice(0, tabIdx);
      const subject = tabIdx === -1 ? '' : rest.slice(tabIdx + 1);
      current = { sha, subject, files: [] };
      continue;
    }
    if (!current) continue;
    if (line.length === 0) continue;
    current.files.push(line);
  }
  if (current) out.push(current);
  return out;
}

function isNonEmptyString(s) {
  return typeof s === 'string' && s.length > 0;
}

function shellQuote(value) {
  if (!/[\s'"$`\\!]/.test(value)) return value;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeIsoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function stripEnvelope(text) {
  let inner = text;
  const startIdx = inner.indexOf('---WORK_SUMMARY---');
  if (startIdx !== -1) inner = inner.slice(startIdx + '---WORK_SUMMARY---'.length);
  const endIdx = inner.indexOf('---END_WORK_SUMMARY---');
  if (endIdx !== -1) inner = inner.slice(0, endIdx);
  return inner;
}

function pickSentinelParagraph(text) {
  // Split on blank lines; return the first paragraph containing the sentinel.
  const paragraphs = text.split(/\n\s*\n/);
  for (const p of paragraphs) {
    if (/no\s+changes\s+required/i.test(p)) return p;
  }
  return text;
}

function fileMatchesGlob(file, glob) {
  if (typeof file !== 'string' || typeof glob !== 'string') return false;
  if (file === glob) return true;
  return segmentsMatch(normalize(file).split('/'), normalize(glob).split('/'));
}

function normalize(p) {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function segmentsMatch(file, glob) {
  if (file.length === 0 && glob.length === 0) return true;
  if (glob.length === 0) return false;
  const g0 = glob[0];
  if (g0 === '**') {
    if (glob.length === 1) return true;
    for (let i = 0; i <= file.length; i++) {
      if (segmentsMatch(file.slice(i), glob.slice(1))) return true;
    }
    return false;
  }
  if (file.length === 0) return false;
  if (segmentMatch(file[0], g0)) return segmentsMatch(file.slice(1), glob.slice(1));
  return false;
}

function segmentMatch(fileSeg, globSeg) {
  if (fileSeg === globSeg) return true;
  if (globSeg === '*') return true;
  if (!globSeg.includes('*')) return false;
  return segmentToRegex(globSeg).test(fileSeg);
}

function segmentToRegex(seg) {
  let re = '';
  for (const c of seg) {
    if (c === '*') re += '[^/]*';
    else if ('.+?^${}()|[]\\/'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
