/**
 * Queues module — frontend types (subset of functions/shared/types/queue-request.ts).
 */

export type QueueTarget = 'ec2' | 'local';

export type QueueRequestStatus =
  | 'RECEIVED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RESPONDED';

export interface QueueAuditEntry {
  at: string;
  event: string;
  detail?: string;
  by?: string;
}

/** Mirrors `QueueDispatcher` in functions/shared/types/queue-request.ts — which
 * machine/runtime actually ran the call, the model, and timings. */
export interface QueueDispatcher {
  source: string;
  host: string;
  model: string;
  receivedAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface QueueResponseEnvelope {
  requestId: string;
  status: QueueRequestStatus;
  ok: boolean;
  result?: string;
  error?: string;
  completedAt?: string;
  dispatcher?: QueueDispatcher;
}

export interface QueueRequest {
  requestId: string;
  status: QueueRequestStatus;
  source: string;
  receiver?: string;
  target: QueueTarget;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  prompt: string;
  workingDir?: string;
  autoRespond: boolean;
  callbackUrl?: string;
  response?: QueueResponseEnvelope;
  respondedTo?: string;
  jobId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  audit: QueueAuditEntry[];
  createdBy?: string;
}
