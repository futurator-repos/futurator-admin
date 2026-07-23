// pretool-gate — the keystone live gate for daemon dev spawns.
//
// Fuses three converged ideas from the harness analyses:
//   • ecc composite RISK SCORE  (base + file-sensitivity + blast-radius + irreversibility)
//   • ecc GateGuard FACT-FORCE  (block-once-with-required-facts, then allow — never "are you sure?")
//   • jcode/SDD SCOPE GATE       (touchPoints / forbiddenAreas) — reuses the daemon's own detector
//
// Posture: deterministic, no LLM, FAIL-OPEN. A broken gate must never brick a run.
// Modes: off (allow all) · audit (never block, just emit markers — safe rollout) · enforce (real exit 2).
//
// Claude Code PreToolUse hook contract: exit 0 = allow, exit 2 = block (stderr → fed to the model).
// Wire-in: spread the hook command into the dev spawn; pass policy via env (see README).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectScopeViolations } from '../../daemon/pipelines/lib/scope-violation-detector.mjs';

const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);
const SECRET_RE = /\.env|\.ssh|\.aws|id_rsa|id_ed25519|\.pem|\bsecret\b|\btoken\b|credential/i;
const INFRA_RE = /Dockerfile|\.github\/workflows|Cargo\.toml|package\.json|sst\.config|tsconfig/i;

// ── ecc risk model: composite 0–1 score → tier ───────────────────────────────
export function computeRisk(toolName, toolInput = {}) {
  const factors = [];
  let score = 0;
  const add = (n, why) => { score += n; factors.push(why); };

  const base = { Bash: 0.2, Write: 0.15, MultiEdit: 0.15, Edit: 0.1 }[toolName] ?? 0;
  if (base) add(base, `base:${toolName}=${base}`);

  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    if (SECRET_RE.test(cmd)) add(0.25, 'secret-path');
    else if (INFRA_RE.test(cmd)) add(0.15, 'infra-file');
    // irreversibility (take the strongest)
    if (/\brm\s+-rf\b|git\s+reset\s+--hard|\bdrop\s+table\b|\btruncate\b|\bdd\s+if=/i.test(cmd)) add(0.45, 'irreversible');
    else if (/git\s+push\s+.*-f\b|--force\b/i.test(cmd)) add(0.4, 'force-push');
    // blast radius
    if (/\brm\s+-rf\s+\/|git\s+push\s+.*\b(main|master)\b/i.test(cmd)) add(0.35, 'shared-blast');
    else if (/\*\*|find\s+.*\bxargs/.test(cmd)) add(0.25, 'glob-blast');
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const path = String(toolInput.file_path || '');
    if (SECRET_RE.test(path)) add(0.25, 'secret-path');
    else if (INFRA_RE.test(path)) add(0.15, 'infra-file');
  }

  score = Math.min(1, score);
  const tier = score >= 0.85 ? 'block' : score >= 0.6 ? 'confirm' : score >= 0.35 ? 'review' : 'allow';
  return { score: Number(score.toFixed(2)), tier, factors };
}

// File targeted by a mutating file tool (null for Bash / non-file tools).
export function targetFile(toolName, toolInput = {}) {
  return ['Edit', 'Write', 'MultiEdit'].includes(toolName) ? (toolInput.file_path || null) : null;
}

// ── decision: pure, deterministic. main() maps it to exit codes + fact-force memo. ──
export function decide(payload, policy = {}) {
  const { toolName, toolInput } = payload;
  if (!MUTATING.has(toolName)) return { decision: 'allow', reason: `${toolName} is read-only` };

  const file = targetFile(toolName, toolInput);

  // 1) scope gate — reuse the daemon's own detector so pre-write == post-hoc audit.
  if (file) {
    const { touchPointsViolations, forbiddenViolations } = detectScopeViolations({
      modifiedFiles: [file],
      touchPoints: policy.touchPoints,
      forbiddenAreas: policy.forbiddenAreas,
    });
    if (forbiddenViolations.length)
      return { decision: 'block', reason: `forbidden: ${file} matches forbiddenArea ${forbiddenViolations[0].area}` };
    if (touchPointsViolations.length)
      return { decision: 'block', reason: `out-of-scope: ${file} not in touchPoints [${(policy.touchPoints || []).join(', ')}]` };
  }

  // 2) risk gate (ecc).
  const risk = computeRisk(toolName, toolInput);
  const where = file || `\`${String(toolInput.command || '').slice(0, 80)}\``;
  if (risk.tier === 'block')
    return { decision: 'block', reason: `risk ${risk.score} [${risk.factors.join('+')}] on ${where}`, risk };
  if (risk.tier === 'confirm')
    return { decision: 'fact-force', reason: factForceMsg(where, risk), risk };
  if (risk.tier === 'review')
    return { decision: 'audit', reason: `review risk ${risk.score} [${risk.factors.join('+')}] on ${where}`, risk };
  return { decision: 'allow', reason: 'low risk', risk };
}

function factForceMsg(where, risk) {
  return [
    `BLOCKED (fact-force, risk ${risk.score} [${risk.factors.join('+')}]) on ${where}.`,
    'Before retrying, state in your reasoning: (1) which callers/files this affects,',
    '(2) the rollback if it goes wrong, (3) why this is the minimum change. Then retry — it will pass.',
  ].join(' ');
}

// ── hook plumbing ─────────────────────────────────────────────────────────────
export function parseHookPayload(rawStdin, env = {}) {
  let toolName = env.CLAUDE_TOOL_NAME || '';
  let toolInput = {};
  const raw = String(rawStdin || '').trim();
  if (raw) {
    try {
      const j = JSON.parse(raw);
      toolName = j.tool_name || j.toolName || toolName;
      toolInput = j.tool_input || j.toolInput || {};
    } catch { /* fall through to env */ }
  }
  if (!Object.keys(toolInput).length && env.CLAUDE_TOOL_INPUT) {
    try { toolInput = JSON.parse(env.CLAUDE_TOOL_INPUT); } catch { /* leave empty */ }
  }
  return { toolName, toolInput, sessionId: env.CLAUDE_SESSION_ID || 'nosession' };
}

export function loadPolicy(env = {}) {
  const list = (v) => {
    if (!v) return [];
    try { const j = JSON.parse(v); return Array.isArray(j) ? j : [String(j)]; }
    catch { return String(v).split(',').map((s) => s.trim()).filter(Boolean); }
  };
  return {
    mode: (env.FUTURATOR_GATE_MODE || 'audit').toLowerCase(), // off | audit | enforce
    touchPoints: list(env.FUTURATOR_TOUCH_POINTS),
    forbiddenAreas: list(env.FUTURATOR_FORBIDDEN_AREAS),
  };
}

// fact-force memo: block a confirm-tier action ONCE per (session,tool,target), then allow the retry.
// ponytail: flat file under tmp, no TTL — add a 30-min sweep if a long session re-blocks legit retries.
function memoCleared(key, stateDir) {
  const dir = stateDir || join(tmpdir(), 'futurator-gate');
  const f = join(dir, `${key}.seen`);
  if (existsSync(f)) return true;
  try { mkdirSync(dir, { recursive: true }); writeFileSync(f, ''); } catch { /* best-effort */ }
  return false;
}

export function main(env = process.env) {
  // recursion guard + kill switch
  if (env.FUTURATOR_HOOKS_DISABLED === '1') return 0;
  try {
    const policy = loadPolicy(env);
    if (policy.mode === 'off') return 0;

    const raw = (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })();
    const payload = parseHookPayload(raw, env);
    const d = decide(payload, policy);

    if (d.decision === 'allow') return 0;
    if (d.decision === 'audit') { process.stderr.write(`[pretool-gate] audit: ${d.reason}\n`); return 0; }

    // block / fact-force
    const key = createHash('sha256').update(`${payload.sessionId}|${payload.toolName}|${targetFile(payload.toolName, payload.toolInput) || payload.toolInput.command || ''}`).digest('hex').slice(0, 16);
    const enforce = policy.mode === 'enforce';
    if (d.decision === 'fact-force' && memoCleared(key, env.FUTURATOR_GATE_STATE_DIR)) {
      process.stderr.write(`[pretool-gate] fact-force cleared: ${targetFile(payload.toolName, payload.toolInput) || 'cmd'}\n`);
      return 0;
    }
    process.stderr.write(`[pretool-gate] ${enforce ? 'BLOCK' : 'would-block'}: ${d.reason}\n`);
    return enforce ? 2 : 0; // audit mode never blocks — safe rollout
  } catch (err) {
    // FAIL-OPEN: a broken gate must never brick a run.
    process.stderr.write(`[pretool-gate] fail-open (${err?.message || err})\n`);
    return 0;
  }
}

// run only when invoked directly as the hook
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
