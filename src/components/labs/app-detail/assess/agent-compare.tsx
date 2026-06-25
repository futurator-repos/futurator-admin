'use client';

/**
 * Dual-agent comparison panel (the "ultimate goal"). Asks the SAME question of
 * two agents over the assessed clone — Agent A (vanilla Claude tools) vs Agent B
 * (+ Mycelium graph MCP) — then shows both answers side-by-side with latency,
 * tokens, cost, and how many graph tools Agent B actually called. Human judges
 * which answer is better; the metrics show whether the graph earned its keep.
 */

import { useState } from 'react';
import { useAgentJob } from '@/hooks/use-agent-job';
import {
  useRunAgentCompare,
  COMPARE_PRESETS,
  type RunAgentCompareInput,
} from '@/hooks/use-agent-compare';
import type { DualAgentLaneResult } from '@/types/agent-orchestrator';

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtUsd = (n: number | null) => (n == null ? '—' : `$${n.toFixed(4)}`);

export function AgentCompare({ appId }: { appId: string }) {
  const [question, setQuestion] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const run = useRunAgentCompare(appId);
  const { data: job } = useAgentJob(jobId);

  const result = job?.dualAgentCompareResult ?? null;
  const status = job?.status;
  const running = !!jobId && status !== 'COMPLETED' && status !== 'FAILED';

  const start = () => {
    const q = question.trim();
    if (!q) return;
    const input: RunAgentCompareInput = { question: q };
    run.mutate(input, { onSuccess: (res) => setJobId(res.jobId) });
  };

  return (
    <div
      data-testid="agent-compare"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 14,
        background: 'var(--bg-elev)',
      }}
    >
      <div>
        <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', margin: 0 }}>
          Compare agents: vanilla vs. graph-equipped
        </h4>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '3px 0 0' }}>
          Same question, two agents. Agent B gets the Mycelium code-graph tools. Compare answer
          quality (you judge), latency, tokens, and cost. If Agent B made 0 graph calls or the graph
          isn’t ingested for this app, that’s a signal too.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {COMPARE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setQuestion(p)}
            disabled={running}
            style={{
              fontSize: 10.5,
              color: 'var(--text-dim)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '3px 9px',
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {p}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about this codebase…"
          rows={2}
          disabled={running}
          data-testid="agent-compare-input"
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: 'inherit',
            color: 'var(--foreground)',
            background: 'var(--background)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '8px 10px',
            resize: 'vertical',
          }}
        />
        <button
          type="button"
          onClick={start}
          disabled={running || run.isPending || !question.trim()}
          data-testid="agent-compare-run"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--background)',
            background: 'var(--foreground)',
            border: 'none',
            borderRadius: 8,
            padding: '9px 16px',
            cursor: running || !question.trim() ? 'not-allowed' : 'pointer',
            opacity: running || !question.trim() ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {running ? 'Running…' : run.isPending ? 'Starting…' : 'Compare'}
        </button>
      </div>

      {running && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Spawning both agents (sequential, up to a few minutes each)…
        </div>
      )}
      {status === 'FAILED' && (
        <div style={{ fontSize: 11, color: 'var(--destructive)' }}>
          Comparison failed: {job?.errorMessage || 'unknown error'}
        </div>
      )}

      {result && (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Question: <span style={{ color: 'var(--foreground)' }}>{result.question}</span> · model{' '}
            {result.model}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              alignItems: 'stretch',
            }}
          >
            <LaneCard lane={result.agentA} />
            <LaneCard lane={result.agentB} />
          </div>
          <DeltaRow a={result.agentA} b={result.agentB} />
        </>
      )}
    </div>
  );
}

function LaneCard({ lane }: { lane: DualAgentLaneResult }) {
  return (
    <div
      data-testid={`agent-compare-lane-${lane.lane}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 10,
        background: 'var(--background)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
          Agent {lane.lane}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{lane.label}</span>
        {lane.withGraph && (
          <span
            title="Mycelium graph tool calls"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: lane.graphToolCalls > 0 ? 'var(--background)' : 'var(--text-dim)',
              background: lane.graphToolCalls > 0 ? 'var(--accent-purple, #a855f7)' : 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '1px 7px',
              marginLeft: 'auto',
            }}
          >
            {lane.graphToolCalls} graph call{lane.graphToolCalls === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 10.5, color: 'var(--text-dim)' }}>
        <span>⏱ {fmtMs(lane.latencyMs)}</span>
        <span>
          ▦ {fmtTok(lane.tokens.input)} in / {fmtTok(lane.tokens.output)} out
        </span>
        <span>$ {fmtUsd(lane.costUsd)}</span>
        <span>🔧 {lane.toolCalls}</span>
      </div>
      {lane.error ? (
        <div style={{ fontSize: 11, color: 'var(--destructive)' }}>Error: {lane.error}</div>
      ) : (
        <div
          style={{
            fontSize: 11.5,
            lineHeight: 1.5,
            color: 'var(--foreground)',
            whiteSpace: 'pre-wrap',
            maxHeight: 360,
            overflow: 'auto',
          }}
        >
          {lane.answer || '(no answer)'}
        </div>
      )}
    </div>
  );
}

function DeltaRow({ a, b }: { a: DualAgentLaneResult; b: DualAgentLaneResult }) {
  const tok = (l: DualAgentLaneResult) => l.tokens.input + l.tokens.output;
  const delta = (x: number, y: number) => {
    if (!x) return '—';
    const pct = ((y - x) / x) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
  };
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        fontSize: 11,
        color: 'var(--text-dim)',
        borderTop: '1px solid var(--border)',
        paddingTop: 8,
      }}
    >
      <span>
        B vs A latency:{' '}
        <strong style={{ color: 'var(--foreground)' }}>{delta(a.latencyMs, b.latencyMs)}</strong>
      </span>
      <span>
        B vs A tokens:{' '}
        <strong style={{ color: 'var(--foreground)' }}>{delta(tok(a), tok(b))}</strong>
      </span>
      <span>
        B vs A cost:{' '}
        <strong style={{ color: 'var(--foreground)' }}>
          {a.costUsd && b.costUsd ? delta(a.costUsd, b.costUsd) : '—'}
        </strong>
      </span>
      <span>
        Graph tools used by B:{' '}
        <strong style={{ color: 'var(--foreground)' }}>{b.graphToolCalls}</strong>
      </span>
    </div>
  );
}
