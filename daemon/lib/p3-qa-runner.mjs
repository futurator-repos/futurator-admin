/**
 * p3-qa-runner.mjs — QA-Review W2 orchestrator.
 *
 * Runs the full W2 verdict (functions/shared/types/qa-review-p3.ts P3QaVerdict)
 * for one Pipeline-3 plan against its ASSEMBLED, DEPLOYED dev URL
 * (`plan.devUrl`), pinned to the frozen commit `plan.qaCommitSha`. Wires the
 * four sibling modules built alongside this one:
 *
 *   - p3-journey-source.mjs  (resolveJourneys)   — WHICH journeys to run
 *   - browser-probe-executor.mjs (parseProbe, runBrowserJourney) — Lane 1
 *     (deterministic __harness assertions), capture:true for before/after
 *     frame Buffers per step.
 *   - p3-vqa-judge.mjs (judgeVqaStep)            — Lane 2 (VQA before/after
 *     judge), given a story source-diff reference and the two captured
 *     frames (written to local scratch files — the judge CLI Reads local
 *     paths, it does not fetch URLs).
 *   - p3-orphan-check.mjs (findOrphanModules)    — the deterministic wiring
 *     sub-lane (assemble-must-import / pacman3 ghost-module class).
 *
 * FAIL-OPEN / HONESTY CONTRACT: an infra throw while processing one journey
 * (e.g. an S3 upload primitive throwing) is caught PER-JOURNEY — that journey
 * degrades to verdict:'uncertain' (non-blocking) and processing CONTINUES to
 * the next journey. An uninterpretable probe step, or a seam-not-mounted /
 * chromium-unavailable Lane-1 result, is NEVER silently fake-passed — it is
 * recorded as a deterministic FAIL. A real (non-throwing) S3 upload failure
 * degrades to an empty frame URL (non-blocking, logged loudly) rather than
 * aborting the journey — only a genuine THROW is the per-journey escape
 * hatch, matching the "s3 upload primitive misbehaves" failure class this
 * orchestrator's own glue code (not a sibling module — those are already
 * fail-open internally) is responsible for containing.
 *
 * NOTE on `sourceDiff`: this orchestrator's signature carries no git/CLI
 * access (by design — no network/git/CLI dependency beyond the injected
 * `s3` primitive). A real unified diff is therefore NOT available here; the
 * Lane-2 judge is given a best-effort textual reference built from the
 * owning story's metadata (storyId/title/intent/touches), with an escape
 * hatch for a real caller-supplied diff via `qaContext.sourceDiffByAcId`
 * (an optional `{ [acId]: diffText }` map) when the daemon wires real git
 * diffing in later. This is documented here rather than silently degrading
 * quality without a trace.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseProbe, runBrowserJourney, runObserveStep, OBSERVE_ONLY_NOTE } from './browser-probe-executor.mjs';
import { judgeVqaStep, judgeObserveStep } from './p3-vqa-judge.mjs';
import { findOrphanModules } from './p3-orphan-check.mjs';
import { resolveJourneys } from './p3-journey-source.mjs';

const EPIC_WIDE_TOUCH = '<EPIC_WIDE>';

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Join a plan's dev URL (may or may not carry a trailing slash / basePath /
 * subdomain-hosted subpath) with an optional subpath so `page.goto()` never
 * 404s on a doubled or missing slash. PURE.
 */
export function joinDevUrl(devUrl, subpath = '') {
  const base = String(devUrl || '').replace(/\/+$/, '');
  if (!subpath) return base ? `${base}/` : '/';
  const clean = String(subpath).replace(/^\/+/, '');
  return base ? `${base}/${clean}` : `/${clean}`;
}

/** Render a parsed action object (browser-probe-executor.mjs shape) as a human string. */
function describeAction(action) {
  if (!action) return '(no action)';
  if (action.type === 'key') return `press ${action.key}`;
  if (action.type === 'harness') return `__harness.${action.method}(${(action.args || []).map((a) => JSON.stringify(a)).join(', ')})`;
  if (action.type === 'wait') return `wait ${action.ms}ms`;
  return JSON.stringify(action);
}

/** Render a parsed assertions array as a human-readable single assertion string. */
function describeAssertions(assertions) {
  if (!assertions || !assertions.length) return '(no assertion)';
  return assertions
    .map((a) => `snapshot.${a.field} ${a.op === 'gt' ? '>' : a.op === 'lt' ? '<' : '=='} ${JSON.stringify(a.value)}`)
    .join(' and ');
}

/** Turn any string into a safe path/key fragment. */
function sanitizeKey(s) {
  return String(s || 'step').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

/** Find the story that owns a given AC id (dangling refs resolve to undefined). */
function findStoryForAc(acId, stories) {
  for (const s of stories || []) {
    if ((s?.acceptanceCriteria || []).some((ac) => ac?.id === acId)) return s;
  }
  return undefined;
}

/**
 * Best-effort source-diff reference for the Lane-2 judge (see file header note).
 * Prefers a caller-supplied real diff (`qaContext.sourceDiffByAcId[acId]`) when
 * present; otherwise falls back to a textual story-metadata summary. PURE.
 */
function sourceDiffFor(acId, stories, qaContext) {
  const injected = qaContext?.sourceDiffByAcId?.[acId];
  if (typeof injected === 'string' && injected.trim()) return injected;
  const story = findStoryForAc(acId, stories);
  if (!story) return '(no source diff available — owning story not found)';
  const touches = (story.touches || []).filter((t) => t !== EPIC_WIDE_TOUCH);
  return [
    '(no git diff wired for QA-Review W2 — story metadata only)',
    `# story: ${story.storyId || '?'} — ${story.title || ''}`,
    `# touches: ${touches.length ? touches.join(', ') : EPIC_WIDE_TOUCH}`,
    `# intent: ${story.intent || ''}`,
  ].join('\n');
}

/** Flatten StoryNodeRow.touches across every story (glob/EPIC_WIDE passed through untouched). */
function flattenTouches(stories) {
  const out = [];
  for (const s of stories || []) for (const t of s?.touches || []) out.push(t);
  return out;
}

const INFRA_DETAIL_PATTERNS = [
  'seam not mounted',
  'chromium unavailable',
  'browser journey error',
];

/**
 * Infer one primary step's deterministic pass/fail from `runBrowserJourney`'s
 * AGGREGATE result (it reports one passed:boolean + one joined detail string
 * for the whole journey, not per-step booleans). An infra-level detail (seam
 * not mounted / chromium unavailable / thrown-and-caught journey error)
 * applies to every step in the journey (Lane 1 has no 'uncertain' state —
 * DeterministicResult is boolean-only, so an unmounted seam is a FAIL here,
 * per the honesty contract). Otherwise, a step is judged failed only if its
 * OWN label appears in the '|'-joined per-step failure list.
 */
function stepDeterministicFromResult(runResult, stepLabel, assertionsDesc) {
  if (runResult.passed) return { assertion: assertionsDesc, passed: true, detail: 'assertion(s) passed' };
  const detail = runResult.detail || '';
  if (INFRA_DETAIL_PATTERNS.some((p) => detail.includes(p))) {
    return { assertion: assertionsDesc, passed: false, detail };
  }
  const entries = detail.split(' | ');
  const mine = entries.find((e) => e.startsWith(`${stepLabel}: `));
  if (mine) return { assertion: assertionsDesc, passed: false, detail: mine.slice(stepLabel.length + 2) };
  // This step's own label was not in the failure list — it individually passed
  // even though a SIBLING step in the same journey failed.
  return { assertion: assertionsDesc, passed: true, detail: 'assertion(s) passed' };
}

/**
 * Combine one journey's per-step deterministic + VQA outcomes into its overall
 * LaneVerdict.
 *
 * CONFIRMATORY POLICY (redesign Part 3 / operator's top pain): the DETERMINISTIC
 * lane — hardened by focus/settle/poll in browser-probe-executor — is the GATE.
 * VQA is CONFIRMATORY. Callers apply the BLOCKING short-circuit first (any step
 * with `blocking:true` → journey 'fail'); this function decides the NON-blocking
 * remainder. When every deterministic step passed, the journey PASSES; a VQA
 * 'fail' is DOWNGRADED to attention (recorded on the step's rationale, but NEVER
 * flips a deterministically-verified journey to 'fail'). A step the deterministic
 * lane could not decide (undecided/undriveable, already proven non-blocking by
 * the caller) → 'uncertain'. Only a genuinely UNKNOWN VQA also → 'uncertain'.
 */
function combineVerdict(deterministicAllPassed, vqaVerdicts) {
  if (!deterministicAllPassed) return 'uncertain';
  if (vqaVerdicts.some((v) => v === 'uncertain')) return 'uncertain';
  return 'pass';
}

/**
 * Upload one local frame file to S3 → a publicly-reachable URL.
 *
 * BUCKET (2026-07-07 pacman4 fix): writes to the DEV-ENV bucket
 * (`qaContext.screenshotBucket`, served at `qaContext.screenshotBase` =
 * https://dev.futurator.ai) under an `_qa/` prefix — NOT the public
 * `futurator-ai-website` bucket, which the daemon's EC2 role is (correctly)
 * denied PutObject on (CLAUDE.md scoped-write law). `_qa` is a reserved prefix
 * (app slugs are kebab-case and never start with `_`), so it never collides
 * with a deployed app. Missing bucket → skip (empty URL); the verdict still
 * lands with journeys + wiring, just no frame thumbnails.
 *
 * A non-zero exit code degrades to an empty URL (non-blocking, logged loudly).
 * A genuine THROW from `s3` is deliberately NOT caught here: it is the
 * per-journey infra-throw case runP3Qa's outer try/catch contains.
 */
async function uploadFrame({ s3, localPath, key, cwd, log, bucket, base }) {
  if (typeof s3 !== 'function' || !bucket) return '';
  const cmd = `timeout 30 aws s3 cp ${localPath} "s3://${bucket}/${key}" --content-type image/png`;
  const up = await s3(cmd, cwd, 45_000);
  if (up && up.code === 0) return `${base}/${key}`;
  try {
    log('warn', `[p3-qa-runner] SCREENSHOT_UPLOAD_FAILED for ${key}: ${(up?.stderr || '').slice(0, 200)}`);
  } catch {
    /* best-effort */
  }
  return '';
}

// ── Per-journey processing ──────────────────────────────────────────────

/**
 * Expand a p3-journey-source journey's `steps` (AC-prose, one per acId) into:
 *  - `browserSteps`: the post-parse `{label, action, assertions}` shape
 *    `runBrowserJourney` expects, one PRIMARY step per AC (extra parsed
 *    actions beyond the first are inserted as assertion-less "pre" steps so
 *    the driven app still advances through every action, without silently
 *    dropping a multi-action `when` clause).
 *  - `primaryMeta`: one entry per AC carrying everything needed to build the
 *    final JourneyStep + (optionally) judge it visually.
 */
export function expandJourneySteps(journey, { observeOnly = false } = {}) {
  const browserSteps = [];
  const primaryMeta = [];
  for (const step of journey?.steps || []) {
    // OBSERVE steps (p3-journey-source `toObserveStep`, kind:'observe') have no
    // driving action and no deterministic assertion — they are handled entirely
    // by the runner's separate observe path (runObserveStep + single-frame
    // judge → advisoryVqa), NOT the deterministic browser-journey driver. Skip
    // them here so they never become an uninterpretable Lane-1 step.
    if (step?.kind === 'observe') continue;
    const acId = step?.acId ?? '';
    const rawLabel = step?.label || acId || '(unlabeled step)';
    const probe = parseProbe({ when: step?.when, thenObservable: step?.thenObservable, then: step?.then });
    let actions = probe.actions?.length ? probe.actions : [null];

    // OBSERVE-ONLY: drop the harness DRIVE lane (forceStatus/dispatch). A probe
    // must reach the state the way a USER would; keys/clicks survive.
    let droveNothing = false;
    if (observeOnly) {
      const kept = actions.filter((a) => !(a && a.type === 'harness'));
      if (kept.length !== actions.length) {
        // The AC's ONLY route to its state was the disabled DRIVE lane → the
        // deterministic lane cannot decide it (we did NOT execute a real drive).
        // Mark it UNDECIDED (non-blocking on its own), never a hard fail.
        droveNothing = kept.length === 0;
        actions = kept.length ? kept : [null];
      }
    }

    for (let i = 0; i < actions.length - 1; i++) {
      browserSteps.push({ label: `${rawLabel}__pre${i}__${sanitizeKey(acId)}`, action: actions[i], assertions: [], settle: step?.settle });
    }
    const finalAction = actions[actions.length - 1];
    const stepLabel = `${acId}::${rawLabel}`;
    // When the drive was fully disabled, the step is UNDECIDED: no assertions run
    // (we couldn't reach the state), so the deterministic lane reads 'undecided'
    // not 'hard-fail'. VQA on the (identical) frames stays confirmatory.
    const interpretable = probe.interpretable && !droveNothing;
    const reason = droveNothing ? OBSERVE_ONLY_NOTE : probe.reason;
    browserSteps.push({
      label: stepLabel,
      action: finalAction,
      assertions: interpretable ? probe.assertions : [],
      settle: step?.settle,
    });

    primaryMeta.push({
      acId,
      label: stepLabel,
      interpretable,
      reason,
      assertionsDesc: describeAssertions(probe.assertions),
      actionDesc: describeAction(finalAction),
      when: step?.when,
      thenObservable: step?.thenObservable,
      then: step?.then,
    });
  }
  return { browserSteps, primaryMeta };
}

/**
 * Run ONE journey end to end: Lane 1 (browser probe drive), then Lane 2 (VQA
 * judge) per act step with captured frames, then combine into a JourneyResult
 * (functions/shared/types/qa-review-p3.ts). Any exception here propagates to
 * the caller's per-journey try/catch (`runP3Qa`) — this function does not
 * itself fail-open beyond what its callees already guarantee.
 */
async function runOneJourney({ journey, url, stories, playwright, spawnJudge, s3, qaContext, planId, qaCommitSha, frameRoot, log, observeOnly = true, wait }) {
  const { browserSteps, primaryMeta } = expandJourneySteps(journey, { observeOnly });

  let runResult = { passed: true, detail: 'no steps to run', frames: [] };
  if (browserSteps.length) {
    runResult = await runBrowserJourney({ url, steps: browserSteps, playwright, capture: !!frameRoot, log, observeOnly, wait });
  }

  const steps = [];
  const vqaFlat = [];
  const advisoryFlat = [];
  const journeyIdKey = sanitizeKey(journey?.id || 'journey');

  // ── OBSERVE steps (Q1 — advisory-taste appearance ACs) ────────────────────
  // A pure-appearance AC (no `when`, no deterministic assertion) drove nothing:
  // navigate → settle → single "after" frame → single-frame VQA judge. The
  // result is written back per-AC as `advisoryVqa` (attention-only, NEVER
  // blocking — the advisory-taste contract). Frame capture/judging failures
  // record status:'error' (a diagnosable engine miss, never a fabricated pass);
  // a genuine s3 upload THROW propagates to runP3Qa's per-journey escape hatch,
  // exactly like the action-step path.
  const screenshotBucket = qaContext?.screenshotBucket;
  const screenshotBase = qaContext?.screenshotBase || 'https://dev.futurator.ai';
  for (const obs of journey?.steps || []) {
    if (obs?.kind !== 'observe') continue;
    const acId = obs.acId ?? '';
    let status = 'error';
    let rationale = '';
    let frameUrl = '';
    const observed = await runObserveStep({ url, step: obs, playwright, log, wait });
    if (observed?.ok && observed.frames?.after && frameRoot) {
      const slug = sanitizeKey(`observe-${acId}`);
      const afterPath = join(frameRoot, `${slug}-after.png`);
      writeFileSync(afterPath, observed.frames.after);
      const judged = await judgeObserveStep({
        spec: { id: acId, acText: obs.spec },
        frame: afterPath,
        spawnJudge,
        cwd: qaContext?.appDir,
        log,
      });
      // Map: pass → 'pass'; fail|uncertain → 'attention' (never blocking);
      // judge/engine failure → 'error' (distinct from a genuine attention).
      if (!judged.ok) {
        status = 'error';
      } else if (judged.verdict === 'pass') {
        status = 'pass';
      } else {
        status = 'attention';
      }
      rationale = judged.rationale;
      const stamp = Date.now();
      frameUrl = await uploadFrame({
        s3,
        localPath: afterPath,
        key: `_qa/${planId}/${qaCommitSha}/${journeyIdKey}/${slug}-observe-${stamp}.png`,
        cwd: qaContext?.appDir,
        bucket: screenshotBucket,
        base: screenshotBase,
        log,
      });
    } else {
      status = 'error';
      rationale = observed?.detail || 'observe frame capture failed';
    }
    advisoryFlat.push({ acId, status, judgedAt: new Date().toISOString(), sha: qaCommitSha, frameUrl, rationale });
  }

  // A harness/infra failure (no browser, launch/nav error) is NOT an app verdict
  // — flag every step so the blocking check excludes it and the journey reads
  // 'uncertain' (never a false-block, never a fake-pass).
  const infra = !!runResult.infra;
  for (const meta of primaryMeta) {
    const det = !meta.interpretable
      ? { assertion: meta.assertionsDesc, passed: false, detail: `probe not interpretable: ${meta.reason}` }
      : infra
        ? { assertion: meta.assertionsDesc, passed: false, infra: true, detail: `harness unavailable: ${runResult.detail}` }
        : stepDeterministicFromResult(runResult, meta.label, meta.assertionsDesc);

    let stepVqa;
    const frame = (runResult.frames || []).find((f) => f.stepLabel === meta.label);
    if (frameRoot && frame?.before && frame?.after) {
      const slug = sanitizeKey(meta.label);
      const beforePath = join(frameRoot, `${slug}-before.png`);
      const afterPath = join(frameRoot, `${slug}-after.png`);
      writeFileSync(beforePath, frame.before);
      writeFileSync(afterPath, frame.after);

      const story = findStoryForAc(meta.acId, stories);
      const sourceDiff = sourceDiffFor(meta.acId, stories, qaContext);
      const spec = { id: meta.acId, acText: meta.actionDesc, thenObservable: meta.thenObservable, then: meta.then };
      const judged = await judgeVqaStep({
        spec,
        sourceDiff,
        beforeFrame: beforePath,
        afterFrame: afterPath,
        spawnJudge,
        cwd: qaContext?.appDir,
        log,
      });

      // `_qa/` reserved prefix in the DEV-ENV bucket (served at screenshotBase).
      const keyPrefix = `_qa/${planId}/${qaCommitSha}/${journeyIdKey}`;
      const stamp = Date.now();
      const beforeShotUrl = await uploadFrame({
        s3,
        localPath: beforePath,
        key: `${keyPrefix}/${slug}-before-${stamp}.png`,
        cwd: qaContext?.appDir,
        bucket: screenshotBucket,
        base: screenshotBase,
        log,
      });
      const afterShotUrl = await uploadFrame({
        s3,
        localPath: afterPath,
        key: `${keyPrefix}/${slug}-after-${stamp}.png`,
        cwd: qaContext?.appDir,
        bucket: screenshotBucket,
        base: screenshotBase,
        log,
      });

      stepVqa = {
        verdict: judged.verdict,
        rationale: judged.rationale,
        beforeShotUrl,
        afterShotUrl,
        sourceDiffRef: story?.storyId ? `story:${story.storyId}` : 'unknown',
      };
      vqaFlat.push({
        journeyId: journey?.id ?? '',
        stepLabel: meta.label,
        verdict: stepVqa.verdict,
        rationale: stepVqa.rationale,
        beforeShotUrl: stepVqa.beforeShotUrl,
        afterShotUrl: stepVqa.afterShotUrl,
      });
    }

    // BLOCKING POLICY (confirmatory gate). A VQA fail can NEVER block a step
    // whose deterministic assertion passed (det.passed===true → both terms
    // below are false) — that is the fix for VQA false-negatives on a working
    // canvas game. A step blocks only when the deterministic lane HARD-fails an
    // interpretable assertion, OR the lane is UNDECIDED (uninterpretable/drive-
    // disabled, no infra) AND VQA independently confirms a fail.
    const detHardFail = det.passed === false && meta.interpretable && !det.infra;
    const detUndecided = det.passed === false && !meta.interpretable && !det.infra;
    const vqaFail = stepVqa?.verdict === 'fail';
    const blocking = detHardFail || (detUndecided && vqaFail);

    steps.push({
      label: meta.label,
      action: meta.actionDesc,
      deterministic: det,
      blocking,
      ...(stepVqa ? { vqa: stepVqa } : {}),
    });
  }

  const deterministicAllPassed = steps.every((s) => s.deterministic.passed);
  const vqaVerdicts = steps.filter((s) => s.vqa).map((s) => s.vqa.verdict);

  // A journey with ZERO executable steps verified NOTHING — reporting 'pass'
  // (the vacuous every()→true path) would be a fake-pass (honesty contract). A
  // journey whose acRefs all resolved to non-browser-shaped ACs lands here.
  // Report 'uncertain' (non-blocking, surfaced to the operator) instead. An
  // infra failure of the harness likewise reads 'uncertain', never a block.
  // BLOCKING short-circuit first (a real blocker → 'fail'); then the confirmatory
  // remainder. A VQA fail on a deterministically-passed step is NOT blocking, so
  // it never reaches 'fail' here — the journey stays 'pass'.
  const anyBlocking = steps.some((s) => s.blocking);
  const verdict =
    infra || steps.length === 0
      ? 'uncertain'
      : anyBlocking
        ? 'fail'
        : combineVerdict(deterministicAllPassed, vqaVerdicts);

  return {
    journeyResult: {
      id: journey?.id ?? '',
      title: journey?.title ?? '',
      narrative: journey?.narrative,
      acRefs: Array.isArray(journey?.acRefs) ? journey.acRefs : [],
      verdict,
      steps,
    },
    vqaFlat,
    advisoryFlat,
  };
}

// ── Orchestrator entry point ─────────────────────────────────────────────

/**
 * Run the full QA-Review W2 verdict for one plan.
 *
 * @param {{
 *   plan: { planId?:string, devUrl?:string, qaCommitSha?:string, deliveryJourneys?:object[] },
 *   stories?: object[],
 *   journeys?: object[],
 *   playwright?: object,
 *   spawnJudge?: Function,
 *   s3?: Function,
 *   qaContext?: { appDir?:string, sourceDiffByAcId?: Record<string,string> },
 *   log?: (level:string, msg:string) => void,
 * }} args
 * @returns {Promise<import('../../functions/shared/types/qa-review-p3.ts').P3QaVerdict>}
 */
export async function runP3Qa({
  plan = {},
  stories = [],
  journeys: providedJourneys,
  playwright,
  spawnJudge,
  s3,
  qaContext,
  log = () => {},
  // OBSERVE-ONLY by default (redesign Part 3 §4): QA probes reach states the way
  // a user would — the harness DRIVE lane (forceStatus/dispatch) is refused. TRUE
  // here means agent-daemon needs NO edit to get the safe posture.
  observeOnly = true,
  // Injected poll/settle clock (tests pass a no-op); production uses real timers.
  wait,
  // Q1 — writeback for per-AC advisoryVqa (observe steps). Injected by the daemon
  // (buildStoryStateUpdate + UpdateCommand on the story row). Default no-op so
  // pure unit tests need no persistence. Called once per affected story with the
  // WHOLE mutated acceptanceCriteria array (mirrors testBinding writeback).
  persistAdvisory,
  // Q2 — Agentic VQA lane. `agenticMode` is the resolved P3_AGENTIC_VQA flag
  // ('off'|'shadow'|'on'); 'off' skips the lane, 'shadow' runs+records but never
  // gates, 'on' lets a [blocking] agentic finding contribute to verdict.blocking.
  agenticMode = 'off',
  // Injected agentic runner (tests). Default lazily imports the real lane so the
  // heavy browser-agent/SDK deps only load when the lane is actually enabled.
  runAgentic = async (args) => (await import('./agentic-vqa-runner.mjs')).runAgenticVqa(args),
  // Env passed through to the agentic lane (BROWSER_AGENT_*/AGENTIC_VQA_* keys).
  env = process.env,
  // Q3b — { misconfigured, box }: when the daemon's lazy playwright import
  // FAILED, the daemon flags it here so the verdict carries an explicit
  // 'qa-engine-misconfigured' attention marker naming the box, distinct from a
  // real app 'seam unreachable' failure.
  qaEngine = {},
} = {}) {
  const vlog = (level, msg) => {
    try {
      log(level, `[p3-qa-runner] ${msg}`);
    } catch {
      /* best-effort */
    }
  };

  const planId = plan?.planId ?? '';
  const qaCommitSha = plan?.qaCommitSha ?? '';
  const url = joinDevUrl(plan?.devUrl);

  const journeys = Array.isArray(providedJourneys) && providedJourneys.length
    ? providedJourneys
    : resolveJourneys({ plan, stories });

  let frameRoot = null;
  try {
    frameRoot = mkdtempSync(join(tmpdir(), 'p3-qa-'));
  } catch (err) {
    vlog('warn', `could not create frame scratch dir — Lane 2 (VQA) disabled for this run, Lane 1 unaffected: ${err?.message || err}`);
  }

  const journeyResults = [];
  const vqaResults = [];
  const advisoryResults = [];

  for (const journey of journeys) {
    try {
      const { journeyResult, vqaFlat, advisoryFlat } = await runOneJourney({
        journey,
        url,
        stories,
        playwright,
        spawnJudge,
        s3,
        qaContext,
        planId,
        qaCommitSha,
        frameRoot,
        log,
        observeOnly,
        wait,
      });
      journeyResults.push(journeyResult);
      vqaResults.push(...vqaFlat);
      advisoryResults.push(...(advisoryFlat || []));
    } catch (err) {
      vlog('warn', `journey ${journey?.id ?? '?'} infra-threw — degrading to uncertain (non-blocking), continuing to the next journey: ${err?.message || err}`);
      journeyResults.push({
        id: journey?.id ?? '',
        title: journey?.title ?? '',
        narrative: journey?.narrative,
        acRefs: Array.isArray(journey?.acRefs) ? journey.acRefs : [],
        verdict: 'uncertain',
        steps: [],
      });
    }
  }

  if (frameRoot) {
    try {
      rmSync(frameRoot, { recursive: true, force: true });
    } catch {
      /* best-effort — scratch cleanup never fails the run */
    }
  }

  let wiring = { orphanModules: [], blocking: false };
  if (qaContext?.appDir) {
    wiring = findOrphanModules({ appDir: qaContext.appDir, builtModules: flattenTouches(stories), log });
    // Static seam-mount sub-lane (the pacman4/pacman3 gate, previously wired
    // only into the legacy epic path): grep-level proof of whether any feature
    // file actually calls the seam hook. Cheap, deterministic, and it makes the
    // verdict's ROOT CAUSE explicit (journeys report the symptom "seam not
    // mounted"; this reports the cause "hook never imported"). Fail-open.
    try {
      const { checkSeamMounted } = await import('./seam-mount-check.mjs');
      // seamHook is BOILERPLATE METADATA (registry testHarness.seamHook),
      // resolved by the cron and carried on the p3-qa job — the pipeline never
      // hardcodes an app-kind's hook. Absent → checkSeamMounted returns
      // checked:false (N/A); the runtime probe still covers "no seam" honestly.
      const seam = checkSeamMounted({
        projectDir: qaContext.appDir,
        seamHook: qaContext.seamHook,
      });
      // Block ONLY on the orphaned-scaffold case (hook DEFINED but never
      // imported — the pacman3 class). A tree without the hook at all is N/A:
      // the runtime probe covers "no seam" honestly and there's nothing to wire.
      if (seam.checked && seam.defined !== false) {
        wiring = { ...wiring, seamMounted: seam.mounted, seamDetail: seam.reason };
        if (!seam.mounted) wiring.blocking = true;
      }
    } catch (e) {
      vlog('warn', `seam-mount check skipped (fail-open): ${e?.message || e}`);
    }
  }

  // Q1 — persist per-AC advisoryVqa onto the owning story rows (attention-only,
  // never blocking). Group by story, mutate the in-memory AC, write the WHOLE
  // acceptanceCriteria array back (mirrors testBinding writeback). A persist
  // failure is logged, never fatal.
  if (typeof persistAdvisory === 'function' && advisoryResults.length) {
    const affected = new Map();
    for (const adv of advisoryResults) {
      const story = findStoryForAc(adv.acId, stories);
      if (!story) continue;
      const ac = (story.acceptanceCriteria || []).find((a) => a?.id === adv.acId);
      if (!ac) continue;
      ac.advisoryVqa = {
        status: adv.status,
        judgedAt: adv.judgedAt,
        ...(adv.sha ? { sha: adv.sha } : {}),
        ...(adv.frameUrl ? { frameUrl: adv.frameUrl } : {}),
        ...(adv.rationale ? { rationale: adv.rationale } : {}),
      };
      affected.set(story.storyId, story);
    }
    for (const story of affected.values()) {
      try {
        await persistAdvisory({ storyId: story.storyId, acceptanceCriteria: story.acceptanceCriteria });
      } catch (e) {
        vlog('warn', `advisoryVqa writeback failed for ${story.storyId} (non-blocking): ${e?.message || e}`);
      }
    }
  }

  // Q2 — Agentic VQA lane (BrowserAgent operator-play-test). Runs AFTER the
  // deterministic journeys. It NEVER throws (honesty contract); a missing
  // BROWSER_AGENT_API_KEY surfaces as report.skippedReason:'no-api-key' and
  // never fails QA. A [blocking] finding contributes to verdict.blocking ONLY
  // when the flag is 'on' ('shadow' records the report but never gates).
  let agentic;
  if (agenticMode !== 'off') {
    try {
      agentic = await runAgentic({
        plan,
        journeys,
        devUrl: plan?.devUrl,
        sha: qaCommitSha,
        mode: env.AGENTIC_VQA_MODE || 'auto',
        s3,
        log,
        env,
        screenshotBucket: qaContext?.screenshotBucket,
        screenshotBase: qaContext?.screenshotBase,
      });
    } catch (err) {
      vlog('warn', `agentic VQA lane threw (non-blocking): ${err?.message || err}`);
      agentic = {
        mode: 'headless',
        model: env.AGENTIC_VQA_MODEL || 'claude-sonnet-5',
        skippedReason: `error: ${err?.message || err}`,
        runs: [],
      };
    }
  }
  const agenticBlocking =
    agenticMode === 'on' &&
    !!agentic &&
    (agentic.runs || []).some((r) => (r.findings || []).some((f) => f?.severity === 'blocking'));

  // BLOCKING = the per-step confirmatory policy (runOneJourney): a step blocks
  // only on a deterministic HARD-fail, or an UNDECIDED step that VQA confirms.
  // A VQA fail alone (on a deterministically-passed step) is downgraded to
  // attention and CANNOT block — the anyVqaRealFail term is deliberately gone.
  // Plus (flag 'on' only) a blocking agentic finding.
  const anyStepBlocking = journeyResults.some((j) => (j.steps || []).some((s) => s.blocking));
  const blocking = anyStepBlocking || wiring.blocking || agenticBlocking;

  const anyUncertain = journeyResults.some((j) => j.verdict === 'uncertain') || vqaResults.some((v) => v.verdict === 'uncertain');
  const status = blocking ? 'fail' : journeys.length === 0 || anyUncertain ? 'uncertain' : 'pass';

  const out = {
    status,
    blocking,
    ranAtSha: qaCommitSha,
    journeys: journeyResults,
    vqa: vqaResults,
    wiring,
  };
  if (agentic) out.agentic = agentic;
  // Q3b — explicit QA-engine-misconfigured marker (playwright import failed on
  // this box). Non-blocking attention: it means BOTH lanes could not drive a
  // browser, so the journeys read 'uncertain' for an ENGINE reason, not an app
  // failure. Names the box (SERVER_ID) so the operator fixes the right host.
  if (qaEngine?.misconfigured) {
    out.qaEngineMisconfigured = {
      box: qaEngine.box || '(unknown box)',
      note: `qa-engine-misconfigured: playwright/chromium is not available on ${qaEngine.box || 'this QA box'} — deterministic + observe lanes could not drive a browser (this is an ENGINE/install problem on the box, not an app failure). Install the daemon's playwright browsers to restore QA.`,
    };
  }
  return out;
}
