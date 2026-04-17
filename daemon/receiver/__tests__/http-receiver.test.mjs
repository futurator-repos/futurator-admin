import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDaemonReceiver } from '../http-receiver.mjs';

function silentLogger() {
  return { warn: () => {}, error: () => {}, info: () => {} };
}

function createFakeDdb({ failAt = null } = {}) {
  const calls = [];
  let callIdx = 0;
  return {
    calls,
    send: async (cmd) => {
      callIdx += 1;
      calls.push({ type: cmd.constructor.name, input: cmd.input });
      if (failAt !== null && callIdx === failAt) {
        throw new Error('simulated DDB failure');
      }
      return { Attributes: {} };
    },
  };
}

async function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // leave as string
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

async function getReq(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('daemon HTTP receiver', () => {
  it('rejects missing constructor args', () => {
    expect(() => createDaemonReceiver({ jobsTable: 't' })).toThrow(/ddb client/);
    expect(() => createDaemonReceiver({ ddb: { send: () => {} } })).toThrow(/jobsTable/);
  });

  describe('listening server', () => {
    let ddb;
    let receiver;
    let port;

    beforeEach(async () => {
      ddb = createFakeDdb();
      receiver = createDaemonReceiver({
        ddb,
        jobsTable: 'test-jobs',
        logger: silentLogger(),
        now: () => '2026-04-17T00:00:00.000Z',
      });
      const addr = await receiver.listen(0, '127.0.0.1');
      port = addr.port;
    });

    afterEach(async () => {
      await receiver.close();
    });

    it('POST /wave-complete persists waveResults and returns persistedAt', async () => {
      const res = await postJson(port, '/wave-complete', {
        jobId: 'job-1',
        epicId: 'E-1',
        wave: 2,
        results: { stories: [{ storyId: 'S-1', status: 'passed' }] },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, persistedAt: '2026-04-17T00:00:00.000Z' });
      expect(ddb.calls).toHaveLength(2);
      expect(ddb.calls[0].input.UpdateExpression).toBe('SET #wr = if_not_exists(#wr, :empty)');
      expect(ddb.calls[1].input.UpdateExpression).toBe('SET #wr.#w = :r, updatedAt = :ts');
      expect(ddb.calls[1].input.ExpressionAttributeNames['#w']).toBe('2');
      expect(ddb.calls[1].input.ExpressionAttributeValues[':r']).toMatchObject({
        epicId: 'E-1',
        persistedAt: '2026-04-17T00:00:00.000Z',
        stories: [{ storyId: 'S-1', status: 'passed' }],
      });
    });

    it('POST /wave-complete: rejects missing jobId', async () => {
      const res = await postJson(port, '/wave-complete', { epicId: 'E-1', wave: 1 });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(ddb.calls).toHaveLength(0);
    });

    it('POST /wave-complete: rejects non-numeric wave', async () => {
      const res = await postJson(port, '/wave-complete', { jobId: 'j', epicId: 'E', wave: 'two' });
      expect(res.status).toBe(400);
      expect(ddb.calls).toHaveLength(0);
    });

    it('POST /heartbeat updates lastHeartbeatAt using provided ts', async () => {
      const ts = '2026-04-17T12:00:00.000Z';
      const res = await postJson(port, '/heartbeat', { jobId: 'job-hb', ts });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(ddb.calls).toHaveLength(1);
      expect(ddb.calls[0].input.UpdateExpression).toBe('SET lastHeartbeatAt = :ts');
      expect(ddb.calls[0].input.ExpressionAttributeValues[':ts']).toBe(ts);
    });

    it('POST /heartbeat stamps now() when ts missing', async () => {
      const res = await postJson(port, '/heartbeat', { jobId: 'job-hb-2' });
      expect(res.status).toBe(200);
      expect(ddb.calls[0].input.ExpressionAttributeValues[':ts']).toBe('2026-04-17T00:00:00.000Z');
    });

    it('POST /heartbeat rejects missing jobId', async () => {
      const res = await postJson(port, '/heartbeat', {});
      expect(res.status).toBe(400);
      expect(ddb.calls).toHaveLength(0);
    });

    it('returns 404 for unknown paths', async () => {
      const res = await postJson(port, '/nope', {});
      expect(res.status).toBe(404);
    });

    it('returns 405 for non-POST methods', async () => {
      const res = await getReq(port, '/wave-complete');
      expect(res.status).toBe(405);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await postJson(port, '/heartbeat', '{not json');
      expect(res.status).toBe(400);
    });
  });

  it('binds to 127.0.0.1 only (loopback)', async () => {
    const receiver = createDaemonReceiver({
      ddb: createFakeDdb(),
      jobsTable: 't',
      logger: silentLogger(),
    });
    const addr = await receiver.listen(0, '127.0.0.1');
    try {
      expect(addr.address).toBe('127.0.0.1');
    } finally {
      await receiver.close();
    }
  });

  it('uses UpdateCommand from lib-dynamodb', async () => {
    const ddb = createFakeDdb();
    const receiver = createDaemonReceiver({ ddb, jobsTable: 't', logger: silentLogger() });
    const addr = await receiver.listen(0, '127.0.0.1');
    try {
      await postJson(addr.port, '/heartbeat', { jobId: 'j' });
      expect(ddb.calls[0].type).toBe(UpdateCommand.name);
    } finally {
      await receiver.close();
    }
  });

  it('propagates DDB errors as 500', async () => {
    const ddb = createFakeDdb({ failAt: 1 });
    const receiver = createDaemonReceiver({ ddb, jobsTable: 't', logger: silentLogger() });
    const addr = await receiver.listen(0, '127.0.0.1');
    try {
      const res = await postJson(addr.port, '/heartbeat', { jobId: 'j' });
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    } finally {
      await receiver.close();
    }
  });
});
