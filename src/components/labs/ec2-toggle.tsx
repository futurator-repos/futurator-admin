'use client';
import { useEffect, useState, useRef } from 'react';
import { Cpu, KeyRound } from 'lucide-react';
import {
  useEc2Status,
  useEnableEc2,
  useStartEc2Daemon,
  useDisableEc2,
  useRefreshEc2Credentials,
} from '@/hooks/use-ec2-daemon';

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
  const [showAuthModal, setShowAuthModal] = useState(false);
  const syncedRef = useRef(false);

  // Always fetch EC2 status so we can detect if instance is running on a fresh device
  const { data: status } = useEc2Status(true);
  const enableEc2 = useEnableEc2();
  const startDaemon = useStartEc2Daemon();
  const disableEc2 = useDisableEc2();
  const refreshCreds = useRefreshEc2Credentials();

  const daemonStartedRef = useRef(false);

  // Auto-sync: if the instance is running but localStorage says 'local', correct it
  useEffect(() => {
    if (syncedRef.current) return;
    if (status?.state === 'running' && mode === 'local') {
      syncedRef.current = true;
      setMode('ec2');
      storeMode('ec2');
    } else if (status?.state === 'stopped' && mode === 'ec2') {
      syncedRef.current = true;
      setMode('local');
      storeMode('local');
    }
  }, [status?.state, mode]);

  useEffect(() => {
    if (mode !== 'ec2') {
      daemonStartedRef.current = false;
      return;
    }
    if (status?.state === 'running' && !status.daemonAlive && !daemonStartedRef.current) {
      daemonStartedRef.current = true;
      startDaemon.mutate(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, status?.state, status?.daemonAlive]);

  function handleToggle(next: RuntimeMode) {
    setMode(next);
    storeMode(next);
    daemonStartedRef.current = false;

    if (next === 'ec2') {
      enableEc2.mutate(undefined);
    } else {
      disableEc2.mutate(undefined);
    }
  }

  const isEc2 = mode === 'ec2';

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

      {isEc2 && status && (
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

      {isEc2 && status?.state === 'running' && (
        <button
          onClick={() => setShowAuthModal(true)}
          className="h-6 px-1.5 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          title="Re-authorize Claude Code on EC2"
        >
          <KeyRound className="h-3 w-3" />
        </button>
      )}

      {showAuthModal && (
        <RefreshCredentialsModal
          onClose={() => setShowAuthModal(false)}
          onSubmit={(creds) => {
            refreshCreds.mutate(creds, {
              onSuccess: () => setShowAuthModal(false),
            });
          }}
          isPending={refreshCreds.isPending}
          isSuccess={refreshCreds.isSuccess}
        />
      )}
    </div>
  );
}

const KEYCHAIN_CMD = `security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w`;

function RefreshCredentialsModal({
  onClose,
  onSubmit,
  isPending,
  isSuccess,
}: {
  onClose: () => void;
  onSubmit: (creds: string) => void;
  isPending: boolean;
  isSuccess: boolean;
}) {
  const [creds, setCreds] = useState('');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Re-authorize Claude Code on EC2</h3>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Run this in your terminal, then paste the output below:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-2 py-1.5 text-[11px] font-mono select-all break-all">
              {KEYCHAIN_CMD}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(KEYCHAIN_CMD)}
              className="rounded bg-secondary px-2 py-1.5 text-[10px] hover:bg-secondary/80 shrink-0"
            >
              Copy
            </button>
          </div>
        </div>

        <textarea
          value={creds}
          onChange={(e) => setCreds(e.target.value)}
          placeholder="Paste the credentials JSON here..."
          className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs font-mono resize-none focus:border-ring focus:outline-none h-20"
        />

        <div className="flex items-center justify-between">
          <div className="text-[10px]">
            {isPending && <span className="text-yellow-500">Writing to EC2...</span>}
            {isSuccess && <span className="text-green-500">Done! Daemon restarted.</span>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => onSubmit(creds)}
              disabled={!creds.trim() || isPending}
              className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isPending ? 'Sending...' : 'Authorize'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
