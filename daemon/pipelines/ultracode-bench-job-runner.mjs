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
 *   - runCase2({intent,model,effort,cwd,rep}) → {scriptJs}
 *   - parseScript(scriptJs) → DecisionPlan
 *   - scorePlans(case1Plan, case2Plan) → {score, perMetric}
 *   - pushEvent(runId, stepId, agentId, eventType, data)
 *   - updateRun(runId, patch) → Promise
 * @returns {Promise<{ok:boolean, reps?:number, tainted?:number, reason?:string, error?:string}>}
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
  const taintReasons = []; // the specific reason each excluded rep failed (for an honest error msg)
  try {
    for (let i = 0; i < reps; i++) {
      const t0 = Date.now();
      await ev(`case1-rep${i}`, 'case1', 'ultracode-bench.case1.start', { rep: i, model, effort });
      await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.start', { rep: i, model, effort });

      // Run BOTH engines in PARALLEL — independent claude processes, same intent, only the prompt
      // differs. Each persists its own result the instant it finishes, so whichever halts first
      // fills its panel; wall-clock ≈ max(case1, case2) instead of the sum.
      const case1P = deps
        .captureCase1({ intent: p.intent, model, effort, cwd: job.workingDir, rep: i, captureTimeoutMs })
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
        })
        .then(async (c2) => {
          const case2DurationMs = Date.now() - t0;
          const case2Plan = deps.parseScript(c2.scriptJs);
          await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.ready', { rep: i });
          await deps.updateRun(runId, {
            case2Status: 'COMPLETE',
            case2Pattern: case2Plan.pattern,
            case2Plan,
            case2Script: c2.scriptJs,
            case2DurationMs,
            case2Tokens: c2.tokens,
          });
          return { c2, case2Plan, case2DurationMs };
        });

      const [R1, R2] = await Promise.all([case1P, case2P]);

      if (R1.tainted) {
        tainted++;
        if (R1.cap.taintReason) taintReasons.push(R1.cap.taintReason);
        continue; // Case 1 produced no usable plan — exclude this rep (Case 2 is still shown)
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
