'use client';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { CopyLogButton } from '@/components/labs/plan-dashboard/shared/copy-log-button';

const TOOL_ICONS: Record<string, string> = {
  Read: '\u{1F4C4}',
  Edit: '\u{270F}\u{FE0F}',
  Write: '\u{1F4DD}',
  Bash: '\u{2B1B}',
  Grep: '\u{1F50D}',
  Glob: '\u{1F4C2}',
};

function parseInput(input?: string): string {
  if (!input) return '';
  try {
    const p = JSON.parse(input);
    const v = p.file_path || p.command || p.pattern || '';
    return v.length > 60 ? '...' + v.slice(-60) : v;
  } catch {
    return input.slice(0, 60);
  }
}

function ExpandableSection({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        {title}
      </button>
      {isOpen && <div className="mt-2 pl-4">{children}</div>}
    </div>
  );
}

export function StoryResult({ jobId }: { jobId: string }) {
  const { data: job } = useAgentJob(jobId);
  const { events } = useAgentEvents(jobId, job?.status);

  if (!job) return <p className="text-xs text-muted-foreground">Loading results...</p>;

  const totalCost = job.totalCost || 0;
  const stepResults = job.stepResults || [];
  const totalDuration = stepResults.reduce((sum, sr) => sum + (sr.durationMs || 0), 0);
  const feedback = job.variables?.FEEDBACK || '';
  const workSummary = job.variables?.WORK_SUMMARY || '';
  const verdict = job.variables?.VERDICT || '';
  const iterations = job.variables?.ITERATION || '1';

  const toolEvents = events.filter((e) => e.eventType === 'tool_use');
  const resultEvents = events.filter((e) => e.eventType === 'tool_result');
  const extractionEvents = events.filter((e) => e.eventType === 'extraction');
  const validationEvents = events.filter((e) => e.eventType === 'validation');
  const stepStartEvents = events.filter(
    (e) => e.eventType === 'step_start' || e.eventType === 'step_complete',
  );
  const errorEvents = events.filter((e) => e.eventType === 'step_error');

  return (
    <div className="space-y-2 text-xs">
      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
        <span
          className={
            verdict === 'PASS'
              ? 'text-green-500 font-semibold'
              : verdict === 'FAIL'
                ? 'text-red-500 font-semibold'
                : 'font-medium'
          }
        >
          {verdict}
        </span>
        <span className="font-mono">${totalCost.toFixed(4)}</span>
        <span className="font-mono">{(totalDuration / 1000).toFixed(0)}s</span>
        <span>{iterations === '1' ? '1 attempt' : `${iterations} attempts`}</span>
        <span>{stepResults.length} steps</span>
        {stepResults.map((sr) => (
          <span key={sr.stepId} className="text-[10px] font-mono">
            {sr.stepId}: {sr.model?.replace(/\[.*\]/, '') || '?'} {sr.inputTokens?.toLocaleString()}
            tok
          </span>
        ))}
      </div>

      {/* Dev Summary — expandable */}
      {workSummary && (
        <ExpandableSection title="Dev Summary" defaultOpen={true}>
          <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground bg-muted/30 rounded p-2 max-h-32 overflow-auto">
            {workSummary
              .replace(/^---WORK_SUMMARY---\n?/, '')
              .replace(/\n?---END_WORK_SUMMARY---$/, '')}
          </pre>
        </ExpandableSection>
      )}

      {/* Reviewer Feedback — expandable */}
      {feedback && (
        <ExpandableSection title="Reviewer Feedback" defaultOpen={false}>
          <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground bg-muted/30 rounded p-2 max-h-32 overflow-auto">
            {feedback}
          </pre>
        </ExpandableSection>
      )}

      {/* Event Log — expandable */}
      {events.length > 0 && (
        <EventLogSection
          toolEvents={toolEvents}
          resultEvents={resultEvents}
          extractionEvents={extractionEvents}
          validationEvents={validationEvents}
          stepStartEvents={stepStartEvents}
          errorEvents={errorEvents}
        />
      )}
    </div>
  );
}

function EventLogSection({
  toolEvents,
  resultEvents,
  extractionEvents,
  validationEvents,
  stepStartEvents,
  errorEvents,
}: {
  toolEvents: ReturnType<typeof useAgentEvents>['events'];
  resultEvents: ReturnType<typeof useAgentEvents>['events'];
  extractionEvents: ReturnType<typeof useAgentEvents>['events'];
  validationEvents: ReturnType<typeof useAgentEvents>['events'];
  stepStartEvents: ReturnType<typeof useAgentEvents>['events'];
  errorEvents: ReturnType<typeof useAgentEvents>['events'];
}) {
  const [isOpen, setIsOpen] = useState(false);

  // Rebuild a merged, chronologically-sorted event array for clipboard copy.
  // Excludes resultEvents (those are already attached to their tool_use via
  // the renderer below) to keep the pasted log terse.
  const mergedEvents = [
    ...stepStartEvents,
    ...toolEvents,
    ...resultEvents,
    ...extractionEvents,
    ...validationEvents,
    ...errorEvents,
  ].sort((a, b) => a.seq - b.seq);

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
          <span>
            Event Log ({toolEvents.length} tools, {extractionEvents.length} extractions,{' '}
            {validationEvents.length} validations
            {errorEvents.length > 0 ? `, ${errorEvents.length} errors` : ''})
          </span>
        </button>
        <CopyLogButton events={mergedEvents} compact />
      </div>

      {isOpen && (
        <div className="mt-2 pl-4 rounded border border-input max-h-64 overflow-y-auto font-mono text-[10px]">
          {[
            ...stepStartEvents,
            ...toolEvents,
            ...extractionEvents,
            ...validationEvents,
            ...errorEvents,
          ]
            .sort((a, b) => a.seq - b.seq)
            .map((ev, i) => {
              if (ev.eventType === 'tool_use') {
                const icon = TOOL_ICONS[ev.toolName || ''] || '\u{1F527}';
                const matched = resultEvents.find(
                  (r) =>
                    r.seq > ev.seq &&
                    r.seq < (toolEvents[toolEvents.indexOf(ev) + 1]?.seq ?? Infinity),
                );
                return (
                  <details key={i} className="border-b border-input/30">
                    <summary className="px-3 py-0.5 cursor-pointer hover:bg-accent/20 text-muted-foreground">
                      {icon} {ev.toolName}({parseInput(ev.toolInput)})
                    </summary>
                    <div className="px-3 pb-1 pl-7 space-y-1 text-[9px]">
                      {ev.toolInput && (
                        <pre className="bg-muted/40 rounded p-1 overflow-x-auto whitespace-pre-wrap max-h-20">
                          {ev.toolInput}
                        </pre>
                      )}
                      {matched?.toolOutput && (
                        <pre className="bg-muted/40 rounded p-1 overflow-x-auto whitespace-pre-wrap max-h-20">
                          {matched.toolOutput}
                        </pre>
                      )}
                    </div>
                  </details>
                );
              }
              if (ev.eventType === 'extraction') {
                return (
                  <div key={i} className="px-3 py-0.5 text-blue-400">
                    {'\u{1F4E6}'} {ev.variableName} = {(ev.variableValue || '').slice(0, 60)}
                  </div>
                );
              }
              if (ev.eventType === 'validation') {
                return (
                  <div
                    key={i}
                    className={`px-3 py-0.5 ${ev.validationPassed ? 'text-green-500' : 'text-red-500'}`}
                  >
                    {ev.validationPassed ? '\u2705' : '\u274C'} {ev.validationLabel}:{' '}
                    {ev.validationDetails?.slice(0, 60)}
                  </div>
                );
              }
              if (ev.eventType === 'step_start') {
                return (
                  <div key={i} className="px-3 py-0.5 text-purple-400">
                    {'\u{1F680}'} {ev.text}
                  </div>
                );
              }
              if (ev.eventType === 'step_complete') {
                return (
                  <div key={i} className="px-3 py-0.5 text-green-500">
                    {'\u2705'} Step {ev.stepId} complete
                  </div>
                );
              }
              if (ev.eventType === 'step_error') {
                return (
                  <div key={i} className="px-3 py-1 text-red-500 font-medium">
                    {'\u{1F6A8}'} {ev.text}
                  </div>
                );
              }
              return null;
            })}
        </div>
      )}
    </div>
  );
}
