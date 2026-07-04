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

import { parseProbe, runBrowserJourney } from './browser-probe-executor.mjs';
import { judgeVqaStep } from './p3-vqa-judge.mjs';
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

/** Combine one journey's per-step deterministic + VQA outcomes into its overall LaneVerdict. */
function combineVerdict(deterministicAllPassed, vqaVerdicts) {
  if (!deterministicAllPassed) return 'fail';
  if (vqaVerdicts.some((v) => v === 'fail')) return 'fail';
  if (vqaVerdicts.some((v) => v === 'uncertain')) return 'uncertain';
  return 'pass';
}

/**
 * Upload one local frame file to S3, namespaced under
 * `p3-qa/<planId>/<qaCommitSha>/<journeyId>/...`. Mirrors the exact
 * `aws s3 cp` shell-command shape used by wave-vqa-runner.mjs's screenshot
 * upload (same bucket/content-type/timeout convention), reused here via the
 * injected `s3` primitive (same `(cmd, cwd, timeoutMs) => {code,stdout,stderr}`
 * shape as that module's `shell`).
 *
 * A non-zero exit code degrades to an empty URL (non-blocking, logged loudly)
 * — a NORMAL upload failure mode. A genuine THROW from `s3` is deliberately
 * NOT caught here: it is the per-journey infra-throw case this orchestrator's
 * outer try/catch (in `runP3Qa`) is responsible for containing.
 */
async function uploadFrame({ s3, localPath, key, cwd, log }) {
  if (typeof s3 !== 'function') return '';
  const cmd = `timeout 30 aws s3 cp ${localPath} "s3://futurator-ai-website/${key}" --content-type image/png`;
  const up = await s3(cmd, cwd, 45_000);
  if (up && up.code === 0) return `https://futurator.ai/${key}`;
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
function expandJourneySteps(journey) {
  const browserSteps = [];
  const primaryMeta = [];
  for (const step of journey?.steps || []) {
    const acId = step?.acId ?? '';
    const rawLabel = step?.label || acId || '(unlabeled step)';
    const probe = parseProbe({ when: step?.when, thenObservable: step?.thenObservable, then: step?.then });
    const actions = probe.actions?.length ? probe.actions : [null];

    for (let i = 0; i < actions.length - 1; i++) {
      browserSteps.push({ label: `${rawLabel}__pre${i}__${sanitizeKey(acId)}`, action: actions[i], assertions: [] });
    }
    const finalAction = actions[actions.length - 1];
    const stepLabel = `${acId}::${rawLabel}`;
    browserSteps.push({
      label: stepLabel,
      action: finalAction,
      assertions: probe.interpretable ? probe.assertions : [],
    });

    primaryMeta.push({
      acId,
      label: stepLabel,
      interpretable: probe.interpretable,
      reason: probe.reason,
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
async function runOneJourney({ journey, url, stories, playwright, spawnJudge, s3, qaContext, planId, qaCommitSha, frameRoot, log }) {
  const { browserSteps, primaryMeta } = expandJourneySteps(journey);

  let runResult = { passed: true, detail: 'no steps to run', frames: [] };
  if (browserSteps.length) {
    runResult = await runBrowserJourney({ url, steps: browserSteps, playwright, capture: !!frameRoot, log });
  }

  const steps = [];
  const vqaFlat = [];
  const journeyIdKey = sanitizeKey(journey?.id || 'journey');

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

      const keyPrefix = `p3-qa/${planId}/${qaCommitSha}/${journeyIdKey}`;
      const stamp = Date.now();
      const beforeShotUrl = await uploadFrame({
        s3,
        localPath: beforePath,
        key: `${keyPrefix}/${slug}-before-${stamp}.png`,
        cwd: qaContext?.appDir,
        log,
      });
      const afterShotUrl = await uploadFrame({
        s3,
        localPath: afterPath,
        key: `${keyPrefix}/${slug}-after-${stamp}.png`,
        cwd: qaContext?.appDir,
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

    steps.push({
      label: meta.label,
      action: meta.actionDesc,
      deterministic: det,
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
  const verdict =
    infra || steps.length === 0 ? 'uncertain' : combineVerdict(deterministicAllPassed, vqaVerdicts);

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

  for (const journey of journeys) {
    try {
      const { journeyResult, vqaFlat } = await runOneJourney({
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
      });
      journeyResults.push(journeyResult);
      vqaResults.push(...vqaFlat);
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
      const seam = checkSeamMounted({
        projectDir: qaContext.appDir,
        seamHook: qaContext.seamHook || 'useGameStateMachine',
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

  // Infra-flagged steps (harness failures) are excluded — they never block.
  const anyJourneyDeterministicFail = journeyResults.some((j) => (j.steps || []).some((s) => s.deterministic?.passed === false && !s.deterministic?.infra));
  const anyVqaRealFail = vqaResults.some((v) => v.verdict === 'fail');
  const blocking = anyJourneyDeterministicFail || anyVqaRealFail || wiring.blocking;

  const anyUncertain = journeyResults.some((j) => j.verdict === 'uncertain') || vqaResults.some((v) => v.verdict === 'uncertain');
  const status = blocking ? 'fail' : journeys.length === 0 || anyUncertain ? 'uncertain' : 'pass';

  return {
    status,
    blocking,
    ranAtSha: qaCommitSha,
    journeys: journeyResults,
    vqa: vqaResults,
    wiring,
  };
}
