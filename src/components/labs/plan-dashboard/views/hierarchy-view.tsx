'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useRunStory } from '@/hooks/use-epic-workflow';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { useAttentionItems } from '@/hooks/use-attention-items';
import type { PlanWithEpics } from '@/hooks/use-plans';
import type { AgentJobStatus } from '@/types/agent-orchestrator';
import type {
  DashboardPlan,
  DashboardEpic,
  DashboardWave,
  DashboardStory,
  Aggregate,
} from '../adapter';
import { aggregateEpic, aggregateWave, fmtCost, fmtSec, fmtTokens } from '../adapter';
import { ACTIVE_STORY_STATUSES, STORY_STATUS_META, epicStatusColor } from '../constants';
import { MetricChip } from '../shared/metric-chip';
import { StatusPill } from '../shared/status-pill';
import { LogEntry } from '../shared/log-entry';
import { CopyLogButton } from '../shared/copy-log-button';

// ── Top-level view ───────────────────────────────────────────────────

export function HierarchyView({
  plan,
  agg,
  rawPlan,
  pmJobStatus,
  pmJobId,
  applyPending,
}: {
  plan: DashboardPlan;
  agg: Aggregate;
  /** Raw PlanWithEpics — only used for the concept/generating empty state. */
  rawPlan?: PlanWithEpics;
  pmJobStatus?: AgentJobStatus;
  pmJobId?: string | null;
  applyPending?: boolean;
}) {
  const initialExpanded = useMemo(() => {
    const o: Record<string, boolean> = {};
    plan.epics.forEach((e) => {
      o[e.id] = e.status === 'in_progress' || e.status === 'fixing';
      e.waves.forEach((w) => {
        o[w.id] = e.status === 'in_progress' || e.status === 'fixing';
      });
    });
    return o;
  }, [plan.epics]);
  const [exp, setExp] = useState<Record<string, boolean>>(initialExpanded);
  const [storyExp, setStoryExp] = useState<Record<string, boolean>>({});

  // Phase D.2: count unresolved attention items per epic (by context.epicId).
  const attention = useAttentionItems(plan.id);
  const attentionByEpic = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of attention.data?.items || []) {
      if (item.status === 'resolved') continue;
      const eid = item.context?.epicId;
      if (!eid) continue;
      map[eid] = (map[eid] || 0) + 1;
    }
    return map;
  }, [attention.data?.items]);

  if (plan.epics.length === 0) {
    const pmRunning = pmJobStatus === 'PENDING' || pmJobStatus === 'RUNNING';
    const pmFailed = pmJobStatus === 'FAILED';
    const generating = pmRunning || !!applyPending;
    return (
      <ConceptEmptyState
        plan={plan}
        rawPlan={rawPlan}
        generating={generating}
        pmFailed={pmFailed}
        pmJobId={pmJobId}
      />
    );
  }

  return (
    <div>
      <PlanRollup agg={agg} epicCount={plan.epics.length} />
      {plan.epics.map((e) => (
        <EpicCard
          key={e.id}
          epic={e}
          exp={exp}
          setExp={setExp}
          storyExp={storyExp}
          setStoryExp={setStoryExp}
          attentionCount={attentionByEpic[e.id] || 0}
        />
      ))}
    </div>
  );
}

// ── Plan rollup strip (6 metrics) ────────────────────────────────────

function PlanRollup({ agg, epicCount }: { agg: Aggregate; epicCount: number }) {
  const metrics = [
    {
      label: 'Plan time',
      value: `${fmtSec(agg.actual)} / ${fmtSec(agg.planned)}`,
      color: 'var(--foreground)',
    },
    {
      label: 'Stories done',
      value: `${agg.done} / ${agg.total}`,
      color: 'var(--success)',
    },
    { label: 'In flight', value: String(agg.running), color: 'var(--accent-purple)' },
    { label: 'Epics', value: String(epicCount), color: 'var(--accent-blue)' },
    { label: 'Tokens', value: fmtTokens(agg.tokens), color: 'var(--cyan)' },
    { label: 'Cost', value: fmtCost(agg.cost), color: 'var(--amber)' },
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        marginBottom: 28,
        padding: '24px 28px',
        border: '1px solid var(--border)',
      }}
    >
      {metrics.map((m, i) => (
        <div
          key={m.label}
          style={{
            paddingLeft: i === 0 ? 0 : 20,
            borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              color: 'var(--text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.24em',
              marginBottom: 10,
            }}
          >
            {m.label}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 24,
              color: m.color,
              fontWeight: 300,
              letterSpacing: '-0.01em',
            }}
          >
            {m.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Epic card ────────────────────────────────────────────────────────

interface EpicCardProps {
  epic: DashboardEpic;
  exp: Record<string, boolean>;
  setExp: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  storyExp: Record<string, boolean>;
  setStoryExp: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  /** Phase D.2: unresolved attention items referencing this epic. */
  attentionCount?: number;
}

function EpicCard({ epic, exp, setExp, storyExp, setStoryExp, attentionCount = 0 }: EpicCardProps) {
  const open = exp[epic.id];
  const agg = aggregateEpic(epic);
  const pct = Math.round(agg.progress);
  const statusColor = epicStatusColor(epic.status);

  return (
    <div
      style={{
        marginBottom: 1,
        background: 'transparent',
        border: '1px solid var(--border)',
        overflow: 'hidden',
        transition: 'border-color 150ms',
      }}
    >
      <div
        onClick={() => setExp((p) => ({ ...p, [epic.id]: !p[epic.id] }))}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px auto 1fr auto auto auto auto auto auto',
          alignItems: 'center',
          gap: 14,
          padding: '14px 18px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-mute)',
            transition: 'transform 160ms',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          PW{epic.planWave}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              marginBottom: 5,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-faint)',
                letterSpacing: '0.08em',
              }}
            >
              {epic.label}
            </span>
            <span
              style={{
                fontSize: 17,
                fontWeight: 300,
                color: 'var(--foreground)',
                letterSpacing: '-0.005em',
              }}
            >
              {epic.title}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: statusColor,
                textTransform: 'uppercase',
                letterSpacing: '0.22em',
              }}
            >
              {epic.status.replace('_', ' ')}
            </span>
            {attentionCount > 0 && <EpicAttentionDot count={attentionCount} />}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-mute)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '0.005em',
            }}
          >
            {epic.goal}
            {epic.dependsOnLabels.length > 0 && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-faint)',
                  marginLeft: 14,
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                }}
              >
                → {epic.dependsOnLabels.join(', ')}
              </span>
            )}
          </div>
        </div>
        <div style={{ width: 140, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: statusColor,
                transition: 'width 300ms',
                opacity: agg.running ? 1 : 0.7,
              }}
            />
          </div>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: statusColor,
              minWidth: 32,
              textAlign: 'right',
              letterSpacing: '0.02em',
            }}
          >
            {pct}%
          </span>
        </div>
        <MetricChip
          label="time"
          value={`${fmtSec(agg.actual)} / ${fmtSec(agg.planned)}`}
          color="var(--text-dim)"
        />
        <MetricChip label="waves" value={String(epic.waves.length)} color="var(--text-dim)" />
        <MetricChip label="tokens" value={fmtTokens(agg.tokens)} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(agg.cost)} color="var(--amber)" />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--foreground)',
            fontWeight: 400,
            letterSpacing: '0.02em',
          }}
        >
          {agg.done}/{agg.total}
        </span>
      </div>
      {open && (
        <div
          style={{
            background: 'color-mix(in srgb, var(--foreground) 1%, transparent)',
          }}
        >
          {epic.waves.map((w) => (
            <WaveRow
              key={w.id}
              epic={epic}
              wave={w}
              exp={exp}
              setExp={setExp}
              storyExp={storyExp}
              setStoryExp={setStoryExp}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Wave row ─────────────────────────────────────────────────────────

function WaveRow({
  epic,
  wave,
  exp,
  setExp,
  storyExp,
  setStoryExp,
}: {
  epic: DashboardEpic;
  wave: DashboardWave;
  exp: Record<string, boolean>;
  setExp: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  storyExp: Record<string, boolean>;
  setStoryExp: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) {
  const open = exp[wave.id];
  const agg = aggregateWave(wave);
  const pct = Math.round(agg.progress);
  const isParallel = wave.stories.length > 1;
  // 2026-05-30 — completion wins over "active". `agg.running` counts
  // ACTIVE_STATUSES, which includes 'fixing'; a wave whose stories are all
  // `done` (100%, e.g. 3/3) but which sits under a `fixing` epic was rendering
  // the purple "in-progress" bar despite being complete. A wave is complete
  // iff every story is done — show success then, regardless of epic status.
  const isComplete = agg.total > 0 && agg.done === agg.total;
  const anyRunning = !isComplete && agg.running > 0;

  return (
    <div>
      <div
        onClick={() => setExp((p) => ({ ...p, [wave.id]: !p[wave.id] }))}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 100px 1fr auto auto auto auto auto',
          alignItems: 'center',
          gap: 14,
          padding: '10px 18px 10px 36px',
          cursor: 'pointer',
          background: 'transparent',
          borderTop: '1px solid var(--border)',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-mute)',
            transition: 'transform 160ms',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--accent-purple)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          {wave.label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-dim)',
              letterSpacing: '0.005em',
            }}
          >
            {wave.stories.length} {wave.stories.length === 1 ? 'story' : 'stories'}
            {isParallel && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--accent-purple)',
                  marginLeft: 12,
                  fontSize: 9,
                  textTransform: 'uppercase',
                  letterSpacing: '0.22em',
                }}
              >
                ∥ parallel
              </span>
            )}
          </span>
        </div>
        <div style={{ width: 120, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: anyRunning ? 'var(--accent-purple)' : 'var(--success)',
                transition: 'width 300ms',
                opacity: anyRunning ? 1 : 0.7,
              }}
            />
          </div>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-mute)',
              minWidth: 28,
              textAlign: 'right',
            }}
          >
            {pct}%
          </span>
        </div>
        <MetricChip
          label="time"
          value={`${fmtSec(agg.actual)} / ${fmtSec(agg.planned)}`}
          color="var(--text-dim)"
        />
        <MetricChip label="tokens" value={fmtTokens(agg.tokens)} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(agg.cost)} color="var(--amber)" />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {agg.done}/{agg.total}
        </span>
      </div>
      {open &&
        wave.stories.map((s) => (
          <StoryRow
            key={s.id}
            story={s}
            epicId={epic.id}
            expanded={!!storyExp[s.id]}
            onToggle={() => setStoryExp((p) => ({ ...p, [s.id]: !p[s.id] }))}
          />
        ))}
    </div>
  );
}

// ── Story row ────────────────────────────────────────────────────────

function StoryRow({
  story,
  epicId,
  expanded,
  onToggle,
}: {
  story: DashboardStory;
  epicId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = STORY_STATUS_META[story.status];
  const prog = story.status === 'done' ? 100 : story.progress;
  const isActive = ACTIVE_STORY_STATUSES.includes(story.status);

  const timeValue =
    story.status === 'done'
      ? fmtSec(story.actualSec)
      : isActive
        ? `${fmtSec(story.actualSec ?? (story.plannedSec * prog) / 100)}…`
        : fmtSec(story.plannedSec);

  return (
    <div
      id={`story-${story.id}`}
      data-story-id={story.id}
      style={{ borderTop: '1px solid var(--border)' }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '24px 60px 1fr auto auto auto auto auto auto',
          alignItems: 'center',
          gap: 14,
          padding: '12px 18px 12px 54px',
          cursor: 'pointer',
          transition: 'background 120ms',
          background: expanded
            ? 'color-mix(in srgb, var(--foreground) 2.5%, transparent)'
            : 'transparent',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-faint)',
            transition: 'transform 160ms',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {story.id.slice(0, 10)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              color: 'var(--foreground)',
              fontWeight: 400,
              marginBottom: 3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '0.005em',
            }}
          >
            {story.label}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-mute)',
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
            }}
          >
            <span>{story.sp} SP</span>
            {story.agent && (
              <>
                <span style={{ color: 'var(--text-faint)' }}>·</span>
                <span>{story.agent}</span>
              </>
            )}
            {story.touchPoints.length > 0 && (
              <>
                <span style={{ color: 'var(--text-faint)' }}>·</span>
                <span>
                  {story.touchPoints.length} file{story.touchPoints.length === 1 ? '' : 's'}
                </span>
              </>
            )}
          </div>
        </div>
        <div style={{ width: 120, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${prog}%`,
                height: '100%',
                background: meta.color,
                transition: 'width 300ms',
                opacity: isActive ? 1 : 0.7,
              }}
            />
          </div>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-mute)',
              minWidth: 28,
              textAlign: 'right',
            }}
          >
            {Math.round(prog)}%
          </span>
        </div>
        <MetricChip label="time" value={timeValue} color="var(--text-dim)" />
        <MetricChip label="tokens" value={fmtTokens(story.tokens)} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(story.cost)} color="var(--amber)" />
        <StatusPill status={story.status} />
        {story.retryAttempt > 0 && (
          <RetryPill attempt={story.retryAttempt} max={story.maxRetries} />
        )}
      </div>

      {expanded && <StoryDetailPanel story={story} epicId={epicId} />}
    </div>
  );
}

// ── Expanded story detail (left: AC+touches; right: live log) ───────

function StoryDetailPanel({ story, epicId }: { story: DashboardStory; epicId: string }) {
  const isActive = ACTIVE_STORY_STATUSES.includes(story.status);
  const { data: job } = useAgentJob(story.jobId);
  const { events } = useAgentEvents(story.jobId, job?.status);
  const runStory = useRunStory();
  // Phase C.5: Overview | Logs tab. Logs is a full-text, copy-friendly
  // pane (per-step) for pasting into chat when debugging.
  const [tab, setTab] = useState<'overview' | 'logs'>('overview');

  function onRetry() {
    runStory.mutate({ epicId, storyId: story.id });
  }

  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--foreground) 1.5%, transparent)',
        padding: '20px 54px 24px',
        borderTop: '1px solid var(--border)',
      }}
    >
      <StoryDetailTabs active={tab} onChange={setTab} />
      {tab === 'logs' ? (
        <StoryLogsPane events={events} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr',
            gap: 28,
          }}
        >
          <div>
            <SectionLabel>Description</SectionLabel>
            <p
              style={{
                fontSize: 13,
                color: 'var(--text-dim)',
                lineHeight: 1.65,
                marginBottom: 20,
                textWrap: 'pretty',
              }}
            >
              {story.desc}
            </p>

            {story.criteria.length > 0 && (
              <>
                <SectionLabel>Acceptance criteria</SectionLabel>
                <div
                  style={{
                    marginBottom: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  {story.criteria.map((c, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12,
                      }}
                    >
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                          border: `1px solid ${c.done ? 'var(--success)' : 'var(--border-2)'}`,
                          background: c.done
                            ? 'color-mix(in srgb, var(--success) 8%, transparent)'
                            : 'transparent',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--success)',
                          fontSize: 10,
                          flexShrink: 0,
                        }}
                      >
                        {c.done ? '✓' : ''}
                      </span>
                      <span
                        style={{
                          color: c.done ? 'var(--text-dim)' : 'var(--foreground)',
                          textDecoration: c.done ? 'line-through' : 'none',
                          textDecorationColor: 'var(--text-faint)',
                        }}
                      >
                        {c.text}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {story.touchPoints.length > 0 && (
              <>
                <SectionLabel>Touch points</SectionLabel>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {story.touchPoints.map((p) => (
                    <span
                      key={p}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        padding: '3px 8px',
                        border: '1px solid var(--border)',
                        color: 'var(--text-dim)',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              }}
            >
              <SectionLabel noMargin>Live log</SectionLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isActive && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: 'var(--accent-purple)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      textTransform: 'uppercase',
                      letterSpacing: '0.22em',
                    }}
                  >
                    <span
                      className="animate-pulse-soft"
                      style={{
                        background: 'var(--accent-purple)',
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        display: 'inline-block',
                      }}
                    />
                    streaming
                  </span>
                )}
                <CopyLogButton events={events} compact />
              </div>
            </div>
            <div
              style={{
                background: 'var(--background)',
                border: '1px solid var(--border)',
                padding: '10px 14px',
                maxHeight: 240,
                overflow: 'auto',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {events.length > 0 ? (
                events.map((ev) => <LogEntry key={`${ev.jobId}-${ev.eventSeq}`} event={ev} />)
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-faint)',
                    padding: '8px 0',
                    textAlign: 'center',
                    letterSpacing: '0.08em',
                  }}
                >
                  {story.jobId
                    ? 'No log events yet — waiting for job.'
                    : `No log events — story is ${story.status}.`}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <GhostButton label="Retry" onClick={onRetry} disabled={runStory.isPending} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Phase C.5: Story detail tabs + logs pane ─────────────────────────

function StoryDetailTabs({
  active,
  onChange,
}: {
  active: 'overview' | 'logs';
  onChange: (v: 'overview' | 'logs') => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 18,
        borderBottom: '1px solid var(--border)',
        marginBottom: 18,
      }}
    >
      {(['overview', 'logs'] as const).map((k) => {
        const isActive = k === active;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onChange(k)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${isActive ? 'var(--foreground)' : 'transparent'}`,
              padding: '6px 2px 10px',
              color: isActive ? 'var(--foreground)' : 'var(--text-mute)',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
            }}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
}

function StoryLogsPane({ events }: { events: import('@/types/agent-orchestrator').AgentEvent[] }) {
  const steps = useMemo(() => {
    const uniq = new Map<string, number>();
    for (const ev of events) uniq.set(ev.stepId, (uniq.get(ev.stepId) || 0) + 1);
    return Array.from(uniq.entries()); // [stepId, count][]
  }, [events]);
  const [selected, setSelected] = useState<string>('all');
  const filtered = useMemo(
    () => (selected === 'all' ? events : events.filter((e) => e.stepId === selected)),
    [events, selected],
  );

  // Render text mirrors CopyLogButton's formatEventsForClipboard so the
  // pasted text and the on-screen text stay identical.
  const text = useMemo(() => {
    return filtered
      .map((ev) => {
        const ts = ev.timestamp || '';
        const header = `[${ts}] ${ev.stepId} / ${ev.agentId} / ${ev.eventType}`;
        const body =
          ev.eventType === 'tool_use'
            ? `  tool: ${ev.toolName}\n  input: ${ev.toolInput || ''}`
            : ev.eventType === 'tool_result'
              ? `  output: ${ev.toolOutput || ''}`
              : ev.text || '';
        return `${header}\n${body}`;
      })
      .join('\n\n');
  }, [filtered]);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <LogStepChip
            label={`all · ${events.length}`}
            active={selected === 'all'}
            onClick={() => setSelected('all')}
          />
          {steps.map(([stepId, count]) => (
            <LogStepChip
              key={stepId}
              label={`${stepId} · ${count}`}
              active={selected === stepId}
              onClick={() => setSelected(stepId)}
            />
          ))}
        </div>
        <CopyLogButton events={filtered} label="Copy to clipboard" />
      </div>
      <pre
        style={{
          background: 'var(--background)',
          border: '1px solid var(--border)',
          padding: '14px 16px',
          margin: 0,
          maxHeight: 520,
          overflow: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--text-dim)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text || 'No log events yet for this selection.'}
      </pre>
    </div>
  );
}

function LogStepChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.06em',
        padding: '5px 10px',
        borderRadius: 2,
        border: `1px solid ${active ? 'var(--foreground)' : 'var(--border)'}`,
        background: active
          ? 'color-mix(in srgb, var(--foreground) 8%, transparent)'
          : 'transparent',
        color: active ? 'var(--foreground)' : 'var(--text-mute)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

// Phase D.3: retry-count pill on story rows. Shown only when a story's
// linked job has retried at least once (daemon's exponential-backoff
// ladder). Amber visual to mirror the budget banner + attention dot.
function RetryPill({ attempt, max }: { attempt: number; max: number }) {
  return (
    <span
      title={`Retry ${attempt} of ${max} — daemon backoff ladder`}
      aria-label={`Retry ${attempt} of ${max}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        borderRadius: 2,
        border: '1px solid var(--amber, #f59e0b)',
        background: 'color-mix(in srgb, var(--amber, #f59e0b) 10%, transparent)',
        color: 'var(--amber, #f59e0b)',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      retry {attempt}/{max}
    </span>
  );
}

// Phase D.2: amber dot with unresolved-attention count on epic rows.
function EpicAttentionDot({ count }: { count: number }) {
  return (
    <span
      title={`${count} unresolved attention item${count === 1 ? '' : 's'} on this epic`}
      aria-label={`${count} unresolved attention items`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 7px',
        borderRadius: 10,
        background: 'color-mix(in srgb, var(--amber, #f59e0b) 14%, transparent)',
        border: '1px solid var(--amber, #f59e0b)',
        color: 'var(--amber, #f59e0b)',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.06em',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'var(--amber, #f59e0b)',
          display: 'inline-block',
        }}
      />
      {count}
    </span>
  );
}

function SectionLabel({ children, noMargin }: { children: React.ReactNode; noMargin?: boolean }) {
  return (
    <div
      style={{
        fontSize: 8,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.24em',
        marginBottom: noMargin ? 0 : 10,
        fontFamily: 'var(--font-mono)',
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
        padding: '7px 14px',
        border: '1px solid var(--border-2)',
        color: 'var(--text-dim)',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        background: 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

// ── Concept / generating empty state ─────────────────────────────────

function ConceptEmptyState({
  plan,
  rawPlan,
  generating,
  pmFailed,
  pmJobId,
}: {
  plan: DashboardPlan;
  rawPlan?: PlanWithEpics;
  generating: boolean;
  pmFailed: boolean;
  pmJobId?: string | null;
}) {
  const intent = rawPlan?.intent ?? plan.intent;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Intent card */}
      <div
        style={{
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          padding: '18px 22px',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.24em',
            marginBottom: 12,
          }}
        >
          Intent
        </div>
        <p
          style={{
            fontSize: 14,
            color: 'var(--foreground)',
            lineHeight: 1.55,
            margin: 0,
            textWrap: 'pretty',
          }}
        >
          {intent || <em style={{ color: 'var(--text-mute)' }}>No intent set.</em>}
        </p>
      </div>

      {/* Status card */}
      {generating && (
        <div
          style={{
            border: '1px dashed var(--border-2)',
            background: 'color-mix(in srgb, var(--accent-purple) 8%, transparent)',
            borderRadius: 8,
            padding: '18px 22px',
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
              PM agent is generating your plan…
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-mute)',
                letterSpacing: '0.08em',
              }}
            >
              Epics and stories will appear here the moment the PM finishes.
              {pmJobId && (
                <>
                  {' · '}
                  <span style={{ color: 'var(--text-dim)' }}>job {pmJobId.slice(0, 8)}</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {pmFailed && !generating && (
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
          The PM agent failed to generate this plan. Click <strong>Regenerate</strong> in the tab
          bar above to try again.
        </div>
      )}

      {!generating && !pmFailed && (
        <div
          style={{
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            borderRadius: 8,
            padding: '28px 22px',
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 13,
          }}
        >
          No epics yet. Click <strong>Regenerate</strong> in the tab bar to kick off the PM agent.
        </div>
      )}
    </div>
  );
}
