/**
 * system-graph-bootstrap.mjs — Story 7.2 (PRD §8 P10). Bootstrap-on-first-build.
 *
 * A boilerplate repo wires ONE wave-gate hook (`runWaveGateGraph`). On the FIRST
 * build it runs a full-repo bootstrap — reusing the existing Slice-C scan
 * (`bootstrap-ast.mjs --scan`, which already seeds infra/route/service/ast +
 * api-calls; a forbidden area to change). On every SUBSEQUENT wave it runs the
 * incremental reusable step (Story 7.1, `runSystemGraphStep`). The result: every
 * new app is graph-ready from its first commit, with no per-repo code.
 *
 * "First build" is detected by the presence of the AST-facts envelope the
 * bootstrap writes (`<root>/.mycelium/ast-facts.json`) — absent ⇒ never
 * bootstrapped. Pure decision + injectable runner so it unit-tests without
 * spawning processes.
 */

import { existsSync as realExistsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runSystemGraphStep, defaultRun } from './system-graph-step.mjs';

/** 'bootstrap' on first build (no ast-facts marker yet) else 'incremental'. */
export function chooseGraphMode(input = {}, deps = {}) {
  const exists = deps.existsSync ?? realExistsSync;
  const myceliumDir = input.myceliumDir ?? (input.root ? join(input.root, '.mycelium') : null);
  if (!myceliumDir) return 'bootstrap';
  return exists(join(myceliumDir, 'ast-facts.json')) ? 'incremental' : 'bootstrap';
}

/**
 * The boilerplate wave-gate hook. Dispatches bootstrap vs incremental.
 *
 * @param {object} input - { root, project?, knowledgeDir?, app?, config?, lambda?, global?, waveGate?, sourceFiles? }
 * @param {{ run?:Function, existsSync?:Function, log?:Function, mode?:string, writeFile?:Function, mkdir?:Function }} deps
 */
export async function runWaveGateGraph(input = {}, deps = {}) {
  if (!input.root) throw new Error('runWaveGateGraph requires root');
  const run = deps.run ?? defaultRun;
  const log = deps.log ?? (() => {});
  const project = input.project ?? basename(input.root);
  const mode = deps.mode ?? chooseGraphMode(input, deps);

  if (mode === 'bootstrap') {
    log(`[system-graph] first build → full-repo bootstrap (bootstrap-ast --scan) for ${project}`);
    // bootstrap-ast.mjs IS the full-repo scan (it runs ast + infra/route/service
    // + api-calls then graph-sync). Reused as-is.
    await run('bootstrap-ast.mjs', ['--project', project, '--root', input.root]);
    return { mode, project, ran: 'bootstrap-ast' };
  }

  log(`[system-graph] incremental wave → reusable step for ${project}`);
  const result = await runSystemGraphStep({ ...input, project }, { ...deps, run });
  return { mode, project, ran: 'system-graph-step', result };
}
