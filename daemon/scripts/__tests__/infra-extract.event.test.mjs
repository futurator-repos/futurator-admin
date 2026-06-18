/**
 * infra-extract.event.test.mjs — Story SG-1.3 (event infra & async edges, W5).
 *
 * The blast-radius false-all-clear guard: an SNS subscribe / cron-function-ref
 * must produce TRIGGERS / SUBSCRIBES edges so an async chain is traversable.
 * Without these, "what does changing X affect?" silently misses event-driven
 * consumers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTsParser } from '../lib/extractor-envelope.mjs';
import { extractInfra } from '../infra-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', '__fixtures__', 'mini-sst');

let result;
beforeAll(async () => {
  const ts = await loadTsParser('test');
  const source = await readFile(join(FIXTURE_ROOT, 'sst.config.ts'), 'utf-8');
  result = extractInfra(source, { ...ts, root: FIXTURE_ROOT });
});

const nodeById = (id) => result.nodes.find((n) => n.nodeId === id);
const hasEdge = (type, source, target) =>
  result.edges.some((e) => e.type === type && e.source === source && e.target === target);

describe('infra-extract — SNS subscribe (W5)', () => {
  it('promotes the subscriber handler to a first-class lambda node', () => {
    expect(nodeById('infra/lambda/AlarmToAttention')?.kind).toBe('lambda');
  });

  it('TRIGGERS (topic → lambda) + SUBSCRIBES (lambda → topic)', () => {
    expect(hasEdge('TRIGGERS', 'infra/topic/AlarmsTopic', 'infra/lambda/AlarmToAttention')).toBe(true);
    expect(hasEdge('SUBSCRIBES', 'infra/lambda/AlarmToAttention', 'infra/topic/AlarmsTopic')).toBe(true);
  });

  it('the subscriber lambda still gets HANDLED_BY + USES from its config block', () => {
    expect(hasEdge('HANDLED_BY', 'infra/lambda/AlarmToAttention', 'code/functions--cron--alarm.ts')).toBe(true);
    expect(hasEdge('USES', 'infra/lambda/AlarmToAttention', 'infra/table/ScoresTable')).toBe(true);
  });
});

describe('infra-extract — cron function reference (W5)', () => {
  it('a cron referencing an existing function var TRIGGERS that lambda', () => {
    expect(nodeById('infra/lambda/ReportFn')?.kind).toBe('lambda');
    expect(nodeById('infra/cron/ReportCron')?.schedule).toBe('rate(7 days)');
    expect(hasEdge('TRIGGERS', 'infra/cron/ReportCron', 'infra/lambda/ReportFn')).toBe(true);
  });

  it('an INLINE-function cron keeps HANDLED_BY on the cron node (no false TRIGGERS)', () => {
    // DigestCron has an inline function: { handler } — must NOT emit TRIGGERS.
    expect(hasEdge('HANDLED_BY', 'infra/cron/DigestCron', 'code/functions--cron--digest.ts')).toBe(true);
    expect(result.edges.some((e) => e.type === 'TRIGGERS' && e.source === 'infra/cron/DigestCron')).toBe(false);
  });
});

describe('infra-extract — real config event wiring', () => {
  it('extracts the cwAlarmsTopic → CloudWatchToAttention subscribe chain', async () => {
    const ts = await loadTsParser('test');
    const repoRoot = join(__dirname, '..', '..', '..');
    const source = await readFile(join(repoRoot, 'sst.config.ts'), 'utf-8');
    const real = extractInfra(source, { ...ts, root: repoRoot });

    const ids = new Set(real.nodes.map((n) => n.nodeId));
    expect(ids.has('infra/topic/CloudWatchAlarmsTopic')).toBe(true);
    expect(ids.has('infra/lambda/CloudWatchToAttention')).toBe(true);
    expect(
      real.edges.some(
        (e) => e.type === 'TRIGGERS' && e.source === 'infra/topic/CloudWatchAlarmsTopic' && e.target === 'infra/lambda/CloudWatchToAttention',
      ),
    ).toBe(true);
    expect(
      real.edges.some(
        (e) => e.type === 'SUBSCRIBES' && e.source === 'infra/lambda/CloudWatchToAttention' && e.target === 'infra/topic/CloudWatchAlarmsTopic',
      ),
    ).toBe(true);
  });
});
