'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { PlanSpecDashboard } from '@/components/labs3/plan-spec-dashboard';

/**
 * Labs3 — the pipeline-3 / SDD visualization surface. A NEW sibling of legacy
 * Labs that reads the plan-spec-graph (StoryNode topology) instead of the
 * epic→wave plan model. Legacy Labs is untouched.
 *
 * Static-export friendly: the plan id is a query param, never a path segment.
 *   /labs3?planId=<uuid>   → the plan's spec-graph dashboard
 *   /labs3                 → guidance to pick a plan (via legacy Labs)
 */
function Labs3Content() {
  const params = useSearchParams();
  const planId = params.get('planId');

  if (planId) {
    return <PlanSpecDashboard planId={planId} />;
  }

  return (
    <div style={{ padding: 40, maxWidth: 640, color: 'var(--foreground)' }}>
      <h1
        style={{
          fontSize: 17,
          fontWeight: 300,
          letterSpacing: '0.42em',
          textTransform: 'uppercase',
          margin: 0,
        }}
      >
        L A B S 3
      </h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 18, lineHeight: 1.6, fontSize: 13 }}>
        Labs3 visualizes a plan&rsquo;s spec graph — the pipeline-3 StoryNode topology, dependency
        frontier, bound-AC test bindings, and the continuous-learning loop.
      </p>
      <p style={{ color: 'var(--text-dim)', marginTop: 10, lineHeight: 1.6, fontSize: 13 }}>
        Open a plan with{' '}
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>?planId=&lt;id&gt;</code>, or
        pick one from{' '}
        <Link href="/labs/" style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
          Labs
        </Link>
        .
      </p>
    </div>
  );
}

export default function Labs3Page() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <Labs3Content />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
