'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  UploadCloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMigrations, useUpdateMigration } from '@/hooks/use-migrations';
import { useRefreshProjectMutation } from '@/hooks/use-party-projects';
import { ProjectStatusBadge } from '@/components/labs/party/project-status-badge';
import { DeleteMigrationModal } from './delete-migration-modal';
import { PushEnabledModal } from './push-enabled-modal';
import type { Migration } from '@/types/migration';

function truncateMiddle(s: string, max = 50): string {
  if (s.length <= max) return s;
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

/**
 * Cross-project list of brownfield migrations. Each card shows the
 * project state, the upstream URL + branch, when it was last pulled,
 * env-var key count, and Refresh / Delete actions. The Refresh action
 * reuses `useRefreshProjectMutation` (same one the Labs Party card
 * uses); Delete calls the new `useDeleteMigration`.
 */
export function MigrationsList({ highlight }: { highlight?: string | null }) {
  const { data, isLoading, error } = useMigrations();
  const refresh = useRefreshProjectMutation();
  const [pendingDelete, setPendingDelete] = useState<Migration | null>(null);
  // Story 21.3 — push toggle modal. `intent` is whichever direction the
  // operator just clicked; the modal renders different copy + form fields
  // for enable vs disable.
  const [pendingPush, setPendingPush] = useState<{
    migration: Migration;
    intent: 'enable' | 'disable';
  } | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading migrations…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load migrations: {(error as Error).message}
      </div>
    );
  }
  const migrations = data?.migrations ?? [];
  if (migrations.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
        No migrations yet. Click <strong>+ New migration</strong> to bring an existing private
        GitHub repo into Futurator.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {migrations.map((m) => (
        <MigrationCard
          key={m.projectId}
          migration={m}
          isHighlighted={highlight === m.projectId}
          onRefresh={() => refresh.mutate(m.projectId)}
          refreshing={refresh.isPending && refresh.variables === m.projectId}
          onRequestDelete={() => setPendingDelete(m)}
          onRequestPushToggle={(intent) => setPendingPush({ migration: m, intent })}
        />
      ))}
      <DeleteMigrationModal
        migration={pendingDelete}
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
      />
      <PushEnabledModal
        migration={pendingPush?.migration ?? null}
        intent={pendingPush?.intent ?? 'enable'}
        open={pendingPush !== null}
        onOpenChange={(o) => {
          if (!o) setPendingPush(null);
        }}
      />
    </div>
  );
}

interface CardProps {
  migration: Migration;
  isHighlighted: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  onRequestDelete: () => void;
  onRequestPushToggle: (intent: 'enable' | 'disable') => void;
}

function MigrationCard(p: CardProps) {
  const m = p.migration;
  const isRefreshing = p.refreshing || m.bmadStatus === 'REFRESHING';
  const isBusy = isRefreshing || m.bmadStatus === 'INSTALLING';
  const pulled = m.lastPulledAt ? new Date(m.lastPulledAt) : null;
  // Auto-PR toggle — no PAT needed (push must already be on), so it flips
  // directly via PATCH rather than going through the push-enable modal.
  const updateAutoPr = useUpdateMigration();
  const toggleAutoPr = () =>
    updateAutoPr.mutate({ projectId: m.projectId, autoOpenPr: !m.autoOpenPr });
  // Auto-merge toggle — "publish = finish". No PAT needed; only effective
  // when push + Auto-PR are both on (daemon gates on all three).
  const updateAutoMerge = useUpdateMigration();
  const toggleAutoMerge = () =>
    updateAutoMerge.mutate({ projectId: m.projectId, autoMerge: !m.autoMerge });
  return (
    <div
      className={`rounded-md border bg-card p-4 ${
        p.isHighlighted ? 'border-accent-purple ring-1 ring-accent-purple/40' : 'border-border'
      }`}
      data-testid={`migration-card-${m.projectId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base" aria-hidden>
              {m.icon}
            </span>
            <span className="truncate text-sm font-semibold">{m.displayName}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{m.projectId}</span>
            <ProjectStatusBadge status={m.bmadStatus} />
          </div>
          {m.gitRepoUrl && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono" title={m.gitRepoUrl}>
                {truncateMiddle(m.gitRepoUrl)}
              </span>
              <span className="ml-1 inline-flex items-center rounded-full border border-border bg-muted/40 px-1.5 font-mono">
                {m.gitBranch || 'main'}
              </span>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[10.5px] text-muted-foreground">
            {pulled && <span>pulled {formatDistanceToNow(pulled)} ago</span>}
            <span>
              {m.envVarCount} env var{m.envVarCount === 1 ? '' : 's'}
            </span>
            <span>
              {m.sessionCount} debate{m.sessionCount === 1 ? '' : 's'}
            </span>
            {m.lastCommitSha && (
              <span className="font-mono opacity-70">{m.lastCommitSha.slice(0, 7)}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant={m.pushEnabled ? 'default' : 'outline'}
            className={`h-7 text-[11px] ${
              m.pushEnabled
                ? 'bg-success/20 text-success-foreground hover:bg-success/30'
                : 'text-muted-foreground'
            }`}
            disabled={isBusy}
            onClick={() => p.onRequestPushToggle(m.pushEnabled ? 'disable' : 'enable')}
            data-testid={`migration-push-toggle-${m.projectId}`}
            title={
              m.pushEnabled
                ? 'Push is enabled — party-checkpoint pushes to GitHub. Click to disable.'
                : 'Push is disabled — checkpoints commit locally only. Click to enable (requires contents:write PAT).'
            }
          >
            {m.pushEnabled ? (
              <UploadCloud className="mr-1 h-3 w-3" />
            ) : (
              <Upload className="mr-1 h-3 w-3 opacity-50" />
            )}
            Push: {m.pushEnabled ? 'on' : 'off'}
          </Button>
          {/* Auto-PR opt-in — only meaningful once push is enabled. */}
          {m.pushEnabled && (
            <Button
              size="sm"
              variant={m.autoOpenPr ? 'default' : 'outline'}
              className={`h-7 text-[11px] ${
                m.autoOpenPr
                  ? 'bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30'
                  : 'text-muted-foreground'
              }`}
              disabled={isBusy || updateAutoPr.isPending}
              onClick={toggleAutoPr}
              data-testid={`migration-autopr-toggle-${m.projectId}`}
              title={
                m.autoOpenPr
                  ? 'Auto-PR is on — a draft PR opens automatically after each checkpoint push. Click to disable.'
                  : 'Auto-PR is off — open PRs manually from the checkpoint card. Click to auto-open a draft PR on each push.'
              }
            >
              {updateAutoPr.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <GitPullRequest className="mr-1 h-3 w-3" />
              )}
              Auto-PR: {m.autoOpenPr ? 'on' : 'off'}
            </Button>
          )}
          {/* Auto-merge opt-in — "publish = finish". Only meaningful once
              push + Auto-PR are on (the daemon requires all three). */}
          {m.pushEnabled && m.autoOpenPr && (
            <Button
              size="sm"
              variant={m.autoMerge ? 'default' : 'outline'}
              className={`h-7 text-[11px] ${
                m.autoMerge
                  ? 'bg-teal-500/20 text-teal-600 hover:bg-teal-500/30 dark:text-teal-300'
                  : 'text-muted-foreground'
              }`}
              disabled={isBusy || updateAutoMerge.isPending}
              onClick={toggleAutoMerge}
              data-testid={`migration-automerge-toggle-${m.projectId}`}
              title={
                m.autoMerge
                  ? 'Auto-merge is on — after each checkpoint the debate is merged to main, its worktree deleted, and it is marked Done. Click to disable.'
                  : 'Auto-merge is off — PRs are opened but not merged. Click to auto-merge each checkpoint to main, delete the worktree, and mark the debate Done (publish = finish).'
              }
            >
              {updateAutoMerge.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <GitMerge className="mr-1 h-3 w-3" />
              )}
              Auto-merge: {m.autoMerge ? 'on' : 'off'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={isBusy}
            onClick={p.onRefresh}
            data-testid={`migration-refresh-${m.projectId}`}
          >
            <RefreshCw className={`mr-1 h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] text-red-400 hover:bg-red-500/10"
            onClick={p.onRequestDelete}
            disabled={isBusy}
            data-testid={`migration-delete-${m.projectId}`}
            title="Open delete confirmation dialog"
          >
            <Trash2 className="mr-1 h-3 w-3" />
            Delete…
          </Button>
        </div>
      </div>
      {m.envVarKeys.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 border-t border-border/60 pt-2">
          {m.envVarKeys.map((k) => (
            <span
              key={k}
              className="inline-flex items-center rounded-full border border-border bg-muted/30 px-1.5 font-mono text-[10px] text-muted-foreground"
            >
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
