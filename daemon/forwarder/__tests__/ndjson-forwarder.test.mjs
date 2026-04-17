import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNdjsonForwarder } from '../ndjson-forwarder.mjs';

function createFakeStore({ preloadMax = {} } = {}) {
  const writes = [];
  const maxSeq = new Map(Object.entries(preloadMax));
  const seen = new Set();
  const putEvent = async (item) => {
    const key = `${item.jobId}#${item.eventSeq}`;
    if (seen.has(key)) {
      const err = new Error('duplicate');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    seen.add(key);
    writes.push(item);
    const prev = maxSeq.get(item.jobId) || 0;
    if (item.seq > prev) maxSeq.set(item.jobId, item.seq);
  };
  const queryMaxSeq = async (jobId) => maxSeq.get(jobId) || 0;
  return { putEvent, queryMaxSeq, writes };
}

function silentLogger() {
  return { warn: () => {}, error: () => {}, info: () => {} };
}

function buildEvent(jobId, i, overrides = {}) {
  return JSON.stringify({
    jobId,
    epicId: 'EPIC-TEST',
    waveNumber: 1,
    role: 'orchestrator',
    eventType: 'wave_start',
    storyId: `STORY-${i}`,
    attempt: 1,
    payload: { i },
    ...overrides,
  });
}

function writeAll(filePath, lines) {
  writeFileSync(filePath, lines.map((l) => `${l}\n`).join(''));
}

async function waitForWrites(store, target, timeoutMs = 4000) {
  const start = Date.now();
  while (store.writes.length < target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timeout waiting for ${target} writes; got ${store.writes.length}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('NDJSON forwarder — end to end', () => {
  let logDir;
  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'ndjson-fw-'));
  });
  afterEach(() => {
    if (logDir && existsSync(logDir)) rmSync(logDir, { recursive: true, force: true });
  });

  it('validates required constructor args', () => {
    expect(() => createNdjsonForwarder({ store: {} })).toThrow(/logDir is required/);
    expect(() => createNdjsonForwarder({ logDir })).toThrow(/store must implement/);
  });

  it('forwards 100 events in order with contiguous eventSeq', async () => {
    const jobId = 'job-ordered-100';
    const file = join(logDir, `${jobId}.ndjson`);
    const store = createFakeStore();
    const fw = createNdjsonForwarder({
      logDir,
      store,
      pollMs: 20,
      logger: silentLogger(),
    });

    const lines = Array.from({ length: 100 }, (_, i) => buildEvent(jobId, i));
    writeAll(file, lines);

    await fw.start();
    await waitForWrites(store, 100);
    await fw.stop();

    expect(store.writes).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(store.writes[i].payload.i).toBe(i);
      expect(store.writes[i].eventSeq).toBe(String(i + 1).padStart(6, '0'));
      expect(store.writes[i].seq).toBe(i + 1);
    }
  });

  it('enriches missing correlationId and timestamp', async () => {
    const jobId = 'job-enrich';
    const file = join(logDir, `${jobId}.ndjson`);
    const store = createFakeStore();
    const fw = createNdjsonForwarder({
      logDir,
      store,
      pollMs: 20,
      logger: silentLogger(),
      now: () => Date.parse('2026-04-17T00:00:00Z'),
    });
    writeAll(file, [buildEvent(jobId, 0)]);
    await fw.start();
    await waitForWrites(store, 1);
    await fw.stop();

    const [event] = store.writes;
    expect(event.correlationId).toBe('EPIC-TEST/wave-1/STORY-0/orchestrator/1');
    expect(event.timestamp).toBe('2026-04-17T00:00:00.000Z');
    expect(typeof event.expireAt).toBe('number');
  });

  it('skips malformed JSON lines without halting the tail', async () => {
    const jobId = 'job-malformed';
    const file = join(logDir, `${jobId}.ndjson`);
    const store = createFakeStore();
    const fw = createNdjsonForwarder({
      logDir,
      store,
      pollMs: 20,
      logger: silentLogger(),
    });
    writeAll(file, [
      buildEvent(jobId, 0),
      'not-json',
      '{"partial": true', // missing close
      buildEvent(jobId, 2),
    ]);

    await fw.start();
    await waitForWrites(store, 2);
    await fw.stop();

    expect(store.writes.map((w) => w.payload.i)).toEqual([0, 2]);
  });

  it('handles appends after initial processing', async () => {
    const jobId = 'job-append';
    const file = join(logDir, `${jobId}.ndjson`);
    const store = createFakeStore();
    const fw = createNdjsonForwarder({ logDir, store, pollMs: 20, logger: silentLogger() });

    writeAll(file, [buildEvent(jobId, 0), buildEvent(jobId, 1)]);
    await fw.start();
    await waitForWrites(store, 2);

    appendFileSync(file, `${buildEvent(jobId, 2)}\n`);
    await waitForWrites(store, 3);

    appendFileSync(file, `${buildEvent(jobId, 3)}\n${buildEvent(jobId, 4)}\n`);
    await waitForWrites(store, 5);

    await fw.stop();
    expect(store.writes.map((w) => w.payload.i)).toEqual([0, 1, 2, 3, 4]);
  });

  it('crash-resume: no duplicates and no loss when forwarder restarts mid-flow', async () => {
    const jobId = 'job-crash';
    const file = join(logDir, `${jobId}.ndjson`);
    const store = createFakeStore();

    const fw1 = createNdjsonForwarder({ logDir, store, pollMs: 20, logger: silentLogger() });
    writeAll(file, Array.from({ length: 20 }, (_, i) => buildEvent(jobId, i)));
    await fw1.start();
    await waitForWrites(store, 20);
    await fw1.stop();

    const offsetPath = `${file}.offset`;
    expect(existsSync(offsetPath)).toBe(true);

    appendFileSync(
      file,
      Array.from({ length: 10 }, (_, i) => `${buildEvent(jobId, 20 + i)}\n`).join('')
    );

    // Second forwarder instance simulates restart — in-memory state cleared, offset on disk drives resume.
    const fw2 = createNdjsonForwarder({ logDir, store, pollMs: 20, logger: silentLogger() });
    await fw2.start();
    await waitForWrites(store, 30);
    await fw2.stop();

    expect(store.writes).toHaveLength(30);
    expect(new Set(store.writes.map((w) => w.eventSeq)).size).toBe(30);
    for (let i = 0; i < 30; i++) {
      expect(store.writes[i].payload.i).toBe(i);
    }
  });

  it(
    'truncation: resets offset and re-forwards from start (idempotent via DDB)',
    async () => {
      const jobId = 'job-trunc';
      const file = join(logDir, `${jobId}.ndjson`);
      const store = createFakeStore();
      const fw = createNdjsonForwarder({
        logDir,
        store,
        pollMs: 20,
        logger: silentLogger(),
      });

      writeAll(file, [buildEvent(jobId, 0), buildEvent(jobId, 1)]);
      await fw.start();
      await waitForWrites(store, 2);

      // Sleep past filesystem mtime granularity so the replacement is detectable.
      await new Promise((r) => setTimeout(r, 1100));
      truncateSync(file, 0);
      // Replacement payloads are same byte length as initial so size <= offset
      // (the contract-specified truncation signal).
      writeAll(file, [buildEvent(jobId, 2), buildEvent(jobId, 3)]);

      await waitForWrites(store, 4, 6000);
      await fw.stop();

      const payloadIs = store.writes.map((w) => w.payload.i);
      expect(payloadIs).toEqual([0, 1, 2, 3]);
    },
    10000,
  );

  it('seeds per-job counter from DDB max when preexisting events are present', async () => {
    const jobId = 'job-seed';
    const file = join(logDir, `${jobId}.ndjson`);
    const store = createFakeStore({ preloadMax: { [jobId]: 5 } });
    const fw = createNdjsonForwarder({ logDir, store, pollMs: 20, logger: silentLogger() });
    writeAll(file, [buildEvent(jobId, 0), buildEvent(jobId, 1)]);
    await fw.start();
    await waitForWrites(store, 2);
    await fw.stop();
    expect(store.writes.map((w) => w.eventSeq)).toEqual(['000006', '000007']);
  });

  it('picks up new files appearing after start', async () => {
    const store = createFakeStore();
    const fw = createNdjsonForwarder({ logDir, store, pollMs: 20, logger: silentLogger() });
    await fw.start();

    const jobId = 'job-new-file';
    const file = join(logDir, `${jobId}.ndjson`);
    writeAll(file, [buildEvent(jobId, 0)]);
    await waitForWrites(store, 1);
    await fw.stop();
    expect(store.writes[0].jobId).toBe(jobId);
  });

  it('persists offset after each committed write', async () => {
    const jobId = 'job-offset';
    const file = join(logDir, `${jobId}.ndjson`);
    const store = createFakeStore();
    const fw = createNdjsonForwarder({ logDir, store, pollMs: 20, logger: silentLogger() });
    writeAll(file, [buildEvent(jobId, 0), buildEvent(jobId, 1)]);
    await fw.start();
    await waitForWrites(store, 2);
    await fw.stop();

    const offsetRaw = readFileSync(`${file}.offset`, 'utf8').trim();
    const stat = readFileSync(file, 'utf8').length;
    expect(parseInt(offsetRaw, 10)).toBe(stat);
  });
});
