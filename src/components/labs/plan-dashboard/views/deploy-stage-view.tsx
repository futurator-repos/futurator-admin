'use client';

/**
 * DeployStageView — content for the Deploy pipeline stage.
 *
 * Layout:
 *   [RELEASE STRIP — sticky]  big verdict pill + target + CTA
 *   [WHAT'S SHIPPING]         handoff card (name, rigor, stories, cost, QA)
 *   [DEPLOY STEPS]            live 4-step tracker for the current / last deploy
 *   [DEPLOY HISTORY]          past deploys (absolute timestamps + durations)
 *   [ENVIRONMENT]             bucket / prefix / CloudFront info
 *   [DEFERRED FEATURES]       collapsible roadmap
 *
 * Distinct from the Developing → Deploy sub-tab (toolkit view). This is the
 * release dashboard.
 */

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { PlanWithEpics } from '@/hooks/use-plans';
import { useDeployReport } from '@/hooks/use-deploy-report';
import { ReleaseStrip } from './deploy/release-strip';
import { EnvironmentLadder } from './deploy/environment-ladder';
import { WhatsShipping } from './deploy/whats-shipping';
import { DeploySteps } from './deploy/deploy-steps';
import { DeployLogs } from './deploy/deploy-logs';
import { DeployHistory } from './deploy/deploy-history';
import { EnvironmentFooter } from './deploy/environment-footer';
import { DeferredFeatures } from './deploy/deferred-features';

export function DeployStageView({ plan }: { plan: PlanWithEpics }) {
  const { data: report, isLoading, error } = useDeployReport(plan.planId);

  // The backend fans deploys out through the final epic (highest plan-wave),
  // matching Developing → Deploy sub-tab semantics.
  const targetEpicId = useMemo<string | null>(() => {
    const epics = plan.epics ?? [];
    if (epics.length === 0) return null;
    return [...epics].sort((a, b) => (b.epicWave ?? 0) - (a.epicWave ?? 0))[0].epicId;
  }, [plan.epics]);

  if (isLoading || !report) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 80,
          color: 'var(--text-mute)',
          gap: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        <Loader2 size={14} className="animate-spin" />
        Loading deploy report…
      </div>
    );
  }
  if (error) {
    return (
      <div
        style={{
          padding: 24,
          border: '1px solid var(--destructive)',
          background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
          borderRadius: 8,
          color: 'var(--destructive)',
          fontSize: 13,
        }}
      >
        Couldn&apos;t load deploy report.
        {error instanceof Error ? ` · ${error.message}` : ''}
      </div>
    );
  }

  // Deploy is allowed when QA isn't blocking AND we have a target epic. Even
  // never-deployed plans with QA not-yet-run can deploy if the operator
  // insists (rigor=prototype, say). We rely on `verdict === 'not-ready'` to
  // mean "QA regressed and we refuse to ship."
  const canDeploy =
    !!targetEpicId && report.verdict !== 'not-ready' && report.verdict !== 'deploying';
  const blockedReason =
    report.verdict === 'not-ready'
      ? report.statusReason
      : report.verdict === 'deploying'
        ? 'A deploy is already in progress.'
        : !targetEpicId
          ? 'No epics in this plan yet.'
          : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ReleaseStrip
        report={report}
        epicId={targetEpicId}
        canDeploy={canDeploy}
        blockedReason={blockedReason}
      />
      <EnvironmentLadder environments={report.environments} planId={plan.planId} />
      <WhatsShipping handoff={report.handoff} />
      <DeploySteps current={report.current} />
      <DeployLogs deployJobId={report.current?.jobId ?? null} />
      <DeployHistory history={report.history} planId={plan.planId} />
      <EnvironmentFooter target={report.target} />
      <DeferredFeatures />
    </div>
  );
}
