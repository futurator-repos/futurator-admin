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
 *              story count, rationale, critique/audit notes) above the
 *              dependency graph, rendered INLINE (B2, design D11) rather
 *              than linked out to a separate subtab — concept is now a
 *              single continuous panel: Intent → status → graph.
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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import type { AgentJobStatus } from '@/types/agent-orchestrator';
import type { Labs3ViewProps } from '../plan-spec-dashboard/constants';
import { fmtDuration } from '../plan-spec-dashboard/project-hero';
import { PlannerNarrativePanel, SpecGraphCanvas } from './spec-graph-view';
import type { StoryNodeRow } from '@/types/plan-spec';

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

/**
 * Pure grouping helper for the planner live-stream pane (I8) — no DOM, unit
 * testable standalone. Filters `agent_text` events and concatenates each
 * phase's (`stepId`'s) text in arrival order, returning groups in FIRST-SEEN
 * phase order. `eventType === 'agent_text'` is a daemon-only value not yet
 * declared on the shared `AgentEventType` union (owned by another slice) —
 * compared as a string rather than widening that type, mirroring this
 * file's existing `job.phase` cast (see file-header deviation note).
 */
export function groupAgentTextByPhase(
  events: { eventType: unknown; stepId?: string; text?: string }[],
): { phase: string; text: string }[] {
  const order: string[] = [];
  const byPhase = new Map<string, string>();
  for (const e of events) {
    if ((e.eventType as string) !== 'agent_text' || !e.text) continue;
    const phase = e.stepId || 'planner';
    if (!byPhase.has(phase)) {
      order.push(phase);
      byPhase.set(phase, '');
    }
    byPhase.set(phase, (byPhase.get(phase) || '') + e.text);
  }
  return order.map((phase) => ({ phase, text: byPhase.get(phase) || '' }));
}

/**
 * Terminal-style live-stream pane for the planner's assistant-text output
 * (I8 planner-stream wire). Fed by `useAgentEvents` against the mint job —
 * groups `agent_text` events by `stepId` (the phase the daemon tagged them
 * with: planner | parallelism-repair | critique | critique-repair) and
 * renders each group's accumulated text in arrival order.
 *
 * Sticks to the bottom on new output unless the operator has scrolled up to
 * read something (then it stays put until they scroll back down). Open by
 * default while RUNNING; auto-collapses ONCE when the job leaves RUNNING so
 * completed plans don't waste vertical space, but stays openable via the
 * header toggle either way.
 *
 * `eventType === 'agent_text'` is a daemon-only value not yet declared on
 * the shared `AgentEventType` union (owned by another slice) — compared as
 * a string rather than widening that type, mirroring this file's existing
 * `job.phase` cast (see file-header deviation note).
 */
function PlannerStreamPane({
  jobId,
  jobStatus,
}: {
  jobId: string | null;
  jobStatus: AgentJobStatus | undefined;
}) {
  const isRunning = jobStatus !== 'COMPLETED' && jobStatus !== 'FAILED';
  const { events } = useAgentEvents(jobId, jobStatus);
  // Derived (not effect-driven) open state: defaults to "open while RUNNING,
  // collapsed once terminal" and an explicit operator toggle overrides that
  // default for the rest of this pane's lifetime. Avoids a setState-in-effect
  // cascading-render lint trip for what is really just a derived value.
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? isRunning;

  const groups = useMemo(() => groupAgentTextByPhase(events), [events]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [groups, open]);

  if (!jobId || (!isRunning && groups.length === 0)) return null;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setUserOverride(!open)}
        aria-expanded={open}
        aria-controls="planner-stream-pane"
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '10px 14px',
          background: 'var(--bg-elev)',
          border: 'none',
          borderBottom: open ? '1px solid var(--border)' : 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, ...LABEL }}>
          {isRunning && <Loader2 size={11} className="animate-spin" />}
          {isRunning ? 'Streaming planner…' : 'Planner stream'}
        </span>
        {open ? (
          <ChevronUp size={14} color="var(--text-mute)" aria-hidden="true" />
        ) : (
          <ChevronDown size={14} color="var(--text-mute)" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div
          id="planner-stream-pane"
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label="Planner live output"
          style={{
            maxHeight: 260,
            overflowY: 'auto',
            padding: '12px 14px',
            background: '#0b0d12',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            lineHeight: 1.6,
            color: '#c9d1d9',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {groups.length === 0 ? (
            <span style={{ color: '#6e7681' }}>Waiting for planner output…</span>
          ) : (
            groups.map((g) => (
              <div key={g.phase} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    color: '#7ee787',
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    marginBottom: 4,
                  }}
                >
                  {g.phase}
                </div>
                {g.text}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Small generic chip echoing where a plan's intent was dispatched from
 * (B1 — mirrors `sealProvenance.source` verbatim, e.g. an external caller
 * name; renders whatever the field holds, no assumption about the caller).
 */
function ProvenanceChip({ source }: { source: string }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        padding: '1px 6px',
        borderRadius: 8,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        color: 'var(--text-mute)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
      title="Dispatch source"
    >
      {source}
    </span>
  );
}

/**
 * B1 (design D10) — always-rendered "Intent" card, reusing the
 * `PlannerNarrativePanel` collapsible-monospace pattern (a seal document can
 * be long markdown). Called at the top of EVERY concept-stage branch
 * (RUNNING/PENDING, FAILED, ingested, no-mint-telemetry) so `plan.intent` —
 * the received order — is visible for the plan's entire life, not just the
 * sub-minute RUNNING window it used to be inlined in.
 *
 * Renders whatever `plan.intent` holds verbatim; no assumption about caller
 * or content. Returns null only when there's genuinely no intent to show
 * (legacy plan / not yet persisted) — mirroring `PlannerNarrativePanel`'s
 * own no-content behavior.
 */
function IntentCard({
  intent,
  sealProvenance,
}: {
  intent?: string;
  sealProvenance?: { source: string };
}) {
  const [open, setOpen] = useState(false);
  if (!intent) return null;

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="intent-card-body"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--foreground)',
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms',
            color: 'var(--text-mute)',
            fontSize: 10,
          }}
        >
          ▶
        </span>
        <span style={LABEL}>Intent</span>
        {sealProvenance?.source && <ProvenanceChip source={sealProvenance.source} />}
      </button>
      {open && (
        <pre
          id="intent-card-body"
          style={{
            margin: 0,
            padding: '0 16px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            lineHeight: 1.6,
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowX: 'auto',
          }}
        >
          {intent}
        </pre>
      )}
    </div>
  );
}

/**
 * B2 (design D11) — the concept panel's inline dependency graph. Concept is
 * now a single continuous subtab (STAGE_DEFS['concept'].subtabs ===
 * ['plan-stage']; `plan-spec-dashboard/constants.ts`), so the graph that used
 * to live behind its own `graph` subtab renders here, directly below the
 * mint/planner status, reusing `SpecGraphCanvas` (extracted from
 * `spec-graph-view.tsx`) — zero duplicated layout/edge/detail-panel logic.
 * Renders nothing until stories exist; the status card above this already
 * communicates "still planning" so no redundant empty-state text is needed
 * here. Pure prop pass-through — no assumption about story count/content.
 */
function InlineDependencyGraph({
  stories,
  onSelectStory,
}: {
  stories: StoryNodeRow[];
  onSelectStory?: (storyId: string) => void;
}) {
  if (stories.length === 0) return null;
  return <SpecGraphCanvas stories={stories} onSelectStory={onSelectStory} />;
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
  const { appId, plan, stories } = props;
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

  // Stories ingested — the planner narrative is the plan's front door now.
  if (stories.length > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <IntentCard intent={plan?.intent} sealProvenance={plan?.sealProvenance} />
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
        </Card>
        <PlannerStreamPane jobId={mintJobId} jobStatus={job?.status} />
        <InlineDependencyGraph stories={stories} onSelectStory={props.onSelectStory} />
      </div>
    );
  }

  // No mint telemetry — either a legacy plan or the FK was never persisted.
  if (!mintJobId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <IntentCard intent={plan?.intent} sealProvenance={plan?.sealProvenance} />
        <Card>
          <div style={LABEL}>Planning</div>
          <p style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>
            No mint telemetry for this plan — it predates the quick-planspec job FK, or was created
            via the legacy planning chain. The dependency graph below will populate once stories are
            ingested.
          </p>
        </Card>
        <InlineDependencyGraph stories={stories} onSelectStory={props.onSelectStory} />
      </div>
    );
  }

  // FAILED — prominent error card, no fake retry button.
  if (job?.status === 'FAILED') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <IntentCard intent={plan?.intent} sealProvenance={plan?.sealProvenance} />
        <Card>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--destructive)' }}
          >
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
        <PlannerStreamPane jobId={mintJobId} jobStatus={job?.status} />
        <InlineDependencyGraph stories={stories} onSelectStory={props.onSelectStory} />
      </div>
    );
  }

  // RUNNING (or PENDING, or job still loading) — the live stepper.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <IntentCard intent={plan?.intent} sealProvenance={plan?.sealProvenance} />
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
      </Card>
      <PlannerStreamPane jobId={mintJobId} jobStatus={job?.status} />
      <InlineDependencyGraph stories={stories} onSelectStory={props.onSelectStory} />
    </div>
  );
}
