'use client';

import { useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Code2, Copy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type {
  UltracodeDecisionPlan,
  UltracodePlanAgent,
  UltracodePlanPhase,
} from '@/types/ultracode-run';

const MODE_LABEL: Record<string, string> = {
  'parallel-barrier': 'parallel ⇉',
  streaming: 'pipeline →',
  sequential: 'sequential',
};

/** One subagent — click to reveal its prompt + capabilities. */
function AgentRow({ agent }: { agent: UltracodePlanAgent }) {
  const [open, setOpen] = useState(false);
  const hasPrompt = !!agent.prompt;
  return (
    <li className="pl-4">
      <button
        onClick={() => hasPrompt && setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-1.5 text-left text-xs text-muted-foreground"
        aria-expanded={open}
      >
        {hasPrompt ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )
        ) : (
          <Bot className="h-3 w-3 shrink-0" />
        )}
        <span className="text-foreground">{agent.role}</span>
        {agent.model && agent.model !== 'default' && (
          <span className="font-mono">· {agent.model}</span>
        )}
        {agent.effort && (
          <Badge variant="outline" className="text-[10px]">
            effort: {agent.effort}
          </Badge>
        )}
        {agent.hasSchema && (
          <Badge variant="outline" className="text-[10px]">
            schema
          </Badge>
        )}
        {agent.isolation === 'worktree' && (
          <Badge variant="outline" className="text-[10px]">
            worktree
          </Badge>
        )}
        {agent.agentType && (
          <Badge variant="outline" className="text-[10px]">
            {agent.agentType}
          </Badge>
        )}
      </button>
      {open && agent.prompt && (
        <div className="mt-1 rounded-md border border-border bg-muted/30 p-2">
          {agent.promptDynamic && (
            <p className="mb-1 text-[10px] text-warning">
              ⚠ prompt is composed dynamically in the script — this is the call expression; see the
              full script for the builder.
            </p>
          )}
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
            {agent.prompt}
          </pre>
        </div>
      )}
    </li>
  );
}

function PhaseRow({ phase, index }: { phase: UltracodePlanPhase; index: number }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="tabular-nums text-muted-foreground">{index + 1}.</span>
          <span>{phase.name}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <Badge variant="outline" className="text-[10px]">
            {MODE_LABEL[phase.mode] ?? phase.mode}
          </Badge>
          {phase.fanOut && (
            <Badge variant="secondary" className="text-[10px]">
              {phase.fanOut.axis} × {String(phase.fanOut.width)}
            </Badge>
          )}
        </div>
      </div>
      {phase.agents.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {phase.agents.map((a, i) => (
            <AgentRow key={i} agent={a} />
          ))}
        </ul>
      )}
      {phase.barrierReason && (
        <p className="mt-1 pl-4 text-[10px] text-muted-foreground">
          barrier: {phase.barrierReason}
        </p>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title="Copy script to clipboard"
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function PlanView({ plan, script }: { plan: UltracodeDecisionPlan; script?: string }) {
  const [showScript, setShowScript] = useState(false);
  const totalAgents = plan.phases.reduce((n, p) => n + p.agents.length, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <Badge>{plan.pattern}</Badge>
        {plan.verify?.present && (
          <Badge variant="secondary" className="text-[10px]">
            verify: {plan.verify.kind}
          </Badge>
        )}
        {plan.qualityPatterns.map((q) => (
          <Badge key={q} variant="outline" className="text-[10px]">
            {q}
          </Badge>
        ))}
        <span className="ml-auto whitespace-nowrap text-[10px] text-muted-foreground">
          {plan.phases.length} phases · {totalAgents} agents · {plan.reduceSteps} reduce
        </span>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
        {plan.phases.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No phases parsed from the script — view the raw script below.
          </p>
        ) : (
          plan.phases.map((p, i) => <PhaseRow key={i} phase={p} index={i} />)
        )}
        {plan.extraction?.lossy?.length > 0 && (
          <p className="pt-1 text-[10px] text-muted-foreground">
            ⚠ lossy: {plan.extraction.lossy.join('; ')}
          </p>
        )}
      </div>

      {script && (
        <div className="border-t border-border">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setShowScript((v) => !v)}
              className="flex flex-1 items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50"
            >
              {showScript ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <Code2 className="h-3 w-3" />
              {showScript ? 'Hide' : 'View'} generated script ({script.split('\n').length} lines)
            </button>
            <div className="pr-2">
              <CopyButton text={script} />
            </div>
          </div>
          {showScript && (
            <pre className="max-h-72 overflow-auto bg-muted/40 px-3 py-2 text-[10px] leading-relaxed">
              <code>{script}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
