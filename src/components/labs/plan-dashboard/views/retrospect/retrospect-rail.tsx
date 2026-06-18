'use client';

/**
 * Plan Retrospect — the stage rail (spec §7.2).
 *
 * One row per rubric stage (Concept · Development · QA Review · Deployment ·
 * Publish · Overview), each with a "Run analysis" button. An "Analyze all"
 * button fans the lot out. Mirrors the concept-rail visual pattern (semantic
 * theme tokens, mono captions) but lays the stages out as a vertical list of
 * runnable rows rather than a DAG.
 *
 * Deterministic stages snap to a scored card; `[LLM]` stages stream (handled by
 * the parent view via StoryLiveOutput). This rail only owns the trigger + the
 * per-stage analyzed/running indicator.
 */

import type { StageId } from '@/types/scorecard';

export interface RetrospectStageRow {
  id: StageId;
  label: string;
  /** One-line "what this stage grades" caption. */
  sub: string;
  /** This stage involves `[LLM]` Assessor criteria (streams live). */
  hasAssessor: boolean;
}

/** The six stages, in pipeline order. Overview is the cross-cutting roll-up. */
export const RETROSPECT_STAGES: RetrospectStageRow[] = [
  { id: 'concept', label: 'Concept', sub: 'grounding · spec coverage · gate', hasAssessor: true },
  {
    id: 'development',
    label: 'Development',
    sub: 'compile thrash · waves · skills · graph',
    hasAssessor: true,
  },
  { id: 'qa', label: 'QA Review', sub: 'capture integrity · calibration', hasAssessor: true },
  {
    id: 'deployment',
    label: 'Deployment',
    sub: 'build-once · scoped-path safety',
    hasAssessor: true,
  },
  { id: 'publish', label: 'Publish', sub: 'projects.json · scoped writes', hasAssessor: true },
  { id: 'overview', label: 'Overview', sub: 'pipeline health · grade band', hasAssessor: false },
];

export function RetrospectRail({
  analyzedStages,
  runningStage,
  onRun,
  onRunAll,
  runningAll,
}: {
  /** Stages that already have a stored verdict. */
  analyzedStages: StageId[];
  /** The stage whose analysis is in flight (deterministic compute or enqueue). */
  runningStage: StageId | null;
  onRun: (stage: StageId) => void;
  onRunAll: () => void;
  runningAll: boolean;
}) {
  const analyzed = new Set(analyzedStages);
  return (
    <div
      data-testid="retrospect-rail"
      style={{
        padding: '16px 20px',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg-elev)',
        marginBottom: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Plan Retrospect
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          grade this run against the pipeline quality rubric
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <button
          type="button"
          data-testid="retrospect-run-all"
          disabled={runningAll}
          onClick={onRunAll}
          style={pillStyle('accent-blue', runningAll)}
        >
          {runningAll ? 'Analyzing…' : 'Analyze all'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {RETROSPECT_STAGES.map((stage) => {
          const isAnalyzed = analyzed.has(stage.id);
          const isRunning = runningStage === stage.id || runningAll;
          return (
            <div
              key={stage.id}
              data-testid={`retrospect-row-${stage.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: isAnalyzed
                  ? 'color-mix(in srgb, var(--success) 6%, transparent)'
                  : 'transparent',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flex: '0 0 auto',
                  background: isAnalyzed ? 'var(--success)' : 'var(--border-2)',
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
                  {stage.label}
                  {stage.hasAssessor && (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 8,
                        fontWeight: 600,
                        color: 'var(--accent-blue)',
                        marginLeft: 8,
                        letterSpacing: '0.08em',
                      }}
                    >
                      LLM
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--text-faint)',
                    marginTop: 2,
                  }}
                >
                  {stage.sub}
                </div>
              </div>
              {isAnalyzed && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    fontWeight: 600,
                    color: 'var(--success)',
                  }}
                >
                  analyzed
                </span>
              )}
              <button
                type="button"
                data-testid={`retrospect-run-${stage.id}`}
                disabled={isRunning}
                onClick={() => onRun(stage.id)}
                style={pillStyle(isAnalyzed ? 'text-mute' : 'accent-blue', isRunning)}
              >
                {isRunning ? 'Analyzing…' : isAnalyzed ? 'Re-run' : 'Run analysis'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Shared pill-button style keyed on a theme tone (mirrors concept-rail). */
function pillStyle(tone: string, busy?: boolean) {
  return {
    fontSize: 11,
    fontWeight: 600,
    color: `var(--${tone})`,
    background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
    border: `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
    borderRadius: 5,
    padding: '4px 12px',
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.5 : 1,
    flex: '0 0 auto' as const,
    whiteSpace: 'nowrap' as const,
  };
}
