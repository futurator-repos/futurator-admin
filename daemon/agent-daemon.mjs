/**
 * Futurator Agent Orchestrator — Local Daemon (v2)
 *
 * Step-based pipeline executor. Supports N agents, variable extraction,
 * template substitution, session resume, and validation assertions.
 *
 * Usage:
 *   cp .env.example .env
 *   npm install
 *   npm start
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { spawn, execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { totalmem, freemem, loadavg } from 'os';
import { isCompileStep as _isCompileStep, COMPILE_STEP_IDS as _COMPILE_STEP_IDS } from './pipelines/compile-pipeline.mjs';
import {
  emitCompilationStarted,
  emitCompilationCompleted,
  emitCompilationFailed,
  writeCompilationLog,
  parseArticleCounts,
} from './pipelines/compile-events.mjs';
import { createNdjsonForwarder } from './forwarder/ndjson-forwarder.mjs';
import { createDdbEventStore } from './forwarder/ddb-event-store.mjs';
import { createDaemonReceiver } from './receiver/http-receiver.mjs';
import {
  selectHandler,
  validateEpicDevJob,
  JOB_HANDLER_EPIC_DEV,
} from './pipelines/job-router.mjs';
import { runEpicDevPipeline } from './pipelines/epic-dev-pipeline.mjs';
import {
  findStaleJobs,
  buildResumeJob,
  DEFAULT_STALE_MS,
} from './pipelines/stale-heartbeat.mjs';
import { randomUUID } from 'node:crypto';

// Resolve the full path to `claude` binary at startup
let CLAUDE_BIN = 'claude';
try {
  CLAUDE_BIN = execSync('which claude', { encoding: 'utf8' }).trim();
} catch {
  // Fallback: try common locations
  for (const p of ['/usr/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(p)) { CLAUDE_BIN = p; break; }
  }
}

// ── Config ──

const REGION = process.env.AWS_REGION || 'us-east-1';
const JOBS_TABLE = process.env.AGENT_JOBS_TABLE || 'futurator-agent-jobs';
const EVENTS_TABLE = process.env.AGENT_EVENTS_TABLE || 'futurator-agent-events';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const API_KEY_SSM_PARAM = process.env.ANTHROPIC_API_KEY_SSM_PARAM || '/futurator/daemon/anthropic-api-key';
const API_KEY_REFRESH_MS = parseInt(process.env.API_KEY_REFRESH_MS || String(2 * 60 * 1000), 10);
const AUTH_PROBE_INTERVAL_MS = parseInt(process.env.AUTH_PROBE_INTERVAL_MS || String(5 * 60 * 1000), 10);
const EVENT_LOG_DIR = process.env.FUTURATOR_EVENT_LOG_DIR || '/var/log/futurator/events';
const FORWARDER_POLL_MS = parseInt(process.env.FORWARDER_POLL_MS || '250', 10);
const DAEMON_RECEIVER_PORT = parseInt(process.env.FUTURATOR_DAEMON_PORT || '17631', 10);
const STALE_HEARTBEAT_MS = parseInt(process.env.STALE_HEARTBEAT_MS || String(DEFAULT_STALE_MS), 10);
const STALE_SCAN_INTERVAL_MS = parseInt(process.env.STALE_SCAN_INTERVAL_MS || '30000', 10);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({ region: REGION });

// ── Anthropic API key + auth health (Option E from ec2-auth-lifecycle-analysis.md) ──
// Daemon prefers an API key from SSM over the OAuth `.credentials.json` file, because
// the OAuth flow has no headless refresh path and expires every 12-24h. The API key
// never expires, so this is the fix for the "Not logged in" failures.
let apiKeyLoadedAt = 0;
let apiKeySource = 'none'; // 'ssm' | 'env' | 'oauth-fallback' | 'none'
const authState = {
  valid: null, // null until first probe
  checkedAt: null,
  error: null,
};

async function loadApiKeyFromSsm(reason = 'startup') {
  // Static env-provided key always wins (local dev, CI, opt-out).
  if (process.env.ANTHROPIC_API_KEY && apiKeySource !== 'ssm') {
    apiKeySource = 'env';
    apiKeyLoadedAt = Date.now();
    return;
  }
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: API_KEY_SSM_PARAM, WithDecryption: true }),
    );
    const value = Parameter?.Value?.trim();
    if (!value) throw new Error('SSM parameter is empty');
    process.env.ANTHROPIC_API_KEY = value;
    apiKeySource = 'ssm';
    apiKeyLoadedAt = Date.now();
    log('info', `Anthropic API key loaded from SSM (${reason})`, { param: API_KEY_SSM_PARAM });
  } catch (err) {
    // Fall back to whatever OAuth credentials.json provides — don't fail hard.
    if (apiKeySource === 'none') apiKeySource = 'oauth-fallback';
    log('warn', `Could not read API key from SSM (${reason}); falling back to OAuth`, {
      param: API_KEY_SSM_PARAM,
      err: err.message,
    });
  }
}

function probeAuth() {
  return new Promise((resolve) => {
    const args = ['-p', 'ok', '--model', 'haiku', '--output-format', 'json'];
    const proc = spawn(process.execPath, [CLAUDE_BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 20000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', (err) => {
      authState.valid = false;
      authState.error = `probe spawn failed: ${err.message}`;
      authState.checkedAt = new Date().toISOString();
      resolve();
    });
    proc.on('close', (code) => {
      const combined = stderr + stdout;
      const authFailed = isAuthFailureOutput(combined) || (code !== 0 && /login|auth/i.test(combined));
      authState.valid = !authFailed && code === 0;
      authState.error = authState.valid ? null : (stderr.trim() || `exit ${code}`).slice(0, 200);
      authState.checkedAt = new Date().toISOString();
      log(authState.valid ? 'info' : 'warn', `Auth probe: ${authState.valid ? 'OK' : 'FAIL'}`, {
        source: apiKeySource,
        err: authState.error,
      });
      resolve();
    });
  });
}

function isAuthFailureOutput(text) {
  if (!text) return false;
  return /401|authentication_error|unauthenticated|Failed to authenticate|Not logged in|Please run \/login|Invalid[- ]?(api[- ]?key|bearer)/i.test(
    text,
  );
}

const jobEventSeqs = new Map(); // jobId -> last seq number
const activeJobs = new Map(); // jobId -> { startedAt, workingDir, stepId, agentId, pid, model }
// t2.micro has 1.8GB RAM; each Claude process uses ~150-300MB. 2 concurrent = safe.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
let shuttingDown = false;
let ndjsonForwarder = null;
let daemonReceiver = null;

function log(level, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  const prefix = { info: '\x1b[36mINFO\x1b[0m', warn: '\x1b[33mWARN\x1b[0m', error: '\x1b[31mERROR\x1b[0m', debug: '\x1b[90mDEBG\x1b[0m' };
  console.log(`[${entry.ts}] ${prefix[level] || level} ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

// ── Push event to DynamoDB ──

async function pushEvent(jobId, stepId, agentId, eventType, data = {}) {
  const current = (jobEventSeqs.get(jobId) || 0) + 1;
  jobEventSeqs.set(jobId, current);
  const seq = String(current).padStart(6, '0');
  try {
    await ddb.send(
      new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          jobId,
          eventSeq: seq,
          seq: current,
          timestamp: new Date().toISOString(),
          stepId,
          agentId,
          eventType,
          ...data,
          expireAt: Math.floor(Date.now() / 1000) + 7 * 86400,
        },
      }),
    );
  } catch (err) {
    log('error', `Failed to push event ${eventType}`, { jobId, seq, err: err.message });
  }
}

// ── Template substitution: replace {{VAR}} with values from variables store ──

function substituteTemplate(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    if (varName in variables) {
      log('debug', `Template substitution: {{${varName}}} → ${variables[varName].length} chars`);
      return variables[varName];
    }
    log('warn', `Template variable {{${varName}}} not found in store, leaving as-is`);
    return match;
  });
}

// ── Extract variables from agent output ──

function runExtractors(text, extractors) {
  const extracted = {};

  for (const [varName, config] of Object.entries(extractors)) {
    let value = null;

    if (config.type === 'regex' && config.pattern) {
      try {
        const re = new RegExp(config.pattern, 's');
        const match = re.exec(text);
        if (match) {
          value = match[1] || match[0]; // prefer capture group 1
        }
      } catch (err) {
        log('error', `Invalid regex for ${varName}: ${config.pattern}`, { err: err.message });
      }
    } else if (config.type === 'between' && config.startDelimiter && config.endDelimiter) {
      const startIdx = text.indexOf(config.startDelimiter);
      const endIdx = text.indexOf(config.endDelimiter, startIdx);
      if (startIdx !== -1 && endIdx !== -1) {
        value = text.slice(startIdx, endIdx + config.endDelimiter.length);
      }
    }

    if (value !== null) {
      extracted[varName] = value;
      log('info', `Extracted ${varName} (${config.type}): ${value.length} chars`, {
        preview: value.slice(0, 80),
      });
    } else {
      log('warn', `Extractor ${varName} (${config.type}) found nothing`);
    }
  }

  return extracted;
}

// ── Run validations ──

function runValidations(validations, variables) {
  const results = [];

  for (const v of validations) {
    const leftVal = variables[v.left] ?? v.left;
    const rightVal = variables[v.right] ?? v.right;
    let passed = false;
    let details = '';

    switch (v.type) {
      case 'equals':
        passed = leftVal === rightVal;
        details = passed
          ? `"${leftVal.slice(0, 40)}" == "${rightVal.slice(0, 40)}"`
          : `"${leftVal.slice(0, 40)}" != "${rightVal.slice(0, 40)}"`;
        break;
      case 'contains':
        passed = leftVal.includes(rightVal);
        details = passed
          ? `"${v.left}" contains "${v.right}"`
          : `"${v.left}" does NOT contain "${v.right}"`;
        break;
      case 'not_contains':
        passed = !leftVal.includes(rightVal);
        details = passed
          ? `"${v.left}" correctly does NOT contain "${v.right}"`
          : `LEAKED: "${v.right}" found inside "${v.left}"`;
        break;
    }

    const icon = passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    log('info', `Validation [${icon}] ${v.label}: ${details}`);
    results.push({ label: v.label, passed, details });
  }

  return results;
}

// ── Run a single Claude CLI agent ──

function runAgent(jobId, stepId, agentId, prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.allowedTools) args.push('--allowedTools', opts.allowedTools);
    if (opts.disallowedTools) args.push('--disallowedTools', opts.disallowedTools);
    if (opts.model) args.push('--model', opts.model);

    log('info', `Spawning claude for step ${stepId} (agent ${agentId})`, {
      resume: opts.resume || 'none',
      model: opts.model || 'default',
      promptLen: prompt.length,
    });

    pushEvent(jobId, stepId, agentId, 'step_start', {
      text: `Step ${stepId}: Agent ${agentId} starting...`,
    });

    // Auto-create working directory if it doesn't exist
    const cwd = opts.workingDir || process.env.HOME;
    if (opts.workingDir && !existsSync(opts.workingDir)) {
      try {
        mkdirSync(opts.workingDir, { recursive: true });
        log('info', `Created working directory: ${opts.workingDir}`);
      } catch (err) {
        log('error', `Failed to create working directory: ${err.message}`);
      }
    }

    // Use node directly to execute claude's cli.js — avoids shell interpretation
    // issues AND works on Linux where spawn without shell can't handle shebangs
    const proc = spawn(process.execPath, [CLAUDE_BIN, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    // Track PID and model in heartbeat
    const entry = activeJobs.get(jobId);
    if (entry) { entry.pid = proc.pid; entry.model = opts.model || 'default'; }

    let buffer = '';
    let finalResult = null;
    let stderrBuffer = '';

    // Handle spawn failures (ENOENT, permissions, etc.)
    proc.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? `Claude CLI not found at ${CLAUDE_BIN}. Is it installed?`
        : `Failed to spawn claude: ${err.message}`;
      log('error', msg);
      pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
      reject(new Error(msg));
    });

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processStreamEvent(jobId, stepId, agentId, event);
          if (event.type === 'result') finalResult = event;
        } catch {
          // Non-JSON line
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        stderrBuffer += text + '\n';
        log('debug', `stderr [${stepId}]: ${text}`);
      }
    });

    proc.on('close', (code) => {
      // Check for auth errors in stderr or stdout — also catch the silent-failure
      // pattern where Claude CLI exits 0 with $0 cost and empty output (seen when
      // the OAuth token is expired but stream-json mode swallowed the error).
      const allOutput = stderrBuffer + (finalResult?.result || '');
      const isAuthError = isAuthFailureOutput(allOutput);
      const silentZeroCost =
        code === 0 && finalResult && (finalResult.total_cost_usd || 0) === 0 && !finalResult.result?.trim();
      const isRateLimit = /429|rate.?limit/i.test(allOutput);

      if (isAuthError || silentZeroCost) {
        // Mark auth as invalid so the next heartbeat reflects reality immediately.
        authState.valid = false;
        authState.error = (silentZeroCost ? 'silent zero-cost failure' : allOutput.slice(0, 200)) || 'auth failure';
        authState.checkedAt = new Date().toISOString();
        const msg =
          apiKeySource === 'ssm'
            ? 'Claude credentials expired or invalid — update the API key in SSM parameter ' + API_KEY_SSM_PARAM + ' and no restart is needed.'
            : 'Claude credentials expired — re-authorize from EC2 settings (or provision an API key via SSM ' + API_KEY_SSM_PARAM + ').';
        log('error', msg);
        pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
        return reject(new Error(msg));
      }

      if (isRateLimit) {
        const msg = 'Claude Code rate limited (429). Too many concurrent requests. Retry in a moment.';
        log('warn', msg);
        pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
        return reject(new Error(msg));
      }

      if (code !== 0 && !finalResult) {
        const errorDetail = stderrBuffer.trim() || `Process exited with code ${code}`;
        log('error', `Step ${stepId} failed: ${errorDetail}`);
        pushEvent(jobId, stepId, agentId, 'step_error', {
          text: `Step failed (exit ${code}): ${errorDetail.slice(0, 500)}`,
        });
        return reject(new Error(`Step ${stepId} (agent ${agentId}) failed: ${errorDetail.slice(0, 200)}`));
      }

      // Check if result contains auth error in text_delta
      if (finalResult?.result && isAuthError) {
        const msg = 'Claude authentication expired during execution';
        pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
        return reject(new Error(msg));
      }

      // Extract model usage info
      const modelKey = finalResult?.modelUsage ? Object.keys(finalResult.modelUsage)[0] : null;
      const modelInfo = modelKey ? finalResult.modelUsage[modelKey] : {};
      const cost = finalResult?.total_cost_usd || 0;
      const inputTokens = modelInfo.inputTokens || finalResult?.usage?.input_tokens || 0;
      const outputTokens = modelInfo.outputTokens || finalResult?.usage?.output_tokens || 0;
      const cacheRead = modelInfo.cacheReadInputTokens || 0;
      const cacheCreation = modelInfo.cacheCreationInputTokens || 0;
      const contextWindow = modelInfo.contextWindow || 0;
      const totalTokens = inputTokens + outputTokens + cacheCreation;
      const contextPercent = contextWindow > 0 ? Math.round((totalTokens / contextWindow) * 100) : 0;

      log('info', `Step ${stepId} complete`, {
        cost: `$${cost.toFixed(4)}`,
        duration: finalResult?.duration_ms,
        session: finalResult?.session_id,
        model: modelKey || 'unknown',
        tokens: `${inputTokens}in + ${outputTokens}out + ${cacheCreation}cache = ${totalTokens} (${contextPercent}% of ${contextWindow})`,
        turns: finalResult?.num_turns,
      });

      pushEvent(jobId, stepId, agentId, 'step_complete', {
        cost,
        sessionId: finalResult?.session_id || '',
        durationMs: finalResult?.duration_ms || 0,
        text: JSON.stringify({
          model: modelKey || 'unknown',
          inputTokens,
          outputTokens,
          cacheCreation,
          cacheRead,
          contextWindow,
          contextPercent,
          numTurns: finalResult?.num_turns || 0,
        }),
      });

      resolve(finalResult);
    });
  });
}

// ── Process stream-json events ──

async function processStreamEvent(jobId, stepId, agentId, event) {
  switch (event.type) {
    case 'stream_event': {
      const delta = event.event?.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        await pushEvent(jobId, stepId, agentId, 'text_delta', { text: delta.text });
      }
      break;
    }
    case 'assistant': {
      const content = event.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          await pushEvent(jobId, stepId, agentId, 'tool_use', {
            toolName: block.name,
            toolInput: JSON.stringify(block.input).slice(0, 2000),
          });
        }
        if (block.type === 'text' && block.text) {
          await pushEvent(jobId, stepId, agentId, 'text_delta', { text: block.text });
        }
      }
      break;
    }
    case 'tool_result': {
      const output =
        typeof event.output === 'string'
          ? event.output.slice(0, 2000)
          : JSON.stringify(event.output).slice(0, 2000);
      await pushEvent(jobId, stepId, agentId, 'tool_result', { toolOutput: output });
      break;
    }
  }
}

// ── Update job fields helper ──

async function updateJobFields(jobId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);

  const names = {};
  const values = {};
  const expressions = [];

  for (const [key, value] of entries) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    expressions.push(`#${key} = :${key}`);
  }

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

// ── Write heartbeat so UI can show daemon status ──

const DAEMON_SOURCE = process.env.DAEMON_SOURCE || 'local';

async function writeHeartbeat() {
  try {
    const processes = [];
    for (const [jobId, info] of activeJobs) {
      processes.push({
        jobId: jobId.slice(0, 12),
        stepId: info.stepId,
        agentId: info.agentId,
        model: info.model,
        pid: info.pid,
        startedAt: info.startedAt,
        workingDir: (info.workingDir || '').split('/').pop() || '',
      });
    }

    const mem = { totalMem: totalmem(), freeMem: freemem(), loadAvg: loadavg() };

    await ddb.send(
      new PutCommand({
        TableName: JOBS_TABLE,
        Item: {
          jobId: 'DAEMON_HEARTBEAT',
          status: 'ALIVE',
          source: DAEMON_SOURCE,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          activeCount: activeJobs.size,
          maxConcurrent: MAX_CONCURRENT,
          processes,
          system: {
            totalMem: Math.round(mem.totalMem / 1024 / 1024),
            freeMem: Math.round(mem.freeMem / 1024 / 1024),
            loadAvg: mem.loadAvg.map((v) => Math.round(v * 100) / 100),
          },
          auth: {
            valid: authState.valid,
            checkedAt: authState.checkedAt,
            error: authState.error,
            source: apiKeySource,
            apiKeyLoadedAt: apiKeyLoadedAt ? new Date(apiKeyLoadedAt).toISOString() : null,
          },
        },
      }),
    );
  } catch {
    // Non-critical
  }
}

// ── Stale-heartbeat scan for crash-resume (EO-4.5) ──
// Query RUNNING epic-dev jobs, find ones whose lastHeartbeatAt is older
// than STALE_HEARTBEAT_MS, mark them STALE, and create a fresh PENDING
// job that carries the accumulated waveResults forward via
// resumeFromWaveResults. The poll loop will then pick the new job up
// and spawn a new orchestrator that skips completed waves.
let lastStaleScanAt = 0;

async function scanStaleEpicDevJobs() {
  try {
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: JOBS_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#s = :running',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':running': 'RUNNING' },
        Limit: 50,
      }),
    );

    if (!Items || Items.length === 0) return;

    const stale = findStaleJobs(Items, { now: Date.now(), staleMs: STALE_HEARTBEAT_MS });
    if (stale.length === 0) return;

    for (const job of stale) {
      // Skip jobs currently running on THIS daemon — they aren't actually
      // dead; their heartbeat is just behind because the pipeline module
      // doesn't tick updatedAt continuously.
      if (activeJobs.has(job.jobId)) continue;

      const newJobId = randomUUID();
      const nowIso = new Date().toISOString();
      const resumeJob = buildResumeJob(job, { newJobId, now: nowIso });

      log('warn', `Stale epic-dev job detected — resuming`, {
        staleJobId: job.jobId.slice(0, 8),
        newJobId: newJobId.slice(0, 8),
        waves: resumeJob.resumeFromWaveResults ? Object.keys(resumeJob.resumeFromWaveResults).length : 0,
      });

      try {
        await ddb.send(
          new PutCommand({
            TableName: JOBS_TABLE,
            Item: resumeJob,
          }),
        );
        await updateJobFields(job.jobId, {
          status: 'STALE',
          errorMessage: `Orchestrator heartbeat stale >${Math.round(STALE_HEARTBEAT_MS / 1000)}s — resumed as ${newJobId}`,
          resumedAsJobId: newJobId,
        });
      } catch (err) {
        log('error', `Failed to schedule resume for ${job.jobId.slice(0, 8)}: ${err.message}`);
      }
    }
  } catch (err) {
    log('error', `Stale scan failed: ${err.message}`);
  }
}

// ── Execute pipeline ──

// ── Execute a shell (non-agentic) step ──

async function executeShellStep(jobId, step, workingDir, variables) {
  const command = substituteTemplate(step.command, variables);
  const timeout = step.timeout || 30000;
  const expectCode = step.expectExitCode ?? 0;

  log('info', `\n${'='.repeat(60)}`);
  log('info', `STEP: ${step.id} (Shell command)`);
  log('info', `${'='.repeat(60)}`);
  log('debug', `Command: ${command}`);

  await pushEvent(jobId, step.id, '__shell__', 'step_start', {
    text: `Shell: ${command.slice(0, 120)}`,
  });

  const startMs = Date.now();

  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], {
      cwd: workingDir || process.env.HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', async (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      const passed = !killed && code === expectCode;

      if (step.captureAs) variables[step.captureAs] = stdout;
      if (step.captureStderrAs) variables[step.captureStderrAs] = stderr;

      const stepResult = {
        stepId: step.id,
        agentId: '__shell__',
        status: 'complete',
        cost: 0,
        durationMs,
        extractedVariables: {},
        validationResults: [{
          label: `exit code ${code}${killed ? ' (timeout)' : ''}`,
          passed,
          details: passed
            ? `Exited ${code} as expected`
            : `Expected ${expectCode}, got ${code}${killed ? ' (killed)' : ''}. stderr: ${stderr.slice(0, 300)}`,
        }],
      };

      await pushEvent(jobId, step.id, '__shell__', passed ? 'step_complete' : 'step_error', {
        text: passed
          ? `Shell passed (${durationMs}ms)`
          : `Shell FAILED: exit ${code}. ${stderr.slice(0, 300)}`,
        durationMs,
      });

      if (!passed && step.onFail?.injectAs) {
        variables[step.onFail.injectAs] = stderr || stdout;
      }

      resolve({ passed, stepResult });
    });

    proc.on('error', async (err) => {
      clearTimeout(timer);
      await pushEvent(jobId, step.id, '__shell__', 'step_error', {
        text: `Shell spawn failed: ${err.message}`,
      });
      resolve({
        passed: false,
        stepResult: {
          stepId: step.id,
          agentId: '__shell__',
          status: 'error',
          cost: 0,
          durationMs: Date.now() - startMs,
          errorMessage: err.message,
          extractedVariables: {},
          validationResults: [],
        },
      });
    });
  });
}

// ── Execute a single step (reusable for loops) ──

async function executeStep(jobId, step, agents, workingDir, variables, sessions, stepResults) {
  // Update activity tracker for heartbeat
  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.stepId = step.id;
    entry.agentId = step.stepType === 'shell' ? '__shell__' : (step.agentId || null);
  }

  // ── Branch on step type ──
  if (step.stepType === 'shell') {
    const { passed, stepResult } = await executeShellStep(jobId, step, workingDir, variables);
    stepResults.push(stepResult);
    await updateJobFields(jobId, { variables, sessions, stepResults });

    if (!passed && step.onFail?.action === 'fail') {
      throw new Error(`Shell step ${step.id} failed`);
    }

    return { allPassed: passed, stepResult };
  }

  // ── Agent step (existing logic) ──
  const agent = agents[step.agentId];
  if (!agent) {
    throw new Error(`Step ${step.id} references unknown agent "${step.agentId}"`);
  }

  log('info', `\n${'='.repeat(60)}`);
  log('info', `STEP: ${step.id} (Agent ${step.agentId} — ${agent.name})`);
  log('info', `${'='.repeat(60)}`);

  // 1. Template substitution
  const prompt = substituteTemplate(step.prompt, variables);
  log('debug', `Prompt after substitution: ${prompt.length} chars`);

  // 2. Resolve session resume
  const resumeSession = step.resumeFromStep ? sessions[step.resumeFromStep] : undefined;
  if (step.resumeFromStep) {
    if (resumeSession) {
      log('info', `Resuming session from step ${step.resumeFromStep}: ${resumeSession}`);
    } else {
      log('warn', `Step ${step.id} wants to resume from ${step.resumeFromStep} but no session found`);
    }
  }

  // 3. Run agent
  const result = await runAgent(jobId, step.id, step.agentId, prompt, {
    workingDir: workingDir || process.env.HOME,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    model: agent.model,
    resume: resumeSession,
  });

  const resultText = result?.result || '';
  const sessionId = result?.session_id || '';
  sessions[step.id] = sessionId;

  // Extract model info for the step result
  const modelKey = result?.modelUsage ? Object.keys(result.modelUsage)[0] : null;
  const modelInfo = modelKey ? result.modelUsage[modelKey] : {};

  const stepResult = {
    stepId: step.id,
    agentId: step.agentId,
    status: 'complete',
    sessionId,
    cost: result?.total_cost_usd || 0,
    durationMs: result?.duration_ms || 0,
    model: modelKey || undefined,
    inputTokens: modelInfo.inputTokens || result?.usage?.input_tokens || 0,
    outputTokens: modelInfo.outputTokens || result?.usage?.output_tokens || 0,
    contextWindow: modelInfo.contextWindow || 0,
    numTurns: result?.num_turns || 0,
    extractedVariables: {},
    validationResults: [],
  };

  // 4. Run extractors
  if (step.extractors && Object.keys(step.extractors).length > 0) {
    const extracted = runExtractors(resultText, step.extractors);
    stepResult.extractedVariables = extracted;

    for (const [varName, varValue] of Object.entries(extracted)) {
      variables[varName] = varValue;
      await pushEvent(jobId, step.id, step.agentId, 'extraction', {
        variableName: varName,
        variableValue: varValue.slice(0, 500),
        extractorType: step.extractors[varName].type,
      });
    }
  }

  // 5. Run validations
  let allPassed = true;
  if (step.validations && step.validations.length > 0) {
    const validationResults = runValidations(step.validations, variables);
    stepResult.validationResults = validationResults;

    for (const vr of validationResults) {
      await pushEvent(jobId, step.id, step.agentId, 'validation', {
        validationLabel: vr.label,
        validationPassed: vr.passed,
        validationDetails: vr.details,
      });
    }

    allPassed = validationResults.every((vr) => vr.passed);
    if (!allPassed) {
      log('warn', `Validation(s) failed in step ${step.id}`);
    }
  }

  stepResults.push(stepResult);

  await updateJobFields(jobId, { variables, sessions, stepResults });
  log('info', `Step ${step.id} done. Variables: [${Object.keys(variables).join(', ')}]`);

  return { allPassed, stepResult };
}

// ── Compile step identification (imported from compile-pipeline.mjs) ──
const isCompileStep = _isCompileStep;

async function executePipeline(job) {
  const { jobId, pipeline } = job;

  if (!pipeline || !pipeline.agents || !pipeline.steps) {
    throw new Error('Job has no valid pipeline definition (old format?)');
  }

  const { agents, steps } = pipeline;
  const maxIterations = pipeline.maxIterations || 1;
  const workingDir = job.workingDir;

  const variables = { ITERATION: '1', MAX_ITERATIONS: String(maxIterations), ...(pipeline.initialVariables || {}) };
  const sessions = {};
  const stepResults = [];

  // Compilation tracking metadata
  let compilationStatus = undefined; // 'success' | 'failed' | 'skipped' | undefined
  let compilationStartedAt = undefined;
  let compilationCompletedAt = undefined;

  // Collect steps that are loop-only targets (only run during loop retries, not in linear flow)
  const loopTargetIds = new Set(steps.filter((s) => s.loopTo).map((s) => s.loopTo));

  // Check if this pipeline has compile steps
  const hasCompileSteps = steps.some((s) => isCompileStep(s.id));

  log('info', `Pipeline starting: ${steps.length} steps, ${Object.keys(agents).length} agents, maxIterations: ${maxIterations}`);
  if (loopTargetIds.size > 0) {
    log('info', `Loop-only steps (skipped in linear flow): [${[...loopTargetIds].join(', ')}]`);
  }
  if (hasCompileSteps) {
    log('info', `COMPILE phase detected: steps will be non-blocking`);
  }

  await updateJobFields(jobId, { status: 'RUNNING', currentStepIndex: 0 });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Skip loop-only steps in normal linear flow — they only run during loop iterations
    if (loopTargetIds.has(step.id)) {
      log('info', `Skipping "${step.id}" (loop-only step, runs only during retry)`);
      continue;
    }

    await updateJobFields(jobId, { currentStepIndex: i });

    // ── Non-blocking COMPILE phase handling ──
    if (isCompileStep(step.id)) {
      // Record compilation start time on first compile step
      if (!compilationStartedAt) {
        const compilationCtx = {
          jobId,
          storyId: variables.STORY_ID || 'unknown',
          epicId: variables.EPIC_ID || 'unknown',
          projectId: variables.PROJECT_ID || 'unknown',
          workingDir,
        };
        compilationStartedAt = await emitCompilationStarted(pushEvent, jobId, compilationCtx) || new Date().toISOString();
      }

      try {
        const { allPassed } = await executeStep(jobId, step, agents, workingDir, variables, sessions, stepResults);

        if (!allPassed) {
          throw new Error(`Compile step ${step.id} did not pass`);
        }

        // If this is the last compile step and we got here, compilation succeeded
        if (step.id === 'compile-sync') {
          compilationStatus = 'success';
          compilationCompletedAt = new Date().toISOString();
          const durationMs = new Date(compilationCompletedAt) - new Date(compilationStartedAt);

          // Parse article counts from the compiler agent's output
          const articleCounts = parseArticleCounts(variables.COMPILE_RESULT || '');

          const compilationCtx = {
            jobId,
            storyId: variables.STORY_ID || 'unknown',
            epicId: variables.EPIC_ID || 'unknown',
            projectId: variables.PROJECT_ID || 'unknown',
            workingDir,
          };

          log('info', `Compilation phase SUCCEEDED (${durationMs}ms, ${articleCounts.created} created, ${articleCounts.updated} updated, ${articleCounts.superseded} superseded)`);

          await emitCompilationCompleted(pushEvent, jobId, compilationCtx, {
            status: 'success',
            startedAt: compilationStartedAt,
            completedAt: compilationCompletedAt,
            durationMs,
            articleCounts,
          });

          // Write success record to knowledge/log.md as fallback
          // (in case the COMPILER agent skipped the log write)
          await writeCompilationLog(
            workingDir,
            variables.STORY_ID || 'unknown',
            'success',
            articleCounts,
          );
        }
      } catch (compileErr) {
        compilationStatus = 'failed';
        compilationCompletedAt = new Date().toISOString();

        const compilationCtx = {
          jobId,
          storyId: variables.STORY_ID || 'unknown',
          epicId: variables.EPIC_ID || 'unknown',
          projectId: variables.PROJECT_ID || 'unknown',
          workingDir,
        };

        log('warn', `Compilation step ${step.id} failed (NON-BLOCKING): ${compileErr.message}`);

        // Emit typed compilation-failed event via compile-events module
        await emitCompilationFailed(pushEvent, jobId, compilationCtx, compileErr, compilationStartedAt);

        // Write failure record to knowledge/log.md via compile-events module
        await writeCompilationLog(
          workingDir,
          variables.STORY_ID || 'unknown',
          'failed',
          { created: 0, updated: 0, superseded: 0 },
          compileErr.message.slice(0, 100),
        );

        // Skip remaining compile steps — jump to end of compile phase
        while (i + 1 < steps.length && isCompileStep(steps[i + 1].id)) {
          i++;
          log('info', `Skipping remaining compile step: ${steps[i].id}`);
        }
        // Continue pipeline — compilation is non-blocking
        continue;
      }
      continue;
    }

    // ── Standard (non-compile) step execution ──
    const { allPassed } = await executeStep(jobId, step, agents, workingDir, variables, sessions, stepResults);

    // ── Loop logic: if validations failed and loopTo is set, retry ──
    if (!allPassed && step.loopTo) {
      const retryStep = steps.find((s) => s.id === step.loopTo);
      if (!retryStep) {
        log('error', `loopTo step "${step.loopTo}" not found, skipping loop`);
        continue;
      }

      for (let iteration = 1; iteration < maxIterations; iteration++) {
        // Inject iteration count into variable store so prompts can use {{ITERATION}}
        variables.ITERATION = String(iteration + 1); // 1st attempt was iteration 1, this is 2+
        variables.MAX_ITERATIONS = String(maxIterations);

        log('info', `\n*** LOOP iteration ${iteration}/${maxIterations - 1}: running "${retryStep.id}" then re-checking "${step.id}" (attempt ${iteration + 1}/${maxIterations}) ***`);

        await pushEvent(jobId, step.id, step.agentId || '__shell__', 'status', {
          text: `Loop iteration ${iteration}: re-running ${retryStep.id} then ${step.id} (attempt ${iteration + 1}/${maxIterations})`,
        });

        // Run the retry/fix step
        await executeStep(jobId, retryStep, agents, workingDir, variables, sessions, stepResults);

        // Re-run the gate step (the one with loopTo)
        const recheck = await executeStep(jobId, step, agents, workingDir, variables, sessions, stepResults);

        if (recheck.allPassed) {
          log('info', `Loop resolved after ${iteration} iteration(s)`);
          break;
        }

        if (iteration === maxIterations - 1) {
          log('warn', `Max iterations (${maxIterations}) reached, continuing pipeline`);
        }
      }
    }
  }

  // All steps complete
  const totalCost = stepResults.reduce((sum, sr) => sum + (sr.cost || 0), 0);

  // Parse article counts if compilation succeeded
  const compilationArticleCounts = compilationStatus === 'success'
    ? parseArticleCounts(variables.COMPILE_RESULT || '')
    : undefined;

  await updateJobFields(jobId, {
    status: 'COMPLETED',
    totalCost,
    stepResults,
    variables,
    sessions,
    compilationStatus: compilationStatus || (hasCompileSteps ? 'skipped' : undefined),
    compilationStartedAt,
    compilationCompletedAt,
    compilationArticleCounts,
  });

  log('info', `\nPipeline COMPLETED. Total cost: $${totalCost.toFixed(4)}${compilationStatus ? ` | Compilation: ${compilationStatus}` : ''}`);
  log('info', `Final variables: ${JSON.stringify(Object.fromEntries(
    Object.entries(variables).map(([k, v]) => [k, v.slice(0, 60)])
  ))}`);
}

// ── Epic-dev pipeline dispatcher (EO-4.3) ──

async function executeEpicDevJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateEpicDevJob(job);
  if (!validation.ok) {
    throw new Error(`epic-dev job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to epic-dev pipeline`, {
    epicId: job.epicId,
    stories: job.epicDevPayload?.stories?.length,
    model: job.epicDevPayload?.orchestratorModel,
  });

  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.stepId = 'epic-dev';
    entry.agentId = 'orchestrator';
    entry.model = job.epicDevPayload?.orchestratorModel || null;
  }

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'epic-dev',
    lastHeartbeatAt: new Date().toISOString(),
  });

  const result = await runEpicDevPipeline({
    job,
    eventLogDir: EVENT_LOG_DIR,
    daemonPort: DAEMON_RECEIVER_PORT,
    claudeBin: CLAUDE_BIN,
    spawn,
    logger: {
      info: (msg) => log('info', msg),
      warn: (msg) => log('warn', msg),
      error: (msg) => log('error', msg),
    },
  });

  const ok = result.exitCode === 0;
  log(ok ? 'info' : 'error', `[${short}] Orchestrator exited`, {
    code: result.exitCode,
    durationMs: result.durationMs,
  });

  await updateJobFields(jobId, {
    status: ok ? 'COMPLETED' : 'FAILED',
    errorMessage: ok ? undefined : `orchestrator exit code ${result.exitCode}`,
    orchestratorDurationMs: result.durationMs,
  });
}

// ── Poll loop ──

async function runJobAsync(job) {
  activeJobs.set(job.jobId, {
    startedAt: new Date().toISOString(),
    workingDir: job.workingDir || '',
    stepId: null, agentId: null, pid: null, model: null,
  });
  jobEventSeqs.set(job.jobId, 0);

  const handler = selectHandler(job);
  log('info', `[${job.jobId.slice(0, 8)}] Job started (${activeJobs.size}/${MAX_CONCURRENT} concurrent) handler=${handler}`);
  if (handler !== JOB_HANDLER_EPIC_DEV) {
    log('info', `[${job.jobId.slice(0, 8)}]   Steps: ${job.pipeline?.steps?.length || 0}`);
    log('info', `[${job.jobId.slice(0, 8)}]   Agents: ${Object.keys(job.pipeline?.agents || {}).join(', ')}`);
  }

  try {
    if (handler === JOB_HANDLER_EPIC_DEV) {
      await executeEpicDevJob(job);
    } else {
      await executePipeline(job);
    }
  } catch (err) {
    log('error', `[${job.jobId.slice(0, 8)}] Job failed: ${err.message}`);
    try {
      await updateJobFields(job.jobId, { status: 'FAILED', errorMessage: err.message });
    } catch (updateErr) {
      log('error', `[${job.jobId.slice(0, 8)}] Failed to mark as FAILED: ${updateErr.message}`);
    }
  } finally {
    activeJobs.delete(job.jobId);
    jobEventSeqs.delete(job.jobId);
  }
}

async function poll() {
  log('info', 'Agent daemon started');
  log('info', `  Region:     ${REGION}`);
  log('info', `  Jobs table: ${JOBS_TABLE}`);
  log('info', `  Events:     ${EVENTS_TABLE}`);
  log('info', `  Interval:   ${POLL_INTERVAL}ms`);
  log('info', `  Concurrency: ${MAX_CONCURRENT} jobs`);
  log('info', `  Claude:     ${CLAUDE_BIN}`);
  log('info', `  API key SSM param: ${API_KEY_SSM_PARAM}`);

  await loadApiKeyFromSsm('startup');
  await probeAuth();

  // NDJSON event forwarder: tails per-job logs written by emit-event.sh and
  // mirrors them into the events table with monotonic eventSeq + idempotent puts.
  try {
    const store = createDdbEventStore({ ddb, tableName: EVENTS_TABLE });
    ndjsonForwarder = createNdjsonForwarder({
      logDir: EVENT_LOG_DIR,
      store,
      pollMs: FORWARDER_POLL_MS,
      logger: {
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
        info: () => {},
      },
    });
    await ndjsonForwarder.start();
    log('info', `NDJSON forwarder started`, { logDir: EVENT_LOG_DIR, pollMs: FORWARDER_POLL_MS });
  } catch (err) {
    log('error', `NDJSON forwarder failed to start: ${err.message}`);
  }

  // Loopback HTTP receiver for wave-complete / heartbeat from orchestrator subagents.
  try {
    daemonReceiver = createDaemonReceiver({
      ddb,
      jobsTable: JOBS_TABLE,
      logger: {
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
        info: (msg) => log('info', msg),
      },
    });
    const addr = await daemonReceiver.listen(DAEMON_RECEIVER_PORT, '127.0.0.1');
    log('info', `Daemon receiver listening`, { host: addr.address, port: addr.port });
  } catch (err) {
    log('error', `Daemon receiver failed to start: ${err.message}`);
  }

  setInterval(() => {
    loadApiKeyFromSsm('refresh').catch((e) => log('error', `API key refresh failed: ${e.message}`));
  }, API_KEY_REFRESH_MS).unref();
  setInterval(() => {
    probeAuth().catch((e) => log('error', `Auth probe failed: ${e.message}`));
  }, AUTH_PROBE_INTERVAL_MS).unref();

  log('info', 'Polling for PENDING jobs...\n');

  while (!shuttingDown) {
    try {
      await writeHeartbeat();

      // Stale-heartbeat scan (EO-4.5) — throttled so we don't hammer DDB.
      if (Date.now() - lastStaleScanAt >= STALE_SCAN_INTERVAL_MS) {
        lastStaleScanAt = Date.now();
        scanStaleEpicDevJobs().catch((e) => log('error', `Stale scan uncaught: ${e.message}`));
      }

      // Only query if we have available slots
      const availableSlots = MAX_CONCURRENT - activeJobs.size;
      if (availableSlots > 0) {
        const { Items } = await ddb.send(
          new QueryCommand({
            TableName: JOBS_TABLE,
            IndexName: 'status-createdAt-index',
            KeyConditionExpression: '#s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':pending': 'PENDING' },
            Limit: availableSlots,
            ScanIndexForward: true,
          }),
        );

        if (Items?.length > 0) {
          for (const job of Items) {
            if (activeJobs.has(job.jobId)) continue; // already in flight
            // Fire-and-forget — job runs concurrently
            runJobAsync(job).catch((e) => log('error', `runJobAsync uncaught: ${e.message}`));
          }
        }
      }
    } catch (err) {
      log('error', `Poll error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

// ── Graceful shutdown ──

async function shutdown(signal) {
  log('warn', `Received ${signal}. Shutting down... (${activeJobs.size} active jobs)`);
  shuttingDown = true;

  if (ndjsonForwarder) {
    try {
      await ndjsonForwarder.stop();
    } catch (err) {
      log('error', `NDJSON forwarder stop failed: ${err.message}`);
    }
  }

  if (daemonReceiver) {
    try {
      await daemonReceiver.close();
    } catch (err) {
      log('error', `Daemon receiver close failed: ${err.message}`);
    }
  }

  for (const jobId of activeJobs.keys()) {
    log('warn', `Marking active job ${jobId.slice(0, 8)} as FAILED (interrupted)`);
    try {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: `Daemon interrupted by ${signal}`,
      });
    } catch (err) {
      log('error', `Failed to update job on shutdown: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// SIGUSR1 = hot-reload the Anthropic API key from SSM and re-probe auth.
// Triggered by the admin API after /api/ec2/set-anthropic-key so rotations
// propagate within seconds — no restart, no killed jobs.
process.on('SIGUSR1', async () => {
  log('info', 'SIGUSR1 received — hot-reloading API key from SSM');
  try {
    await loadApiKeyFromSsm('sigusr1');
    await probeAuth();
  } catch (err) {
    log('error', `SIGUSR1 reload failed: ${err.message}`);
  }
});

poll();
