// posttool-observe — capture deterministic observations for the instinct loop
// (development-plan §5.5, Pillar 3). A PostToolUse sibling on the gate's plumbing.
//
// Records WHAT the tools + gate actually did — never an LLM judgment — to
// observations.jsonl, which instinct-distiller later reduces. Best-effort,
// fail-open: a learning-capture blip must never affect the run.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build one observation row from a PostToolUse payload + env. PURE. */
export function buildObservation(payload = {}, env = {}) {
  const tool = payload.tool_name || payload.toolName || env.CLAUDE_TOOL_NAME || '';
  const input = payload.tool_input || payload.toolInput || {};
  const target = input.file_path || (input.command ? String(input.command).slice(0, 120) : '') || '';
  const exit = payload.tool_response?.exitCode ?? payload.exitCode;
  // W4.3 — additive TDD/gate telemetry the instinct distiller can group on. Only
  // included when present (identical shape by default), so this is purely
  // additive and doubly-inert at default-off (the hook only runs when the gate
  // set FUTURATOR_OBSERVE_LOG). Flat fields (not nested) to match the distiller.
  const extra = {};
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') extra[k] = v; };
  set('scopeViolation', payload.scopeViolation ?? env.FUTURATOR_SCOPE_VIOLATION);
  set('gateTier', payload.gateTier ?? env.FUTURATOR_GATE_TIER);
  set('tamper', payload.tamper ?? env.FUTURATOR_TAMPER);
  set('redFirstFail', payload.redFirstFail ?? env.FUTURATOR_RED_FIRST_FAIL);
  set('coverageGap', payload.coverageGap ?? env.FUTURATOR_COVERAGE_GAP);
  set('mutationSurvivor', payload.mutationSurvivor ?? env.FUTURATOR_MUTATION_SURVIVOR);
  return {
    at: new Date().toISOString(),
    session: payload.session_id || env.CLAUDE_SESSION_ID || 'nosession',
    role: env.FUTURATOR_AGENT_ROLE || '',
    tool,
    target,
    exitOutcome: typeof exit === 'number' ? (exit === 0 ? 'ok' : 'fail') : undefined,
    sha: env.FUTURATOR_HEAD_SHA || undefined,
    ...extra,
  };
}

/** Append one observation. Best-effort; never throws. */
export function appendObservation(path, obs) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(obs) + '\n', 'utf8');
  } catch { /* fail-open */ }
}

/** Read observations.jsonl into rows (tolerant of corrupt lines). */
export function readObservations(path) {
  try {
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

export function main(env = process.env) {
  try {
    if (!env.FUTURATOR_OBSERVE_LOG) return 0;
    let raw = '';
    try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
    appendObservation(env.FUTURATOR_OBSERVE_LOG, buildObservation(payload, env));
    return 0;
  } catch { return 0; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
