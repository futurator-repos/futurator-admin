'use client';

import { useMemo, useState } from 'react';
import { Loader2, Copy, Globe, Eye, Rocket } from 'lucide-react';
import type { PlanWithEpics } from '@/hooks/use-plans';
import {
  useDeployApp,
  useEpicWorkflow,
  useRunVisualQa,
  useStartDevServer,
} from '@/hooks/use-epic-workflow';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useQaReport } from '@/hooks/use-qa-report';
import type { EpicWorkflow } from '@/types/epic-workflow';

export function DeployView({ plan }: { plan: PlanWithEpics }) {
  // Last epic (highest plan-wave) owns deploy/QA since its workingDir is the
  // plan folder. Matches the legacy DeployTab behavior.
  const targetEpic = useMemo<EpicWorkflow | null>(() => {
    const epics = plan.epics ?? [];
    if (epics.length === 0) return null;
    return [...epics].sort((a, b) => (b.epicWave ?? 0) - (a.epicWave ?? 0))[0];
  }, [plan.epics]);

  // Pull the plan-wide QA verdict to gate the Publish button. When QA isn't
  // green we disable Publish with a tooltip citing the blocking reason.
  const { data: qaReport } = useQaReport(plan.planId);

  const startDev = useStartDevServer();
  const runQa = useRunVisualQa();
  const deploy = useDeployApp();

  const { data: epicLive } = useEpicWorkflow(targetEpic?.epicId || null);

  const [devServerJobId, setDevServerJobId] = useState<string | null>(null);
  // Local overrides set by the button mutations. When null, fall back to
  // whatever the backend reports on the epic. This avoids a setState-in-effect
  // to sync backend updates into state — we just derive the effective jobId.
  const [localQaJobId, setLocalQaJobId] = useState<string | null>(null);
  const [localDeployJobId, setLocalDeployJobId] = useState<string | null>(null);
  const qaJobId = localQaJobId ?? epicLive?.qaJobId ?? null;
  const deployJobId = localDeployJobId ?? epicLive?.deployJobId ?? null;

  const { data: devServerJob } = useAgentJob(devServerJobId);
  const { data: qaJob } = useAgentJob(qaJobId);
  const { data: deployJob } = useAgentJob(deployJobId);

  const devServerUrl = devServerJob?.variables?.DEV_SERVER_URL;
  const qaVerdict = qaJob?.variables?.OVERALL_VERDICT;
  const deployUrl =
    deployJob?.variables?.DEPLOY_URL || plan.deployUrl || epicLive?.deployUrl;

  // Publish gate:
  //   1. Plan must be in a deployable status (review/delivered).
  //   2. QA verdict must be 'ready' (all pillars green) OR there's no QA
  //      report yet (prototype rigor with no gate runs — soft allow).
  const deployable = plan.status === 'review' || plan.status === 'delivered';
  const qaBlocking =
    qaReport?.verdict === 'blocking' || qaReport?.verdict === 'needs-attention';
  const publishGateReason = !deployable
    ? `Plan must reach review status before publishing. Current: ${plan.status}.`
    : qaBlocking
      ? qaReport?.blockingReason || 'QA verdict is not ready — promote from QA Review first.'
      : undefined;
  const publishAllowed = deployable && !qaBlocking;

  async function onStartDev() {
    if (!targetEpic) return;
    const result = await startDev.mutateAsync(targetEpic.epicId);
    setDevServerJobId(result.jobId);
  }
  async function onRunQa() {
    if (!targetEpic) return;
    const result = await runQa.mutateAsync(targetEpic.epicId);
    setLocalQaJobId(result.jobId);
  }
  async function onDeploy() {
    if (!targetEpic) return;
    const result = await deploy.mutateAsync(targetEpic.epicId);
    setLocalDeployJobId(result.jobId);
  }

  if (!targetEpic) {
    return (
      <EmptyCard>No epics in this plan yet — nothing to deploy.</EmptyCard>
    );
  }

  const isDevBusy =
    startDev.isPending ||
    devServerJob?.status === 'PENDING' ||
    devServerJob?.status === 'RUNNING';
  const isQaBusy =
    runQa.isPending || qaJob?.status === 'PENDING' || qaJob?.status === 'RUNNING';
  const isDeployBusy =
    deploy.isPending ||
    deployJob?.status === 'PENDING' ||
    deployJob?.status === 'RUNNING';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Dev Server */}
      <DeploySection
        icon={<Globe size={14} />}
        title="Dev Server"
        busy={isDevBusy}
        busyLabel="Starting…"
        action={devServerUrl ? 'Restart' : 'Start Dev Server'}
        onAction={onStartDev}
      >
        {devServerUrl ? (
          <UrlRow url={devServerUrl} />
        ) : (
          <HelpText>
            {isDevBusy
              ? 'Starting vite — usually takes 8–15s.'
              : 'Launch a dev server on EC2 port 5173. Returns a public URL.'}
          </HelpText>
        )}
      </DeploySection>

      {/* Visual QA */}
      <DeploySection
        icon={<Eye size={14} />}
        title="Visual QA"
        busy={isQaBusy}
        busyLabel="Running…"
        action={qaVerdict ? 'Re-run QA' : 'Run Visual QA'}
        onAction={onRunQa}
      >
        {qaJob?.status === 'COMPLETED' && qaVerdict && (
          <>
            <div
              style={{
                border: `1px solid ${
                  qaVerdict === 'PASS' ? 'var(--success)' : 'var(--destructive)'
                }`,
                background:
                  qaVerdict === 'PASS'
                    ? 'color-mix(in srgb, var(--success) 10%, transparent)'
                    : 'color-mix(in srgb, var(--destructive) 10%, transparent)',
                color: qaVerdict === 'PASS' ? 'var(--success)' : 'var(--destructive)',
                padding: '10px 14px',
                borderRadius: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
              }}
            >
              Verdict: {qaVerdict}
              {qaJob.variables?.FAILED_TESTS &&
                qaJob.variables.FAILED_TESTS.trim() !== 'none' && (
                  <div style={{ color: 'var(--text-dim)', marginTop: 6 }}>
                    Failed: {qaJob.variables.FAILED_TESTS}
                  </div>
                )}
            </div>
            <QaScreenshots
              overviewUrl={qaJob.variables?.OVERVIEW_URL}
              screenshotsRaw={qaJob.variables?.SCREENSHOTS}
            />
          </>
        )}
        {qaJob?.status === 'FAILED' && (
          <ErrorBlock>
            QA job failed: {qaJob.errorMessage || 'unknown error'}
          </ErrorBlock>
        )}
        {!qaJob && (
          <HelpText>
            Screenshots the app at each visual test definition and scores against
            expected behaviors. Runs Playwright + Claude QA agent against a freshly
            started dev server.
          </HelpText>
        )}
      </DeploySection>

      {/* Publish */}
      <DeploySection
        icon={<Rocket size={14} />}
        title="Publish"
        busy={isDeployBusy}
        busyLabel="Deploying…"
        action={deployUrl ? 'Re-deploy' : 'Publish to futurator.ai'}
        onAction={onDeploy}
        disabled={!publishAllowed}
        disabledReason={publishGateReason}
        primary
      >
        {deployUrl ? (
          <UrlRow url={deployUrl} />
        ) : (
          <HelpText>
            {publishGateReason ? (
              publishGateReason
            ) : (
              <>
                Builds with <code>vite base=/apps/{plan.name}/</code>, syncs to S3,
                invalidates CloudFront. Takes ~30–60s.
              </>
            )}
          </HelpText>
        )}
        {/* Handoff summary — when QA is green, show what's about to ship. */}
        {publishAllowed && qaReport && qaReport.verdict === 'ready' && (
          <HandoffCard qaReport={qaReport} />
        )}
        {deployJob?.status === 'FAILED' && (
          <ErrorBlock>
            Deploy failed:{' '}
            {deployJob.variables?.DEPLOY_DETAILS ||
              deployJob.errorMessage ||
              'unknown'}
          </ErrorBlock>
        )}
        {deployJob?.status === 'COMPLETED' && deployJob.variables?.DEPLOY_DETAILS && (
          <HelpText>{deployJob.variables.DEPLOY_DETAILS}</HelpText>
        )}
      </DeploySection>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────

function DeploySection({
  icon,
  title,
  busy,
  busyLabel,
  action,
  onAction,
  disabled,
  disabledReason,
  primary,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  busy: boolean;
  busyLabel: string;
  action: string;
  onAction: () => void;
  disabled?: boolean;
  /** Shown as the button's native tooltip when `disabled` is true. */
  disabledReason?: string;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ color: 'var(--text-dim)', display: 'inline-flex' }}>
          {icon}
        </span>
        <span
          style={{
            fontSize: 13,
            color: 'var(--foreground)',
            letterSpacing: '0.02em',
            fontWeight: 500,
          }}
        >
          {title}
        </span>
        <div style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={onAction}
            disabled={busy || disabled}
            title={disabled && disabledReason ? disabledReason : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              padding: '6px 14px',
              border: primary ? '1px solid var(--foreground)' : '1px solid var(--border-2)',
              borderRadius: 2,
              background: primary ? 'var(--foreground)' : 'transparent',
              color: primary ? 'var(--background)' : 'var(--text-dim)',
              fontWeight: primary ? 500 : 400,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              cursor: busy || disabled ? 'not-allowed' : 'pointer',
              opacity: busy || disabled ? 0.5 : 1,
            }}
          >
            {busy && <Loader2 size={11} className="animate-spin" />}
            {busy ? busyLabel : action}
          </button>
        </div>
      </div>
      <div
        style={{
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function UrlRow({ url }: { url: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          flex: 1,
          padding: '8px 12px',
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-dim)',
          textDecoration: 'none',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {url}
      </a>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(url)}
        style={{
          padding: 8,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-mute)',
          cursor: 'pointer',
        }}
        aria-label="Copy URL"
      >
        <Copy size={12} />
      </button>
    </div>
  );
}

function HelpText({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: 12,
        color: 'var(--text-mute)',
        lineHeight: 1.55,
        margin: 0,
      }}
    >
      {children}
    </p>
  );
}

function ErrorBlock({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid var(--destructive)',
        background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
        padding: '10px 14px',
        borderRadius: 4,
        color: 'var(--destructive)',
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 30,
        textAlign: 'center',
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        color: 'var(--text-mute)',
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

// ── QA screenshots (carried over from legacy DeployTab) ──────────────

function QaScreenshots({
  overviewUrl,
  screenshotsRaw,
}: {
  overviewUrl?: string;
  screenshotsRaw?: string;
}) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const shots = useMemo(() => {
    const out: Array<{ id: string; url: string }> = [];
    if (overviewUrl) out.push({ id: 'overview', url: overviewUrl });
    if (screenshotsRaw) {
      for (const line of screenshotsRaw.split('\n')) {
        const m = /^\s*[-*]\s*[*_`]*([\w-]+)[*_`]*:\s*(https?:\/\/\S+)/.exec(line);
        if (m) out.push({ id: m[1], url: m[2] });
      }
    }
    return out;
  }, [overviewUrl, screenshotsRaw]);

  if (shots.length === 0) return null;

  return (
    <>
      <div style={{ marginTop: 8 }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            marginBottom: 10,
          }}
        >
          Screenshots ({shots.length})
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
          }}
        >
          {shots.map((s) => (
            <button
              key={s.id + s.url}
              type="button"
              onClick={() => setLightboxUrl(s.url)}
              style={{
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 4,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.url}
                alt={s.id}
                loading="lazy"
                style={{
                  aspectRatio: '16 / 9',
                  width: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  insetInline: 0,
                  bottom: 0,
                  padding: '4px 8px',
                  background:
                    'color-mix(in srgb, var(--background) 80%, transparent)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--text-dim)',
                }}
              >
                {s.id}
              </div>
            </button>
          ))}
        </div>
      </div>
      {lightboxUrl && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 400,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.85)',
            cursor: 'zoom-out',
            padding: 24,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="Screenshot"
            style={{
              maxHeight: '100%',
              maxWidth: '100%',
              borderRadius: 6,
              boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ── Handoff card ─────────────────────────────────────────────────────

/**
 * Compact "what's about to ship" summary shown when QA is green. Renders
 * story count + a couple of thumbnails so the operator has visual confidence
 * before hitting Publish.
 */
function HandoffCard({
  qaReport,
}: {
  qaReport: import('@/types/qa-report').QaReport;
}) {
  const stories = countStories(qaReport);
  const previewThumbs = qaReport.vqa.thumbnails
    .filter((t) => t.status === 'pass' && t.screenshotUrl)
    .slice(0, 3);
  return (
    <div
      style={{
        marginTop: 6,
        padding: '12px 14px',
        border: '1px solid var(--success)',
        background: 'color-mix(in srgb, var(--success) 8%, transparent)',
        borderRadius: 4,
        display: 'flex',
        gap: 14,
        alignItems: 'center',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--success)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            marginBottom: 4,
          }}
        >
          Ready to ship
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-dim)',
            lineHeight: 1.4,
          }}
        >
          {stories} stor{stories === 1 ? 'y' : 'ies'} · {qaReport.vqa.pass} visual test{qaReport.vqa.pass === 1 ? '' : 's'} passing · rigor <code>{qaReport.rigor}</code>
        </div>
      </div>
      {previewThumbs.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {previewThumbs.map((t) => (
            <div
              key={t.testId}
              title={t.testId}
              style={{
                width: 48,
                height: 32,
                borderRadius: 3,
                border: '1px solid var(--success)',
                overflow: 'hidden',
                background: 'var(--surface)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={t.screenshotUrl}
                alt={t.testId}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function countStories(r: import('@/types/qa-report').QaReport): number {
  // Approximate from AC rollup — 1 story per criterion is wrong but we have
  // no direct story count in QaReport v1. Use unique storyIds from failures
  // + thumbnails as a lower bound.
  const ids = new Set<string>();
  for (const f of r.ac.failures) ids.add(f.storyId);
  for (const t of r.vqa.thumbnails) ids.add(t.storyId);
  return ids.size || r.perEpic.length;
}
