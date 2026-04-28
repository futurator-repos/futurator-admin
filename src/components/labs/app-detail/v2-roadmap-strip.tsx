'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { V2_PHASES, PHASE_1_PROGRESS_PCT, type PhaseData } from '@/lib/v2-phase-data';

const LS_KEY = 'v2-roadmap-collapsed';

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(LS_KEY);
    // Default: collapsed (true). Only override if explicitly stored as 'false'.
    return stored === null ? true : stored !== 'false';
  } catch {
    return true;
  }
}

function writeCollapsed(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, String(value));
  } catch {
    /* noop — storage may be unavailable */
  }
}

// ── Phase pill ─────────────────────────────────────────────────────────────

function PhasePill({ phase }: { phase: PhaseData }) {
  const isActive = phase.status === 'active';
  const isDone = phase.status === 'done';

  const pillClass = isActive
    ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30'
    : isDone
      ? 'bg-success/15 text-success border border-success/30'
      : 'bg-muted/60 text-muted-foreground border border-border';

  const indicator = isDone ? '✅' : isActive ? '⏳' : '⏳';

  return (
    <div className={`flex flex-col gap-1 rounded-md px-3 py-1.5 text-xs ${pillClass}`}>
      <div className="flex items-center gap-1.5 font-medium whitespace-nowrap">
        <span aria-hidden>{indicator}</span>
        <span>
          Phase {phase.number}
          {isActive ? ' — active' : isDone ? ' — done' : ' — pending'}
        </span>
      </div>

      {isActive && (
        <div className="flex items-center gap-2">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-accent-blue/20"
            role="progressbar"
            aria-valuenow={PHASE_1_PROGRESS_PCT}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Phase 1 progress: ${PHASE_1_PROGRESS_PCT}%`}
          >
            <div
              className="h-full rounded-full bg-accent-blue transition-[width]"
              style={{ width: `${Math.max(PHASE_1_PROGRESS_PCT, 3)}%` }}
            />
          </div>
          <span className="tabular-nums">{PHASE_1_PROGRESS_PCT}%</span>
        </div>
      )}
    </div>
  );
}

// ── Expanded body ──────────────────────────────────────────────────────────

function ExpandedBody() {
  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {V2_PHASES.map((phase) => (
          <div key={phase.number} className="space-y-1">
            <p className="text-xs font-semibold text-foreground">{phase.title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{phase.summary}</p>
            <p className="text-xs text-muted-foreground/70 italic">{phase.duration}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Link href="/labs/roadmap" className="text-xs text-accent-blue hover:underline">
          Read full roadmap →
        </Link>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

/**
 * Story 1.6.1 — collapsible Pipeline v2 Roadmap strip.
 * Rendered above the Plans timeline in AppDetailView.
 *
 * Persists expand/collapse state in localStorage under key `v2-roadmap-collapsed`.
 * Uses a lazy useState initializer (same pattern as ec2-toggle.tsx) to avoid
 * the react-hooks/set-state-in-effect lint rule.
 */
export function V2RoadmapStrip() {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
      {/* Header row — always visible, ~40px */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-controls="v2-roadmap-strip-body"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        className="flex cursor-pointer select-none items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Pipeline v2 Roadmap
          </span>
          {V2_PHASES.map((phase) => (
            <PhasePill key={phase.number} phase={phase} />
          ))}
        </div>
        <span className="text-muted-foreground" aria-hidden>
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </span>
      </div>

      {/* Expanded body */}
      {!collapsed && (
        <div id="v2-roadmap-strip-body">
          <ExpandedBody />
        </div>
      )}
    </div>
  );
}
