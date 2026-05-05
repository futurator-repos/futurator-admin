'use client';
import { useEffect, useState, useRef } from 'react';
import { Cpu, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useEc2Status, useDisableEc2, useStartAndVerify } from '@/hooks/use-ec2-daemon';
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

export function Ec2Toggle() {
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
  const authValid = status?.auth?.valid;
  const authBroken = status?.state === 'running' && authValid === false;

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center bg-secondary/30 rounded p-0.5">
        <button
          className={`h-6 px-2 text-xs rounded transition-colors ${
            !isEc2
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => handleToggle('local')}
        >
          Local
        </button>
        <button
          className={`h-6 px-2 text-xs rounded transition-colors flex items-center gap-1 ${
            isEc2
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => handleToggle('ec2')}
        >
          <Cpu className="h-3 w-3" />
          EC2
        </button>
      </div>

      {isEc2 && startVerify.isRunning && (
        <span
          className="text-[10px] font-mono text-yellow-500 max-w-[260px] truncate"
          title={startVerify.detail}
        >
          {startVerify.step.replace('-', ' ')}…
        </span>
      )}

      {isEc2 && startVerify.step === 'error' && (
        <span
          className="text-[10px] font-mono text-red-400 max-w-[260px] truncate"
          title={startVerify.error || ''}
        >
          error: {startVerify.error}
        </span>
      )}

      {isEc2 && !startVerify.isRunning && status && (
        <span
          className={`text-[10px] font-mono ${
            status.state === 'running'
              ? 'text-green-500'
              : status.state === 'pending' || status.state === 'stopping'
                ? 'text-yellow-500'
                : 'text-muted-foreground'
          }`}
        >
          {status.state}
        </span>
      )}

      {isEc2 && status?.state === 'running' && status.activeCount > 0 && (
        <span className="text-[9px] font-mono text-green-500">{status.activeCount} active</span>
      )}

      {isEc2 && status?.state === 'running' && authValid === true && (
        <span
          className="flex items-center gap-1 text-[10px] text-green-500"
          title={`Claude Code auth OK — ${status?.auth?.subscriptionType || 'max'} subscription`}
        >
          <CheckCircle2 className="h-3 w-3" />
          oauth
        </span>
      )}

      {isEc2 && authBroken && (
        <span
          className="flex items-center gap-1 text-[10px] text-red-400"
          title={status?.auth?.error || 'Claude Code OAuth probe failed'}
        >
          <AlertTriangle className="h-3 w-3" />
          auth expired
        </span>
      )}

      {/*
       * Re-auth is always available when running on EC2 — the server-side
       * auth probe reports probe-level success but the actual `claude -p`
       * subprocess can still hit 401 if the cached token expired between
       * probe cycles. Operator needs a one-click refresh without waiting
       * for the probe to flip.
       */}
      {isEc2 && status?.state === 'running' && <ReauthorizeButton compact />}
    </div>
  );
}
