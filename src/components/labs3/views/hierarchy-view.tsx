'use client';

/**
 * Labs3 · Stories / Hierarchy view.
 *
 * Mirrors the legacy plan-dashboard hierarchy-view (StoryRow /
 * StoryDetailPanel / StoryLogsPane + useStickToBottom) but drives off the
 * SDD plan-spec graph instead of the epic→wave→story model. The tree is:
 *
 *   cohort (epic)  →  cohortBatch (topological level)  →  StoryNodeRow
 *
 * Per-story we render the bound-AC list (testBinding.status drives the
 * glyph), depends_on / touches chips, a retry pill (from the linked
 * story-dev AgentJob), the latest commit SHA (from the most recent
 * testBinding.lastRunSha), and a live log streamed via useAgentEvents.
 *
 * Read-only: the ready-frontier auto-dispatches stories, so there is no
 * per-story Retry action here — the retry pill is informational only.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import type { AgentJob, AgentEvent } from '@/types/agent-orchestrator';
import type {
  StoryNodeRow,
  StoryNodeState,
  BoundAcceptanceCriterion,
  TestBindingStatus,
  AcClass,
} from '@/types/plan-spec';

// B2 shared module (StoryNodeStatePill + adapter formatters).
import {
  StoryNodeStatePill,
  STORY_NODE_STATE_META,
  ACTIVE_STORY_NODE_STATES,
} from '../shared/state-pill';
import {
  buildStoryGraphModel,
  fmtSec,
  fmtCost,
  fmtTokens,
  jobCost,
  jobTokens,
} from '../plan-spec-dashboard/adapter';
import type { Labs3ViewProps } from '../plan-spec-dashboard/constants';

// Legacy shared primitives (imported unchanged, per the design contract).
import { MetricChip } from '@/components/labs/plan-dashboard/shared/metric-chip';
import { LogEntry } from '@/components/labs/plan-dashboard/shared/log-entry';
import { CopyLogButton } from '@/components/labs/plan-dashboard/shared/copy-log-button';

// ── Live-log stick-to-bottom (terminal-style; ported from legacy) ────

function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

/**
 * Live wall-clock (ms) for elapsed timers. `Date.now()` is impure and may not
 * be read during render, so we snapshot it in an effect and tick it once a
 * second only while the row is active (terminal rows need no ticking).
 */
function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// ── State / AC visual maps ───────────────────────────────────────────

const STATE_PROGRESS: Record<StoryNodeState, number> = {
  blocked: 5,
  ready: 15,
  claimed: 30,
  developing: 60,
  merging: 80,
  verifying: 92,
  done: 100,
  failed: 100,
};

const AC_STATUS_META: Record<TestBindingStatus, { glyph: string; color: string }> = {
  passing: { glyph: '✓', color: 'var(--success)' },
  failing: { glyph: '✕', color: 'var(--destructive)' },
  bound: { glyph: '○', color: 'var(--accent-blue)' },
  unbound: { glyph: '·', color: 'var(--text-faint)' },
};

const AC_CLASS_COLOR: Record<AcClass, string> = {
  deterministic: 'var(--accent-blue)',
  'advisory-taste': 'var(--accent-purple)',
  'advisory-security': 'var(--amber, #f59e0b)',
};

interface AcRollup {
  passing: number;
  failing: number;
  bound: number;
  unbound: number;
  total: number;
}

function rollupAc(acs: BoundAcceptanceCriterion[]): AcRollup {
  const r: AcRollup = { passing: 0, failing: 0, bound: 0, unbound: 0, total: acs.length };
  for (const ac of acs) r[ac.testBinding.status] += 1;
  return r;
}

/** Most recent commit SHA across the story's bound-AC test runs. */
function latestRunSha(acs: BoundAcceptanceCriterion[]): string | null {
  let best: { sha: string; at: number } | null = null;
  for (const ac of acs) {
    const sha = ac.testBinding.lastRunSha;
    if (!sha) continue;
    const at = ac.testBinding.lastRunAt ? Date.parse(ac.testBinding.lastRunAt) : 0;
    if (!best || at >= best.at) best = { sha, at };
  }
  return best?.sha ?? null;
}

/** Live elapsed seconds from the linked job (terminal → real, else live). */
function jobElapsed(job: AgentJob | undefined, nowMs: number): number | null {
  if (!job) return null;
  const start = Date.parse(job.createdAt);
  if (!Number.isFinite(start)) return null;
  const terminal = job.status === 'COMPLETED' || job.status === 'FAILED';
  const end = terminal ? Date.parse(job.updatedAt) : nowMs;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

interface BatchGroup {
  batch: number;
  stories: StoryNodeRow[];
}

function groupByBatch(stories: StoryNodeRow[]): BatchGroup[] {
  const map = new Map<number, StoryNodeRow[]>();
  for (const s of stories) {
    const b = s.cohortBatch ?? 0;
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push(s);
  }
  return [...map.keys()]
    .sort((a, b) => a - b)
    .map((batch) => ({ batch, stories: map.get(batch)! }));
}

// ── Top-level view ───────────────────────────────────────────────────

export function HierarchyView({ stories, onSelectStory }: Labs3ViewProps) {
  const model = useMemo(() => buildStoryGraphModel(stories), [stories]);

  const initialExpanded = useMemo(() => {
    const o: Record<string, boolean> = {};
    for (const c of model.byEpic) {
      // Expand cohorts that have any active (in-flight) story.
      o[`epic:${c.epicId}`] = c.stories.some((s) => ACTIVE_STORY_NODE_STATES.has(s.state));
    }
    return o;
  }, [model.byEpic]);

  const [exp, setExp] = useState<Record<string, boolean>>(initialExpanded);
  const [storyExp, setStoryExp] = useState<Record<string, boolean>>({});

  if (stories.length === 0) {
    return (
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
        No story nodes yet. Run this plan as <strong>Pipeline 3</strong> to ingest the spec graph.
      </div>
    );
  }

  return (
    <div>
      <PlanRollup model={model} />
      {model.byEpic.map((cohort) => (
        <CohortCard
          key={cohort.epicId}
          epicId={cohort.epicId}
          epicTitle={cohort.epicTitle}
          stories={cohort.stories}
          open={!!exp[`epic:${cohort.epicId}`]}
          onToggle={() =>
            setExp((p) => ({ ...p, [`epic:${cohort.epicId}`]: !p[`epic:${cohort.epicId}`] }))
          }
          storyExp={storyExp}
          setStoryExp={setStoryExp}
          onSelectStory={onSelectStory}
        />
      ))}
    </div>
  );
}

// ── Plan rollup strip ────────────────────────────────────────────────

function PlanRollup({ model }: { model: ReturnType<typeof buildStoryGraphModel> }) {
  const active = (['ready', 'claimed', 'developing', 'merging', 'verifying'] as const).reduce(
    (a, s) => a + (model.stateCounts[s] ?? 0),
    0,
  );
  const metrics = [
    { label: 'Stories done', value: `${model.done} / ${model.total}`, color: 'var(--success)' },
    { label: 'Progress', value: `${model.pct}%`, color: 'var(--foreground)' },
    { label: 'In flight', value: String(active), color: 'var(--accent-purple)' },
    { label: 'Ready frontier', value: String(model.frontier.length), color: 'var(--accent-blue)' },
    { label: 'Blocked', value: String(model.stateCounts.blocked ?? 0), color: 'var(--text-mute)' },
    { label: 'Failed', value: String(model.stateCounts.failed ?? 0), color: 'var(--destructive)' },
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

// ── Cohort (epic) card ───────────────────────────────────────────────

function CohortCard({
  epicId,
  epicTitle,
  stories,
  open,
  onToggle,
  storyExp,
  setStoryExp,
  onSelectStory,
}: {
  epicId: string;
  epicTitle: string;
  stories: StoryNodeRow[];
  open: boolean;
  onToggle: () => void;
  storyExp: Record<string, boolean>;
  setStoryExp: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onSelectStory?: (storyId: string) => void;
}) {
  const batches = useMemo(() => groupByBatch(stories), [stories]);
  const done = stories.filter((s) => s.state === 'done').length;
  const failed = stories.some((s) => s.state === 'failed');
  const anyActive = stories.some((s) => ACTIVE_STORY_NODE_STATES.has(s.state));
  const pct = stories.length === 0 ? 0 : Math.round((done / stories.length) * 100);
  const barColor = failed
    ? 'var(--destructive)'
    : anyActive
      ? 'var(--accent-purple)'
      : 'var(--success)';

  return (
    <div
      style={{
        marginBottom: 1,
        background: 'transparent',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 1fr 160px auto',
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
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.2em',
              }}
            >
              {epicId}
            </span>
            <span
              style={{
                fontSize: 17,
                fontWeight: 300,
                color: 'var(--foreground)',
                letterSpacing: '-0.005em',
              }}
            >
              {epicTitle || 'Untitled cohort'}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--text-mute)',
                textTransform: 'uppercase',
                letterSpacing: '0.2em',
              }}
            >
              {batches.length} batch{batches.length === 1 ? '' : 'es'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 2, background: 'var(--border)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: barColor,
                transition: 'width 300ms',
                opacity: anyActive ? 1 : 0.7,
              }}
            />
          </div>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: barColor,
              minWidth: 32,
              textAlign: 'right',
            }}
          >
            {pct}%
          </span>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--foreground)',
            letterSpacing: '0.02em',
          }}
        >
          {done}/{stories.length}
        </span>
      </div>

      {open && (
        <div style={{ background: 'color-mix(in srgb, var(--foreground) 1%, transparent)' }}>
          {batches.map((b) => (
            <BatchRow
              key={b.batch}
              batch={b.batch}
              stories={b.stories}
              storyExp={storyExp}
              setStoryExp={setStoryExp}
              onSelectStory={onSelectStory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Cohort-batch (topological level) row ─────────────────────────────

function BatchRow({
  batch,
  stories,
  storyExp,
  setStoryExp,
  onSelectStory,
}: {
  batch: number;
  stories: StoryNodeRow[];
  storyExp: Record<string, boolean>;
  setStoryExp: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onSelectStory?: (storyId: string) => void;
}) {
  const isParallel = stories.length > 1;
  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 110px 1fr',
          alignItems: 'center',
          gap: 14,
          padding: '10px 18px 10px 36px',
          borderTop: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>·</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--accent-blue)',
            textTransform: 'uppercase',
            letterSpacing: '0.2em',
          }}
        >
          Batch {batch}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {stories.length} {stories.length === 1 ? 'story' : 'stories'}
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
      {stories.map((s) => (
        <StoryRow
          key={s.storyId}
          story={s}
          expanded={!!storyExp[s.storyId]}
          onToggle={() => {
            setStoryExp((p) => ({ ...p, [s.storyId]: !p[s.storyId] }));
            onSelectStory?.(s.storyId);
          }}
        />
      ))}
    </div>
  );
}

// ── Story row ────────────────────────────────────────────────────────

function StoryRow({
  story,
  expanded,
  onToggle,
}: {
  story: StoryNodeRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { data: job } = useAgentJob(story.jobId ?? null);
  const meta = STORY_NODE_STATE_META[story.state];
  const prog = STATE_PROGRESS[story.state];
  const isActive = ACTIVE_STORY_NODE_STATES.has(story.state);
  const ac = useMemo(() => rollupAc(story.acceptanceCriteria), [story.acceptanceCriteria]);
  const now = useLiveNow(isActive);
  const elapsed = jobElapsed(job, now);
  const retryAttempt = job?.retryAttempt ?? 0;

  return (
    <div
      id={`labs3-story-${story.storyId}`}
      data-story-id={story.storyId}
      style={{ borderTop: '1px solid var(--border)' }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '24px 70px 1fr auto auto auto auto auto auto',
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
          {story.storyId.slice(0, 10)}
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
            {story.title}
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
            <span>{story.complexity}</span>
            {story.touches.length > 0 && (
              <>
                <span style={{ color: 'var(--text-faint)' }}>·</span>
                <span>
                  {story.touches.length} file{story.touches.length === 1 ? '' : 's'}
                </span>
              </>
            )}
            {story.depends_on.length > 0 && (
              <>
                <span style={{ color: 'var(--text-faint)' }}>·</span>
                <span>
                  {story.unblockedDepsCount}/{story.depends_on.length} deps
                </span>
              </>
            )}
          </div>
        </div>
        <AcRollupBadge rollup={ac} />
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
            {prog}%
          </span>
        </div>
        {/* Prefer the per-story write-back (persisted at completion) over the
            live job — that's where duration/cost/tokens actually land. Fall back
            to the running job's live figures while a story is still in flight. */}
        <MetricChip
          label="time"
          value={fmtSec(story.durationMs ? story.durationMs / 1000 : elapsed)}
          color="var(--text-dim)"
        />
        <MetricChip
          label="tokens"
          value={fmtTokens((story.inputTokens ?? 0) + (story.outputTokens ?? 0) || jobTokens(job))}
          color="var(--cyan)"
        />
        <MetricChip
          label="cost"
          value={fmtCost(story.costUsd ?? jobCost(job))}
          color="var(--amber)"
        />
        <StoryNodeStatePill state={story.state} pulse={isActive} />
        {retryAttempt > 0 && <RetryPill attempt={retryAttempt} max={3} />}
      </div>

      {expanded && <StoryDetailPanel story={story} job={job} ac={ac} />}
    </div>
  );
}

function AcRollupBadge({ rollup }: { rollup: AcRollup }) {
  if (rollup.total === 0) {
    return (
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          letterSpacing: '0.08em',
        }}
      >
        no AC
      </span>
    );
  }
  const color =
    rollup.failing > 0
      ? 'var(--destructive)'
      : rollup.passing === rollup.total
        ? 'var(--success)'
        : 'var(--text-mute)';
  return (
    <span
      title={`${rollup.passing} passing · ${rollup.failing} failing · ${rollup.bound} bound · ${rollup.unbound} unbound`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        borderRadius: 3,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      AC {rollup.passing}/{rollup.total}
    </span>
  );
}

// ── Expanded story detail (left: AC + chips; right: live log) ────────

function StoryDetailPanel({
  story,
  job,
  ac,
}: {
  story: StoryNodeRow;
  job: AgentJob | undefined;
  ac: AcRollup;
}) {
  const isActive = ACTIVE_STORY_NODE_STATES.has(story.state);
  const { events } = useAgentEvents(story.jobId ?? null, job?.status);
  const { ref: liveLogRef, onScroll: liveLogOnScroll } = useStickToBottom(events.length);
  const [tab, setTab] = useState<'overview' | 'logs'>('overview');
  const sha = latestRunSha(story.acceptanceCriteria);

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
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 28 }}>
          <div>
            {story.intent && (
              <>
                <SectionLabel>Intent</SectionLabel>
                <p
                  style={{
                    fontSize: 13,
                    color: 'var(--text-dim)',
                    lineHeight: 1.65,
                    marginBottom: 20,
                    textWrap: 'pretty',
                  }}
                >
                  {story.intent}
                </p>
              </>
            )}

            {story.acceptanceCriteria.length > 0 && (
              <>
                <SectionLabel>
                  Acceptance criteria · {ac.passing}/{ac.total} passing
                </SectionLabel>
                <div
                  style={{
                    marginBottom: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                  }}
                >
                  {story.acceptanceCriteria.map((c) => (
                    <AcRow key={c.id} ac={c} />
                  ))}
                </div>
              </>
            )}

            {story.depends_on.length > 0 && (
              <>
                <SectionLabel>
                  Depends on · {story.unblockedDepsCount}/{story.depends_on.length} done
                </SectionLabel>
                <ChipRow items={story.depends_on} color="var(--accent-blue)" mono />
              </>
            )}

            {story.touches.length > 0 && (
              <>
                <SectionLabel>Touches</SectionLabel>
                <ChipRow items={story.touches} color="var(--text-dim)" mono />
              </>
            )}

            {story.forbiddenAreas && story.forbiddenAreas.length > 0 && (
              <>
                <SectionLabel>Forbidden areas</SectionLabel>
                <ChipRow items={story.forbiddenAreas} color="var(--destructive)" mono />
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
              ref={liveLogRef}
              onScroll={liveLogOnScroll}
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
                    ? 'No log events yet — waiting for the story-dev job.'
                    : `No log events — story is ${story.state}.`}
                </div>
              )}
            </div>

            <div
              style={{
                marginTop: 14,
                display: 'flex',
                gap: 14,
                flexWrap: 'wrap',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-mute)',
                letterSpacing: '0.06em',
              }}
            >
              {story.jobId && <span>job {story.jobId.slice(0, 8)}</span>}
              {sha && (
                <span>
                  commit <span style={{ color: 'var(--text-dim)' }}>{sha.slice(0, 7)}</span>
                </span>
              )}
              <span>branch plan/{story.planId}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AcRow({ ac }: { ac: BoundAcceptanceCriterion }) {
  const meta = AC_STATUS_META[ac.testBinding.status];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
      <span
        aria-label={`test binding ${ac.testBinding.status}`}
        style={{
          width: 16,
          flexShrink: 0,
          textAlign: 'center',
          color: meta.color,
          fontSize: 12,
          lineHeight: '18px',
        }}
      >
        {meta.glyph}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: ac.testBinding.status === 'unbound' ? 'var(--text-mute)' : 'var(--foreground)',
            lineHeight: 1.5,
          }}
        >
          {ac.text}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginTop: 3,
            flexWrap: 'wrap',
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          <span style={{ color: AC_CLASS_COLOR[ac.acClass] }}>{ac.acClass}</span>
          <span style={{ color: meta.color }}>{ac.testBinding.status}</span>
          {ac.testBinding.testRef && (
            <span style={{ color: 'var(--text-faint)' }}>{ac.testBinding.testRef}</span>
          )}
          {ac.testBinding.lastRunSha && (
            <span style={{ color: 'var(--text-faint)' }}>
              @{ac.testBinding.lastRunSha.slice(0, 7)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ChipRow({ items, color, mono }: { items: string[]; color: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
      {items.map((p) => (
        <span
          key={p}
          style={{
            fontFamily: mono ? 'var(--font-mono)' : 'inherit',
            fontSize: 10,
            padding: '3px 8px',
            border: '1px solid var(--border)',
            color,
            letterSpacing: '0.02em',
          }}
        >
          {p}
        </span>
      ))}
    </div>
  );
}

// ── Detail tabs + logs pane (ported from legacy) ─────────────────────

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

function StoryLogsPane({ events }: { events: AgentEvent[] }) {
  const steps = useMemo(() => {
    const uniq = new Map<string, number>();
    for (const ev of events) uniq.set(ev.stepId, (uniq.get(ev.stepId) || 0) + 1);
    return Array.from(uniq.entries());
  }, [events]);
  const [selected, setSelected] = useState<string>('all');
  const filtered = useMemo(
    () => (selected === 'all' ? events : events.filter((e) => e.stepId === selected)),
    [events, selected],
  );

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
