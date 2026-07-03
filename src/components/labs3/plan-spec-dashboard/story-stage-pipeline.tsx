'use client';

/**
 * StoryStagePipeline — the per-story multi-agent sub-pipeline, made visible.
 *
 * Derives the TDD stage timeline from the story's agent-event stream (grouped
 * by stepId) and renders it as a horizontal strip:
 *
 *   🧪 Test-Author → ⚙ Implementer → 👁 Reviewer → 📚 Compile
 *
 * Stage events are emitted by the daemon: 'test-author' (P3_TEST_AUTHOR_SPLIT),
 * 'story-dev' (the implementer spawn), 'reviewer' (P3_QUALITY_GATE=on,
 * risk-tiered), 'compile' (fire-and-forget knowledge-graph growth). A stage with
 * no events renders dimmed ("not run") — e.g. single-spawn runs have no
 * Test-Author, low-risk stories no Reviewer — so the pipeline SHAPE is always
 * legible, including what was skipped.
 */

import type { AgentEvent } from '@/types/agent-orchestrator';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'not-run';

export interface StageInfo {
  id: string;
  label: string;
  icon: string;
  status: StageStatus;
  durationMs: number | null;
  detail: string | null;
  attempts: number;
}

const STAGE_DEFS = [
  { id: 'test-author', label: 'Test-Author', icon: '🧪' },
  { id: 'story-dev', label: 'Implementer', icon: '⚙️' },
  { id: 'reviewer', label: 'Reviewer', icon: '👁️' },
  { id: 'compile', label: 'Compile', icon: '📚' },
] as const;

/** Pure: fold the event stream into one StageInfo per pipeline stage. */
export function deriveStages(events: AgentEvent[]): StageInfo[] {
  return STAGE_DEFS.map((def) => {
    const evs = events.filter((e) => e.stepId === def.id);
    if (evs.length === 0) {
      return {
        ...def,
        status: 'not-run' as StageStatus,
        durationMs: null,
        detail: null,
        attempts: 0,
      };
    }
    const starts = evs.filter((e) => e.eventType === 'step_start');
    const completes = evs.filter((e) => e.eventType === 'step_complete');
    const errors = evs.filter((e) => e.eventType === 'step_error');
    const status: StageStatus =
      errors.length > 0 && completes.length === 0
        ? 'failed'
        : completes.length > 0
          ? 'done'
          : starts.length > 0
            ? 'running'
            : 'pending';
    const first = starts[0] ?? evs[0];
    const lastTerminal = completes[completes.length - 1] ?? errors[errors.length - 1];
    const durationMs =
      first && lastTerminal
        ? Math.max(
            0,
            new Date(lastTerminal.timestamp).getTime() - new Date(first.timestamp).getTime(),
          )
        : null;
    const lastText =
      [...completes, ...errors].pop()?.text ?? starts[starts.length - 1]?.text ?? null;
    return { ...def, status, durationMs, detail: lastText, attempts: starts.length };
  });
}

const STATUS_COLOR: Record<StageStatus, string> = {
  'not-run': 'var(--text-faint)',
  pending: 'var(--text-faint)',
  running: 'var(--accent-blue)',
  done: 'var(--success)',
  failed: 'var(--destructive)',
};

function fmtMs(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function StoryStagePipeline({ events }: { events: AgentEvent[] }) {
  const stages = deriveStages(events);
  // Nothing streamed at all yet (story not started) — don't render an empty strip.
  if (stages.every((s) => s.status === 'not-run')) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 8,
        margin: '2px 0 18px',
        flexWrap: 'wrap',
      }}
    >
      {stages.map((s, i) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            title={
              s.detail ?? (s.status === 'not-run' ? 'stage did not run for this story' : s.label)
            }
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '7px 12px',
              borderRadius: 6,
              minWidth: 128,
              border: `1px solid color-mix(in srgb, ${STATUS_COLOR[s.status]} 45%, transparent)`,
              background: `color-mix(in srgb, ${STATUS_COLOR[s.status]} 6%, transparent)`,
              opacity: s.status === 'not-run' ? 0.45 : 1,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12 }}>{s.icon}</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--foreground)',
                }}
              >
                {s.label}
              </span>
              {s.attempts > 1 && (
                <span
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--warning)' }}
                >
                  ×{s.attempts}
                </span>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: STATUS_COLOR[s.status],
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: STATUS_COLOR[s.status],
                  ...(s.status === 'running' ? { animation: 'pulse 1.2s infinite' } : {}),
                }}
              />
              {s.status === 'not-run' ? 'not run' : s.status}
              {s.durationMs != null && s.status !== 'not-run' && (
                <span style={{ color: 'var(--text-faint)', textTransform: 'none' }}>
                  {fmtMs(s.durationMs)}
                </span>
              )}
            </div>
          </div>
          {i < stages.length - 1 && (
            <span style={{ color: 'var(--text-faint)', fontSize: 11, flexShrink: 0 }}>→</span>
          )}
        </div>
      ))}
    </div>
  );
}
