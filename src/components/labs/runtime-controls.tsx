'use client';
/**
 * Runtime controls — two visually-grouped containers for the top-right of
 * Labs screens. Daemon actions on the left, Claude Code auth on the right.
 *
 * Replaces the single-row `<Ec2Toggle>` + `<DaemonStatus>` in LabsHeader so
 * the two concerns can be visually separated while still sharing the
 * ec2-status query.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cpu, RefreshCw, RotateCw } from 'lucide-react';
import {
  useDisableEc2,
  useEc2Status,
  useRestartEc2Daemon,
  useStartAndVerify,
  type Ec2Status,
} from '@/hooks/use-ec2-daemon';
import { ReauthorizeButton } from '@/components/labs/reauthorize-button';

const STORAGE_KEY = 'futurator.labs.runtimeMode';
export type RuntimeMode = 'local' | 'ec2';

function readMode(): RuntimeMode {
  if (typeof window === 'undefined') return 'local';
  return (window.localStorage.getItem(STORAGE_KEY) as RuntimeMode) || 'local';
}

function storeMode(mode: RuntimeMode) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, mode);
  }
}

export function RuntimeControls() {
  const [mode, setMode] = useState<RuntimeMode>(() => readMode());
  const syncedRef = useRef(false);

  const { data: status } = useEc2Status(true);
  const disableEc2 = useDisableEc2();
  const startVerify = useStartAndVerify();

  useEffect(() => {
    if (syncedRef.current) return;
    const next: RuntimeMode | null =
      status?.state === 'running' && mode === 'local'
        ? 'ec2'
        : status?.state === 'stopped' && mode === 'ec2'
          ? 'local'
          : null;
    if (!next) return;
    syncedRef.current = true;
    storeMode(next);
    queueMicrotask(() => setMode(next));
  }, [status?.state, mode]);

  function handleToggle(next: RuntimeMode) {
    setMode(next);
    storeMode(next);
    if (next === 'ec2') {
      startVerify.reset();
      startVerify.run();
    } else {
      disableEc2.mutate(undefined);
    }
  }

  const isEc2 = mode === 'ec2';
  const running = status?.state === 'running';
  const authValid = status?.auth?.valid;
  const authBroken = running && authValid === false;

  return (
    <div className="flex items-center gap-2">
      <DaemonPanel mode={mode} status={status} startVerify={startVerify} onToggle={handleToggle} />
      {isEc2 && running && (
        <ClaudeCodePanel authValid={authValid} authBroken={authBroken} status={status} />
      )}
    </div>
  );
}

// ── Daemon panel ──────────────────────────────────────────────────────

function DaemonPanel({
  mode,
  status,
  startVerify,
  onToggle,
}: {
  mode: RuntimeMode;
  status: Ec2Status | undefined;
  startVerify: ReturnType<typeof useStartAndVerify>;
  onToggle: (m: RuntimeMode) => void;
}) {
  const isEc2 = mode === 'ec2';
  const restart = useRestartEc2Daemon();
  const running = status?.state === 'running';
  const stateColor = running
    ? 'text-green-500'
    : status?.state === 'pending' || status?.state === 'stopping'
      ? 'text-yellow-500'
      : 'text-muted-foreground';

  const handleRestart = () => {
    if (restart.isPending) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Restart the daemon? In-flight steps get a 30s graceful shutdown window — anything that does not exit cleanly will be marked FAILED.',
      )
    )
      return;
    restart.mutate();
  };

  return (
    <PanelShell label="Daemon" title="Daemon runtime + service actions">
      {/* Local / EC2 toggle — always visible */}
      <div className="flex items-center bg-secondary/30 rounded p-0.5">
        <button
          className={`h-6 px-2 text-xs rounded transition-colors ${
            !isEc2
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onToggle('local')}
        >
          Local
        </button>
        <button
          className={`h-6 px-2 text-xs rounded transition-colors flex items-center gap-1 ${
            isEc2
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onToggle('ec2')}
        >
          <Cpu className="h-3 w-3" />
          EC2
        </button>
      </div>

      {/* Progress while start-and-verify is walking its steps */}
      {isEc2 && startVerify.isRunning && (
        <span
          className="text-[10px] font-mono text-yellow-500 max-w-[180px] truncate"
          title={startVerify.detail}
        >
          {startVerify.step.replace('-', ' ')}…
        </span>
      )}
      {isEc2 && startVerify.step === 'error' && (
        <span
          className="text-[10px] font-mono text-red-400 max-w-[180px] truncate"
          title={startVerify.error || ''}
        >
          error: {startVerify.error}
        </span>
      )}

      {/* Resting state: state chip + active count + Restart */}
      {isEc2 && !startVerify.isRunning && status && (
        <>
          <span
            className={`text-[10px] font-mono ${stateColor}`}
            title={
              status.lastHeartbeat
                ? `Last heartbeat: ${new Date(status.lastHeartbeat).toLocaleTimeString()}`
                : 'No heartbeat yet'
            }
          >
            {status.state}
          </span>
          {running && status.activeCount > 0 && (
            <span
              className="text-[9px] font-mono text-green-500"
              title={`${status.activeCount}/${status.maxConcurrent} concurrent jobs`}
            >
              {status.activeCount} active
            </span>
          )}
          {running && (
            <button
              type="button"
              onClick={handleRestart}
              disabled={restart.isPending}
              title="Restart the daemon (systemctl restart). Current steps get a 30s graceful shutdown window."
              className="inline-flex items-center gap-1 h-6 px-1.5 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50 disabled:opacity-50"
            >
              <RotateCw className={`h-3 w-3 ${restart.isPending ? 'animate-spin' : ''}`} />
              {restart.isPending ? 'Restarting…' : 'Restart'}
            </button>
          )}
        </>
      )}
    </PanelShell>
  );
}

// ── Claude Code panel ─────────────────────────────────────────────────

function ClaudeCodePanel({
  authValid,
  authBroken,
  status,
}: {
  authValid: boolean | null | undefined;
  authBroken: boolean;
  status: Ec2Status | undefined;
}) {
  return (
    <PanelShell label="Claude Code" title="Claude Max subscription auth">
      {authValid === true && (
        <span
          className="flex items-center gap-1 text-[10px] text-green-500"
          title={`Claude Code auth OK — ${status?.auth?.subscriptionType || 'max'} subscription`}
        >
          <CheckCircle2 className="h-3 w-3" />
          oauth
        </span>
      )}
      {authBroken && (
        <span
          className="flex items-center gap-1 text-[10px] text-red-400"
          title={status?.auth?.error || 'Claude Code OAuth probe failed'}
        >
          <AlertTriangle className="h-3 w-3" />
          auth expired
        </span>
      )}
      {authValid === null && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" />
          probing
        </span>
      )}
      <ReauthorizeButton compact />
    </PanelShell>
  );
}

// ── Shared panel chrome ───────────────────────────────────────────────

function PanelShell({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      title={title}
      className="flex items-center gap-2 rounded border border-border/60 bg-secondary/20 pl-2 pr-1.5 py-1"
    >
      <span className="text-[9px] font-mono uppercase tracking-[0.18em] text-muted-foreground/70">
        {label}
      </span>
      <span className="h-3 w-px bg-border" />
      {children}
    </div>
  );
}
