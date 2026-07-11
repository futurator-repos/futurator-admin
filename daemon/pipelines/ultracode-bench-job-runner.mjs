/**
 * ultracode-bench-job-runner.mjs — daemon runner for a PENDING `jobType: 'ultracode-bench'` row.
 *
 * SYMMETRIC FRAME (2026-06-24): per rep, run TWO single `claude` invocations at the SAME model +
 * effort (Opus 4.8 · xhigh), differing ONLY in the prompt:
 *   CASE 1 — native `ultracode <intent>`: capture the generated planner `.js` and HALT before
 *            fan-out (kill the subprocess on a size-stable wf_<id>.json; assert agentCount === 0).
 *   CASE 2 — our Futurator Workflow Author meta-prompt: `claude -p`, output-only, returns a script.
 * Both scripts are AST-parsed to the SAME DecisionPlan IR and structurally diffed. Guardrails are a
 * later layer, not part of this frame.
 *
 * DI: every effectful dep (captureCase1, runCase2, parseScript, scorePlans, pushEvent, updateRun) is
 * injected, so this orchestration is unit-tested WITHOUT spawning Claude or touching DDB. Production
 * wiring lives in `agent-daemon.mjs::executeUltracodeBenchJob` (adds the dispatch branch in
 * selectHandler's switch + the `classifyAgentForSpend` line — see the EC2-validation doc).
 *
 * The kill-on-script-write halt and the headless `claude -p ultracode` trigger are UNPROVEN until
 * validated on real EC2 (see docs). Until then a rep whose wf_<id>.json is missing or whose
 * agentCount > 0 is TAINTED and excluded — never silently counted as a clean zero-token capture.
 */

import { CANCELLED_TAINT_REASON } from './ultracode-bench-capture.mjs';

/** Pure structural check, mirrors validateScorecardAssessJob. */
export function validateUltracodeBenchJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'ultracode-bench') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  if (!job.workingDir) return { ok: false, reason: 'workingDir-missing' };
  const p = job.ultracodeBenchPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'ultracodeBenchPayload-missing' };
  if (!p.runId) return { ok: false, reason: 'runId-missing' };
  if (!p.intent || typeof p.intent !== 'string') return { ok: false, reason: 'intent-missing' };
  if (typeof p.reps !== 'number' || p.reps < 1) return { ok: false, reason: 'reps-invalid' };
  return { ok: true };
}

const CONFOUND_NOTE =
  'Symmetric frame: both engines are single claude runs at the same model+effort; the only variable is the prompt.';

/**
 * @param {object} job
 * @param {object} deps
 *   - paused: boolean
 *   - captureCase1({intent,model,effort,cwd,rep,captureTimeoutMs}) → {scriptJs,agentCount,tainted,taintReason}
 *   - runCase2({intent,model,effort,cwd,rep}) → {scriptJs,planText}
 *   - parseScript(scriptJs) → DecisionPlan
 *   - scorePlans(case1Plan, case2Plan) → {score, perMetric}
 *   - pushEvent(runId, stepId, agentId, eventType, data)
 *   - updateRun(runId, patch) → Promise
 *   - isCancelRequested?(runId) → Promise<boolean>  (true-cancel: read cancelRequestedAt off the run row)
 * @returns {Promise<{ok:boolean, reps?:number, tainted?:number, cancelled?:boolean, reason?:string, error?:string}>}
 */
export async function runUltracodeBenchJob(job, deps) {
  const v = validateUltracodeBenchJob(job);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (deps.paused) return { ok: false, reason: 'agent-paused' };

  const p = job.ultracodeBenchPayload;
  const { runId } = p;
  const reps = p.reps;
  const model = p.model || 'opus';
  // 'max' is the CLI's highest effort tier (the old 'xhigh' default is rejected by the claude CLI).
  const effort = p.effort || 'max';
  // Opus·max Case 1 authoring runs ~4.5–5min and was timing out at 300s; floor the capture window at
  // 600s so an older/short payload can't undercut it. The capture still halts early the instant the
  // plan's scriptPath appears, so this only bites a genuinely slow/stuck run.
  const captureTimeoutMs = Math.max(p.captureTimeoutMs || 0, 600000);
  const ev = (stepId, agentId, type, data) => deps.pushEvent(runId, stepId, agentId, type, data);

  await deps.updateRun(runId, {
    status: 'CAPTURING',
    case1Status: 'RUNNING',
    case2Status: 'RUNNING', // both engines run in parallel
  });

  const remaining = []; // per-rep results
  let tainted = 0;
  let cancelled = false; // operator pressed Cancel — finalize as CANCELLED, never ERROR
  const taintReasons = []; // the specific reason each excluded rep failed (for an honest error msg)
  // True-cancel signal (optional dep so tests/old wirings stay valid; without it Cancel is inert).
  const isCancelRequested = deps.isCancelRequested ? () => deps.isCancelRequested(runId) : null;
  try {
    for (let i = 0; i < reps; i++) {
      if (isCancelRequested && (await isCancelRequested())) {
        cancelled = true;
        break;
      }
      const t0 = Date.now();
      await ev(`case1-rep${i}`, 'case1', 'ultracode-bench.case1.start', { rep: i, model, effort });
      await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.start', { rep: i, model, effort });

      // Run BOTH engines in PARALLEL — independent claude processes, same intent, only the prompt
      // differs. Each persists its own result the instant it finishes, so whichever halts first
      // fills its panel; wall-clock ≈ max(case1, case2) instead of the sum.
      const case1P = deps
        .captureCase1({
          intent: p.intent,
          model,
          effort,
          cwd: job.workingDir,
          rep: i,
          captureTimeoutMs,
          shouldAbort: isCancelRequested ?? undefined,
        })
        .then(async (cap) => {
          const case1DurationMs = Date.now() - t0;
          if (cap.tainted) {
            await ev(`case1-rep${i}`, 'case1', 'ultracode-bench.case1.tainted', {
              rep: i,
              reason: cap.taintReason,
            });
            return { cap, case1DurationMs, tainted: true };
          }
          await ev(`case1-rep${i}`, 'case1', 'ultracode-bench.case1.halted', {
            rep: i,
            agentCount: cap.agentCount,
          });
          const case1Plan = deps.parseScript(cap.scriptJs);
          await deps.updateRun(runId, {
            case1Status: 'HALTED',
            case1Pattern: case1Plan.pattern,
            case1Plan,
            case1Script: cap.scriptJs,
            case1DurationMs,
            case1Tokens: cap.tokens,
          });
          return { cap, case1Plan, case1DurationMs };
        });

      const case2P = deps
        .runCase2({
          intent: p.intent,
          model,
          effort,
          cwd: job.workingDir,
          rep: i,
          onToken: (text) => ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.token', { text }),
          shouldAbort: isCancelRequested ?? undefined,
        })
        .then(async (c2) => {
          const case2DurationMs = Date.now() - t0;
          if (c2.aborted) {
            await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.cancelled', { rep: i });
            await deps.updateRun(runId, { case2Status: 'CANCELLED' });
            return { c2, aborted: true, case2DurationMs };
          }
          // Honesty guard (auth-failure incident 2026-07-11): stdout with no real workflow
          // declaration (login error, refusal, prose-only) must NOT read as COMPLETE — the old
          // path recorded the error text as a 1-line "script" with pattern 'other'.
          if (!/^export const meta\s*=/m.test(c2.scriptJs || '')) {
            await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.tainted', {
              rep: i,
              reason: `no workflow script in output: ${(c2.scriptJs || '').slice(0, 120) || '(empty)'}`,
            });
            await deps.updateRun(runId, { case2Status: 'ERROR' });
            return { c2, invalid: true, case2DurationMs };
          }
          const case2Plan = deps.parseScript(c2.scriptJs);
          // Cap the plan text before it lands on the row — same "don't inflate the row" rule as
          // the other inline artifacts here (scripts/plans are already small; this one is prose).
          const case2PlanText = (c2.planText || '').slice(0, 4000);
          await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.ready', { rep: i });
          await deps.updateRun(runId, {
            case2Status: 'COMPLETE',
            case2Pattern: case2Plan.pattern,
            case2Plan,
            case2Script: c2.scriptJs,
            case2PlanText,
            case2DurationMs,
            case2Tokens: c2.tokens,
          });
          return { c2, case2Plan, case2PlanText, case2DurationMs };
        });

      const [R1, R2] = await Promise.all([case1P, case2P]);

      // Operator cancel surfaced through either engine (kill mid-capture) → stop the whole run.
      if (R1.cap?.taintReason === CANCELLED_TAINT_REASON || R2.aborted) {
        cancelled = true;
        break;
      }

      if (R1.tainted) {
        tainted++;
        if (R1.cap.taintReason) taintReasons.push(R1.cap.taintReason);
        continue; // Case 1 produced no usable plan — exclude this rep (Case 2 is still shown)
      }
      if (R2.invalid) {
        tainted++;
        taintReasons.push('case2 emitted no workflow script');
        continue; // Case 2 produced no usable plan — nothing to diff this rep
      }

      const structural = deps.scorePlans(R1.case1Plan, R2.case2Plan);
      remaining.push({
        structural,
        case1Pattern: R1.case1Plan.pattern,
        case2Pattern: R2.case2Plan.pattern,
        case1Plan: R1.case1Plan,
        case2Plan: R2.case2Plan,
        case1Script: R1.cap.scriptJs,
        case2Script: R2.c2.scriptJs,
        case2PlanText: R2.case2PlanText,
        case1DurationMs: R1.case1DurationMs,
        case2DurationMs: R2.case2DurationMs,
        case1Tokens: R1.cap.tokens,
        case2Tokens: R2.c2.tokens,
      });
    }
  } catch (err) {
    await deps.updateRun(runId, {
      status: 'ERROR',
      case1Status: 'ERROR',
      errorMessage: err?.message || String(err),
      taintedReps: tainted,
    });
    return { ok: false, error: err?.message || String(err) };
  }

  if (cancelled) {
    await deps.updateRun(runId, {
      status: 'CANCELLED',
      case1Status: 'CANCELLED',
      case2Status: 'CANCELLED',
      errorMessage: 'Cancelled by operator',
      taintedReps: tainted,
    });
    await ev('final', 'system', 'ultracode-bench.cancelled', { reps: remaining.length, tainted });
    // ok:true — the job did what was asked (stop); a cancel is not a daemon failure.
    return { ok: true, cancelled: true, reps: remaining.length, tainted };
  }

  if (remaining.length === 0) {
    await deps.updateRun(runId, {
      status: 'ERROR',
      case1Status: 'ERROR',
      errorMessage: `Case 1 produced no usable plan in ${reps} rep(s): ${[...new Set(taintReasons)].join('; ') || 'tainted'}`,
      taintedReps: tainted,
    });
    await ev('final', 'system', 'ultracode-bench.error', {
      reason: [...new Set(taintReasons)].join('; ') || 'all-reps-tainted',
    });
    return { ok: false, reason: 'all-reps-tainted', tainted };
  }

  await deps.updateRun(runId, { status: 'SCORING' });
  const agg = aggregate(remaining);
  // Representative rep (the last clean one) whose plans + scripts back the UI detail view.
  const rep = remaining[remaining.length - 1];
  const scorecard = {
    structural: { score: agg.score, perMetric: agg.perMetric },
    slices: agg.slices,
    verdict: agg.verdict,
    observations: [
      CONFOUND_NOTE,
      ...(tainted ? [`${tainted}/${reps} reps tainted (excluded).`] : []),
    ],
  };

  await deps.updateRun(runId, {
    status: 'COMPLETE',
    case1Status: 'HALTED',
    case2Status: 'COMPLETE',
    structuralScore: agg.score,
    case1Pattern: mode(remaining.map((r) => r.case1Pattern)),
    case2Pattern: mode(remaining.map((r) => r.case2Pattern)),
    verdict: agg.verdict,
    summarySlices: agg.slices.slice(0, 10),
    scorecard,
    taintedReps: tainted,
    // Artifacts for the UI detail view (phases, subagents, raw scripts).
    case1Plan: rep?.case1Plan,
    case2Plan: rep?.case2Plan,
    case1Script: rep?.case1Script,
    case2Script: rep?.case2Script,
    case2PlanText: rep?.case2PlanText,
    // Per-case planning time + token usage (the measurability the operator asked for).
    case1DurationMs: rep?.case1DurationMs,
    case2DurationMs: rep?.case2DurationMs,
    case1Tokens: rep?.case1Tokens,
    case2Tokens: rep?.case2Tokens,
  });
  await ev('final', 'system', 'ultracode-bench.complete', {
    structuralScore: agg.score,
    reps: remaining.length,
    tainted,
  });
  return { ok: true, reps: remaining.length, tainted };
}

// ── pure aggregation ───────────────────────────────────────────────────────────
function aggregate(reps) {
  const scores = reps.map((r) => r.structural.score);
  const score = mean(scores);
  const metricKeys = new Set();
  for (const r of reps)
    for (const k of Object.keys(r.structural.perMetric || {})) metricKeys.add(k);
  const perMetric = {};
  for (const k of metricKeys)
    perMetric[k] = round3(
      mean(reps.map((r) => r.structural.perMetric?.[k]).filter((x) => typeof x === 'number')),
    );
  const verdict = score >= 0.7 ? 'case2-matches' : 'case2-gaps';
  const slices = Object.entries(perMetric).map(([k, vRaw]) => {
    const v = vRaw;
    return {
      criterionId: `STRUCT-${k}`,
      stage: 'development',
      score: v == null ? null : Math.max(0, Math.min(4, Math.round(v * 4))),
      verdict: v == null ? '⚪' : v >= 1 ? '🟢' : v >= 0.5 ? '🟡' : '🔴',
      value: v,
      evidence: { kind: 'report', ref: `structural.perMetric.${k}` },
      ieIds: [],
      fixIds: [],
      engine: 'deterministic',
    };
  });
  slices.push({
    criterionId: 'STRUCT-aggregate',
    stage: 'development',
    score: Math.max(0, Math.min(4, Math.round(score * 4))),
    verdict: score >= 1 ? '🟢' : score >= 0.5 ? '🟡' : '🔴',
    value: round3(score),
    evidence: { kind: 'report', ref: 'structural.score' },
    ieIds: [],
    fixIds: [],
    engine: 'deterministic',
  });
  return { score: round3(score), perMetric, slices, verdict };
}

function mean(xs) {
  const v = (xs || []).filter((x) => typeof x === 'number');
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}
function mode(xs) {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  let best = xs[0];
  let bn = -1;
  for (const [k, n] of c)
    if (n > bn) {
      bn = n;
      best = k;
    }
  return best;
}
const round3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
