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

import { useMemo } from 'react';
import { VerdictStrip } from './qa/verdict-strip';
import { BoundAcTable } from './qa/bound-ac-table';
import { CohortMatrix } from './qa/cohort-matrix';
import { DevUrlCard, type DevPreviewStatus } from './qa/dev-url-card';
import { JourneyVerdicts } from './qa/journey-verdicts';
import { BeforeAfterGallery } from './qa/before-after-gallery';
import { WiringOrphanBanner } from './qa/wiring-orphan-banner';
import { QaActions } from './qa/qa-actions';
import { useP3QaReport } from '@/hooks/use-p3-qa-report';
import { StoryNodeStatePill } from '@/components/labs3/shared/state-pill';
import type { StoryNodeRow, StoryNodeState } from '@/types/plan-spec';
import type { P3QaReport, P3QaVerdict } from '@/types/qa-review-p3';

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
  if (p3Qa.enabled && p3Qa.report) {
    return <DeployedAppQaReview planId={planId} report={p3Qa.report} />;
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
      {/* Sticky verdict strip */}
      <VerdictStrip stories={stories} />

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
function DeployedAppQaReview({ planId, report }: { planId: string; report: P3QaReport }) {
  // The dev-preview BUILD status is independent of the QA verdict: if the app is
  // served at devUrl the build succeeded (a failed QA does NOT mean a failed
  // build — that's what the journey/wiring panels below report). Only show
  // 'deploying' when there's no URL yet.
  const devStatus: DevPreviewStatus = report.devUrl ? 'live' : 'deploying';
  // The GET endpoint carries the decision fields on the verdict; the report is
  // display-shaped. Reconstruct the verdict QaActions needs from the report.
  const verdict: P3QaVerdict = {
    status: report.status === 'passed' ? 'pass' : report.status === 'failed' ? 'fail' : 'uncertain',
    blocking: report.status === 'failed',
    ranAtSha: report.qaCommitSha,
    journeys: report.journeys,
    vqa: report.vqa,
    wiring: report.wiring,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <DevUrlCard devUrl={report.devUrl} qaCommitSha={report.qaCommitSha} status={devStatus} />
      <WiringOrphanBanner wiring={report.wiring} />
      <JourneyVerdicts journeys={report.journeys} />
      <BeforeAfterGallery journeys={report.journeys} />
      <QaActions planId={planId} verdict={verdict} currentQaCommitSha={report.qaCommitSha} />
    </div>
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
