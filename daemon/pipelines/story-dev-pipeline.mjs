// story-dev-pipeline — run ONE Claude for ONE story (development-plan §4 Dev stage).
//
// The Pipeline-3 execution unit: a single agent scoped to the story's `touches`,
// under the live gate, lazy-injected, model-routed — NOT an orchestrator managing
// waves. Because it's one story per spawn, the gate gets real PER-STORY scope
// (touchPoints = the story's touches, forbiddenAreas = its dev contract), the
// precision the plan otherwise deferred to a worktree policy file.
//
// On exit it computes the deterministic completion verdict (bound-AC gate) and
// updates the StoryNode lifecycle. Spawn + ddb are injected so the orchestration
// unit-tests without infrastructure.

import { spawn as realSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerChild, unregisterChild } from './lib/child-tracker.mjs';
import { freezeFlagsOntoJob } from '../lib/pipeline-flags.mjs';
import { buildGateSpawn } from '../lib/gate-settings.mjs';
import { buildSubagentInjectionArgs } from '../lib/subagent-start.mjs';
import { handleStoryCompletion } from '../lib/story-completion-handler.mjs';
import { integrateStory } from '../lib/story-integrate.mjs';
import { planBranchName } from '../lib/plan-branch.mjs';

/** Build the single-story dev prompt. PURE. Requires the agent to emit <BINDING>. */
export function buildStoryDevPrompt(payload) {
  const acLines = (payload.acceptanceCriteria || [])
    .map((ac, i) => `  ${i + 1}. [${ac.id}] ${ac.text}${ac.acClass ? ` (${ac.acClass})` : ''}`)
    .join('\n');
  return [
    `You are implementing ONE story in an automated spec-driven pipeline.`,
    ``,
    `# Story: ${payload.title}`,
    payload.intent ? `Intent: ${payload.intent}` : '',
    ``,
    `# Acceptance criteria (the spec — implement the minimum that makes these pass)`,
    acLines,
    ``,
    `# Scope`,
    `You may ONLY create/modify files matching: ${(payload.touches || []).join(', ')}`,
    `You may NOT touch: ${(payload.forbiddenAreas || []).join(', ') || '(none beyond the defaults)'}`,
    `A live gate enforces this — out-of-scope writes are blocked.`,
    ``,
    `# Required: bind each AC to a test`,
    `When done, emit a manifest mapping each acceptance-criterion id to the test that verifies it:`,
    `<BINDING>`,
    `{ ${(payload.acceptanceCriteria || []).map((ac) => `"${ac.id}": { "testRef": "<test selector>", "testKind": "unit|integration|browser|manual" }`).join(', ')} }`,
    `</BINDING>`,
  ].filter((l) => l !== '').join('\n');
}

function ensureDir(d) { try { if (!existsSync(d)) mkdirSync(d, { recursive: true }); } catch { /* best-effort */ } }

/**
 * Run a story-dev job end to end.
 *
 * @param {{ job: object, eventLogDir: string, deps?: object }} opts
 *   deps: { spawn, ddb, graphTable, executors, headSha, logger, now,
 *           updateStoryState, propagateCompletion }
 * @returns {Promise<{ exitCode:number, verdict?:object, newState?:string }>}
 */
export async function runStoryDevJob({ job, eventLogDir, deps = {} }) {
  const spawn = deps.spawn || realSpawn;
  const logger = deps.logger || console;
  const claudeBin = deps.claudeBin || 'claude';
  const payload = job.storyDevPayload;
  if (!payload) throw new Error('runStoryDevJob: job.storyDevPayload required');
  const projectRoot = resolve(job.workingDir);

  const p3Flags = freezeFlagsOntoJob(job, { env: process.env });
  const gate = buildGateSpawn({
    jobId: job.jobId,
    p3Flags,
    // PER-STORY scope — one story per spawn, so the gate enforces exactly this
    // story's touches + forbidden set (no coarse fallback needed here).
    touchPoints: payload.touches || [],
    forbiddenAreas: payload.forbiddenAreas || [],
    ledgerPath: join(projectRoot, '.pipeline', 'gate-events.jsonl'),
    ceilingUsd: payload.costCeilingUsd ?? job.costCeilingUsd,
    harnessCostDir: join(projectRoot, '.pipeline', 'harness-cost'),
    haltDir: projectRoot,
    observeLog: join(projectRoot, '.pipeline', 'observations.jsonl'),
    agentRole: 'story-dev',
  });
  const injectionArgs = buildSubagentInjectionArgs({ p3Flags });

  const prompt = buildStoryDevPrompt(payload);
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    ...gate.args,
    ...injectionArgs,
  ];

  ensureDir(eventLogDir);
  const stdoutPath = join(eventLogDir, `${job.jobId}.story-dev.stdout.log`);

  logger.info?.(`[story-dev] spawning story=${payload.storyId} touches=[${(payload.touches || []).join(', ')}]` +
    (gate.env.FUTURATOR_GATE_MODE ? ` gate=${gate.env.FUTURATOR_GATE_MODE}` : ''));

  const child = spawn(claudeBin, args, {
    cwd: projectRoot,
    env: { ...process.env, ...gate.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  registerChild(job.jobId, child);

  let output = '';
  const outFile = createWriteStream(stdoutPath, { flags: 'a' });
  child.stdout.on('data', (c) => { output += c.toString('utf8'); try { outFile.write(c); } catch { /* ignore */ } });
  child.stderr.on('data', (c) => logger.warn?.(`[story-dev:${job.jobId}:stderr] ${c.toString('utf8').trimEnd()}`));

  const exitCode = await new Promise((res) => {
    child.on('error', (err) => { unregisterChild(job.jobId, child); logger.error?.(`[story-dev] spawn error: ${err.message}`); res(-1); });
    child.on('close', (code) => { unregisterChild(job.jobId, child); outFile.end(); res(code ?? 0); });
  });

  if (exitCode !== 0) {
    await deps.updateStoryState?.({ storyId: payload.storyId, state: 'failed', reason: `dev exit ${exitCode}` });
    return { exitCode, newState: 'failed' };
  }

  // ── Integrate (development-plan §4.1): commit THIS story's files to the plan
  // branch under the commit lock. No branch, no merge. The commit SHA is what
  // the bound-AC tests bind against (staleness guard). Skipped when no git
  // helper is injected (unit tests) — then we fall back to deps.headSha.
  let headSha = deps.headSha || '';
  if (deps.git) {
    const integ = await integrateStory({
      repoDir: projectRoot,
      touches: payload.touches || [],
      storyId: payload.storyId,
      title: payload.title,
      // Per-PLAN branch (development-plan §4.1); slug if available, else planId.
      planBranch: planBranchName(payload.planSlug || payload.planId),
      git: deps.git,
    });
    if (integ.committed && integ.sha) headSha = integ.sha;
    else if (!integ.committed) logger.warn?.(`[story-dev] ${payload.storyId} integrate: ${integ.reason}`);
  }

  // Deterministic completion verdict (bound-AC gate), bound to the committed SHA.
  const completion = await handleStoryCompletion({
    storyNode: { storyId: payload.storyId, acceptanceCriteria: payload.acceptanceCriteria },
    devOutput: output,
    headSha,
    executors: deps.executors || {},
    now: deps.now,
  });

  await deps.updateStoryState?.({ storyId: payload.storyId, state: completion.newState, verdict: completion.verdict });
  if (completion.propagate) {
    await deps.propagateCompletion?.({ completedStoryId: payload.storyId });
  }

  return { exitCode, verdict: completion.verdict, newState: completion.newState };
}
