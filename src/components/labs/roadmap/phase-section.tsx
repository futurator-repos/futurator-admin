'use client';

import type { PhaseData } from '@/lib/v2-phase-data';

const statusLabel: Record<string, string> = {
  backlog: 'backlog',
  'in-progress': 'in progress',
  done: 'done',
};

const statusClass: Record<string, string> = {
  backlog: 'bg-muted text-muted-foreground',
  'in-progress': 'bg-accent-blue/15 text-accent-blue',
  done: 'bg-success/15 text-success',
};

const phaseStatusClass: Record<string, string> = {
  active: 'border-accent-blue/40 bg-accent-blue/5',
  pending: 'border-border bg-card',
  done: 'border-success/40 bg-success/5',
};

const phaseStatusBadgeClass: Record<string, string> = {
  active: 'bg-accent-blue/15 text-accent-blue',
  pending: 'bg-muted text-muted-foreground',
  done: 'bg-success/15 text-success',
};

const phaseStatusLabel: Record<string, string> = {
  active: '⏳ Active',
  pending: '⏳ Pending',
  done: '✅ Done',
};

/**
 * Story 1.6.2 — full roadmap page section.
 * Renders one phase block with: status badge, narrative, epic list,
 * ship gate, and deferrals list.
 */
export function PhaseSection({ phase }: { phase: PhaseData }) {
  const anchorId = `phase-${phase.number}`;

  return (
    <section
      id={anchorId}
      aria-labelledby={`${anchorId}-heading`}
      className={`scroll-mt-24 rounded-xl border p-6 ${phaseStatusClass[phase.status]}`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`${anchorId}-heading`} className="text-xl font-semibold text-foreground">
            {phase.title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{phase.tagline}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${phaseStatusBadgeClass[phase.status]}`}
          >
            {phaseStatusLabel[phase.status]}
          </span>
          <span className="text-xs text-muted-foreground">{phase.duration}</span>
        </div>
      </div>

      {/* Narrative */}
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{phase.narrative}</p>

      {/* Epic list */}
      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Epics
        </h3>
        <ul className="space-y-2">
          {phase.epics.map((epic) => (
            <li
              key={epic.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-background/60 px-3 py-2"
            >
              <span className="text-sm text-foreground">{epic.title}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {epic.stories} {epic.stories === 1 ? 'story' : 'stories'} · {epic.effort}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass[epic.status]}`}
                >
                  {statusLabel[epic.status]}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Ship gate */}
      <div className="mt-5">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Ship gate
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{phase.shipGate}</p>
      </div>

      {/* Key deferrals */}
      <div className="mt-5">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Key deferrals
        </h3>
        <ul className="space-y-1">
          {phase.deferrals.map((d, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
              <span className="mt-0.5 shrink-0 text-muted-foreground/50" aria-hidden>
                ›
              </span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
