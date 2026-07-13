'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { usePlansList, useQuickP3Plan } from '@/hooks/use-plans';
import { useApps } from '@/hooks/use-apps';
import { useDaemonStatus } from '@/hooks/use-daemon-status';
import { api } from '@/lib/api-client';
import type { PlanSummary } from '@/types/plan';

/**
 * Labs3 launcher — the empty-state (no ?planId) surface.
 *
 * Labs3 itself is a viewer; this closes the "how do I even start a run" gap:
 *   • pick a plan (no hand-typed ?planId),
 *   • Run as Pipeline-3 (converts the legacy plan → plan_spec + ingests
 *     StoryNodes via POST /plans/:id/run-as-pipeline-3) and auto-navigates
 *     into the live graph,
 *   • a dispatch banner that says plainly when the daemon frontier is off, so
 *     an ingested-but-idle plan doesn't look like a silent hang.
 */

interface RunAsP3Result {
  ok: boolean;
  planId: string;
  stories: number;
}

// The bridge (run-as-pipeline3-route) accepts a plan that still has convertible
// epics; delivered/abandoned/archived plans have nothing to convert.
const RUNNABLE_STATUSES = new Set(['concept', 'developing', 'fixing', 'review']);

const wrap: React.CSSProperties = { padding: 40, maxWidth: 760, color: 'var(--foreground)' };
const h1: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 300,
  letterSpacing: '0.42em',
  textTransform: 'uppercase',
  margin: 0,
};

// Intent → Pipeline-3 in one step. Two modes:
//   'new'  — scaffolds a fresh app, one Claude call turns the idea into
//            StoryNodes, the frontier runs it. No epics/waves.
//   'grow' — brownfield growth: reuse an EXISTING app (targetAppId) instead of
//            scaffolding. The planner grows the delivered code and treats the
//            app's prior tests as law (payload.brownfield=true), so a growth
//            plan can't silently regress what already shipped.
type QuickMode = 'new' | 'grow';

function QuickCreate() {
  const router = useRouter();
  const quick = useQuickP3Plan();
  const { data: apps } = useApps();
  const [mode, setMode] = useState<QuickMode>('new');
  const [targetAppId, setTargetAppId] = useState('');
  const [intent, setIntent] = useState('');
  const [name, setName] = useState('');
  const [qaAutopilot, setQaAutopilot] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Grow mode can't submit until an app is chosen — there is nothing to grow
  // otherwise, and an empty targetAppId would fall back to a fresh scaffold.
  const growMissingApp = mode === 'grow' && !targetAppId;
  const disabled = quick.isPending || intent.trim().length < 3 || growMissingApp;

  const submit = () => {
    setErr(null);
    quick.mutate(
      {
        intent: intent.trim(),
        name: name.trim() || undefined,
        qaAutopilot,
        // Only threaded in grow mode — greenfield stays byte-identical.
        targetAppId: mode === 'grow' ? targetAppId : undefined,
      },
      {
        onSuccess: (r) => router.push(`/labs3/?planId=${r.planId}`),
        onError: (e) => setErr(e instanceof Error ? e.message : 'Create failed'),
      },
    );
  };

  const sortedApps = (apps ?? [])
    .slice()
    .sort((a, b) => (a.displayName ?? a.appId).localeCompare(b.displayName ?? b.appId));

  return (
    <div
      style={{
        marginTop: 22,
        padding: 16,
        borderRadius: 10,
        border: '1px solid var(--border)',
        background: 'var(--card, transparent)',
      }}
    >
      {/* Mode switch — New app (greenfield) vs Grow existing app (brownfield). */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {(['new', 'grow'] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setErr(null);
              }}
              style={{
                fontSize: 11.5,
                fontWeight: active ? 600 : 400,
                padding: '4px 11px',
                borderRadius: 6,
                border: `1px solid ${active ? 'var(--accent-blue)' : 'var(--border-2, var(--border))'}`,
                background: active
                  ? 'color-mix(in srgb, var(--accent-blue) 14%, transparent)'
                  : 'none',
                color: active ? 'var(--accent-blue)' : 'var(--text-dim)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {m === 'new' ? 'New app' : 'Grow existing app'}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 8 }}>
        {mode === 'new' ? (
          <>
            New Pipeline-3 plan from an idea — no epics/waves. Scaffolds a fresh app and generates
            the story graph directly.
          </>
        ) : (
          <>
            Grow an existing app — the planner plans against its delivered code and keeps the
            app&rsquo;s prior tests as law, so the new work can&rsquo;t regress what already
            shipped.
          </>
        )}
      </div>
      {mode === 'grow' && (
        <select
          value={targetAppId}
          onChange={(e) => setTargetAppId(e.target.value)}
          aria-label="App to grow"
          style={{
            width: '100%',
            fontSize: 12.5,
            padding: '7px 10px',
            borderRadius: 6,
            border: '1px solid var(--border-2, var(--border))',
            background: 'var(--background)',
            color: 'var(--foreground)',
            marginBottom: 8,
          }}
        >
          <option value="">Choose an app to grow…</option>
          {sortedApps.map((a) => (
            <option key={a.appId} value={a.appId}>
              {(a.displayName ?? a.appId) === a.appId ? a.appId : `${a.displayName} (${a.appId})`}
            </option>
          ))}
        </select>
      )}
      <textarea
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        placeholder="Describe an app idea… e.g. a kanban board with draggable cards and columns, or a tip calculator with a bill split, or a dino runner game — any app type works"
        rows={3}
        style={{
          width: '100%',
          resize: 'vertical',
          fontSize: 13,
          padding: '9px 11px',
          borderRadius: 8,
          border: '1px solid var(--border-2, var(--border))',
          background: 'var(--background)',
          color: 'var(--foreground)',
          fontFamily: 'inherit',
        }}
      />
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginTop: 8,
          fontSize: 12,
          color: 'var(--text-dim)',
          cursor: 'pointer',
          width: 'fit-content',
        }}
        title="When QA Review finds blocking failures, the pipeline auto-mints fix stories, re-deploys, and re-runs QA (up to 2 rounds) — you test an already-fixed build."
      >
        <input
          type="checkbox"
          checked={qaAutopilot}
          onChange={(e) => setQaAutopilot(e.target.checked)}
          style={{ accentColor: 'var(--accent-blue)' }}
        />
        QA autopilot — auto-fix &amp; re-run QA on failures before I test
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name (optional)"
          style={{
            flex: 1,
            fontSize: 12.5,
            padding: '7px 10px',
            borderRadius: 6,
            border: '1px solid var(--border-2, var(--border))',
            background: 'var(--background)',
            color: 'var(--foreground)',
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          title={growMissingApp ? 'Choose an app to grow first' : undefined}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            padding: '7px 16px',
            borderRadius: 6,
            border: '1px solid var(--accent-blue)',
            background: 'var(--accent-blue)',
            color: '#fff',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {quick.isPending
            ? 'Creating…'
            : mode === 'grow'
              ? 'Grow & Run Pipeline-3'
              : 'Create & Run Pipeline-3'}
        </button>
      </div>
      {err && (
        <div style={{ marginTop: 7, fontSize: 11.5, color: 'var(--warning, #f97316)' }}>{err}</div>
      )}
    </div>
  );
}

export function Labs3Launcher() {
  const { data: plans, isLoading, error } = usePlansList();
  const { data: daemon } = useDaemonStatus();

  // Newest first; hide archived. The bridge itself validates convertibility,
  // so we surface all live plans and let the row explain any rejection.
  const visible = (plans ?? [])
    .filter((p) => !p.archivedAt)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  const frontier = daemon?.p3ReadyFrontier;
  const dispatchOff = daemon?.alive === true && frontier != null && frontier !== 'on';

  return (
    <div style={wrap}>
      <h1 style={h1}>L A B S 3</h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 18, lineHeight: 1.6, fontSize: 13 }}>
        Pick a plan to visualize its pipeline-3 spec graph, or run one through the SDD story-dev
        path. Legacy plan authoring still lives in{' '}
        <Link href="/labs/" style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
          Labs
        </Link>
        .
      </p>

      <QuickCreate />

      {dispatchOff && (
        <div
          role="status"
          style={{
            marginTop: 16,
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid var(--warning, #f97316)',
            background: 'color-mix(in srgb, var(--warning, #f97316) 10%, transparent)',
            color: 'var(--foreground)',
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          Daemon dispatch frontier is <code>{frontier}</code>. A plan you run will ingest its
          StoryNodes but <strong>won&rsquo;t start building</strong> until{' '}
          <code>P3_READY_FRONTIER=on</code> on the daemon — otherwise the graph stays idle.
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        {isLoading && <Muted>Loading plans…</Muted>}
        {error && <Muted>Couldn&rsquo;t load plans.</Muted>}
        {!isLoading && !error && visible.length === 0 && (
          <Muted>
            No plans yet. Create one in{' '}
            <Link href="/labs/" style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
              Labs
            </Link>{' '}
            first.
          </Muted>
        )}
        {visible.map((p) => (
          <PlanRow key={p.planId} plan={p} />
        ))}
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ color: 'var(--text-mute)', fontSize: 12.5 }}>{children}</div>;
}

function PlanRow({ plan }: { plan: PlanSummary }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);

  const run = useMutation<RunAsP3Result>({
    mutationFn: () => api.post<RunAsP3Result>(`/plans/${plan.planId}/run-as-pipeline-3`, {}),
    onSuccess: (r) => router.push(`/labs3/?planId=${r.planId}`),
    onError: (e) => setErr(e instanceof Error ? e.message : 'Run failed'),
  });

  const runnable = RUNNABLE_STATUSES.has(plan.status);
  const open = () => router.push(`/labs3/?planId=${plan.planId}`);

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={open}
          style={{
            flex: 1,
            textAlign: 'left',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--foreground)',
          }}
          title="Open this plan's spec graph"
        >
          <span style={{ fontSize: 13.5 }}>{plan.displayName ?? plan.name}</span>
          <span style={{ marginLeft: 10 }}>
            <StatusPill status={plan.status} />
          </span>
          <span
            style={{
              marginLeft: 10,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-mute)',
            }}
          >
            {plan.doneStories}/{plan.totalStories} stories
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setErr(null);
            run.mutate();
          }}
          disabled={run.isPending || !runnable}
          title={
            runnable
              ? 'Convert to a plan_spec, ingest StoryNodes, and open the live graph'
              : `Plan is "${plan.status}" — nothing to convert`
          }
          style={{
            fontSize: 12,
            padding: '5px 12px',
            borderRadius: 6,
            border: '1px solid var(--border-2, var(--border))',
            background: 'none',
            color: runnable ? 'var(--accent-blue)' : 'var(--text-mute)',
            cursor: run.isPending || !runnable ? 'default' : 'pointer',
            opacity: run.isPending || !runnable ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {run.isPending ? 'Converting…' : 'Run as Pipeline-3'}
        </button>
      </div>

      {err && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--warning, #f97316)' }}>{err}</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'developing' || status === 'fixing'
      ? 'var(--accent-blue)'
      : status === 'review'
        ? 'var(--warning, #f97316)'
        : status === 'delivered'
          ? 'var(--success, #22c55e)'
          : 'var(--text-mute)';
  return (
    <span
      style={{
        fontSize: 10.5,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: '1px 6px',
      }}
    >
      {status}
    </span>
  );
}
