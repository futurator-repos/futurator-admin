'use client';

import { useMemo, useState } from 'react';
import { useRunStory } from '@/hooks/use-epic-workflow';
import type { DashboardPlan, DashboardStory } from '../adapter';
import { flattenStories, fmtCost, fmtSec, fmtTokens } from '../adapter';
import { ACTIVE_STORY_STATUSES, KANBAN_COLUMNS, STORY_STATUS_META } from '../constants';

export function KanbanView({ plan }: { plan: DashboardPlan }) {
  const [filter, setFilter] = useState<string>('all');
  const [selected, setSelected] = useState<DashboardStory | null>(null);

  const allStories = useMemo(() => flattenStories(plan), [plan]);
  const columns = useMemo(
    () =>
      KANBAN_COLUMNS.map((c) => ({
        ...c,
        stories: allStories.filter(
          (s) =>
            c.matches.includes(s.status) && (filter === 'all' || s.epicId === filter),
        ),
      })),
    [allStories, filter],
  );

  const totalCost = useMemo(
    () =>
      columns.reduce(
        (a, c) => a + c.stories.reduce((b, s) => b + s.cost, 0),
        0,
      ),
    [columns],
  );

  return (
    <div>
      {/* Filter row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginRight: 4,
          }}
        >
          Filter
        </span>
        {[{ id: 'all', label: 'All epics' }, ...plan.epics.map((e) => ({ id: e.id, label: `${e.label} — ${e.title}` }))].map(
          (o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setFilter(o.id)}
              style={{
                padding: '5px 10px',
                borderRadius: 4,
                fontSize: 11,
                background:
                  filter === o.id
                    ? 'color-mix(in srgb, var(--success) 10%, transparent)'
                    : 'var(--surface)',
                border: `1px solid ${
                  filter === o.id ? 'var(--success)' : 'var(--border)'
                }`,
                color: filter === o.id ? 'var(--success)' : 'var(--text-dim)',
                fontWeight: filter === o.id ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {o.label}
            </button>
          ),
        )}
        <span
          style={{
            marginLeft: 'auto',
            color: 'var(--text-mute)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
          }}
        >
          Total this view:{' '}
          <span style={{ color: 'var(--amber)' }}>{fmtCost(totalCost)}</span>
        </span>
      </div>

      {/* Columns */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 12,
        }}
      >
        {columns.map((col) => {
          const colMeta = STORY_STATUS_META[col.id] ?? {
            label: col.label,
            color: 'var(--text-mute)',
          };
          return (
            <div
              key={col.id}
              style={{
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 520,
              }}
            >
              <div
                style={{
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  borderTop: `3px solid ${colMeta.color}`,
                  borderRadius: '10px 10px 0 0',
                }}
              >
                <span
                  style={{
                    background: colMeta.color,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    display: 'inline-block',
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--foreground)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {col.label}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--text-mute)',
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {col.stories.length}
                </span>
              </div>
              <div style={{ padding: 10, flex: 1, overflow: 'auto' }}>
                {col.stories.length === 0 ? (
                  <div
                    style={{
                      textAlign: 'center',
                      color: 'var(--text-faint)',
                      fontSize: 11,
                      padding: '24px 12px',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    — empty —
                  </div>
                ) : (
                  col.stories.map((s) => (
                    <KanbanCard key={s.id} story={s} onSelect={setSelected} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <StoryModal story={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────

function KanbanCard({
  story,
  onSelect,
}: {
  story: DashboardStory;
  onSelect: (s: DashboardStory) => void;
}) {
  const meta = STORY_STATUS_META[story.status];
  const prog = story.status === 'done' ? 100 : story.progress;
  const isActive = ACTIVE_STORY_STATUSES.includes(story.status);

  return (
    <div
      onClick={() => onSelect(story)}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${meta.color}`,
        borderRadius: 6,
        padding: '10px 12px',
        marginBottom: 8,
        cursor: 'pointer',
        transition: 'border-color 150ms, transform 150ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-2)';
        e.currentTarget.style.borderLeftColor = meta.color;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border)';
        e.currentTarget.style.borderLeftColor = meta.color;
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: meta.color,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          {story.id.slice(0, 8)}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'var(--text-faint)',
            padding: '1px 5px',
            borderRadius: 3,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
          }}
        >
          {story.epicLabel}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'var(--accent-purple)',
            padding: '1px 5px',
            borderRadius: 3,
            background:
              'color-mix(in srgb, var(--accent-purple) 10%, transparent)',
            border:
              '1px solid color-mix(in srgb, var(--accent-purple) 22%, transparent)',
          }}
        >
          W{story.wave}
        </span>
        {isActive && (
          <span
            className="animate-pulse-soft"
            style={{
              background: meta.color,
              width: 6,
              height: 6,
              borderRadius: '50%',
              marginLeft: 'auto',
              display: 'inline-block',
            }}
          />
        )}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--foreground)',
          fontWeight: 500,
          lineHeight: 1.35,
          marginBottom: 8,
          textWrap: 'pretty',
        }}
      >
        {story.label}
      </div>
      {isActive && (
        <div
          style={{
            height: 3,
            background: 'var(--border)',
            borderRadius: 2,
            overflow: 'hidden',
            marginBottom: 8,
          }}
        >
          <div
            style={{
              width: `${prog}%`,
              height: '100%',
              background: `linear-gradient(90deg, color-mix(in srgb, ${meta.color} 55%, transparent), ${meta.color})`,
              boxShadow: `0 0 6px color-mix(in srgb, ${meta.color} 45%, transparent)`,
              transition: 'width 300ms',
            }}
          />
        </div>
      )}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-mute)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>{story.sp}SP</span>
        <span style={{ color: 'var(--text-faint)' }}>·</span>
        <span>
          {story.status === 'done'
            ? fmtSec(story.actualSec)
            : fmtSec(story.plannedSec)}
        </span>
        {story.cost > 0 && (
          <>
            <span style={{ color: 'var(--text-faint)' }}>·</span>
            <span style={{ color: 'var(--amber)' }}>{fmtCost(story.cost)}</span>
          </>
        )}
        {story.tokens > 0 && (
          <span style={{ color: 'var(--cyan)', marginLeft: 'auto' }}>
            {fmtTokens(story.tokens)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────

function StoryModal({
  story,
  onClose,
}: {
  story: DashboardStory;
  onClose: () => void;
}) {
  const runStory = useRunStory();
  const meta = STORY_STATUS_META[story.status];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxHeight: '80vh',
          overflow: 'auto',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 10,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              color: meta.color,
              fontWeight: 700,
            }}
          >
            {story.id.slice(0, 10)}
          </span>
          <span
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: 'var(--foreground)',
            }}
          >
            {story.label}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              color: 'var(--text-mute)',
              fontSize: 18,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--text-dim)',
            lineHeight: 1.6,
            marginBottom: 14,
          }}
        >
          {story.desc}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 10,
            marginBottom: 14,
          }}
        >
          {[
            { l: 'Status', v: meta.label, c: meta.color },
            {
              l: 'Epic / Wave',
              v: `${story.epicLabel} / W${story.wave}`,
              c: 'var(--accent-purple)',
            },
            { l: 'Story points', v: `${story.sp} SP`, c: 'var(--foreground)' },
            { l: 'Planned', v: fmtSec(story.plannedSec), c: 'var(--text-dim)' },
            {
              l: 'Actual',
              v: story.actualSec != null ? fmtSec(story.actualSec) : '—',
              c: 'var(--text-dim)',
            },
            { l: 'Cost', v: fmtCost(story.cost), c: 'var(--amber)' },
          ].map((m) => (
            <div
              key={m.l}
              style={{
                padding: 10,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  marginBottom: 3,
                }}
              >
                {m.l}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: m.c,
                  fontWeight: 600,
                }}
              >
                {m.v}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() =>
              runStory.mutate({ epicId: story.epicId, storyId: story.id })
            }
            disabled={runStory.isPending}
            style={{
              fontSize: 12,
              padding: '7px 14px',
              borderRadius: 5,
              background:
                'color-mix(in srgb, var(--success) 12%, transparent)',
              border: '1px solid var(--success)',
              color: 'var(--success)',
              fontWeight: 600,
              cursor: runStory.isPending ? 'not-allowed' : 'pointer',
              opacity: runStory.isPending ? 0.6 : 1,
            }}
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
