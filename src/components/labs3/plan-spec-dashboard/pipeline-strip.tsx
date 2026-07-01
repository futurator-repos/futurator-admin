'use client';

import { Fragment } from 'react';
import type { StoryGraphModel, StoryBatchGroup } from './adapter';
import { ACTIVE_STORY_NODE_STATES } from '../shared/state-pill';

/**
 * Pipeline strip — Labs3's primary topology nav. Where legacy renders 5 fixed
 * lifecycle stages (Concept → Developing → QA → Deploy → Published), the SDD
 * model has no fixed stages: the ready-frontier walks topological *batches*
 * (cohortBatch levels). This strip renders one node per batch with its
 * done/total rollup, a pulsing dot on the active batch (the lowest batch that
 * still has incomplete stories), and ✓ on fully-done batches.
 *
 * Clicking a batch is optional (onSelectBatch) — the dependency Graph view (B3)
 * is the deep surface; this strip is the at-a-glance progress spine.
 */
export function PipelineStrip({
  model,
  onSelectBatch,
}: {
  model: StoryGraphModel;
  onSelectBatch?: (cohortBatch: number) => void;
}) {
  const batches = model.byBatch;

  // Active batch = first (lowest) batch that is not fully done. When all done,
  // the marker rests on the last batch.
  const activeIdx = (() => {
    const idx = batches.findIndex((b) => b.stories.some((s) => s.state !== 'done'));
    return idx === -1 ? Math.max(0, batches.length - 1) : idx;
  })();

  return (
    <div
      style={{
        padding: '18px 24px',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background:
          'linear-gradient(180deg, color-mix(in srgb, var(--foreground) 1.5%, transparent), transparent)',
        marginTop: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14, gap: 12 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Topological Frontier
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.05em',
          }}
        >
          {model.done}/{model.total} stories · {model.pct}%
        </span>
      </div>

      {batches.length === 0 ? (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-faint)',
            letterSpacing: '0.06em',
            padding: '8px 0',
          }}
        >
          No StoryNodes ingested yet — run this plan as pipeline-3 to populate the spec graph.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            gap: 0,
            overflowX: 'auto',
          }}
        >
          {batches.map((b, i) => (
            <Fragment key={b.cohortBatch}>
              <BatchNode
                batch={b}
                batchIdx={i}
                activeIdx={activeIdx}
                onClick={onSelectBatch ? () => onSelectBatch(b.cohortBatch) : undefined}
              />
              {i < batches.length - 1 && <Connector isPast={i < activeIdx} />}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchNode({
  batch,
  batchIdx,
  activeIdx,
  onClick,
}: {
  batch: StoryBatchGroup;
  batchIdx: number;
  activeIdx: number;
  onClick?: () => void;
}) {
  const total = batch.stories.length;
  const done = batch.stories.filter((s) => s.state === 'done').length;
  const failed = batch.stories.some((s) => s.state === 'failed');
  const active = batch.stories.some((s) => ACTIVE_STORY_NODE_STATES.has(s.state));

  const isComplete = total > 0 && done === total;
  const isCurrent = batchIdx === activeIdx;
  const isFuture = batchIdx > activeIdx && !isComplete;

  const dotColor = failed
    ? 'var(--destructive)'
    : isComplete
      ? 'var(--success)'
      : isCurrent || active
        ? 'var(--amber)'
        : 'var(--border-2)';

  const labelColor = isComplete
    ? 'var(--text-dim)'
    : isCurrent || active
      ? 'var(--foreground)'
      : 'var(--text-faint)';

  const showPulse = isCurrent || active;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-current={isCurrent ? 'step' : undefined}
      style={{
        flex: 1,
        minWidth: 88,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        position: 'relative',
        background: 'transparent',
        border: 'none',
        cursor: onClick ? 'pointer' : 'default',
        padding: '4px 0 6px',
        borderRadius: 4,
        transition: 'background 150ms',
      }}
      onMouseEnter={(e) => {
        if (onClick)
          e.currentTarget.style.background =
            'color-mix(in srgb, var(--foreground) 3%, transparent)';
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div
        style={{
          position: 'relative',
          height: 26,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {showPulse && (
          <span
            className="animate-pulse-soft"
            style={{
              position: 'absolute',
              width: 26,
              height: 26,
              borderRadius: '50%',
              border: `1px solid ${dotColor}`,
              opacity: 0.5,
            }}
          />
        )}
        <span
          style={{
            width: showPulse ? 12 : 8,
            height: showPulse ? 12 : 8,
            borderRadius: '50%',
            background: isFuture ? 'transparent' : dotColor,
            border: isFuture ? `1px solid ${dotColor}` : 'none',
            boxShadow: showPulse
              ? `0 0 12px color-mix(in srgb, ${dotColor} 40%, transparent)`
              : 'none',
            transition: 'all 300ms',
            display: 'inline-block',
          }}
        />
      </div>
      <div style={{ marginTop: 10, textAlign: 'center', padding: '0 8px' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: showPulse ? 500 : 400,
            color: labelColor,
            transition: 'color 200ms',
          }}
        >
          Batch {batch.cohortBatch}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: failed ? 'var(--destructive)' : 'var(--text-faint)',
            marginTop: 3,
            letterSpacing: '0.06em',
          }}
        >
          {done}/{total} done
          {failed ? ' · failed' : active && !isComplete ? ' · live' : ''}
        </div>
      </div>
    </button>
  );
}

function Connector({ isPast }: { isPast: boolean }) {
  return (
    <div
      style={{
        flexShrink: 0,
        width: 40,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 12,
      }}
    >
      <div
        style={{
          height: 1,
          width: '100%',
          background: isPast
            ? 'var(--text-dim)'
            : 'linear-gradient(90deg, var(--border-2), var(--border))',
          transition: 'background 200ms',
        }}
      />
    </div>
  );
}
