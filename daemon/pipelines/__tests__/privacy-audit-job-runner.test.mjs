/**
 * privacy-audit-job-runner.test.mjs — pure functions of the privacy lane.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validatePrivacyAuditJob,
  classifyPrivacyFailure,
  summarizePrivacyReport,
  runPrivacyAuditJob,
  PRIVACY_TOP_PER_REG,
} from '../privacy-audit-job-runner.mjs';

const job = (over = {}) => ({
  jobId: 'j1',
  refactorAuditPayload: { projectId: 'applicator', projectPath: '/home/ubuntu/projects/applicator', ...over },
});

// a realistic (shrunk) privacy-recon report
const report = (gdprN = 200) => ({
  tier: 'pro',
  rulepack_version: 'abc',
  cards_loaded: 13,
  regulations: ['gdpr', 'eu-ai-act'],
  duration_ms: 8144,
  by_regulation: {
    gdpr: {
      scanned_files: 1498,
      summary: { critical: 50, high: gdprN - 50, total: gdprN },
      hotspots: Array.from({ length: gdprN }, (_, i) => ({
        category: i % 2 ? 'Consent' : 'Automated Decisions',
        regulation: 'GDPR — Article 22',
        severity: i < 50 ? 'critical' : 'high',
        score: 100 - (i % 60),
        title: `finding ${i}`,
        file: `src/f${i}.ts`,
        citation: ['https://eur-lex.europa.eu/eli/reg/2016/679/oj'],
        card: '[[Automated Decisions]]',
      })),
    },
    'eu-ai-act': {
      scanned_files: 1498,
      summary: { critical: 3, total: 3 },
      hotspots: [
        { category: 'High-risk', regulation: 'EU AI Act', severity: 'critical', score: 90, title: 'x', file: 'a.ts' },
      ],
    },
  },
});

describe('validatePrivacyAuditJob', () => {
  it('accepts a well-formed job', () => expect(validatePrivacyAuditJob(job())).toEqual({ ok: true }));
  it('rejects missing projectPath', () =>
    expect(validatePrivacyAuditJob(job({ projectPath: '' }))).toEqual({ ok: false, reason: 'projectPath-missing' }));
});

describe('classifyPrivacyFailure', () => {
  it('maps rulepack + auth failures', () => {
    expect(classifyPrivacyFailure(1, 'rulepack fetch failed: 500')).toBe('rulepack-fetch-failed');
    expect(classifyPrivacyFailure(1, 'HTTP 401 unauthorized')).toBe('auth-failed');
    expect(classifyPrivacyFailure(1, 'boom')).toBe('privacy-error');
  });
});

describe('summarizePrivacyReport', () => {
  it('caps hotspots per regulation but keeps full counts', () => {
    const s = summarizePrivacyReport(report(200));
    expect(s.tier).toBe('pro');
    expect(s.totalDetected).toBe(201); // 200 gdpr + 1 ai-act
    const g = s.byRegulation.gdpr;
    expect(g.detectedCount).toBe(200);
    expect(g.shownCount).toBe(PRIVACY_TOP_PER_REG); // capped at 80
    expect(g.hotspots.length).toBe(PRIVACY_TOP_PER_REG);
    // category counts cover the FULL set, not just the shown ones
    const catTotal = Object.values(g.byCategory).reduce((a, b) => a + b, 0);
    expect(catTotal).toBe(200);
    // top hotspot is the highest score
    expect(g.hotspots[0].score).toBeGreaterThanOrEqual(g.hotspots[1].score);
  });
});

describe('runPrivacyAuditJob', () => {
  it('happy path emits the full audit trail (started→transfer→rulepack→regulation→completed)', async () => {
    const events = [];
    const pushEvent = vi.fn(async (_j, _s, _a, et) => events.push(et));
    const res = await runPrivacyAuditJob(job(), {
      runPrivacy: vi.fn(async () => ({ code: 0 })),
      readReport: vi.fn(async () => ({ ...report(120), rulepack_source: 'https://svc/v1/rulepack' })),
      pushEvent,
      serviceUrl: 'https://fm43v45ux7.execute-api.us-east-1.amazonaws.com',
    });
    expect(res.ok).toBe(true);
    expect(res.summary.totalDetected).toBe(121);
    expect(res.report).toBeTruthy(); // full report for S3
    // 3rd-party audit trail is in the log
    expect(events).toContain('privacy.started');
    expect(events).toContain('privacy.transfer'); // data-boundary note
    expect(events).toContain('privacy.rulepack'); // what came back from the service
    expect(events).toContain('privacy.regulation'); // per-reg breakdown
    expect(events).toContain('privacy.completed');
  });

  it('transfer event names the service host (never the token)', async () => {
    const data = [];
    const pushEvent = vi.fn(async (_j, _s, _a, et, d) => data.push({ et, d }));
    await runPrivacyAuditJob(job(), {
      runPrivacy: vi.fn(async () => ({ code: 0 })),
      readReport: vi.fn(async () => report(10)),
      pushEvent,
      serviceUrl: 'https://host.example.com/base?secret=should-not-appear',
    });
    const started = data.find((x) => x.et === 'privacy.started');
    expect(started.d.serviceHost).toBe('host.example.com');
    const all = JSON.stringify(data);
    expect(all).not.toMatch(/should-not-appear/); // query/token never logged
  });

  it('classifies a child failure (non-fatal upstream)', async () => {
    const res = await runPrivacyAuditJob(job(), {
      runPrivacy: vi.fn(async () => ({ code: 1, stderrTail: 'rulepack fetch failed: 403' })),
      readReport: vi.fn(),
    });
    expect(res).toMatchObject({ ok: false, reason: 'rulepack-fetch-failed' });
  });

  it('gates when paused', async () => {
    const res = await runPrivacyAuditJob(job(), { paused: true, runPrivacy: vi.fn() });
    expect(res).toMatchObject({ ok: true, status: 'gated' });
  });
});
