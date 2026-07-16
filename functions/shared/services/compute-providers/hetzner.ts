import { getProviderCredentials } from '../provider-credentials-sm';
import type {
  ComputeProviderAdapter,
  ProviderRef,
  ProviderState,
  ProviderStatus,
  ProvisionSpec,
} from './types';

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';

interface HetznerCredentials {
  token: string;
}

interface HetznerApiError {
  error?: { message?: string };
}

interface HetznerServer {
  id: number;
  status: string;
  public_net?: { ipv4?: { ip?: string | null } };
}

async function authHeader(): Promise<Record<string, string>> {
  const creds = await getProviderCredentials<HetznerCredentials>('hetzner');
  if (!creds?.token) {
    throw new Error('Hetzner credentials are not configured');
  }
  return { Authorization: `Bearer ${creds.token}` };
}

async function throwOnError(res: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as HetznerApiError;
  const message = body?.error?.message ?? `Hetzner API error (${res.status})`;
  throw new Error(message);
}

function mapState(status: string): ProviderState {
  switch (status) {
    case 'running':
      return 'running';
    case 'initializing':
    case 'starting':
      return 'creating';
    case 'off':
      return 'stopped';
    default:
      return 'unknown';
  }
}

async function provision(spec: ProvisionSpec): Promise<ProviderRef> {
  const headers = await authHeader();
  const res = await fetch(`${HETZNER_API_BASE}/servers`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: spec.name,
      server_type: spec.size,
      image: 'ubuntu-24.04',
      location: spec.region,
      user_data: spec.userData,
    }),
  });
  await throwOnError(res);
  const body = (await res.json()) as { server: HetznerServer };
  return {
    instanceId: String(body.server.id),
    ip: body.server.public_net?.ipv4?.ip ?? undefined,
  };
}

async function destroy(ref: ProviderRef): Promise<void> {
  const headers = await authHeader();
  const res = await fetch(`${HETZNER_API_BASE}/servers/${ref.instanceId}`, {
    method: 'DELETE',
    headers,
  });
  if (res.status === 404) return; // already gone — treat as success
  await throwOnError(res);
}

async function status(ref: ProviderRef): Promise<ProviderStatus> {
  const headers = await authHeader();
  const res = await fetch(`${HETZNER_API_BASE}/servers/${ref.instanceId}`, {
    method: 'GET',
    headers,
  });
  await throwOnError(res);
  const body = (await res.json()) as { server: HetznerServer };
  return {
    state: mapState(body.server.status),
    ip: body.server.public_net?.ipv4?.ip ?? undefined,
  };
}

/**
 * Hetzner Cloud adapter. Hetzner bills stopped VMs, so this adapter does NOT
 * implement `stop`/`start` — `destroy` always deletes (see Global Constraints).
 */
export const hetznerAdapter: ComputeProviderAdapter = {
  provision,
  destroy,
  status,
};
