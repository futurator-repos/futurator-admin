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

  const args = [
    '--model', payload.orchestratorModel,
    '--print',
    '--permission-mode', 'acceptEdits',
  ];

  logger.info?.(
    `[epic-dev-pipeline] spawning orchestrator job=${job.jobId} epic=${job.epicId} ` +
      `model=${payload.orchestratorModel} stories=${payload.stories.length}`,
  );

  const startedAt = now();

  const child = spawn(claudeBin, args, {
    cwd: projectRoot,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutFile = createWriteStream(stdoutPath, { flags: 'a' });
  const stderrFile = createWriteStream(stderrPath, { flags: 'a' });

  let stdoutBuffered = '';
  let stderrBuffered = '';

  teeStream({
    source: child.stdout,
    file: stdoutFile,
    sink: (chunk) => {
      stdoutBuffered += chunk;
      logger.info?.(`[orchestrator:${job.jobId}] ${chunk.trimEnd()}`);
    },
  });
  teeStream({
    source: child.stderr,
    file: stderrFile,
    sink: (chunk) => {
      stderrBuffered += chunk;
      logger.warn?.(`[orchestrator:${job.jobId}:stderr] ${chunk.trimEnd()}`);
    },
  });

  try {
    child.stdin?.write?.(prompt);
    child.stdin?.end?.();
  } catch {
    // fall through to close handler
  }

  const exitCode = await new Promise((resolvePromise) => {
    child.on('error', (err) => {
      logger.error?.(`[epic-dev-pipeline] spawn error: ${err.message}`);
      resolvePromise(-1);
    });
    child.on('close', async (code) => {
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
