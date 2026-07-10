/**
 * Queues module — inbound external REST call record types.
 *
 * An external app (atlassinator, applicator, gomad, mycelium, …) POSTs to
 * `/api/queue/ingest`; the API writes one row here (the socket-tester envelope)
 * and spawns a standard `agent-job` (`jobType: 'queue-request'`) so execution
 * rides the shared ConcurrencyManager cap. The daemon runner streams the live
 * Claude terminal into the `agent-events` table (keyed by the spawned `jobId`)
 * and writes the assembled result back onto this row.
 *
 * Lifecycle:
 *   RECEIVED (API, before enqueue) → QUEUED (agent-job PENDING minted)
 *     → RUNNING (daemon claims the job) → COMPLETED | FAILED
 *     → RESPONDED (answer delivered to the receiver, auto or manual)
 *
 * `target` records where the operator intended the call to run (EC2 vs the
 * laptop daemon). It is a routing *label* today — whichever daemon is alive
 * claims the job; the cap that applies is the one for that daemon's source.
 */

export type QueueTarget = 'ec2' | 'local';

export type QueueRequestStatus =
  | 'RECEIVED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RESPONDED';

/** A single audit-trail entry for the service log (who/what/when). */
export interface QueueAuditEntry {
  at: string; // ISO 8601
  event: string; // e.g. 'received' | 'queued' | 'running' | 'completed' | 'failed' | 'responded'
  detail?: string;
  by?: string; // operator id or 'external' | 'daemon' | 'system'
}

/** The standard JSON answer envelope sent back to the receiver. */
export interface QueueResponseEnvelope {
  requestId: string;
  status: QueueRequestStatus;
  ok: boolean;
  result?: string; // assembled Claude final text
  error?: string;
  completedAt?: string;
}

export interface QueueRequest {
  requestId: string; // PK
  status: QueueRequestStatus;

  // ── Inbound envelope (the socket-tester detail) ──
  source: string; // originating app, e.g. 'atlassinator'
  receiver?: string; // logical receiver name (defaults to source)
  target: QueueTarget; // 'ec2' | 'local'
  method: string; // HTTP method of the inbound call
  path: string; // inbound path
  headers?: Record<string, string>; // sanitized inbound headers (secret stripped)
  body?: unknown; // raw inbound JSON body
  prompt: string; // instructions handed to `claude -p`
  workingDir?: string; // scratch/worktree the session runs in

  // ── Response handling ──
  autoRespond: boolean; // default false — operator reviews & sends manually
  callbackUrl?: string; // where the answer is POSTed
  response?: QueueResponseEnvelope; // captured answer
  respondedTo?: string; // the URL the answer was actually delivered to

  // ── Execution linkage ──
  jobId?: string; // spawned agent-job (also the agent-events key)
  error?: string; // terminal failure message

  // ── Timestamps ──
  createdAt: string;
  updatedAt: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;

  // ── Audit + TTL ──
  audit: QueueAuditEntry[];
  createdBy?: string; // operator id for test calls, else 'external'
  expiresAt: number; // epoch seconds (30-day TTL)
}

/** Compact row for list views (Queues tab table). */
export interface QueueRequestSummary {
  requestId: string;
  status: QueueRequestStatus;
  source: string;
  target: QueueTarget;
  autoRespond: boolean;
  jobId?: string;
  createdAt: string;
  completedAt?: string;
}

export function toQueueRequestSummary(r: QueueRequest): QueueRequestSummary {
  return {
    requestId: r.requestId,
    status: r.status,
    source: r.source,
    target: r.target,
    autoRespond: r.autoRespond,
    jobId: r.jobId,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}
