'use client';

/**
 * Labs3 QA Review view — driven from StoryNodeRow[] (no QaReport).
 *
 * Layout (top → bottom):
 *   [VERDICT STRIP — sticky: delivery verdict + AC gauges]
 *   [COHORT MATRIX — optional, only when ≥ 2 cohortBatch levels]
 *   [BOUND-AC TABLE — grouped epicTitle → storyTitle → AC, in-place expanders]
 *   [STORY STATE FOOTNOTE — compact state breakdown for cross-check]
 *
 * TWO MODES:
 *  1. QA-Review W2 (P3_QA_REVIEW on + a deployed-app verdict exists) → the
 *     DEPLOYED-APP review: dev-URL card, Lane-1 journey verdicts, Lane-2
 *     before/after VQA, wiring/orphan banner, Approve/Send-back. This is the
 *     merged-plan QA of what the operator actually clicks at plan.devUrl.
 *  2. Fallback (flag off, or no verdict yet) → the per-story testBinding view
 *     below (read-only; the ready-frontier is the authority).
 *
 * AC grouping: cohort.epicTitle → story.title → BoundAcceptanceCriterion
 * StatusChip: passing ✓ | failing ✗ | bound ○ | unbound dim
 * AcClass badge: DET (deterministic) | ADV (advisory-taste) | SEC (advisory-security)
 *
 * The legacy QA view (labs/plan-dashboard/views/qa-review-view.tsx) is
 * UNTOUCHED — this is a new sibling in the labs3 module.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, UserCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { VerdictStrip } from './qa/verdict-strip';
import { BoundAcTable } from './qa/bound-ac-table';
import { CohortMatrix } from './qa/cohort-matrix';
import { DevUrlCard, type DevPreviewStatus } from './qa/dev-url-card';
import { JourneyVerdicts } from './qa/journey-verdicts';
import { BeforeAfterGallery } from './qa/before-after-gallery';
import { AgenticJourneysSection } from './qa/agentic-journeys-section';
import { WiringOrphanBanner } from './qa/wiring-orphan-banner';
import { QaActions } from './qa/qa-actions';
import {
  useP3QaReport,
  qaReadiness,
  type QaReadiness,
  type P3QaReportWithAgentic,
} from '@/hooks/use-p3-qa-report';
import { StoryNodeStatePill } from '@/components/labs3/shared/state-pill';
import type { StoryNodeRow, StoryNodeState } from '@/types/plan-spec';
import type { P3QaVerdict, NeedsHumanVerdict } from '@/types/qa-review-p3';

// D-fix-3 — the runtime story state carried by a quarantined story. Not in the
// StoryNodeState union yet (shared type gap; the daemon writes it at runtime), so
// it is compared as a string constant.
const NEEDS_HUMAN_STATE = 'needs-human';

// ── View props (matches Labs3ViewProps subset; shell passes full shape) ──

export interface QaReviewViewProps {
  planId: string;
  appId: string | null;
  stories: StoryNodeRow[];
  onSelectStory?: (storyId: string) => void;
}

// ── Root component ───────────────────────────────────────────────────

export function QaReviewView({ planId, stories }: QaReviewViewProps) {
  // QA-Review W2 — when the deployed-app QA has produced a verdict for this plan
  // (flag on), show the merged-plan review instead of the per-story testBinding
  // view. Falls back seamlessly when the flag is off or no verdict exists yet.
  const p3Qa = useP3QaReport(planId);
  // The readiness rule (FROZEN CONTRACT single source of truth). The verdict
  // carries decision/blocking; the report carries qaVerifiedAt — together they
  // decide deliverability. Gate on the FLAG ALONE, not on the presence of a
  // signal: when the gate is on but QA hasn't produced a verdict yet (job still
  // running), report+verdict are both null and readiness resolves to 'pending'
  // (neutral) — it must NOT collapse to `null` and let the fallback strip paint
  // green "Ready to deliver" off the unit-AC rollup. `null` only when the flag
  // is off → the fallback strip keeps its legacy behavior.
  const readiness: QaReadiness | null = p3Qa.enabled
    ? qaReadiness({
        qaVerifiedAt: p3Qa.report?.qaVerifiedAt,
        p3QaVerdict: p3Qa.verdict,
      })
    : null;

  if (p3Qa.enabled && p3Qa.report) {
    return (
      <DeployedAppQaReview
        planId={planId}
        report={p3Qa.report}
        verdict={p3Qa.verdict}
        readiness={readiness ?? 'pending'}
      />
    );
  }

  if (stories.length === 0) {
    return (
      <div
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          color: 'var(--text-mute)',
          fontSize: 12.5,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em',
          lineHeight: 1.6,
        }}
      >
        No stories ingested yet. Trigger{' '}
        <code style={{ color: 'var(--accent-blue)' }}>POST /api/plans/:id/run-as-pipeline-3</code>{' '}
        to build the plan-spec graph.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* D-fix-3 — stories quarantined on a ran-and-failed browser/behavior AC
          (needs-human). Surfaced with their D-fix-4 probe evidence + an Accept
          lane so the operator adjudicates an interaction-gated VQA false-negative
          INFORMED. Self-suppresses when none are quarantined. */}
      <NeedsHumanReviewSection planId={planId} stories={stories} />

      {/* Sticky verdict strip — gated on deployed-app QA readiness so it can't
          read green off the unit-AC rollup while QA is unverified/blocking. */}
      <VerdictStrip stories={stories} qaReadiness={readiness ?? undefined} />

      {/* Cohort-batch matrix — self-suppresses when only 1 batch */}
      <CohortMatrix stories={stories} />

      {/* Bound-AC table — the centerpiece */}
      <BoundAcTable stories={stories} />

      {/* Story state footnote */}
      <StorySummaryFootnote stories={stories} />
    </div>
  );
}

// ── QA-Review W2 — the deployed-app review (the merged plan @ plan.devUrl) ──

/**
 * The assembled-plan QA Review: what the operator actually clicks, tested.
 *   [DEV-URL CARD] the exact bytes, pinned to qaCommitSha
 *   [WIRING BANNER] runtime orphans (assemble-must-import) — the pacman3 class
 *   [JOURNEY VERDICTS] Lane 1 — deterministic reach/act/observe gate
 *   [BEFORE/AFTER GALLERY] Lane 2 — VQA judge on frame pairs
 *   [ACTIONS] Approve → staging (W3) / Send-back → mint fix stories
 */
function DeployedAppQaReview({
  planId,
  report,
  verdict: envelopeVerdict,
  readiness,
}: {
  planId: string;
  report: P3QaReportWithAgentic;
  /** The full verdict from the GET envelope (decision/blocking); may be null. */
  verdict: P3QaVerdict | null;
  readiness: QaReadiness;
}) {
  // The dev-preview BUILD status is independent of the QA verdict: if the app is
  // served at devUrl the build succeeded (a failed QA does NOT mean a failed
  // build — that's what the journey/wiring panels below report). Only show
  // 'deploying' when there's no URL yet.
  const devStatus: DevPreviewStatus = report.devUrl ? 'live' : 'deploying';
  // Prefer the real verdict from the envelope (it carries the operator decision
  // fields Approve/Send-back need). Fall back to a display-shaped reconstruction
  // from the report only when the envelope verdict is absent.
  const verdict: P3QaVerdict = envelopeVerdict ?? {
    status: report.status === 'passed' ? 'pass' : report.status === 'failed' ? 'fail' : 'uncertain',
    blocking: report.status === 'failed',
    ranAtSha: report.qaCommitSha,
    journeys: report.journeys,
    vqa: report.vqa,
    wiring: report.wiring,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Deliverability chip — the READINESS RULE made visible. NEVER green off
          the unit-AC rollup; only when deployed-app QA is verified. */}
      <ReadinessChip readiness={readiness} />
      <DevUrlCard devUrl={report.devUrl} qaCommitSha={report.qaCommitSha} status={devStatus} />
      {/* hasRun: a report exists ⇒ the wiring check ran; lets "ran & clean" show
          a green confirmation instead of being indistinguishable from "never ran". */}
      <WiringOrphanBanner wiring={report.wiring} hasRun />
      <JourneyVerdicts journeys={report.journeys} />
      <AgenticJourneysSection agentic={report.agentic} planId={planId} devUrl={report.devUrl} />
      <BeforeAfterGallery journeys={report.journeys} />
      <QaActions planId={planId} verdict={verdict} currentQaCommitSha={report.qaCommitSha} />
    </div>
  );
}

// ── Readiness chip — the FROZEN CONTRACT READY-TO-DELIVER affordance ──

const READINESS_META: Record<QaReadiness, { label: string; color: string; help: string }> = {
  verified: {
    label: 'Ready to deliver',
    color: 'var(--success)',
    help: 'Deployed-app QA verified for the current commit — this plan is deliverable.',
  },
  blocking: {
    label: 'QA blocking',
    color: 'var(--destructive)',
    help: 'The deployed-app QA verdict has blocking failures. Send it back, or override via Approve.',
  },
  pending: {
    label: 'QA pending — unverified',
    color: 'var(--text-mute)',
    help: 'Deployed-app QA has not passed for the current commit yet. Not ready to deliver.',
  },
};

function ReadinessChip({ readiness }: { readiness: QaReadiness }) {
  const meta = READINESS_META[readiness];
  return (
    <div
      data-testid="qa-readiness-chip"
      data-readiness={readiness}
      title={meta.help}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        alignSelf: 'flex-start',
        padding: '8px 16px',
        border: `1px solid ${meta.color}`,
        background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
        borderRadius: 2,
      }}
    >
      <span
        style={{
          background: meta.color,
          width: 8,
          height: 8,
          borderRadius: '50%',
          display: 'inline-block',
          boxShadow: readiness === 'blocking' ? `0 0 10px ${meta.color}` : 'none',
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: meta.color,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 500,
        }}
      >
        {meta.label}
      </span>
    </div>
  );
}

// ── D-fix-3 — needs-human quarantine + operator Accept lane ──────────────────

/**
 * Surfaces every story quarantined in 'needs-human' (its ONLY outstanding
 * failure is a browser/behavior AC that RAN and failed a snapshot assertion —
 * D-fix-2). Renders the D-fix-4 probe evidence (interpreted actions / status /
 * per-assertion detail) so the operator adjudicates an interaction-gated VQA
 * FALSE-NEGATIVE INFORMED, and an "Accept" button that flips the story done and
 * unblocks its dependents (POST .../stories/:id/accept). App-agnostic: keys ONLY
 * on story state + AC-kind + verdict; no app/story/content literal.
 */
function NeedsHumanReviewSection({ planId, stories }: { planId: string; stories: StoryNodeRow[] }) {
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: (storyId: string) =>
      api.post<{ ok: boolean; storyId: string; state: string; unblocked: string[] }>(
        `/plans/${planId}/stories/${storyId}/accept`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['story-nodes', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });

  const quarantined = useMemo(
    () => stories.filter((s) => (s.state as string) === NEEDS_HUMAN_STATE),
    [stories],
  );
  if (quarantined.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        border: '1px solid var(--warning)',
        background: 'color-mix(in srgb, var(--warning) 6%, transparent)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <UserCheck size={14} style={{ color: 'var(--warning)' }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.16em',
            color: 'var(--warning)',
            fontWeight: 600,
          }}
        >
          Needs human review · {quarantined.length}
        </span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5, margin: 0 }}>
        These stories committed working code (their unit ACs passed) but a{' '}
        <strong>browser/behavior AC ran and failed</strong> a snapshot assertion — a candidate
        interaction-gated VQA false-negative. They are quarantined, not failed: their dependents
        wait (blocked) and the plan holds until you adjudicate. Accept to treat the failure as a
        false-negative and unblock dependents, or send back to fix (leave un-accepted).
      </p>
      {quarantined.map((story) => (
        <NeedsHumanStoryCard
          key={story.storyId}
          story={story}
          accepting={accept.isPending && accept.variables === story.storyId}
          onAccept={() => accept.mutate(story.storyId)}
        />
      ))}
      {accept.isError && (
        <span style={{ fontSize: 11, color: 'var(--destructive)', fontFamily: 'var(--font-mono)' }}>
          Accept failed: {(accept.error as Error)?.message ?? 'unknown error'}
        </span>
      )}
    </div>
  );
}

function NeedsHumanStoryCard({
  story,
  accepting,
  onAccept,
}: {
  story: StoryNodeRow;
  accepting: boolean;
  onAccept: () => void;
}) {
  const [open, setOpen] = useState(true);
  // The story's verdict carries the D-fix-2 human-review lane + D-fix-4 probes.
  const verdict = (story.verdict as unknown as NeedsHumanVerdict | undefined) ?? undefined;
  const probes = verdict?.probes ?? [];
  const reasons = verdict?.reasons ?? [];
  const humanReview = verdict?.humanReview ?? [];
  const acById = useMemo(
    () => new Map((story.acceptanceCriteria ?? []).map((ac) => [ac.id, ac])),
    [story.acceptanceCriteria],
  );

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            flex: 1,
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
            {story.title || story.storyId}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-mute)',
            }}
          >
            {story.storyId}
            {humanReview.length > 0 ? ` · AC ${humanReview.join(', ')}` : ''}
          </span>
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={accepting}
          title="Accept for interaction-gated VQA false-negative — flips the story done and unblocks its dependents."
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 12px',
            border: '1px solid var(--success)',
            background: 'color-mix(in srgb, var(--success) 12%, transparent)',
            color: 'var(--success)',
            borderRadius: 4,
            cursor: accepting ? 'default' : 'pointer',
            opacity: accepting ? 0.6 : 1,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
          }}
        >
          {accepting ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
          Accept (VQA false-negative)
        </button>
      </div>

      {open && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {reasons.length > 0 && (
            <ul
              style={{
                margin: 0,
                paddingLeft: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {reasons.map((r, i) => (
                <li key={i} style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  {r}
                </li>
              ))}
            </ul>
          )}

          {probes.length === 0 ? (
            <span
              style={{ fontSize: 11, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}
            >
              No probe evidence recorded on the verdict (D-fix-4 not present for this run).
            </span>
          ) : (
            probes.map((p) => {
              const ac = acById.get(p.acId);
              return (
                <div
                  key={p.acId}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '8px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--accent-blue)',
                      }}
                    >
                      {p.acId}
                    </span>
                    <ProbeChip label={p.testKind ?? 'unbound'} />
                    <ProbeChip label={p.status} />
                    <ProbeChip label={p.probeRan ? 'probe ran' : 'probe did not run'} />
                    {p.errored && <ProbeChip label="errored" tone="destructive" />}
                  </div>
                  {ac?.text && (
                    <span style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                      {ac.text}
                    </span>
                  )}
                  {p.detail && (
                    <pre
                      style={{
                        margin: 0,
                        padding: '8px 10px',
                        background: 'var(--bg)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        fontSize: 10.5,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-dim)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        overflowX: 'auto',
                      }}
                    >
                      {p.detail}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function ProbeChip({ label, tone }: { label: string; tone?: 'destructive' }) {
  const color = tone === 'destructive' ? 'var(--destructive)' : 'var(--text-mute)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: '2px 6px',
      }}
    >
      {label}
    </span>
  );
}

// ── Story state footnote ─────────────────────────────────────────────

/**
 * Compact per-state story count strip. Lets a semi-technical reader
 * cross-check the verdict strip without switching to the Stories tab.
 * State order: done, failed, developing, merging, verifying, claimed, ready, blocked.
 */

const STATE_ORDER: StoryNodeState[] = [
  'done',
  'failed',
  'developing',
  'merging',
  'verifying',
  'claimed',
  'ready',
  'blocked',
];

function StorySummaryFootnote({ stories }: { stories: StoryNodeRow[] }) {
  const entries = useMemo(() => {
    const counts = new Map<StoryNodeState, number>();
    for (const s of stories) {
      counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
    }
    // Return in canonical order, omitting zero counts
    return STATE_ORDER.filter((st) => counts.has(st)).map((st) => ({
      state: st,
      count: counts.get(st)!,
    }));
  }, [stories]);

  if (entries.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        padding: '10px 14px',
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        alignItems: 'center',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          color: 'var(--text-faint)',
          flexShrink: 0,
        }}
      >
        Story states
      </span>

      {entries.map(({ state, count }) => (
        <span key={state} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <StoryNodeStatePill state={state} />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-dim)',
            }}
          >
            ×{count}
          </span>
        </span>
      ))}

      <span
        style={{
          marginLeft: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--text-mute)',
        }}
      >
        {stories.length} total
      </span>
    </div>
  );
}
