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
  // Pipeline v2.0 PR-6 (B+): the daemon's auth-recovery wrapper attempted 2
  // OAuth reloads after a mid-stream auth failure but the access token
  // remained invalid. Operator must Re-Authorize from the admin UI; once
  // tokens are fresh, clicking Retry resumes from the prior session
  // (PR-6 A) without re-running completed steps.
  | 'auth-recovery-failed'
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
  // compile-commit-on-pass refused an empty commit (STORY_COMMIT_EMPTY), OR
  // the 2026-06-05 false-DONE guard found a story-pipeline job reaching the
  // end with no commit on the worktree HEAD (resume-past-empty-commit). The
  // story was NOT delivered; the job is FAILED. High severity.
  | 'story-commit-empty'
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
  // ── Epic 2 + Epic 3 (2026-05-19/20) — skill substrate categories ────
  // Epic 2 Story 2.3 — vendor-skills exit 1 (federation missing /
  // network / malformed manifest). Bootstrap completes; operator fixes
  // upstream cause + re-runs sync.
  | 'skill-sync-failed'
  // Epic 2 Story 2.3 — vendor-skills exit 2 (one or more local SKILL.md
  // SHAs don't match the pinned version). Non-blocking; operator runs
  // `--resync` or re-pins via SKILL-SCOUT.
  | 'skill-manifest-out-of-sync'
  // Epic 3 Story 3.1 — SKILL-SCOUT decision card (v2.5 §37.2). Operator
  // chooses confirm / edit / decline / defer.
  | 'manifest-change-proposed'
  // Epic 3 Story 3.1 — SKILL-SCOUT step failed (agent crash, manifest
  // read error, OAuth death). Non-blocking; the project still has its
  // pre-existing manifest.
  | 'skill-scout-failed'
  // Epic 3 Story 3.1 — SKILL-SCOUT emitted output that didn't match the
  // Zod schema (missing fields, malformed JSON, version pin shape).
  // Indicates prompt tuning is needed.
  | 'skill-scout-output-invalid'
  // Epic 3 Story 3.2 — operator-confirmed install failed (manifest
  // write error, vendor sync hard-fail). Manifest changes were either
  // partial or not committed.
  | 'skill-install-failed'
  // 2026-06-02 — per-story runtime VQA (review-runtime) judged the running
  // app against the story's browser ACs and one or more FAILED. One evolving
  // card per (plan, story); carries the screenshot URL + observations and
  // auto-resolves when a retry passes. The DEV agent is auto-fed the
  // observations to fix (story-pipeline retry loop).
  | 'story-vqa-failed'
  // ── Step-0 hardening (2026-06-05) — honest-verdict categories ──────
  // 'story-vqa-unverifiable' — the judge classified one or more browser
  // ACs as UNREACHABLE from the idle frame (or only low-confidence FAILs).
  // No retry was triggered; the operator should rebind/reword the AC or
  // map it to a suite test. Low severity, deduped per (plan, story).
  | 'story-vqa-unverifiable'
  // 'story-vqa-skipped' — review-runtime exited without judging (dev
  // server no-boot, screenshot failure, judge crash, unparseable output).
  // The story proceeded UNVERIFIED; previously this was indistinguishable
  // from a healthy pass (the H12 silent-pass surface).
  | 'story-vqa-skipped'
  // 'ac-contested' — DEV emitted ---AC_CONTEST--- instead of a code change:
  // it disputes that the failing AC's state is observable by the idle
  // screenshot. The fix loop stopped without burning iterations; operator
  // adjudicates (fix the AC / Accept in QA / send back to dev).
  | 'ac-contested'
  // 'ac-coverage-gap' — TEST emitted an AC→test map but some browser ACs
  // have no asserting test case; the screenshot judge keeps jurisdiction
  // over them (Step-0.5 deterministic-first binding).
  | 'ac-coverage-gap'
  // pacman1 (2026-06-11) — wave gate categories, written daemon-side by the
  // wave-merge runner (untyped JS) since Story B but never declared here:
  // 'wave-build-failed'  — clean merge, but the merged union failed the
  //                        post-merge validation gate (build/typecheck/tests).
  // 'merge-conflict'     — a story's merge conflicted and (if auto-merge is
  //                        on) the resolver couldn't integrate it.
  // Declaring them lets the UI wire category-specific actions (Retry gate).
  | 'wave-build-failed'
  | 'merge-conflict'
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
  /**
   * pacman1 (2026-06-11) — wave gate failures carry the wave index so the
   * UI can wire the "Retry step" suggested action to
   * POST /api/plans/:id/waves/retry-gate without parsing the title.
   */
  waveNumber?: number;
}

/**
 * 2026-05-27 PR D.a — per-item remediation policy.
 *
 *   manual     — operator must open the chat themselves (today's behavior;
 *                no agent action without explicit operator intent).
 *   auto-draft — daemon spawns a free-agent session, drafts a fix, opens
 *                a PR, then STOPS. Operator approves via inline card or
 *                push notification.
 *   auto-fix   — same as auto-draft, but if classifier returns `green`
 *                AND all gates pass, the daemon's bot identity calls
 *                /approve-merge itself. Reserved for highly-confident
 *                item types only (operator graduates types over time).
 *
 * Default is 'manual'. The policy can be set per-type via the operator
 * UI's Settings → Agent → Remediation Policies panel (each entry maps
 * an AttentionCategory to a policy). Per-item overrides are stored on
 * the item row itself.
 */
export type RemediationPolicy = 'manual' | 'auto-draft' | 'auto-fix';

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

  // ── Pipeline v2.0 PR-7 (G+H+I): idempotent upsert + recurrence count ────
  //
  // dedupKey is a stable identifier for the underlying logical failure (e.g.,
  // "wave-reducer:test-gate-failed:<storyId>"). Multiple emitters of the same
  // failure produce ONE row keyed on (planId, dedupKey) instead of N rows
  // keyed on (planId, itemId). Reducers / cron / daemon retry attempts all
  // dedupe naturally via `upsertOpenAttentionItem`.
  //
  // dino1 forensic (2026-04-29): a single stuck story produced 224 attention
  // items because every wave-reducer tick wrote a new row. With dedupKey the
  // operator sees one row with `recurrenceCount: 86`.
  //
  // Optional for backwards-compat — pre-PR-7 rows have no dedupKey and use
  // itemId as their primary identifier. New writes from PR-7+ should always
  // supply one.
  dedupKey?: string;
  /** ISO timestamp of the most-recent upsert that matched this row. Defaults to createdAt. */
  lastSeenAt?: string;
  /** Number of times the same logical failure has been observed. 1 for first write, increments on each upsert hit. */
  recurrenceCount?: number;

  // ── 2026-05-27 PR D.a — Rung 5 autotrigger surface ─────────────────────
  /**
   * Per-item override of the category-default remediation policy. When
   * unset, the daemon's attention-poller falls back to the policy from
   * `futurator-remediation-policies[item.category]`. When the resolved
   * policy is `manual`, the item is operator-driven only (today's
   * behavior — no agent action).
   */
  remediationPolicy?: RemediationPolicy;
  /**
   * Stamped by the daemon's attention-poller after it creates a free-
   * agent session targeting this item. Used as a double-spawn guard:
   * the poller refuses to claim items with a non-null `agentSessionId`.
   * Cleared by the operator when re-opening the item (PR D out-of-scope).
   */
  agentSessionId?: string;
  /**
   * ISO timestamp the daemon claimed this item. Pairs with `agentSessionId`
   * for forensic queries ("which items did the agent investigate today").
   */
  agentClaimedAt?: string;
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
