/**
 * NDJSON forwarder (Observability Spine §4).
 *
 * Tails per-job NDJSON files under logDir, assigns monotonic eventSeq per
 * jobId, writes to DynamoDB idempotently (ConditionExpression), and
 * checkpoints the file offset AFTER the successful DDB write so a crash
 * between steps re-tries the same line instead of skipping it.
 *
 * The module takes an injected `store` adapter so the AWS SDK sits outside
 * the hot path and tests can swap it for an in-memory fake.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, basename } from 'node:path';

const DEFAULT_POLL_MS = 250;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const SEQ_PAD = 6;

export function createNdjsonForwarder({
  logDir,
  store,
  pollMs = DEFAULT_POLL_MS,
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (!logDir || typeof logDir !== 'string') {
    throw new Error('createNdjsonForwarder: logDir is required');
  }
  if (!store || typeof store.putEvent !== 'function' || typeof store.queryMaxSeq !== 'function') {
    throw new Error('createNdjsonForwarder: store must implement putEvent() and queryMaxSeq()');
  }

  const seqByJob = new Map();
  const tails = new Map();
  let rescanTimer = null;
  let stopped = false;

  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  async function start() {
    stopped = false;
    scan();
    rescanTimer = setInterval(scan, pollMs * 4);
    if (typeof rescanTimer.unref === 'function') rescanTimer.unref();
  }

  async function stop() {
    stopped = true;
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    for (const tail of tails.values()) {
      if (tail.timer) clearInterval(tail.timer);
    }
    tails.clear();
  }

  async function drainAll() {
    const jobs = Array.from(tails.keys());
    await Promise.all(jobs.map((jobId) => processOnce(jobId)));
  }

  function scan() {
    if (stopped) return;
    if (!existsSync(logDir)) return;
    const entries = readdirSync(logDir).filter((f) => f.endsWith('.ndjson'));
    for (const file of entries) {
      const jobId = basename(file, '.ndjson');
      if (!tails.has(jobId)) addTail(jobId, join(logDir, file));
    }
  }

  function addTail(jobId, filePath) {
    const state = {
      jobId,
      filePath,
      offsetPath: `${filePath}.offset`,
      offset: readOffset(`${filePath}.offset`),
      lastMtimeMs: 0,
      busy: false,
      timer: null,
    };
    state.timer = setInterval(() => {
      if (stopped) return;
      void processTail(state);
    }, pollMs);
    if (typeof state.timer.unref === 'function') state.timer.unref();
    tails.set(jobId, state);
  }

  async function processOnce(jobId) {
    const state = tails.get(jobId);
    if (!state) return;
    await processTail(state);
  }

  async function processTail(state) {
    if (state.busy) return;
    state.busy = true;
    try {
      if (!existsSync(state.filePath)) return;
      const stats = statSync(state.filePath);

      const truncated =
        stats.size < state.offset ||
        (state.offset > 0 &&
          stats.size <= state.offset &&
          stats.mtimeMs > state.lastMtimeMs);

      if (truncated) {
        logger.warn?.(`[forwarder] ${state.jobId}: truncation detected (size=${stats.size}, offset=${state.offset}); resetting`);
        state.offset = 0;
        seqByJob.delete(state.jobId);
        writeOffset(state.offsetPath, 0);
      }

      state.lastMtimeMs = stats.mtimeMs;

      if (stats.size === state.offset) return;

      const { lines, newOffset } = readNewLines(state.filePath, state.offset, stats.size);
      for (const line of lines) {
        if (stopped) break;
        const ok = await handleLine(state.jobId, line);
        if (!ok) return;
        state.offset += Buffer.byteLength(line, 'utf8') + 1;
        writeOffset(state.offsetPath, state.offset);
      }

      if (stopped) return;
      if (state.offset < newOffset) {
        state.offset = newOffset;
        writeOffset(state.offsetPath, state.offset);
      }
    } catch (err) {
      logger.error?.(`[forwarder] ${state.jobId}: tail error: ${err.message}`);
    } finally {
      state.busy = false;
    }
  }

  async function handleLine(jobId, line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (err) {
      logger.warn?.(`[forwarder] ${jobId}: malformed NDJSON line skipped: ${err.message}`);
      return true;
    }

    if (event.jobId && event.jobId !== jobId) {
      logger.warn?.(`[forwarder] ${jobId}: line has mismatched jobId=${event.jobId}; skipping`);
      return true;
    }

    const seq = await nextSeq(jobId);
    const enriched = enrich(jobId, seq, event, now());

    try {
      await store.putEvent(enriched);
      return true;
    } catch (err) {
      if (isConditionFailed(err)) {
        logger.warn?.(`[forwarder] ${jobId}: duplicate eventSeq=${enriched.eventSeq} (already forwarded); skipping`);
        return true;
      }
      logger.error?.(`[forwarder] ${jobId}: DDB putEvent failed: ${err.message}`);
      rollbackSeq(jobId);
      return false;
    }
  }

  async function nextSeq(jobId) {
    if (!seqByJob.has(jobId)) {
      const max = await store.queryMaxSeq(jobId);
      seqByJob.set(jobId, max);
    }
    const next = seqByJob.get(jobId) + 1;
    seqByJob.set(jobId, next);
    return next;
  }

  function rollbackSeq(jobId) {
    const current = seqByJob.get(jobId);
    if (typeof current === 'number' && current > 0) {
      seqByJob.set(jobId, current - 1);
    }
  }

  return { start, stop, drainAll };
}

function readOffset(offsetPath) {
  if (!existsSync(offsetPath)) return 0;
  const raw = readFileSync(offsetPath, 'utf8').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeOffset(offsetPath, offset) {
  writeFileSync(offsetPath, `${offset}\n`);
}

function readNewLines(filePath, from, to) {
  const length = to - from;
  if (length <= 0) return { lines: [], newOffset: from };
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, from);
    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n');

    let newOffset = to;
    if (!chunk.endsWith('\n')) {
      const partial = lines.pop() || '';
      newOffset = to - Buffer.byteLength(partial, 'utf8');
    } else {
      lines.pop();
    }
    return { lines, newOffset };
  } finally {
    closeSync(fd);
  }
}

function enrich(jobId, seq, event, tsMillis) {
  const eventSeq = String(seq).padStart(SEQ_PAD, '0');
  const ts = event.ts ?? tsMillis;
  const correlationId =
    event.correlationId ||
    composeCorrelation(event.epicId, event.waveNumber, event.storyId, event.role, event.attempt);

  return {
    jobId,
    eventSeq,
    seq,
    timestamp: new Date(ts).toISOString(),
    stepId: event.stepId || event.storyId || '-',
    agentId: event.agentId || event.subagentId || event.role || 'orchestrator',
    eventType: event.eventType,
    epicId: event.epicId,
    waveNumber: event.waveNumber,
    storyId: event.storyId,
    role: event.role,
    subagentId: event.subagentId,
    attempt: event.attempt,
    correlationId,
    payload: event.payload,
    expireAt: Math.floor(tsMillis / 1000) + SEVEN_DAYS_SECONDS,
  };
}

function composeCorrelation(epicId, wave, storyId, role, attempt) {
  if (!epicId) return undefined;
  const waveStr = typeof wave === 'number' ? `wave-${wave}` : '-';
  const s = storyId || '-';
  const r = role || '-';
  const a = typeof attempt === 'number' ? attempt : '-';
  return `${epicId}/${waveStr}/${s}/${r}/${a}`;
}

function isConditionFailed(err) {
  if (!err) return false;
  return (
    err.name === 'ConditionalCheckFailedException' ||
    err.__type === 'ConditionalCheckFailedException' ||
    err.code === 'ConditionalCheckFailedException'
  );
}
