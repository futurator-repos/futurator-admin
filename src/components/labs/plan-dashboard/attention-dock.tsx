'use client';
/**
 * Attention Inbox right-side dock — Pipeline Enhancement Plan v2, Phase B.
 *
 * 420px panel that slides in from the right when the plan-hero bell is
 * clicked. Closes with Esc or by clicking the backdrop. Renders filter
 * chips (All / Critical / High / Medium / Low / Resolved), the sorted item
 * list, and per-item optimistic resolve.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  useAttentionItems,
  useResolveAttentionItem,
  type DedupedAttentionItem,
} from '@/hooks/use-attention-items';
import type { AttentionSeverity } from '../../../../functions/shared/types/attention';

type ChipKey = 'all' | AttentionSeverity | 'resolved';

const CHIPS: { key: ChipKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
  { key: 'resolved', label: 'Resolved' },
];

const SEVERITY_COLOR: Record<AttentionSeverity, string> = {
  critical: 'var(--destructive)',
  high: 'var(--amber, #f59e0b)',
  medium: 'var(--yellow, #eab308)',
  low: 'var(--accent-blue, #3b82f6)',
};

export function AttentionDock({
  planId,
  open,
  onClose,
}: {
  planId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [chip, setChip] = useState<ChipKey>('all');
  const { data } = useAttentionItems(planId);
  const resolveMut = useResolveAttentionItem(planId);
  // Track in-flight resolves so the card can show the optimistic "resolving"
  // state immediately without waiting for the server round-trip.
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const items = data?.items || [];
    if (chip === 'all') return items.filter((it) => it.status !== 'resolved');
    if (chip === 'resolved') return items.filter((it) => it.status === 'resolved');
    return items.filter((it) => it.severity === chip && it.status !== 'resolved');
  }, [data?.items, chip]);

  const countsBySeverity = useMemo(() => {
    const counts: Record<AttentionSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const it of data?.items || []) {
      if (it.status === 'resolved') continue;
      counts[it.severity] += 1;
    }
    return counts;
  }, [data?.items]);

  const resolvedCount = data?.items.filter((it) => it.status === 'resolved').length || 0;
  const allOpenCount = data?.unresolvedCount || 0;

  const handleResolve = (itemId: string) => {
    setResolving((prev) => {
      const next = new Set(prev);
      next.add(itemId);
      return next;
    });
    resolveMut.mutate(itemId, {
      onSettled: () => {
        setResolving((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      },
    });
  };

  return (
    <>
      {/* Backdrop — click to close. Non-interactive when closed. */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.35)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 180ms ease-out',
          zIndex: 70,
        }}
      />
      <aside
        role="complementary"
        aria-label="Attention inbox"
        aria-hidden={!open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '100vw',
          background: 'var(--card, var(--background))',
          borderLeft: '1px solid var(--border)',
          boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.4)',
          transform: `translateX(${open ? '0' : '110%'})`,
          transition: 'transform 200ms ease-out',
          zIndex: 71,
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--foreground)',
        }}
      >
        <DockHeader onClose={onClose} total={allOpenCount} />
        <DockChips
          active={chip}
          onChange={setChip}
          countsBySeverity={countsBySeverity}
          allOpenCount={allOpenCount}
          resolvedCount={resolvedCount}
        />
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 16px 24px',
          }}
        >
          {filtered.length === 0 ? (
            <DockEmpty chip={chip} />
          ) : (
            filtered.map((item) => (
              <AttentionCard
                key={item.itemId}
                item={item}
                resolving={resolving.has(item.itemId)}
                onResolve={() => handleResolve(item.itemId)}
                onOpenStory={() => {
                  const sid = item.context?.storyId;
                  if (sid) scrollToStory(sid);
                  onClose();
                }}
              />
            ))
          )}
        </div>
      </aside>
    </>
  );
}

function DockHeader({ onClose, total }: { onClose: () => void; total: number }) {
  return (
    <header
      style={{
        padding: '20px 16px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div>
        <div
          style={{
            fontSize: 9,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            marginBottom: 4,
          }}
        >
          Attention
        </div>
        <div
          style={{
            fontSize: 20,
            fontWeight: 300,
            color: 'var(--foreground)',
            letterSpacing: '-0.01em',
          }}
        >
          {total} unresolved
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close attention inbox"
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          color: 'var(--text-mute)',
          borderRadius: 6,
          width: 32,
          height: 32,
          cursor: 'pointer',
          fontSize: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ×
      </button>
    </header>
  );
}

function DockChips({
  active,
  onChange,
  countsBySeverity,
  allOpenCount,
  resolvedCount,
}: {
  active: ChipKey;
  onChange: (k: ChipKey) => void;
  countsBySeverity: Record<AttentionSeverity, number>;
  allOpenCount: number;
  resolvedCount: number;
}) {
  return (
    <div
      style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      {CHIPS.map((c) => {
        const isActive = c.key === active;
        const count =
          c.key === 'all'
            ? allOpenCount
            : c.key === 'resolved'
              ? resolvedCount
              : countsBySeverity[c.key as AttentionSeverity];
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onChange(c.key)}
            aria-pressed={isActive}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '5px 10px',
              borderRadius: 2,
              cursor: 'pointer',
              background: isActive
                ? 'color-mix(in srgb, var(--foreground) 10%, transparent)'
                : 'transparent',
              border: `1px solid ${isActive ? 'var(--foreground)' : 'var(--border)'}`,
              color: isActive ? 'var(--foreground)' : 'var(--text-mute)',
            }}
          >
            {c.label}
            <span
              style={{
                marginLeft: 6,
                color: isActive ? 'var(--foreground)' : 'var(--text-faint)',
                fontSize: 9,
              }}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DockEmpty({ chip }: { chip: ChipKey }) {
  const label =
    chip === 'all'
      ? 'No unresolved items'
      : chip === 'resolved'
        ? 'Nothing resolved yet'
        : `No ${chip} items`;
  return (
    <div
      style={{
        padding: '48px 16px',
        textAlign: 'center',
        color: 'var(--text-faint)',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em',
      }}
    >
      {label}
    </div>
  );
}

function AttentionCard({
  item,
  resolving,
  onResolve,
  onOpenStory,
}: {
  item: DedupedAttentionItem;
  resolving: boolean;
  onResolve: () => void;
  onOpenStory: () => void;
}) {
  const color = SEVERITY_COLOR[item.severity];
  const isResolved = item.status === 'resolved';
  const isResolving = resolving || item.status === 'resolving';
  const hasStory = !!item.context?.storyId;
  return (
    <article
      style={{
        position: 'relative',
        margin: '12px 0',
        padding: '14px 14px 14px 18px',
        background: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        overflow: 'hidden',
        opacity: isResolving ? 0.55 : isResolved ? 0.4 : 1,
        transition: 'opacity 160ms ease-out',
      }}
    >
      {/* Severity color bar */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: color,
        }}
      />
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color,
          }}
        >
          {item.severity} · {item.category}
        </span>
        <time
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            letterSpacing: '0.04em',
          }}
        >
          {formatRelative(item.createdAt)}
        </time>
      </header>
      <h3
        style={{
          fontSize: 14,
          fontWeight: 400,
          color: 'var(--foreground)',
          margin: '0 0 6px',
          lineHeight: 1.3,
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span style={{ flex: 1 }}>{item.title}</span>
        {item.duplicateCount > 0 && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: '0.06em',
              color: 'var(--text-faint)',
              border: '1px solid var(--border)',
              padding: '1px 6px',
              borderRadius: 10,
            }}
            title={`${item.duplicateCount + 1} similar events collapsed`}
          >
            +{item.duplicateCount}
          </span>
        )}
      </h3>
      {item.body && (
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-mute)',
            margin: '0 0 10px',
            lineHeight: 1.45,
          }}
        >
          {item.body}
        </p>
      )}
      {!isResolved && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onResolve}
            disabled={isResolving}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              padding: '5px 10px',
              borderRadius: 2,
              border: `1px solid ${color}`,
              background: `color-mix(in srgb, ${color} 8%, transparent)`,
              color,
              cursor: isResolving ? 'wait' : 'pointer',
            }}
          >
            {isResolving ? 'Resolving…' : 'Resolve'}
          </button>
          {hasStory && (
            <button
              type="button"
              onClick={onOpenStory}
              disabled={isResolving}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                padding: '5px 10px',
                borderRadius: 2,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-mute)',
                cursor: 'pointer',
              }}
            >
              Open story
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Scroll the hierarchy story row into view and briefly flash it.
 * The row gets id="story-<storyId>" from hierarchy-view.tsx (Phase B.5).
 */
function scrollToStory(storyId: string) {
  if (typeof window === 'undefined') return;
  // Allow the dock's close animation to settle before scrolling so the
  // target is actually visible when we jump to it.
  setTimeout(() => {
    const el = document.getElementById(`story-${storyId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = el.style.background;
    el.style.transition = 'background 800ms ease-out';
    el.style.background = 'color-mix(in srgb, var(--amber, #f59e0b) 18%, transparent)';
    setTimeout(() => {
      el.style.background = prev;
    }, 900);
  }, 220);
}

function formatRelative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(delta / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
