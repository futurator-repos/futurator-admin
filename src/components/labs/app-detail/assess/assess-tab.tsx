'use client';

/**
 * Refactoring Assessment Module — the Assess tab (Epic D1/D3, FR30/FR35).
 *
 * Trigger → live recon progress → severity-ranked hotspot dashboard →
 * Create-plan. Report-only: nothing here mutates the assessed code. The
 * producing `jobId` is stashed in the URL (`?auditJob=…`) so a reload resumes
 * the view (MVP has no durable audit table — that's Epic C).
 */

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { App } from '@/types/app';
import type { AuditHotspot } from '@/types/refactor-audit';
import { useRunAppAudit, useAppAuditJob, selectAuditReport } from '@/hooks/use-app-audit';
import { StoryLiveOutput } from '@/components/labs/agentic-workflow/story-live-output';
import { NewPlanModal } from '../new-plan-modal';
import { HotspotDashboard } from './hotspot-dashboard';

/**
 * Compile selected hotspots into a NewPlanModal intent seed (FR35). Pure +
 * exported for unit tests. Frames the work as a Strangler-Fig (extract →
 * repoint → delete, test-gated) so the downstream plan sequences safely.
 */
export function buildPlanIntent(hotspots: AuditHotspot[]): string {
  if (hotspots.length === 0) return '';
  const lines = hotspots.map((h) => `- [${h.severity}] ${h.title}\n    → ${h.suggestedAction}`);
  const intent = [
    'Refactor the following recon-identified hotspots. Sequence each as a Strangler-Fig:',
    'extract shared core → repoint dependents → delete the old path, every deletion gated',
    'on grep-zero + a passing test. Characterize behavior with a test net BEFORE any',
    'deletion/repoint on routes that lack coverage.',
    '',
    ...lines,
  ].join('\n');
  // NewPlanModal caps intent at 2000 chars (planNameSchema) — keep it submittable.
  const CAP = 2000;
  if (intent.length <= CAP) return intent;
  return `${intent.slice(0, CAP - 40).trimEnd()}\n… (truncated; see the hotspot report)`;
}

export function AssessTab({ app }: { app: App }) {
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params.get('auditJob');

  const run = useRunAppAudit(app.appId);
  const { data: job } = useAppAuditJob(jobId);
  const report = selectAuditReport(job);

  const [planOpen, setPlanOpen] = useState(false);
  const [planIntent, setPlanIntent] = useState('');

  // Stash the new jobId in the URL (preserve appId + tab=assess).
  const setAuditJob = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('tab', 'assess');
      next.set('auditJob', id);
      router.replace(`?${next.toString()}`);
    },
    [params, router],
  );

  const startAudit = () => {
    run.mutate(
      {},
      {
        onSuccess: (res) => setAuditJob(res.jobId),
      },
    );
  };

  const onCreatePlan = useCallback((hotspots: AuditHotspot[]) => {
    setPlanIntent(buildPlanIntent(hotspots));
    setPlanOpen(true);
  }, []);

  const hotspots = report.status === 'scored' ? report.hotspots : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)', margin: 0 }}>
            Refactoring Assessment
          </h3>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 0' }}>
            Deterministic recon over the migrated codebase — graphify (shape) + alias-resolve and
            knip (usage) → a severity-ranked hotspot report. ~0 LLM tokens, &lt; 3 min. Report-only
            — it never edits code.
          </p>
        </div>
        <button
          type="button"
          onClick={startAudit}
          disabled={run.isPending || report.status === 'assessing'}
          data-testid="assess-run"
          title={report.status === 'assessing' ? 'An assessment is already running' : undefined}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--background)',
            background: 'var(--foreground)',
            border: 'none',
            borderRadius: 6,
            padding: '7px 14px',
            cursor: run.isPending || report.status === 'assessing' ? 'not-allowed' : 'pointer',
            opacity: run.isPending || report.status === 'assessing' ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {report.status === 'scored' || report.status === 'failed'
            ? 'Re-assess'
            : run.isPending
              ? 'Starting…'
              : 'Assess'}
        </button>
      </div>

      {run.error && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--destructive)',
            border: '1px solid color-mix(in srgb, var(--destructive) 30%, transparent)',
            borderRadius: 8,
            padding: 10,
          }}
        >
          Could not start the assessment: {(run.error as Error).message}
        </div>
      )}

      {/* Live recon progress while the daemon runs. */}
      {report.status === 'assessing' && jobId && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
            Running recon on the EC2 clone…
          </div>
          <StoryLiveOutput jobId={jobId} hideResponse />
        </div>
      )}

      {report.status === 'failed' && (
        <div
          data-testid="assess-failed"
          style={{
            fontSize: 12,
            color: 'var(--destructive)',
            border: '1px solid color-mix(in srgb, var(--destructive) 30%, transparent)',
            borderRadius: 8,
            padding: 10,
          }}
        >
          Assessment failed: {report.message}
        </div>
      )}

      {report.status === 'scored' && (
        <>
          {hotspots.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => onCreatePlan(hotspots)}
                data-testid="assess-create-plan-all"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--accent-blue)',
                  background: 'transparent',
                  border: '1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent)',
                  borderRadius: 6,
                  padding: '5px 10px',
                  cursor: 'pointer',
                }}
              >
                Create plan from all hotspots →
              </button>
            </div>
          )}
          <HotspotDashboard hotspots={hotspots} onCreatePlan={onCreatePlan} />
        </>
      )}

      {report.status === 'idle' && !run.isPending && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-dim)',
            border: '1px dashed var(--border)',
            borderRadius: 10,
            padding: 14,
          }}
        >
          No assessment yet. Click <strong>Assess</strong> to run the recon and surface this
          app&apos;s refactor hotspots.
        </div>
      )}

      <NewPlanModal
        appId={app.appId}
        hasExistingPlans
        open={planOpen}
        onOpenChange={setPlanOpen}
        initialIntent={planIntent}
      />
    </div>
  );
}
