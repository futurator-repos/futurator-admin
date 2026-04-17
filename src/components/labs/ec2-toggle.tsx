'use client';
import { useEffect, useState, useRef } from 'react';
import { Cpu, KeyRound, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  useEc2Status,
  useDisableEc2,
  useSetAnthropicKey,
  useAnthropicKeyStatus,
  useStartAndVerify,
  type Ec2Status,
} from '@/hooks/use-ec2-daemon';
import { api } from '@/lib/api-client';

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
    // Defer setState out of the effect's synchronous render cycle.
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

      {isEc2 && authBroken && (
        <span
          className="flex items-center gap-1 text-[10px] text-red-400"
          title="Auth probe failed"
        >
          <AlertTriangle className="h-3 w-3" />
          auth expired
        </span>
      )}

      {isEc2 && status?.state === 'running' && authValid === true && (
        <span className="flex items-center gap-1 text-[10px] text-green-500" title="Claude auth OK">
          <CheckCircle2 className="h-3 w-3" />
        </span>
      )}

      {isEc2 && status?.state === 'running' && (
        <button
          onClick={() => setShowAuthModal(true)}
          className={`h-6 px-1.5 text-xs rounded transition-colors ${
            authBroken
              ? 'text-red-400 hover:text-red-300 hover:bg-red-950/40 animate-pulse'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
          }`}
          title="Rotate Anthropic API key"
        >
          <KeyRound className="h-3 w-3" />
        </button>
      )}

      {showAuthModal && <ApiKeyModal onClose={() => setShowAuthModal(false)} />}
    </div>
  );
}

// ── API key rotation modal ──
// Writes a new Anthropic API key to SSM and signals the daemon (SIGUSR1) so
// the new key is live in ~5s without restart. Polls auth.valid afterwards.

function ApiKeyModal({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [phase, setPhase] = useState<'input' | 'applying' | 'verifying' | 'success' | 'failed'>(
    'input',
  );
  const [error, setError] = useState<string | null>(null);

  const { data: keyStatus } = useAnthropicKeyStatus();
  const setKey = useSetAnthropicKey();
  const { data: ec2 } = useEc2Status(true);

  async function handleSubmit() {
    const trimmed = apiKey.trim();
    if (!trimmed.startsWith('sk-ant-')) {
      setError('Expected an Anthropic API key (starts with sk-ant-api03-)');
      return;
    }
    setError(null);
    setPhase('applying');
    try {
      await setKey.mutateAsync(trimmed);
      setPhase('verifying');
      // Poll auth.valid for up to 30s
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));
        try {
          const fresh = await api.get<Ec2Status>('/ec2/status');
          if (fresh.auth?.valid === true) {
            setPhase('success');
            setTimeout(onClose, 1500);
            return;
          }
        } catch {
          // transient — keep polling
        }
      }
      setPhase('failed');
      setError('Key stored but auth probe did not succeed within 30s. Check daemon logs.');
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }

  const daemonRunning = ec2?.state === 'running' && ec2.daemonAlive;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Rotate Anthropic API Key</h3>

        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>
            Paste a new <code className="font-mono">sk-ant-api03-…</code> key. It&apos;s written to
            SSM SecureString and the daemon hot-reloads within seconds — no restart, no killed jobs.
          </p>
          {!daemonRunning && (
            <p className="text-yellow-500">
              Daemon not currently running — key will be loaded when it next starts.
            </p>
          )}
        </div>

        {keyStatus?.exists && (
          <div className="rounded bg-muted/40 px-2 py-1.5 text-[10px] space-y-0.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current key</span>
              <span className="font-mono">{keyStatus.preview || '(opaque)'}</span>
            </div>
            {keyStatus.lastModified && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last rotated</span>
                <span className="font-mono">
                  {new Date(keyStatus.lastModified).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}

        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-api03-..."
          autoComplete="off"
          spellCheck={false}
          disabled={phase !== 'input' && phase !== 'failed'}
          className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs font-mono focus:border-ring focus:outline-none disabled:opacity-60"
        />

        {error && <p className="text-[10px] text-red-400">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] flex-1 truncate">
            {phase === 'applying' && <span className="text-yellow-500">Writing to SSM…</span>}
            {phase === 'verifying' && (
              <span className="text-yellow-500">Waiting for daemon to reload…</span>
            )}
            {phase === 'success' && (
              <span className="text-green-500">
                <CheckCircle2 className="inline h-3 w-3 mr-1" />
                Auth verified — closing.
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {phase === 'success' ? 'Close' : 'Cancel'}
            </button>
            <button
              onClick={handleSubmit}
              disabled={
                !apiKey.trim() ||
                phase === 'applying' ||
                phase === 'verifying' ||
                phase === 'success'
              }
              className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {phase === 'applying'
                ? 'Writing…'
                : phase === 'verifying'
                  ? 'Verifying…'
                  : phase === 'failed'
                    ? 'Retry'
                    : 'Rotate Key'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
