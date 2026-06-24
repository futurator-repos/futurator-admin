// judge-panel.mjs — Scorer 2 (design doc §7). Blind-paired LLM-as-judge.
//
// Reuses the daemon assessor convention (scorecard-assess-job-runner.mjs): a marker-block prompt
// and a TOLERANT parser that DOWNGRADES a score with no justification to null (the honesty rule).
// Net-new vs the daemon: blind A/B pairing (relabel + randomize so the judge can't tell Case 1 from
// Case 2) and 3-judge averaging with single-outlier rejection.
//
// `runJudge(prompt) → Promise<string>` is injectable — default shells to `claude -p`; tests pass a
// deterministic stub so the panel is unit-testable with no live model.

import { spawn } from 'node:child_process';

/** module-spec §7.2 axes. */
export const JUDGE_AXES = [
  'detail', 'assertiveness', 'logic_soundness', 'completeness', 'structure_clarity', 'decomposition_quality',
];

/** Render a plan for a judge WITHOUT provenance — strips source/extraction so A/B is truly blind. */
export function renderPlanForJudge(plan) {
  return JSON.stringify({
    pattern: plan.pattern,
    qualityPatterns: plan.qualityPatterns,
    verify: plan.verify,
    reduceSteps: plan.reduceSteps,
    earlyExit: plan.earlyExit,
    phases: plan.phases.map((p) => ({
      name: p.name, mode: p.mode, fanOut: p.fanOut,
      agents: p.agents.map((a) => ({ role: a.role, hasSchema: a.hasSchema, model: a.model, isolation: a.isolation })),
    })),
    edges: plan.edges,
  }, null, 2);
}

export function buildJudgePrompt({ planAText, planBText, axes = JUDGE_AXES }) {
  return `You are comparing two software development PLANS, labeled A and B. They were produced by
different planners for the SAME intent. Score each plan 0–10 on every axis below, with a ONE-LINE
justification per axis. Do not assume either is "the reference"; judge only what you see.

Axes: ${axes.join(', ')}

PLAN A:
${planAText}

PLAN B:
${planBText}

Respond with ONLY this block (valid JSON array; one object per axis):
---JUDGE---
[{ "axis": "detail", "A": <0-10>, "B": <0-10>, "justification": "<one line>" }, ...]
---END_JUDGE---`;
}

/** Tolerant parse; a score with NO justification is dropped to null (assessor honesty rule). */
export function parseJudgeOutput(raw, axes = JUDGE_AXES) {
  let body = raw;
  const m = raw.match(/---JUDGE---\s*([\s\S]*?)\s*---END_JUDGE---/);
  if (m) body = m[1];
  else { const arr = raw.match(/\[[\s\S]*\]/); if (arr) body = arr[0]; }
  body = body.replace(/```[a-z]*\n?/gi, '').trim();

  let parsed;
  try { parsed = JSON.parse(body); } catch { return {}; }
  if (!Array.isArray(parsed)) return {};

  const out = {};
  for (const row of parsed) {
    const axis = String(row?.axis || '').trim();
    if (!axes.includes(axis)) continue;
    const just = String(row?.justification || '').trim();
    const clamp = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : null);
    let A = clamp(row.A), B = clamp(row.B);
    if (!just) { A = null; B = null; } // no justification → not trustworthy
    out[axis] = { A, B, justification: just };
  }
  return out;
}

/** Average 3 judges, rejecting a single outlier when the spread is wide (median-anchored). */
function aggregate(values) {
  const v = values.filter((x) => typeof x === 'number');
  if (v.length === 0) return null;
  if (v.length <= 2) return mean(v);
  const sorted = [...v].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const spread = sorted[sorted.length - 1] - sorted[0];
  if (spread > 3) { // drop the single value furthest from the median, average the rest
    let worst = 0, wd = -1;
    v.forEach((x, i) => { const d = Math.abs(x - med); if (d > wd) { wd = d; worst = i; } });
    return mean(v.filter((_, i) => i !== worst));
  }
  return mean(v);
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** Default judge: one-shot `claude -p`. Overridable for tests. */
function defaultRunJudge(prompt, { model = 'opus' } = {}) {
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', prompt, '--model', model, '--permission-mode', 'bypassPermissions'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out));
    p.on('error', () => resolve('')); // no claude available → empty (parser yields {})
  });
}

/**
 * Run the blind-paired 3-judge panel.
 * @param {object} args
 * @param {object} args.case1   DecisionPlan (Case 1)
 * @param {object} args.case2   DecisionPlan (Case 2)
 * @param {number} args.seed    rep index — seeds the A/B flip (Math.random is avoided for reproducibility)
 * @param {number} [args.judges=3]
 * @param {(prompt:string)=>Promise<string>} [args.runJudge]
 * @returns {Promise<{perAxis:Record<string,{case1:number|null,case2:number|null}>, notes:string[], blind:{case1:'A'|'B'}}>}
 */
export async function runJudgePanel({ case1, case2, seed = 0, judges = 3, runJudge = defaultRunJudge, axes = JUDGE_AXES }) {
  // blind A/B by seed parity — even ⇒ case1=A, odd ⇒ case1=B
  const case1IsA = seed % 2 === 0;
  const planAText = renderPlanForJudge(case1IsA ? case1 : case2);
  const planBText = renderPlanForJudge(case1IsA ? case2 : case1);
  const prompt = buildJudgePrompt({ planAText, planBText, axes });

  const raws = await Promise.all(Array.from({ length: judges }, () => runJudge(prompt)));
  const parsed = raws.map((r) => parseJudgeOutput(r, axes));

  const notes = [];
  const perAxis = {};
  for (const axis of axes) {
    const aVals = parsed.map((p) => p[axis]?.A).filter((x) => x != null);
    const bVals = parsed.map((p) => p[axis]?.B).filter((x) => x != null);
    const aAgg = aggregate(aVals);
    const bAgg = aggregate(bVals);
    // un-blind: map A/B back to case1/case2
    perAxis[axis] = case1IsA ? { case1: aAgg, case2: bAgg } : { case1: bAgg, case2: aAgg };
    for (const p of parsed) if (p[axis]?.justification) notes.push(`[${axis}] ${p[axis].justification}`);
  }
  return { perAxis, notes, blind: { case1: case1IsA ? 'A' : 'B' } };
}
