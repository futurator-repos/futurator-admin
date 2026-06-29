// gate-settings — builds the per-spawn Claude Code settings.json + env that wire
// the live pretool-gate into a dev orchestrator spawn (development-plan §5.4).
//
// One call site in epic-dev-pipeline.mjs: given the job's resolved P3 flags and
// its coarse scope, this returns `{ settingsPath, args, env }` to splice into the
// spawn. When P3_GATE_MODE is off/absent it returns a no-op ({} env, [] args) so
// the legacy path is byte-for-byte unchanged.
//
// Settings live OUTSIDE the worktree (under /tmp), mirroring party-turn's choice,
// so a stray `git add -A` in a checkpoint can't sweep them into a commit.

import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagMode } from './pipeline-flags.mjs';

/** Absolute path to a hook script. Guarded for non-file test URLs. */
function resolveHookPath(relFromLib) {
  try {
    return fileURLToPath(new URL(relFromLib, import.meta.url));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), relFromLib);
  }
}

/** Absolute path to the gate hook script. */
export function resolveGateHookPath() {
  return resolveHookPath('./pretool-gate.mjs');
}

/**
 * @param {{
 *   jobId: string,
 *   p3Flags?: Record<string,string>,
 *   touchPoints?: string[],
 *   forbiddenAreas?: string[],
 *   ledgerPath?: string,    // e.g. <workingDir>/.pipeline/gate-events.jsonl
 *   settingsDir?: string,   // override for tests
 * }} opts
 * @returns {{ settingsPath: string|null, args: string[], env: Record<string,string> }}
 */
export function buildGateSpawn(opts = {}) {
  const gateMode = flagMode(opts.p3Flags, 'P3_GATE_MODE'); // off | audit | enforce
  const costMode = flagMode(opts.p3Flags, 'P3_COST_CEILING'); // off | observe | enforce
  const gateOn = gateMode && gateMode !== 'off';
  const costOn = costMode && costMode !== 'off';
  if (!gateOn && !costOn) return { settingsPath: null, args: [], env: {} };

  // One settings.json carries every dev-spawn hook concern so a single --settings
  // flag covers PreToolUse (gate) + statusLine + PostToolUse (cost ceiling).
  const hooks = {};
  const env = {};

  if (gateOn) {
    hooks.PreToolUse = [
      {
        matcher: 'Edit|Write|MultiEdit|Bash',
        hooks: [{ type: 'command', command: `node ${JSON.stringify(resolveGateHookPath())}` }],
      },
    ];
    env.FUTURATOR_GATE_MODE = gateMode;
    env.FUTURATOR_TOUCH_POINTS = JSON.stringify(opts.touchPoints || []);
    env.FUTURATOR_FORBIDDEN_AREAS = JSON.stringify(opts.forbiddenAreas || []);
    if (opts.ledgerPath) env.FUTURATOR_GATE_LEDGER = opts.ledgerPath;
  }

  if (costOn) {
    // statusLine on EVERY process writes its authoritative spend; PostToolUse
    // reconciles + enforces the mid-turn ceiling (development-plan §5.4).
    hooks.statusLine = { type: 'command', command: `node ${JSON.stringify(resolveHookPath('../hooks/statusline-cost.mjs'))}` };
    hooks.PostToolUse = [
      {
        matcher: 'Edit|Write|MultiEdit|Bash',
        hooks: [{ type: 'command', command: `node ${JSON.stringify(resolveHookPath('../hooks/posttool-ceiling.mjs'))}` }],
      },
    ];
    env.FUTURATOR_COST_CEILING = costMode;
    if (opts.ceilingUsd != null) env.FUTURATOR_COST_CEILING_USD = String(opts.ceilingUsd);
    if (opts.harnessCostDir) env.FUTURATOR_HARNESS_COST_DIR = opts.harnessCostDir;
    if (opts.haltDir) env.FUTURATOR_HALT_DIR = opts.haltDir;
  }

  const dir = opts.settingsDir || tmpdir();
  const settingsPath = join(dir, `futurator-gate-settings-${String(opts.jobId || 'job').slice(0, 24)}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  } catch {
    // If we can't write settings, don't half-wire — fall back to legacy.
    return { settingsPath: null, args: [], env: {} };
  }

  return { settingsPath, args: ['--settings', settingsPath], env };
}
