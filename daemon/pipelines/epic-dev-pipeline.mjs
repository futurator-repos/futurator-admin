/**
 * Epic-dev pipeline entry point (Arch Doc §3; EO-4.2).
 *
 * Called by the daemon poll loop when a job's `phase === 'epic-dev'`.
 *
 * Responsibilities:
 *   1. Load rubric via mergeRubric (default + optional project overlay).
 *   2. Load context digest from the job payload.
 *   3. Render the orchestrator prompt template with all 11 variables.
 *   4. Write the rendered prompt + stdout/stderr logs under
 *      {eventLogDir}/{jobId}.orchestrator.{prompt,stdout,stderr}.log.
 *   5. Spawn the Claude CLI as the orchestrator process and stream
 *      stdout/stderr to both the caller's logger and the log files.
 *
 * The module exports both a library API (`runEpicDevPipeline`) used by
 * the daemon and pure helpers (`renderOrchestratorPrompt`,
 * `buildStoryTableRows`) that are unit-tested in isolation.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as realSpawn } from 'node:child_process';
import { mergeRubric } from './lib/rubric-merge.mjs';
import { registerChild, unregisterChild } from './lib/child-tracker.mjs';
import { assertSpawnAllowed, ShellGuardViolation } from './lib/shell-guard.mjs';
import { freezeFlagsOntoJob } from '../lib/pipeline-flags.mjs';
import { buildGateSpawn } from '../lib/gate-settings.mjs';
import { buildSubagentInjectionArgs } from '../lib/subagent-start.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ORCHESTRATOR_TEMPLATE_PATH = join(
  __dirname,
  'templates',
  'epic-orchestrator-prompt.md.tpl',
);

const REQUIRED_PAYLOAD_FIELDS = [
  'orchestratorModel',
  'maxParallel',
  'maxRemediationRounds',
  'epicGoal',
  'contextDigest',
  'rubric',
  'stories',
];

const REQUIRED_TEMPLATE_VARS = [
  'epicId',
  'projectId',
  'projectRoot',
  'jobId',
  'daemonPort',
  'contextDigest',
  'rubric',
  'storyTableRows',
  'storyManifestJson',
  'maxParallel',
  'maxRemediationRounds',
  'resumeFromWaveResults',
];

/**
 * Render the orchestrator prompt template. Returns { prompt, missingVars }
 * so callers can surface unresolved placeholders as warnings. An empty
 * missingVars array means every `{{var}}` substituted cleanly.
 */
export function renderOrchestratorPrompt(template, vars) {
  const missing = new Set();
  const prompt = template.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    if (name in vars && vars[name] !== undefined && vars[name] !== null) {
      return String(vars[name]);
    }
    missing.add(name);
    return `{{${name}}}`;
  });
  return { prompt, missingVars: Array.from(missing) };
}

/**
 * Render the `storyTableRows` markdown table body for the orchestrator
 * prompt. One row per story, pipe-separated, with trailing newlines.
 */
export function buildStoryTableRows(stories) {
  if (!Array.isArray(stories) || stories.length === 0) return '';
  return stories
    .map((s) => {
      const title = escapeTableCell(s.title || '');
      const tp = (s.touchPoints || []).join(', ');
      return `| ${s.storyId} | ${s.wave} | ${s.complexity} | ${s.reviewRigor} | ${title} | ${escapeTableCell(tp)} |`;
    })
    .join('\n');
}

function escapeTableCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('epic-dev-pipeline: payload is required');
  }
  const missing = REQUIRED_PAYLOAD_FIELDS.filter((k) => payload[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`epic-dev-pipeline: payload missing fields: ${missing.join(', ')}`);
  }
  if (!Array.isArray(payload.stories) || payload.stories.length === 0) {
    throw new Error('epic-dev-pipeline: payload.stories must be a non-empty array');
  }
  for (const s of payload.stories) {
    if (!s.storyId || !Array.isArray(s.touchPoints) || s.touchPoints.length === 0) {
      throw new Error(`epic-dev-pipeline: story ${s.storyId || '?'} missing storyId or touchPoints`);
    }
    if (!s.complexity || !s.reviewRigor) {
      throw new Error(
        `epic-dev-pipeline: story ${s.storyId} missing complexity/reviewRigor — run touch-point inference first`,
      );
    }
  }
}

function resolveRubric(payload, opts, logger) {
  const overridePath = opts.rubricDefaultPath;
  if (overridePath) {
    return mergeRubric(
      { defaultPath: overridePath, overlayPath: opts.rubricOverlayPath },
      { logger },
    );
  }
  if (typeof payload.rubric === 'string' && payload.rubric.length > 0) {
    return payload.rubric;
  }
  return '(no rubric provided)';
}

function ensureLogDir(dir) {
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function teeStream({ source, file, sink }) {
  if (!source) return;
  source.on('data', (chunk) => {
    if (file) {
      try {
        file.write(chunk);
      } catch {
        // never let write errors disturb the pipeline
      }
    }
    if (sink) {
      try {
        sink(chunk.toString('utf8'));
      } catch {
        // never let logger errors disturb the pipeline
      }
    }
  });
}

/**
 * @param {{
 *   job: object,
 *   eventLogDir: string,
 *   daemonPort?: number,
 *   claudeBin?: string,
 *   rubricDefaultPath?: string,
 *   rubricOverlayPath?: string,
 *   templatePath?: string,
 *   spawn?: typeof realSpawn,
 *   logger?: Console,
 *   now?: () => number,
 *   env?: Record<string, string>,
 * }} opts
 */
export async function runEpicDevPipeline(opts) {
  if (!opts?.job) throw new Error('runEpicDevPipeline: job is required');
  if (!opts?.eventLogDir) throw new Error('runEpicDevPipeline: eventLogDir is required');

  const {
    job,
    eventLogDir,
    daemonPort = 17631,
    claudeBin = 'claude',
    templatePath = ORCHESTRATOR_TEMPLATE_PATH,
    spawn = realSpawn,
    logger = console,
    now = () => Date.now(),
  } = opts;

  if (job.phase !== 'epic-dev') {
    throw new Error(`runEpicDevPipeline: job.phase must be 'epic-dev', got ${job.phase}`);
  }

  const payload = job.epicDevPayload;
  validatePayload(payload);

  if (!job.workingDir) throw new Error('runEpicDevPipeline: job.workingDir is required');
  const projectRoot = resolve(job.workingDir);

  const rubric = resolveRubric(payload, opts, logger);

  const storyTableRows = buildStoryTableRows(payload.stories);
  const storyManifestJson = JSON.stringify(payload.stories, null, 2);

  const resumeSerialized =
    job.resumeFromWaveResults && Object.keys(job.resumeFromWaveResults).length > 0
      ? JSON.stringify(job.resumeFromWaveResults, null, 2)
      : 'null';

  const vars = {
    epicId: job.epicId || '',
    projectId: job.projectId || '',
    projectRoot,
    jobId: job.jobId,
    daemonPort,
    contextDigest: payload.contextDigest,
    rubric,
    storyTableRows,
    storyManifestJson,
    maxParallel: payload.maxParallel,
    maxRemediationRounds: payload.maxRemediationRounds,
    resumeFromWaveResults: resumeSerialized,
  };

  const template = readFileSync(templatePath, 'utf8');
  const { prompt, missingVars } = renderOrchestratorPrompt(template, vars);

  const unresolved = missingVars.filter((v) => !REQUIRED_TEMPLATE_VARS.includes(v) || vars[v] === undefined);
  if (missingVars.length > 0) {
    logger.warn?.(
      `[epic-dev-pipeline] ${missingVars.length} template variable(s) unresolved: ${missingVars.join(', ')}`,
    );
  }
  if (unresolved.length > 0) {
    throw new Error(
      `epic-dev-pipeline: template variables unresolved: ${unresolved.join(', ')}`,
    );
  }

  ensureLogDir(eventLogDir);
  const promptPath = join(eventLogDir, `${job.jobId}.orchestrator.prompt.log`);
  const stdoutPath = join(eventLogDir, `${job.jobId}.orchestrator.stdout.log`);
  const stderrPath = join(eventLogDir, `${job.jobId}.orchestrator.stderr.log`);

  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(promptPath, prompt);
  } catch (err) {
    logger.warn?.(`[epic-dev-pipeline] failed to persist prompt log: ${err.message}`);
  }

  // ── Pipeline-3: live pretool-gate (development-plan §5.4) ──────────────────
  // Resolve the frozen P3 flag-set (claim-time normally; fallback here for
  // direct callers), then build the PreToolUse gate settings + env. When
  // P3_GATE_MODE is off/absent, buildGateSpawn returns no-ops and the spawn is
  // byte-for-byte the legacy path. The orchestrator's session settings cover its
  // subagents, so this reaches the agents that actually write code under
  // bypassPermissions. Phase-1 coarse: risk-tier + epic-level forbiddenAreas
  // live; per-story touchPoints stay at the post-diff backstop.
  const p3Flags = freezeFlagsOntoJob(job, { env: process.env });
  const gate = buildGateSpawn({
    jobId: job.jobId,
    p3Flags,
    touchPoints: [], // coarse at orchestrator scope (spans all stories)
    forbiddenAreas: Array.isArray(payload.forbiddenAreas) ? payload.forbiddenAreas : [],
    ledgerPath: join(projectRoot, '.pipeline', 'gate-events.jsonl'),
    // Cost ceiling (development-plan §5.4) — harness-cost dir scoped PER JOB so
    // reconcile never mixes concurrent jobs' sessions; halt sentinel under cwd.
    ceilingUsd: payload.costCeilingUsd ?? job.costCeilingUsd,
    // Per-workingDir (not per-job): all of a plan's jobs write here, deduped by
    // globally-unique sessionId, so the wave-budget reconcile sums the whole plan.
    harnessCostDir: join(projectRoot, '.pipeline', 'harness-cost'),
    haltDir: projectRoot,
    // Instinct-loop observation capture (observe-only; rides the gate audit).
    observeLog: join(projectRoot, '.pipeline', 'observations.jsonl'),
    agentRole: 'orchestrator',
  });

  // ── Pipeline-3: AC-aware laziness injection (development-plan §5.3) ─────────
  // The single-source SubagentStart seam; today it carries the laziness ruleset
  // (P3_LAZY_MODE), later instincts + a facts pack. [] when nothing is active.
  const injectionArgs = buildSubagentInjectionArgs({ p3Flags });

  const args = [
    '-p',
    '--model', payload.orchestratorModel,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    ...gate.args,
    ...injectionArgs,
  ];

  logger.info?.(
    `[epic-dev-pipeline] spawning orchestrator job=${job.jobId} epic=${job.epicId} ` +
      `model=${payload.orchestratorModel} stories=${payload.stories.length}` +
      (gate.env.FUTURATOR_GATE_MODE ? ` gate=${gate.env.FUTURATOR_GATE_MODE}` : ''),
  );

  const pushEvent = opts.pushEvent;
  const stepId = 'epic-dev';
  const agentId = 'orchestrator';

  if (pushEvent) {
    try {
      await pushEvent(job.jobId, stepId, agentId, 'step_start', {
        text: `Orchestrator starting — ${payload.stories.length} stories across ${new Set(payload.stories.map((s) => s.wave)).size} waves`,
      });
    } catch (err) {
      logger.warn?.(`[epic-dev-pipeline] failed to push step_start: ${err.message}`);
    }
  }

  const startedAt = now();

  try {
    assertSpawnAllowed(claudeBin, args, projectRoot);
  } catch (err) {
    if (err instanceof ShellGuardViolation) {
      logger.error?.(`[epic-dev-pipeline] shell-guard refused spawn: ${err.message}`);
      if (opts.onGuardViolation) {
        try {
          opts.onGuardViolation(job.jobId, err.details);
        } catch {
          // never let the violation hook throw
        }
      }
      throw err;
    }
    throw err;
  }

  const child = spawn(claudeBin, args, {
    cwd: projectRoot,
    env: { ...process.env, ...(opts.env || {}), ...gate.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(job.jobId, child);

  // Deliver the rendered prompt over stdin (claude -p reads the prompt from
  // stdin when no positional prompt is given). Keeps the large prompt out of
  // argv (shell-guard scans args) and matches the orchestrator's contract.
  try {
    child.stdin?.write?.(prompt);
    child.stdin?.end?.();
  } catch {
    // fall through to close handler
  }

  const stdoutFile = createWriteStream(stdoutPath, { flags: 'a' });
  const stderrFile = createWriteStream(stderrPath, { flags: 'a' });

  let stdoutBuffered = '';
  let stderrBuffered = '';
  let lineBuffer = '';
  let finalResult = null;

  const processEvent = async (event) => {
    if (!pushEvent) return;
    try {
      if (event.type === 'stream_event') {
        const delta = event.event?.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          await pushEvent(job.jobId, stepId, agentId, 'text_delta', { text: delta.text });
        }
      } else if (event.type === 'assistant') {
        const content = event.message?.content || [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            await pushEvent(job.jobId, stepId, agentId, 'tool_use', {
              toolName: block.name,
              toolInput: JSON.stringify(block.input).slice(0, 2000),
            });
          } else if (block.type === 'text' && block.text) {
            await pushEvent(job.jobId, stepId, agentId, 'text_delta', { text: block.text });
          }
        }
      } else if (event.type === 'tool_result') {
        const output =
          typeof event.output === 'string'
            ? event.output.slice(0, 2000)
            : JSON.stringify(event.output).slice(0, 2000);
        await pushEvent(job.jobId, stepId, agentId, 'tool_result', { toolOutput: output });
      } else if (event.type === 'result') {
        finalResult = event;
      }
    } catch (err) {
      logger.warn?.(`[epic-dev-pipeline] event push failed: ${err.message}`);
    }
  };

  child.stdout.on('data', async (chunk) => {
    const text = chunk.toString('utf8');
    stdoutBuffered += text;
    try {
      stdoutFile.write(chunk);
    } catch {
      // ignore log write errors
    }
    lineBuffer += text;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        await processEvent(event);
      } catch {
        logger.info?.(`[orchestrator:${job.jobId}] ${line.slice(0, 500)}`);
      }
    }
  });
  teeStream({
    source: child.stderr,
    file: stderrFile,
    sink: (chunk) => {
      stderrBuffered += chunk;
      logger.warn?.(`[orchestrator:${job.jobId}:stderr] ${chunk.trimEnd()}`);
    },
  });

  const exitCode = await new Promise((resolvePromise) => {
    child.on('error', (err) => {
      unregisterChild(job.jobId, child);
      logger.error?.(`[epic-dev-pipeline] spawn error: ${err.message}`);
      resolvePromise(-1);
    });
    child.on('close', async (code) => {
      unregisterChild(job.jobId, child);
      await Promise.all([
        new Promise((r) => stdoutFile.end(r)),
        new Promise((r) => stderrFile.end(r)),
      ]);
      resolvePromise(code ?? 0);
    });
  });

  const durationMs = now() - startedAt;
  logger.info?.(
    `[epic-dev-pipeline] orchestrator exited job=${job.jobId} code=${exitCode} duration=${durationMs}ms`,
  );

  if (pushEvent) {
    try {
      if (exitCode === 0) {
        const cost = finalResult?.total_cost_usd || 0;
        await pushEvent(job.jobId, stepId, agentId, 'step_complete', {
          cost,
          sessionId: finalResult?.session_id || '',
          durationMs,
          text: JSON.stringify({
            numTurns: finalResult?.num_turns || 0,
            durationMs,
          }),
        });
      } else {
        await pushEvent(job.jobId, stepId, agentId, 'step_error', {
          text: `Orchestrator exited with code ${exitCode}${stderrBuffered ? `: ${stderrBuffered.slice(0, 500)}` : ''}`,
        });
      }
    } catch (err) {
      logger.warn?.(`[epic-dev-pipeline] failed to push terminal event: ${err.message}`);
    }
  }

  return {
    exitCode,
    promptPath,
    stdoutPath,
    stderrPath,
    durationMs,
    stdout: stdoutBuffered,
    stderr: stderrBuffered,
    prompt,
  };
}
