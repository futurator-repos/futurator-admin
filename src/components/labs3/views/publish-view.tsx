'use client';

/**
 * Labs3 · Publish view — the PRODUCTION surface (design doc I8 slice N3,
 * stage 5 of the stage-first nav — `stageForStatus: delivered → deployUrl ? 5 : 4`).
 *
 * Composes:
 *  - Production card — live URL when `plan.deployUrl` is set, a purposeful
 *    "Not published yet" empty state otherwise.
 *  - QaEvidenceLine — commit sha + verdict, shared with DeploymentView.
 *  - PromoteCtaBar — "Publish to production" CTA gated on
 *    `qaReadiness === 'verified'` (reuses use-p3-qa-report's frozen-contract
 *    readiness rule) via `canPromoteToProduction()`. Publishing is a
 *    destructive/irreversible action (advances main) — the bar requires an
 *    explicit typed "PUBLISH" confirm step before firing.
 *  - ReleaseHistory — last few deploys, shared with DeploymentView.
 */

import { CheckCircle2, Loader2 } from 'lucide-react';
import type { Labs3ViewProps } from '../plan-spec-dashboard/constants';
import { useDeployReport } from '@/hooks/use-deploy-report';
import { qaReadiness } from '@/hooks/use-p3-qa-report';
import { ReleaseHistory } from './deploy/release-history';
import { QaEvidenceLine } from './deploy/qa-evidence-line';
import { PromoteCtaBar } from './deploy/promote-cta-bar';
import { canPromoteToProduction } from './deploy/deploy-gate';

const cardStyle: React.CSSProperties = {
  padding: '40px 20px',
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--bg-elev)',
  textAlign: 'center',
};

export function PublishView(props: Labs3ViewProps) {
  const { planId, plan } = props;
  const { data: report, isLoading, isError, error } = useDeployReport(planId);

  const readiness = qaReadiness({
    qaVerifiedAt: plan?.qaVerifiedAt,
    p3QaVerdict: plan?.p3QaVerdict,
  });
  const gate = canPromoteToProduction(
    plan ? { stagingUrl: plan.stagingUrl } : undefined,
    readiness,
  );

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
          Loading publish status…
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
          Publish
        </h2>
        <p style={{ marginTop: 10, color: 'var(--destructive)', fontSize: 13, lineHeight: 1.55 }}>
          {error instanceof Error ? error.message : 'Could not load the publish status.'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ProductionCard deployUrl={plan?.deployUrl} />

      <QaEvidenceLine qaCommitSha={plan?.qaCommitSha} readiness={readiness} />

      <PromoteCtaBar
        planId={planId}
        target="production"
        label="Publish to production"
        gate={gate}
        liveUrl={plan?.deployUrl}
        confirmWord="PUBLISH"
        confirmCopy="Publishes staging → production (advances main). This is irreversible."
      />

      <ReleaseHistory history={report.history ?? []} />
    </div>
  );
}

function ProductionCard({ deployUrl }: { deployUrl: string | undefined }) {
  return (
    <section
      aria-label="Production"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        padding: '16px 20px',
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'var(--text-faint)',
          }}
        >
          Production
        </span>
        {deployUrl ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              color: 'var(--success)',
            }}
          >
            <CheckCircle2 size={14} aria-hidden="true" />
            Published and live
          </span>
        ) : (
          <span style={{ fontSize: 13, color: 'var(--text-mute)' }}>Not published yet</span>
        )}
      </div>

      {deployUrl ? (
        <a
          href={deployUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '0.02em',
            color: 'var(--accent-blue)',
            textDecoration: 'none',
            border: '1px solid var(--accent-blue)',
            background: 'color-mix(in srgb, var(--accent-blue) 10%, transparent)',
            borderRadius: 6,
            padding: '10px 18px',
            whiteSpace: 'nowrap',
          }}
        >
          Open production ↗
        </a>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--text-faint)', maxWidth: 260, lineHeight: 1.5 }}>
          Promote staging to production below to publish this app.
        </span>
      )}
    </section>
  );
}
