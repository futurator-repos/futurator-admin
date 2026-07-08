/**
 * p3-vqa-judge — QA-Review W2, Lane 2 (VQA judge) for one delivery-journey
 * step (functions/shared/types/qa-review-p3.ts §Lane 2).
 *
 * Lane 1 (deterministic __harness assertions, browser-probe-executor.mjs) is
 * the primary verdict. Lane 2 corroborates it visually: a BEFORE frame
 * (baseline, captured pre-action) and an AFTER frame (post-action) are shown
 * to a VLM judge alongside the story's SOURCE DIFF — research shows including
 * the code that produced the behavior measurably improves judge accuracy
 * (+6.4-8.7pts) over pixels alone — and the judge is asked whether the
 * expected CHANGE occurred between the two frames. This mirrors the
 * `beforeAfter` directive in functions/shared/services/qa-author.ts
 * (`postInteractionJudge(..., beforeAfter=true)`): two frames, compare, PASS
 * only if frame 2 differs from frame 1 in the expected way.
 *
 * The daemon is native ESM and cannot import functions/shared/*.ts, so
 * `parseJudgeOutput`/`judgeConsensus` below are DUPLICATED byte-for-byte from
 * daemon/lib/wave-vqa-runner.mjs (parity-tested — see
 * __tests__/p3-vqa-judge.test.mjs). Do not fork their behavior without
 * updating both copies.
 *
 * HONESTY CONTRACT / FAIL-OPEN: an infra error (spawnJudge throws, no output,
 * unparseable output, a missing frame) NEVER produces a false 'pass' — it
 * degrades to 'uncertain' (non-blocking) with a diagnosable rationale. A real,
 * confidently-parsed FAIL is the only thing that gates. Two frames are ALWAYS
 * required and ALWAYS both passed to the judge — a single-frame judgment is
 * never attempted (there is nothing to compare against).
 */

// ── Duplicated from daemon/lib/wave-vqa-runner.mjs (parity-tested) ─────────

/** Parse one judge's output per the VERDICT/OBSERVATION contract. */
export function parseJudgeOutput(output) {
  const vm = (output || '').match(
    /VERDICT:\s*(PASS|FAIL|UNREACHABLE|UNCERTAIN)\s*(?:\[conf=(high|low)\])?/i,
  );
  if (!vm) return null;
  const om = (output || '').match(/OBSERVATION:\s*(.+)/i);
  return {
    verdict: vm[1].toUpperCase(),
    confidence: (vm[2] || 'low').toLowerCase(),
    observation: (om?.[1] || '').trim().slice(0, 300),
  };
}

/**
 * Panel consensus for one AC. `votes`: [{lens, verdict, confidence, observation}].
 * CONFIRMED FAIL = strict majority FAIL with at least one high-confidence
 * vote (mirrors review-runtime's "only confident fails drive fixes").
 * Majority UNREACHABLE → unverifiable. Anything else non-blocking.
 */
export function judgeConsensus(votes) {
  const n = votes.length;
  if (n === 0) return { result: 'UNCERTAIN' };
  const count = (v) => votes.filter((x) => x.verdict === v).length;
  const fails = votes.filter((x) => x.verdict === 'FAIL');
  if (fails.length * 2 > n && fails.some((x) => x.confidence === 'high')) {
    return { result: 'FAIL', observation: fails.map((f) => f.observation).join(' | ') };
  }
  if (count('UNREACHABLE') * 2 > n) return { result: 'UNVERIFIABLE' };
  if (count('PASS') * 2 > n) return { result: 'PASS' };
  return { result: 'UNCERTAIN' };
}

// ── Two-frame judge prompt (mirrors qa-author.ts's beforeAfter directive) ───

/**
 * The end-state expectation to judge, in plain words. Mirrors
 * `deriveEndStateExpectation` in qa-author.ts: prefer the BDD
 * thenObservable/then, else strip a "transitions … to X" preamble down to the
 * end state, else fall back to the raw AC/spec text. PURE.
 */
function deriveEndState(spec) {
  const obs = (spec?.thenObservable || spec?.then || '').trim();
  if (obs) return obs.replace(/[.;]\s*$/, '');
  const text = (spec?.acText || spec?.text || spec?.action || spec?.label || '').trim();
  const m =
    /\b(?:transitions?|changes?|switch(?:es)?|goes|moves?|advances?|turns?)\b[^.]*?\bto\b\s+(.+)/i.exec(
      text,
    );
  if (m) return m[1].trim().replace(/[.;]\s*$/, '');
  return text.replace(/[.;]\s*$/, '');
}

/**
 * Build the two-frame judge prompt. ALWAYS references both frame paths
 * exactly once each, and ALWAYS includes the story's source diff (fenced) —
 * an uninterpretable/missing diff still renders the fence with a placeholder
 * rather than silently dropping the section (never fake it away). PURE.
 */
export function buildTwoFrameJudgePrompt({ spec, sourceDiff, beforeFrame, afterFrame }) {
  const end = deriveEndState(spec);
  const acId = spec?.id || spec?.acId || '';
  const acText = spec?.acText || spec?.text || '';
  const acLine = acId ? `Acceptance criterion: ${acId}${acText ? ` — ${acText}` : ''}` : null;
  return [
    'You are the QA-Review Lane-2 visual judge for a single delivery-journey step.',
    'Two screenshots were captured: frame 1 = BEFORE the action (baseline), frame 2 = AFTER.',
    `Use the Read tool to open frame 1 at ${beforeFrame} and frame 2 at ${afterFrame}, then inspect both.`,
    '',
    `Compare them and judge whether the expected CHANGE occurred: ${end || '(no end-state derivable — judge the raw spec below)'}.`,
    'PASS only if frame 2 differs from frame 1 in the expected way; if the two frames look the',
    'same (no effect) FAIL. Do NOT expect a title/start screen.',
    '',
    acLine,
    acLine ? '' : null,
    'The story source diff that produced this behavior — ground your judgment in what actually',
    'changed in the code (code context measurably improves judge accuracy over pixels alone):',
    '```diff',
    sourceDiff && sourceDiff.trim() ? sourceDiff : '(no source diff provided)',
    '```',
    '',
    'TOLERANCE — IGNORE incidental rendering variation: sprite/animation-frame differences,',
    'anti-aliasing, particle effects, score-digit font/kerning, sub-pixel motion, minor color',
    'shifts. Judge ONLY whether the SPECIFIC expected change above is present vs absent.',
    'CONFIRMATORY — a deterministic assertion has ALREADY decided this step by reading the app',
    'state directly; you are a SECOND opinion, not the primary gate. Overturn it to FAIL ONLY',
    'with a HIGH-confidence, clearly-contradicting observation. Plausible motion or change that',
    'is CONSISTENT with the expected change → PASS (do not demand pixel-perfect proof).',
    '',
    'Verdict rules, in order:',
    '1. UNREACHABLE — if these frames physically cannot show the expected change (wrong surface,',
    '   blank/error page unrelated to this criterion) — never FAIL an unreachable case.',
    '2. PASS — frame 2 plausibly shows the expected change from frame 1 (consistent with it).',
    '3. FAIL — ONLY when the frames CONCRETELY contradict the expected change AND you can cite the',
    '   specific contradicting observation. Requires conf=high. If you are not highly confident, or',
    '   the difference is merely incidental rendering variation, this is NOT a FAIL.',
    '4. UNCERTAIN — unreadable images, ambiguous, or genuinely too close to call (any non-high FAIL).',
    '',
    'Output EXACTLY two lines:',
    'VERDICT: PASS|FAIL|UNREACHABLE|UNCERTAIN [conf=high|low]',
    "OBSERVATION: <≤200 chars — what actually changed (or didn't) between the frames>",
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Map the raw consensus result to the plan-level LaneVerdict
 * ('pass'|'fail'|'uncertain' — functions/shared/types/qa-review-p3.ts). A
 * confirmed FAIL blocks; PASS clears; everything else (UNVERIFIABLE,
 * UNCERTAIN, no votes) is 'uncertain' and NEVER blocks — only routes to the
 * operator (F12 honest-verdict lane).
 */
function toLaneVerdict(result) {
  if (result === 'PASS') return 'pass';
  if (result === 'FAIL') return 'fail';
  return 'uncertain';
}

/**
 * Judge one before/after step. Injects `spawnJudge` (the VLM caller) so this
 * is testable hermetically — production wiring spawns the real judge CLI, the
 * same shape as wave-vqa-runner.mjs's `spawnJudge`: `async ({prompt, cwd}) =>
 * ({ ok, output })`.
 *
 * @param {{ spec: object, sourceDiff: string, beforeFrame: string,
 *           afterFrame: string, spawnJudge: Function, cwd?: string,
 *           log?: Function }} args
 * @returns {Promise<{ verdict: 'pass'|'fail'|'uncertain', rationale: string }>}
 */
export async function judgeVqaStep({
  spec,
  sourceDiff,
  beforeFrame,
  afterFrame,
  spawnJudge,
  cwd,
  log = () => {},
}) {
  const vlog = (level, msg) => log(level, `[p3-vqa-judge] ${msg}`);

  // Two frames are a hard precondition — never attempt a single-frame
  // judgment (there is nothing to compare a change against).
  if (!beforeFrame || !afterFrame) {
    vlog('warn', 'missing before/after frame — degrading to uncertain (non-blocking)');
    return {
      verdict: 'uncertain',
      rationale: 'both a before and an after frame are required for Lane-2 judging; at least one was missing',
    };
  }
  if (typeof spawnJudge !== 'function') {
    vlog('warn', 'no spawnJudge injected — degrading to uncertain (non-blocking)');
    return { verdict: 'uncertain', rationale: 'no judge available to invoke' };
  }

  const prompt = buildTwoFrameJudgePrompt({ spec, sourceDiff, beforeFrame, afterFrame });

  let judged;
  try {
    judged = await spawnJudge({ prompt, cwd });
  } catch (err) {
    vlog('warn', `spawnJudge threw: ${err?.message || err} — degrading to uncertain (non-blocking)`);
    return { verdict: 'uncertain', rationale: `judge invocation failed: ${err?.message || err}` };
  }

  if (judged?.ok === false) {
    const tail = (judged.reason || judged.output || '').slice(0, 200);
    vlog('warn', `judge unavailable: ${tail} — degrading to uncertain (non-blocking)`);
    return { verdict: 'uncertain', rationale: `judge unavailable: ${tail || '(no detail)'}` };
  }

  const parsed = parseJudgeOutput(judged?.output);
  const vote = parsed
    ? { lens: 'before-after', ...parsed }
    : { lens: 'before-after', verdict: 'UNCERTAIN', confidence: 'low', observation: 'judge output unparseable' };

  const consensus = judgeConsensus([vote]);
  const verdict = toLaneVerdict(consensus.result);
  const rationale = consensus.observation || vote.observation || '(no observation)';

  vlog('info', `verdict=${verdict} rawResult=${consensus.result} :: ${rationale}`);
  return { verdict, rationale };
}
