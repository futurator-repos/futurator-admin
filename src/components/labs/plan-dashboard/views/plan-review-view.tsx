'use client';

/**
 * Plan Review view — shown for plans in the Concept stage.
 *
 * Purpose: present what the PM proposed (epics → waves → stories) and let the
 * operator either Regenerate or Start development. Designed for review, not
 * live monitoring (that's the Hierarchy view under the Developing stage).
 *
 * Ported from the layout pattern of the legacy plan-detail.tsx → Plan tab.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PlanWithEpics } from '@/hooks/use-plans';
import { usePatchPlan, useRegeneratePlan, useStartPlan } from '@/hooks/use-plans';
import type { AgentJobStatus } from '@/types/agent-orchestrator';
import type { EpicWorkflow } from '@/types/epic-workflow';
import { epicStatusColor } from '../constants';
import { StoryLiveOutput } from '@/components/labs/agentic-workflow/story-live-output';

interface Props {
  plan: PlanWithEpics;
  pmJobStatus?: AgentJobStatus;
  pmJobId?: string | null;
  applyPending?: boolean;
  onPmJobStarted?: (jobId: string) => void;
  onPlanStarted?: () => void;
}

export function PlanReviewView({
  plan,
  pmJobStatus,
  pmJobId,
  applyPending,
  onPmJobStarted,
  onPlanStarted,
}: Props) {
  const epics = plan.epics ?? [];
  const hasEpics = epics.length > 0;
  const isConcept = plan.status === 'concept';
  const pmRunning = pmJobStatus === 'PENDING' || pmJobStatus === 'RUNNING';
  const pmFailed = pmJobStatus === 'FAILED';
  const generating = pmRunning || !!applyPending;

  const patch = usePatchPlan(plan.planId);
  const regenerate = useRegeneratePlan(plan.planId);
  const start = useStartPlan(plan.planId);

  // Intent editor — kept in sync with server state. The effect handles
  // external updates (regenerate from another tab, or a polled refetch
  // returning a different intent). We only sync when the local draft is
  // pristine, otherwise we'd clobber the user's in-progress edit.
  const [intentDraft, setIntentDraft] = useState<string>(plan.intent);
  const [draftAnchor, setDraftAnchor] = useState<string>(plan.intent);
  useEffect(() => {
    if (intentDraft === draftAnchor) {
      setIntentDraft(plan.intent);
    }
    setDraftAnchor(plan.intent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.intent]);
  const intentDirty = intentDraft !== plan.intent;
  const canEditIntent = isConcept && !generating;

  async function saveIntent() {
    if (!intentDirty) return;
    try {
      await patch.mutateAsync({ intent: intentDraft });
    } catch (err) {
      console.error('[PlanReview] saveIntent', err);
    }
  }

  async function handleRegenerate() {
    if (intentDirty) await saveIntent();
    try {
      const result = await regenerate.mutateAsync();
      onPmJobStarted?.(result.pmJobId);
    } catch (err) {
      console.error('[PlanReview] regenerate', err);
    }
  }

  async function handleStart() {
    try {
      await start.mutateAsync();
      onPlanStarted?.();
    } catch (err) {
      console.error('[PlanReview] start', err);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Intent card */}
      <section
        style={{
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          padding: '18px 22px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}
        >
          <SectionHeader>Intent</SectionHeader>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {intentDirty && canEditIntent && (
              <GhostButton
                label={patch.isPending ? 'Saving…' : 'Save'}
                onClick={() => saveIntent()}
                disabled={patch.isPending}
              />
            )}
            {isConcept && (
              <GhostButton
                label={regenerate.isPending ? 'Starting…' : 'Regenerate'}
                onClick={handleRegenerate}
                disabled={regenerate.isPending || generating}
              />
            )}
            {isConcept && hasEpics && (
              <SolidButton
                label={start.isPending ? 'Launching…' : 'Start development →'}
                onClick={handleStart}
                disabled={start.isPending || generating}
              />
            )}
          </div>
        </div>
        <textarea
          value={intentDraft}
          onChange={(e) => setIntentDraft(e.target.value)}
          readOnly={!canEditIntent}
          rows={Math.min(10, Math.max(3, intentDraft.split('\n').length + 1))}
          style={{
            width: '100%',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '10px 12px',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--foreground)',
            fontFamily: 'var(--font-sans)',
            resize: 'vertical',
            outline: 'none',
            cursor: canEditIntent ? 'text' : 'default',
            opacity: canEditIntent ? 1 : 0.85,
          }}
        />
      </section>

      {/* PM-running / failed banner */}
      {generating && (
        <GeneratingBanner pmJobId={pmJobId} />
      )}
      {pmFailed && !generating && !hasEpics && (
        <FailedBanner />
      )}

      {/* PR-9 #2 — PM agent live logs. Reuses StoryLiveOutput so the
          Concept stage gets the same auditable stream the dev/reviewer
          stages already had. Visible whenever there's a PM job (running,
          completed, or failed); collapsed by default once epics land so
          the operator sees the structure first, the trace on demand. */}
      {pmJobId && <PmAgentLogPanel jobId={pmJobId} defaultOpen={!hasEpics || generating} />}

      {/* Epics list */}
      <section>
        <SectionHeader style={{ marginBottom: 10 }}>
          Epics{hasEpics && <span style={{ opacity: 0.5 }}> · {epics.length}</span>}
        </SectionHeader>

        {!hasEpics && !generating && !pmFailed && (
          <EmptyCard>
            No epics yet. Click <strong>Regenerate</strong> to kick off the PM agent.
          </EmptyCard>
        )}

        {generating && !hasEpics && (
          <EmptyCard faded>
            PM is drafting epics…
          </EmptyCard>
        )}

        {hasEpics && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {epics.map((e, idx) => (
              <EpicRow key={e.epicId} epic={e} label={`E${idx + 1}`} allEpics={epics} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────

function EpicRow({
  epic,
  label,
  allEpics,
}: {
  epic: EpicWorkflow;
  label: string;
  allEpics: EpicWorkflow[];
}) {
  const color = epicStatusColor(epic.status);
  const storiesByWave = new Map<number, typeof epic.stories>();
  for (const s of epic.stories) {
    const w = s.wave ?? 0;
    if (!storiesByWave.has(w)) storiesByWave.set(w, []);
    storiesByWave.get(w)!.push(s);
  }
  const waveNumbers = [...storiesByWave.keys()].sort((a, b) => a - b);
  const depLabels = (epic.dependsOnEpics ?? []).map((id) => {
    const idx = allEpics.findIndex((x) => x.epicId === id);
    return idx >= 0 ? `E${idx + 1}` : id;
  });
  const doneCount = epic.stories.filter((s) => s.status === 'done').length;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 6,
        padding: '14px 18px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            border: '1px solid var(--border-2)',
            padding: '2px 8px',
            borderRadius: 2,
            flexShrink: 0,
          }}
        >
          PW{epic.epicWave ?? 0}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-faint)',
            letterSpacing: '0.08em',
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: 15,
            fontWeight: 400,
            color: 'var(--foreground)',
            letterSpacing: '-0.005em',
            flex: 1,
            minWidth: 220,
          }}
        >
          {epic.title}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            flexShrink: 0,
          }}
        >
          {epic.status.replace('_', ' ')}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.04em',
            flexShrink: 0,
          }}
        >
          {doneCount}/{epic.stories.length}
        </span>
      </div>

      {epic.description && (
        <p
          style={{
            fontSize: 13,
            color: 'var(--text-dim)',
            lineHeight: 1.55,
            marginBottom: 8,
            textWrap: 'pretty',
          }}
        >
          {epic.description}
        </p>
      )}

      {depLabels.length > 0 && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            marginBottom: 12,
          }}
        >
          depends on: <span style={{ color: 'var(--text-dim)' }}>{depLabels.join(', ')}</span>
        </div>
      )}

      {/* Waves */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {waveNumbers.map((w) => {
          const items = storiesByWave.get(w) ?? [];
          const parallel = items.length > 1;
          return (
            <div
              key={w}
              style={{
                background:
                  'color-mix(in srgb, var(--foreground) 2%, transparent)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '8px 12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--accent-purple)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.22em',
                    padding: '2px 6px',
                    borderRadius: 2,
                    background:
                      'color-mix(in srgb, var(--accent-purple) 10%, transparent)',
                    border:
                      '1px solid color-mix(in srgb, var(--accent-purple) 22%, transparent)',
                  }}
                >
                  Wave {w}
                </span>
                {parallel ? (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: 'var(--accent-purple)',
                      letterSpacing: '0.12em',
                    }}
                  >
                    ⚡ {items.length} parallel
                  </span>
                ) : (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: 'var(--text-mute)',
                      letterSpacing: '0.12em',
                    }}
                  >
                    1 story
                  </span>
                )}
              </div>
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {items.map((story, sidx) => (
                  <StoryWithCriteria
                    key={story.storyId}
                    story={story}
                    label={`S${sidx + 1}`}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * PR-9 #3 — render a story row with collapsible AC list. Operator clicks
 * the row to expand and see the criteria the PM emitted. Resolves the
 * "PM gave me 4 stories with no visible structure" complaint — the
 * structure was always there in story.criteria[], just not surfaced on
 * the Concept stage.
 *
 * AC count badge always visible so operator can sanity-check rigor density
 * (prototype: 1-3 ACs/story; mvp: 3-5; production: 4-6).
 */
function StoryWithCriteria({
  story,
  label,
}: {
  story: EpicWorkflow['stories'][number];
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const criteria = story.criteria ?? [];
  const hasCriteria = criteria.length > 0;
  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: 'var(--foreground)',
      }}
    >
      <button
        type="button"
        onClick={() => hasCriteria && setExpanded((v) => !v)}
        disabled={!hasCriteria}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '3px 0',
          background: 'transparent',
          border: 'none',
          textAlign: 'left',
          color: 'inherit',
          cursor: hasCriteria ? 'pointer' : 'default',
          width: '100%',
          fontSize: 13,
        }}
      >
        <StoryDot status={story.status} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            letterSpacing: '0.08em',
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {story.title}
        </span>
        {hasCriteria ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-faint)',
              letterSpacing: '0.12em',
              border: '1px solid var(--border)',
              padding: '1px 6px',
              borderRadius: 2,
              flexShrink: 0,
            }}
            title="Acceptance criteria — click to expand"
          >
            {criteria.length} AC{criteria.length === 1 ? '' : 's'} {expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--destructive)',
              letterSpacing: '0.12em',
              flexShrink: 0,
            }}
            title="PM did not emit acceptance criteria for this story"
          >
            no AC
          </span>
        )}
      </button>
      {expanded && hasCriteria && (
        <ul
          style={{
            listStyle: 'none',
            padding: '4px 0 4px 24px',
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {criteria.map((c) => (
            <li
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12,
                color: 'var(--text-dim)',
                lineHeight: 1.5,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--text-faint)',
                  letterSpacing: '0.08em',
                  flexShrink: 0,
                  marginTop: 2,
                }}
              >
                {c.id}
              </span>
              <span style={{ flex: 1 }}>{c.text}</span>
              {c.needsBrowser && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    color: 'var(--accent-purple)',
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                  title="Requires browser/visual verification — will spawn a visual test"
                >
                  browser
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function StoryDot({ status }: { status: string }) {
  const color =
    status === 'done'
      ? 'var(--success)'
      : status === 'running'
        ? 'var(--accent-purple)'
        : status === 'queued'
          ? 'var(--warning)'
          : status === 'failed' || status === 'blocked'
            ? 'var(--destructive)'
            : 'var(--text-faint)';
  return (
    <span
      style={{
        width: 6,
        height: 6,
        background: color,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'inline-block',
      }}
      aria-label={status}
    />
  );
}

/**
 * PR-9 #2 — collapsible PM-agent log panel for the Concept stage.
 *
 * Surfaces the same stream-json trace the dev/reviewer stages already
 * expose, scoped to the PM job. Solves the "PM is not producing any
 * auditable logs" complaint — the trace was always captured by the
 * daemon (it's a regular agent-job with extractors) but the Concept
 * stage previously rendered just a "drafting…" spinner.
 */
function PmAgentLogPanel({
  jobId,
  defaultOpen,
}: {
  jobId: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SectionHeader>PM agent trace</SectionHeader>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-faint)',
              letterSpacing: '0.04em',
            }}
          >
            job {jobId.slice(0, 8)}
          </span>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.14em',
          }}
        >
          {open ? '▾ HIDE' : '▸ SHOW'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
          <StoryLiveOutput jobId={jobId} />
        </div>
      )}
    </section>
  );
}

function GeneratingBanner({ pmJobId }: { pmJobId?: string | null }) {
  return (
    <div
      style={{
        border: '1px dashed var(--border-2)',
        background:
          'color-mix(in srgb, var(--accent-purple) 8%, transparent)',
        borderRadius: 8,
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <Loader2
        size={16}
        className="animate-spin"
        style={{ color: 'var(--accent-purple)', flexShrink: 0 }}
      />
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 13,
            color: 'var(--foreground)',
            fontWeight: 500,
            marginBottom: 2,
          }}
        >
          PM agent is drafting your plan…
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.08em',
          }}
        >
          Epics and stories will appear as soon as the PM finishes.
          {pmJobId && (
            <>
              {' · '}
              <span style={{ color: 'var(--text-dim)' }}>job {pmJobId.slice(0, 8)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FailedBanner() {
  return (
    <div
      style={{
        border: '1px solid var(--destructive)',
        background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
        color: 'var(--destructive)',
        borderRadius: 8,
        padding: '14px 18px',
        fontSize: 13,
      }}
    >
      The PM agent failed to generate this plan. Click <strong>Regenerate</strong>{' '}
      to retry.
    </div>
  );
}

function EmptyCard({
  children,
  faded,
}: {
  children: React.ReactNode;
  faded?: boolean;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        padding: '26px 20px',
        textAlign: 'center',
        color: faded ? 'var(--text-faint)' : 'var(--text-mute)',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function SectionHeader({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.22em',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function GhostButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        padding: '6px 14px',
        border: '1px solid var(--border-2)',
        borderRadius: 2,
        color: 'var(--text-dim)',
        background: 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function SolidButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        padding: '6px 14px',
        border: '1px solid var(--foreground)',
        borderRadius: 2,
        color: 'var(--background)',
        background: 'var(--foreground)',
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}
