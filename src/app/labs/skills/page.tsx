'use client';
/**
 * /labs/skills — Pipeline v2 Phase 3-C Epic 7 (2026-05-20).
 *
 * Per-app skill activity dashboard. The operator sees:
 *   - boilerplate + bootstrap timestamp
 *   - recent SKILL-SCOUT job history (trigger, disposition, proposals)
 *   - top skills by activation count across recent plans
 *
 * Wired via ?appId=<slug> — the existing app detail page links here.
 * Without an appId, the page lists which apps to drill into.
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
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
    queryFn: () => api.get<AppRow[]>('/apps'),
  });
  if (isLoading) return <p style={{ fontSize: 12, color: 'var(--text-mute)' }}>Loading apps…</p>;
  if (error)
    return <p style={{ fontSize: 12, color: 'var(--warning, #f59e0b)' }}>Failed to load apps.</p>;
  return (
    <div style={{ padding: '16px 0' }}>
      <h2 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Select an app</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        {(data ?? []).map((app) => (
          <li key={app.appId}>
            <a
              href={`/labs/skills?appId=${encodeURIComponent(app.appId)}`}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--accent-blue, #3b82f6)',
                textDecoration: 'none',
              }}
            >
              {app.appId}{' '}
              <span
                style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 10 }}
              >
                ({app.boilerplateType ?? 'unknown'})
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkillsDigest({ appId }: { appId: string }) {
  const { data, isLoading, error } = useSkillsDigest(appId);
  if (isLoading) return <p style={{ fontSize: 12, color: 'var(--text-mute)' }}>Loading digest…</p>;
  if (error) {
    return (
      <p style={{ fontSize: 12, color: 'var(--warning, #f59e0b)' }}>
        Failed to load skills digest: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div style={{ padding: '16px 0', display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>
          Skills · <code style={{ fontSize: 16 }}>{appId}</code>
        </h1>
        <p style={{ fontSize: 11, color: 'var(--text-mute)', margin: '4px 0 0' }}>
          {data.boilerplateType ?? 'unknown boilerplate'} ·{' '}
          {data.bootstrappedAt
            ? `bootstrapped ${new Date(data.bootstrappedAt).toLocaleDateString()}`
            : 'not bootstrapped'}{' '}
          · {data.plansAnalyzed} recent plan(s) analyzed
        </p>
      </header>

      <section>
        <h2 style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
          Top skills used (cumulative across recent plans)
        </h2>
        {data.skillsUsedAggregate.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            No <code>skill_activated</code> events recorded yet. Plans that run after Epic 4 ships
            populate this list.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
            {data.skillsUsedAggregate.slice(0, 10).map((entry) => (
              <li
                key={`${entry.skill}@${entry.source}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  padding: '4px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span>
                  {entry.skill}
                  <span style={{ color: 'var(--text-faint)' }}>@{entry.source}</span>
                </span>
                <span style={{ color: 'var(--text-mute)' }}>{entry.activationCount}×</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Recent SKILL-SCOUT runs</h2>
        {data.recentSkillScoutJobs.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            No SKILL-SCOUT jobs yet. Bootstrap a new app or create a new plan to trigger T1/T2.
          </p>
        ) : (
          <table style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-faint)' }}>
                <th style={{ padding: '4px 8px 4px 0' }}>When</th>
                <th style={{ padding: '4px 8px' }}>Trigger</th>
                <th style={{ padding: '4px 8px' }}>Rigor</th>
                <th style={{ padding: '4px 8px' }}>Status</th>
                <th style={{ padding: '4px 8px' }}>Disposition</th>
                <th style={{ padding: '4px 0 4px 8px', textAlign: 'right' }}>Prop / Acc</th>
              </tr>
            </thead>
            <tbody>
              {data.recentSkillScoutJobs.map((job) => (
                <tr key={job.jobId} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 8px 4px 0', color: 'var(--text-mute)' }}>
                    {new Date(job.createdAt).toLocaleString()}
                  </td>
                  <td style={{ padding: '4px 8px' }}>{job.trigger ?? '—'}</td>
                  <td style={{ padding: '4px 8px' }}>{job.rigor ?? '—'}</td>
                  <td style={{ padding: '4px 8px' }}>{job.status}</td>
                  <td style={{ padding: '4px 8px' }}>{job.disposition ?? '—'}</td>
                  <td style={{ padding: '4px 0 4px 8px', textAlign: 'right' }}>
                    {job.proposalCount} / {job.acceptedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function SkillsTabs({ appId }: { appId?: string }) {
  const registryHref = appId
    ? `/labs/skills/registry?appId=${encodeURIComponent(appId)}`
    : '/labs/skills/registry';
  return (
    <nav
      style={{
        display: 'flex',
        gap: 16,
        borderBottom: '1px solid var(--border)',
        marginBottom: 16,
      }}
    >
      <span
        style={{
          fontSize: 13,
          padding: '8px 0',
          borderBottom: '2px solid var(--accent-blue, #3b82f6)',
          color: 'var(--text)',
        }}
      >
        Usage
      </span>
      <a
        href={registryHref}
        style={{
          fontSize: 13,
          padding: '8px 0',
          color: 'var(--text-mute)',
          textDecoration: 'none',
        }}
      >
        Registry
      </a>
    </nav>
  );
}

function SkillsPageContent() {
  const params = useSearchParams();
  const appId = params.get('appId') || undefined;
  return (
    <>
      <SkillsTabs appId={appId} />
      {!appId ? <SkillsAppList /> : <SkillsDigest appId={appId} />}
    </>
  );
}

export default function SkillsPage() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense
          fallback={
            <p style={{ padding: 16, fontSize: 12, color: 'var(--text-mute)' }}>Loading…</p>
          }
        >
          <SkillsPageContent />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
