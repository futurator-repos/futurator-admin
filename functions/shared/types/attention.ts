export type AttentionSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AttentionCategory =
  | 'policy-violation'
  | 'retry-exhausted'
  // Pipeline v2.0 efficiency fix T0.3: distinct from the generic
  // 'retry-exhausted' so operators can spot a story-pipeline DEV loop at a
  // glance. Triggered when a story's dev step fails MAX_DEV_ATTEMPTS_PER_STORY
  // times (default 2) without emitting ---DONE---. Resolution actions favor
  // Salvage-with-last-WORK_SUMMARY over the generic Retry to discourage
  // burning more budget on the same conclusion.
  | 'dev-retry-exhausted'
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
  // Story 1.3 — daemon-side loop detector forced the step to exit.
  | 'loop-detected'
  // Story 1.4 — pre-flight validator failure (e.g. folder-exists). Step
  // never spawned Claude; operator must fix the precondition and retry.
  | 'preflight-failed'
  // Story C.2/C.5: per-AC reviewer escalation. Emitted when the structured
  // ---REVIEW_CRITERIA--- block has at least one `needs-human` verdict.
  // Operator opens Talk → answers → Apply Output → final verdict drives
  // wave advancement.
  | 'reviewer-needs-human'
  // Story C.2: REVIEWER did not emit a parseable ---REVIEW_CRITERIA--- block.
  // Distinct category from `agent-escalated` so operators can spot prompt
  // drift quickly. Daemon also forces the next loop iteration to ask the
  // reviewer to re-emit.
  | 'prompt-format'
  // Pipeline v2 Phase 1 / Story 1.4.3: an App-bootstrap saga step failed
  // (clone, materialize, inject, npm install, BMAD install, commit/push).
  // Title carries the failing step + slug; suggestedActions includes
  // "Re-run bootstrap" and "Mark App failed and delete".
  | 'pv2-app-bootstrap-failed'
  // Pipeline v2 Phase 1 / Story 1.4.4: the saga's `deleteRepo` rollback
  // itself failed after a DDB transaction error, leaving an orphaned
  // GitHub repo that an operator must clean up by hand.
  | 'pv2-app-bootstrap-rollback-orphan'
  // Pipeline v2 Phase 1 / Story 1.8.7: a plan's category time exceeded the
  // cohort median by ≥3× (info) or ≥5× (medium). Deep-link → /labs?planId=#timing.
  | 'pv2-timer-cohort-outlier'
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
