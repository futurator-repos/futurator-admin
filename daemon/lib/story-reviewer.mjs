// story-reviewer — W2.1b. The risk-tiered, fresh-context reviewer for pipeline-3.
//
// The deterministic oracle already decides pass/fail objectively; the reviewer
// judges only what the oracle CAN'T: is the code safe/clean, and does a bound
// test actually honour its AC (not a tautology). It is ADVISORY — only an
// advisory-security fail blocks (via evaluateCompletion), advisory-taste is a
// note. It runs in a FRESH context (diff + ACs only, never the implementer's
// reasoning) and only for high-risk stories, so most stories never pay for it.
//
// PURE prompt + parser here; the spawn is injected by the daemon.

/** Should a reviewer be spawned for this story? P0/P1 risk, or a would-be CONCERNS. */
export function shouldReview(acceptanceCriteria = [], qualityVerdict) {
  const highRisk = acceptanceCriteria.some((a) => a.riskTag === 'P0' || a.riskTag === 'P1');
  return highRisk || qualityVerdict?.verdict === 'CONCERNS';
}

/**
 * Fresh-context reviewer prompt. Judges each AC against the diff, focused on the
 * advisory concerns the oracle can't measure. PURE.
 */
export function buildReviewerPrompt({ storyTitle, acceptanceCriteria = [], diff = '' }) {
  const acLines = acceptanceCriteria
    .map((ac, i) => `  ${i + 1}. [${ac.id}] ${ac.text}${ac.acClass ? ` (${ac.acClass})` : ''}${ac.riskTag ? ` {${ac.riskTag}}` : ''}`)
    .join('\n');
  return [
    `You are an INDEPENDENT reviewer. You have NOT seen the implementer's reasoning —`,
    `only the diff and the acceptance criteria. Automated tests already decide whether`,
    `the code works; your job is ONLY what tests can't measure:`,
    `  • security concerns (injection, secret handling, authz gaps),`,
    `  • whether each bound test truly proves its AC (not a tautology),`,
    `  • egregious code-quality issues that will bite future changes.`,
    ``,
    `# Story: ${storyTitle || '(untitled)'}`,
    ``,
    `# Acceptance criteria`,
    acLines || '  (none)',
    ``,
    `# Diff`,
    '```diff',
    String(diff || '').slice(0, 12000),
    '```',
    ``,
    `Return a verdict per AC — "pass" unless you found a concrete, cited concern.`,
    `Be conservative: default to "pass". End with EXACTLY this block:`,
    `<REVIEW>`,
    `{ ${acceptanceCriteria.map((ac) => `"${ac.id}": "pass|fail"`).join(', ')} }`,
    `</REVIEW>`,
    `If an AC genuinely needs a human (ambiguous, can't tell from the diff), add its id`,
    `to a needs-human list: <NEEDS_HUMAN>["AC-x"]</NEEDS_HUMAN>`,
  ].join('\n');
}

const REVIEW_RE = /<REVIEW>([\s\S]*?)<\/REVIEW>/i;
const NEEDS_HUMAN_RE = /<NEEDS_HUMAN>([\s\S]*?)<\/NEEDS_HUMAN>/i;

/** Parse the reviewer's output → { verdicts: {acId:'pass'|'fail'}, needsHuman: string[] }. Tolerant. */
export function parseReviewerVerdict(text) {
  const out = { verdicts: {}, needsHuman: [] };
  if (typeof text !== 'string') return out;
  const m = REVIEW_RE.exec(text);
  if (m) {
    try {
      const obj = JSON.parse(m[1].trim());
      for (const [acId, v] of Object.entries(obj || {})) {
        const val = String(v).toLowerCase();
        if (val === 'pass' || val === 'fail') out.verdicts[acId] = val;
      }
    } catch { /* malformed → empty verdicts (fail-open to no-block) */ }
  }
  const nh = NEEDS_HUMAN_RE.exec(text);
  if (nh) {
    try {
      const arr = JSON.parse(nh[1].trim());
      if (Array.isArray(arr)) out.needsHuman = arr.map(String);
    } catch { /* ignore */ }
  }
  return out;
}
