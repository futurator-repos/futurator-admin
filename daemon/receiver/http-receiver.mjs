/**
 * Daemon-local HTTP receiver (Observability Spine §5).
 *
 * Binds to 127.0.0.1 only — trust boundary is the loopback interface,
 * so no auth is required. Endpoints:
 *
 *   POST /wave-complete  { jobId, epicId, wave, results }
 *     → agent-jobs row: waveResults[<wave>] = { ...results, epicId, persistedAt }
 *
 *   POST /heartbeat      { jobId, ts? }
 *     → agent-jobs row: lastHeartbeatAt = ts
 *
 *   POST /story-status   { jobId?, epicId, storyId, status }
 *     → epic-workflows row: stories[i].status = <status> (epicRepo required)
 *
 * DynamoDB client is injected so tests can swap it for an in-memory fake.
 */

import { createServer } from 'node:http';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17631;
const BODY_LIMIT_BYTES = 64 * 1024;

export function createDaemonReceiver({
  ddb,
  jobsTable,
  epicRepo = null,
  logger = console,
  now = () => new Date().toISOString(),
} = {}) {
  if (!ddb || typeof ddb.send !== 'function') {
    throw new Error('createDaemonReceiver: ddb client with send() is required');
  }
  if (!jobsTable || typeof jobsTable !== 'string') {
    throw new Error('createDaemonReceiver: jobsTable is required');
  }

  const ALLOWED_STORY_STATUSES = new Set([
    'pending',
    'running',
    'in_review',
    'fixing',
    'done',
    'failed',
    'skipped',
    'blocked',
  ]);

  let server = null;

  async function handleWaveComplete(body) {
    const { jobId, epicId, wave, results } = body || {};
    if (!jobId || typeof wave !== 'number' || !Number.isFinite(wave)) {
      return { status: 400, body: { ok: false, error: 'jobId and numeric wave required' } };
    }
    const persistedAt = now();

    // Seed waveResults as an empty map on first write; idempotent if it exists.
    await ddb.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression: 'SET #wr = if_not_exists(#wr, :empty)',
        ExpressionAttributeNames: { '#wr': 'waveResults' },
        ExpressionAttributeValues: { ':empty': {} },
      }),
    );

    await ddb.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression: 'SET #wr.#w = :r, updatedAt = :ts',
        ExpressionAttributeNames: { '#wr': 'waveResults', '#w': String(wave) },
        ExpressionAttributeValues: {
          ':r': { ...(results || {}), epicId, persistedAt },
          ':ts': persistedAt,
        },
      }),
    );

    return { status: 200, body: { ok: true, persistedAt } };
  }

  async function handleStoryStatus(body) {
    const { jobId, epicId, storyId, status } = body || {};
    if (!epicId || !storyId || !status) {
      return {
        status: 400,
        body: { ok: false, error: 'epicId, storyId, status required' },
      };
    }
    if (!ALLOWED_STORY_STATUSES.has(status)) {
      return {
        status: 400,
        body: { ok: false, error: `invalid status: ${status}` },
      };
    }
    if (!epicRepo || typeof epicRepo.updateStoryStatus !== 'function') {
      return {
        status: 503,
        body: { ok: false, error: 'epicRepo not configured on receiver' },
      };
    }
    const result = await epicRepo.updateStoryStatus(epicId, storyId, status);
    return {
      status: result.updated ? 200 : 404,
      body: { ...result, jobId, epicId, storyId, status },
    };
  }

  async function handleHeartbeat(body) {
    const { jobId, ts } = body || {};
    if (!jobId) {
      return { status: 400, body: { ok: false, error: 'jobId required' } };
    }
    const at = typeof ts === 'string' && ts.length > 0 ? ts : now();
    await ddb.send(
      new UpdateCommand({
        TableName: jobsTable,
        Key: { jobId },
        UpdateExpression: 'SET lastHeartbeatAt = :ts',
        ExpressionAttributeValues: { ':ts': at },
      }),
    );
    return { status: 200, body: { ok: true } };
  }

  function requestHandler(req, res) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'POST only' });
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        aborted = true;
        writeJson(res, 413, { ok: false, error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (aborted || res.writableEnded) return;
      let body;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        body = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        writeJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }

      try {
        let result;
        if (req.url === '/wave-complete') {
          result = await handleWaveComplete(body);
        } else if (req.url === '/heartbeat') {
          result = await handleHeartbeat(body);
        } else if (req.url === '/story-status') {
          result = await handleStoryStatus(body);
        } else {
          result = { status: 404, body: { ok: false, error: 'not found' } };
        }
        writeJson(res, result.status, result.body);
      } catch (err) {
        logger.error?.(`[receiver] ${req.url} failed: ${err.message}`);
        writeJson(res, 500, { ok: false, error: err.message });
      }
    });

    req.on('error', () => {
      if (!res.writableEnded) writeJson(res, 400, { ok: false, error: 'request error' });
    });
  }

  function listen(port = DEFAULT_PORT, host = DEFAULT_HOST) {
    return new Promise((resolve, reject) => {
      server = createServer(requestHandler);
      server.once('error', reject);
      server.listen(port, host, () => {
        logger.info?.(`[receiver] listening on ${host}:${port}`);
        resolve(server.address());
      });
    });
  }

  async function close() {
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }

  return { listen, close };
}

function writeJson(res, status, body) {
  if (res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}
