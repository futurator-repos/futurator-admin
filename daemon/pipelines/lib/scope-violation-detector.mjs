/**
 * Scope-violation detector — Epic D.4 (pipeline-v1 dev correction).
 *
 * Given a story's declared `touchPoints` + `forbiddenAreas` and the actual
 * file set the dev modified, returns:
 *
 *   • `scope-touchpoints` — files modified outside `touchPoints`
 *   • `scope-forbidden`   — files modified that match `forbiddenAreas`
 *
 * The daemon prepends these as automatic AC entries in the structured
 * `---REVIEW_CRITERIA---` block before passing it to the parser. This is
 * intentionally daemon-side (not LLM) so a reviewer that overlooks scope
 * can't accidentally PASS a story that leaked work into a sibling's
 * territory.
 *
 * Deliberately skipped: `<UNKNOWN>` and `<EPIC_WIDE>` sentinels disable the
 * touchPoints check (a legacy story has no declared scope; an epic-wide
 * story is allowed to touch everything by definition). `forbiddenAreas`
 * always applies regardless of sentinels.
 */

const TOUCH_POINTS_EPIC_WIDE = '<EPIC_WIDE>';
const TOUCH_POINTS_UNKNOWN = '<UNKNOWN>';

const SCOPE_TOUCHPOINTS_AC = 'scope-touchpoints';
const SCOPE_FORBIDDEN_AC = 'scope-forbidden';

/**
 * Parse a `git diff --name-status` output into a flat `Set<string>` of
 * modified file paths (A/M/D/R*). Tolerates the `R100\told\tnew` rename
 * format by recording BOTH the old and new paths so neither slips through
 * the scope check.
 *
 * @param {string} diffOutput - the captured DIFF_MANIFEST string
 * @returns {string[]} sorted list of modified paths
 */
export function parseDiffFiles(diffOutput) {
  if (!diffOutput || typeof diffOutput !== 'string') return [];
  const out = new Set();
  for (const rawLine of diffOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Common shapes: "A\tpath", "M\tpath", "D\tpath", "R100\told\tnew", "C50\tsrc\tdst".
    const cols = line.split(/\s+/).filter((c) => c.length > 0);
    if (cols.length === 0) continue;
    const status = cols[0];
    if (/^R/.test(status) || /^C/.test(status)) {
      // Rename / copy: records old and new paths.
      if (cols[1]) out.add(cols[1]);
      if (cols[2]) out.add(cols[2]);
    } else if (/^[AMD]$/.test(status) || /^[AMTUX]$/.test(status)) {
      if (cols[1]) out.add(cols[1]);
    } else {
      // Tolerate name-only diffs (no status column).
      out.add(line);
    }
  }
  return [...out].sort();
}

/**
 * Compute scope violations for a story's diff against its declared scope.
 *
 * @param {{
 *   modifiedFiles: string[],
 *   touchPoints?: string[] | null,
 *   forbiddenAreas?: string[] | null,
 * }} input
 * @returns {{
 *   touchPointsViolations: Array<{ file: string }>,
 *   forbiddenViolations: Array<{ file: string, area: string }>,
 *   skipped: { touchPointsCheck: boolean, reason?: string },
 * }}
 */
export function detectScopeViolations({ modifiedFiles, touchPoints, forbiddenAreas }) {
  const files = Array.isArray(modifiedFiles) ? [...modifiedFiles].sort() : [];

  const tp = Array.isArray(touchPoints) ? touchPoints.filter(isNonEmptyString) : [];
  const fa = Array.isArray(forbiddenAreas) ? forbiddenAreas.filter(isNonEmptyString) : [];

  // ── touchPoints scope ──
  let touchPointsViolations = [];
  let skipped = { touchPointsCheck: false };
  if (tp.length === 0 || tp.includes(TOUCH_POINTS_UNKNOWN)) {
    skipped = { touchPointsCheck: true, reason: 'no declared touchPoints (<UNKNOWN>)' };
  } else if (tp.includes(TOUCH_POINTS_EPIC_WIDE)) {
    skipped = { touchPointsCheck: true, reason: 'story is <EPIC_WIDE>' };
  } else {
    for (const file of files) {
      if (!tp.some((pattern) => fileMatchesGlob(file, pattern))) {
        touchPointsViolations.push({ file });
      }
    }
  }

  // ── forbiddenAreas scope (always applied) ──
  const forbiddenViolations = [];
  for (const file of files) {
    for (const area of fa) {
      if (fileMatchesGlob(file, area)) {
        forbiddenViolations.push({ file, area });
        break;
      }
    }
  }

  return { touchPointsViolations, forbiddenViolations, skipped };
}

/**
 * Render the violations as `---REVIEW_CRITERIA---` AC lines the daemon can
 * prepend to whatever the reviewer agent emits. One `scope-touchpoints` /
 * `scope-forbidden` line per offending file.
 *
 * Output is plain strings ready to splice into the block, e.g.:
 *
 *   scope-touchpoints: fail — modified obstacle.js (not in touchPoints: src/main.js)
 *   scope-forbidden: fail — modified src/utils/auth.ts (matches forbiddenArea: src/utils/auth.ts)
 *
 * Exposed for testability + so the daemon's executeStep keeps the
 * formatting concentrated in one place.
 *
 * @param {ReturnType<typeof detectScopeViolations>} report
 * @param {{ touchPoints?: string[], forbiddenAreas?: string[] }} ctx
 * @returns {string[]} one AC line per violation
 */
export function renderScopeViolationsAsCriteria(report, ctx = {}) {
  const lines = [];
  const tpDisplay = (ctx.touchPoints || []).filter(isNonEmptyString).join(', ') || '(none)';
  let n = 1;
  for (const v of report.touchPointsViolations) {
    lines.push(
      `${SCOPE_TOUCHPOINTS_AC}-${n}: fail — modified ${v.file} (not in touchPoints: ${tpDisplay})`,
    );
    n += 1;
  }
  let m = 1;
  for (const v of report.forbiddenViolations) {
    lines.push(
      `${SCOPE_FORBIDDEN_AC}-${m}: fail — modified ${v.file} (matches forbiddenArea: ${v.area})`,
    );
    m += 1;
  }
  return lines;
}

// ── helpers ──────────────────────────────────────────────────────────────

function isNonEmptyString(s) {
  return typeof s === 'string' && s.length > 0;
}

/**
 * File-vs-glob match. Supports `**`, `*`, and literal segments. Mirrors the
 * conservative semantics of the daemon's `glob-intersect.mjs` and the API's
 * `wave-conflict-resolver.ts` — same input → same answer.
 */
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

  if (segmentMatch(file[0], g0)) {
    return segmentsMatch(file.slice(1), glob.slice(1));
  }
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
