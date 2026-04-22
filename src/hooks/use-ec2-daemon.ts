'use client';
import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface DaemonProcess {
  jobId: string;
  stepId: string | null;
  agentId: string | null;
  model: string | null;
  pid: number | null;
  startedAt: string;
  workingDir: string;
}

export interface SystemStats {
  totalMem: number; // MB
  freeMem: number; // MB
  loadAvg: number[]; // [1m, 5m, 15m]
}

// Shape mirrors what the daemon writes into DAEMON_HEARTBEAT.auth in
// daemon/agent-daemon.mjs. Claude Max OAuth is the only auth path, so the
// fields below describe the OAuth file at /home/ubuntu/.claude/.credentials.json
// and the result of the last `claude -p ok` probe.
export interface AuthState {
  valid: boolean | null; // null until first probe completes
  checkedAt: string | null; // ISO of last probe
  error: string | null; // one-line error when valid=false
  hasFile: boolean; // OAuth file exists + parses
  hasRefresh: boolean; // file contains a refresh_token (needed for auto-refresh)
  loadedAt: string | null; // when the daemon last re-read the file
  expiresAt: string | null; // accessToken expiry (CLI refreshes per-use)
  subscriptionType: string | null; // "max", "pro", ...
}

export interface Ec2Status {
  instanceId: string;
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown';
  publicIp?: string;
  daemonAlive: boolean;
  daemonSource: 'local' | 'ec2' | null;
  lastHeartbeat: string | null;
  activeCount: number;
  maxConcurrent: number;
  processes: DaemonProcess[];
  system: SystemStats | null;
  auth: AuthState | null;
}

export function useEc2Status(enabled: boolean) {
  return useQuery({
    queryKey: ['ec2-status'],
    queryFn: () => api.get<Ec2Status>('/ec2/status'),
    enabled,
    refetchInterval: 5000,
    retry: 2,
  });
}

export function useEnableEc2() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ state: string; message: string }>('/ec2/enable', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ec2-status'] }),
  });
}

export function useStartEc2Daemon() {
  return useMutation({
    mutationFn: () => api.post<{ commandId: string; message: string }>('/ec2/start-daemon', {}),
  });
}

/**
 * Restart the daemon in place (systemctl restart). Same underlying endpoint
 * as useStartEc2Daemon — the shell command on EC2 is idempotent, so this is
 * semantically "restart if running, start if not".
 *
 * Phase A.1 (graceful shutdown) gives the current subprocess up to 30s to
 * flush before SIGKILL, so this is safe to call even mid-wave; in-flight
 * steps that don't exit cleanly are marked FAILED with
 * daemon-shutdown-timeout and surface in the attention inbox.
 */
export function useRestartEc2Daemon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ commandId: string; message: string }>('/ec2/start-daemon', {}),
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['ec2-status'] });
      }, 3000);
    },
  });
}

export function useDisableEc2() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ state: string; message: string }>('/ec2/disable', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ec2-status'] }),
  });
}

// Re-authorize EC2 by asking the operator's Mac helper
// (scripts/mac-oauth-server.mjs, listening on http://127.0.0.1:9876) to
// push fresh Claude Code OAuth from Keychain → EC2 via SSM. The helper then
// sends SIGUSR1 to the daemon, which re-reads the file and re-probes within
// seconds. Modern browsers allow HTTPS pages to fetch http://localhost
// without mixed-content blocking.
export type ReauthErrorKind = 'helper_not_running' | 'sync_failed' | 'unknown';

export interface ReauthError {
  kind: ReauthErrorKind;
  message: string;
  stderr?: string;
}

export interface ReauthResult {
  ok: boolean;
  ts: string | null;
  trigger: string | null;
  exitCode: number | null;
  message: string;
}

const MAC_HELPER_URL = 'http://127.0.0.1:9876';

export function useReauthorizeEc2() {
  const queryClient = useQueryClient();
  return useMutation<ReauthResult, ReauthError>({
    mutationFn: async () => {
      let resp: Response;
      try {
        resp = await fetch(`${MAC_HELPER_URL}/sync`, { method: 'POST' });
      } catch {
        // Browser throws TypeError on connection-refused → helper isn't running.
        throw {
          kind: 'helper_not_running',
          message: 'Mac helper not running on 127.0.0.1:9876',
        } satisfies ReauthError;
      }
      const body = (await resp.json().catch(() => null)) as ReauthResult | null;
      if (!resp.ok || !body?.ok) {
        throw {
          kind: 'sync_failed',
          message: body?.message || `helper returned HTTP ${resp.status}`,
          stderr: (body as unknown as { stderr?: string })?.stderr,
        } satisfies ReauthError;
      }
      return body;
    },
    onSuccess: () => {
      // Daemon re-probes within ~5s of SIGUSR1; refetch heartbeat shortly.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['ec2-status'] });
      }, 5000);
    },
  });
}

// ── Orchestrated start-and-verify flow ──
// Chains: enable EC2 → poll running → start-daemon → poll heartbeat fresh →
// poll auth.valid=true. Each step has its own timeout and retries. The caller
// observes `step` / `error` to render a progress UI.

export type StartVerifyStep =
  | 'idle'
  | 'starting-ec2'
  | 'waiting-ec2'
  | 'starting-daemon'
  | 'waiting-daemon'
  | 'verifying-auth'
  | 'done'
  | 'error';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, backoffMs = 2_000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(backoffMs * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('operation failed');
}

async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
  onProgress?: (elapsedMs: number) => void,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // transient — keep polling
    }
    onProgress?.(Date.now() - (deadline - timeoutMs));
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export function useStartAndVerify() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<StartVerifyStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string>('');

  const run = useCallback(async () => {
    setError(null);
    try {
      // Step 1: enable EC2 (idempotent at backend)
      setStep('starting-ec2');
      setDetail('Requesting EC2 start…');
      await withRetry(() => api.post('/ec2/enable', {}), 3);

      // Step 2: wait until AWS reports state=running
      setStep('waiting-ec2');
      setDetail('Waiting for instance to reach running state (up to 2 min)…');
      await waitFor(async () => (await api.get<Ec2Status>('/ec2/status')).state === 'running', {
        timeoutMs: 120_000,
        intervalMs: 3_000,
      });

      // Step 3: start the daemon service (idempotent — systemctl restart)
      setStep('starting-daemon');
      setDetail('Pulling latest daemon code and starting service…');
      await withRetry(() => api.post('/ec2/start-daemon', {}), 3);

      // Step 4: wait for fresh heartbeat
      setStep('waiting-daemon');
      setDetail('Waiting for daemon heartbeat (up to 90s)…');
      await waitFor(async () => (await api.get<Ec2Status>('/ec2/status')).daemonAlive === true, {
        timeoutMs: 90_000,
        intervalMs: 3_000,
      });

      // Step 5: wait for auth probe to succeed — the Mac helper pushes OAuth
      // automatically when the admin UI loads, but we still wait for the
      // daemon to confirm it probed successfully against the Max subscription.
      setStep('verifying-auth');
      setDetail('Verifying Claude Code auth against your Max subscription…');
      await waitFor(
        async () => {
          const s = await api.get<Ec2Status>('/ec2/status');
          return s.auth?.valid === true;
        },
        { timeoutMs: 120_000, intervalMs: 3_000 },
      );

      setStep('done');
      setDetail('Daemon running and Claude authorized.');
      queryClient.invalidateQueries({ queryKey: ['ec2-status'] });
    } catch (err) {
      setStep('error');
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  }, [queryClient]);

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
    setDetail('');
  }, []);

  return {
    step,
    error,
    detail,
    run,
    reset,
    isRunning: step !== 'idle' && step !== 'done' && step !== 'error',
  };
}
