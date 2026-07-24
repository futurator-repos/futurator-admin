'use client';
import { useMemo, useState } from 'react';
import { useQueueRequest, useRespondQueueRequest } from '@/hooks/use-queue-requests';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useServers } from '@/hooks/use-servers';
import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusLozenge } from './status-legend';
import type { AgentJobStatus } from '@/types/agent-orchestrator';
import type { QueueRequest, QueueRequestStatus } from '@/types/queue';

/** Map the queue-request status onto the AgentJobStatus the events poller reads. */
function toJobStatus(s: QueueRequestStatus | undefined): AgentJobStatus | undefined {
  if (!s) return undefined;
  if (s === 'RUNNING') return 'RUNNING';
  if (s === 'FAILED') return 'FAILED';
  if (s === 'COMPLETED' || s === 'RESPONDED') return 'COMPLETED';
  return 'PENDING';
}

/** One rendered line of the live terminal, derived from an agent-event row. */
interface QueueEventRow {
  eventSeq: string;
  eventType: string;
  text?: string;
  tool?: { name?: string; input?: string };
  result?: string;
  error?: string;
  prompt?: string;
}

function LiveTerminal({ jobId, status }: { jobId: string | null; status: QueueRequestStatus }) {
  // Reuse the pipeline's agent-events poller (cursor + terminal-catch-up handled).
  const { events } = useAgentEvents(jobId, toJobStatus(status));
  const rows = events as unknown as QueueEventRow[];

  const lines = useMemo(() => {
    const out: { key: string; kind: string; text: string }[] = [];
    for (const e of rows) {
      switch (e.eventType) {
        case 'queue.start':
          out.push({ key: e.eventSeq, kind: 'meta', text: `▶ session started` });
          break;
        case 'queue.token':
          if (e.text) out.push({ key: e.eventSeq, kind: 'token', text: e.text });
          break;
        case 'queue.tool_use':
          out.push({
            key: e.eventSeq,
            kind: 'tool',
            text: `⚙ ${e.tool?.name ?? 'tool'}(${e.tool?.input ?? ''})`,
          });
          break;
        case 'queue.result':
          out.push({
            key: e.eventSeq,
            kind: e.error ? 'error' : 'result',
            text: e.error ? `✖ ${e.error}` : `■ done`,
          });
          break;
        default:
          break;
      }
    }
    return out;
  }, [rows]);

  return (
    <div className="rounded-md border border-border bg-black/60 p-3 font-mono text-[11px] leading-relaxed max-h-96 overflow-auto">
      {lines.length === 0 ? (
        <span className="text-muted-foreground italic">
          {status === 'QUEUED' || status === 'RECEIVED'
            ? 'Waiting for a free slot…'
            : 'No output yet.'}
        </span>
      ) : (
        lines.map((l) => (
          <span
            key={l.key}
            className={
              l.kind === 'tool'
                ? 'text-cyan-400'
                : l.kind === 'error'
                  ? 'text-red-400'
                  : l.kind === 'meta' || l.kind === 'result'
                    ? 'text-muted-foreground'
                    : 'text-green-300'
            }
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {l.text}
          </span>
        ))
      )}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-[10px] uppercase text-muted-foreground">{label}</span>
      <span className="text-xs break-all">{value}</span>
    </div>
  );
}

/** Pretty-prints whatever value is stored — no schema assumptions about its shape.
 * Renders nothing for an absent/empty value so ingest rows without a body/headers
 * field don't show a stray empty block. */
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  let pretty: string;
  try {
    pretty = JSON.stringify(value, null, 2);
  } catch {
    pretty = String(value);
  }
  if (!pretty || pretty === '{}' || pretty === '[]' || pretty === '""') return null;
  return (
    <details>
      <summary className="cursor-pointer text-[10px] uppercase text-muted-foreground hover:text-foreground">
        {label}
      </summary>
      <pre className="mt-1 rounded-md border border-border bg-muted/30 p-2 text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">
        {pretty}
      </pre>
    </details>
  );
}

/** Call/body inspector (D6b) — renders whatever the stored row carries
 * (method/path/source/headers/body) for BOTH ingest and dispatch-audit rows.
 * Pure pretty-print: no field allow-list, no schema assumptions. Header
 * sanitization (stripping x-queue-key / authorization) happens server-side
 * at persistence (A2); this only displays what was stored. */
function CallInspector({ req }: { req: QueueRequest }) {
  const hasBody = req.body !== undefined && req.body !== null;
  const hasHeaders = req.headers !== undefined && req.headers !== null;
  if (!req.method && !req.path && !hasHeaders && !hasBody) return null;

  return (
    <div className="rounded-md border border-border p-3 space-y-1.5">
      <span className="text-xs font-medium">Call</span>
      <MetaRow label="Method" value={req.method || '—'} />
      <MetaRow label="Path" value={req.path || '—'} />
      <MetaRow label="Source" value={req.source || '—'} />
      <JsonBlock label="Headers" value={req.headers} />
      <JsonBlock label="Body" value={req.body} />
    </div>
  );
}

function ResponsePanel({ req }: { req: QueueRequest }) {
  const respond = useRespondQueueRequest();
  const [receiverUrl, setReceiverUrl] = useState('');
  const canSend = req.status === 'COMPLETED'; // not yet RESPONDED, has a captured answer
  const answer = req.response?.result ?? req.response?.error ?? '';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Response</span>
        <span className="text-[10px] text-muted-foreground">
          auto-respond {req.autoRespond ? 'ON' : 'OFF'}
        </span>
      </div>
      {req.response ? (
        <pre className="rounded-md border border-border bg-muted/30 p-2 text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-auto">
          {answer || '(empty)'}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground italic">No response captured yet.</p>
      )}

      {req.respondedTo && (
        <p className="text-[10px] text-emerald-400">Delivered to {req.respondedTo}</p>
      )}

      {canSend && (
        <div className="flex items-center gap-2">
          <input
            value={receiverUrl}
            onChange={(e) => setReceiverUrl(e.target.value)}
            placeholder={req.callbackUrl || 'Receiver URL (re-route optional)'}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
          <button
            onClick={() =>
              respond.mutate({
                requestId: req.requestId,
                receiverUrl: receiverUrl.trim() || undefined,
              })
            }
            disabled={respond.isPending || (!receiverUrl.trim() && !req.callbackUrl)}
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            {respond.isPending ? 'Sending…' : 'Send response'}
          </button>
        </div>
      )}
      {respond.isError && (
        <p className="text-[10px] text-red-400">{(respond.error as Error).message}</p>
      )}
    </div>
  );
}

export function QueueDetail({ requestId }: { requestId: string }) {
  const { data: req, isLoading } = useQueueRequest(requestId);
  const { data: job } = useAgentJob(req?.jobId ?? null);
  const { data: serversData } = useServers();
  const serverNameById = new Map(
    (serversData?.servers ?? []).map((s) => [s.serverId, s.name] as const),
  );

  if (isLoading || !req) {
    return <div className="text-xs text-muted-foreground">Loading request…</div>;
  }

  const dispatcherHost = req.response?.dispatcher?.host;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Metadata card — the socket-tester detail */}
        <div className="rounded-md border border-border p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusLozenge status={req.status} />
              <span className="text-xs font-medium">{req.source}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                {req.target}
              </span>
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">{req.requestId}</span>
          </div>
          <MetaRow label="Created" value={new Date(req.createdAt).toLocaleString()} />
          {req.startedAt && (
            <MetaRow label="Started" value={new Date(req.startedAt).toLocaleTimeString()} />
          )}
          {req.completedAt && (
            <MetaRow label="Completed" value={new Date(req.completedAt).toLocaleTimeString()} />
          )}
          <MetaRow label="Receiver" value={req.receiver ?? '—'} />
          <MetaRow label="Callback" value={req.callbackUrl ?? '—'} />
          <MetaRow label="Job" value={req.jobId ?? '—'} />
          <MetaRow
            label="Machine"
            value={
              job?.assignedServerId || dispatcherHost ? (
                <span className="inline-flex items-center gap-2">
                  {job?.assignedServerId && (
                    <span title={job.assignReason}>
                      {serverNameById.get(job.assignedServerId) ?? job.assignedServerId}
                    </span>
                  )}
                  {dispatcherHost && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      ({dispatcherHost})
                    </span>
                  )}
                </span>
              ) : (
                '—'
              )
            }
          />
          <MetaRow
            label="Prompt"
            value={<span className="text-muted-foreground">{req.prompt.slice(0, 400)}</span>}
          />
          {req.error && (
            <MetaRow label="Error" value={<span className="text-red-400">{req.error}</span>} />
          )}
        </div>

        {/* Call / body inspector — raw request as received (ingest or dispatch) */}
        <CallInspector req={req} />

        {/* Live terminal */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Live terminal</span>
          <LiveTerminal jobId={req.jobId ?? null} status={req.status} />
        </div>

        {/* Response */}
        <ResponsePanel req={req} />

        {/* Audit log */}
        {req.audit?.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
              Audit log ({req.audit.length})
            </summary>
            <div className="mt-1 space-y-0.5">
              {req.audit.map((a, i) => (
                <div key={i} className="flex gap-2 text-[10px] font-mono text-muted-foreground">
                  <span>{new Date(a.at).toLocaleTimeString()}</span>
                  <span className="text-foreground">{a.event}</span>
                  <span>{a.detail}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </TooltipProvider>
  );
}
