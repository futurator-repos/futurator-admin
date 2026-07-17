import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { gcpAccessToken } from '../gcp-auth';
import { gcpAdapter } from '../gcp';

vi.mock('../../provider-credentials-sm', () => ({
  getProviderCredentials: vi.fn(),
}));

import { getProviderCredentials } from '../../provider-credentials-sm';

// One RSA keypair for the whole file — used to sign the in-test service-account JWT.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type FetchStub = (
  url: string,
  init?: RequestInit,
) => { status: number; ok: boolean; json: () => Promise<unknown>; text?: () => Promise<string> };

function stubFetch(handler: FetchStub) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  );
}

const OK = (body: unknown, status = 200) => ({ status, ok: true, json: async () => body });
const ERR = (message: string, status = 400) => ({
  status,
  ok: false,
  json: async () => ({ error: { message } }),
  text: async () => message,
});

function saJson(clientEmail: string): string {
  return JSON.stringify({
    client_email: clientEmail,
    private_key: privateKeyPem,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

const CREDS = {
  serviceAccountJson: saJson('sa@my-proj.iam.gserviceaccount.com'),
  projectId: 'my-proj',
  zone: 'europe-west3-a',
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getProviderCredentials).mockReset();
  vi.mocked(getProviderCredentials).mockResolvedValue(CREDS);
});
afterEach(() => vi.unstubAllGlobals());

describe('gcpAccessToken', () => {
  it('exchanges a signed JWT for an access token with correct claims', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    stubFetch((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        capturedUrl = url;
        capturedBody = init?.body as string;
        return OK({ access_token: 'ya29.test-token', expires_in: 3600 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const token = await gcpAccessToken(saJson('claims@x.iam.gserviceaccount.com'));

    expect(token).toBe('ya29.test-token');
    expect(capturedUrl).toBe('https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = params.get('assertion') ?? '';
    const parts = assertion.split('.');
    expect(parts).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    expect(claims.iss).toBe('claims@x.iam.gserviceaccount.com');
    expect(claims.scope).toBe('https://www.googleapis.com/auth/compute');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
  });

  it('caches the token for repeated calls with the same service account', async () => {
    let calls = 0;
    stubFetch((url) => {
      if (url.includes('/token')) {
        calls += 1;
        return OK({ access_token: 'ya29.cached', expires_in: 3600 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const sa = saJson('cache@x.iam.gserviceaccount.com');
    await gcpAccessToken(sa);
    await gcpAccessToken(sa);
    expect(calls).toBe(1);
  });
});

describe('gcpAdapter.provision', () => {
  it('POSTs a GCE instance create with mapped body and returns instanceId+zone', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    stubFetch((url, init) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.prov', expires_in: 3600 });
      capturedUrl = url;
      capturedInit = init;
      return OK({ name: 'operation-1', status: 'RUNNING' });
    });

    const ref = await gcpAdapter.provision({
      serverId: 'srv-gcp-1',
      name: 'gcp-fra-1',
      region: 'europe-west3',
      size: 'e2-small',
      arch: 'x86_64',
      userData: '#!/bin/bash\necho hi',
    });

    expect(capturedUrl).toBe(
      'https://compute.googleapis.com/compute/v1/projects/my-proj/zones/europe-west3-a/instances',
    );
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer ya29.prov',
    );
    const body = JSON.parse(capturedInit?.body as string);
    // The instance name is the slugged label + serverId suffix, never the raw
    // label: GCE rejects anything outside RFC1035 (see naming.test.ts).
    expect(body.name).toBe('gcp-fra-1-srvgcp1');
    expect(body.machineType).toBe('zones/europe-west3-a/machineTypes/e2-small');
    expect(body.disks[0].boot).toBe(true);
    expect(body.disks[0].autoDelete).toBe(true);
    expect(body.disks[0].initializeParams.sourceImage).toBe(
      'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
    );
    expect(body.networkInterfaces[0]).toEqual({
      network: 'global/networks/default',
      accessConfigs: [{}],
    });
    expect(body.metadata.items[0]).toEqual({
      key: 'startup-script',
      value: '#!/bin/bash\necho hi',
    });
    // instanceId MUST be the name we actually created — status/stop/start/
    // destroy address the instance by it.
    expect(ref).toEqual({ instanceId: 'gcp-fra-1-srvgcp1', zone: 'europe-west3-a' });
  });

  it('throws with the API error message on non-2xx', async () => {
    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.x', expires_in: 3600 });
      return ERR('QUOTA_EXCEEDED', 403);
    });

    await expect(
      gcpAdapter.provision({
        serverId: 'srv-gcp-1',
        name: 'gcp-fra-1',
        region: 'europe-west3',
        size: 'e2-small',
        arch: 'x86_64',
        userData: '',
      }),
    ).rejects.toThrow(/QUOTA_EXCEEDED/);
  });
});

describe('gcpAdapter.status', () => {
  it('maps RUNNING -> running and pulls natIP', async () => {
    let capturedUrl = '';
    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.s', expires_in: 3600 });
      capturedUrl = url;
      return OK({
        status: 'RUNNING',
        networkInterfaces: [{ accessConfigs: [{ natIP: '34.1.2.3' }] }],
      });
    });

    const status = await gcpAdapter.status({ instanceId: 'gcp-fra-1', zone: 'europe-west3-a' });
    expect(capturedUrl).toBe(
      'https://compute.googleapis.com/compute/v1/projects/my-proj/zones/europe-west3-a/instances/gcp-fra-1',
    );
    expect(status.state).toBe('running');
    expect(status.ip).toBe('34.1.2.3');
  });

  it('maps PROVISIONING/STAGING -> creating', async () => {
    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.s', expires_in: 3600 });
      return OK({ status: 'PROVISIONING' });
    });
    expect((await gcpAdapter.status({ instanceId: 'gcp-fra-1' })).state).toBe('creating');

    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.s', expires_in: 3600 });
      return OK({ status: 'STAGING' });
    });
    expect((await gcpAdapter.status({ instanceId: 'gcp-fra-1' })).state).toBe('creating');
  });

  it('maps TERMINATED/STOPPING -> stopped', async () => {
    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.s', expires_in: 3600 });
      return OK({ status: 'TERMINATED' });
    });
    expect((await gcpAdapter.status({ instanceId: 'gcp-fra-1' })).state).toBe('stopped');

    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.s', expires_in: 3600 });
      return OK({ status: 'STOPPING' });
    });
    expect((await gcpAdapter.status({ instanceId: 'gcp-fra-1' })).state).toBe('stopped');
  });
});

describe('gcpAdapter.stop / start', () => {
  it('stop POSTs the stop endpoint', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    stubFetch((url, init) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.stop', expires_in: 3600 });
      capturedUrl = url;
      capturedMethod = init?.method ?? '';
      return OK({ status: 'STOPPING' });
    });

    await gcpAdapter.stop?.({ instanceId: 'gcp-fra-1', zone: 'europe-west3-a' });
    expect(capturedUrl).toBe(
      'https://compute.googleapis.com/compute/v1/projects/my-proj/zones/europe-west3-a/instances/gcp-fra-1/stop',
    );
    expect(capturedMethod).toBe('POST');
  });

  it('start POSTs the start endpoint', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    stubFetch((url, init) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.start', expires_in: 3600 });
      capturedUrl = url;
      capturedMethod = init?.method ?? '';
      return OK({ status: 'STAGING' });
    });

    await gcpAdapter.start?.({ instanceId: 'gcp-fra-1', zone: 'europe-west3-a' });
    expect(capturedUrl).toBe(
      'https://compute.googleapis.com/compute/v1/projects/my-proj/zones/europe-west3-a/instances/gcp-fra-1/start',
    );
    expect(capturedMethod).toBe('POST');
  });
});

describe('gcpAdapter.destroy', () => {
  it('DELETEs the instance', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    stubFetch((url, init) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.del', expires_in: 3600 });
      capturedUrl = url;
      capturedMethod = init?.method ?? '';
      return OK({}, 200);
    });

    await gcpAdapter.destroy({ instanceId: 'gcp-fra-1', zone: 'europe-west3-a' });
    expect(capturedUrl).toBe(
      'https://compute.googleapis.com/compute/v1/projects/my-proj/zones/europe-west3-a/instances/gcp-fra-1',
    );
    expect(capturedMethod).toBe('DELETE');
  });

  it('treats a 404 as success (already gone)', async () => {
    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.del', expires_in: 3600 });
      return ERR('instance not found', 404);
    });

    await expect(
      gcpAdapter.destroy({ instanceId: 'gcp-gone', zone: 'europe-west3-a' }),
    ).resolves.toBeUndefined();
  });

  it('throws with the API error message on other non-2xx', async () => {
    stubFetch((url) => {
      if (url.includes('/token')) return OK({ access_token: 'ya29.del', expires_in: 3600 });
      return ERR('forbidden', 403);
    });

    await expect(
      gcpAdapter.destroy({ instanceId: 'gcp-fra-1', zone: 'europe-west3-a' }),
    ).rejects.toThrow(/forbidden/);
  });
});
