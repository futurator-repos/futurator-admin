'use client';

/**
 * Story 1.5.2 — Source tab for App detail view.
 *
 * Layout: two-pane — left: collapsible GitHub tree, right: file content reader.
 * Footer chip shows rate-limit remaining / limit / reset time.
 *
 * Syntax highlighting: no highlighter library found in package.json (no prism,
 * shiki, monaco, or highlight.js). Content renders in a styled <pre> with
 * monospace font. Phase 2 can layer in a highlighter.
 *
 * Hides when app.boilerplateType or app.bootstrappedAt is unset (legacy apps).
 */

import { useState, useCallback } from 'react';
import { ExternalLink } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useGithubTree, type GithubTreeResponse } from '@/hooks/use-github-tree';
import { useGithubFile } from '@/hooks/use-github-file';
import { SourceTreeNode, buildVirtualTree } from './source-tree-node';
import type { App } from '@/types/app';
import { resolveRepoRef } from '../../../../functions/shared/github/parse-repo-url';
import type { RateLimit } from '../../../../functions/shared/github/types';

// ── Rate-limit footer ───────────────────────────────────────────────────────

function rateLimitColor(remaining: number): string {
  if (remaining > 1000) return 'text-success';
  if (remaining >= 500) return 'text-warning';
  return 'text-destructive';
}

function formatResetTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function RateLimitFooter({ rateLimit }: { rateLimit: RateLimit }) {
  const colorClass = rateLimitColor(rateLimit.remaining);
  return (
    <div
      className={`flex items-center gap-1 text-[11px] font-mono ${colorClass}`}
      title="GitHub API rate limit"
    >
      <span>
        {rateLimit.remaining.toLocaleString()} / {rateLimit.limit.toLocaleString()}
      </span>
      <span className="text-muted-foreground">— resets at {formatResetTime(rateLimit.reset)}</span>
    </div>
  );
}

// ── Breadcrumbs ─────────────────────────────────────────────────────────────

function FileBreadcrumbs({
  path,
  onNavigate,
}: {
  path: string | null;
  onNavigate: (path: string) => void;
}) {
  if (!path) {
    return <span className="text-xs text-muted-foreground italic">Select a file</span>;
  }
  const parts = path.split('/');
  return (
    <div className="flex flex-wrap items-center gap-0.5 text-xs font-mono">
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1;
        const partPath = parts.slice(0, i + 1).join('/');
        return (
          <span key={partPath} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-muted-foreground">/</span>}
            {isLast ? (
              <span className="text-foreground font-medium">{part}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(partPath)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {part}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ── File content panel ──────────────────────────────────────────────────────

function FileContentPanel({
  appId,
  githubRepoUrl,
  selectedPath,
  branch,
  onBreadcrumbNavigate,
}: {
  appId: string;
  githubRepoUrl?: string;
  selectedPath: string | null;
  branch: string | undefined;
  onBreadcrumbNavigate: (path: string) => void;
}) {
  const { data, isLoading, error } = useGithubFile(appId, selectedPath, branch, githubRepoUrl);

  const { owner, repo } = resolveRepoRef(appId, githubRepoUrl);
  const githubFileUrl = selectedPath
    ? `https://github.com/${owner}/${repo}/blob/${branch ?? 'main'}/${selectedPath}`
    : undefined;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 min-h-[32px]">
        <FileBreadcrumbs path={selectedPath} onNavigate={onBreadcrumbNavigate} />
        {githubFileUrl && (
          <a
            href={githubFileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Open in GitHub"
            title="Open in GitHub"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {/* Content area */}
      <div className="relative min-h-[200px] flex-1 rounded-md border border-border bg-card overflow-hidden">
        {!selectedPath && (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            Select a file from the tree to preview its contents.
          </div>
        )}

        {selectedPath && isLoading && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {selectedPath && error && (
          <div className="p-4 text-sm text-destructive">
            Failed to load file: {(error as Error).message}
          </div>
        )}

        {data && 'tooLarge' in data && data.tooLarge && (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm font-medium">Too large to preview</p>
            <p className="text-xs text-muted-foreground">
              File size: {(data.size / 1024 / 1024).toFixed(1)} MB — exceeds the 1 MB preview limit.
            </p>
            {githubFileUrl && (
              <a
                href={githubFileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent-blue hover:underline"
              >
                View on GitHub
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}

        {data && 'content' in data && (
          <pre className="overflow-auto p-4 font-mono text-[12px] leading-relaxed text-foreground whitespace-pre">
            {data.content}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Tree display (pure — receives pre-fetched data) ─────────────────────────

function TreeDisplay({
  treeData,
  isLoading,
  error,
  selectedPath,
  onSelect,
}: {
  treeData: GithubTreeResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-1.5 p-2" aria-busy="true" aria-label="Loading file tree">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-5 rounded" style={{ width: `${50 + (i % 5) * 10}%` }} />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="p-3 text-xs text-destructive">Failed to load tree: {error.message}</div>;
  }

  if (!treeData) return null;

  const nodes = buildVirtualTree(treeData.tree);

  if (nodes.length === 0) {
    return <div className="p-3 text-xs text-muted-foreground italic">Repository is empty.</div>;
  }

  return (
    <div role="tree" aria-label="Repository file tree">
      {treeData.truncated && (
        <div className="px-2 py-1 text-[11px] text-warning">
          Tree truncated — repository exceeds GitHub&apos;s 100k-entry / 7 MB limit.
        </div>
      )}
      {nodes.map((node) => (
        <SourceTreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// ── Main export ─────────────────────────────────────────────────────────────

interface SourceTabProps {
  app: App;
  defaultBranch?: string;
}

/**
 * SourceTabContent — the body of the "Source" tab in App detail view.
 *
 * Receives the defaultBranch from the repo summary query (pre-fetched by
 * AppDetailView) to avoid a redundant API call.
 */
export function SourceTabContent({ app, defaultBranch }: SourceTabProps) {
  // Guard: hide for legacy / in-flight greenfield apps. 2026-05-30 — brownfield
  // apps with an explicit githubRepoUrl are always sourceable (their repo
  // exists on GitHub), regardless of bootstrappedAt.
  if (!app.githubRepoUrl && (!app.boilerplateType || !app.bootstrappedAt)) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Source view is available once the app bootstrap completes.
      </div>
    );
  }

  return (
    <SourceTabInner
      appId={app.appId}
      githubRepoUrl={app.githubRepoUrl}
      defaultBranch={defaultBranch ?? app.githubBranch}
    />
  );
}

function SourceTabInner({
  appId,
  githubRepoUrl,
  defaultBranch,
}: {
  appId: string;
  githubRepoUrl?: string;
  defaultBranch: string | undefined;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Fetch the tree here so the rate limit is visible to the footer without
  // calling setState during a child's render phase.
  const {
    data: treeData,
    isLoading: treeLoading,
    error: treeError,
  } = useGithubTree(appId, defaultBranch ?? null, githubRepoUrl);

  const rateLimit = treeData?.rateLimit;

  const handleSelect = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const handleBreadcrumbNavigate = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {/* Two-pane layout */}
      <div className="flex gap-3 overflow-hidden rounded-lg border border-border bg-card">
        {/* Left: tree */}
        <div className="w-64 shrink-0 overflow-y-auto border-r border-border py-2 max-h-[60vh]">
          <TreeDisplay
            treeData={treeData}
            isLoading={treeLoading}
            error={treeError}
            selectedPath={selectedPath}
            onSelect={handleSelect}
          />
        </div>

        {/* Right: file content */}
        <div className="flex min-w-0 flex-1 flex-col p-3 max-h-[60vh] overflow-auto">
          <FileContentPanel
            appId={appId}
            githubRepoUrl={githubRepoUrl}
            selectedPath={selectedPath}
            branch={defaultBranch}
            onBreadcrumbNavigate={handleBreadcrumbNavigate}
          />
        </div>
      </div>

      {/* Footer — rate limit chip */}
      <div className="flex items-center justify-end px-1">
        {rateLimit ? (
          <RateLimitFooter rateLimit={rateLimit} />
        ) : (
          <span className="text-[11px] text-muted-foreground">Rate limit: —</span>
        )}
      </div>
    </div>
  );
}
