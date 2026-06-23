/**
 * use-app-audit.test.ts — Refactoring Assessment Module (Epic D, FR31).
 *
 * Unit-tests the pure `selectAuditReport` deriver: it turns a polled job row
 * into the dashboard view, and is the single place the hotspot source lives
 * (so Epic C can swap the job row for the durable table without UI churn).
 */

import { describe, it, expect } from 'vitest';
import { selectAuditReport } from '../use-app-audit';
import type { AgentJob } from '@/types/agent-orchestrator';
import type { AuditHotspot } from '@/types/refactor-audit';

const hotspot = (over: Partial<AuditHotspot> = {}): AuditHotspot => ({
  kind: 'god-object',
  score: 90,
  severity: 'critical',
  title: 'God-object: AWSProfileStorage (44 methods, 38 importers)',
  files: ['src/lib/aws-profile-storage.ts'],
  evidence: { methods: 44, importers: 38 },
  suggestedAction: 'Split into domain repositories.',
  ...over,
});

// minimal AgentJob factory — only the fields selectAuditReport reads.
const job = (over: Partial<AgentJob>): AgentJob =>
  ({ jobId: 'j1', status: 'PENDING', ...over }) as AgentJob;

describe('selectAuditReport', () => {
  it('returns idle for a null job', () => {
    expect(selectAuditReport(null)).toEqual({ status: 'idle' });
    expect(selectAuditReport(undefined)).toEqual({ status: 'idle' });
  });

  it('returns assessing while PENDING or RUNNING', () => {
    expect(selectAuditReport(job({ status: 'PENDING' }))).toEqual({
      status: 'assessing',
      jobId: 'j1',
    });
    expect(selectAuditReport(job({ status: 'RUNNING' }))).toEqual({
      status: 'assessing',
      jobId: 'j1',
    });
  });

  it('returns failed with the error message', () => {
    const r = selectAuditReport(job({ status: 'FAILED', errorMessage: 'degenerate-build' }));
    expect(r).toEqual({ status: 'failed', jobId: 'j1', message: 'degenerate-build' });
  });

  it('returns scored with the full hotspot array from the job summary', () => {
    const hs = [hotspot(), hotspot({ kind: 'dead-code', score: 30, severity: 'medium' })];
    const r = selectAuditReport(
      job({
        status: 'COMPLETED',
        refactorAuditSummary: {
          hotspotCount: 2,
          counts: { 'god-object': 1, 'dead-code': 1 },
          hotspots: hs,
          reportPath: '/x/REPORT.md',
        },
      }),
    );
    expect(r).toMatchObject({
      status: 'scored',
      jobId: 'j1',
      hotspotCount: 2,
      hotspots: hs,
      counts: { 'god-object': 1, 'dead-code': 1 },
      reportPath: '/x/REPORT.md',
    });
  });

  it('falls back to hotspots.length when hotspotCount is absent', () => {
    const r = selectAuditReport(
      job({
        status: 'COMPLETED',
        // @ts-expect-error — exercising a partial/legacy summary row
        refactorAuditSummary: { counts: {}, hotspots: [hotspot()], reportPath: null },
      }),
    );
    expect(r).toMatchObject({ status: 'scored', hotspotCount: 1 });
  });

  it('tolerates a COMPLETED job with no summary (defensive)', () => {
    const r = selectAuditReport(job({ status: 'COMPLETED' }));
    expect(r).toMatchObject({ status: 'scored', hotspotCount: 0, hotspots: [] });
  });
});
