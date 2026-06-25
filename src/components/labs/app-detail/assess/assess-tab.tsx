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
import {
  useRunAppAudit,
  useAppAuditJob,
  selectAuditReport,
  useAppAudits,
  useDeleteAudit,
  reportFromRecord,
} from '@/hooks/use-app-audit';
import { StoryLiveOutput } from '@/components/labs/agentic-workflow/story-live-output';
import { NewPlanModal } from '../new-plan-modal';
import { HotspotDashboard } from './hotspot-dashboard';
import { RefactorGraph } from './refactor-graph';
import { AgentCompare } from './agent-compare';
import { PrivacyDashboard } from './privacy-dashboard';

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

/**
 * Trigger a browser download of the assessment as a JSON file. Pure-ish (the DOM
 * side-effect is unavoidable); kept here so the export shape is one place. The
 * file is shareable for auditing / further-improvement review.
 */
function downloadAuditJson(args: {
  appId: string;
  jobId: string | null;
  auditId?: string;
  counts: Record<string, number>;
  hotspots: AuditHotspot[];
  generatedAt: string;
  detectedCount?: number;
  shownCount?: number;
  toolStatus?: Record<string, string>;
  graphAvailable?: boolean;
}) {
  const payload = {
    schema: 'futurator.refactor-audit/v2',
    appId: args.appId,
    jobId: args.jobId,
    auditId: args.auditId ?? null,
    generatedAt: args.generatedAt,
    // audit-context so iterative review knows what ran: tool availability +
    // whether the report was capped + whether the code graph was produced.
    toolStatus: args.toolStatus ?? {},
    detectedCount: args.detectedCount ?? args.hotspots.length,
    shownCount: args.shownCount ?? args.hotspots.length,
    graphAvailable: args.graphAvailable ?? false,
    counts: args.counts,
    hotspotCount: args.hotspots.length,
    hotspots: args.hotspots,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `assessment-${args.appId}-${(args.jobId ?? 'latest').slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function AssessTab({ app }: { app: App }) {
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params.get('auditJob');

  const run = useRunAppAudit(app.appId);
  const { data: job } = useAppAuditJob(jobId);

  // Durable persistence: with no live ?auditJob (e.g. opened on another
  // computer), load the project's stored audits from AWS and render the latest.
  const { data: auditsData } = useAppAudits(jobId ? null : app.appId);
  const audits = auditsData?.audits ?? [];
  const deleteAudit = useDeleteAudit(app.appId);
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const selectedRecord = jobId
    ? null
    : (audits.find((a) => a.auditId === selectedAuditId) ?? audits[0] ?? null);

  // Live job takes precedence; otherwise derive from the durable record.
  const report = jobId ? selectAuditReport(job) : reportFromRecord(selectedRecord);
  // Audit-context (auditId, toolStatus, detected/shown, graphAvailable) — present
  // on both the job summary and the durable record.
  const currentSummary = jobId ? job?.refactorAuditSummary : selectedRecord;
  const currentAuditId = currentSummary?.auditId;
  // The job whose log we stream — the live URL job, or the producing job of the
  // selected durable record (events persist 7 days, so a finished audit's log is
  // still viewable). Drives the persistent collapsible log.
  const logJobId = jobId ?? selectedRecord?.jobId ?? null;

  const [planOpen, setPlanOpen] = useState(false);
  const [planIntent, setPlanIntent] = useState('');
  const [view, setView] = useState<'hotspots' | 'graph' | 'privacy'>('hotspots');
  const [includePrivacy, setIncludePrivacy] = useState(false);
  // 'internal' = our own deterministic scanner (default); 'external' = GDPR service.
  const [privacyMode, setPrivacyMode] = useState<'internal' | 'external'>('internal');
  const privacy = currentSummary?.privacy;
  const privacyRunning = report.status === 'assessing' && !!jobId && includePrivacy;

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
      { runPrivacy: includePrivacy, ...(includePrivacy ? { privacyMode } : {}) },
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
        {report.status === 'scored' && (
          <button
            type="button"
            onClick={() =>
              downloadAuditJson({
                appId: app.appId,
                jobId: report.jobId,
                auditId: currentAuditId,
                counts: report.counts,
                hotspots: report.hotspots,
                generatedAt: new Date().toISOString(),
                detectedCount: currentSummary?.detectedCount,
                shownCount: currentSummary?.shownCount,
                toolStatus: currentSummary?.toolStatus,
                graphAvailable: currentSummary?.graphAvailable,
              })
            }
            data-testid="assess-export"
            title="Download this assessment as JSON (share for auditing)"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--foreground)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '7px 12px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            ⇩ Export JSON
          </button>
        )}
        <label
          title="Run the Data Privacy Assessment (GDPR + EU AI Act) in parallel with the refactoring recon"
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            cursor: report.status === 'assessing' ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <input
            type="checkbox"
            checked={includePrivacy}
            onChange={(e) => setIncludePrivacy(e.target.checked)}
            disabled={report.status === 'assessing'}
            data-testid="assess-include-privacy"
          />
          Include data privacy
        </label>
        {includePrivacy && (
          <div
            role="radiogroup"
            aria-label="Privacy scanner mode"
            data-testid="assess-privacy-mode"
            style={{
              display: 'inline-flex',
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflow: 'hidden',
              fontSize: 11,
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
                  disabled={report.status === 'assessing'}
                  data-testid={`assess-privacy-mode-${mode}`}
                  title={
                    mode === 'internal'
                      ? 'Our own deterministic scanner — source never leaves the box (GDPR + EU AI Act, code + IaC)'
                      : 'External GDPR service (data-privacy-platform)'
                  }
                  style={{
                    padding: '5px 10px',
                    border: 'none',
                    fontWeight: active ? 600 : 400,
                    color: active ? 'var(--background)' : 'var(--text-dim)',
                    background: active ? 'var(--foreground)' : 'transparent',
                    cursor: report.status === 'assessing' ? 'not-allowed' : 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        )}
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

      {/* Durable history — past assessments stored in AWS (cross-machine). Only
          shown when not following a live job and ≥1 stored audit exists. */}
      {!jobId && audits.length > 0 && (
        <div
          data-testid="assess-history"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
        >
          <span
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-faint)',
            }}
          >
            history
          </span>
          {audits.map((a) => {
            const active = a.auditId === (selectedRecord?.auditId ?? audits[0]?.auditId);
            return (
              <span
                key={a.auditId}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: active ? 'var(--foreground)' : 'var(--text-dim)',
                  border: `1px solid ${active ? 'var(--foreground)' : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '3px 7px',
                }}
              >
                <button
                  type="button"
                  onClick={() => setSelectedAuditId(a.auditId)}
                  title={`${a.status} · ${a.hotspots?.length ?? 0} hotspots · ${a.createdAt}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  {a.createdAt.slice(0, 16).replace('T', ' ')}
                  {a.status === 'adjudicated' ? ' ·L3' : ''}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedAuditId === a.auditId) setSelectedAuditId(null);
                    deleteAudit.mutate(a.auditId);
                  }}
                  title="Delete this stored assessment"
                  aria-label="Delete assessment"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-faint)',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 12,
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

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

      {/* Live assessment log — the SAME StoryLiveOutput component the pipeline
          dev stage uses (now renders assess.* recon events). Shown prominently
          while running / on failure. */}
      {logJobId && (report.status === 'assessing' || report.status === 'failed') && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
            {report.status === 'failed'
              ? 'Assessment failed — log:'
              : 'Running recon on the EC2 clone…'}
          </div>
          {privacyRunning && (
            <div style={{ fontSize: 11, color: 'var(--accent-blue)', marginTop: 8 }}>
              <span className="animate-pulse">●</span> Data Privacy Assessment running in parallel
              (GDPR + EU AI Act)…
            </div>
          )}
          <StoryLiveOutput jobId={logJobId} hideResponse />
        </div>
      )}

      {report.status === 'scored' && currentSummary?.toolStatus?.knip === 'unavailable' && (
        <div
          data-testid="assess-knip-banner"
          style={{
            fontSize: 11,
            color: 'var(--warning)',
            border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)',
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          Dead-code: knip unavailable (the recon box has no node_modules for this clone) — showing
          the weaker alias-resolve orphan signal (needs-review).
          {currentSummary?.detectedCount != null &&
            currentSummary?.shownCount != null &&
            currentSummary.detectedCount > currentSummary.shownCount &&
            ` · ${currentSummary.detectedCount} detected, top ${currentSummary.shownCount} shown.`}
        </div>
      )}

      {report.status === 'scored' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Hotspots | Graph view toggle */}
            <div
              style={{
                display: 'inline-flex',
                border: '1px solid var(--border)',
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              {(['hotspots', 'graph', ...(privacy ? (['privacy'] as const) : [])] as const).map(
                (v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    data-testid={`assess-view-${v}`}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: view === v ? 'var(--background)' : 'var(--text-dim)',
                      background: view === v ? 'var(--foreground)' : 'transparent',
                      border: 'none',
                      padding: '5px 12px',
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {v === 'privacy' ? 'Data Privacy' : v}
                  </button>
                ),
              )}
            </div>
            <div style={{ flex: 1 }} />
            {hotspots.length > 0 && (
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
            )}
          </div>
          {view === 'hotspots' && (
            <HotspotDashboard hotspots={hotspots} onCreatePlan={onCreatePlan} />
          )}
          {view === 'graph' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <RefactorGraph
                appId={app.appId}
                hotspots={hotspots}
                graphAvailable={
                  jobId ? job?.refactorAuditSummary?.graphAvailable : selectedRecord?.graphAvailable
                }
              />
              <AgentCompare appId={app.appId} />
            </div>
          )}
          {view === 'privacy' && <PrivacyDashboard privacy={privacy} />}
          {/* Persistent assessment log — stays available after completion (the
              events stream lives 7 days) so the run is auditable post-hoc. */}
          {logJobId && (
            <details style={{ marginTop: 4 }}>
              <summary
                style={{
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                Assessment log
              </summary>
              <div style={{ marginTop: 8 }}>
                <StoryLiveOutput jobId={logJobId} hideResponse />
              </div>
            </details>
          )}
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
