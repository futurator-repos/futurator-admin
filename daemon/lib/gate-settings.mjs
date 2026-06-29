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

/** Absolute path to the gate hook script. Guarded for non-file test URLs. */
export function resolveGateHookPath() {
  try {
    return fileURLToPath(new URL('./pretool-gate.mjs', import.meta.url));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), 'pretool-gate.mjs');
  }
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
  const mode = flagMode(opts.p3Flags, 'P3_GATE_MODE'); // off | audit | enforce
  if (!mode || mode === 'off') return { settingsPath: null, args: [], env: {} };

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|Bash',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(resolveGateHookPath())}` }],
        },
      ],
    },
  };

  const dir = opts.settingsDir || tmpdir();
  const settingsPath = join(dir, `futurator-gate-settings-${String(opts.jobId || 'job').slice(0, 24)}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  } catch {
    // If we can't write settings, don't half-wire the gate — fall back to legacy.
    return { settingsPath: null, args: [], env: {} };
  }

  const env = {
    FUTURATOR_GATE_MODE: mode,
    FUTURATOR_TOUCH_POINTS: JSON.stringify(opts.touchPoints || []),
    FUTURATOR_FORBIDDEN_AREAS: JSON.stringify(opts.forbiddenAreas || []),
  };
  if (opts.ledgerPath) env.FUTURATOR_GATE_LEDGER = opts.ledgerPath;

  return { settingsPath, args: ['--settings', settingsPath], env };
}
