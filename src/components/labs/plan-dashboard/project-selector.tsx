'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { usePlansList } from '@/hooks/use-plans';
import type { PlanSummary } from '@/types/plan';
import { PLAN_STATUS_META } from './constants';

function fmtRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtCost(c: number): string {
  return `$${(c ?? 0).toFixed(2)}`;
}

interface Props {
  currentPlanId: string;
}

export function ProjectSelector({ currentPlanId }: Props) {
  const router = useRouter();
  const { data: plans = [] } = usePlansList();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const [hoverIntent, setHoverIntent] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);
  // Reset search state when the dropdown transitions to closed. The guard on
  // previous value keeps updates idempotent; the eslint-disable is intentional
  // since resetting derived UI state on a boolean transition is a legitimate
  // effect (same pattern used elsewhere in this repo — see use-party-*).
  useEffect(() => {
    if (open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQ((prev) => (prev === '' ? prev : ''));
    setHoverIntent((prev) => (prev === null ? prev : null));
  }, [open]);

  const current = plans.find((p) => p.planId === currentPlanId);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    const base = plans.filter((p) => p.status !== 'archived');
    if (!needle) return base;
    return base.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.displayName ?? '').toLowerCase().includes(needle) ||
        p.intent.toLowerCase().includes(needle) ||
        p.status.toLowerCase().includes(needle),
    );
  }, [q, plans]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && filtered[focusIdx]) {
      selectPlan(filtered[focusIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function selectPlan(p: PlanSummary) {
    setOpen(false);
    router.push(`/labs/?planId=${p.planId}`);
  }

  const currentMeta = current ? PLAN_STATUS_META[current.status] : null;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-2)')}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.borderColor = 'var(--border)';
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 12px',
          borderRadius: 2,
          background: 'transparent',
          border: `1px solid ${open ? 'var(--border-2)' : 'var(--border)'}`,
          minWidth: 240,
          textAlign: 'left',
          transition: 'border-color 140ms',
          color: 'var(--foreground)',
          cursor: 'pointer',
        }}
      >
        {currentMeta && (
          <span
            style={{
              background: currentMeta.color,
              width: 6,
              height: 6,
              borderRadius: '50%',
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: 13,
            color: 'var(--foreground)',
            letterSpacing: '0.01em',
            fontWeight: 400,
          }}
        >
          {current ? current.displayName || current.name : 'Select plan'}
        </span>
        {currentMeta && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-mute)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginLeft: 4,
            }}
          >
            {currentMeta.label}
          </span>
        )}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 8,
            color: 'var(--text-faint)',
            transition: 'transform 150ms',
            transform: open ? 'rotate(180deg)' : 'rotate(0)',
          }}
        >
          ▼
        </span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            width: 460,
            zIndex: 100,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-2)',
            borderRadius: 2,
            boxShadow: '0 30px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.02)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 16px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              style={{ color: 'var(--text-mute)' }}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setFocusIdx(0);
              }}
              onKeyDown={onKey}
              placeholder="Search plans…"
              style={{
                flex: 1,
                fontSize: 13,
                color: 'var(--foreground)',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                letterSpacing: '0.01em',
              }}
            />
            <kbd
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--text-faint)',
                letterSpacing: '0.1em',
              }}
            >
              {filtered.length}
            </kbd>
          </div>

          <div style={{ maxHeight: 440, overflow: 'auto' }}>
            {filtered.length === 0 && (
              <div
                style={{
                  padding: 36,
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  fontSize: 12,
                }}
              >
                No plans match{' '}
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--foreground)' }}>
                  {q}
                </span>
              </div>
            )}
            {filtered.map((p, i) => {
              const meta = PLAN_STATUS_META[p.status];
              const active = i === focusIdx;
              const isCur = p.planId === currentPlanId;
              const pct =
                p.totalStories > 0 ? Math.round((p.doneStories / p.totalStories) * 100) : 0;
              const showTip = hoverIntent === p.planId;
              return (
                <div
                  key={p.planId}
                  onMouseEnter={() => {
                    setFocusIdx(i);
                    setHoverIntent(p.planId);
                  }}
                  onMouseLeave={() => setHoverIntent(null)}
                  onClick={() => selectPlan(p)}
                  style={{
                    position: 'relative',
                    padding: '14px 18px',
                    borderBottom:
                      i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                    background: active ? 'var(--surface)' : 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    transition: 'background 120ms',
                  }}
                >
                  <span
                    style={{
                      background: meta.color,
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      flexShrink: 0,
                      display: 'inline-block',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 5,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          color: 'var(--foreground)',
                          letterSpacing: '0.005em',
                        }}
                      >
                        {p.displayName || p.name}
                      </span>
                      {p.displayName && p.displayName !== p.name && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 9,
                            color: 'var(--text-faint)',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {p.name}
                        </span>
                      )}
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 8,
                          color: meta.color,
                          textTransform: 'uppercase',
                          letterSpacing: '0.18em',
                        }}
                      >
                        {meta.label}
                      </span>
                      {isCur && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 8,
                            color: 'var(--text-dim)',
                            marginLeft: 'auto',
                            letterSpacing: '0.18em',
                            textTransform: 'uppercase',
                          }}
                        >
                          current
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        fontSize: 9,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      <span style={{ color: 'var(--text-mute)' }}>
                        {p.doneStories}/{p.totalStories}
                      </span>
                      <span style={{ color: 'var(--text-faint)' }}>·</span>
                      <span style={{ color: 'var(--text-mute)' }}>{fmtCost(p.totalCostUsd)}</span>
                      <span style={{ color: 'var(--text-faint)' }}>·</span>
                      <span style={{ color: 'var(--text-mute)' }}>
                        {fmtRelative(p.updatedAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        height: 1,
                        background: 'var(--border)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: '100%',
                          background: meta.color,
                          transition: 'width 200ms',
                          opacity: 0.7,
                        }}
                      />
                    </div>
                  </div>

                  {showTip && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '50%',
                        left: 'calc(100% + 10px)',
                        transform: 'translateY(-50%)',
                        width: 300,
                        padding: '12px 14px',
                        zIndex: 200,
                        background: 'var(--background)',
                        border: '1px solid var(--border-2)',
                        borderRadius: 2,
                        boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
                      }}
                    >
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 8,
                          color: 'var(--text-faint)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.22em',
                          marginBottom: 6,
                        }}
                      >
                        Intent
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-dim)',
                          lineHeight: 1.55,
                        }}
                      >
                        {p.intent}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div
            style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 9,
              color: 'var(--text-faint)',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span>
              <kbd style={{ color: 'var(--text-mute)' }}>↑↓</kbd> nav
            </span>
            <span>
              <kbd style={{ color: 'var(--text-mute)' }}>↵</kbd> open
            </span>
            <span>
              <kbd style={{ color: 'var(--text-mute)' }}>esc</kbd> close
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push('/labs/');
              }}
              style={{
                marginLeft: 'auto',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                letterSpacing: 'inherit',
                textTransform: 'inherit',
              }}
            >
              ＋ New Plan
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
