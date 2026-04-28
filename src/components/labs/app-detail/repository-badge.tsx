'use client';

/**
 * Story 1.5.1 — Repository badge shown in the App detail header.
 *
 * Displays: GitHub icon, futurator-repos/<appId> link, default-branch chip,
 * and the last-push timestamp (pushed_at from the GitHub repo object).
 *
 * NOTE — commit SHA + message: the `/api/github/repos/:owner/:name` endpoint
 * returns the raw GitHub repo object via getRepo(). That object includes
 * `pushed_at` (ISO timestamp) but does NOT include the latest commit SHA or
 * message. The connector's getRepoTree() exposes tree-entry SHAs (blob/tree
 * objects), not the commit SHA. A `/repos/{owner}/{name}/commits/{branch}`
 * call would be needed — but no such route exists in the current connector.
 * Deferred to Phase 2: show `pushed_at` formatted as "last push" instead.
 *
 * Hides entirely when: app.boilerplateType is unset (pre-1.4 legacy app, no
 * GitHub repo). When boilerplateType is set but bootstrappedAt is missing,
 * the badge shows with a "Scaffold pending…" pill — the GitHub repo URL is
 * valid the moment createRepoFromTemplate returns; only the daemon's
 * post-create scaffold (placeholder substitution + BMAD install + commit
 * customisation) is in-flight. Hiding the URL until daemon completes was the
 * original Story 1.5.1 design but proved confusing — operators can't see
 * the link they just created.
 */

import { GitBranch, TriangleAlert, Loader2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useGithubRepoSummary } from '@/hooks/use-github-repo-summary';
import type { App } from '@/types/app';

function formatPushedAt(iso: string | null | undefined): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

interface RepositoryBadgeProps {
  app: App;
}

export function RepositoryBadge({ app }: RepositoryBadgeProps) {
  // Guard: only show for Story 1.4+ apps that have a GitHub repo. The repo
  // URL is valid as soon as the saga's createRepoFromTemplate returns, so
  // we don't need to wait for daemon-side bootstrap to complete.
  if (!app.boilerplateType) return null;

  const scaffoldPending = !app.bootstrappedAt;
  return <RepositoryBadgeInner appId={app.appId} scaffoldPending={scaffoldPending} />;
}

function RepositoryBadgeInner({
  appId,
  scaffoldPending,
}: {
  appId: string;
  scaffoldPending: boolean;
}) {
  const { data, isLoading, error } = useGithubRepoSummary(appId);

  const githubUrl = `https://github.com/futurator-repos/${appId}`;

  // Loading state — skeleton chips
  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2"
        aria-label="Loading GitHub repository info"
        aria-busy="true"
      >
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 w-36 rounded" />
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-4 w-24 rounded" />
      </div>
    );
  }

  // 404 — repo doesn't exist yet (pre-1.4 or bootstrap still running)
  const err = error as (Error & { status?: number }) | null;
  if (err && err.status === 404) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" aria-hidden />
        <span>No repository yet</span>
      </div>
    );
  }

  // Other error — warning tooltip
  if (error && !data) {
    return (
      <div
        className="flex items-center gap-1.5 text-xs text-warning"
        title="GitHub unreachable — could not load repository metadata"
        role="alert"
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span>GitHub unreachable</span>
      </div>
    );
  }

  if (!data) return null;

  const { repo } = data;
  const pushedLabel = formatPushedAt(repo.pushed_at);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {/* Icon + linkified repo name */}
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted transition-colors"
        aria-label={`Open GitHub repository futurator-repos/${appId}`}
      >
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span>futurator-repos/{appId}</span>
      </a>

      {/* Default branch chip */}
      <span className="inline-flex items-center rounded-full bg-accent-blue/10 px-2 py-0.5 font-mono text-[11px] text-accent-blue border border-accent-blue/20">
        {repo.default_branch}
      </span>

      {/* Last push timestamp (commit SHA/message deferred — see file header) */}
      <span className="text-muted-foreground" title={repo.pushed_at ?? undefined}>
        last push: {pushedLabel}
      </span>

      {/* Scaffold-in-flight pill — daemon hasn't completed post-create steps */}
      {scaffoldPending && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] text-warning border border-warning/20"
          title="Daemon is still injecting placeholder values + installing BMAD. Refresh in a moment."
        >
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Scaffold pending
        </span>
      )}
    </div>
  );
}
