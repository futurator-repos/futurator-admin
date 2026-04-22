export type AttentionSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AttentionCategory =
  | 'policy-violation'
  | 'retry-exhausted'
  | 'daemon-shutdown-timeout'
  | 'tamper-reverted'
  | 'budget-warning'
  | 'test-gate-failed'
  | 'dev-server-down'
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
