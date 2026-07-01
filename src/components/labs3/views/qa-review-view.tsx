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
 * Read-only — no send-back, no deploy promotion, no accept endpoints.
 * The pipeline executor (ready-frontier + story-dev jobs) is the authority;
 * this view observes the testBinding states it writes.
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
import { StoryNodeStatePill } from '@/components/labs3/shared/state-pill';
import type { StoryNodeRow, StoryNodeState } from '@/types/plan-spec';

// ── View props (matches Labs3ViewProps subset; shell passes full shape) ──

export interface QaReviewViewProps {
  planId: string;
  appId: string | null;
  stories: StoryNodeRow[];
  onSelectStory?: (storyId: string) => void;
}

// ── Root component ───────────────────────────────────────────────────

export function QaReviewView({ planId: _planId, stories }: QaReviewViewProps) {
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
