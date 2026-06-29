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
  return {
    at: new Date().toISOString(),
    session: payload.session_id || env.CLAUDE_SESSION_ID || 'nosession',
    role: env.FUTURATOR_AGENT_ROLE || '',
    tool,
    target,
    exitOutcome: typeof exit === 'number' ? (exit === 0 ? 'ok' : 'fail') : undefined,
    sha: env.FUTURATOR_HEAD_SHA || undefined,
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
