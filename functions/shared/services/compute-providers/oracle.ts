import { getProviderCredentials } from '../provider-credentials-sm';
import { signOciRequest } from './oci-signer';
import type {
  ComputeProviderAdapter,
  ProviderRef,
  ProviderState,
  ProviderStatus,
  ProvisionSpec,
} from './types';

/**
 * Oracle Cloud Infrastructure adapter — plain OCI REST with draft-cavage
 * request signing (no OCI SDK). Provisions `VM.Standard.A1.Flex` ARM VMs and
 * retries across availability domains on the "Out of host capacity" error that
 * OCI's Always-Free ARM pool routinely returns. Oracle bills stopped VMs, so
 * `destroy` DELETEs (never stops) and `stop`/`start` are intentionally absent.
 */

interface OracleCredentials {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKeyPem: string;
  compartmentId: string;
  region: string;
  imageId: string;
  availabilityDomains: string[];
}

const OCI_API_VERSION = '20160918';

async function creds(): Promise<OracleCredentials> {
  const c = await getProviderCredentials<OracleCredentials>('oracle');
  if (!c?.tenancyOcid || !c?.privateKeyPem) {
    throw new Error('Oracle credentials are not configured');
  }
  return c;
}

function iaasBase(region: string): string {
  return `https://iaas.${region}.oraclecloud.com/${OCI_API_VERSION}`;
}

function keyIdFor(c: OracleCredentials): string {
  return `${c.tenancyOcid}/${c.userOcid}/${c.fingerprint}`;
}

interface OciResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

async function ociFetch(
  c: OracleCredentials,
  method: string,
  url: string,
  body?: unknown,
): Promise<OciResponse> {
  const headers = signOciRequest({
    keyId: keyIdFor(c),
    privateKeyPem: c.privateKeyPem,
    method,
    url,
    body,
  });
  return (await fetch(url, {
    method,
    headers: { ...headers, accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })) as unknown as OciResponse;
}

async function errorMessage(res: OciResponse): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
  return body?.message ?? body?.code ?? `OCI API error (${res.status})`;
}

function isCapacityError(message: string): boolean {
  return /capacity/i.test(message);
}

function mapState(lifecycleState: string): ProviderState {
  switch (lifecycleState) {
    case 'RUNNING':
      return 'running';
    case 'PROVISIONING':
    case 'STARTING':
    case 'CREATING_IMAGE':
      return 'creating';
    case 'STOPPED':
      return 'stopped';
    case 'TERMINATED':
    case 'TERMINATING':
      return 'terminated';
    default:
      return 'unknown';
  }
}

async function provision(spec: ProvisionSpec): Promise<ProviderRef> {
  const c = await creds();
  const url = `${iaasBase(c.region)}/instances/`;

  for (const availabilityDomain of c.availabilityDomains) {
    const body = {
      availabilityDomain,
      compartmentId: c.compartmentId,
      shape: 'VM.Standard.A1.Flex',
      shapeConfig: { ocpus: 2, memoryInGBs: 12 },
      displayName: spec.name,
      sourceDetails: { sourceType: 'image', imageId: c.imageId },
      metadata: { user_data: Buffer.from(spec.userData).toString('base64') },
    };

    const res = await ociFetch(c, 'POST', url, body);
    if (res.ok) {
      const instance = (await res.json()) as { id: string };
      return { instanceId: instance.id, availabilityDomain, ip: undefined };
    }

    const message = await errorMessage(res);
    if (isCapacityError(message)) {
      // ARM pool exhausted in this AD — try the next one.
      continue;
    }
    throw new Error(message);
  }

  throw new Error('oracle: out of ARM capacity in all availability domains');
}

async function resolvePublicIp(
  c: OracleCredentials,
  instanceId: string,
): Promise<string | undefined> {
  try {
    const attUrl = `${iaasBase(c.region)}/vnicAttachments/?compartmentId=${encodeURIComponent(
      c.compartmentId,
    )}&instanceId=${encodeURIComponent(instanceId)}`;
    const attRes = await ociFetch(c, 'GET', attUrl);
    if (!attRes.ok) return undefined;
    const attachments = (await attRes.json()) as Array<{ vnicId?: string }>;
    const vnicId = attachments.find((a) => a.vnicId)?.vnicId;
    if (!vnicId) return undefined;

    const vnicRes = await ociFetch(c, 'GET', `${iaasBase(c.region)}/vnics/${vnicId}`);
    if (!vnicRes.ok) return undefined;
    const vnic = (await vnicRes.json()) as { publicIp?: string };
    return vnic.publicIp ?? undefined;
  } catch {
    // VNIC not ready yet — acceptable in v1 (spec §4.1).
    return undefined;
  }
}

async function status(ref: ProviderRef): Promise<ProviderStatus> {
  const c = await creds();
  const res = await ociFetch(c, 'GET', `${iaasBase(c.region)}/instances/${ref.instanceId}`);
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  const instance = (await res.json()) as { lifecycleState: string };
  const state = mapState(instance.lifecycleState);
  const ip = state === 'running' ? await resolvePublicIp(c, String(ref.instanceId)) : undefined;
  return { state, ip };
}

async function destroy(ref: ProviderRef): Promise<void> {
  const c = await creds();
  const url = `${iaasBase(c.region)}/instances/${ref.instanceId}?preserveBootVolume=false`;
  const res = await ociFetch(c, 'DELETE', url);
  if (res.status === 404) return; // already gone — treat as success
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
}

export const oracleAdapter: ComputeProviderAdapter = {
  provision,
  destroy,
  status,
};
