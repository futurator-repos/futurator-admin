'use client';
/**
 * Shared "Copy to clipboard" button for log panels.
 *
 * Used by every surface that renders agent events, so the operator can
 * paste real Claude Code logs into chat / issues / audits in one click.
 * Keeps the visual + behavior consistent (monospace micro-caps label,
 * green confirmation for 1.5s).
 */
import { useState } from 'react';
import type { AgentEvent } from '@/types/agent-orchestrator';

/**
 * Format a list of events as a plain-text log suitable for pasting into
 * chat. Mirrors the Logs-tab format so copy output is predictable no
 * matter which panel produced it.
 */
export function formatEventsForClipboard(events: AgentEvent[]): string {
  return events
    .map((ev) => {
      const ts = ev.timestamp || '';
      const header = `[${ts}] ${ev.stepId} / ${ev.agentId} / ${ev.eventType}`;
      const body =
        ev.eventType === 'tool_use'
          ? `  tool: ${ev.toolName || ''}\n  input: ${ev.toolInput || ''}`
          : ev.eventType === 'tool_result'
            ? `  output: ${ev.toolOutput || ''}`
            : ev.eventType === 'extraction'
              ? `  ${ev.variableName} = ${ev.variableValue || ''}`
              : ev.eventType === 'validation'
                ? `  ${ev.validationPassed ? 'PASS' : 'FAIL'}: ${ev.validationLabel || ''}`
                : ev.text || '';
      return `${header}\n${body}`;
    })
    .join('\n\n');
}

export function CopyLogButton({
  events,
  compact = false,
  label,
}: {
  events: AgentEvent[];
  /** Compact inline variant for tight log-header rows. */
  compact?: boolean;
  /** Override the default label (e.g. "Copy step"). */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const disabled = events.length === 0 || typeof navigator === 'undefined';

  const handleCopy = () => {
    if (disabled || !navigator.clipboard) return;
    const text = formatEventsForClipboard(events);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      aria-label={label || 'Copy log to clipboard'}
      title={`Copy ${events.length} event${events.length === 1 ? '' : 's'} to clipboard`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: compact ? 9 : 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        padding: compact ? '3px 8px' : '5px 10px',
        borderRadius: 2,
        border: '1px solid var(--border)',
        background: 'transparent',
        color: copied ? 'var(--success, #10b981)' : 'var(--text-mute)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'color 150ms',
      }}
    >
      {copied ? 'Copied!' : label || 'Copy'}
    </button>
  );
}
