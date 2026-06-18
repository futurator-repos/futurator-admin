'use client';

/**
 * Plan Retrospect — the tab view (spec §7.2).
 *
 * Composes the stage rail + per-stage Reality Check cards. The Overview row
 * carries the pipeline-health number + grade band; its trend sparkline is
 * STUBBED ("Phase 3 — needs pipeline-versioning"). At the foot, the generated
 * improvement-action list with "Push to fixes-plan backlog" / "Push to
 * Reflector inbox" buttons — wired to LOCAL state only (the backend push
 * endpoint is Phase-later; see the TODO).
 *
 * For `[LLM]`/assessing stages, the Assessor runs as a normal daemon agent job;
 * while it streams we render the existing `StoryLiveOutput` (visual parity with
 * concept/dev), then the card replaces it on completion (the GET refetch picks
 * up the stored Assessor slices).
 *
 * NEVER hardcodes a planId — it is always a prop; the feature is the pipeline's
 * self-improvement mechanism and must run against any completed plan.
 */

import { useMemo, useState } from 'react';
import { StoryLiveOutput } from '@/components/labs/agentic-workflow/story-live-output';
import { useScorecard, useRunScorecardStage } from '@/hooks/use-scorecard';
import { api } from '@/lib/api-client';
import type {
  StageId,
  ScorecardSlice,
  ImprovementAction,
  FixRef,
  GradeBand,
  RealityCheck,
} from '@/types/scorecard';
import { RetrospectRail, RETROSPECT_STAGES } from './retrospect-rail';
import { RealityCheckCard } from './reality-check-card';
import {
  buildReportMarkdown,
  buildReconciliationMarkdown,
  buildAuditBundle,
  reconcile,
  type ForensicLike,
} from './retrospect-export';

const STAGE_LABEL: Record<StageId, string> = {
  concept: 'Concept',
  development: 'Development',
  qa: 'QA Review',
  deployment: 'Deployment',
  publish: 'Publish',
  overview: 'Overview',
};

const GRADE_TONE: Record<GradeBand, string> = {
  A: 'success',
  B: 'success',
  C: 'warning',
  D: 'warning',
  F: 'destructive',
};

export function RetrospectView({ planId }: { planId: string }) {
  const { data, isLoading, error } = useScorecard(planId);
  const runStage = useRunScorecardStage(planId);

  // Which stage's analysis is currently in flight (the mutation target).
  const [runningStage, setRunningStage] = useState<StageId | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  // Per-stage live Assessor job ids (from `status:'assessing'` responses).
  const [assessJobs, setAssessJobs] = useState<Partial<Record<StageId, string>>>({});
  // Local push state for improvement actions (the backend push endpoint is
  // Phase-later — TODO below). Keyed by the action's redCriterion.
  const [pushed, setPushed] = useState<Record<string, 'fixes-plan' | 'reflector-inbox'>>({});

  const slicesByStage = useMemo(() => {
    const map = new Map<StageId, ScorecardSlice[]>();
    for (const s of data?.slices ?? []) {
      const arr = map.get(s.stage) ?? [];
      arr.push(s);
      map.set(s.stage, arr);
    }
    return map;
  }, [data?.slices]);

  const analyzedStages = data?.analyzedStages ?? [];

  async function run(stage: StageId) {
    setRunningStage(stage);
    try {
      const res = await runStage.mutateAsync(stage);
      if (res.status === 'assessing') {
        setAssessJobs((j) => ({ ...j, [stage]: res.jobId }));
      } else {
        // Deterministic stage resolved inline — drop any stale stream.
        setAssessJobs((j) => ({ ...j, [stage]: undefined }));
      }
    } finally {
      setRunningStage(null);
    }
  }

  async function runAll() {
    setRunningAll(true);
    try {
      const res = await runStage.mutateAsync('all');
      if (res.status === 'assessing' && res.jobId) {
        // `all` may return a lead Assessor job; subsequent stage jobs surface
        // via the GET refetch. Attach the lead job to whichever stage it names.
        setAssessJobs((j) => ({ ...j, [res.stage]: res.jobId }));
      }
    } finally {
      setRunningAll(false);
    }
  }

  // ── Push wiring (LOCAL ONLY) ──────────────────────────────────────────────
  // TODO(Phase-later): replace with a real mutation —
  //   POST /plans/:id/scorecard/actions/push { redCriterion, target }
  // which flips the action's stored status to 'pushed' and records `target`,
  // drafting an F<n> row in the fixes plan (SQ2 default) or appending to the
  // Reflector inbox. For now we only reflect the operator's choice locally.
  function pushAction(action: ImprovementAction, target: 'fixes-plan' | 'reflector-inbox') {
    setPushed((p) => ({ ...p, [action.redCriterion]: target }));
  }

  if (isLoading) {
    return (
      <p style={{ fontSize: 12, color: 'var(--text-dim)', padding: 16 }}>Loading Reality Check…</p>
    );
  }
  if (error) {
    return (
      <p style={{ fontSize: 12, color: 'var(--destructive)', padding: 16 }}>
        Failed to load the Reality Check: {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }

  return (
    <div data-testid="retrospect-view">
      <RetrospectRail
        analyzedStages={analyzedStages}
        runningStage={runningStage}
        runningAll={runningAll}
        onRun={run}
        onRunAll={runAll}
      />

      {/* Per-stage cards (rail order). Overview is rendered separately at the top. */}
      <OverviewHeader
        pipelineHealth={data?.pipelineHealth ?? null}
        gradeBand={data?.gradeBand ?? null}
        confidence={data?.confidence}
        analyzed={analyzedStages.includes('overview')}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {RETROSPECT_STAGES.filter((s) => s.id !== 'overview').map((stage) => {
          const slices = slicesByStage.get(stage.id) ?? [];
          const jobId = assessJobs[stage.id];
          const streaming = !!jobId && slices.length === 0;
          return (
            <div key={stage.id}>
              {streaming ? (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    background: 'var(--bg-elev)',
                    padding: 14,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--foreground)',
                      marginBottom: 8,
                    }}
                  >
                    {STAGE_LABEL[stage.id]} — The Assessor is grading…
                  </div>
                  <StoryLiveOutput jobId={jobId} hideResponse />
                </div>
              ) : (
                (slices.length > 0 || analyzedStages.includes(stage.id)) && (
                  <RealityCheckCard stageLabel={STAGE_LABEL[stage.id]} slices={slices} />
                )
              )}
            </div>
          );
        })}
      </div>

      {/* Overview's own criteria (e.g. OV1..OV11) render as a card too. */}
      {(slicesByStage.get('overview')?.length ?? 0) > 0 && (
        <div style={{ marginTop: 14 }}>
          <RealityCheckCard
            stageLabel="Overview — cross-cutting criteria"
            slices={slicesByStage.get('overview') ?? []}
          />
        </div>
      )}

      <ImprovementActions actions={data?.actions ?? []} pushed={pushed} onPush={pushAction} />

      {data && <ExportBar planId={planId} data={data} />}
    </div>
  );
}

// ── Export & audit ──────────────────────────────────────────────────────────

function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Operator export row. Four artefacts off the in-memory Reality Check:
 *   • Report (.md)         — the readable retrospect.
 *   • Forensic (.json)     — the raw timing payload the scores were derived from.
 *   • Reconciliation (.md) — re-derives every forensic-backed criterion from
 *                            that payload and flags MATCH/MISMATCH — the
 *                            "are the forensics + rubric actually right" check.
 *   • Audit bundle (.json) — report + forensic + reconciliation in one file.
 * The forensic payload is fetched once on demand and cached.
 */
function ExportBar({ planId, data }: { planId: string; data: RealityCheck }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forensic, setForensic] = useState<ForensicLike | null>(null);

  async function getForensic(): Promise<ForensicLike> {
    if (forensic) return forensic;
    // include=events so wall-clock-derived criteria (D-WS1) can be reconciled
    // and the exported bundle is self-contained (the API strips events[] by
    // default on read).
    const f = await api.get<ForensicLike>(`/plans/${planId}/timing/forensic?include=events`);
    setForensic(f);
    return f;
  }

  async function run(kind: string, fn: () => Promise<void> | void) {
    setBusy(kind);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-testid="retrospect-export"
      style={{
        marginTop: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '12px 16px',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg-elev)',
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>Export</span>
      <span style={{ fontSize: 11, color: 'var(--text-dim)', marginRight: 4 }}>
        full report · raw forensics · cross-check that they agree
      </span>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        disabled={!!busy}
        onClick={() =>
          run('report', () =>
            downloadText(`${planId}-retrospect.md`, buildReportMarkdown(data), 'text/markdown'),
          )
        }
        style={exportBtn('accent-blue')}
      >
        {busy === 'report' ? '…' : 'Report (.md)'}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() =>
          run('forensic', async () => {
            const f = await getForensic();
            downloadText(`${planId}-forensic.json`, JSON.stringify(f, null, 2), 'application/json');
          })
        }
        style={exportBtn('text-mute')}
      >
        {busy === 'forensic' ? '…' : 'Forensic (.json)'}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() =>
          run('recon', async () => {
            const f = await getForensic();
            downloadText(
              `${planId}-reconciliation.md`,
              buildReconciliationMarkdown(reconcile(data, f), planId),
              'text/markdown',
            );
          })
        }
        style={exportBtn('accent-blue')}
      >
        {busy === 'recon' ? '…' : 'Reconciliation (.md)'}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() =>
          run('bundle', async () => {
            let f: ForensicLike | null = null;
            try {
              f = await getForensic();
            } catch {
              f = null; // bundle records the absence rather than failing
            }
            downloadText(
              `${planId}-retrospect-audit.json`,
              JSON.stringify(buildAuditBundle(data, f), null, 2),
              'application/json',
            );
          })
        }
        style={exportBtn('text-mute')}
      >
        {busy === 'bundle' ? '…' : 'Audit bundle (.json)'}
      </button>
      {err && (
        <span style={{ flexBasis: '100%', fontSize: 11, color: 'var(--destructive)' }}>
          Export failed: {err}
        </span>
      )}
    </div>
  );
}

function exportBtn(tone: string) {
  return {
    fontSize: 11,
    fontWeight: 600,
    color: `var(--${tone})`,
    background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
    border: `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
    borderRadius: 6,
    padding: '5px 11px',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  };
}

/** Overview band: pipeline-health + grade + the stubbed Phase-3 trend. */
function OverviewHeader({
  pipelineHealth,
  gradeBand,
  confidence,
  analyzed,
}: {
  pipelineHealth: number | null;
  gradeBand: GradeBand | null;
  confidence?: 'reconciled' | 'unreconciled';
  analyzed: boolean;
}) {
  const pct = pipelineHealth != null ? Math.round(pipelineHealth * 100) : null;
  const tone = gradeBand ? GRADE_TONE[gradeBand] : 'text-faint';
  return (
    <div
      data-testid="retrospect-overview"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '14px 18px',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg-elev)',
        marginBottom: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 28, fontWeight: 700, color: `var(--${tone})` }}>
          {gradeBand ?? '—'}
        </span>
        <span style={{ fontSize: 14, color: 'var(--foreground)' }}>
          pipeline health {pct != null ? `${pct}%` : '— not yet scored'}
        </span>
      </div>
      {confidence === 'unreconciled' && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            fontWeight: 600,
            color: 'var(--warning)',
            border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
            borderRadius: 4,
            padding: '2px 6px',
          }}
        >
          cost = lower bound · unreconciled (F2/F3 open)
        </span>
      )}
      <div style={{ flex: 1 }} />
      {/* Trend sparkline — STUBBED (spec §7.2 / §9; needs pipeline-versioning). */}
      <div
        data-testid="retrospect-trend-stub"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          border: '1px dashed var(--border)',
          borderRadius: 6,
          padding: '4px 8px',
        }}
      >
        <span style={{ opacity: 0.5 }}>▁▂▃▄▅▆▇</span>
        trend — Phase 3 (needs pipeline-versioning)
      </div>
      {!analyzed && (
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          run Overview analysis to compute the rollup
        </span>
      )}
    </div>
  );
}

/** Generated improvement actions with the two push targets (spec §7.2 / SQ2). */
function ImprovementActions({
  actions,
  pushed,
  onPush,
}: {
  actions: ImprovementAction[];
  pushed: Record<string, 'fixes-plan' | 'reflector-inbox'>;
  onPush: (action: ImprovementAction, target: 'fixes-plan' | 'reflector-inbox') => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div
      data-testid="retrospect-actions"
      style={{
        marginTop: 18,
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--foreground)',
        }}
      >
        Improvement actions
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-dim)', marginLeft: 8 }}>
          every 🔴/🟡 → a fix to ship
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {actions.map((a) => {
          const target = pushed[a.redCriterion] ?? (a.status === 'pushed' ? a.target : undefined);
          return (
            <div
              key={a.redCriterion}
              data-testid={`action-${a.redCriterion}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 16px',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--foreground)',
                  minWidth: 56,
                }}
              >
                {a.redCriterion}
              </span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                {a.fixIds.length > 0 ? (
                  a.fixIds.map((f) => <ActionFix key={f.id} fix={f} />)
                ) : a.draftFinding ? (
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    draft new finding: <em>{a.draftFinding}</em>
                  </span>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>no mapped fix</span>
                )}
              </div>
              {target ? (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    fontWeight: 600,
                    color: 'var(--success)',
                  }}
                >
                  pushed → {target === 'fixes-plan' ? 'fixes-plan' : 'Reflector inbox'}
                </span>
              ) : (
                <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>
                  <button
                    type="button"
                    onClick={() => onPush(a, 'fixes-plan')}
                    style={actionBtn('accent-blue')}
                  >
                    Push to fixes-plan backlog
                  </button>
                  <button
                    type="button"
                    onClick={() => onPush(a, 'reflector-inbox')}
                    style={actionBtn('text-mute')}
                  >
                    Push to Reflector inbox
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionFix({ fix }: { fix: FixRef }) {
  const shipped = fix.status === 'shipped' || fix.status === 'verified';
  const tone = shipped ? 'success' : 'destructive';
  const label = fix.kind === 'story' ? `Story ${fix.id}` : fix.id;
  return (
    <span
      title={shipped ? `${label} — ${fix.status} · verify it held` : `${label} — open`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 600,
        color: `var(--${tone})`,
        border: `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
        borderRadius: 3,
        padding: '1px 6px',
      }}
    >
      {shipped ? `ship-verify ${label}` : `ship ${label}`}
    </span>
  );
}

function actionBtn(tone: string) {
  return {
    fontSize: 10,
    fontWeight: 600,
    color: `var(--${tone})`,
    background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
    border: `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
    borderRadius: 5,
    padding: '4px 10px',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  };
}
