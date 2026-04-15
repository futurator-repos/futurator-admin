'use client';
import Link from 'next/link';
import { usePublishedApps, type AppEntry } from '@/hooks/use-epic-workflow';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { format } from 'date-fns';

const STATUS_CONFIG: Record<AppEntry['appStatus'], { label: string; color: string }> = {
  conceptualized: { label: 'Conceptualized', color: 'bg-gray-500/20 text-gray-400' },
  in_development: { label: 'In Development', color: 'bg-yellow-500/20 text-yellow-400' },
  deployed: { label: 'Deployed', color: 'bg-green-500/20 text-green-400' },
};

function StatusBadge({ status }: { status: AppEntry['appStatus'] }) {
  const { label, color } = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}
    >
      {label}
    </span>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-muted">
        <div
          className="h-1.5 rounded-full bg-green-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        {done}/{total}
      </span>
    </div>
  );
}

export function AppsTable() {
  const { data: apps, isLoading, error } = usePublishedApps();

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading apps...</div>;
  }

  if (error) {
    return (
      <div className="p-8 text-sm text-red-400">
        Failed to load apps: {(error as Error).message}
      </div>
    );
  }

  if (!apps || apps.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">No apps yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Create an epic from the Labs Agentic Workflow to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>App</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Stories</TableHead>
            <TableHead>Directory</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">URL</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.map((app) => (
            <TableRow key={app.epicId}>
              <TableCell>
                <div>
                  <div className="font-medium">{app.title}</div>
                  <div className="text-xs text-muted-foreground font-mono">{app.appName}</div>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge status={app.appStatus} />
              </TableCell>
              <TableCell>
                <ProgressBar done={app.doneStories} total={app.totalStories} />
              </TableCell>
              <TableCell>
                <Link
                  href={`/development/files?path=${encodeURIComponent(app.workingDir)}`}
                  className="text-xs font-mono text-blue-400 hover:text-blue-300 hover:underline"
                >
                  {app.workingDir}
                </Link>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {app.createdAt ? format(new Date(app.createdAt), 'MMM d, yyyy') : '—'}
              </TableCell>
              <TableCell className="text-right">
                {app.url ? (
                  <a
                    href={app.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {app.url.replace('https://', '')}
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
