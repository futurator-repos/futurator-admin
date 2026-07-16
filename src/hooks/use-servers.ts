'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  ComputeServer,
  ComputeProviderId,
  ServerServiceType,
  DispatchPolicy,
  DispatchMode,
  ProviderCatalogEntry,
  ServerAssignment,
} from '@/types/servers';

// Mirrors functions/shared/types/compute-server.ts (spec §5 heartbeat
// eligibility/reassignment thresholds) — single source there, this is the
// frontend copy used to render the fleet's heartbeat dot.
const HEARTBEAT_FRESH_MS = 60_000;
const HEARTBEAT_STALE_MS = 120_000;

export type HeartbeatState = 'fresh' | 'stale' | 'dead';

/** <60s since last heartbeat = fresh, <120s = stale, else (or never) = dead. */
export function heartbeatState(lastHeartbeatAt: string | undefined, now: number): HeartbeatState {
  if (!lastHeartbeatAt) return 'dead';
  const age = now - new Date(lastHeartbeatAt).getTime();
  if (age < HEARTBEAT_FRESH_MS) return 'fresh';
  if (age < HEARTBEAT_STALE_MS) return 'stale';
  return 'dead';
}

/** The fleet (Fleet tab). Polls so PROVISIONING → BOOTSTRAPPING → ACTIVE and
 * heartbeats update live without a manual refresh. */
export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<{ servers: ComputeServer[] }>('/servers'),
    refetchInterval: 5000,
  });
}

/** Static provider catalog merged with live `configured` flags (Add Service wizard). */
export function useProviderCatalog() {
  return useQuery({
    queryKey: ['servers', 'providers'],
    queryFn: () => api.get<{ providers: ProviderCatalogEntry[] }>('/servers/providers'),
  });
}

/** Current operator dispatch policy (Dispatch Policy tab). */
export function useDispatchPolicy() {
  return useQuery({
    queryKey: ['servers', 'policy'],
    queryFn: () => api.get<{ policy: DispatchPolicy }>('/servers/policy'),
  });
}

export interface SaveDispatchPolicyInput {
  mode: DispatchMode;
  priorityOrder: string[];
  weights: Record<string, number>;
}

/** Persist the policy; the API re-sweeps immediately so it takes effect
 * without waiting for the 1-minute cron. */
export function useSaveDispatchPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveDispatchPolicyInput) =>
      api.put<{ policy: DispatchPolicy; sweep: unknown }>('/servers/policy', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
  });
}

export interface CreateServerInput {
  name: string;
  provider: ComputeProviderId;
  serviceType: ServerServiceType;
  region: string;
  size: string;
  arch: 'arm64' | 'x86_64';
  maxConcurrent: number;
  costPerHour: number;
}

export interface CreateServerResult {
  server: ComputeServer;
  installCommand?: string;
}

/** Create + provision a server (Add Service wizard, final step). */
export function useCreateServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateServerInput) => api.post<CreateServerResult>('/servers', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export interface UpdateServerInput {
  name?: string;
  enabled?: boolean;
  maxConcurrent?: number;
  costPerHour?: number;
}

/** Operator-editable fields only (name, enabled, cap, cost/hr) — the server
 * card's Switch and cap stepper. */
export function useUpdateServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { serverId: string; input: UpdateServerInput }) =>
      api.put<{ server: ComputeServer }>(`/servers/${vars.serverId}`, vars.input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export type ServerActionKind = 'destroy' | 'retry' | 'stop' | 'start';

export interface ServerActionResult {
  server?: ComputeServer;
  ok?: boolean;
  installCommand?: string;
}

/** The card's actions menu — Stop/Start (gcp only), Retry (ERROR only), Destroy. */
export function useServerAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { serverId: string; action: ServerActionKind }) =>
      api.post<ServerActionResult>(`/servers/${vars.serverId}/${vars.action}`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] }),
  });
}

/** Recent server-assigned agent-jobs (Assignments feed under the Policy tab). */
export function useAssignments() {
  return useQuery({
    queryKey: ['servers', 'assignments'],
    queryFn: () => api.get<ServerAssignment[]>('/servers/assignments'),
    refetchInterval: 5000,
  });
}
