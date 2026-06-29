'use client';

/**
 * Refactoring Scan v2 (hybrid) — the Assess tab.
 *
 * The single scan surface: deterministic recon builds the structural skeleton,
 * an LLM swarm adds the semantic findings, and the result is a dimension-tagged
 * priority matrix + maturity scorecard + Infrastructure inventory + a phased,
 * dependency-ordered plan you can turn into a real refactoring plan. Report-only.
 * The v1 deterministic-only "Refactoring Assessment" was retired in favour of this.
 */

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import type { App } from '@/types/app';
import type { AuditHotspot } from '@/types/refactor-audit';
import { useAppAuditJob } from '@/hooks/use-app-audit';
import { StoryLiveOutput } from '@/components/labs/agentic-workflow/story-live-output';
import { NewPlanModal } from '../new-plan-modal';
import { AgentCompare } from './agent-compare';
import { ScanReport } from './scan-report';
import { useRunScanEngine, useScanReport } from '@/hooks/use-scan-engine';

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
  const CAP = 2000;
  if (intent.length <= CAP) return intent;
  return `${intent.slice(0, CAP - 40).trimEnd()}\n… (truncated; see the hotspot report)`;
}

export function AssessTab({ app }: { app: App }) {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();

  const [planOpen, setPlanOpen] = useState(false);
  const [planIntent, setPlanIntent] = useState('');
  // Privacy lane: 'internal' (our own scanner, default — source stays on the box)
  // | 'external' (the GDPR data-privacy service). Inactive (internal) by default.
  const [privacyMode, setPrivacyMode] = useState<'internal' | 'external'>('internal');

  // ── Scan job state. LOCAL state is the source of truth (set synchronously on
  // start) so the running state + live log show immediately, even before
  // router.replace lands in the static export. The URL is updated too (resume). ──
  const [localScanJob, setLocalScanJob] = useState<string | null>(null);
  const scanJobId = localScanJob ?? params.get('scanJob');
  const { data: scanJob } = useAppAuditJob(scanJobId);
  const scanStatus = scanJob?.status;
  const scanRun = useRunScanEngine(app.appId);
  const scanTerminal = scanStatus === 'COMPLETED' || scanStatus === 'FAILED';
  const scanRunning = scanRun.isPending || (!!scanJobId && !scanTerminal);
  const scanSummary = scanJob?.scanEngineSummary;
  // A prior scan persists on S3 (shared react-query cache with ScanReport) — so the
  // button reads "Re-scan" + the report shows even on a fresh load with no ?scanJob.
  const { data: persistedScan } = useScanReport(app.appId);
  const hasScan = !!persistedScan || !!scanSummary?.scanAvailable;

  // When a running scan completes, refetch the persisted scan + graph so the new
  // results replace the old ones without a manual reload.
  useEffect(() => {
    if (scanStatus === 'COMPLETED') {
      queryClient.invalidateQueries({ queryKey: ['scan-report', app.appId] });
      queryClient.invalidateQueries({ queryKey: ['refactor-graph-available', app.appId] });
    }
  }, [scanStatus, app.appId, queryClient]);

  const setScanJob = useCallback(
    (id: string) => {
      setLocalScanJob(id);
      const next = new URLSearchParams(params.toString());
      next.set('tab', 'assess');
      next.set('scanJob', id);
      router.replace(`?${next.toString()}`);
    },
    [params, router],
  );
  const startScan = (mode: 'full' | 'deterministic' = 'full') => {
    scanRun.mutate({ privacyMode, mode }, { onSuccess: (res) => setScanJob(res.jobId) });
  };
  // Granular re-scan: re-run a subset of the swarm (targets) or auto-target the
  // git-changed subsystems, merging into the persisted scan — a few agents, not ~48.
  const rescanParts = (input: {
    targets?: string[];
    reuseRecon?: boolean;
    autoTargetChanged?: boolean;
  }) => {
    scanRun.mutate({ privacyMode, ...input }, { onSuccess: (res) => setScanJob(res.jobId) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        data-testid="scan-engine-section"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)', margin: 0 }}>
              Refactoring Scan v2 (hybrid)
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 0' }}>
              Deterministic recon builds the structural skeleton, then an LLM swarm (per-subsystem +
              cross-cutting passes) adds the semantic findings recon can&apos;t see. Output: a
              dimension-tagged priority matrix (architecture · safety · compliance · quality ·
              correctness), a maturity scorecard, an Infrastructure inventory, and a phased,
              dependency-ordered plan. Report-only.
            </p>
          </div>
          {/* Privacy lane toggle — Internal (default) | External GDPR service. */}
          <div
            role="radiogroup"
            aria-label="Privacy scanner mode"
            data-testid="scan-privacy-mode"
            style={{
              display: 'inline-flex',
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            {(['internal', 'external'] as const).map((mode) => {
              const active = privacyMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPrivacyMode(mode)}
                  disabled={scanRunning}
                  data-testid={`scan-privacy-mode-${mode}`}
                  title={
                    mode === 'internal'
                      ? 'Our own deterministic scanner — source never leaves the box (GDPR + EU AI Act)'
                      : 'External GDPR service (data-privacy-platform)'
                  }
                  style={{
                    fontSize: 11,
                    fontWeight: active ? 600 : 400,
                    color: active ? 'var(--background)' : 'var(--text-dim)',
                    background: active ? 'var(--foreground)' : 'transparent',
                    border: 'none',
                    padding: '5px 10px',
                    cursor: scanRunning ? 'not-allowed' : 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {mode}
                </button>
              );
            })}
          </div>
          {/* Quick re-scan: deterministic only (recon + detectors + plan, no LLM
              swarm) → ~0 tokens. Shown once a scan exists, since it refreshes the
              cheap layer without re-spending the ~48-agent swarm. */}
          {hasScan && (
            <button
              type="button"
              onClick={() => startScan('deterministic')}
              disabled={scanRunning}
              data-testid="scan-engine-quick"
              title="Re-run only the deterministic layer (recon + hotspots + infra + dead-code + maturity + plan) — no LLM swarm, ~0 tokens"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--foreground)',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '7px 12px',
                cursor: scanRunning ? 'not-allowed' : 'pointer',
                opacity: scanRunning ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              ↻ Quick re-scan (~0 tokens)
            </button>
          )}
          <button
            type="button"
            onClick={() => startScan('full')}
            disabled={scanRunning}
            data-testid="scan-engine-run"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--background)',
              background: 'var(--foreground)',
              border: 'none',
              borderRadius: 6,
              padding: '7px 14px',
              cursor: scanRunning ? 'not-allowed' : 'pointer',
              opacity: scanRunning ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {scanRunning && (
              <span
                aria-hidden
                style={{
                  width: 11,
                  height: 11,
                  border: '2px solid var(--background)',
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'spin 0.7s linear infinite',
                }}
              />
            )}
            {scanRun.isPending
              ? 'Starting…'
              : scanRunning
                ? 'Scanning…'
                : hasScan
                  ? 'Re-scan'
                  : 'Run v2 scan'}
          </button>
          <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
        </div>
        {scanRunning && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Running deps → recon → subsystem decomposition → swarm → phased plan (a few minutes).
            Watch the <strong>Scan log</strong> below for live progress.
          </div>
        )}
        {scanRun.isError && (
          <div style={{ fontSize: 11, color: 'var(--destructive)' }}>
            Could not start scan: {(scanRun.error as Error)?.message || 'request failed'}
          </div>
        )}
        {scanStatus === 'FAILED' && (
          <div style={{ fontSize: 11, color: 'var(--destructive)' }}>
            Scan failed: {scanJob?.errorMessage || 'unknown error'}
          </div>
        )}
        <ScanReport
          appId={app.appId}
          scanRunning={scanRunning}
          onRescan={rescanParts}
          onCreatePlan={(intent) => {
            setPlanIntent(intent);
            setPlanOpen(true);
          }}
        />
        {scanJobId && (
          <details open={scanRunning}>
            <summary
              style={{
                fontSize: 12,
                color: 'var(--text-dim)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              Scan log {scanRunning ? '(live)' : ''}
            </summary>
            <div style={{ marginTop: 8 }}>
              <StoryLiveOutput jobId={scanJobId} hideResponse />
            </div>
          </details>
        )}
      </div>

      {/* Dual-agent comparison harness (graph-vs-vanilla) — retained from v1. */}
      <AgentCompare appId={app.appId} />

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
