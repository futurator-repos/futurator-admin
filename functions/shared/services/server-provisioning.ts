/**
 * server-provisioning.ts — Servers module Task 15 (spec §4.2 / §4.3 / §11).
 *
 * Async provisioning lifecycle orchestration. The Lambda never waits for a
 * VM: `provisionServer` mints identity (serverId + enrollment token), creates
 * the per-server IAM user, hands the bootstrap cloud-init to the provider
 * adapter, and persists the row as `PROVISIONING` (202 to the UI). The
 * 1-minute sweeper then drives the state machine forward via
 * `refreshProvisioningServers`:
 *
 *   PROVISIONING --(provider reports running)--> BOOTSTRAPPING
 *   BOOTSTRAPPING --(first daemon heartbeat)---> ACTIVE
 *
 * Failures land the row in `ERROR` with a `statusMessage` (UI offers
 * Retry / Destroy). Destroy is full revocation: DELETE the VM at the
 * provider (never stop — Hetzner/Oracle bill stopped VMs), delete the IAM
 * user/keys, invalidate the enrollment token, mark the row `DELETED`.
 */

import crypto from 'node:crypto';
import type { z } from 'zod';
import type { createServerSchema } from '../schemas/servers-schema';
import type { ComputeServer } from '../types/compute-server';
import {
  createServer,
  getServerById,
  listServers,
  updateServerFields,
} from '../repositories/servers-repository';
import { createServerIamUser, deleteServerIamUser } from './server-iam';
import { buildBootstrapScript } from './compute-providers/cloud-init';
import { getAdapter } from './compute-providers';
import type { ProviderRef } from './compute-providers/types';
import { getCatalogEntry, getCatalogSize } from './compute-providers/catalog';
import { getProviderPlacement } from './provider-credentials-sm';
import { hashEnrollToken } from './agent-credentials-relay';
import { AppError, NotFoundError, ValidationError } from '../errors';

export type CreateServerInput = z.infer<typeof createServerSchema>;

export interface ProvisionResult {
  server: ComputeServer;
  /**
   * Local-machine path only: the copy-paste one-liner that starts the daemon
   * on the operator's own box. Carries the RAW enrollment token — this is the
   * only time it ever leaves the process (DynamoDB stores just the hash).
   */
  installCommand?: string;
}

/** Providers with a compute adapter (Task 12–14). `aws`/`local` rows are seeded/local-only. */
const ADAPTER_PROVIDERS = new Set(['hetzner', 'oracle', 'gcp']);

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 6-char lowercase-alphanumeric suffix (nanoid-style, crypto-random). */
function shortId(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/** 32-byte hex enrollment token. Only its sha256 hash is ever persisted. */
function mintEnrollToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * The base URL a fleet server must call back on — it fetches its Claude OAuth
 * credentials from `<base>/api/servers/agent-credentials` at boot.
 *
 * This MUST be the API's own origin, not the site's. `https://hub.futurator.ai`
 * is CloudFront serving the static admin app: it has no /api behaviour, so
 * /api/servers/agent-credentials returns the SPA's index.html with HTTP **200**.
 * `curl -fsS` treats that as success and writes 11KB of HTML into
 * .credentials.json — the daemon then reports "OAuth file missing or
 * unreadable" and every Claude call fails "Not logged in". Observed live.
 *
 * The API cannot read its own Function URL from env (self-reference is circular
 * in the SST/Pulumi graph), so we take the origin of the request that asked us
 * to provision — by definition a URL on which this API is reachable.
 * ADMIN_API_URL still wins if set (e.g. once the API gets a custom domain).
 */
function adminApiUrl(requestOrigin?: string): string {
  return (
    process.env.ADMIN_API_URL ||
    requestOrigin ||
    process.env.ALLOWED_ORIGIN ||
    'https://hub.futurator.ai'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The one-liner the operator runs on a self-managed machine (Mac, desktop):
 * env for identity + enrollment, then the daemon entrypoint. Mirrors the env
 * contract of the cloud-init bootstrap (Task 11) minus the VM setup.
 */
function buildLocalInstallCommand(
  serverId: string,
  enrollToken: string,
  requestOrigin?: string,
): string {
  return (
    `SERVER_ID=${serverId} ENROLL_TOKEN=${enrollToken} ` +
    `ADMIN_API_URL=${adminApiUrl(requestOrigin)} DAEMON_SOURCE=${serverId} ` +
    `node agent-daemon.mjs`
  );
}

/**
 * Cloud leg shared by provision + retry: IAM user → bootstrap script →
 * adapter.provision. Returns the fields to persist. On any failure the
 * just-created IAM user is torn down and the row fields come back as ERROR
 * with a statusMessage — the caller persists either way.
 */
async function runCloudProvision(
  serverId: string,
  enrollToken: string,
  input: Pick<
    CreateServerInput,
    'name' | 'provider' | 'region' | 'size' | 'arch' | 'maxConcurrent'
  >,
  requestOrigin?: string,
): Promise<Pick<ComputeServer, 'status' | 'statusMessage' | 'providerRef' | 'iamUserName'>> {
  let iamUserName: string | undefined;
  try {
    const bundleS3Uri = process.env.DAEMON_BUNDLE_S3_URI;
    if (!bundleS3Uri) {
      throw new Error('DAEMON_BUNDLE_S3_URI env var is not set');
    }
    const iamUser = await createServerIamUser(serverId);
    iamUserName = iamUser.userName;
    const userData = buildBootstrapScript({
      serverId,
      enrollToken,
      adminApiUrl: adminApiUrl(requestOrigin),
      awsAccessKeyId: iamUser.accessKeyId,
      awsSecretAccessKey: iamUser.secretAccessKey,
      awsRegion: process.env.AWS_REGION || 'eu-central-1',
      maxConcurrent: input.maxConcurrent,
      bundleS3Uri,
      arch: input.arch,
    });
    const providerRef = await getAdapter(input.provider).provision({
      serverId,
      name: input.name,
      region: input.region,
      size: input.size,
      arch: input.arch,
      userData,
    });
    return { status: 'PROVISIONING', statusMessage: '', providerRef, iamUserName };
  } catch (err) {
    if (iamUserName) {
      try {
        await deleteServerIamUser(iamUserName);
      } catch (cleanupErr) {
        console.error(
          `[server-provisioning] IAM cleanup for ${iamUserName} failed:`,
          errorMessage(cleanupErr),
        );
      }
    }
    return {
      status: 'ERROR',
      statusMessage: errorMessage(err),
      providerRef: {},
      iamUserName: undefined,
    };
  }
}

/**
 * Validate a create request against the provider catalog and resolve the two
 * fields the client must not be trusted to set, BEFORE any IAM user is minted
 * or any VM is billed:
 *
 *  - `arch` follows the shape. A CAX11 (ARM) asked for as x86_64 would get an
 *    x86 awscli in its cloud-init and boot broken.
 *  - `region` for Oracle/GCP comes from the stored credentials, because their
 *    adapters read `credentials.region` / `credentials.zone` and ignore the
 *    per-server value. Accepting the client's guess would make the fleet card
 *    claim a location the VM isn't in.
 *
 * Also rejects providers with no adapter (`aws` — EC2 is IaC, seeded as
 * srv_ec2_main) and service types the catalog marks unavailable (Cloud Run
 * Jobs), which would otherwise fail deep in `getAdapter` after side effects.
 */
async function resolveAgainstCatalog(
  input: CreateServerInput,
): Promise<{ region: string; arch: 'arm64' | 'x86_64' }> {
  const entry = getCatalogEntry(input.provider);
  if (!entry || !entry.creatable) {
    throw new ValidationError(
      entry?.unavailableNote ?? `Provider ${input.provider} cannot be provisioned`,
    );
  }
  const serviceType = entry.serviceTypes.find((s) => s.type === input.serviceType);
  if (!serviceType?.available) {
    throw new ValidationError(
      serviceType?.note ?? `${entry.label} does not offer ${input.serviceType} yet`,
    );
  }

  if (input.serviceType === 'local-machine') {
    return { region: 'local', arch: input.arch };
  }

  const size = getCatalogSize(input.provider, input.size);
  if (!size) {
    const known = entry.sizes.map((s) => s.value).join(', ');
    throw new ValidationError(
      `Unknown ${entry.label} size "${input.size}" (expected one of: ${known})`,
    );
  }

  if (entry.regionSource === 'credentials') {
    const placement = await getProviderPlacement(input.provider);
    const region = placement?.zone ?? placement?.region;
    if (!region) {
      throw new ValidationError(
        `${entry.label} credentials are missing a ${input.provider === 'gcp' ? 'zone' : 'region'} — re-save them before provisioning`,
      );
    }
    return { region, arch: size.arch };
  }

  if (!entry.regions.some((r) => r.value === input.region)) {
    const known = entry.regions.map((r) => r.value).join(', ');
    throw new ValidationError(
      `Unknown ${entry.label} region "${input.region}" (expected one of: ${known})`,
    );
  }
  return { region: input.region, arch: size.arch };
}

/**
 * Create + provision a server (spec §4.2 step 1 — seconds, never waits for
 * the VM). Local-machine path: no cloud call; the row starts at
 * `BOOTSTRAPPING` and the result carries the install one-liner. Cloud path:
 * IAM user → cloud-init → adapter.provision → `PROVISIONING` row; on adapter
 * failure the row is saved as `ERROR` (with cleanup) instead of throwing so
 * the UI can offer Retry / Destroy.
 */
export async function provisionServer(
  input: CreateServerInput,
  opts: { requestOrigin?: string } = {},
): Promise<ProvisionResult> {
  const resolved = await resolveAgainstCatalog(input);
  const serverId = `srv_${input.provider}_${shortId()}`;
  const enrollToken = mintEnrollToken();
  const nowIso = new Date().toISOString();
  const base: ComputeServer = {
    serverId,
    name: input.name,
    provider: input.provider,
    serviceType: input.serviceType,
    region: resolved.region,
    size: input.size,
    arch: resolved.arch,
    status: 'BOOTSTRAPPING',
    enabled: true,
    maxConcurrent: input.maxConcurrent,
    costPerHour: input.costPerHour,
    providerRef: {},
    enrollTokenHash: hashEnrollToken(enrollToken),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (input.serviceType === 'local-machine') {
    await createServer(base);
    return {
      server: base,
      installCommand: buildLocalInstallCommand(serverId, enrollToken, opts.requestOrigin),
    };
  }

  const outcome = await runCloudProvision(
    serverId,
    enrollToken,
    { ...input, region: resolved.region, arch: resolved.arch },
    opts.requestOrigin,
  );
  const server: ComputeServer = { ...base, ...outcome };
  await createServer(server);
  return { server };
}

async function requireServer(serverId: string): Promise<ComputeServer> {
  const server = await getServerById(serverId);
  if (!server || server.status === 'DELETED') {
    throw new NotFoundError('Server', serverId);
  }
  return server;
}

/**
 * Full revocation (spec §4.3): DEPROVISIONING → DELETE the VM at the
 * provider → delete the per-server IAM user → row `DELETED` with the
 * enrollment token invalidated. Idempotent-ish: re-running after a partial
 * failure resumes from DEPROVISIONING.
 */
export async function destroyServer(serverId: string): Promise<void> {
  const server = await requireServer(serverId);
  await updateServerFields(serverId, { status: 'DEPROVISIONING' });
  if (ADAPTER_PROVIDERS.has(server.provider) && server.providerRef?.instanceId) {
    await getAdapter(server.provider).destroy(server.providerRef);
  }
  if (server.iamUserName) {
    await deleteServerIamUser(server.iamUserName);
  }
  await updateServerFields(serverId, { status: 'DELETED', enrollTokenHash: 'REVOKED' });
}

/**
 * Re-run provisioning for an `ERROR` row (spec §4.2 step 4): fresh enrollment
 * token + fresh IAM keys, same serverId. Local-machine rows just re-mint the
 * token and hand back a new install command.
 */
export async function retryServer(
  serverId: string,
  opts: { requestOrigin?: string } = {},
): Promise<ProvisionResult> {
  const server = await requireServer(serverId);
  if (server.status !== 'ERROR') {
    throw new AppError(
      'INVALID_STATE',
      `Server '${serverId}' is not in ERROR (status ${server.status}) — nothing to retry`,
      409,
    );
  }
  const enrollToken = mintEnrollToken();

  if (server.serviceType === 'local-machine') {
    const fields: Partial<ComputeServer> = {
      status: 'BOOTSTRAPPING',
      statusMessage: '',
      enrollTokenHash: hashEnrollToken(enrollToken),
    };
    await updateServerFields(serverId, fields);
    return {
      server: { ...server, ...fields } as ComputeServer,
      installCommand: buildLocalInstallCommand(serverId, enrollToken, opts.requestOrigin),
    };
  }

  // Tear down any stale IAM user from the failed attempt before re-keying.
  if (server.iamUserName) {
    await deleteServerIamUser(server.iamUserName);
  }
  const outcome = await runCloudProvision(serverId, enrollToken, server, opts.requestOrigin);
  const fields: Partial<ComputeServer> = {
    ...outcome,
    enrollTokenHash: hashEnrollToken(enrollToken),
  };
  await updateServerFields(serverId, fields);
  return { server: { ...server, ...fields } as ComputeServer };
}

/**
 * Sweeper-driven state refresh (spec §4.2 steps 2–3). For `PROVISIONING`
 * rows: ask the provider; `running` flips the row to `BOOTSTRAPPING` (+ip).
 * For `BOOTSTRAPPING` rows: the first daemon heartbeat (Task 18 writes
 * `lastHeartbeatAt`) closes the loop to `ACTIVE`. Provider `status()`
 * failures are logged and skipped — never flap server state on an outage
 * (spec §11).
 */
export async function refreshProvisioningServers(): Promise<void> {
  const servers = await listServers();
  for (const server of servers) {
    if (server.status === 'PROVISIONING' && ADAPTER_PROVIDERS.has(server.provider)) {
      try {
        const status = await getAdapter(server.provider).status(server.providerRef);
        if (status.state === 'running') {
          const providerRef: ProviderRef = {
            ...server.providerRef,
            ...(status.ip ? { ip: status.ip } : {}),
          };
          await updateServerFields(server.serverId, { status: 'BOOTSTRAPPING', providerRef });
        }
      } catch (err) {
        console.warn(
          `[server-provisioning] status refresh for ${server.serverId} failed:`,
          errorMessage(err),
        );
      }
    } else if (server.status === 'BOOTSTRAPPING' && server.lastHeartbeatAt) {
      await updateServerFields(server.serverId, { status: 'ACTIVE' });
    }
  }
}

/**
 * Capability-gated billing pause (spec §4.1 — GCP only; Hetzner/Oracle bill
 * stopped VMs so their adapters deliberately have no stop/start). 404-style
 * error when the provider lacks the capability.
 */
/**
 * Toggle a server's participation in dispatch, and — where the provider can
 * actually pause billing — its machine too.
 *
 * Only GCP's adapter implements stop/start, and GCP stop pauses compute
 * billing. Hetzner and Oracle bill stopped instances at full price, so for
 * them "disabled" is a dispatch decision only; the UI says so rather than
 * implying scale-to-zero (destroying is the way to stop cost there).
 *
 * `enabled` is persisted BEFORE any provider call: the dispatcher must stop
 * assigning work immediately, even if the stop API is having a bad day. A
 * failed stop is reported in `statusMessage`, never swallowed — a machine you
 * think is paused but isn't is exactly the surprise-bill case.
 */
export async function setServerEnabled(
  serverId: string,
  enabled: boolean,
): Promise<{ server: ComputeServer; vmAction: 'stopped' | 'started' | 'none' }> {
  const server = await requireServer(serverId);
  await updateServerFields(serverId, { enabled });

  const adapter = ADAPTER_PROVIDERS.has(server.provider) ? getAdapter(server.provider) : undefined;
  const canPause = Boolean(adapter?.stop && adapter?.start);
  if (!canPause || server.serviceType !== 'vm') {
    return { server: { ...server, enabled }, vmAction: 'none' };
  }

  try {
    if (!enabled && (server.status === 'ACTIVE' || server.status === 'BOOTSTRAPPING')) {
      await adapter!.stop!(server.providerRef);
      await updateServerFields(serverId, { status: 'PAUSED', statusMessage: '' });
      return { server: { ...server, enabled, status: 'PAUSED' }, vmAction: 'stopped' };
    }
    if (enabled && server.status === 'PAUSED') {
      await adapter!.start!(server.providerRef);
      await updateServerFields(serverId, { status: 'BOOTSTRAPPING', statusMessage: '' });
      return { server: { ...server, enabled, status: 'BOOTSTRAPPING' }, vmAction: 'started' };
    }
  } catch (err) {
    const action = enabled ? 'start' : 'stop';
    const message = `${action} failed: ${errorMessage(err)}`;
    await updateServerFields(serverId, { statusMessage: message });
    throw new AppError('PROVIDER_ERROR', message, 502);
  }
  return { server: { ...server, enabled }, vmAction: 'none' };
}

export async function stopServer(serverId: string): Promise<ComputeServer> {
  const server = await requireServer(serverId);
  const adapter = ADAPTER_PROVIDERS.has(server.provider) ? getAdapter(server.provider) : undefined;
  if (!adapter?.stop) {
    throw new AppError('NOT_SUPPORTED', `Provider '${server.provider}' does not support stop`, 404);
  }
  await adapter.stop(server.providerRef);
  await updateServerFields(serverId, { status: 'PAUSED' });
  return { ...server, status: 'PAUSED' };
}

/** Restart a paused (GCP) server; the daemon's first heartbeat re-activates it. */
export async function startServer(serverId: string): Promise<ComputeServer> {
  const server = await requireServer(serverId);
  const adapter = ADAPTER_PROVIDERS.has(server.provider) ? getAdapter(server.provider) : undefined;
  if (!adapter?.start) {
    throw new AppError(
      'NOT_SUPPORTED',
      `Provider '${server.provider}' does not support start`,
      404,
    );
  }
  await adapter.start(server.providerRef);
  await updateServerFields(serverId, { status: 'BOOTSTRAPPING' });
  return { ...server, status: 'BOOTSTRAPPING' };
}
