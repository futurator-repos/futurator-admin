'use client';
import { useMemo, useState } from 'react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import type { AgentEvent } from '@/types/agent-orchestrator';

interface StoryLiveOutputProps {
  jobId: string;
}

const TOOL_ICONS: Record<string, string> = {
  Read: '\u{1F4C4}',
  Edit: '\u{270F}\u{FE0F}',
  Write: '\u{1F4DD}',
  Bash: '\u{2B1B}',
  Grep: '\u{1F50D}',
  Glob: '\u{1F4C2}',
};

interface Action {
  type:
    | 'tool_use'
    | 'tool_result'
    | 'status'
    | 'extraction'
    | 'validation'
    | 'step_start'
    | 'step_complete'
    | 'error';
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  text?: string;
  variableName?: string;
  variableValue?: string;
  validationLabel?: string;
  validationPassed?: boolean;
  stepId?: string;
  agentId?: string;
  timestamp: string;
}

function parseInput(input?: string): string {
  if (!input) return '';
  try {
    const parsed = JSON.parse(input);
    return (
      parsed.file_path ||
      parsed.command ||
      parsed.pattern ||
      parsed.path ||
      JSON.stringify(parsed).slice(0, 80)
    );
  } catch {
    return input.slice(0, 80);
  }
}

function actionSummary(a: Action): string {
  if (a.type === 'tool_use') {
    const summary = parseInput(a.toolInput);
    const truncated = summary.length > 60 ? '...' + summary.slice(-60) : summary;
    return `${a.toolName}(${truncated})`;
  }
  if (a.type === 'error') return `ERROR: ${a.text || 'Unknown error'}`;
  if (a.type === 'status' || a.type === 'step_start') return a.text || '';
  if (a.type === 'step_complete') return `Step ${a.stepId} complete`;
  if (a.type === 'extraction') return `${a.variableName} = ${(a.variableValue || '').slice(0, 40)}`;
  if (a.type === 'validation')
    return `${a.validationPassed ? 'PASS' : 'FAIL'}: ${a.validationLabel}`;
  return '';
}

function actionIcon(a: Action): string {
  if (a.type === 'tool_use') return TOOL_ICONS[a.toolName || ''] || '\u{1F527}';
  if (a.type === 'validation') return a.validationPassed ? '\u2705' : '\u274C';
  if (a.type === 'extraction') return '\u{1F4E6}';
  if (a.type === 'step_start') return '\u{1F680}';
  if (a.type === 'step_complete') return '\u2705';
  return '\u2022';
}

function formatActionForCopy(a: Action, idx: number): string {
  const header = `[${idx + 1}] ${a.timestamp} · ${a.agentId || '?'}/${a.stepId || '?'} · ${a.type}`;
  if (a.type === 'tool_use') {
    const parts = [header, `  tool: ${a.toolName}`];
    if (a.toolInput) parts.push(`  input: ${a.toolInput}`);
    if (a.toolOutput) parts.push(`  output: ${a.toolOutput}`);
    return parts.join('\n');
  }
  if (a.type === 'step_start') return `${header}\n  ${a.text || ''}`;
  if (a.type === 'step_complete') return `${header}\n  Step ${a.stepId} complete`;
  if (a.type === 'error') return `${header}\n  ERROR: ${a.text || ''}`;
  if (a.type === 'status') return `${header}\n  ${a.text || ''}`;
  if (a.type === 'extraction')
    return `${header}\n  ${a.variableName} = ${a.variableValue || ''}`;
  if (a.type === 'validation')
    return `${header}\n  ${a.validationPassed ? 'PASS' : 'FAIL'}: ${a.validationLabel || ''}`;
  return header;
}

export function StoryLiveOutput({ jobId }: StoryLiveOutputProps) {
  const { data: job } = useAgentJob(jobId);
  const { events } = useAgentEvents(jobId, job?.status);
  const [actionsExpanded, setActionsExpanded] = useState(true);
  const [expandedAction, setExpandedAction] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  // Build action list: tool calls with their matched results, status, extractions, validations
  const actions = useMemo(() => {
    const items: Action[] = [];
    const toolResultsByIdx: AgentEvent[] = events.filter((e) => e.eventType === 'tool_result');
    let resultIdx = 0;

    for (const ev of events) {
      if (ev.eventType === 'tool_use') {
        const match = toolResultsByIdx[resultIdx];
        resultIdx++;
        items.push({
          type: 'tool_use',
          toolName: ev.toolName,
          toolInput: ev.toolInput,
          toolOutput: match?.toolOutput,
          stepId: ev.stepId,
          agentId: ev.agentId,
          timestamp: ev.timestamp,
        });
      } else if (ev.eventType === 'step_start') {
        items.push({
          type: 'step_start',
          text: ev.text,
          stepId: ev.stepId,
          agentId: ev.agentId,
          timestamp: ev.timestamp,
        });
      } else if (ev.eventType === 'step_complete') {
        items.push({
          type: 'step_complete',
          stepId: ev.stepId,
          agentId: ev.agentId,
          timestamp: ev.timestamp,
        });
      } else if (ev.eventType === 'extraction') {
        items.push({
          type: 'extraction',
          variableName: ev.variableName,
          variableValue: ev.variableValue,
          stepId: ev.stepId,
          agentId: ev.agentId,
          timestamp: ev.timestamp,
        });
      } else if (ev.eventType === 'validation') {
        items.push({
          type: 'validation',
          validationLabel: ev.validationLabel,
          validationPassed: ev.validationPassed,
          stepId: ev.stepId,
          agentId: ev.agentId,
          timestamp: ev.timestamp,
        });
      } else if (ev.eventType === 'step_error') {
        items.push({
          type: 'error',
          text: ev.text,
          stepId: ev.stepId,
          agentId: ev.agentId,
          timestamp: ev.timestamp,
        });
      } else if (ev.eventType === 'status') {
        items.push({
          type: 'status',
          text: ev.text,
          stepId: ev.stepId,
          agentId: ev.agentId,
          timestamp: ev.timestamp,
        });
      }
    }
    return items;
  }, [events]);

  // Latest thought — last chunk of streamed text (excluding WORK_SUMMARY markers)
  const latestThought = useMemo(() => {
    const textEvents = events.filter((e) => e.eventType === 'text_delta' && e.text);
    if (textEvents.length === 0) return '';
    const allText = textEvents.map((e) => e.text).join('');
    // Strip WORK_SUMMARY blocks so thoughts stay separate from response
    const cleaned = allText.replace(/---WORK_SUMMARY---[\s\S]*?---END_WORK_SUMMARY---/g, '');
    return cleaned.slice(-200).replace(/\s+/g, ' ').trim();
  }, [events]);

  // Response — accumulated text_delta (agent's full streaming output, trimmed of markers)
  const responseText = useMemo(() => {
    const textEvents = events.filter((e) => e.eventType === 'text_delta' && e.text);
    const allText = textEvents.map((e) => e.text).join('');
    return allText.trim();
  }, [events]);

  const lastAction = actions[actions.length - 1];

  const copyAllActions = async () => {
    const blocks = actions.map((a, i) => formatActionForCopy(a, i));
    const banner = `Orchestrator actions — job ${jobId} — ${actions.length} entries — exported ${new Date().toISOString()}`;
    const payload = [banner, '='.repeat(banner.length), '', ...blocks].join('\n\n');
    try {
      await navigator.clipboard.writeText(payload);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
    setTimeout(() => setCopyStatus('idle'), 1600);
  };

  if (events.length === 0 && !job) {
    return (
      <p className="text-xs text-muted-foreground py-2">Waiting for daemon to pick up job...</p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Current thought */}
      {latestThought && (
        <div className="rounded bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground italic line-clamp-2">
          &ldquo;{latestThought}&rdquo;
        </div>
      )}

      {/* Actions section */}
      {actions.length > 0 && (
        <div className="rounded border border-input">
          <div className="w-full flex items-center justify-between px-3 py-2 hover:bg-accent/30">
            <button
              type="button"
              onClick={() => setActionsExpanded(!actionsExpanded)}
              className="flex items-center gap-2 min-w-0 text-xs text-left flex-1"
            >
              <span className="font-semibold">Actions ({actions.length})</span>
              {lastAction && (
                <span className="text-muted-foreground truncate font-mono text-[11px]">
                  {actionIcon(lastAction)} {actionSummary(lastAction)}
                </span>
              )}
            </button>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyAllActions();
                }}
                title="Copy all actions (with inputs + outputs) to clipboard"
                className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  copyStatus === 'copied'
                    ? 'border-green-500/60 bg-green-500/10 text-green-500'
                    : copyStatus === 'error'
                      ? 'border-red-500/60 bg-red-500/10 text-red-500'
                      : 'border-input text-muted-foreground hover:text-foreground hover:bg-accent/40'
                }`}
              >
                {copyStatus === 'copied'
                  ? '\u2713 Copied'
                  : copyStatus === 'error'
                    ? 'Copy failed'
                    : 'Copy logs'}
              </button>
              <button
                type="button"
                onClick={() => setActionsExpanded(!actionsExpanded)}
                className="text-muted-foreground text-xs"
              >
                {actionsExpanded ? '\u25BC' : '\u25B6'}
              </button>
            </div>
          </div>
          {actionsExpanded && (
            <div className="border-t border-input max-h-72 overflow-y-auto">
              {actions.map((a, i) => {
                const isExpandable = a.type === 'tool_use' && (a.toolInput || a.toolOutput);
                const isExpanded = expandedAction === i;
                return (
                  <div key={i} className="border-b border-input/30 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => isExpandable && setExpandedAction(isExpanded ? null : i)}
                      disabled={!isExpandable}
                      className={`w-full flex items-start gap-2 px-3 py-1 text-left font-mono text-[11px] ${isExpandable ? 'hover:bg-accent/20 cursor-pointer' : 'cursor-default'}`}
                    >
                      <span className="shrink-0">{actionIcon(a)}</span>
                      <span
                        className={
                          a.type === 'error'
                            ? 'text-red-500 font-medium'
                            : a.type === 'validation' && !a.validationPassed
                              ? 'text-red-500'
                              : a.type === 'validation' && a.validationPassed
                                ? 'text-green-500'
                                : a.type === 'extraction'
                                  ? 'text-blue-400'
                                  : a.type === 'step_start'
                                    ? 'text-purple-400'
                                    : a.type === 'step_complete'
                                      ? 'text-green-500'
                                      : 'text-muted-foreground'
                        }
                      >
                        {actionSummary(a)}
                      </span>
                      {isExpandable && (
                        <span className="ml-auto text-muted-foreground/50">
                          {isExpanded ? '\u25BC' : '\u25B6'}
                        </span>
                      )}
                    </button>
                    {isExpanded && isExpandable && (
                      <div className="px-3 pb-2 pl-7 space-y-1 text-[10px]">
                        {a.toolInput && (
                          <div>
                            <div className="text-muted-foreground">input:</div>
                            <pre className="bg-muted/40 rounded p-1.5 overflow-x-auto whitespace-pre-wrap">
                              {a.toolInput}
                            </pre>
                          </div>
                        )}
                        {a.toolOutput && (
                          <div>
                            <div className="text-muted-foreground">output:</div>
                            <pre className="bg-muted/40 rounded p-1.5 overflow-x-auto whitespace-pre-wrap max-h-32">
                              {a.toolOutput}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Response (agent's streamed text output) */}
      {responseText && (
        <div className="rounded border border-input">
          <div className="px-3 py-1.5 border-b border-input bg-muted/20">
            <span className="text-xs font-semibold">Response</span>
          </div>
          <pre className="px-3 py-2 text-[11px] whitespace-pre-wrap max-h-48 overflow-y-auto font-mono text-muted-foreground">
            {responseText}
          </pre>
        </div>
      )}
    </div>
  );
}
