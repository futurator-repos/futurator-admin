'use client';

/**
 * Labs3 · Deployment view — the DEV → STAGING promotion surface
 * (design doc I8 slice N3, stage 4 of the stage-first nav).
 *
 * Scoped to DEV + STAGING only — production lives on `publish-view.tsx`
 * (stage 5). Composes:
 *  - DevUrlCard (top) — the exact dev preview URL QA ran against, pinned SHA.
 *  - QaEvidenceLine — `commit <sha> QA-verified` via qaReadiness.
 *  - PromoteCtaBar — explicit "Promote to staging" CTA, disabled-with-reason
 *    via the pure `canPromote()` helper (deploy-gate.ts). No confirm step —
 *    promoting to staging is non-destructive (production is untouched).
 *  - EnvironmentLadder (READ-ONLY reuse, filtered to dev+staging rungs) —
 *    the visual ladder segment, each rung wired to usePromoteApp.
 *  - ReleaseHistory — last few deploys (labs3-native, read-only).
 *
 * Exported as both `DeploymentView` (the I8 name) and `DeployView` (back-compat
 * — plan-spec-dashboard/index.tsx still imports the old name).
 *
 * Handles plans with zero deploys gracefully: the backend's deploy-report
 * endpoint always returns a report (verdict 'never-deployed', every rung
 * 'none') rather than 404ing, so the only client-side states to guard are
 * loading/error before that first response lands.
 */

import { Loader2 } from 'lucide-react';
import type { Labs3ViewProps } from '../plan-spec-dashboard/constants';
import { useDeployReport } from '@/hooks/use-deploy-report';
import { qaReadiness } from '@/hooks/use-p3-qa-report';
import { EnvironmentLadder } from '@/components/labs/plan-dashboard/views/deploy/environment-ladder';
import { DevUrlCard, type DevPreviewStatus } from './qa/dev-url-card';
import { ReleaseHistory } from './deploy/release-history';
import { QaEvidenceLine } from './deploy/qa-evidence-line';
import { PromoteCtaBar } from './deploy/promote-cta-bar';
import { canPromote } from './deploy/deploy-gate';

const cardStyle: React.CSSProperties = {
  padding: '40px 20px',
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--bg-elev)',
  textAlign: 'center',
};

/** Derive the DevUrlCard status from the deploy report's `dev` rung. */
function devPreviewStatusFromReport(
  environments: { environment: string; status: string }[] | undefined,
): DevPreviewStatus {
  const dev = environments?.find((e) => e.environment === 'dev');
  if (dev?.status === 'live') return 'live';
  if (dev?.status === 'failed') return 'failed';
  return 'deploying';
}

export function DeploymentView(props: Labs3ViewProps) {
  const { planId, plan } = props;
  const { data: report, isLoading, isError, error } = useDeployReport(planId);

  const readiness = qaReadiness({
    qaVerifiedAt: plan?.qaVerifiedAt,
    p3QaVerdict: plan?.p3QaVerdict,
  });
  const gate = canPromote(plan ? { devUrl: plan.devUrl } : undefined, readiness);

  if (isLoading) {
    return (
      <div style={cardStyle}>
        <Loader2
          size={18}
          className="animate-spin"
          aria-hidden="true"
          style={{ color: 'var(--text-mute)' }}
        />
        <p style={{ marginTop: 10, color: 'var(--text-dim)', fontSize: 13 }}>
          Loading deploy report…
        </p>
      </div>
    );
  }

  if (isError || !report) {
    return (
      <div style={cardStyle}>
        <h2
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--text-mute)',
          }}
        >
          Deployment
        </h2>
        <p style={{ marginTop: 10, color: 'var(--destructive)', fontSize: 13, lineHeight: 1.55 }}>
          {error instanceof Error ? error.message : 'Could not load the deploy report.'}
        </p>
      </div>
    );
  }

  // Stage 4 scope — dev + staging rungs only; production is PublishView's job.
  const devStagingEnvs = (report.environments ?? []).filter(
    (e) => e.environment === 'dev' || e.environment === 'staging',
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {plan?.devUrl && (
        <DevUrlCard
          devUrl={plan.devUrl}
          qaCommitSha={plan.qaCommitSha ?? ''}
          status={devPreviewStatusFromReport(report.environments)}
        />
      )}

      <QaEvidenceLine qaCommitSha={plan?.qaCommitSha} readiness={readiness} />

      <PromoteCtaBar
        planId={planId}
        target="staging"
        label="Promote to staging"
        gate={gate}
        liveUrl={plan?.stagingUrl}
      />

      <EnvironmentLadder environments={devStagingEnvs} planId={planId} />

      <ReleaseHistory history={report.history ?? []} />
    </div>
  );
}

/** Back-compat alias — plan-spec-dashboard/index.tsx imports the old name. */
export const DeployView = DeploymentView;
