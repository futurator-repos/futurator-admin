import { getProviderCredentials } from '../provider-credentials-sm';
import { gcpAccessToken } from './gcp-auth';
import { toProviderResourceName } from './naming';
import type {
  ComputeProviderAdapter,
  ProviderRef,
  ProviderState,
  ProviderStatus,
  ProvisionSpec,
} from './types';

const COMPUTE_BASE = 'https://compute.googleapis.com/compute/v1';
const UBUNTU_IMAGE = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64';

interface GcpCredentials {
  serviceAccountJson: string;
  projectId: string;
  zone: string;
}

interface GcpApiError {
  error?: { message?: string };
}

interface GcpInstance {
  status?: string;
  networkInterfaces?: { accessConfigs?: { natIP?: string }[] }[];
}

async function loadCredentials(): Promise<GcpCredentials> {
  const creds = await getProviderCredentials<GcpCredentials>('gcp');
  if (!creds?.serviceAccountJson || !creds.projectId || !creds.zone) {
    throw new Error('GCP credentials are not configured');
  }
  return creds;
}

async function authHeader(serviceAccountJson: string): Promise<Record<string, string>> {
  const token = await gcpAccessToken(serviceAccountJson);
  return { Authorization: `Bearer ${token}` };
}

async function throwOnError(res: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as GcpApiError;
  const message = body?.error?.message ?? `GCP API error (${res.status})`;
  throw new Error(message);
}

function instancesUrl(projectId: string, zone: string): string {
  return `${COMPUTE_BASE}/projects/${projectId}/zones/${zone}/instances`;
}

function mapState(status: string | undefined): ProviderState {
  switch (status) {
    case 'RUNNING':
      return 'running';
    case 'PROVISIONING':
    case 'STAGING':
      return 'creating';
    case 'TERMINATED':
    case 'STOPPING':
      return 'stopped';
    default:
      return 'unknown';
  }
}

function natIpOf(inst: GcpInstance): string | undefined {
  return inst.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? undefined;
}

async function provision(spec: ProvisionSpec): Promise<ProviderRef> {
  const creds = await loadCredentials();
  const headers = await authHeader(creds.serviceAccountJson);
  // GCE names are RFC1035 identifiers, not labels — the operator's free-form
  // server name would be rejected outright ("Invalid value for field
  // 'resource.name'"). instanceId must be the name we actually created, since
  // status/stop/start/destroy address the instance by it.
  const instanceName = toProviderResourceName(spec.name, spec.serverId);
  const res = await fetch(instancesUrl(creds.projectId, creds.zone), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: instanceName,
      machineType: `zones/${creds.zone}/machineTypes/${spec.size}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: { sourceImage: UBUNTU_IMAGE },
        },
      ],
      networkInterfaces: [{ network: 'global/networks/default', accessConfigs: [{}] }],
      metadata: { items: [{ key: 'startup-script', value: spec.userData }] },
    }),
  });
  await throwOnError(res);
  return { instanceId: instanceName, zone: creds.zone };
}

async function status(ref: ProviderRef): Promise<ProviderStatus> {
  const creds = await loadCredentials();
  const headers = await authHeader(creds.serviceAccountJson);
  const zone = ref.zone ?? creds.zone;
  const res = await fetch(`${instancesUrl(creds.projectId, zone)}/${ref.instanceId}`, {
    method: 'GET',
    headers,
  });
  await throwOnError(res);
  const inst = (await res.json()) as GcpInstance;
  return { state: mapState(inst.status), ip: natIpOf(inst) };
}

async function destroy(ref: ProviderRef): Promise<void> {
  const creds = await loadCredentials();
  const headers = await authHeader(creds.serviceAccountJson);
  const zone = ref.zone ?? creds.zone;
  const res = await fetch(`${instancesUrl(creds.projectId, zone)}/${ref.instanceId}`, {
    method: 'DELETE',
    headers,
  });
  if (res.status === 404) return; // already gone — treat as success
  await throwOnError(res);
}

async function stop(ref: ProviderRef): Promise<void> {
  const creds = await loadCredentials();
  const headers = await authHeader(creds.serviceAccountJson);
  const zone = ref.zone ?? creds.zone;
  const res = await fetch(`${instancesUrl(creds.projectId, zone)}/${ref.instanceId}/stop`, {
    method: 'POST',
    headers,
  });
  await throwOnError(res);
}

async function start(ref: ProviderRef): Promise<void> {
  const creds = await loadCredentials();
  const headers = await authHeader(creds.serviceAccountJson);
  const zone = ref.zone ?? creds.zone;
  const res = await fetch(`${instancesUrl(creds.projectId, zone)}/${ref.instanceId}/start`, {
    method: 'POST',
    headers,
  });
  await throwOnError(res);
}

/**
 * Google Compute Engine adapter. GCP is the ONLY provider that implements
 * `stop`/`start`: stopping a GCE VM genuinely pauses compute billing (unlike
 * Hetzner/Oracle, which bill stopped VMs — see Global Constraints).
 */
export const gcpAdapter: ComputeProviderAdapter = {
  provision,
  destroy,
  status,
  stop,
  start,
};
