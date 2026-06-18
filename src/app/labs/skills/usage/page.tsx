'use client';
/**
 * /labs/skills/usage — per-app skill activity dashboard (Skills FE refactor,
 * 2026-06-16; formerly the /labs/skills index).
 *
 * The operator sees, for one app (?appId=<slug>):
 *   - boilerplate + bootstrap timestamp
 *   - recent SKILL-SCOUT job history (trigger, disposition, proposals)
 *   - top skills by activation count across recent plans
 *
 * Without an appId, lists which apps to drill into. AuthGuard / AppShell /
 * tab bar / Suspense are provided by the shared layout.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkillsDigest } from '@/hooks/use-skills-digest';

interface AppRow {
  appId: string;
  displayName?: string;
  boilerplateType?: string;
  bootstrappedAt?: string;
}

function SkillsAppList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['apps', 'for-skills-page'],
    // /api/apps returns { apps: [...] } — unwrap to the array (matching
    // use-apps.ts). Treating the envelope as a bare array crashed the page:
    // `(data ?? []).map is not a function` (2026-06-16).
    queryFn: () => api.get<{ apps: AppRow[] }>('/apps').then((r) => r.apps),
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error) return <p className="text-sm text-warning">Failed to load apps.</p>;
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium">Select an app</h2>
      <ul className="grid gap-1.5">
        {(data ?? []).map((app) => (
          <li key={app.appId}>
            <Link
              href={`/labs/skills/usage?appId=${encodeURIComponent(app.appId)}`}
              className="font-mono text-xs text-accent-blue hover:underline"
            >
              {app.appId}{' '}
              <span className="text-muted-foreground">({app.boilerplateType ?? 'unknown'})</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkillsDigest({ appId }: { appId: string }) {
  const { data, isLoading, error } = useSkillsDigest(appId);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) {
    return (
      <p className="text-sm text-warning">
        Failed to load skills digest: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-page-title">
          Skills · <code className="font-mono">{appId}</code>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {data.boilerplateType ?? 'unknown boilerplate'} ·{' '}
          {data.bootstrappedAt
            ? `bootstrapped ${new Date(data.bootstrappedAt).toLocaleDateString()}`
            : 'not bootstrapped'}{' '}
          · {data.plansAnalyzed} recent plan(s) analyzed
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Top skills used (cumulative across recent plans)</h2>
        {data.skillsUsedAggregate.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No <code>skill_activated</code> events recorded yet. Plans that run after Epic 4 ships
            populate this list.
          </p>
        ) : (
          <ul className="grid gap-1">
            {data.skillsUsedAggregate.slice(0, 10).map((entry) => (
              <li
                key={`${entry.skill}@${entry.source}`}
                className="grid grid-cols-[1fr_auto] border-b border-border py-1 font-mono text-xs"
              >
                <span>
                  {entry.skill}
                  <span className="text-muted-foreground">@{entry.source}</span>
                </span>
                <span className="text-muted-foreground">{entry.activationCount}×</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Recent SKILL-SCOUT runs</h2>
        {data.recentSkillScoutJobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No SKILL-SCOUT jobs yet. Bootstrap a new app or create a new plan to trigger T1/T2.
          </p>
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Rigor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Disposition</TableHead>
                  <TableHead className="text-right">Prop / Acc</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentSkillScoutJobs.map((job) => (
                  <TableRow key={job.jobId}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{job.trigger ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{job.rigor ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{job.status}</TableCell>
                    <TableCell className="font-mono text-xs">{job.disposition ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {job.proposalCount} / {job.acceptedCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function SkillsUsagePage() {
  const params = useSearchParams();
  const appId = params.get('appId') || undefined;
  return !appId ? <SkillsAppList /> : <SkillsDigest appId={appId} />;
}
