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
 * `target` records where the call runs (EC2 vs the laptop daemon) and is
 * ENFORCED: the daemon claim loop only picks up a queue-request whose target
 * matches its own DAEMON_SOURCE (see `isJobClaimableBySource` in job-router.mjs),
 * so a 'local' call routes to the laptop daemon and 'ec2' to the EC2 daemon. The
 * cap that applies is the one for that daemon's source.
 */

export type QueueTarget = 'ec2' | 'local';

/**
 * Which inbound mechanism minted this row. `'ingest'` = the queue-request path
 * (`POST /api/queue/ingest` / `/test`) that spawns a `queue-request` agent-job.
 * `'dispatch'` = an AUDIT-ONLY row for the pipeline-dispatch/frontier path
 * (`POST /api/pipeline/dispatch`) — it does NOT spawn a queue-request job; it
 * links to the created plan/run via `runId`/`planId` so the two paths are both
 * visible in `/development/queues`. Absent on legacy ingest rows ⇒ treat as
 * `'ingest'`.
 */
export type QueueRequestKind = 'ingest' | 'dispatch';

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

/**
 * Dispatch provenance stamped onto every completed run — which machine/runtime
 * ran the call, the model, and timings. Delivered inside the envelope AND as
 * X-Futurator-* headers on the callback POST so external systems can audit/route
 * the dispatcher without parsing the body. Written by the daemon runner.
 */
export interface QueueDispatcher {
  source: string; // 'ec2' | 'local' — the runtime that actually ran it
  host: string; // os.hostname() — distinguishes EC2 vs each laptop
  model: string; // model used ('default' when unspecified)
  receivedAt?: string; // job enqueue time
  startedAt?: string;
  completedAt?: string;
  durationMs?: number; // startedAt → completedAt
}

/** The standard JSON answer envelope sent back to the receiver. */
export interface QueueResponseEnvelope {
  requestId: string;
  status: QueueRequestStatus;
  ok: boolean;
  result?: string; // assembled Claude final text
  error?: string;
  completedAt?: string;
  dispatcher?: QueueDispatcher; // dispatch provenance (machine/runtime/model/timing)
}

export interface QueueRequest {
  requestId: string; // PK
  status: QueueRequestStatus;

  // Discriminator — which inbound mechanism minted the row (absent ⇒ 'ingest').
  kind?: QueueRequestKind;

  // ── Inbound envelope (the socket-tester detail) ──
  source: string; // originating app, e.g. 'atlassinator'
  receiver?: string; // logical receiver name (defaults to source)
  // Declared request-time routing intent ('ec2' | 'local'). Optional: the
  // pipeline-dispatch/frontier path declares no target (the executing host is
  // resolved later from the minted job's assignedServerId), so dispatch audit
  // rows leave it unset rather than guessing a provider literal.
  target?: QueueTarget;
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
  // Dispatch/frontier-path linkage (kind === 'dispatch'). The created run and
  // plan share one id in that path (planId === runId); both are stored so the
  // Queues tab can join a dispatch row to its plan and resolve an honest status.
  runId?: string; // linked pipeline run
  planId?: string; // linked plan
  // Display stage captured at write time from `derivePipelineStage(plan,nodes)`
  // — the honest plan/stage the audit row reflects (e.g. 'queued' | 'concept' |
  // 'developing' | 'vqa' | 'deployment' | 'completed' | 'failed' | 'blocked').
  // A read-side join may re-derive it live; this is the write-time snapshot.
  dispatchStage?: string;
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
  kind?: QueueRequestKind;
  source: string;
  target?: QueueTarget;
  autoRespond: boolean;
  jobId?: string;
  runId?: string;
  planId?: string;
  dispatchStage?: string;
  createdAt: string;
  completedAt?: string;
}

export function toQueueRequestSummary(r: QueueRequest): QueueRequestSummary {
  return {
    requestId: r.requestId,
    status: r.status,
    kind: r.kind,
    source: r.source,
    target: r.target,
    autoRespond: r.autoRespond,
    jobId: r.jobId,
    runId: r.runId,
    planId: r.planId,
    dispatchStage: r.dispatchStage,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}
