/**
 * queue-request.mjs — Queues module.
 *
 * Daemon-side runner for one inbound external REST call (atlassinator,
 * applicator, gomad, mycelium, …). The API Lambda writes a `queue-requests`
 * row (RECEIVED) and enqueues an agent-job (`jobType: 'queue-request'`,
 * PENDING) carrying `queueRequestPayload`. The daemon claims it under the
 * shared ConcurrencyManager cap (same 2/3 slots as pipeline / debate /
 * free-agent), then this runner:
 *
 *   1. Prepares a single-use scratch dir for the session.
 *   2. Spawns `claude -p <prompt> --output-format stream-json --verbose
 *      --permission-mode bypassPermissions --add-dir <scratch>`.
 *   3. Parses stream-json line-by-line and mirrors it into the agent-events
 *      table via `pushEvent(jobId, …)` so the Tests tab renders a live terminal
 *      (it polls the SAME `/agent-jobs/:id/events` endpoint the pipeline uses).
 *   4. On close: assembles the final text, writes the result + COMPLETED/FAILED
 *      onto the queue-request row, and — when `autoRespond` is set — POSTs the
 *      standard JSON envelope to `callbackUrl`.
 *   5. Watchdog at 600s (SIGTERM → SIGKILL after a grace window).
 *
 * The runner is dependency-injected (spawn / pushEvent / updateRequest /
 * fetchImpl / now) so it unit-tests without a real Claude CLI or DynamoDB.
 */

import { spawn as realSpawn } from 'node:child_process';
import { mkdirSync as fsMkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

const DEFAULT_TIMEOUT_MS = Number(process.env.QUEUE_REQUEST_TIMEOUT_MS) || 600_000;
const KILL_GRACE_MS = 5_000;
const QUEUE_RUN_ROOT = process.env.QUEUE_RUN_ROOT || pathJoin(tmpdir(), 'futurator-queue-runs');
const EVENT_STEP = 'queue';
const EVENT_AGENT = '__queue__';

/**
 * @param {object} job — agent-jobs row carrying `queueRequestPayload`
 * @param {object} ctx
 * @param {Function} ctx.pushEvent       — pushEvent(jobId, stepId, agentId, eventType, data)
 * @param {Function} ctx.updateRequest   — updateRequest(requestId, patch) → queue-requests row
 * @param {string}   [ctx.claudeBin]     — default 'claude'
 * @param {typeof realSpawn} [ctx.spawn] — injectable for tests
 * @param {Function} [ctx.fetchImpl]     — injectable global-fetch for the callback POST
 * @param {number}   [ctx.timeoutMs]
 * @param {() => string} [ctx.nowIso]
 * @param {object}   [ctx.logger]        — console-like
 * @returns {Promise<{ ok: boolean, result: string, error?: string }>}
 */
export async function runQueueRequest(job, ctx) {
  const payload = job?.queueRequestPayload || {};
  const { requestId, prompt } = payload;
  const {
    pushEvent,
    updateRequest,
    claudeBin = 'claude',
    spawn = realSpawn,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    nowIso = () => new Date().toISOString(),
    logger = console,
  } = ctx || {};

  if (!requestId || typeof requestId !== 'string') {
    throw new Error('runQueueRequest: payload.requestId is required');
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('runQueueRequest: payload.prompt is required');
  }
  if (typeof pushEvent !== 'function') throw new Error('runQueueRequest: ctx.pushEvent required');
  if (typeof updateRequest !== 'function') {
    throw new Error('runQueueRequest: ctx.updateRequest required');
  }

  const jobId = job.jobId;
  const startedAt = nowIso();

  // Single-use scratch dir. Best-effort mkdir; a failure here is fatal (the CLI
  // needs a cwd), so let it throw into the caller's FAILED path.
  const workingDir = payload.workingDir || pathJoin(QUEUE_RUN_ROOT, requestId);
  fsMkdirSync(workingDir, { recursive: true });

  await updateRequest(requestId, { status: 'RUNNING', startedAt, jobId });
  await appendAudit(updateRequest, requestId, {
    at: startedAt,
    event: 'running',
    by: 'daemon',
    detail: `spawning claude in ${workingDir}`,
  });

  const args = [
    '--print',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    workingDir,
  ];
  if (payload.model) args.push('--model', String(payload.model));

  logger.info?.(
    `[queue-request] spawn request=${requestId.slice(0, 8)} job=${String(jobId).slice(0, 8)} model=${payload.model || 'default'}`,
  );

  await pushEvent(jobId, EVENT_STEP, EVENT_AGENT, 'queue.start', {
    requestId,
    source: payload.source,
    target: payload.target,
    prompt,
    model: payload.model || null,
    startedAt,
  });

  const child = spawn(claudeBin, args, {
    cwd: workingDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let timedOut = false;
  let killTimer = null;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* best effort */
        }
      }, KILL_GRACE_MS);
    } catch {
      /* best effort */
    }
  }, timeoutMs);

  let stdoutBuf = '';
  let stderrBuf = '';
  const textParts = [];
  let resultText = null;
  let resultIsError = false;

  child.stdout?.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue;
      void handleLine(line);
    }
  });

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrBuf += text;
  });

  async function handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.warn?.(`[queue-request] non-JSON stdout line: ${line.slice(0, 120)}`);
      return;
    }
    const type = parsed?.type;

    if (type === 'assistant') {
      const blocks = parsed?.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          textParts.push(block.text);
          await pushEvent(jobId, EVENT_STEP, EVENT_AGENT, 'queue.token', {
            requestId,
            text: block.text,
          });
        } else if (block?.type === 'tool_use') {
          await pushEvent(jobId, EVENT_STEP, EVENT_AGENT, 'queue.tool_use', {
            requestId,
            tool: { name: block.name, input: truncateInput(block.input) },
          });
        }
      }
      return;
    }

    if (type === 'result') {
      // The CLI's terminal event carries the assembled result + is_error.
      if (typeof parsed.result === 'string') resultText = parsed.result;
      resultIsError = parsed.is_error === true || parsed.subtype === 'error';
      return;
    }
  }

  // Wait for the process to close, then assemble + persist.
  const exitCode = await new Promise((resolve) => {
    child.on('error', (err) => {
      stderrBuf += `\nspawn error: ${err.message}`;
      resolve(-1);
    });
    child.on('close', (code) => resolve(code));
  });

  clearTimeout(watchdog);
  if (killTimer) clearTimeout(killTimer);

  const completedAt = nowIso();
  const assembled = (resultText ?? textParts.join('')).trim();
  const ok = !timedOut && exitCode === 0 && !resultIsError;

  let error;
  if (timedOut) error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
  else if (exitCode !== 0) error = `claude exited ${exitCode}${stderrBuf ? `: ${stderrBuf.slice(-500)}` : ''}`;
  else if (resultIsError) error = `claude reported an error result`;

  const response = {
    requestId,
    status: ok ? 'COMPLETED' : 'FAILED',
    ok,
    result: assembled || undefined,
    error,
    completedAt,
  };

  await updateRequest(requestId, {
    status: ok ? 'COMPLETED' : 'FAILED',
    completedAt,
    response,
    error: ok ? undefined : error,
  });
  await appendAudit(updateRequest, requestId, {
    at: completedAt,
    event: ok ? 'completed' : 'failed',
    by: 'daemon',
    detail: ok ? `result ${assembled.length} chars` : error,
  });

  await pushEvent(jobId, EVENT_STEP, EVENT_AGENT, 'queue.result', {
    requestId,
    ok,
    result: assembled,
    error,
    completedAt,
  });

  // Auto-respond: deliver the standard JSON envelope to the receiver. A failed
  // delivery does NOT fail the job — the answer is persisted on the row and the
  // operator can re-send manually from the Tests tab.
  if (payload.autoRespond && payload.callbackUrl) {
    try {
      await deliverResponse(fetchImpl, payload.callbackUrl, response);
      await updateRequest(requestId, {
        status: 'RESPONDED',
        respondedTo: payload.callbackUrl,
      });
      await appendAudit(updateRequest, requestId, {
        at: nowIso(),
        event: 'responded',
        by: 'daemon',
        detail: `auto-responded to ${payload.callbackUrl}`,
      });
    } catch (err) {
      logger.warn?.(`[queue-request] auto-respond failed: ${err.message}`);
      await appendAudit(updateRequest, requestId, {
        at: nowIso(),
        event: 'respond_failed',
        by: 'daemon',
        detail: `auto-respond to ${payload.callbackUrl} failed: ${err.message}`,
      });
    }
  }

  return { ok, result: assembled, error };
}

/** POST the standard JSON envelope to a receiver URL. Throws on non-2xx. */
export async function deliverResponse(fetchImpl, url, envelope) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) throw new Error(`receiver returned HTTP ${res.status}`);
  return res;
}

/**
 * Append one audit entry to a queue-request row. The row's `audit` is a list;
 * DynamoDB has no native list-append via our thin repo, so we read-modify-write
 * through updateRequest is avoided — instead the runner keeps audit small and
 * the API seeds `audit: []`. We use list_append here would need the repo; to
 * keep the runner repo-agnostic we accept an updateRequest that merges. The
 * daemon wires updateRequest to a helper that does a DDB list_append.
 */
async function appendAudit(updateRequest, requestId, entry) {
  // The daemon-provided updateRequest understands `{ __appendAudit: entry }`
  // and performs a DDB `list_append`. This keeps the runner free of DDB imports.
  await updateRequest(requestId, { __appendAudit: entry });
}

function truncateInput(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  } catch {
    return '[unserializable]';
  }
}
