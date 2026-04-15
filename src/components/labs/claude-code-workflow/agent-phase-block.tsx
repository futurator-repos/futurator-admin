'use client';
import { useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolCallBlock } from './tool-call-block';
import type { AgentEvent, PipelineDefinition } from '@/types/agent-orchestrator';

interface StepGroup {
  stepId: string;
  agentId: string;
  events: AgentEvent[];
}

export function AgentPhaseBlock({
  group,
  pipeline,
}: {
  group: StepGroup;
  pipeline?: PipelineDefinition;
}) {
  const agentName = pipeline?.agents[group.agentId]?.name || group.agentId;
  const stepDef = pipeline?.steps.find((s) => s.id === group.stepId);
  const resumeLabel = stepDef?.resumeFromStep ? ` (resumed from ${stepDef.resumeFromStep})` : '';

  const markdownText = useMemo(
    () =>
      group.events
        .filter((e) => e.eventType === 'text_delta')
        .map((e) => e.text || '')
        .join(''),
    [group.events],
  );

  const toolPairs = useMemo(() => {
    const pairs: { use: AgentEvent; result?: AgentEvent }[] = [];
    const results = group.events.filter((e) => e.eventType === 'tool_result');
    let ri = 0;
    for (const ev of group.events) {
      if (ev.eventType === 'tool_use') {
        pairs.push({ use: ev, result: results[ri] });
        ri++;
      }
    }
    return pairs;
  }, [group.events]);

  const completeEvent = group.events.find((e) => e.eventType === 'step_complete');
  const statusEvents = group.events.filter(
    (e) => e.eventType === 'status' || e.eventType === 'step_start',
  );

  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="mb-2 text-sm font-semibold">
        <span className="font-mono">{group.stepId}</span>
        <span className="ml-2 font-normal text-muted-foreground">
          Agent {group.agentId} — {agentName}
          {resumeLabel}
        </span>
      </h3>

      {statusEvents.map((ev, i) => (
        <p key={i} className="mb-1 text-xs text-muted-foreground">
          {ev.text}
        </p>
      ))}

      {toolPairs.length > 0 && (
        <div className="mb-3 space-y-1">
          {toolPairs.map((pair, i) => (
            <ToolCallBlock
              key={i}
              name={pair.use.toolName || 'Unknown'}
              input={pair.use.toolInput}
              output={pair.result?.toolOutput}
            />
          ))}
        </div>
      )}

      {markdownText && (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <Markdown remarkPlugins={[remarkGfm]}>{markdownText}</Markdown>
        </div>
      )}

      {completeEvent && (
        <div className="mt-3 flex items-center gap-3 text-xs">
          <span className="text-green-600 dark:text-green-400">Complete</span>
          {completeEvent.cost != null && (
            <span className="text-muted-foreground">${completeEvent.cost.toFixed(4)}</span>
          )}
          {completeEvent.durationMs != null && (
            <span className="text-muted-foreground">
              {(completeEvent.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {completeEvent.sessionId && (
            <span className="font-mono text-muted-foreground/60 text-[10px]">
              {completeEvent.sessionId.slice(0, 8)}...
            </span>
          )}
        </div>
      )}
    </div>
  );
}
