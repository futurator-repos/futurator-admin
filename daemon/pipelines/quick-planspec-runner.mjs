// quick-planspec-runner — the "intent → Pipeline-3 plan" daemon job.
//
// Waits for the fresh app to finish scaffolding, spawns ONE Claude to turn the
// operator's intent into a plan_spec, then ingests the StoryNodes into
// plan-spec-graph. The ready-frontier (P3_READY_FRONTIER) then dispatches them —
// no epics/waves. All I/O is injected so it unit-tests without infra.

import { spawn as realSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractAssistantText } from '../lib/stream-json-text.mjs';
import { buildQuickPlanspecPrompt, parseQuickPlanspec, buildStoryNodeRows } from './lib/quick-planspec.mjs';

const BOOTSTRAP_SUCCESS = new Set(['COMPLETED', 'COMPLETED_VIA_SALVAGE', 'COMPLETED_VIA_PREWORK']);

/** Poll the app-bootstrap job until it succeeds (true) or fails/times out (false). */
async function waitForBootstrap({ getJob, jobId, timeoutMs = 6 * 60_000, pollMs = 4000, log, sleep }) {
  if (!jobId) return true; // no scaffold to wait on
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await getJob(jobId).catch(() => null);
    const status = j?.status;
    if (BOOTSTRAP_SUCCESS.has(status)) return true;
    if (status === 'FAILED' || status === 'ORPHANED') {
      log?.('warn', `[quick-planspec] app-bootstrap ${jobId.slice(0, 8)} → ${status}`);
      return false;
    }
    if (Date.now() > deadline) {
      log?.('warn', `[quick-planspec] app-bootstrap ${jobId.slice(0, 8)} timed out (last=${status || 'unknown'})`);
      return false;
    }
    await wait(pollMs);
  }
}

/** Spawn one Claude and return its full stream-json stdout. */
function spawnClaude({ spawn, claudeBin, cwd, prompt, eventLogDir, jobId, gateArgs = [], modelArgs = [], env = {}, log }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    ...modelArgs,
    ...gateArgs,
  ];
  try { if (eventLogDir && !existsSync(eventLogDir)) mkdirSync(eventLogDir, { recursive: true }); } catch { /* best-effort */ }
  const stdoutPath = eventLogDir ? join(eventLogDir, `${jobId}.quick-planspec.stdout.log`) : null;
  const outFile = stdoutPath ? createWriteStream(stdoutPath, { flags: 'a' }) : null;
  return new Promise((resolve) => {
    const child = spawn(claudeBin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); try { outFile?.write(c); } catch { /* ignore */ } });
    child.stderr.on('data', (c) => log?.('warn', `[quick-planspec:${jobId?.slice(0, 8)}:stderr] ${c.toString('utf8').trimEnd()}`));
    child.on('error', (err) => { log?.('error', `[quick-planspec] spawn error: ${err.message}`); resolve({ exitCode: -1, out }); });
    child.on('close', (code) => { try { outFile?.end(); } catch { /* ignore */ } resolve({ exitCode: code ?? 0, out }); });
  });
}

/**
 * Run a quick-planspec job end to end.
 *
 * @param {object} job   agent-jobs row: { jobId, workingDir, quickPlanspecPayload:{planId,appId,intent,appBootstrapJobId} }
 * @param {object} deps  { spawn, claudeBin, eventLogDir, gateArgs, env, getJob, batchPutStoryNodes,
 *                         updateJobFields, writeAttentionItem, log, now, sleep }
 * @returns {Promise<{ ok:boolean, summary?:object, reason?:string }>}
 */
export async function runQuickPlanspecJob(job, deps) {
  const {
    spawn = realSpawn, claudeBin = 'claude', eventLogDir, gateArgs, env,
    getJob, batchPutStoryNodes, updateJobFields, writeAttentionItem, log = () => {}, now, sleep,
  } = deps;
  const p = job.quickPlanspecPayload || {};
  const { planId, appId, intent, appBootstrapJobId, seamHook } = p;
  const short = String(job.jobId || '').slice(0, 8);

  const fail = async (reason) => {
    log('error', `[quick-planspec ${short}] ${reason}`);
    try {
      await writeAttentionItem?.({ planId, dedupKey: `quick-planspec:${planId}`, severity: 'high',
        category: 'quick-planspec-failed', title: `Quick plan generation failed`, body: reason,
        context: { jobId: job.jobId, planId, appId } });
    } catch { /* best-effort */ }
    try { await updateJobFields?.(job.jobId, { status: 'FAILED', errorMessage: reason.slice(0, 300) }); } catch { /* best-effort */ }
    return { ok: false, reason };
  };

  if (!planId || !appId || !intent) return fail('missing planId/appId/intent on quickPlanspecPayload');
  try { await updateJobFields?.(job.jobId, { status: 'RUNNING' }); } catch { /* best-effort */ }

  // 1) wait for the fresh app to finish scaffolding (stories need the repo).
  const ready = await waitForBootstrap({ getJob, jobId: appBootstrapJobId, log, sleep });
  if (!ready) return fail('app scaffold did not complete (bootstrap failed or timed out)');

  // 2) one Claude call: intent → plan_spec.
  const prompt = buildQuickPlanspecPrompt({ intent, appSlug: appId, seamHook });
  // The PLANNER gets the strongest default thinking (model-effort-policy): a
  // bad plan poisons every downstream story. Adaptive thinking + effort=high.
  const { resolveAgentPolicy, cliModelArgs } = await import('../lib/model-effort-policy.mjs');
  const modelArgs = cliModelArgs(resolveAgentPolicy({ role: 'planner' }));
  const { exitCode, out } = await spawnClaude({ spawn, claudeBin, cwd: job.workingDir, prompt, eventLogDir, jobId: job.jobId, gateArgs, modelArgs, env, log });
  if (exitCode !== 0 && !out) return fail(`generation spawn exited ${exitCode} with no output`);

  // 3) parse → StoryNodes.
  const text = extractAssistantText(out) || out;
  const { stories, errors } = parseQuickPlanspec(text);
  if (errors.length || !stories.length) return fail(`could not parse a plan_spec: ${errors.join('; ') || 'no stories'}`);

  // 4) build rows + ingest → plan-spec-graph. Frontier dispatches from here.
  const { rows, summary } = buildStoryNodeRows({ stories, planId, appId, now });
  try {
    await batchPutStoryNodes(rows);
  } catch (e) {
    return fail(`ingest write failed: ${e?.message || e}`);
  }

  try { await updateJobFields?.(job.jobId, { status: 'COMPLETED' }); } catch { /* best-effort */ }
  log('info', `[quick-planspec ${short}] ingested ${summary.stories} stories → batches 0..${summary.maxBatch} (${summary.ready} ready)`);
  return { ok: true, summary };
}
