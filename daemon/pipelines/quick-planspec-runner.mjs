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
import {
  buildQuickPlanspecPrompt,
  buildQuickPlanspecRepairPrompt,
  parseQuickPlanspec,
  buildStoryNodeRows,
} from './lib/quick-planspec.mjs';
import { buildPlanCritiquePrompt, parsePlanCritique, hasCritical } from './lib/plan-critique.mjs';

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

// I8 planner-stream wire (Wave N2): batches new assistant text into onText
// callbacks at most ~1 per intervalMs, capped at capChars per emit — the UI's
// live-stream pane doesn't need every keystroke, and hammering pushEvent per
// stream-json line would blow the events table's write budget. Fail-soft: the
// caller wraps onText in its own try/catch (see below), this never throws.
function makeTextThrottler({ onText, phase, intervalMs = 1500, capChars = 4000 }) {
  let buf = '';
  let timer = null;
  const flush = () => {
    if (!buf) return;
    const text = buf.length > capChars ? buf.slice(buf.length - capChars) : buf;
    buf = '';
    try { onText?.({ text, phase }); } catch { /* never fail the run */ }
  };
  return {
    push(chunk) {
      if (!chunk) return;
      buf += chunk;
      if (buf.length > capChars) buf = buf.slice(buf.length - capChars);
      if (!timer) timer = setTimeout(() => { timer = null; flush(); }, intervalMs);
    },
    finalFlush() {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    },
  };
}

/**
 * Spawn one Claude and return its full stream-json stdout.
 *
 * @param {object} opts
 * @param {(chunk:{text:string, phase?:string})=>void} [opts.onText]  optional
 *   injected callback for incremental assistant-text pieces (planner-stream
 *   wire). Throttled/batched — see makeTextThrottler. Never fails the spawn.
 * @param {string} [opts.phase]  the phase label to tag onText chunks with.
 */
function spawnClaude({ spawn, claudeBin, cwd, prompt, eventLogDir, jobId, gateArgs = [], modelArgs = [], env = {}, log, onText, phase }) {
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
  const throttler = typeof onText === 'function' ? makeTextThrottler({ onText, phase }) : null;
  let lastExtractedLen = 0;
  return new Promise((resolve) => {
    const child = spawn(claudeBin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      try { outFile?.write(c); } catch { /* ignore */ }
      if (throttler) {
        try {
          // Mirror the post-close fallback (`extractAssistantText(out) || out`,
          // step 3 below) so a fake/non-stream-json transcript in tests — or a
          // real transcript with no complete assistant blocks yet — still
          // streams something rather than emitting nothing until close.
          const full = extractAssistantText(out) || out;
          if (full.length > lastExtractedLen) {
            throttler.push(full.slice(lastExtractedLen));
            lastExtractedLen = full.length;
          }
        } catch { /* best-effort — never fail the spawn over a stream-parse hiccup */ }
      }
    });
    child.stderr.on('data', (c) => log?.('warn', `[quick-planspec:${jobId?.slice(0, 8)}:stderr] ${c.toString('utf8').trimEnd()}`));
    child.on('error', (err) => { throttler?.finalFlush(); log?.('error', `[quick-planspec] spawn error: ${err.message}`); resolve({ exitCode: -1, out }); });
    child.on('close', (code) => { try { outFile?.end(); } catch { /* ignore */ } throttler?.finalFlush(); resolve({ exitCode: code ?? 0, out }); });
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
    // NEW optional injected deps (redesign slice B). Both fail-soft: absent dep or a
    // throw only warns — they enrich the plan, they never gate it.
    updatePlanFields,   // (planId, fields) → persist the planner narrative/shape onto the plan row
    listRepoTestFiles,  // (workingDir) → committed test-file paths (brownfield test-law)
    onText,             // (chunk:{text,phase}) → live planner-stream event (I8). Fail-soft.
  } = deps;
  const p = job.quickPlanspecPayload || {};
  // `brownfield` (set by the API for grow-existing-app plans) switches the prompt to
  // the "existing tests are LAW" variant AND turns on prior-test immutability below.
  const { planId, appId, intent, appBootstrapJobId, seamHook, brownfield } = p;
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

  // Phase markers (U4 — PlanningView phase stepper). Best-effort: a write
  // failure here must never fail the run — the marker only enriches the UI's
  // "planner → parallelism-repair → critique → critique-repair → ingest"
  // stepper, it gates nothing.
  const markPhase = async (phase) => {
    try { await updateJobFields?.(job.jobId, { phase }); } catch { /* best-effort */ }
  };

  // 1) wait for the fresh app to finish scaffolding (stories need the repo).
  const ready = await waitForBootstrap({ getJob, jobId: appBootstrapJobId, log, sleep });
  if (!ready) return fail('app scaffold did not complete (bootstrap failed or timed out)');

  // 2) one Claude call: intent → plan_spec.
  await markPhase('planner');
  const prompt = buildQuickPlanspecPrompt({ intent, appSlug: appId, seamHook, brownfield });
  // The PLANNER gets the strongest default thinking (model-effort-policy): a
  // bad plan poisons every downstream story. Adaptive thinking + effort=high.
  const { resolveAgentPolicy, cliModelArgs } = await import('../lib/model-effort-policy.mjs');
  const modelArgs = cliModelArgs(resolveAgentPolicy({ role: 'planner' }));
  const { exitCode, out } = await spawnClaude({ spawn, claudeBin, cwd: job.workingDir, prompt, eventLogDir, jobId: job.jobId, gateArgs, modelArgs, env, log, onText, phase: 'planner' });
  if (exitCode !== 0 && !out) return fail(`generation spawn exited ${exitCode} with no output`);

  // 3) parse → StoryNodes (+ the parallelism audit).
  const text = extractAssistantText(out) || out;
  let parsed = parseQuickPlanspec(text);
  if (parsed.errors.length || !parsed.stories.length) {
    return fail(`could not parse a plan_spec: ${parsed.errors.join('; ') || 'no stories'}`);
  }

  // 3b) deterministic gate + ONE repair pass: a serial plan (linear chain /
  // god-files) wastes the whole frontier — ask the planner to re-decompose with
  // the audit findings. Keep whichever plan audits better; never fail the job here.
  if (parsed.audit.violations.length) {
    log('warn', `[quick-planspec ${short}] parallelism audit failed: ${parsed.audit.violations.join(' · ')} — running repair pass`);
    await markPhase('parallelism-repair');
    const repairPrompt = buildQuickPlanspecRepairPrompt({
      intent, appSlug: appId, seamHook, brownfield, stories: parsed.stories, violations: parsed.audit.violations,
    });
    const repair = await spawnClaude({
      spawn, claudeBin, cwd: job.workingDir, prompt: repairPrompt, eventLogDir,
      jobId: `${job.jobId}-repair`, gateArgs, modelArgs, env, log, onText, phase: 'parallelism-repair',
    });
    const reparsed = parseQuickPlanspec(extractAssistantText(repair.out) || repair.out);
    if (!reparsed.errors.length && reparsed.stories.length
        && reparsed.audit.violations.length < parsed.audit.violations.length) {
      log('info', `[quick-planspec ${short}] repair pass accepted (${reparsed.audit.violations.length} violation(s) left, was ${parsed.audit.violations.length})`);
      parsed = reparsed;
    } else {
      log('warn', `[quick-planspec ${short}] repair pass did not improve the plan — keeping the original`);
    }
  }
  // 3c) still serial after repair → ingest anyway (safety edges keep it correct)
  // but tell the operator loudly; never silently ship a serial plan.
  if (parsed.audit.violations.length) {
    try {
      await writeAttentionItem?.({ planId, dedupKey: `quick-planspec-serial:${planId}`, severity: 'medium',
        category: 'quick-planspec-serial-plan', title: 'Plan is serialized (parallelism audit failed)',
        body: parsed.audit.violations.join('\n'),
        context: { jobId: job.jobId, planId, appId, levels: parsed.audit.levels, maxWidth: parsed.audit.maxWidth, criticalPath: parsed.audit.criticalPath } });
    } catch { /* best-effort */ }
  }

  // 3d) adversarial plan-critique (P0 critique — redesign Part 2/Part 5 #8): ONE
  // cheap fresh-eyes spawn reads the plan the planner just wrote and looks for
  // dropped capabilities / gameable ACs / wrong planShape / missing seam wiring.
  // Never fails the job. A critical finding earns ONE bounded regeneration (keep
  // whichever plan is parseable + not worse); non-critical findings are written
  // up for the operator, not acted on automatically.
  let critiqueFindingCount = 0;
  try {
    await markPhase('critique');
    const criticPolicy = resolveAgentPolicy({ role: 'critic' }); // no DEFAULTS entry → falls back to reviewer (sonnet/low)
    const critiqueModelArgs = cliModelArgs(criticPolicy);
    const critiquePrompt = buildPlanCritiquePrompt({ intent, appSlug: appId, stories: parsed.stories, planShape: parsed.planShape });
    const critiqueRun = await spawnClaude({
      spawn, claudeBin, cwd: job.workingDir, prompt: critiquePrompt, eventLogDir,
      jobId: `${job.jobId}-critique`, gateArgs, modelArgs: critiqueModelArgs, env, log, onText, phase: 'critique',
    });
    const { findings } = parsePlanCritique(extractAssistantText(critiqueRun.out) || critiqueRun.out);
    critiqueFindingCount = findings.length;
    const critical = findings.filter((f) => f.severity === 'critical');
    const nonCritical = findings.filter((f) => f.severity !== 'critical');

    if (hasCritical(findings)) {
      log('warn', `[quick-planspec ${short}] plan-critique found ${critical.length} critical finding(s) — running one bounded regeneration`);
      await markPhase('critique-repair');
      const critiqueRepairPrompt = buildQuickPlanspecRepairPrompt({
        intent, appSlug: appId, seamHook, brownfield, stories: parsed.stories,
        violations: critical.map((f) => `critique(${f.kind}): ${f.message}${f.storyId ? ` [${f.storyId}]` : ''}`),
      });
      const critiqueRepair = await spawnClaude({
        spawn, claudeBin, cwd: job.workingDir, prompt: critiqueRepairPrompt, eventLogDir,
        jobId: `${job.jobId}-critique-repair`, gateArgs, modelArgs, env, log, onText, phase: 'critique-repair',
      });
      const reparsed = parseQuickPlanspec(extractAssistantText(critiqueRepair.out) || critiqueRepair.out);
      if (!reparsed.errors.length && reparsed.stories.length
          && reparsed.audit.violations.length <= parsed.audit.violations.length) {
        log('info', `[quick-planspec ${short}] critique repair pass accepted`);
        parsed = reparsed;
      } else {
        log('warn', `[quick-planspec ${short}] critique repair pass did not improve the plan — keeping the original`);
      }
    }

    if (nonCritical.length) {
      try {
        await writeAttentionItem?.({ planId, dedupKey: `quick-plan-critique:${planId}`, severity: 'low',
          category: 'quick-plan-critique', title: 'Plan-critique findings',
          body: nonCritical.map((f) => `[${f.severity}] (${f.kind}) ${f.message}${f.storyId ? ` — story ${f.storyId}` : ''}`).join('\n'),
          context: { jobId: job.jobId, planId, appId, count: nonCritical.length } });
      } catch { /* best-effort */ }
    }
  } catch (e) {
    log('warn', `[quick-planspec ${short}] plan-critique spawn failed (non-fatal): ${e?.message || e}`);
  }

  // 4) build rows + ingest → plan-spec-graph. Frontier dispatches from here.
  const { stories, audit, planShape, planShapeRationale } = parsed;
  const { rows, summary } = buildStoryNodeRows({ stories, planId, appId, now });

  // 4a) BROWNFIELD PRIOR-TEST IMMUTABILITY (redesign slice B / TDD test-law): a
  // growth plan must never be able to edit a test committed by an earlier plan —
  // that is exactly how a green suite silently rots across brownfield iterations
  // (pacman8: the implementer authored/relaxed its own tests). We union every
  // committed test-file path into EVERY story's forbiddenAreas; story-job-minter
  // already folds storyNode.forbiddenAreas into the live gate's deny scope, so the
  // implementer physically cannot touch a prior test. Fail-soft: absent dep or a
  // throw just warns and proceeds (greenfield plans never enter this branch).
  if (brownfield && typeof listRepoTestFiles === 'function') {
    try {
      const priorTests = await listRepoTestFiles(job.workingDir);
      if (priorTests?.length) {
        for (const row of rows) {
          row.forbiddenAreas = [...new Set([...(row.forbiddenAreas || []), ...priorTests])];
        }
        log('info', `[quick-planspec ${short}] brownfield: ${priorTests.length} prior test file(s) marked immutable (forbiddenAreas)`);
      }
    } catch (e) {
      log('warn', `[quick-planspec ${short}] listRepoTestFiles failed (non-fatal, proceeding): ${e?.message || e}`);
    }
  } else if (brownfield) {
    log('warn', `[quick-planspec ${short}] brownfield plan but no listRepoTestFiles dep — prior tests NOT locked`);
  }

  // 4b) Persist the planner's thinking onto the plan row for the operator's Plan
  // tab (redesign root-cause #5: the PLAN narrative was never persisted). Optional
  // injected dep — absent or a throw only warns; the plan is already parsed and is
  // about to ingest, so this must never fail the job.
  if (typeof updatePlanFields === 'function') {
    try {
      await updatePlanFields(planId, {
        planNarrative: parsed.planNarrative?.slice(0, 4000) || undefined,
        planShape,
        planShapeRationale: planShapeRationale || undefined,
      });
    } catch (e) {
      log('warn', `[quick-planspec ${short}] updatePlanFields failed (non-fatal): ${e?.message || e}`);
    }
  }

  await markPhase('ingest');
  try {
    await batchPutStoryNodes(rows);
  } catch (e) {
    return fail(`ingest write failed: ${e?.message || e}`);
  }

  try { await updateJobFields?.(job.jobId, { status: 'COMPLETED' }); } catch { /* best-effort */ }
  log('info', `[quick-planspec ${short}] ingested ${summary.stories} stories → batches 0..${summary.maxBatch} (${summary.ready} ready) · width ${audit.maxWidth} · path ${audit.criticalPath} · shape ${planShape || 'unknown'} · critique ${critiqueFindingCount} finding(s)`
    + (audit.safetyEdges ? ` · ${audit.safetyEdges} scope-safety edge(s)` : '')
    + (audit.modelAuthored ? ' · model-authored DAG' : ' · derived DAG'));
  return { ok: true, summary: { ...summary, maxWidth: audit.maxWidth, criticalPath: audit.criticalPath, violations: audit.violations, planShape, critiqueFindings: critiqueFindingCount } };
}
