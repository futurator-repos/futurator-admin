'use client';
/**
 * Debates — portfolio view of every Party Mode session across every App.
 *
 * Route shape (static-export-safe — query params only):
 *   /debates                 → list of every debate, grouped by App
 *   /debates?sessionId=<id>  → full-screen chat for that debate (shareable
 *                              URL; the canonical "permalink" for a debate)
 *
 * The full-screen chat is what gets shared / opened on phone / linked from
 * tickets. It renders the same `<SessionChatV2>` component used inside the
 * App-detail Party tab, so feature parity is automatic.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { ArrowLeft, Loader2, MessageSquare, MessagesSquare, Plus } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Button } from '@/components/ui/button';
import { useAllPartySessions } from '@/hooks/use-party-sessions';
import { useApps } from '@/hooks/use-apps';
import { useSession } from '@/hooks/use-party-session';
import { SessionChatV2 } from '@/components/labs/party/v2/session-chat-v2';
import { NewDebateDialog } from '@/components/debates/new-debate-dialog';
import { useUIStore } from '@/stores/ui-store';
import type { PartySession, PartySessionStatus } from '@/types/party';

const STATUS_TONE: Record<PartySessionStatus, string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  PROCESSING: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  IDLE: 'bg-slate-500/15 text-slate-300 border-slate-400/30',
  ERROR: 'bg-red-500/15 text-red-300 border-red-400/30',
  ARCHIVED: 'bg-zinc-500/15 text-zinc-400 border-zinc-400/30',
};

interface AppGroup {
  appId: string;
  displayName: string;
  icon?: string;
  sessions: PartySession[];
  lastActivity: string;
}

function DebateChatView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { data: session, isLoading, error } = useSession(sessionId);
  const setHeaderBreadcrumbs = useUIStore((s) => s.setHeaderBreadcrumbs);

  // Publish the breadcrumb (Debates / <project> / <topic>) into the global
  // top header so the debate chat doesn't waste a second toolbar row.
  useEffect(() => {
    if (!session) {
      setHeaderBreadcrumbs([{ label: 'Debates', href: '/debates' }]);
      return () => setHeaderBreadcrumbs(null);
    }
    setHeaderBreadcrumbs([
      { label: 'Debates', href: '/debates' },
      {
        label: session.projectId,
        href: `/labs?appId=${encodeURIComponent(session.projectId)}`,
      },
      { label: session.topic || 'Untitled debate' },
    ]);
    return () => setHeaderBreadcrumbs(null);
  }, [session, setHeaderBreadcrumbs]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading debate…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/debates')}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to debates
        </Button>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load debate: {(error as Error).message}
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/debates')}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to debates
        </Button>
        <div className="rounded-lg border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
          Debate not found.
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-104px)] min-h-0 overflow-hidden rounded-md border border-border bg-card">
      <SessionChatV2
        sessionId={sessionId}
        onClose={() => router.push('/debates')}
        onPickSession={(id) => router.push(`/debates?sessionId=${encodeURIComponent(id)}`)}
        onNewSession={() =>
          router.push(`/labs?appId=${encodeURIComponent(session.projectId)}&tab=party`)
        }
      />
    </div>
  );
}

function DebatesListView() {
  const router = useRouter();
  const { data, isLoading, error } = useAllPartySessions();
  const { data: apps } = useApps();
  const [isNewDebateOpen, setIsNewDebateOpen] = useState(false);

  const groups: AppGroup[] = useMemo(() => {
    const sessions = data?.sessions ?? [];
    const byApp = new Map<string, PartySession[]>();
    for (const s of sessions) {
      const arr = byApp.get(s.projectId) ?? [];
      arr.push(s);
      byApp.set(s.projectId, arr);
    }
    const appLookup = new Map((apps ?? []).map((a) => [a.appId, a]));
    const out: AppGroup[] = [];
    for (const [appId, list] of byApp) {
      list.sort((a, b) => {
        const aT = a.lastTurnAt ?? a.createdAt;
        const bT = b.lastTurnAt ?? b.createdAt;
        return bT.localeCompare(aT);
      });
      const app = appLookup.get(appId);
      out.push({
        appId,
        displayName: app?.displayName ?? appId,
        icon: app?.icon,
        sessions: list,
        lastActivity: list[0]?.lastTurnAt ?? list[0]?.createdAt ?? '',
      });
    }
    out.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return out;
  }, [data, apps]);

  function openDebate(sessionId: string) {
    router.push(`/debates?sessionId=${encodeURIComponent(sessionId)}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-page-title flex items-center gap-2">
            <MessagesSquare className="h-6 w-6 text-accent-purple" />
            Debates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every Party Mode session across every App. Each debate has its own URL — share it,
            bookmark it, open it on your phone.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[11px] font-mono text-muted-foreground">
            {data?.sessions.length ?? 0} session{(data?.sessions.length ?? 0) === 1 ? '' : 's'} ·{' '}
            {groups.length} app{groups.length === 1 ? '' : 's'}
          </div>
          <Button
            size="sm"
            onClick={() => setIsNewDebateOpen(true)}
            data-testid="new-debate-button"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            New debate
          </Button>
        </div>
      </div>

      <NewDebateDialog open={isNewDebateOpen} onOpenChange={setIsNewDebateOpen} />

      {isLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading debates…
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load debates: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && groups.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card/40 p-8 text-center">
          <MessageSquare className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          <h2 className="text-sm font-medium">No debates yet</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Start one with the <strong>+ New debate</strong> button above, or open an App and click
            the <strong>Party</strong> tab — either way it shows up here.
          </p>
          <Button
            size="sm"
            className="mt-4"
            onClick={() => setIsNewDebateOpen(true)}
            data-testid="new-debate-button-empty"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            New debate
          </Button>
        </div>
      )}

      <div className="space-y-6">
        {groups.map((g) => (
          <section
            key={g.appId}
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-base" aria-hidden>
                  {g.icon || '📦'}
                </span>
                <button
                  type="button"
                  onClick={() => router.push(`/labs?appId=${encodeURIComponent(g.appId)}`)}
                  className="truncate text-sm font-semibold hover:underline"
                  title="Open App detail"
                >
                  {g.displayName}
                </button>
                <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                  {g.appId}
                </span>
              </div>
              <div className="shrink-0 text-[10.5px] text-muted-foreground">
                {g.sessions.length} debate{g.sessions.length === 1 ? '' : 's'} · last{' '}
                {g.lastActivity ? formatDistanceToNow(new Date(g.lastActivity)) + ' ago' : '—'}
              </div>
            </header>
            <ul className="divide-y divide-border/60">
              {g.sessions.map((s) => {
                const tone = STATUS_TONE[s.status] ?? STATUS_TONE.IDLE;
                const when = s.lastTurnAt ?? s.createdAt;
                return (
                  <li key={s.sessionId}>
                    <button
                      type="button"
                      onClick={() => openDebate(s.sessionId)}
                      className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/20"
                    >
                      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground/70 group-hover:text-accent-purple" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">
                          {s.topic || `Untitled session`}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
                          <span className="font-mono">
                            {s.turnCount} round{s.turnCount === 1 ? '' : 's'}
                          </span>
                          <span>·</span>
                          <span>{formatDistanceToNow(new Date(when))} ago</span>
                          <span className="font-mono opacity-60">{s.sessionId.slice(0, 8)}</span>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wider ${tone}`}
                      >
                        {s.status}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function DebatesContent() {
  const params = useSearchParams();
  const sessionId = params.get('sessionId');
  if (sessionId) return <DebateChatView sessionId={sessionId} />;
  return <DebatesListView />;
}

export default function DebatesPage() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <DebatesContent />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
