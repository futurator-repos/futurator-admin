'use client';

/**
 * Story 1.6.2 — Full Pipeline v2 Roadmap page.
 *
 * Route: /labs/roadmap
 * Deep-linkable anchors: #phase-1, #phase-2, #phase-3
 *
 * Phase data is sourced from src/lib/v2-phase-data.ts (hardcoded snapshot
 * for Phase 1; live sprint-status.yaml reading deferred to Phase 2).
 */

import Link from 'next/link';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { PhaseSection } from '@/components/labs/roadmap/phase-section';
import {
  V2_PHASES,
  PHASE_1_DONE_STORIES,
  PHASE_1_TOTAL_STORIES,
  PHASE_1_PROGRESS_PCT,
} from '@/lib/v2-phase-data';

function RoadmapContent() {
  return (
    <div className="space-y-8 pb-16">
      {/* Page header */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/labs"
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            Labs
          </Link>
          <span className="text-muted-foreground/50" aria-hidden>
            /
          </span>
          <span className="text-sm text-foreground">Pipeline v2 Roadmap</span>
        </div>

        <h1 className="mt-3 text-page-title">Pipeline v2 Roadmap</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Three phases that transform Labs into a fully agentic software-delivery pipeline. Each
          phase ships independently; later phases build on the substrate the previous one
          establishes.
        </p>

        {/* Progress summary bar */}
        <div className="mt-4 flex max-w-sm flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Phase 1 progress — {PHASE_1_DONE_STORIES}/{PHASE_1_TOTAL_STORIES} stories
            </span>
            <span className="tabular-nums font-medium">{PHASE_1_PROGRESS_PCT}%</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={PHASE_1_PROGRESS_PCT}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Phase 1 overall progress: ${PHASE_1_PROGRESS_PCT}%`}
          >
            <div
              className="h-full rounded-full bg-accent-blue transition-[width]"
              style={{ width: `${Math.max(PHASE_1_PROGRESS_PCT, 2)}%` }}
            />
          </div>
        </div>

        {/* Phase anchor navigation */}
        <nav className="mt-4 flex flex-wrap gap-2" aria-label="Phase navigation">
          {V2_PHASES.map((phase) => (
            <a
              key={phase.number}
              href={`#phase-${phase.number}`}
              className="rounded-md border border-border bg-muted/40 px-3 py-1 text-xs text-foreground hover:bg-muted"
            >
              Phase {phase.number} — {phase.status === 'active' ? 'Active' : 'Pending'}
            </a>
          ))}
        </nav>
      </div>

      {/* Phase sections */}
      {V2_PHASES.map((phase) => (
        <PhaseSection key={phase.number} phase={phase} />
      ))}

      {/* Footer reference */}
      <p className="text-xs text-muted-foreground/60">
        Source:{' '}
        <code className="font-mono">
          docs/concepts/pipeline-v2/futurator-pipeline-v2-5-consolidated.md
        </code>{' '}
        · Phase data snapshot updated manually until Phase 2 live-reading lands.
      </p>
    </div>
  );
}

export default function RoadmapPage() {
  return (
    <AuthGuard>
      <AppShell>
        <RoadmapContent />
      </AppShell>
    </AuthGuard>
  );
}
