'use client';
import type { StoryStatus } from '@/types/epic-workflow';
import { STORY_STATUS_META, ACTIVE_STORY_STATUSES } from '../constants';

export function StatusPill({ status }: { status: StoryStatus }) {
  const meta = STORY_STATUS_META[status] ?? { label: status, color: 'var(--text-mute)' };
  const pulse =
    ACTIVE_STORY_STATUSES.includes(status) || status === 'queued';
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
        className={pulse ? 'animate-pulse-soft' : ''}
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
