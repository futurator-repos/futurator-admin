export type AttentionSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AttentionCategory =
  | 'policy-violation'
  | 'retry-exhausted'
  | 'daemon-shutdown-timeout'
  | 'tamper-reverted'
  | 'budget-warning'
  | 'test-gate-failed'
  | 'dev-server-down'
  // Story A.4: surfaced when a per-story compile/sync step exits non-zero —
  // either compile-diff produced no in-scope changes, the per-story commit
  // failed, S3 mirror was empty after sync, or Memgraph upsert reported zero
  // nodes. Operator gets to decide whether to retrigger the story or move on.
  | 'compile-sync-failed'
  // Pipeline v1 — Story 1.2 (universal escalation extractors).
  // 'agent-escalated' = agent emitted ---ESCALATE--- with structured payload.
  // 'agent-needs-human' = agent emitted ---NEED-HUMAN--- shortcut with a question.
  // Both route to NEEDS_ATTENTION; neither triggers a retry.
  | 'agent-escalated'
  | 'agent-needs-human'
  | 'other';

export type AttentionStatus = 'open' | 'resolving' | 'resolved';

export type AttentionActionKind = 'retry-step' | 'open-story' | 'open-logs' | 'archive';

export interface AttentionAction {
  label: string;
  kind: AttentionActionKind;
}

export interface AttentionContext {
  epicId?: string;
  storyId?: string;
  jobId?: string;
  stepId?: string;
}

export interface AttentionItem {
  planId: string;
  itemId: string;
  createdAt: string;
  resolvedAt: string | null;
  severity: AttentionSeverity;
  category: AttentionCategory;
  title: string;
  body: string;
  context: AttentionContext;
  suggestedActions: AttentionAction[];
  status: AttentionStatus;
}

export interface AttentionItemSummary {
  planId: string;
  itemId: string;
  createdAt: string;
  resolvedAt: string | null;
  severity: AttentionSeverity;
  category: AttentionCategory;
  title: string;
  status: AttentionStatus;
}
