'use client';

/**
 * Labs3 — StoryNode state pill (the SDD analogue of legacy's StatusPill).
 *
 * Legacy Labs renders a 9-value StoryStatus pill; Labs3 renders the
 * pipeline-3 StoryNodeState (blocked → ready → claimed → developing →
 * merging → verifying → done | failed). This module is the single source of
 * truth for state → {label, color} and for which states are "active" (and
 * therefore pulse + drive refetch). B3–B7 import from here; they never
 * redefine the meta map or the active set.
 */

import type { StoryNodeState } from '@/types/plan-spec';

export interface StoryNodeStateMeta {
  label: string;
  /** Semantic CSS variable (never a raw hex) for dot / ring / fill. */
  color: string;
}

/**
 * State → display meta. Colors reuse the existing Labs semantic theme tokens
 * so dark/light mode and the rest of the design system stay consistent:
 *   - ready      → accent-blue   (frontier, dispatchable)
 *   - claimed    → warning       (picked up, not yet running)
 *   - developing → accent-purple (matches legacy "running")
 *   - merging    → accent-blue   (committing on plan/<id>)
 *   - verifying  → warning       (bound-AC tests running)
 *   - done       → success
 *   - failed     → destructive
 *   - blocked    → text-mute     (waiting on depends_on)
 */
export const STORY_NODE_STATE_META: Record<StoryNodeState, StoryNodeStateMeta> = {
  blocked: { label: 'Blocked', color: 'var(--text-mute)' },
  ready: { label: 'Ready', color: 'var(--accent-blue)' },
  claimed: { label: 'Claimed', color: 'var(--warning)' },
  developing: { label: 'Developing', color: 'var(--accent-purple)' },
  merging: { label: 'Merging', color: 'var(--accent-blue)' },
  verifying: { label: 'Verifying', color: 'var(--warning)' },
  done: { label: 'Done', color: 'var(--success)' },
  failed: { label: 'Failed', color: 'var(--destructive)' },
};

/**
 * States the ready-frontier is actively churning through. Any row in one of
 * these states means the plan is "live" — used to (a) pulse the pill and
 * (b) gate refetchInterval in useStoryNodes (see hasActiveStory).
 */
export const ACTIVE_STORY_NODE_STATES: ReadonlySet<StoryNodeState> = new Set<StoryNodeState>([
  'ready',
  'claimed',
  'developing',
  'merging',
  'verifying',
]);

/**
 * 5px dot + uppercase mono label. Pulses when the state is active (or when
 * `pulse` is forced true by the caller). Mirrors legacy StatusPill exactly so
 * the two modules read as one design system.
 */
export function StoryNodeStatePill({ state, pulse }: { state: StoryNodeState; pulse?: boolean }) {
  const meta = STORY_NODE_STATE_META[state] ?? { label: state, color: 'var(--text-mute)' };
  const shouldPulse = pulse ?? ACTIVE_STORY_NODE_STATES.has(state);
  return (
    <span
      className="mono inline-flex items-center gap-1.5 whitespace-nowrap"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: meta.color,
        textTransform: 'uppercase',
        letterSpacing: '0.2em',
        fontWeight: 400,
      }}
    >
      <span
        className={shouldPulse ? 'animate-pulse-soft' : ''}
        style={{
          background: meta.color,
          width: 5,
          height: 5,
          borderRadius: '50%',
          display: 'inline-block',
        }}
      />
      {meta.label}
    </span>
  );
}
