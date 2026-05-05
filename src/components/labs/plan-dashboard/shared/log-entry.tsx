'use client';
import type { AgentEvent, AgentEventType } from '@/types/agent-orchestrator';

const COLOR_BY_TYPE: Record<AgentEventType, string> = {
  step_start: 'var(--accent-purple)',
  step_complete: 'var(--success)',
  step_error: 'var(--destructive)',
  tool_use: 'var(--cyan)',
  tool_result: 'var(--text-dim)',
  text_delta: 'var(--foreground)',
  result: 'var(--success)',
  status: 'var(--text-dim)',
  extraction: 'var(--accent-blue)',
  validation: 'var(--warning)',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${String(d.getHours()).padStart(2, '0')}:${mm}:${ss}`;
}

function summarize(ev: AgentEvent): string {
  if (ev.eventType === 'tool_use') {
    const input = ev.toolInput ?? '';
    return `${ev.toolName ?? 'tool'}(${input.slice(0, 80)})`;
  }
  if (ev.eventType === 'step_start') return ev.text ?? `step ${ev.stepId} start`;
  if (ev.eventType === 'step_complete') return `step ${ev.stepId} complete`;
  if (ev.eventType === 'step_error') return `ERROR: ${ev.text ?? ''}`;
  if (ev.eventType === 'extraction')
    return `${ev.variableName} = ${(ev.variableValue ?? '').slice(0, 60)}`;
  if (ev.eventType === 'validation')
    return `${ev.validationPassed ? 'PASS' : 'FAIL'}: ${ev.validationLabel}`;
  if (ev.eventType === 'status' || ev.eventType === 'text_delta') return ev.text ?? '';
  return ev.text ?? '';
}

export function LogEntry({ event }: { event: AgentEvent }) {
  const color = COLOR_BY_TYPE[event.eventType] ?? 'var(--text-dim)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '4px 0',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        alignItems: 'flex-start',
      }}
    >
      <span
        style={{
          color: 'var(--text-faint)',
          flexShrink: 0,
          width: 56,
        }}
      >
        {fmtTime(event.timestamp)}
      </span>
      <span
        style={{
          color,
          flexShrink: 0,
          width: 100,
          textTransform: 'uppercase',
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.05em',
          paddingTop: 1,
        }}
      >
        {event.eventType.replace('_', ' ')}
      </span>
      <span
        style={{
          color: 'var(--text-faint)',
          flexShrink: 0,
          width: 56,
          fontSize: 9,
          paddingTop: 1,
        }}
      >
        {event.stepId}
      </span>
      <span style={{ color: 'var(--text-dim)', flex: 1, lineHeight: 1.5 }}>
        {summarize(event)}
      </span>
    </div>
  );
}
