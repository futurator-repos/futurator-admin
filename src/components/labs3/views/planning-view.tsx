'use client';

/**
 * Labs3 · Planning view — the concept-stage surface (subtab='plan-stage').
 *
 * Design doc I2/U4. Renders the quick-planspec mint job's live status by
 * polling `plan.mintJobId` via `useAgentJob` (existing hook — refetches every
 * 1-2s while RUNNING, stops on COMPLETED/FAILED). Three top-level states:
 *
 *   RUNNING  — phase stepper (planner → parallelism-repair → critique →
 *              critique-repair → ingest) driven by `job.phase`, elapsed
 *              timer, model line, echoed intent, brownfield banner.
 *   FAILED   — error card with job.errorMessage + retry guidance (no fake
 *              retry button — quick-p3 mint jobs aren't resumable).
 *   ingested — planner narrative promoted front-and-center (shape badge,
 *              story count, rationale, critique/audit notes) above a link
 *              into the Graph tab.
 *
 * `mintPhaseSteps()` is exported standalone (pure, no DOM) so the phase→step
 * mapping is unit-testable without rendering.
 *
 * NOTE (deviation, see structured output): `job.phase` on `AgentJob` is
 * currently typed as `AgentJobPhase = 'epic-dev'|'epic-review'|'epic-build'`
 * (functions/shared/types/agent-orchestrator.ts / src/types/agent-orchestrator.ts)
 * — a different, pre-existing discriminator owned by another workstream. The
 * daemon's quick-planspec-runner.mjs (Wave A, A2) writes DIFFERENT string
 * values into that same field ('planner'|'parallelism-repair'|'critique'|
 * 'critique-repair'|'ingest'). Both are untyped at the DynamoDB/JS layer, so
 * this is a live type collision, not a runtime bug — reading it here requires
 * a local cast rather than widening the shared type (out of file-ownership
 * scope for this slice).
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useAgentJob } from '@/hooks/use-agent-job';
import type { Labs3ViewProps } from '../plan-spec-dashboard/constants';
import { links3 } from '@/lib/links3';
import { fmtDuration } from '../plan-spec-dashboard/project-hero';
import { PlannerNarrativePanel } from './spec-graph-view';

/** The quick-planspec mint job's possible phase markers, in pipeline order. */
export type MintPhase =
  | 'planner'
  | 'parallelism-repair'
  | 'critique'
  | 'critique-repair'
  | 'ingest';

export interface MintPhaseStep {
  id: MintPhase;
  label: string;
  /** 'done' | 'active' | 'pending' relative to the job's current phase. */
  state: 'done' | 'active' | 'pending';
}

const PHASE_ORDER: { id: MintPhase; label: string }[] = [
  { id: 'planner', label: 'Planner' },
  { id: 'parallelism-repair', label: 'Parallelism repair' },
  { id: 'critique', label: 'Critique' },
  { id: 'critique-repair', label: 'Critique repair' },
  { id: 'ingest', label: 'Ingest' },
];

/**
 * Pure phase→stepper mapping. `job` is loosely typed (`{ phase?: unknown }`)
 * because `AgentJob.phase` doesn't (yet) carry the quick-planspec phase
 * union — see the file-header deviation note. An absent/unrecognized phase
 * yields every step 'pending' (indeterminate — caller renders a generic
 * "Planning…" label rather than a stepper in that case).
 */
export function mintPhaseSteps(job: { phase?: unknown } | null | undefined): MintPhaseStep[] {
  const current = typeof job?.phase === 'string' ? (job.phase as MintPhase) : null;
  const currentIdx = current ? PHASE_ORDER.findIndex((p) => p.id === current) : -1;
  return PHASE_ORDER.map((p, i) => ({
    id: p.id,
    label: p.label,
    state:
      currentIdx < 0
        ? 'pending'
        : i < currentIdx
          ? 'done'
          : i === currentIdx
            ? 'active'
            : 'pending',
  }));
}

const LABEL = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  color: 'var(--text-faint)',
};

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '20px 22px',
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-elev)',
      }}
    >
      {children}
    </div>
  );
}

function PhaseStepper({
  steps,
  indeterminate,
}: {
  steps: MintPhaseStep[];
  indeterminate: boolean;
}) {
  if (indeterminate) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-dim)',
        }}
      >
        <Loader2 size={13} className="animate-spin" />
        Planning…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0 }}>
      {steps.map((step, i) => {
        const color =
          step.state === 'done'
            ? 'var(--success, #22c55e)'
            : step.state === 'active'
              ? 'var(--amber)'
              : 'var(--text-faint)';
        return (
          <div key={step.id} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {step.state === 'active' ? (
                <Loader2 size={11} className="animate-spin" color={color} />
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: step.state === 'done' ? color : 'transparent',
                    border: `1px solid ${color}`,
                  }}
                />
              )}
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.02em',
                  color: step.state === 'pending' ? 'var(--text-faint)' : 'var(--foreground)',
                }}
              >
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                style={{
                  width: 20,
                  height: 1,
                  margin: '0 8px',
                  background: 'var(--border)',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ElapsedTimer({ since }: { since?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  const ms = since ? now - new Date(since).getTime() : 0;
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)' }}>
      {since ? fmtDuration(ms) : '—'} elapsed
    </span>
  );
}

function BrownfieldBanner({ appId }: { appId: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        marginBottom: 14,
        borderRadius: 6,
        border: '1px solid var(--amber)55',
        background: 'color-mix(in srgb, var(--amber) 6%, transparent)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--amber)',
      }}
    >
      <AlertTriangle size={13} />
      Growing <strong style={{ fontWeight: 600 }}>{appId}</strong> — prior tests are locked as law
    </div>
  );
}

export function PlanningView(props: Labs3ViewProps) {
  const { planId, appId, plan, stories } = props;
  const mintJobId = plan?.mintJobId ?? null;
  const { data: job } = useAgentJob(mintJobId);

  // `job.phase` isn't (yet) declared on the client AgentJob type — the
  // daemon writes it as a best-effort untyped field (see file-header
  // deviation note). Read it via an unknown-shaped cast rather than
  // widening the shared type (out of file-ownership scope for this slice).
  const jobWithPhase = job as unknown as { phase?: unknown } | undefined;
  const phaseSteps = useMemo(() => mintPhaseSteps(jobWithPhase), [jobWithPhase]);
  const rawPhase = jobWithPhase?.phase;
  const indeterminate = rawPhase == null || !PHASE_ORDER.some((p) => p.id === rawPhase);

  const graphHref = links3.plan(planId, 'graph');

  // Stories ingested — the planner narrative is the plan's front door now.
  if (stories.length > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={LABEL}>Plan minted</div>
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)' }}
            >
              {stories.length} {stories.length === 1 ? 'story' : 'stories'}
            </span>
          </div>
          <PlannerNarrativePanel narrative={plan?.planNarrative} shape={plan?.planShape} />
          {!plan?.planNarrative && (
            <p
              style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}
            >
              Stories are ingested but no planner narrative was persisted for this plan.
            </p>
          )}
          <Link
            href={graphHref}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 12,
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.04em',
              textDecoration: 'none',
            }}
          >
            View dependency graph →
          </Link>
        </Card>
      </div>
    );
  }

  // No mint telemetry — either a legacy plan or the FK was never persisted.
  if (!mintJobId) {
    return (
      <Card>
        <div style={LABEL}>Planning</div>
        <p style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>
          No mint telemetry for this plan — it predates the quick-planspec job FK, or was created
          via the legacy planning chain. Watch the Graph tab; stories will appear once ingested.
        </p>
      </Card>
    );
  }

  // FAILED — prominent error card, no fake retry button.
  if (job?.status === 'FAILED') {
    return (
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--destructive)' }}>
          <AlertTriangle size={15} />
          <span style={{ ...LABEL, color: 'var(--destructive)' }}>Planning failed</span>
        </div>
        <p
          style={{
            marginTop: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {job.errorMessage || 'The mint job failed without an error message.'}
        </p>
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.55 }}>
          This mint job cannot be retried in place — create a new plan to try again.
        </p>
      </Card>
    );
  }

  // RUNNING (or PENDING, or job still loading) — the live stepper.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {plan?.kind === 'change' && appId && <BrownfieldBanner appId={appId} />}
      <Card>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={LABEL}>Planning</div>
          <ElapsedTimer since={job?.createdAt} />
        </div>

        <div style={{ marginTop: 14 }}>
          <PhaseStepper steps={phaseSteps} indeterminate={indeterminate} />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 16,
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-mute)',
          }}
        >
          <span>opus-4.8 · high effort</span>
        </div>

        {plan?.intent && (
          <p
            style={{
              marginTop: 12,
              fontSize: 12.5,
              color: 'var(--text-dim)',
              lineHeight: 1.55,
              fontStyle: 'italic',
            }}
          >
            “{plan.intent}”
          </p>
        )}
      </Card>
    </div>
  );
}
