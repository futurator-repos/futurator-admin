'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  FreeAgentMessageThread,
  type FreeAgentMessage,
} from '@/components/free-agent/message-thread';
import { HaltedBadge } from './halted-badge';
import {
  ACTIVE_STATUSES,
  type UltracodeRun,
  type UltracodeRunStatus,
  type UltracodeSideStatus,
} from '@/types/ultracode-run';

/** Live-ticking mm:ss since `from`. */
function Elapsed({ from }: { from?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!from) return null;
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return (
    <span className="tabular-nums">
      {mm}:{String(ss).padStart(2, '0')}
    </span>
  );
}

/** Overall run-status line so the operator always knows what's happening. */
function RunStatusBanner({ run }: { run?: UltracodeRun }) {
  const base = 'flex items-center gap-2 rounded-md border px-3 py-2 text-sm';

  if (!run) {
    return (
      <div className={`${base} border-border bg-muted/30 text-muted-foreground`}>
        <Clock className="h-4 w-4 shrink-0" />
        <span>Submit an intent and press “Run bench” — both engines run on the daemon.</span>
      </div>
    );
  }

  switch (run.status) {
    case 'QUEUED':
      return (
        <div className={`${base} border-border bg-muted/40`}>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span>
            Queued — waiting for the daemon to pick up the job… <Elapsed from={run.createdAt} />
          </span>
        </div>
      );
    case 'CAPTURING':
      return (
        <div className={`${base} border-accent-blue/40 bg-accent-blue/10`}>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span>
            Capturing — running both engines on the daemon (can take a few minutes).{' '}
            <Elapsed from={run.createdAt} /> elapsed
          </span>
        </div>
      );
    case 'SCORING':
      return (
        <div className={`${base} border-accent-blue/40 bg-accent-blue/10`}>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span>
            Scoring the two plans… <Elapsed from={run.createdAt} />
          </span>
        </div>
      );
    case 'COMPLETE':
      return (
        <div className={`${base} border-success/40 bg-success/10`}>
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          <span>
            Complete{run.verdict ? ` — ${run.verdict}` : ''}
            {run.structuralScore != null ? ` · struct ${run.structuralScore.toFixed(2)}` : ''}
            {run.taintedReps ? ` · ${run.taintedReps} rep(s) tainted` : ''}
          </span>
        </div>
      );
    case 'ERROR':
      return (
        <div className={`${base} border-destructive/40 bg-destructive/10`}>
          <XCircle className="h-4 w-4 shrink-0 text-destructive" />
          <span>Failed — {run.errorMessage || 'see daemon logs'}</span>
        </div>
      );
    default:
      return null;
  }
}

interface SidePanelProps {
  title: string;
  subtitle: string;
  status: UltracodeSideStatus;
  messages: FreeAgentMessage[];
  runStatus?: UltracodeRunStatus;
}

function SidePanel({ title, subtitle, status, messages, runStatus }: SidePanelProps) {
  const runActive = !!runStatus && ACTIVE_STATUSES.has(runStatus);

  let empty: React.ReactNode = null;
  if (messages.length === 0) {
    if (status === 'RUNNING') {
      empty = (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-accent-blue" />
          <p className="text-sm font-medium">Running — capturing the plan…</p>
          <p className="text-xs text-muted-foreground">
            This engine doesn’t stream a live transcript; the captured plan appears here the moment
            it halts.
          </p>
        </div>
      );
    } else if (status === 'ERROR') {
      empty = (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <XCircle className="h-6 w-6 text-destructive" />
          <p className="text-sm">This engine errored — see the status line above.</p>
        </div>
      );
    } else if (status === 'PENDING' && runActive) {
      empty = (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <p className="text-sm">Waiting to start…</p>
        </div>
      );
    } else if (status === 'PENDING') {
      empty = (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Awaiting a run — press “Run bench”.
        </div>
      );
    } else {
      empty = (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Plan captured — no streamed transcript for this engine.
        </div>
      );
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <HaltedBadge status={status} />
      </CardHeader>
      <CardContent className="flex-1 p-0">
        <div className="h-[420px] overflow-hidden">
          {empty ?? (
            <FreeAgentMessageThread messages={messages} isProcessing={status === 'RUNNING'} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface DualLiveViewProps {
  run?: UltracodeRun;
  case1Status: UltracodeSideStatus;
  case2Status: UltracodeSideStatus;
  case1Messages: FreeAgentMessage[];
  case2Messages: FreeAgentMessage[];
}

export function DualLiveView({
  run,
  case1Status,
  case2Status,
  case1Messages,
  case2Messages,
}: DualLiveViewProps) {
  return (
    <div className="space-y-3">
      <RunStatusBanner run={run} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SidePanel
          title="Case 1 — ultracode (native, captured)"
          subtitle="claude · Opus 4.8 · max — halted on plan produced"
          status={case1Status}
          messages={case1Messages}
          runStatus={run?.status}
        />
        <SidePanel
          title="Case 2 — Futurator meta-prompt"
          subtitle="claude · Opus 4.8 · max — same frame, our prompt"
          status={case2Status}
          messages={case2Messages}
          runStatus={run?.status}
        />
      </div>
    </div>
  );
}
