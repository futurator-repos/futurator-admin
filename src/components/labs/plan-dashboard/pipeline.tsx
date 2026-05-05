'use client';
import { Fragment } from 'react';
import type { PlanStatus } from '@/types/plan';
import { PIPELINE_STAGES, pipelineStageIndexFor, type PipelineStage } from './constants';

/**
 * Pipeline — now the primary navigation for the plan dashboard. Each stage is
 * clickable. The "current" stage (visually highlighted with the pulsing dot)
 * reflects `plan.status`, which may differ from the stage the operator is
 * currently *viewing* (`activeStageId`).
 *
 * Layout: stages fill the width, then a Party Mode button floats on the right.
 * Party is always clickable; it never depends on `plan.status` or active stage.
 */
export function Pipeline({
  status,
  activeStageId,
  onStageChange,
  onPartyClick,
  isPartyActive,
}: {
  status: PlanStatus;
  activeStageId: PipelineStage['id'];
  onStageChange: (id: PipelineStage['id']) => void;
  onPartyClick: () => void;
  isPartyActive: boolean;
}) {
  // When the user has navigated past the data-backed status (e.g. clicked
  // Promote to Deploy — the backend doesn't have a `deploy` status so
  // plan.status is still `review`), advance the "current" marker to where
  // they are. This gives the pulsing dot a natural forward motion on
  // Promote; it never moves backwards below plan status.
  const baseIdx = pipelineStageIndexFor(status);
  const viewIdx = PIPELINE_STAGES.findIndex((s) => s.id === activeStageId);
  const statusIdx = viewIdx > baseIdx ? viewIdx : baseIdx;
  const isFixing = status === 'fixing';

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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: 14,
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Project Pipeline
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: isFixing ? 'var(--destructive)' : 'var(--text-mute)',
            letterSpacing: '0.05em',
          }}
        >
          {isFixing
            ? '⚠ fixing — blocked at developing'
            : `stage ${statusIdx + 1} of ${PIPELINE_STAGES.length}`}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 0,
        }}
      >
        {PIPELINE_STAGES.map((s, i) => (
          <Fragment key={s.id}>
            <StageNode
              stage={s}
              stageIdx={i}
              statusIdx={statusIdx}
              isFixing={isFixing}
              isViewing={s.id === activeStageId}
              onClick={() => onStageChange(s.id)}
            />
            {i < PIPELINE_STAGES.length - 1 && (
              <Connector isPast={i < statusIdx} />
            )}
          </Fragment>
        ))}

        {/* Divider + Party button (always visible, always clickable) */}
        <div
          style={{
            width: 1,
            margin: '4px 18px 4px 28px',
            background: 'var(--border)',
            flexShrink: 0,
          }}
        />
        <PartyButton active={isPartyActive} onClick={onPartyClick} />
      </div>
    </div>
  );
}

// ── Stage node ───────────────────────────────────────────────────────

function StageNode({
  stage,
  stageIdx,
  statusIdx,
  isFixing,
  isViewing,
  onClick,
}: {
  stage: PipelineStage;
  stageIdx: number;
  statusIdx: number;
  isFixing: boolean;
  isViewing: boolean;
  onClick: () => void;
}) {
  const isDone = stageIdx < statusIdx;
  const isCurrent = stageIdx === statusIdx;
  const isFuture = stageIdx > statusIdx;

  // Label color takes into account both the plan's position AND whether this
  // stage is the one being viewed. Viewing wins — we pop white when you're
  // looking at it, even if it's in the past/future.
  const labelColor = isViewing
    ? 'var(--foreground)'
    : isDone
      ? 'var(--text-dim)'
      : isCurrent
        ? isFixing
          ? 'var(--destructive)'
          : 'var(--foreground)'
        : 'var(--text-faint)';

  const dotColor = isDone
    ? 'var(--text-dim)'
    : isCurrent
      ? isFixing
        ? 'var(--destructive)'
        : 'var(--amber)'
      : 'var(--border-2)';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        position: 'relative',
        minWidth: 0,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '4px 0 6px',
        borderRadius: 4,
        transition: 'background 150ms',
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background =
          'color-mix(in srgb, var(--foreground) 3%, transparent)')
      }
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
        {isCurrent && (
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
            width: isCurrent ? 12 : 8,
            height: isCurrent ? 12 : 8,
            borderRadius: '50%',
            background: isFuture ? 'transparent' : dotColor,
            border: isFuture ? `1px solid ${dotColor}` : 'none',
            boxShadow: isCurrent
              ? `0 0 12px color-mix(in srgb, ${
                  isFixing ? 'var(--destructive)' : 'var(--amber)'
                } 40%, transparent)`
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
            fontWeight: isViewing || isCurrent ? 500 : 400,
            color: labelColor,
            letterSpacing: isCurrent ? '0.01em' : 0,
            transition: 'color 200ms',
          }}
        >
          {stage.label}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            marginTop: 3,
            letterSpacing: '0.06em',
          }}
        >
          {isCurrent && !isFixing
            ? '— in progress —'
            : isCurrent && isFixing
              ? '— recovering —'
              : stage.sub}
        </div>
      </div>
      {/* Underline indicates the stage currently being viewed */}
      <div
        style={{
          height: 2,
          width: isViewing ? '70%' : 0,
          background: 'var(--foreground)',
          marginTop: 6,
          borderRadius: 1,
          transition: 'width 200ms',
        }}
      />
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

// ── Party Mode button ────────────────────────────────────────────────

function PartyButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4px 16px 6px',
        background: active
          ? 'color-mix(in srgb, var(--accent-purple) 12%, transparent)'
          : 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        transition: 'background 150ms',
        minWidth: 100,
      }}
      onMouseEnter={(e) => {
        if (!active)
          e.currentTarget.style.background =
            'color-mix(in srgb, var(--foreground) 3%, transparent)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div
        style={{
          height: 26,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: active
              ? 'var(--accent-purple)'
              : 'color-mix(in srgb, var(--accent-purple) 40%, transparent)',
            boxShadow: active
              ? '0 0 12px color-mix(in srgb, var(--accent-purple) 40%, transparent)'
              : 'none',
            display: 'inline-block',
            transition: 'all 200ms',
          }}
        />
      </div>
      <div style={{ marginTop: 10, textAlign: 'center' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: active ? 500 : 400,
            color: active ? 'var(--foreground)' : 'var(--text-dim)',
            letterSpacing: active ? '0.01em' : 0,
            transition: 'color 200ms',
          }}
        >
          Party Mode
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            marginTop: 3,
            letterSpacing: '0.06em',
          }}
        >
          discuss anytime
        </div>
      </div>
      <div
        style={{
          height: 2,
          width: active ? '70%' : 0,
          background: 'var(--accent-purple)',
          marginTop: 6,
          borderRadius: 1,
          transition: 'width 200ms',
        }}
      />
    </button>
  );
}
