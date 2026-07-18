'use client';

/**
 * Labs3 · Deploy view — the review/delivered-stage surface (subtab='deploy').
 *
 * Design doc I2 slice U5/A5. Composes:
 *  - DevUrlCard (top) — the exact dev preview URL QA ran against, pinned SHA.
 *  - QA-verified evidence line — `commit <sha> QA-verified` via qaReadiness.
 *  - EnvironmentLadder (READ-ONLY reuse) — dev → staging → production rungs,
 *    each wired to the existing usePromoteApp mutation.
 *  - ReleaseStrip (READ-ONLY reuse) — sticky verdict pill + primary promote
 *    CTA, gated by the pure `canPromote()` helper (deploy-gate.ts) so the
 *    disabled reason is always visible, never a silent no-op.
 *  - ReleaseHistory — last few deploys (labs3-native, read-only).
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
import { ReleaseStrip } from '@/components/labs/plan-dashboard/views/deploy/release-strip';
import { DevUrlCard, shortSha, type DevPreviewStatus } from './qa/dev-url-card';
import { ReleaseHistory } from './deploy/release-history';
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

export function DeployView(props: Labs3ViewProps) {
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
          Deploy
        </h2>
        <p style={{ marginTop: 10, color: 'var(--destructive)', fontSize: 13, lineHeight: 1.55 }}>
          {error instanceof Error ? error.message : 'Could not load the deploy report.'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {plan?.devUrl && (
        <DevUrlCard
          devUrl={plan.devUrl}
          qaCommitSha={plan.qaCommitSha ?? ''}
          status={devPreviewStatusFromReport(report.environments)}
        />
      )}

      {/* QA-verified evidence line — `commit <sha> QA-verified`, honest tri-state. */}
      <QaEvidenceLine qaCommitSha={plan?.qaCommitSha} readiness={readiness} />

      <ReleaseStrip
        report={report}
        epicId={null}
        canDeploy={gate.canPromote}
        blockedReason={gate.reason}
        planId={planId}
      />

      <EnvironmentLadder environments={report.environments ?? []} planId={planId} />

      <ReleaseHistory history={report.history ?? []} />
    </div>
  );
}

function QaEvidenceLine({
  qaCommitSha,
  readiness,
}: {
  qaCommitSha: string | undefined;
  readiness: ReturnType<typeof qaReadiness>;
}) {
  const sha = shortSha(qaCommitSha ?? '');
  const meta =
    readiness === 'verified'
      ? { text: `commit ${sha} QA-verified`, color: 'var(--success)' }
      : readiness === 'blocking'
        ? { text: `commit ${sha} — QA blocking`, color: 'var(--destructive)' }
        : {
            text: qaCommitSha ? `commit ${sha} — QA not verified` : 'no QA verdict yet',
            color: 'var(--text-mute)',
          };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 4px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.04em',
        color: meta.color,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color }}
      />
      {meta.text}
    </div>
  );
}
