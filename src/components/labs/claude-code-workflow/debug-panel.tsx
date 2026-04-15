'use client';
import { useMemo } from 'react';
import type { AgentEvent, AgentJob } from '@/types/agent-orchestrator';

interface DebugPanelProps {
  events: AgentEvent[];
  job?: AgentJob;
}

export function DebugPanel({ events, job }: DebugPanelProps) {
  const variables = job?.variables || {};
  const stepResults = job?.stepResults || [];

  const extractions = useMemo(() => events.filter((e) => e.eventType === 'extraction'), [events]);

  const validations = useMemo(() => events.filter((e) => e.eventType === 'validation'), [events]);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Variable Store */}
      <div>
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Variable Store
        </h4>
        {Object.keys(variables).length === 0 ? (
          <p className="text-xs text-muted-foreground">No variables extracted yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-input">
                <th className="pb-1 text-left font-medium text-muted-foreground">Name</th>
                <th className="pb-1 text-left font-medium text-muted-foreground">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(variables).map(([name, value]) => (
                <tr key={name} className="border-b border-input/50">
                  <td className="py-1 font-mono text-blue-600 dark:text-blue-400">{name}</td>
                  <td className="py-1 font-mono max-w-[300px] truncate" title={value}>
                    {value.length > 80 ? `${value.slice(0, 80)}...` : value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Live extraction log */}
        {extractions.length > 0 && (
          <div className="mt-3">
            <h4 className="mb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Extraction Log
            </h4>
            {extractions.map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="text-green-600 dark:text-green-400">&rarr;</span>
                <span className="font-mono text-blue-600 dark:text-blue-400">{e.variableName}</span>
                <span className="text-muted-foreground">({e.extractorType})</span>
                <span className="truncate max-w-[200px] font-mono" title={e.variableValue}>
                  {e.variableValue && e.variableValue.length > 40
                    ? `${e.variableValue.slice(0, 40)}...`
                    : e.variableValue}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Validations + Step Timeline */}
      <div>
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Validations
        </h4>
        {validations.length === 0 ? (
          <p className="text-xs text-muted-foreground">No validations run yet.</p>
        ) : (
          <div className="space-y-1">
            {validations.map((v, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span
                  className={
                    v.validationPassed
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }
                >
                  {v.validationPassed ? 'PASS' : 'FAIL'}
                </span>
                <span className="font-medium">{v.validationLabel}</span>
                <span
                  className="text-muted-foreground truncate max-w-[250px]"
                  title={v.validationDetails || ''}
                >
                  {v.validationDetails}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Step timeline */}
        {stepResults.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Step Timeline
            </h4>
            <div className="space-y-1.5">
              {stepResults.map((sr, i) => {
                const ctxW = sr.contextWindow ?? 0;
                const contextPct =
                  ctxW > 0
                    ? Math.round((((sr.inputTokens || 0) + (sr.outputTokens || 0)) / ctxW) * 100)
                    : 0;
                return (
                  <div key={`${sr.stepId}-${i}`} className="text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          sr.status === 'complete'
                            ? 'text-green-600'
                            : sr.status === 'error'
                              ? 'text-red-600'
                              : 'text-yellow-600'
                        }
                      >
                        {sr.status === 'complete' ? 'DONE' : sr.status === 'error' ? 'ERR' : 'RUN'}
                      </span>
                      <span className="font-mono">{sr.stepId}</span>
                      <span className="text-muted-foreground">({sr.agentId})</span>
                      {sr.cost != null && sr.cost > 0 && (
                        <span className="text-muted-foreground">${sr.cost.toFixed(4)}</span>
                      )}
                      {sr.durationMs != null && (
                        <span className="text-muted-foreground">
                          {(sr.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                      {sr.sessionId && (
                        <span className="font-mono text-muted-foreground/60 text-[10px]">
                          {sr.sessionId.slice(0, 8)}
                        </span>
                      )}
                    </div>
                    {(sr.model || sr.inputTokens) && (
                      <div className="ml-14 flex items-center gap-2 text-[10px] text-muted-foreground/80">
                        {sr.model && <span>{sr.model.replace(/\[.*\]/, '')}</span>}
                        {sr.inputTokens != null && <span>{sr.inputTokens.toLocaleString()}in</span>}
                        {sr.outputTokens != null && (
                          <span>{sr.outputTokens.toLocaleString()}out</span>
                        )}
                        {contextPct > 0 && (
                          <span
                            className={
                              contextPct > 80
                                ? 'text-red-500'
                                : contextPct > 50
                                  ? 'text-yellow-500'
                                  : ''
                            }
                          >
                            ctx:{contextPct}%
                          </span>
                        )}
                        {sr.numTurns != null && sr.numTurns > 1 && <span>{sr.numTurns}turns</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
