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
  // The ultracode planner front-loads heavy thinking before persisting a script; floor the capture
  // window at 300s so an older payload (120000) can't undercut it before the API Lambda redeploys.
  const captureTimeoutMs = Math.max(p.captureTimeoutMs || 0, 300000);
  const ev = (stepId, agentId, type, data) => deps.pushEvent(runId, stepId, agentId, type, data);

  await deps.updateRun(runId, {
    status: 'CAPTURING',
    case1Status: 'RUNNING',
    case2Status: 'PENDING',
  });

  const remaining = []; // per-rep results
  let tainted = 0;
  try {
    for (let i = 0; i < reps; i++) {
      // ── CASE 1 — native ultracode, capture + halt ──
      await ev(`case1-rep${i}`, 'case1', 'ultracode-bench.case1.start', { rep: i, model, effort });
      const cap = await deps.captureCase1({
        intent: p.intent,
        model,
        effort,
        cwd: job.workingDir,
        rep: i,
        captureTimeoutMs,
      });
      if (cap.tainted) {
        tainted++;
        await ev(`case1-rep${i}`, 'case1', 'ultracode-bench.case1.tainted', {
          rep: i,
          reason: cap.taintReason,
        });
        continue; // exclude this rep — never count a non-clean capture
      }
      await ev(`case1-rep${i}`, 'case1', 'ultracode-bench.case1.halted', {
        rep: i,
        agentCount: cap.agentCount,
      });
      const case1Plan = deps.parseScript(cap.scriptJs);

      // ── CASE 2 — our meta-prompt, output-only ──
      await deps.updateRun(runId, { case2Status: 'RUNNING' });
      await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.start', { rep: i, model, effort });
      const c2 = await deps.runCase2({
        intent: p.intent,
        model,
        effort,
        cwd: job.workingDir,
        rep: i,
        // Live-stream Case 2's script as it's generated (its stdout IS the script).
        onToken: (text) => ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.token', { text }),
      });
      const case2Plan = deps.parseScript(c2.scriptJs);
      await ev(`case2-rep${i}`, 'case2', 'ultracode-bench.case2.ready', { rep: i });

      const structural = deps.scorePlans(case1Plan, case2Plan);
      remaining.push({
        structural,
        case1Pattern: case1Plan.pattern,
        case2Pattern: case2Plan.pattern,
        // Keep the artifacts so the UI can show the captured plans + raw scripts (a
        // representative rep is persisted on the run row at COMPLETE).
        case1Plan,
        case2Plan,
        case1Script: cap.scriptJs,
        case2Script: c2.scriptJs,
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
      errorMessage: `all ${reps} reps tainted (no clean zero-agent capture)`,
      taintedReps: tainted,
    });
    await ev('final', 'system', 'ultracode-bench.error', { reason: 'all-reps-tainted' });
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
