'use client';
/**
 * Runtime controls — two visually-grouped containers used in the top-right of
 * Labs / EC2 Monitor / File Explorer screens. Daemon actions on the left,
 * Claude Code auth on the right.
 *
 * OAuth confirmation is gated on the daemon's *next* probe finishing after
 * any in-flight re-auth. We track a `reauthStartedAt` timestamp; the green
 * "oauth" chip only appears once `auth.checkedAt > reauthStartedAt` (and
 * `auth.valid === true`). Until that happens we show "pushing" → "verifying".
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Power, RefreshCw, RotateCw } from 'lucide-react';
import {
  useDisableEc2,
  useEc2Status,
  useReauthorizeEc2,
  useRestartEc2Daemon,
  useStartAndVerify,
  type Ec2Status,
  type ReauthError,
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
  const isStopping = disableEc2.isPending || status?.state === 'stopping';

  return (
    <div className="flex items-center gap-2">
      <DaemonPanel
        mode={mode}
        status={status}
        startVerify={startVerify}
        onToggle={handleToggle}
        isStopping={isStopping}
      />
      {isEc2 && running && <ClaudeCodePanel status={status} />}
    </div>
  );
}

// ── Daemon panel ──────────────────────────────────────────────────────

function DaemonPanel({
  mode,
  status,
  startVerify,
  onToggle,
  isStopping,
}: {
  mode: RuntimeMode;
  status: Ec2Status | undefined;
  startVerify: ReturnType<typeof useStartAndVerify>;
  onToggle: (m: RuntimeMode) => void;
  isStopping: boolean;
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

  const handleStopEc2 = () => {
    if (isStopping) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Stop the EC2 instance? In-flight jobs are aborted and the daemon goes offline. The instance can be brought back with the EC2 toggle.',
      )
    )
      return;
    onToggle('local');
  };

  return (
    <PanelShell label="Daemon" title="Daemon runtime + service actions">
      {/* Local / EC2 toggle — always visible */}
      <div className="flex items-center bg-secondary/30 rounded p-0.5">
        <button
          type="button"
          className={`h-6 px-2 text-xs rounded transition-colors cursor-pointer ${
            !isEc2
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
          }`}
          onClick={() => onToggle('local')}
        >
          Local
        </button>
        <button
          type="button"
          className={`h-6 px-2 text-xs rounded transition-colors flex items-center gap-1 cursor-pointer ${
            isEc2
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
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
            <>
              <button
                type="button"
                onClick={handleRestart}
                disabled={restart.isPending}
                title="Restart the daemon (systemctl restart). Current steps get a 30s graceful shutdown window."
                className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded border border-border/60 bg-background/40 text-muted-foreground hover:text-foreground hover:bg-secondary/60 hover:border-border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RotateCw className={`h-3 w-3 ${restart.isPending ? 'animate-spin' : ''}`} />
                {restart.isPending ? 'Restarting…' : 'Restart'}
              </button>
              <button
                type="button"
                onClick={handleStopEc2}
                disabled={isStopping}
                title="Stop the EC2 instance. In-flight jobs are aborted; bring it back with the EC2 toggle."
                className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded border border-red-900/50 bg-red-950/30 text-red-400 hover:text-red-300 hover:bg-red-900/40 hover:border-red-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Power className="h-3 w-3" />
                {isStopping ? 'Stopping…' : 'Stop EC2'}
              </button>
            </>
          )}
        </>
      )}
    </PanelShell>
  );
}

// ── Claude Code panel ─────────────────────────────────────────────────

function ClaudeCodePanel({ status }: { status: Ec2Status | undefined }) {
  const reauth = useReauthorizeEc2();
  const [showHelp, setShowHelp] = useState(false);

  // Timestamp when the operator last kicked off a re-auth. We refuse to flip
  // the OAuth chip green until the daemon's heartbeat reports an auth probe
  // newer than this timestamp. That guarantees "green" means "verified after
  // re-auth," not "stale value from before re-auth started."
  const [reauthStartedAt, setReauthStartedAt] = useState<number | null>(null);

  const authValid = status?.auth?.valid;
  const checkedAtMs = status?.auth?.checkedAt
    ? new Date(status.auth.checkedAt).getTime()
    : 0;

  // We're "verifying" while the push is in-flight, OR after it succeeded but
  // the daemon hasn't probed yet (auth.checkedAt is still older than the
  // moment we kicked off the re-auth). Once `checkedAtMs >= reauthStartedAt`,
  // `awaitingProbe` flips false on its own — no cleanup effect needed.
  const awaitingProbe = reauthStartedAt !== null && checkedAtMs < reauthStartedAt;
  const isReauthing = reauth.isPending || awaitingProbe;

  const handleReauth = () => {
    reauth.reset();
    setShowHelp(false);
    setReauthStartedAt(Date.now());
    reauth.mutate(undefined, {
      onError: (err: ReauthError) => {
        if (err.kind === 'helper_not_running') setShowHelp(true);
        // On failure, drop the timestamp so we don't keep showing "verifying."
        setReauthStartedAt(null);
      },
    });
  };

  const error = reauth.error as ReauthError | null;
  const oauthConfirmed = authValid === true && !isReauthing;
  const oauthBroken = authValid === false && !isReauthing;
  const oauthProbing = authValid === null && !isReauthing;

  return (
    <>
      <PanelShell label="Claude Code" title="Claude Max subscription auth">
        {oauthConfirmed && (
          <span
            className="flex items-center gap-1 text-[10px] text-green-500"
            title={`Claude Code auth OK — ${status?.auth?.subscriptionType || 'max'} subscription`}
          >
            <CheckCircle2 className="h-3 w-3" />
            oauth
          </span>
        )}
        {oauthBroken && (
          <span
            className="flex items-center gap-1 text-[10px] text-red-400"
            title={status?.auth?.error || 'Claude Code OAuth probe failed'}
          >
            <AlertTriangle className="h-3 w-3" />
            auth expired
          </span>
        )}
        {oauthProbing && (
          <span
            className="flex items-center gap-1 text-[10px] text-muted-foreground"
            title="Daemon has not finished its first OAuth probe yet"
          >
            <RefreshCw className="h-3 w-3 animate-spin" />
            probing
          </span>
        )}
        {isReauthing && (
          <span
            className="flex items-center gap-1 text-[10px] text-yellow-500"
            title={
              reauth.isPending
                ? 'Pushing OAuth from your Mac Keychain to EC2…'
                : 'OAuth pushed — waiting for the daemon to re-probe and confirm'
            }
          >
            <RefreshCw className="h-3 w-3 animate-spin" />
            {reauth.isPending ? 'pushing' : 'verifying'}
          </span>
        )}
        <button
          type="button"
          onClick={handleReauth}
          disabled={isReauthing}
          title="Push fresh OAuth from your Mac Keychain to EC2 (calls local helper on 127.0.0.1:9876)"
          className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded border border-border/60 bg-background/40 text-muted-foreground hover:text-foreground hover:bg-secondary/60 hover:border-border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`h-3 w-3 ${reauth.isPending ? 'animate-spin' : ''}`} />
          Re-auth
        </button>
        {error?.kind === 'sync_failed' && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-red-400 max-w-[160px] truncate"
            title={error.stderr || error.message}
          >
            <AlertTriangle className="h-3 w-3" /> {error.message}
          </span>
        )}
      </PanelShell>
      {showHelp && <HelperInstallDialog onClose={() => setShowHelp(false)} />}
    </>
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

// ── Helper-not-running dialog ─────────────────────────────────────────

function HelperInstallDialog({ onClose }: { onClose: () => void }) {
  const cmd =
    'cd /Users/ricardoarayafarias/GetReal/Futurator-Admin && ./scripts/install-mac-oauth-sync.sh';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-background p-4 shadow-xl space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Mac OAuth helper not running</h3>
        <p className="text-xs text-muted-foreground">
          The Re-auth button needs a tiny background process on your Mac that pushes Keychain
          OAuth tokens to EC2. It listens on{' '}
          <code className="font-mono">http://127.0.0.1:9876</code> and runs at every login.
        </p>
        <p className="text-xs text-muted-foreground">Install once, in your terminal:</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded bg-muted px-2 py-1.5 text-[11px] font-mono select-all break-all">
            {cmd}
          </code>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(cmd)}
            className="rounded bg-secondary px-2 py-1.5 text-[10px] hover:bg-secondary/80 shrink-0 cursor-pointer"
          >
            Copy
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          After installing, click Re-auth again. The helper auto-syncs every 5 minutes too, so
          OAuth on EC2 stays fresh hands-off.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
