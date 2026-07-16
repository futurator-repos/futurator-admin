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

import { provisionServer, destroyServer, refreshProvisioningServers } from '../server-provisioning';
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
