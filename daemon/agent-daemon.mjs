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
  GetCommand,
  QueryCommand,
  UpdateCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { spawn, execSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync } from 'fs';
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
import { createEpicRepo } from './pipelines/lib/epic-repo.mjs';
import {
  selectHandler,
  validateEpicDevJob,
  validatePartyBootstrapJob,
  validatePartyInspectJob,
  validatePartyTurnJob,
  validatePartyDocsSyncJob,
  validatePartyDocsUnlinkJob,
  validateAppBootstrapJob,
  JOB_HANDLER_EPIC_DEV,
  JOB_HANDLER_PARTY_BOOTSTRAP,
  JOB_HANDLER_PARTY_INSPECT,
  JOB_HANDLER_PARTY_TURN,
  JOB_HANDLER_PARTY_DOCS_SYNC,
  JOB_HANDLER_PARTY_DOCS_UNLINK,
  JOB_HANDLER_APP_BOOTSTRAP,
} from './pipelines/job-router.mjs';
import { runEpicDevPipeline } from './pipelines/epic-dev-pipeline.mjs';
import { runPartyBootstrap } from './pipelines/party-bootstrap.mjs';
import { runPartyInspect } from './pipelines/party-inspector.mjs';
import { runPartyTurn } from './pipelines/party-turn.mjs';
import { runPartyDocsSync } from './pipelines/party-docs-sync.mjs';
import { runPartyDocsUnlink } from './pipelines/party-docs-unlink.mjs';
// Pipeline v2 / Story 1.4.3 — App-bootstrap saga (steps 3–5).
import { runAppBootstrap } from './pipelines/app-bootstrap.mjs';
import {
  findStaleJobs,
  buildResumeJob,
  DEFAULT_STALE_MS,
} from './pipelines/stale-heartbeat.mjs';
import {
  registerChild,
  unregisterChild,
  signalAllChildren,
  signalChildrenForJob,
  waitForAllChildrenToExit,
  killAllChildren,
  getChildCount,
} from './pipelines/lib/child-tracker.mjs';
// Pipeline v2.0 efficiency fix B8 — deterministic deny-pattern enforcement
// for Bash tool_use events. Replaces prompt prose ("Do NOT run npm create
// vite") with SIGTERM-on-match. See daemon/lib/bash-deny-patterns.mjs.
import { matchesDenyPattern } from './lib/bash-deny-patterns.mjs';
import {
  writeAttentionItem,
  resolvePlanIdFromEpicId,
} from './pipelines/lib/attention-writer.mjs';
import {
  assertSpawnAllowed,
  ShellGuardViolation,
} from './pipelines/lib/shell-guard.mjs';
import { mergeVisualTestsBlock } from './pipelines/lib/visual-tests-writer.mjs';
// Pipeline v2.0 efficiency fix T0.1 — detect ---DONE--- + ---WORK_SUMMARY---
// in agent prose so COST_HARD-after-DONE terminations resolve as success
// instead of triggering a re-spawn loop. See daemon/lib/done-detector.mjs.
import { hasDoneAndWorkSummary } from './lib/done-detector.mjs';
// Pipeline v2.0 efficiency fix T0.2 — daemon-side pre-DEV gate that
// short-circuits no-op stories without spawning the LLM. See
// daemon/lib/prework-gate.mjs.
import { evaluatePreworkGate, renderGateEvidence } from './lib/prework-gate.mjs';
import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
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
const EPICS_TABLE = process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows';
// Pipeline v2 / Story 1.4.3 — App-bootstrap saga reads + updates the App row.
const APPS_TABLE = process.env.APPS_TABLE || 'futurator-apps';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const OAUTH_CREDS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH || '/home/ubuntu/.claude/.credentials.json';
// Re-read OAuth file + probe hourly. Access tokens expire ~24h and the CLI
// refreshes them per-invocation using the refresh_token, so hourly is plenty.
const AUTH_PROBE_INTERVAL_MS = parseInt(process.env.AUTH_PROBE_INTERVAL_MS || String(60 * 60 * 1000), 10);
const EVENT_LOG_DIR = process.env.FUTURATOR_EVENT_LOG_DIR || '/var/log/futurator/events';
const FORWARDER_POLL_MS = parseInt(process.env.FORWARDER_POLL_MS || '250', 10);
const DAEMON_RECEIVER_PORT = parseInt(process.env.FUTURATOR_DAEMON_PORT || '17631', 10);
const STALE_HEARTBEAT_MS = parseInt(process.env.STALE_HEARTBEAT_MS || String(DEFAULT_STALE_MS), 10);
const STALE_SCAN_INTERVAL_MS = parseInt(process.env.STALE_SCAN_INTERVAL_MS || '30000', 10);
// Pipeline Enhancement Plan v2 — Phase A.1: graceful shutdown window. On
// SIGTERM/SIGINT the daemon SIGTERMs tracked children, waits this long, then
// SIGKILLs any stragglers and emits daemon-shutdown-timeout attention items.
const GRACEFUL_SHUTDOWN_MS = parseInt(process.env.GRACEFUL_SHUTDOWN_MS || '30000', 10);

// Pipeline Enhancement Plan v2 — Phase A.3: retry ladder. Transient step
// failures (non-policy, non-auth) re-queue as PENDING with retryAfter set to
// now + the corresponding delay. After MAX_RETRIES exhausted the job is
// FAILED for real and a high-severity retry-exhausted attention item is
// written.
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000]; // 30s → 2m → 8m
const MAX_RETRIES = RETRY_DELAYS_MS.length;

// Pipeline v2.0 Efficiency Fix T0.3 — story pipelines (per-story DEV→
// REVIEWER→COMPILER) get a tighter retry budget than the generic ladder.
// dino1 forensic: a no-op story burned ~$40 across ~5 dev re-spawns before
// the operator manually abandoned. T0.1's COST_HARD-after-DONE detector is
// the primary fix; this is defense-in-depth for the case where dev fails
// BEFORE emitting ---DONE---. Default 2 attempts (1 retry).
const MAX_DEV_ATTEMPTS_PER_STORY = parseInt(
  process.env.MAX_DEV_ATTEMPTS_PER_STORY || '2',
  10,
);
const STORY_PIPELINE_MAX_RETRIES = Math.max(0, MAX_DEV_ATTEMPTS_PER_STORY - 1);

// Pipeline v2.0 Efficiency Fix T0.2 — daemon-side pre-DEV gate.
// When enabled (default), executePipeline runs three deterministic signals
// (recent commits + AC named exports present in touchPoints + tsc clean)
// before spawning the dev step. If all green, the job short-circuits to
// COMPLETED_VIA_PREWORK without spawning any agent. dino1 forensic projects
// this would have eliminated 7 of 9 DEV spawns on pre-scaffolded boilerplates.
const PREWORK_GATE_ENABLED = (process.env.PREWORK_GATE_ENABLED || 'true') !== 'false';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// ── Claude Code OAuth auth (Max subscription only, no fallback) ──
//
// The daemon NEVER uses an Anthropic API key. All agent work counts against
// the operator's Claude Max subscription via the OAuth tokens at
// OAUTH_CREDS_PATH. Those tokens are pushed from the operator's Mac Keychain
// via scripts/mac-oauth-sync.sh (manual) or scripts/mac-oauth-server.mjs
// (the always-on localhost helper, triggered on-demand by the admin UI's
// Re-authorize button and also on a launchd timer).
//
// If the OAuth file is missing or the `claude` CLI rejects it, jobs fail —
// we do not attempt to authenticate any other way. The operator clicks
// Re-authorize in the UI to push fresh tokens from their Mac.
const authState = {
  valid: null, // null until first probe, true/false after
  checkedAt: null,
  error: null,
  loadedAt: null, // when we last read the OAuth file
  hasFile: false, // does the file exist + parse?
  hasRefresh: false, // does the file contain a refresh_token?
  expiresAt: null, // unix ms from the accessToken (CLI refreshes per-use)
  subscriptionType: null, // "max" / "pro" / ...
};

function tryOAuthFile() {
  try {
    const raw = readFileSync(OAUTH_CREDS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Real Keychain format (verified): { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } }
    // Legacy / alternate flat format: { accessToken, refreshToken, ... }
    const oauth = parsed?.claudeAiOauth || parsed?.oauth || parsed;
    if (!oauth?.accessToken || oauth.accessToken.length < 30) return null;
    return {
      accessToken: oauth.accessToken,
      hasRefresh: !!oauth.refreshToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
      subscriptionType: oauth.subscriptionType || null,
    };
  } catch {
    return null;
  }
}

function loadOAuth(reason = 'startup') {
  // CRITICAL: if ANYTHING has set ANTHROPIC_API_KEY in our process env, remove
  // it. Claude CLI prioritises that env var over the OAuth file and would
  // silently bill against an API key instead of the Max subscription.
  if ('ANTHROPIC_API_KEY' in process.env) {
    delete process.env.ANTHROPIC_API_KEY;
  }
  const info = tryOAuthFile();
  if (!info) {
    authState.hasFile = false;
    authState.hasRefresh = false;
    authState.expiresAt = null;
    authState.subscriptionType = null;
    log('warn', `OAuth file missing or unreadable at ${OAUTH_CREDS_PATH} (${reason})`);
    return;
  }
  authState.hasFile = true;
  authState.hasRefresh = info.hasRefresh;
  authState.expiresAt = info.expiresAt;
  authState.subscriptionType = info.subscriptionType;
  authState.loadedAt = Date.now();
  log('info', `OAuth loaded from ${OAUTH_CREDS_PATH} (${reason})`, {
    subscription: info.subscriptionType,
    hasRefresh: info.hasRefresh,
    accessExpiresAt: info.expiresAt ? new Date(info.expiresAt).toISOString() : null,
  });
}

function probeAuth() {
  return new Promise((resolve) => {
    const args = ['-p', 'ok', '--model', 'haiku', '--output-format', 'json'];
    const proc = spawn(process.execPath, [CLAUDE_BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Belt-and-suspenders: strip ANTHROPIC_API_KEY from child env so the CLI
      // cannot pick it up even if something sets it after daemon startup.
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
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
      // CLI may exit 0 with is_error=true on rate limit / quota / OAuth reject.
      let parsed = null;
      try {
        const trimmed = combined.trim();
        if (trimmed.startsWith('{')) parsed = JSON.parse(trimmed);
      } catch {}
      const claudeReportedError = parsed?.is_error === true;
      const ok = !claudeReportedError && code === 0 && !isAuthFailureOutput(combined);
      authState.valid = ok;
      authState.error = ok
        ? null
        : (parsed?.result || stderr.trim() || `exit ${code}`).slice(0, 300);
      authState.checkedAt = new Date().toISOString();
      log(ok ? 'info' : 'warn', `Auth probe: ${ok ? 'OK' : 'FAIL'}`, {
        err: authState.error,
      });
      resolve();
    });
  });
}

function stripApiKey(env) {
  const clean = { ...env };
  delete clean.ANTHROPIC_API_KEY;
  return clean;
}

function isAuthFailureOutput(text) {
  if (!text) return false;
  return /401|authentication_error|unauthenticated|Failed to authenticate|Not logged in|Please run \/login/i.test(
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

/**
 * Look up the highest existing eventSeq for a jobId in DDB. Used to seed
 * `jobEventSeqs` the first time we touch a jobId in this daemon process —
 * critical for party sessions, where the same jobId (= sessionId) accumulates
 * events across many turns and across daemon restarts. Without this, a
 * deploy/restart resets the counter to 0 and the next turn's events overwrite
 * Round 1's user event in DDB, which (a) destroys data and (b) makes the
 * fresh turn appear at the top of the chat as "Round 1" instead of being
 * appended at the end.
 *
 * Walks ScanIndexForward=false with Limit=1, so it costs one DDB read per
 * cold-start of a session in this process.
 */
async function loadMaxEventSeq(jobId) {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: 'jobId = :j',
        ExpressionAttributeValues: { ':j': jobId },
        ScanIndexForward: false,
        Limit: 1,
        ProjectionExpression: 'eventSeq',
      }),
    );
    const item = (result.Items || [])[0];
    if (!item || typeof item.eventSeq !== 'string') return 0;
    const n = parseInt(item.eventSeq, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    log('warn', 'Failed to load max eventSeq — starting from 0', { jobId, err: err.message });
    return 0;
  }
}

async function pushEvent(jobId, stepId, agentId, eventType, data = {}) {
  // Seed the in-memory counter from DDB the first time we see this jobId in
  // this process. See loadMaxEventSeq() for why.
  if (!jobEventSeqs.has(jobId)) {
    const existing = await loadMaxEventSeq(jobId);
    jobEventSeqs.set(jobId, existing);
  }
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

    try {
      assertSpawnAllowed(process.execPath, [CLAUDE_BIN, ...args], cwd);
    } catch (err) {
      if (err instanceof ShellGuardViolation) {
        log('error', `shell-guard refused agent step ${stepId}: ${err.message}`, err.details);
        handleGuardViolation(jobId, { ...err.details, stepId, agentId });
        return reject(err);
      }
      throw err;
    }
    // Use node directly to execute claude's cli.js — avoids shell interpretation
    // issues AND works on Linux where spawn without shell can't handle shebangs
    const proc = spawn(process.execPath, [CLAUDE_BIN, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // stripApiKey: defense against anything setting ANTHROPIC_API_KEY at
      // runtime. The daemon authenticates exclusively via the Max-subscription
      // OAuth file at OAUTH_CREDS_PATH; if the env var leaks into a spawn the
      // CLI prioritises it and we'd silently switch to API-key billing.
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
    });

    registerChild(jobId, proc);

    // Track PID and model in heartbeat
    const entry = activeJobs.get(jobId);
    if (entry) { entry.pid = proc.pid; entry.model = opts.model || 'default'; }

    let buffer = '';
    let finalResult = null;
    let stderrBuffer = '';
    // T0.1: accumulate the agent's prose output across all stream events so the
    // close-handler can scan for ---DONE--- + ---WORK_SUMMARY--- when the CLI
    // terminates non-zero. Capped at 64 KB to bound memory; the markers
    // typically land in the last few KB of agent output.
    let agentTextBuffer = '';
    const AGENT_TEXT_BUFFER_CAP = 64 * 1024;

    // Handle spawn failures (ENOENT, permissions, etc.)
    proc.on('error', (err) => {
      unregisterChild(jobId, proc);
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
          // T0.1: accumulate agent prose for COST_HARD-after-DONE detection.
          // Two paths emit text: stream_event/text_delta (incremental) and
          // assistant/text-block (final). Keep both; cap at 64 KB.
          if (agentTextBuffer.length < AGENT_TEXT_BUFFER_CAP) {
            if (
              event.type === 'stream_event' &&
              event.event?.delta?.type === 'text_delta' &&
              typeof event.event.delta.text === 'string'
            ) {
              agentTextBuffer += event.event.delta.text;
            } else if (
              event.type === 'assistant' &&
              Array.isArray(event.message?.content)
            ) {
              for (const block of event.message.content) {
                if (block?.type === 'text' && typeof block.text === 'string') {
                  agentTextBuffer += block.text;
                }
              }
            }
          }
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
      unregisterChild(jobId, proc);
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
          'Claude Code OAuth expired on EC2 — click Re-authorize in the admin UI to push fresh tokens from your Mac Keychain.';
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
        // T0.1 — Pipeline v2.0 efficiency fix.
        // If the agent emitted ---DONE--- + ---WORK_SUMMARY--- before the CLI
        // forced a termination (typically COST_HARD), the work is captured.
        // Synthesize a finalResult so executePipeline can run extractors
        // against the buffered text and proceed normally. Without this, the
        // job re-enqueues and the same conclusion is re-discovered next time
        // at full cost — dino1 burned ~$35 on this loop.
        if (hasDoneAndWorkSummary(agentTextBuffer)) {
          log(
            'warn',
            `Step ${stepId}: forced termination (exit ${code}) AFTER ---DONE--- emitted; treating as success`,
            { bufferBytes: agentTextBuffer.length, stderr: stderrBuffer.slice(0, 200) },
          );
          pushEvent(jobId, stepId, agentId, 'status', {
            text: `[SYSTEM] terminationReason=COST_HARD_AFTER_DONE — agent emitted ---DONE--- before termination; treating as success`,
          });
          return resolve({
            type: 'result',
            // Cost is unknown (no result event arrived); 0 keeps rollups stable.
            // Observability sees the COST_HARD log line + the synthesized event.
            total_cost_usd: 0,
            session_id: '',
            // executePipeline reads result.result for runExtractors; the buffer
            // contains the agent's full prose including all envelope markers.
            result: agentTextBuffer.slice(-AGENT_TEXT_BUFFER_CAP),
            modelUsage: {},
            duration_ms: 0,
            num_turns: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            // Tag for downstream observability — not consumed by executePipeline
            // today, but cheap to surface for future debugging.
            _terminationReason: 'COST_HARD_AFTER_DONE',
          });
        }

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

/**
 * Pipeline v2.0 B8 — handle a denied Bash command.
 *
 * SIGTERM the active child for this jobId, push a step_error event for
 * observability, and write a 'tamper-reverted' attention item so the
 * operator can review what the agent attempted. The child's close handler
 * will subsequently reject runAgent — handleJobFailure decides whether
 * the job is retriable (story pipelines retry once per T0.3; the agent
 * gets a fresh attempt with the same prompt and presumably tries again,
 * which this gate will block again — net effect: predictable failure).
 *
 * The deny is non-bypassable: there's no way for the agent to "negotiate"
 * past it via prompt jiggling. The pattern matching happens before the
 * tool_result event is emitted back to the agent, but the bash command
 * has already started executing — the SIGTERM is best-effort harm
 * reduction, not pre-execution prevention. Future: pair with
 * `--disallowedTools=Bash` on agents that don't need Bash at all
 * (REVIEWER, COMPILER) so the surface area is even smaller.
 */
async function handleDeniedBashCommand({ jobId, stepId, agentId, command, verdict }) {
  log(
    'error',
    `[${jobId.slice(0, 8)}] B8 deny — killing child: pattern=${verdict.label} cmd=${command.slice(0, 200)}`,
  );
  await pushEvent(jobId, stepId, agentId, 'step_error', {
    text: `[B8] Bash command denied by deny-pattern (${verdict.label}): ${verdict.reason}`,
    deniedCommand: command.slice(0, 500),
    deniedPattern: verdict.label,
  });

  // SIGTERM only this job's children. Other in-flight jobs are unaffected.
  try {
    const signaled = signalChildrenForJob(jobId, 'SIGTERM');
    log('warn', `[${jobId.slice(0, 8)}] B8: SIGTERMed ${signaled} child(ren)`);
  } catch (sigErr) {
    log('error', `[${jobId.slice(0, 8)}] B8: SIGTERM failed: ${sigErr.message}`);
  }

  // Surface to the operator inbox. Best-effort; failure here is non-fatal.
  try {
    const planId = await resolvePlanIdFromEpicId(ddb, /* epicId */ null);
    // We don't have epicId in this scope; the writer accepts a falsy planId
    // and skips DDB writes silently. The step_error event above is the
    // primary surface; the attention item is the secondary one.
    if (planId) {
      await writeAttentionItem(
        ddb,
        {
          planId,
          severity: 'high',
          category: 'tamper-reverted',
          title: `Agent attempted denied Bash command (B8: ${verdict.label})`,
          body:
            `The ${agentId || 'agent'} step "${stepId}" attempted a Bash command ` +
            `that the daemon's B8 deny-pattern enforcement classified as harmful: ` +
            `${verdict.reason}. Command (truncated): \`${command.slice(0, 300)}\`. ` +
            `The child process was SIGTERM-ed; the job will fail with a step_error. ` +
            `If this is a false-positive, edit daemon/lib/bash-deny-patterns.mjs.`,
          context: { jobId, stepId, agentId, deniedPattern: verdict.label },
          suggestedActions: [
            { label: 'Open logs', kind: 'open-logs' },
            { label: 'Open story', kind: 'open-story' },
          ],
        },
        log,
      );
    }
  } catch (attnErr) {
    log('error', `[${jobId.slice(0, 8)}] B8: attention-item write failed: ${attnErr.message}`);
  }
}

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

          // Pipeline v2.0 B8 — Bash deny-pattern enforcement.
          // The CLI's --allowedTools flag controls which tools are AVAILABLE,
          // but it can't sub-restrict Bash command shapes. We enforce
          // scaffolding-prohibition (npm create vite, git init, rm -rf .,
          // etc.) at the daemon by SIGTERM-ing the child as soon as we
          // observe a denied command. The agent's prompt no longer needs
          // a PROJECT BASELINE prose paragraph — the rule is unbypassable
          // at the process layer.
          if (block.name === 'Bash' && typeof block.input?.command === 'string') {
            const verdict = matchesDenyPattern(block.input.command);
            if (verdict.denied) {
              await handleDeniedBashCommand({
                jobId,
                stepId,
                agentId,
                command: block.input.command,
                verdict,
              });
            }
          }
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
            hasFile: authState.hasFile,
            hasRefresh: authState.hasRefresh,
            loadedAt: authState.loadedAt ? new Date(authState.loadedAt).toISOString() : null,
            expiresAt: authState.expiresAt ? new Date(authState.expiresAt).toISOString() : null,
            subscriptionType: authState.subscriptionType,
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
    const effectiveCwd = workingDir || process.env.HOME;
    try {
      assertSpawnAllowed('bash', ['-c', command], effectiveCwd);
    } catch (err) {
      if (err instanceof ShellGuardViolation) {
        log('error', `shell-guard refused shell step ${step.id}: ${err.message}`, err.details);
        handleGuardViolation(jobId, { ...err.details, command: command.slice(0, 200), stepId: step.id });
        return resolve({
          passed: false,
          stepResult: {
            stepId: step.id,
            agentId: '__shell__',
            status: 'error',
            cost: 0,
            durationMs: 0,
            errorMessage: err.message,
            extractedVariables: {},
            validationResults: [],
          },
        });
      }
      throw err;
    }
    // detached: true → bash becomes its own process group leader. Lets us
    // SIGKILL the whole descendant tree via kill(-pgid) on timeout — critical
    // because shell steps that spawn dev servers (npm, vite, etc.) can leave
    // orphans that keep holding ports and occupying slots (2026-04-24
    // incident).
    const proc = spawn('bash', ['-c', command], {
      cwd: effectiveCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
      detached: true,
    });
    registerChild(jobId, proc);

    let stdout = '';
    let stderr = '';
    let killed = false;
    let resolved = false;

    const settle = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    // Stream chunks into agent events so the UI can show real-time shell
    // output. We throttle to avoid flooding DDB — emit when we've buffered
    // >= 500 chars OR 500ms have passed since last flush, whichever comes
    // first. On step close we flush whatever's left.
    let unflushedStdout = '';
    let unflushedStderr = '';
    let lastFlushAt = Date.now();
    const flushStream = async (force) => {
      const elapsed = Date.now() - lastFlushAt;
      const bigEnough = unflushedStdout.length + unflushedStderr.length >= 500;
      if (!force && !bigEnough && elapsed < 500) return;
      const out = unflushedStdout;
      const err = unflushedStderr;
      unflushedStdout = '';
      unflushedStderr = '';
      lastFlushAt = Date.now();
      if (out) {
        await pushEvent(jobId, step.id, '__shell__', 'tool_result', { text: out.slice(-4000) });
      }
      if (err) {
        await pushEvent(jobId, step.id, '__shell__', 'tool_result', { text: err.slice(-4000) });
      }
    };

    const forceResolveTimer = { id: null };

    const timer = setTimeout(() => {
      killed = true;
      log('warn', `[${jobId.slice(0, 8)}] Step ${step.id} exceeded ${timeout}ms — SIGKILL'ing process group`);
      // Negative pid sends signal to the whole process group (bash + npm +
      // vite + sub-shells). Fall back to per-proc kill if group kill is
      // rejected (e.g. EPERM).
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch (e) {
        log('warn', `[${jobId.slice(0, 8)}] group kill failed (${e.message}) — SIGKILL'ing bash alone`);
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      // Safety net: if proc.on('close') doesn't fire within 5s of SIGKILL,
      // force-resolve the Promise so the job's slot is freed regardless.
      // Happens when bash is alive but a grandchild keeps the stdout pipe
      // open (Vite did this pre-fix).
      forceResolveTimer.id = setTimeout(async () => {
        log(
          'error',
          `[${jobId.slice(0, 8)}] Step ${step.id} did not close 5s after SIGKILL — force-resolving (slot freed)`,
        );
        await pushEvent(jobId, step.id, '__shell__', 'step_error', {
          text: `Step force-killed after ${timeout}ms timeout + 5s grace. stderr: ${stderr.slice(0, 300)}`,
        });
        unregisterChild(jobId, proc);
        settle({
          passed: false,
          stepResult: {
            stepId: step.id,
            agentId: '__shell__',
            status: 'error',
            cost: 0,
            durationMs: Date.now() - startMs,
            errorMessage: `timeout ${timeout}ms + force-kill`,
            extractedVariables: {},
            validationResults: [],
          },
        });
      }, 5000);
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      unflushedStdout += s;
      flushStream(false).catch(() => {});
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      unflushedStderr += s;
      flushStream(false).catch(() => {});
    });

    proc.on('close', async (code) => {
      unregisterChild(jobId, proc);
      clearTimeout(timer);
      if (forceResolveTimer.id) clearTimeout(forceResolveTimer.id);
      if (resolved) return;
      const durationMs = Date.now() - startMs;
      const passed = !killed && code === expectCode;

      await flushStream(true);

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

      settle({ passed, stepResult });
    });

    proc.on('error', async (err) => {
      unregisterChild(jobId, proc);
      clearTimeout(timer);
      if (forceResolveTimer.id) clearTimeout(forceResolveTimer.id);
      await pushEvent(jobId, step.id, '__shell__', 'step_error', {
        text: `Shell spawn failed: ${err.message}`,
      });
      settle({
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

    // Story A.2: when VISUAL_TESTS is captured, materialize it on disk so the
    // reviewer can see it. Before A.2 the reviewer FAILed valid stories with
    // "missing visual-tests file" because nothing wrote `visual-tests.md`.
    // Synchronous on the job loop — must complete BEFORE the reviewer step
    // starts. Malformed entries → compile-sync-failed attention item; the
    // file is left untouched.
    if (extracted.VISUAL_TESTS && workingDir) {
      const merge = mergeVisualTestsBlock({
        projectDir: workingDir,
        block: extracted.VISUAL_TESTS,
      });
      if (merge.ok) {
        log('info', `visual-tests.md merged`, {
          path: merge.path,
          appended: merge.appendedRefs?.length || 0,
          replaced: merge.replacedRefs?.length || 0,
          totalEntries: merge.totalEntries,
        });
        await pushEvent(jobId, step.id, step.agentId, 'status', {
          text: `visual-tests.md updated (${merge.totalEntries || 0} entries; +${merge.appendedRefs?.length || 0} new, ~${merge.replacedRefs?.length || 0} replaced)`,
        });
      } else {
        log(
          'error',
          `visual-tests.md merge FAILED: ${merge.reason}`,
          { path: merge.path },
        );
        await pushEvent(jobId, step.id, step.agentId, 'step_error', {
          text: `visual-tests.md write failed: ${merge.reason}`,
        });
        try {
          const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
          if (planId) {
            await writeAttentionItem(
              ddb,
              {
                planId,
                severity: 'medium',
                category: 'compile-sync-failed',
                title: `visual-tests.md write failed`,
                body:
                  `The DEV agent emitted a VISUAL_TESTS block but it could not be parsed into ${merge.path}: ${merge.reason}. The reviewer will not see the visual tests this run.`,
                context: {
                  jobId,
                  epicId: variables.EPIC_ID,
                  storyId: variables.STORY_ID,
                  stepId: step.id,
                },
                suggestedActions: [
                  { label: 'Open logs', kind: 'open-logs' },
                  { label: 'Open story', kind: 'open-story' },
                ],
              },
              log,
            );
          }
        } catch (attnErr) {
          log('error', `Failed to write visual-tests attention item: ${attnErr.message}`);
        }
      }
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

/**
 * Pipeline v2.0 T0.2 — run the pre-DEV gate for a story-pipeline job.
 * Reads AC_TEXT / TOUCH_POINTS / PLAN_START_TIME from the job's pipeline
 * variables (seeded by generateStoryPipeline), invokes the pure
 * `evaluatePreworkGate`, and writes the evidence markdown to
 * `<workingDir>/.context/wave-N-story-<id>.md` for observability and (when
 * the gate falls through) for the running DEV agent to optionally Read.
 *
 * Returns { shouldSkipDev, reason, evidenceMarkdownPath?, evidence }.
 *
 * Never throws on internal failures — caller falls through to spawn DEV.
 */
async function runPreworkGateForJob(job, variables, workingDir) {
  let touchPoints = [];
  try {
    const raw = variables.TOUCH_POINTS || '[]';
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) touchPoints = parsed.filter((p) => typeof p === 'string');
  } catch {
    // malformed TOUCH_POINTS — treat as no touchPoints (gate falls through)
  }

  const verdict = await evaluatePreworkGate({
    projectDir: workingDir,
    planStartTime: variables.PLAN_START_TIME || null,
    touchPoints,
    acText: variables.AC_TEXT || '',
    runCommand: variables.RUN_COMMAND || undefined,
  });

  // Persist evidence to disk for observability + agent-side context (T1.5
  // will plumb the path into the dev prompt's touchPoints in a later PR;
  // for now the file simply exists).
  let evidenceMarkdownPath = null;
  try {
    const storyId = variables.STORY_ID || 'unknown';
    const waveNum = variables.WAVE_NUMBER || '0';
    const dir = `${workingDir.replace(/\/+$/, '')}/.context`;
    await fsMkdir(dir, { recursive: true });
    const filename = `wave-${waveNum}-story-${storyId}.md`;
    evidenceMarkdownPath = `${dir}/${filename}`;
    const md = renderGateEvidence(verdict, storyId);
    if (md) await fsWriteFile(evidenceMarkdownPath, md, 'utf8');
  } catch (writeErr) {
    log('warn', `prework-gate: failed to write evidence file (non-fatal): ${writeErr.message}`);
  }

  return {
    shouldSkipDev: !verdict.shouldSpawnDev,
    reason: verdict.reason,
    evidenceMarkdownPath,
    evidence: verdict.evidence,
  };
}

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

  // ── Pipeline v2.0 T0.2 — daemon-side pre-DEV gate ──
  // Run before the first step. If all three signals (recent commits + AC
  // named exports present in touchPoints + tsc clean) pass, short-circuit the
  // entire pipeline to COMPLETED_VIA_PREWORK. No LLM is invoked. dino1
  // forensic: 7 of 9 stories were no-ops; this gate would have skipped them
  // for ~$0.02 each instead of ~$0.30 each via the agent-emits-sentinel path.
  const isStoryPipeline = Boolean(variables.STORY_ID);
  const hasDevStep = steps.some((s) => s.id === 'dev');
  if (PREWORK_GATE_ENABLED && isStoryPipeline && hasDevStep && workingDir) {
    try {
      const gateResult = await runPreworkGateForJob(job, variables, workingDir);
      if (gateResult.shouldSkipDev) {
        log('info', `[${jobId.slice(0, 8)}] prework gate PASSED — skipping DEV; reason: ${gateResult.reason}`);
        await pushEvent(jobId, '__prework_gate__', 'orchestrator', 'status', {
          text: `[SYSTEM] prework-gate=skip-dev — ${gateResult.reason}`,
        });
        await updateJobFields(jobId, {
          status: 'COMPLETED_VIA_PREWORK',
          variables,
          stepResults,
          totalCost: 0,
          preworkGateEvidence: gateResult.evidenceMarkdownPath || undefined,
        });
        return;
      }
      log('info', `[${jobId.slice(0, 8)}] prework gate fell through — spawning DEV; reason: ${gateResult.reason}`);
      await pushEvent(jobId, '__prework_gate__', 'orchestrator', 'status', {
        text: `[SYSTEM] prework-gate=spawn-dev — ${gateResult.reason}`,
      });
    } catch (gateErr) {
      // Gate must NEVER block the pipeline. Log + fall through to spawn DEV.
      log('warn', `[${jobId.slice(0, 8)}] prework gate threw (non-blocking): ${gateErr.message}`);
    }
  }

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
    pushEvent,
    onGuardViolation: (jid, details) => handleGuardViolation(jid, details),
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

// ── Party Module (Epic 15) ──

const PARTY_PROJECTS_TABLE = process.env.PARTY_PROJECTS_TABLE || 'futurator-party-projects';
const PARTY_SESSIONS_TABLE = process.env.PARTY_SESSIONS_TABLE || 'futurator-party-sessions';
const PARTY_PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/home/ubuntu/projects';
const PARTY_BMAD_VERSION = process.env.BMAD_VERSION || '6.3.0';
const PARTY_BMAD_AGENTS_SOURCE =
  process.env.BMAD_AGENTS_SOURCE || '/home/ubuntu/bmad-agents-source/bmad/agents';
const PARTY_BMAD_AGENTS_SOURCE_REPO =
  process.env.BMAD_AGENTS_SOURCE_REPO || '/home/ubuntu/bmad-agents-source';
const PARTY_EXPECTED_AGENT_COUNT = parseInt(
  process.env.PARTY_EXPECTED_AGENT_COUNT || '6',
  10,
);

async function updatePartyProjectState(projectId, patch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

async function partyGetSession(sessionId) {
  const result = await ddb.send(
    new GetCommand({ TableName: PARTY_SESSIONS_TABLE, Key: { sessionId } }),
  );
  return result?.Item || null;
}

/**
 * Look up a Party project by id. Used by the party-turn pipeline to read
 * `allowedTools` so it can pass `--allowedTools` to Claude. Returns null
 * if the row is missing — caller falls back to defaults.
 */
async function partyGetProject(projectId) {
  const result = await ddb.send(
    new GetCommand({ TableName: PARTY_PROJECTS_TABLE, Key: { projectId } }),
  );
  return result?.Item || null;
}

async function partySetClaudeSessionId(sessionId, claudeSessionId) {
  // Accept rows where claudeSessionId is absent OR stored as a legacy NULL
  // value (pre-fix createSession wrote `null`, which DDB stores as a NULL
  // attribute and made `attribute_not_exists` return false). This change
  // lets the daemon capture the real Claude session ID on first-turn even
  // for older sessions.
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET claudeSessionId = :cid',
      ConditionExpression:
        'attribute_exists(sessionId) AND (attribute_not_exists(claudeSessionId) OR attribute_type(claudeSessionId, :nullType))',
      ExpressionAttributeValues: {
        ':cid': claudeSessionId,
        ':nullType': 'NULL',
      },
    }),
  );
}

async function partyIncrementTurn(sessionId) {
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'ADD turnCount :one SET lastTurnAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    }),
  );
}

async function partyReleaseSessionLock(sessionId, finalStatus) {
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, lastTurnAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':s': finalStatus,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

function buildPartyCtx() {
  return {
    pushEvent,
    updateProjectState: updatePartyProjectState,
    expectedBmadVersion: PARTY_BMAD_VERSION,
    customAgentsSourceDir: PARTY_BMAD_AGENTS_SOURCE,
    customAgentsSourceRepo: PARTY_BMAD_AGENTS_SOURCE_REPO,
    expectedAgentCount: PARTY_EXPECTED_AGENT_COUNT,
    projectsRoot: PARTY_PROJECTS_ROOT,
  };
}

async function executePartyBootstrapJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validatePartyBootstrapJob(job);
  if (!validation.ok) {
    throw new Error(`party-bootstrap job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to party-bootstrap pipeline`, {
    projectId: job.partyBootstrapPayload?.projectId,
    projectPath: job.partyBootstrapPayload?.projectPath,
    forceReinstall: job.partyBootstrapPayload?.forceReinstall === true,
  });

  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.stepId = 'party-bootstrap';
    entry.agentId = '__party__';
  }

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-bootstrap',
    lastHeartbeatAt: new Date().toISOString(),
  });

  await runPartyBootstrap(job, buildPartyCtx());

  await updateJobFields(jobId, { status: 'COMPLETED' });
  log('info', `[${short}] party-bootstrap completed`);
}

async function executePartyInspectJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validatePartyInspectJob(job);
  if (!validation.ok) {
    throw new Error(`party-inspect job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to party-inspect pipeline`, {
    projectId: job.partyInspectPayload?.projectId,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-inspect',
    lastHeartbeatAt: new Date().toISOString(),
  });

  await runPartyInspect(job, buildPartyCtx());

  await updateJobFields(jobId, { status: 'COMPLETED' });
  log('info', `[${short}] party-inspect completed`);
}

async function executePartyTurnJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validatePartyTurnJob(job);
  if (!validation.ok) {
    throw new Error(`party-turn job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to party-turn pipeline`, {
    sessionId: job.partyTurnPayload?.sessionId,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-turn',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    await runPartyTurn(job, {
      pushEvent,
      getSession: partyGetSession,
      getProject: partyGetProject,
      setClaudeSessionId: partySetClaudeSessionId,
      incrementTurn: partyIncrementTurn,
      releaseSessionLock: partyReleaseSessionLock,
      claudeBin: CLAUDE_BIN,
      spawn,
      // ANTHROPIC_API_KEY is set on process.env by loadApiKeyFromSsm; the
      // spawned child inherits it via the default env-inheritance path.
      env: {},
      logger: {
        info: (msg) => log('info', msg),
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
      },
    });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] party-turn completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] party-turn failed: ${err?.message || err}`);
    throw err;
  }
}

async function executePartyDocsSyncJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);
  const validation = validatePartyDocsSyncJob(job);
  if (!validation.ok) {
    throw new Error(`party-docs-sync job rejected: ${validation.reason}`);
  }
  log('info', `[${short}] Routing to party-docs-sync pipeline`, {
    projectId: job.partyDocsSyncPayload?.projectId,
    filename: job.partyDocsSyncPayload?.filename,
  });
  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-docs-sync',
    lastHeartbeatAt: new Date().toISOString(),
  });
  try {
    await runPartyDocsSync(job, { pushEvent });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] party-docs-sync completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] party-docs-sync failed: ${err?.message || err}`);
    throw err;
  }
}

async function executePartyDocsUnlinkJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);
  const validation = validatePartyDocsUnlinkJob(job);
  if (!validation.ok) {
    throw new Error(`party-docs-unlink job rejected: ${validation.reason}`);
  }
  log('info', `[${short}] Routing to party-docs-unlink pipeline`, {
    projectId: job.partyDocsUnlinkPayload?.projectId,
    filename: job.partyDocsUnlinkPayload?.filename,
  });
  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-docs-unlink',
    lastHeartbeatAt: new Date().toISOString(),
  });
  try {
    await runPartyDocsUnlink(job, { pushEvent });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] party-docs-unlink completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] party-docs-unlink failed: ${err?.message || err}`);
    throw err;
  }
}

// Pipeline v2 / Story 1.4.3 — App-bootstrap saga executor.
//
// Reads + writes the futurator-apps row directly via the daemon's `ddb` client
// (the daemon doesn't import the TS repository module). Re-uses the party
// context for the BMAD step and the shared attention-writer for failure
// surfacing.
async function getAppRow(appId) {
  const result = await ddb.send(
    new GetCommand({ TableName: APPS_TABLE, Key: { appId } }),
  );
  return result.Item || null;
}

async function patchAppRow(appId, patch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);
  const names = {};
  const values = {};
  const expressions = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    expressions.push(`#${k} = :${k}`);
  }
  await ddb.send(
    new UpdateCommand({
      TableName: APPS_TABLE,
      Key: { appId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(appId)',
    }),
  );
}

async function executeAppBootstrapJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateAppBootstrapJob(job);
  if (!validation.ok) {
    throw new Error(`app-bootstrap job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to app-bootstrap pipeline`, {
    appId: job.appBootstrapPayload?.appId,
    boilerplateType: job.appBootstrapPayload?.boilerplateType,
    bmadEnabled: job.appBootstrapPayload?.bmadEnabled === true,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'app-bootstrap',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    await runAppBootstrap(job, {
      pushEvent,
      getApp: getAppRow,
      updateApp: patchAppRow,
      writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
      partyCtx: buildPartyCtx(),
      runPartyBootstrap,
    });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] app-bootstrap completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] app-bootstrap failed: ${err?.message || err}`);
    throw err;
  }
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
    } else if (handler === JOB_HANDLER_PARTY_BOOTSTRAP) {
      await executePartyBootstrapJob(job);
    } else if (handler === JOB_HANDLER_PARTY_INSPECT) {
      await executePartyInspectJob(job);
    } else if (handler === JOB_HANDLER_PARTY_TURN) {
      await executePartyTurnJob(job);
    } else if (handler === JOB_HANDLER_PARTY_DOCS_SYNC) {
      await executePartyDocsSyncJob(job);
    } else if (handler === JOB_HANDLER_PARTY_DOCS_UNLINK) {
      await executePartyDocsUnlinkJob(job);
    } else if (handler === JOB_HANDLER_APP_BOOTSTRAP) {
      await executeAppBootstrapJob(job);
    } else {
      await executePipeline(job);
    }
  } catch (err) {
    log('error', `[${job.jobId.slice(0, 8)}] Job failed: ${err.message}`);
    try {
      await handleJobFailure(job, err);
    } catch (updateErr) {
      log('error', `[${job.jobId.slice(0, 8)}] Failure handler failed: ${updateErr.message}`);
    }
  } finally {
    activeJobs.delete(job.jobId);
    jobEventSeqs.delete(job.jobId);
  }
}

/**
 * Pipeline Enhancement Plan v2 — Phase A.3. Decide between retrying the job
 * (re-queue as PENDING with a backoff) or marking it FAILED for good.
 * Non-retriable: shell-guard violations, auth failures, and jobs that
 * already exhausted MAX_RETRIES.
 */
async function handleJobFailure(job, err) {
  const message = err?.message || String(err);
  // Conversational turns (party-turn) must NEVER silently retry — a retry
  // re-emits `party.turn.user` with the same content and re-runs Claude,
  // producing a duplicate round in the UI. Fail visibly; the user sees the
  // error banner and chooses whether to resend.
  const isConversationalTurn = job.jobType === 'party-turn';
  const nonRetriable =
    err?.name === 'ShellGuardViolation' ||
    /OAuth expired|authentication expired|Not logged in|Please run \/login/i.test(message) ||
    isConversationalTurn;

  // T0.3 — Pipeline v2.0 efficiency fix.
  // Story pipelines (per-story DEV→REVIEWER→COMPILER) get a tighter budget:
  // a no-op story that DEV genuinely fails on shouldn't retry up to the
  // generic 3-attempt ladder ($5+ per attempt). Default 2 attempts (1 retry).
  // T0.1 catches the COST_HARD-after-DONE case; this is the safety net for
  // genuine pre-DONE failures.
  const isStoryPipeline = Boolean(job.pipeline?.initialVariables?.STORY_ID);
  const effectiveMaxRetries = isStoryPipeline ? STORY_PIPELINE_MAX_RETRIES : MAX_RETRIES;

  const currentAttempt = job.retryAttempt || 0;
  const nextAttempt = currentAttempt + 1;
  const canRetry = !nonRetriable && nextAttempt <= effectiveMaxRetries;

  if (canRetry) {
    // Story pipelines reuse the same backoff ladder, just truncated.
    const delayMs = RETRY_DELAYS_MS[currentAttempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    const retryAfter = new Date(Date.now() + delayMs).toISOString();
    log(
      'warn',
      `[${job.jobId.slice(0, 8)}] retry ${nextAttempt}/${effectiveMaxRetries} scheduled for ${retryAfter} (delay ${delayMs}ms)${isStoryPipeline ? ' [story-pipeline]' : ''}`,
    );
    await updateJobFields(job.jobId, {
      status: 'PENDING',
      retryAttempt: nextAttempt,
      retryAfter,
      errorMessage: `retry ${nextAttempt}/${effectiveMaxRetries} queued: ${message}`.slice(0, 500),
    });
    return;
  }

  // Final failure: mark FAILED and emit a retry-exhausted attention item
  // (skip the attention item for non-retriable auth errors — operator needs
  // to see the fix-auth banner, not a stale item).
  await updateJobFields(job.jobId, {
    status: 'FAILED',
    errorMessage: nonRetriable
      ? message
      : `retry exhausted after ${effectiveMaxRetries} attempts: ${message}`,
    // T0.3 — surface the trigger reason on the job row so the UI can
    // disambiguate "step failed once" from "exhausted dev budget".
    ...(isStoryPipeline && !nonRetriable
      ? { triggeredBy: 'DEV_RETRY_BUDGET_EXHAUSTED' }
      : {}),
  });

  if (!nonRetriable) {
    try {
      const planId = await resolvePlanIdFromEpicId(ddb, job.epicId);
      if (planId) {
        // T0.3: distinct attention category for story-pipeline budget exhaustion
        // so operators can spot dev-loop pathologies at a glance and the inbox
        // can render targeted resolution actions (Salvage with last
        // WORK_SUMMARY vs. generic Retry).
        const category = isStoryPipeline ? 'dev-retry-exhausted' : 'retry-exhausted';
        const title = isStoryPipeline
          ? `Story DEV exhausted retry budget (${effectiveMaxRetries + 1} attempts)`
          : `Step failed after ${effectiveMaxRetries} retries`;
        const body = isStoryPipeline
          ? `Story DEV step failed ${effectiveMaxRetries + 1} time(s) without emitting ---DONE---. ` +
            `If the scaffold already implements the AC, salvage with the last WORK_SUMMARY. ` +
            `Final error: ${message.slice(0, 300)}`
          : `Step exhausted its retry budget (${RETRY_DELAYS_MS
              .map((d) => `${Math.round(d / 1000)}s`)
              .join(' / ')}). Final error: ${message.slice(0, 300)}`;
        await writeAttentionItem(
          ddb,
          {
            planId,
            severity: 'high',
            category,
            title,
            body,
            context: {
              jobId: job.jobId,
              epicId: job.epicId,
              ...(isStoryPipeline ? { storyId: job.pipeline?.initialVariables?.STORY_ID } : {}),
            },
            suggestedActions: isStoryPipeline
              ? [
                  { label: 'Salvage with last WORK_SUMMARY', kind: 'salvage-step' },
                  { label: 'Retry step', kind: 'retry-step' },
                  { label: 'Skip story', kind: 'skip-step' },
                  { label: 'Open logs', kind: 'open-logs' },
                ]
              : [
                  { label: 'Retry step', kind: 'retry-step' },
                  { label: 'Open logs', kind: 'open-logs' },
                  { label: 'Open story', kind: 'open-story' },
                ],
          },
          log,
        );
      }
    } catch (attnErr) {
      log('error', `Failed to write retry-exhausted attention item: ${attnErr.message}`);
    }
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
  log('info', `  OAuth file: ${OAUTH_CREDS_PATH}`);

  loadOAuth('startup');
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
    const epicRepo = createEpicRepo({ ddb, tableName: EPICS_TABLE });
    daemonReceiver = createDaemonReceiver({
      ddb,
      jobsTable: JOBS_TABLE,
      epicRepo,
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

  // Re-check OAuth + probe on a slow interval. The Mac helper pushes fresh
  // tokens on a similar cadence (and on-demand via the UI button), so we
  // don't need to spin.
  setInterval(() => {
    loadOAuth('interval');
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
        const nowIso = new Date().toISOString();
        const { Items } = await ddb.send(
          new QueryCommand({
            TableName: JOBS_TABLE,
            IndexName: 'status-createdAt-index',
            KeyConditionExpression: '#s = :pending',
            // Pipeline Enhancement Plan v2 — Phase A.3: skip jobs still
            // inside their retry backoff window (retryAfter > now).
            FilterExpression: 'attribute_not_exists(retryAfter) OR retryAfter <= :now',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':pending': 'PENDING', ':now': nowIso },
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

// ── Shell-guard violation → attention item ──
//
// Pipeline Enhancement Plan v2 — Phase A.2. Called by spawn wrappers when
// shell-guard refuses a spawn. Looks up planId via job.epicId and writes a
// high-severity policy-violation attention item. Never throws.
function handleGuardViolation(jobId, details) {
  (async () => {
    try {
      const row = await ddb.send(
        new GetCommand({
          TableName: JOBS_TABLE,
          Key: { jobId },
          ProjectionExpression: 'epicId',
        }),
      );
      const epicId = row.Item?.epicId;
      const planId = await resolvePlanIdFromEpicId(ddb, epicId);
      if (!planId) return;
      const reason =
        details?.kind === 'cwd'
          ? `cwd "${details.cwd}" escaped allowed roots`
          : details?.kind === 'arg'
            ? `${details.command} arg "${details.arg}" escaped allowed roots`
            : details?.kind === 'script'
              ? `bash script: ${details.command} targets "${details.arg}" outside allowed roots`
              : 'spawn refused by shell-guard';
      await writeAttentionItem(
        ddb,
        {
          planId,
          severity: 'high',
          category: 'policy-violation',
          title: 'Shell-guard refused a spawn',
          body:
            `The daemon's shell-guard refused a spawn because it escaped the ` +
            `allowed project roots. Step: ${details?.stepId || 'n/a'}. Reason: ${reason}. ` +
            `The step failed cleanly — no processes were created.`,
          context: {
            jobId,
            epicId,
            stepId: details?.stepId,
          },
          suggestedActions: [
            { label: 'Open logs', kind: 'open-logs' },
            { label: 'Open story', kind: 'open-story' },
          ],
        },
        log,
      );
    } catch (err) {
      log('error', `handleGuardViolation failed: ${err.message}`);
    }
  })();
}

// ── Graceful shutdown ──
//
// Pipeline Enhancement Plan v2 — Phase A.1.
// On SIGTERM/SIGINT: stop accepting new work, SIGTERM every tracked child,
// wait up to GRACEFUL_SHUTDOWN_MS (default 30s), then SIGKILL stragglers.
// Children that exit cleanly within the window let their own close handlers
// update job status; only the SIGKILL'd jobs get marked FAILED here and get
// a daemon-shutdown-timeout attention item.

async function shutdown(signal) {
  const initialActive = activeJobs.size;
  const initialChildren = getChildCount();
  log(
    'warn',
    `Received ${signal}. Graceful shutdown begun — ${initialActive} active jobs, ${initialChildren} tracked children, ${GRACEFUL_SHUTDOWN_MS}ms window`,
  );
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

  // Step 1: SIGTERM every tracked child so they can flush and exit cleanly.
  const signaled = signalAllChildren('SIGTERM');
  log('info', `SIGTERM sent to ${signaled} tracked children — waiting up to ${GRACEFUL_SHUTDOWN_MS}ms`);

  // Step 2: wait for children to exit, or the window elapses.
  const allExited = await waitForAllChildrenToExit(GRACEFUL_SHUTDOWN_MS);

  if (allExited) {
    log('info', 'All tracked children exited within graceful window');
  } else {
    // Step 3: SIGKILL stragglers and record which jobs got force-killed.
    const survivors = [];
    for (const jobId of activeJobs.keys()) {
      survivors.push(jobId);
    }
    const killed = killAllChildren();
    log(
      'warn',
      `Graceful window elapsed — SIGKILL'd ${killed} children; ${survivors.length} jobs will be marked FAILED with daemon-shutdown-timeout`,
    );

    // Step 4: mark surviving jobs FAILED + emit an attention item each.
    for (const jobId of survivors) {
      try {
        await updateJobFields(jobId, {
          status: 'FAILED',
          errorMessage: `Daemon ${signal} — step did not exit within ${GRACEFUL_SHUTDOWN_MS}ms graceful window`,
        });
      } catch (err) {
        log('error', `Failed to update job on shutdown: ${err.message}`);
      }

      // Resolve planId via the job's epicId for the attention item.
      try {
        const row = await ddb.send(
          new GetCommand({
            TableName: JOBS_TABLE,
            Key: { jobId },
            ProjectionExpression: 'epicId',
          }),
        );
        const epicId = row.Item?.epicId;
        const planId = await resolvePlanIdFromEpicId(ddb, epicId);
        if (planId) {
          await writeAttentionItem(
            ddb,
            {
              planId,
              severity: 'medium',
              category: 'daemon-shutdown-timeout',
              title: `Daemon ${signal} during running step`,
              body:
                `The daemon received ${signal} and the in-flight step did not exit within the ` +
                `${GRACEFUL_SHUTDOWN_MS}ms graceful window. The step was force-killed and the job ` +
                `was marked FAILED. Retry the step when the daemon is back up.`,
              context: { jobId, epicId },
              suggestedActions: [
                { label: 'Open story', kind: 'open-story' },
                { label: 'Retry step', kind: 'retry-step' },
              ],
            },
            log,
          );
        }
      } catch (err) {
        log('error', `Failed to write shutdown attention item: ${err.message}`);
      }
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// SIGUSR1 = fresh OAuth tokens just landed at OAUTH_CREDS_PATH — re-read the
// file and re-probe. Triggered by scripts/mac-oauth-sync.sh (the Mac →
// Keychain → SSM pipeline) after a successful push. No restart, no killed
// jobs — in-flight spawns keep their own env and new spawns get the new file.
process.on('SIGUSR1', async () => {
  log('info', 'SIGUSR1 received — reloading OAuth and re-probing');
  try {
    loadOAuth('sigusr1');
    await probeAuth();
  } catch (err) {
    log('error', `SIGUSR1 reload failed: ${err.message}`);
  }
});

// Story 1.1.3 — configure git identity (PAT from SSM → global git config)
// before the main poll loop. Idempotent. Failure here is fatal because every
// git op the daemon will subsequently run depends on it.
async function configureGitIdentity() {
  if (process.env.SKIP_GIT_IDENTITY === '1') {
    log('info', 'configure-git-identity skipped (SKIP_GIT_IDENTITY=1)');
    return;
  }
  const scriptPath = new URL('./scripts/configure-git-identity.sh', import.meta.url).pathname;
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { stdio: 'inherit' });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`configure-git-identity.sh exited ${code}`));
    });
    child.on('error', reject);
  });
}

(async () => {
  try {
    await configureGitIdentity();
  } catch (err) {
    log('error', `configure-git-identity failed: ${err.message}`);
    log('error', 'Daemon refusing to start — fix PAT or set SKIP_GIT_IDENTITY=1 to bypass.');
    process.exit(3);
  }
  poll();
})();
