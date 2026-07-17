import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Collaborator mocks (Task 15 tests mock everything from Tasks 3, 10, 11,
// 12–14 — the service under test is pure orchestration) ──────────────────────

const repo = vi.hoisted(() => ({
  createServer: vi.fn(),
  getServerById: vi.fn(),
  listServers: vi.fn(),
  updateServerFields: vi.fn(),
}));
vi.mock('../../repositories/servers-repository', () => repo);

const iam = vi.hoisted(() => ({
  createServerIamUser: vi.fn(),
  deleteServerIamUser: vi.fn(),
}));
vi.mock('../server-iam', () => iam);

const cloudInit = vi.hoisted(() => ({ buildBootstrapScript: vi.fn() }));
vi.mock('../compute-providers/cloud-init', () => cloudInit);

const adapters = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock('../compute-providers', () => adapters);

const credentialsSm = vi.hoisted(() => ({ getProviderPlacement: vi.fn() }));
vi.mock('../provider-credentials-sm', () => credentialsSm);

import {
  provisionServer,
  destroyServer,
  refreshProvisioningServers,
  setServerEnabled,
} from '../server-provisioning';
import { hashEnrollToken } from '../agent-credentials-relay';
import type { ComputeServer } from '../../types/compute-server';

const cloudRow = (overrides: Partial<ComputeServer> = {}): ComputeServer =>
  ({
    serverId: 'srv_hetzner_abc123',
    name: 'hetzner-fsn-1',
    provider: 'hetzner',
    serviceType: 'vm',
    region: 'fsn1',
    size: 'cax11',
    arch: 'arm64',
    status: 'ACTIVE',
    enabled: true,
    maxConcurrent: 2,
    costPerHour: 0.008,
    providerRef: { instanceId: '123' },
    enrollTokenHash: 'h1',
    iamUserName: 'futurator-server-srv_hetzner_abc123',
    createdAt: '2026-07-16T00:00:00Z',
    updatedAt: '2026-07-16T00:00:00Z',
    ...overrides,
  }) as ComputeServer;

const provisionInput = {
  name: 'hetzner-fsn-1',
  provider: 'hetzner',
  serviceType: 'vm',
  region: 'fsn1',
  size: 'cax11',
  arch: 'arm64',
  maxConcurrent: 2,
  costPerHour: 0.008,
} as const;

const iamCreds = {
  userName: 'futurator-server-srv_hetzner_abc123',
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'SECRET_TEST',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DAEMON_BUNDLE_S3_URI = 's3://bundle-bucket/daemon/';
  process.env.AWS_REGION = 'eu-central-1';
});

describe('adminApiUrl in the bootstrap — must be the API, never the site', () => {
  // Live failure: the cloud-init curled https://hub.futurator.ai/api/servers/
  // agent-credentials. That host is CloudFront serving the static SPA — it has
  // no /api behaviour, so it answered 200 with index.html. `curl -fsS` called
  // that success and wrote 11KB of HTML into .credentials.json; the daemon then
  // said "OAuth file missing or unreadable" and every Claude call failed
  // "Not logged in", while the fleet card cheerfully showed ACTIVE.
  const LAMBDA_ORIGIN = 'https://3hc6clgy32vtbd5xtmbpfjzase0ajqqq.lambda-url.eu-central-1.on.aws';

  beforeEach(() => {
    delete process.env.ADMIN_API_URL;
    delete process.env.ALLOWED_ORIGIN;
  });

  it('bakes the requesting origin (the real API) into the bootstrap', async () => {
    adapters.getAdapter.mockReturnValue({
      provision: vi.fn().mockResolvedValue({ instanceId: '1' }),
    });
    iam.createServerIamUser.mockResolvedValue(iamCreds);
    cloudInit.buildBootstrapScript.mockReturnValue('#!/bin/bash');
    repo.createServer.mockResolvedValue(undefined);

    await provisionServer({ ...provisionInput }, { requestOrigin: LAMBDA_ORIGIN });

    const opts = cloudInit.buildBootstrapScript.mock.calls[0][0];
    expect(opts.adminApiUrl).toBe(LAMBDA_ORIGIN);
    expect(opts.adminApiUrl).not.toContain('hub.futurator.ai');
  });

  it('local install command points at the API origin too', async () => {
    repo.createServer.mockResolvedValue(undefined);

    const result = await provisionServer(
      {
        name: 'my-mac',
        provider: 'local',
        serviceType: 'local-machine',
        region: 'local',
        size: 'mac',
        arch: 'arm64',
        maxConcurrent: 2,
        costPerHour: 0,
      },
      { requestOrigin: LAMBDA_ORIGIN },
    );

    expect(result.installCommand).toContain(`ADMIN_API_URL=${LAMBDA_ORIGIN}`);
  });

  it('an explicit ADMIN_API_URL still wins (custom API domain later)', async () => {
    process.env.ADMIN_API_URL = 'https://api.futurator.ai';
    adapters.getAdapter.mockReturnValue({
      provision: vi.fn().mockResolvedValue({ instanceId: '1' }),
    });
    iam.createServerIamUser.mockResolvedValue(iamCreds);
    cloudInit.buildBootstrapScript.mockReturnValue('#!/bin/bash');
    repo.createServer.mockResolvedValue(undefined);

    await provisionServer({ ...provisionInput }, { requestOrigin: LAMBDA_ORIGIN });

    expect(cloudInit.buildBootstrapScript.mock.calls[0][0].adminApiUrl).toBe(
      'https://api.futurator.ai',
    );
  });
});

describe('setServerEnabled — the toggle means what the card says', () => {
  it('GCP: disabling stops the VM (billing pauses) and parks it PAUSED', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    repo.getServerById.mockResolvedValue(
      cloudRow({ provider: 'gcp', serviceType: 'vm', status: 'ACTIVE', enabled: true }),
    );
    adapters.getAdapter.mockReturnValue({ stop, start: vi.fn() });

    const { vmAction, server } = await setServerEnabled('srv_gcp_1', false);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(vmAction).toBe('stopped');
    expect(server.status).toBe('PAUSED');
  });

  it('GCP: enabling a PAUSED server starts it again', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    repo.getServerById.mockResolvedValue(
      cloudRow({ provider: 'gcp', serviceType: 'vm', status: 'PAUSED', enabled: false }),
    );
    adapters.getAdapter.mockReturnValue({ stop: vi.fn(), start });

    const { vmAction, server } = await setServerEnabled('srv_gcp_1', true);

    expect(start).toHaveBeenCalledTimes(1);
    expect(vmAction).toBe('started');
    expect(server.status).toBe('BOOTSTRAPPING');
  });

  it('Hetzner: disabling touches no VM — stopping there still bills, so Destroy is the lever', async () => {
    const stop = vi.fn();
    repo.getServerById.mockResolvedValue(
      cloudRow({ provider: 'hetzner', serviceType: 'vm', status: 'ACTIVE', enabled: true }),
    );
    // The hetzner adapter has no stop/start capability at all.
    adapters.getAdapter.mockReturnValue({ provision: vi.fn(), destroy: vi.fn(), status: vi.fn() });

    const { vmAction, server } = await setServerEnabled('srv_hetzner_1', false);

    expect(stop).not.toHaveBeenCalled();
    expect(vmAction).toBe('none');
    expect(server.status).toBe('ACTIVE'); // still running, still billing — honestly reported
    expect(server.enabled).toBe(false); // but the dispatcher skips it
  });

  it('persists enabled BEFORE calling the provider, so a failed stop still halts dispatch', async () => {
    repo.getServerById.mockResolvedValue(
      cloudRow({ provider: 'gcp', serviceType: 'vm', status: 'ACTIVE', enabled: true }),
    );
    adapters.getAdapter.mockReturnValue({
      stop: vi.fn().mockRejectedValue(new Error('GCP is having a bad day')),
      start: vi.fn(),
    });

    await expect(setServerEnabled('srv_gcp_1', false)).rejects.toThrow(/stop failed/i);

    // enabled:false was written first — the dispatcher must not keep sending work.
    expect(repo.updateServerFields).toHaveBeenNthCalledWith(1, 'srv_gcp_1', { enabled: false });
    // and the failure is recorded, never swallowed (a box you think is paused
    // but isn't is exactly the surprise-bill case).
    const messages = repo.updateServerFields.mock.calls.map((c) => c[1]?.statusMessage);
    expect(messages.some((m?: string) => m?.includes('bad day'))).toBe(true);
  });
});

describe('provisionServer — catalog guards (reject BEFORE any side effect)', () => {
  it('rejects a provider with no adapter (aws) instead of failing after minting IAM', async () => {
    await expect(
      provisionServer({ ...provisionInput, provider: 'aws', size: 't4g.small' }),
    ).rejects.toThrow(/IaC|cannot be provisioned/i);
    expect(iam.createServerIamUser).not.toHaveBeenCalled();
    expect(repo.createServer).not.toHaveBeenCalled();
  });

  it('rejects a service type the catalog marks unavailable (GCP Cloud Run Jobs)', async () => {
    // `createServerSchema` already refuses 'serverless' at the API boundary —
    // this pins the service-layer guard behind it (defence in depth), hence the
    // cast past the schema-derived input type.
    await expect(
      provisionServer({
        ...provisionInput,
        provider: 'gcp',
        serviceType: 'serverless',
        size: 'e2-small',
      } as unknown as Parameters<typeof provisionServer>[0]),
    ).rejects.toThrow(/v2|does not offer/i);
    expect(iam.createServerIamUser).not.toHaveBeenCalled();
  });

  it('rejects an unknown shape rather than asking the provider to build it', async () => {
    await expect(provisionServer({ ...provisionInput, size: 'cax99' })).rejects.toThrow(
      /Unknown .* size/i,
    );
    expect(iam.createServerIamUser).not.toHaveBeenCalled();
  });

  it('rejects an unknown region for a provider that honours per-server regions', async () => {
    await expect(provisionServer({ ...provisionInput, region: 'mars1' })).rejects.toThrow(
      /Unknown .* region/i,
    );
  });

  it('derives arch from the shape — a client claiming x86_64 for an ARM box is corrected', async () => {
    const provision = vi.fn().mockResolvedValue({ instanceId: '999' });
    adapters.getAdapter.mockReturnValue({ provision });
    iam.createServerIamUser.mockResolvedValue(iamCreds);
    cloudInit.buildBootstrapScript.mockReturnValue('#!/bin/bash');
    repo.createServer.mockResolvedValue(undefined);

    // cax11 is Ampere ARM; the request lies about it.
    const result = await provisionServer({ ...provisionInput, arch: 'x86_64' });

    expect(result.server.arch).toBe('arm64');
    // The cloud-init that installs an arch-specific awscli must follow the shape.
    expect(cloudInit.buildBootstrapScript.mock.calls[0][0].arch).toBe('arm64');
    expect(provision.mock.calls[0][0].arch).toBe('arm64');
  });

  it('stamps Oracle rows with the credentials region — the adapter ignores per-server regions', async () => {
    const provision = vi.fn().mockResolvedValue({ instanceId: 'ocid1.instance' });
    adapters.getAdapter.mockReturnValue({ provision });
    iam.createServerIamUser.mockResolvedValue(iamCreds);
    cloudInit.buildBootstrapScript.mockReturnValue('#!/bin/bash');
    repo.createServer.mockResolvedValue(undefined);
    credentialsSm.getProviderPlacement.mockResolvedValue({ region: 'eu-frankfurt-1' });

    const result = await provisionServer({
      ...provisionInput,
      provider: 'oracle',
      size: 'VM.Standard.A1.Flex',
      region: 'somewhere-else-1', // client guess — must not survive
    });

    expect(result.server.region).toBe('eu-frankfurt-1');
  });

  it('refuses to provision Oracle when its stored credentials carry no region', async () => {
    credentialsSm.getProviderPlacement.mockResolvedValue(null);
    await expect(
      provisionServer({ ...provisionInput, provider: 'oracle', size: 'VM.Standard.A1.Flex' }),
    ).rejects.toThrow(/re-save/i);
    expect(iam.createServerIamUser).not.toHaveBeenCalled();
  });
});

describe('provisionServer — cloud path', () => {
  it('runs IAM → bootstrap → adapter.provision → PROVISIONING row, in order', async () => {
    const provision = vi.fn().mockResolvedValue({ instanceId: '999', ip: '1.2.3.4' });
    adapters.getAdapter.mockReturnValue({ provision });
    iam.createServerIamUser.mockResolvedValue(iamCreds);
    cloudInit.buildBootstrapScript.mockReturnValue('#!/bin/bash\necho boot');
    repo.createServer.mockResolvedValue(undefined);

    const result = await provisionServer({ ...provisionInput });

    // serverId minted as srv_<provider>_<6 chars>
    expect(result.server.serverId).toMatch(/^srv_hetzner_[a-z0-9]{6}$/);
    // IAM user created for that serverId
    expect(iam.createServerIamUser).toHaveBeenCalledWith(result.server.serverId);
    // bootstrap script built with the IAM keys + enroll token + bundle URI
    const bootOpts = cloudInit.buildBootstrapScript.mock.calls[0][0];
    expect(bootOpts.serverId).toBe(result.server.serverId);
    expect(bootOpts.awsAccessKeyId).toBe('AKIA_TEST');
    expect(bootOpts.awsSecretAccessKey).toBe('SECRET_TEST');
    expect(bootOpts.bundleS3Uri).toBe('s3://bundle-bucket/daemon/');
    expect(bootOpts.maxConcurrent).toBe(2);
    expect(bootOpts.arch).toBe('arm64');
    // the raw token is never stored — only its sha256 hash lands on the row
    expect(result.server.enrollTokenHash).toBe(hashEnrollToken(bootOpts.enrollToken));
    expect(result.server.enrollTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bootOpts.enrollToken).toMatch(/^[0-9a-f]{64}$/); // 32-byte hex
    // adapter got the userData
    expect(adapters.getAdapter).toHaveBeenCalledWith('hetzner');
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: result.server.serverId,
        name: 'hetzner-fsn-1',
        region: 'fsn1',
        size: 'cax11',
        arch: 'arm64',
        userData: '#!/bin/bash\necho boot',
      }),
    );
    // row persisted as PROVISIONING with the providerRef + IAM user name
    const saved = repo.createServer.mock.calls[0][0] as ComputeServer;
    expect(saved.status).toBe('PROVISIONING');
    expect(saved.providerRef).toEqual({ instanceId: '999', ip: '1.2.3.4' });
    expect(saved.iamUserName).toBe(iamCreds.userName);
    expect(result.server).toEqual(saved);
    expect(result.installCommand).toBeUndefined();
    // order-of-operations: IAM before bootstrap before provision before save
    const order = [
      iam.createServerIamUser.mock.invocationCallOrder[0],
      cloudInit.buildBootstrapScript.mock.invocationCallOrder[0],
      provision.mock.invocationCallOrder[0],
      repo.createServer.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // no cleanup on success
    expect(iam.deleteServerIamUser).not.toHaveBeenCalled();
  });

  it('adapter failure → ERROR row with statusMessage + IAM user cleaned up', async () => {
    const provision = vi.fn().mockRejectedValue(new Error('out of capacity'));
    adapters.getAdapter.mockReturnValue({ provision });
    iam.createServerIamUser.mockResolvedValue(iamCreds);
    cloudInit.buildBootstrapScript.mockReturnValue('#!/bin/bash');
    repo.createServer.mockResolvedValue(undefined);

    const result = await provisionServer({ ...provisionInput });

    expect(result.server.status).toBe('ERROR');
    expect(result.server.statusMessage).toContain('out of capacity');
    const saved = repo.createServer.mock.calls[0][0] as ComputeServer;
    expect(saved.status).toBe('ERROR');
    expect(iam.deleteServerIamUser).toHaveBeenCalledWith(iamCreds.userName);
  });
});

describe('provisionServer — local path', () => {
  it('makes no cloud calls and returns an install command containing the token', async () => {
    repo.createServer.mockResolvedValue(undefined);

    const result = await provisionServer({
      name: 'my-mac',
      provider: 'local',
      serviceType: 'local-machine',
      region: 'local',
      size: 'mac',
      arch: 'arm64',
      maxConcurrent: 3,
      costPerHour: 0,
    });

    expect(iam.createServerIamUser).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
    expect(cloudInit.buildBootstrapScript).not.toHaveBeenCalled();
    expect(result.server.status).toBe('BOOTSTRAPPING');
    expect(result.server.serverId).toMatch(/^srv_local_[a-z0-9]{6}$/);
    expect(result.installCommand).toBeDefined();
    expect(result.installCommand).toContain(result.server.serverId);
    // the install command carries the RAW token whose hash is on the row
    const rawToken = /ENROLL_TOKEN=([0-9a-f]{64})/.exec(result.installCommand ?? '')?.[1];
    expect(rawToken).toBeDefined();
    expect(hashEnrollToken(rawToken as string)).toBe(result.server.enrollTokenHash);
    const saved = repo.createServer.mock.calls[0][0] as ComputeServer;
    expect(saved.status).toBe('BOOTSTRAPPING');
  });
});

describe('destroyServer', () => {
  it('runs the revocation trio: adapter.destroy + IAM delete + DELETED/REVOKED row', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    adapters.getAdapter.mockReturnValue({ destroy });
    repo.getServerById.mockResolvedValue(cloudRow());
    repo.updateServerFields.mockResolvedValue(undefined);
    iam.deleteServerIamUser.mockResolvedValue(undefined);

    await destroyServer('srv_hetzner_abc123');

    // status flips to DEPROVISIONING first
    expect(repo.updateServerFields.mock.calls[0]).toEqual([
      'srv_hetzner_abc123',
      expect.objectContaining({ status: 'DEPROVISIONING' }),
    ]);
    expect(destroy).toHaveBeenCalledWith({ instanceId: '123' });
    expect(iam.deleteServerIamUser).toHaveBeenCalledWith('futurator-server-srv_hetzner_abc123');
    const finalCall = repo.updateServerFields.mock.calls.at(-1);
    expect(finalCall?.[1]).toEqual(
      expect.objectContaining({ status: 'DELETED', enrollTokenHash: 'REVOKED' }),
    );
  });

  it('skips the provider call for local-machine rows but still revokes', async () => {
    repo.getServerById.mockResolvedValue(
      cloudRow({
        serverId: 'srv_local_zzz111',
        provider: 'local',
        serviceType: 'local-machine',
        providerRef: {},
        iamUserName: undefined,
      }),
    );
    repo.updateServerFields.mockResolvedValue(undefined);

    await destroyServer('srv_local_zzz111');

    expect(adapters.getAdapter).not.toHaveBeenCalled();
    expect(iam.deleteServerIamUser).not.toHaveBeenCalled();
    const finalCall = repo.updateServerFields.mock.calls.at(-1);
    expect(finalCall?.[1]).toEqual(
      expect.objectContaining({ status: 'DELETED', enrollTokenHash: 'REVOKED' }),
    );
  });
});

describe('refreshProvisioningServers', () => {
  it('flips PROVISIONING+running → BOOTSTRAPPING (+ip) and BOOTSTRAPPING+heartbeat → ACTIVE', async () => {
    const status = vi.fn().mockResolvedValue({ state: 'running', ip: '5.6.7.8' });
    adapters.getAdapter.mockReturnValue({ status });
    repo.listServers.mockResolvedValue([
      cloudRow({ serverId: 'srv_a', status: 'PROVISIONING', providerRef: { instanceId: '1' } }),
      cloudRow({
        serverId: 'srv_b',
        status: 'BOOTSTRAPPING',
        lastHeartbeatAt: '2026-07-16T00:01:00Z',
      }),
      // BOOTSTRAPPING without a heartbeat: untouched
      cloudRow({ serverId: 'srv_c', status: 'BOOTSTRAPPING', lastHeartbeatAt: undefined }),
      // ACTIVE row: untouched
      cloudRow({ serverId: 'srv_d', status: 'ACTIVE' }),
    ]);
    repo.updateServerFields.mockResolvedValue(undefined);

    await refreshProvisioningServers();

    expect(status).toHaveBeenCalledWith({ instanceId: '1' });
    const updates = repo.updateServerFields.mock.calls;
    expect(updates).toHaveLength(2);
    expect(updates[0][0]).toBe('srv_a');
    expect(updates[0][1]).toEqual(
      expect.objectContaining({
        status: 'BOOTSTRAPPING',
        providerRef: { instanceId: '1', ip: '5.6.7.8' },
      }),
    );
    expect(updates[1]).toEqual(['srv_b', expect.objectContaining({ status: 'ACTIVE' })]);
  });

  it('does not flip a PROVISIONING row that is still creating', async () => {
    const status = vi.fn().mockResolvedValue({ state: 'creating' });
    adapters.getAdapter.mockReturnValue({ status });
    repo.listServers.mockResolvedValue([cloudRow({ serverId: 'srv_a', status: 'PROVISIONING' })]);

    await refreshProvisioningServers();

    expect(repo.updateServerFields).not.toHaveBeenCalled();
  });

  it('tolerates adapter.status failures without flapping server state', async () => {
    const status = vi.fn().mockRejectedValue(new Error('provider outage'));
    adapters.getAdapter.mockReturnValue({ status });
    repo.listServers.mockResolvedValue([
      cloudRow({ serverId: 'srv_a', status: 'PROVISIONING' }),
      cloudRow({
        serverId: 'srv_b',
        status: 'BOOTSTRAPPING',
        lastHeartbeatAt: '2026-07-16T00:01:00Z',
      }),
    ]);
    repo.updateServerFields.mockResolvedValue(undefined);

    await expect(refreshProvisioningServers()).resolves.toBeUndefined();
    // the outage on srv_a does not stop srv_b from activating
    expect(repo.updateServerFields).toHaveBeenCalledWith(
      'srv_b',
      expect.objectContaining({ status: 'ACTIVE' }),
    );
  });
});
