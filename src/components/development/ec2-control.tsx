'use client';
import { useEffect, useRef, useState } from 'react';
import {
  useEc2Status,
  useEnableEc2,
  useStartEc2Daemon,
  useDisableEc2,
} from '@/hooks/use-ec2-daemon';

type UserIntent = 'idle' | 'starting' | 'stopping';

export function Ec2Control() {
  const { data: status, isLoading } = useEc2Status(true);
  const enableEc2 = useEnableEc2();
  const startDaemon = useStartEc2Daemon();
  const disableEc2 = useDisableEc2();

  const [intent, setIntent] = useState<UserIntent>('idle');
  const daemonStartedRef = useRef(false);

  const state = status?.state ?? 'unknown';
  const daemonUp = !!(status?.daemonAlive && status?.daemonSource === 'ec2');
  const isRunning = state === 'running';
  const isStopped = state === 'stopped';

  // Derive display phase from intent + external state (no setState needed)
  const phase = (() => {
    if (intent === 'starting') {
      if (daemonUp) return 'idle' as const;
      if (isRunning) return 'waiting-daemon' as const;
      return 'starting' as const;
    }
    if (intent === 'stopping') {
      if (state === 'stopped' || state === 'terminated') return 'idle' as const;
      return 'stopping' as const;
    }
    return 'idle' as const;
  })();

  // Auto-start daemon once instance is running (side-effect only, no setState)
  useEffect(() => {
    if (intent !== 'starting') {
      daemonStartedRef.current = false;
      return;
    }
    if (isRunning && !daemonUp && !daemonStartedRef.current) {
      daemonStartedRef.current = true;
      startDaemon.mutate();
    }
  }, [intent, isRunning, daemonUp, startDaemon]);

  function handleStart() {
    setIntent('starting');
    daemonStartedRef.current = false;
    enableEc2.mutate();
  }

  function handleStop() {
    setIntent('stopping');
    disableEc2.mutate();
  }

  const isTransitional = phase !== 'idle' || state === 'pending' || state === 'stopping';

  // Status dot color
  const dotColor = daemonUp
    ? 'bg-green-500'
    : isRunning
      ? 'bg-yellow-500 animate-pulse'
      : isStopped
        ? 'bg-gray-500'
        : 'bg-yellow-500 animate-pulse';

  // Status label
  const label = isLoading
    ? 'Checking...'
    : phase === 'starting'
      ? 'Starting instance...'
      : phase === 'waiting-daemon'
        ? 'Starting daemon...'
        : phase === 'stopping'
          ? 'Stopping...'
          : daemonUp
            ? 'Running'
            : isRunning
              ? 'Instance up, daemon offline'
              : isStopped
                ? 'Stopped'
                : state;

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotColor}`} />
        <span className="text-muted-foreground">{label}</span>
      </div>

      {isStopped && phase === 'idle' && (
        <button
          onClick={handleStart}
          className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-500 transition-colors"
        >
          Start EC2
        </button>
      )}

      {isRunning && daemonUp && phase === 'idle' && (
        <button
          onClick={handleStop}
          className="rounded-md bg-red-600/80 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 transition-colors"
        >
          Stop EC2
        </button>
      )}

      {isRunning && !daemonUp && phase === 'idle' && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setIntent('starting');
              daemonStartedRef.current = false;
            }}
            className="rounded-md bg-yellow-600 px-3 py-1 text-xs font-medium text-white hover:bg-yellow-500 transition-colors"
          >
            Start Daemon
          </button>
          <button
            onClick={handleStop}
            className="rounded-md border border-red-600/50 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-600/20 transition-colors"
          >
            Stop EC2
          </button>
        </div>
      )}

      {isTransitional && (
        <span className="text-[10px] text-muted-foreground italic">
          {phase === 'starting' && 'Instance boots in ~30s'}
          {phase === 'waiting-daemon' && 'Daemon starts in ~5s'}
          {phase === 'stopping' && 'Shutting down...'}
        </span>
      )}
    </div>
  );
}
