'use client';
/**
 * reflection-inbox.tsx — Pipeline v2 Phase 3 / Story 3-E-3-1 (PR-76).
 *
 * Operator-facing UI for REFLECTOR proposals. Mirrors the attention-dock
 * filter-chip + sorted-list pattern from Phase 1, but the action set is
 * Confirm / Decline / Defer (v2.5 §49) rather than Resolve / Reopen.
 *
 * Scope deliberately tight in PR-76:
 *   - List view with filter chips (status + target)
 *   - Expand row to show rationale + evidence + content (no diff renderer
 *     yet — the dedicated `unified-diff.tsx` lands in a 3-E-3 follow-on)
 *   - Three actions with optimistic UI
 *   - Pre-flight + REVIEWER verdict chips (3-E-9, 3-E-10 surface ready)
 *
 * Follow-ons in 3-E-3:
 *   - Unified-diff renderer (`unified-diff.tsx`) for richer review
 *   - Global-bell sparkle icon with pending-count badge
 *   - REFLECTOR-APPLY commit integration on Confirm (daemon-side)
 */

import { useMemo, useState } from 'react';
import { useReflections, useReflectionDecision } from '@/hooks/use-reflections';
import type {
  ReflectionItem,
  ReflectionStatus,
  ReflectionTarget,
  ReflectionDecision,
} from '../../../../functions/shared/types/reflection';

type StatusChip = ReflectionStatus | 'all';
type TargetChip = ReflectionTarget | 'all';

const STATUS_CHIPS: { key: StatusChip; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'all', label: 'All' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'declined', label: 'Declined' },
  { key: 'deferred', label: 'Deferred' },
];

const TARGET_CHIPS: { key: TargetChip; label: string }[] = [
  { key: 'all', label: 'All targets' },
  { key: 'project-claude-md', label: 'CLAUDE.md' },
  { key: 'project-skill', label: 'Project skills' },
  { key: 'story.vqa.fix', label: 'VQA fixes' },
  { key: 'org-skill', label: 'Org skills' },
  { key: 'agent-persona', label: 'Personas' },
  { key: 'pipeline-config', label: 'Pipeline tuning' },
  { key: 'tool-wrapper', label: 'Tool wrappers' },
];

const TARGET_COLOR: Record<ReflectionTarget, string> = {
  'project-claude-md': 'var(--accent-blue, #3b82f6)',
  'project-skill': 'var(--success, #10b981)',
  'story.vqa.fix': 'var(--accent-blue, #3b82f6)',
  'org-skill': 'var(--warning, #f59e0b)',
  'agent-persona': 'var(--destructive, #ef4444)',
  'pipeline-config': 'var(--muted-foreground, #6b7280)',
  'tool-wrapper': 'var(--accent-blue, #3b82f6)',
};

export function ReflectionInbox({ projectSlug }: { projectSlug?: string }) {
  const [statusChip, setStatusChip] = useState<StatusChip>('pending');
  const [targetChip, setTargetChip] = useState<TargetChip>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, ReflectionStatus>>({});

  const { data, isLoading } = useReflections({
    projectSlug,
    status: statusChip === 'all' ? undefined : statusChip,
  });
  const decision = useReflectionDecision();

  const filtered = useMemo(() => {
    const items = data?.items || [];
    return items.filter((it) => targetChip === 'all' || it.target === targetChip);
  }, [data?.items, targetChip]);

  const pendingCount = data?.pendingCount ?? 0;

  function handleDecision(item: ReflectionItem, action: ReflectionDecision) {
    const nextStatus: ReflectionStatus =
      action === 'confirm' ? 'confirmed' : action === 'decline' ? 'declined' : 'deferred';
    setOptimistic((m) => ({ ...m, [item.id]: nextStatus }));
    decision.mutate({ projectSlug: item.projectSlug, id: item.id, decision: action });
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Reflection Inbox</h1>
          <p className="text-sm text-muted-foreground">
            {pendingCount} pending REFLECTOR proposal{pendingCount === 1 ? '' : 's'}
            {projectSlug ? ` for ${projectSlug}` : ' across all projects'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.key}
            onClick={() => setStatusChip(chip.key)}
            className={`px-3 py-1 rounded-full text-sm border ${
              statusChip === chip.key
                ? 'bg-foreground text-background border-foreground'
                : 'bg-background text-foreground border-border hover:bg-muted'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {TARGET_CHIPS.map((chip) => (
          <button
            key={chip.key}
            onClick={() => setTargetChip(chip.key)}
            className={`px-3 py-1 rounded-full text-xs border ${
              targetChip === chip.key
                ? 'bg-muted text-foreground border-border'
                : 'bg-background text-muted-foreground border-border hover:bg-muted'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground italic">
          No reflections match the current filters.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {filtered.map((item) => {
          const isExpanded = expandedId === item.id;
          const effectiveStatus = optimistic[item.id] ?? item.status;
          const isResolving = effectiveStatus !== item.status;
          return (
            <li
              key={item.id}
              className="rounded-lg border border-border bg-card"
              style={{ borderLeftWidth: 4, borderLeftColor: TARGET_COLOR[item.target] }}
            >
              <button
                type="button"
                className="flex w-full flex-col items-start gap-1 p-3 text-left hover:bg-muted/40"
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.projectSlug} · {item.planId}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {labelForTarget(item.target)} · {item.action}
                    {item.skillName ? ` · ${item.skillName}` : ''}
                    {item.section ? ` · ${item.section}` : ''}
                  </span>
                  <span className="flex items-center gap-2">
                    {item.flaggedForManualReview && (
                      <span
                        className="rounded-full px-2 py-0.5 text-xs text-white"
                        style={{ background: 'var(--destructive, #ef4444)' }}
                      >
                        ⚠ flagged
                      </span>
                    )}
                    {item.reviewerVerdict && (
                      <span
                        className="rounded-full px-2 py-0.5 text-xs"
                        style={{
                          background:
                            item.reviewerVerdict === 'pass'
                              ? 'var(--success, #10b981)'
                              : 'var(--destructive, #ef4444)',
                          color: 'white',
                        }}
                      >
                        REVIEWER: {item.reviewerVerdict}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      conf {item.confidence.toFixed(2)}
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-xs"
                      style={{
                        background: statusBackground(effectiveStatus),
                        color: 'white',
                      }}
                    >
                      {effectiveStatus}
                    </span>
                  </span>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-border p-3">
                  <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                    Rationale
                  </h3>
                  <p className="mt-1 text-sm">{item.rationale}</p>

                  <h3 className="mt-3 text-xs font-semibold uppercase text-muted-foreground">
                    Proposed content
                  </h3>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                    {item.content}
                  </pre>

                  {item.evidence.length > 0 && (
                    <>
                      <h3 className="mt-3 text-xs font-semibold uppercase text-muted-foreground">
                        Evidence
                      </h3>
                      <ul className="mt-1 list-disc pl-5 text-xs">
                        {item.evidence.map((e) => (
                          <li key={e} className="font-mono">
                            {e}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {item.flaggedForManualReview && item.flaggedReason && (
                    <p className="mt-2 text-xs italic text-destructive">
                      Manual review required: {item.flaggedReason}
                    </p>
                  )}

                  {effectiveStatus === 'pending' && (
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        disabled={isResolving}
                        onClick={() => handleDecision(item, 'confirm')}
                        className="rounded-md bg-foreground px-3 py-1 text-sm text-background hover:opacity-90 disabled:opacity-50"
                      >
                        {isResolving ? '…' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        disabled={isResolving}
                        onClick={() => handleDecision(item, 'decline')}
                        className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        disabled={isResolving}
                        onClick={() => handleDecision(item, 'defer')}
                        className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
                      >
                        Defer
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function labelForTarget(target: ReflectionTarget): string {
  return TARGET_CHIPS.find((c) => c.key === target)?.label ?? target;
}

function statusBackground(status: ReflectionStatus): string {
  switch (status) {
    case 'pending':
      return 'var(--accent-blue, #3b82f6)';
    case 'confirmed':
      return 'var(--success, #10b981)';
    case 'declined':
      return 'var(--muted-foreground, #6b7280)';
    case 'deferred':
      return 'var(--warning, #f59e0b)';
  }
}
