import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { oracleAdapter } from '../oracle';

vi.mock('../../provider-credentials-sm', () => ({
  getProviderCredentials: vi.fn(),
}));

import { getProviderCredentials } from '../../provider-credentials-sm';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const ORACLE_CREDS = {
  tenancyOcid: 'ocid1.tenancy.oc1..aaa',
  userOcid: 'ocid1.user.oc1..bbb',
  fingerprint: 'aa:bb:cc:dd',
  privateKeyPem,
  compartmentId: 'ocid1.compartment.oc1..ccc',
  region: 'eu-frankfurt-1',
  imageId: 'ocid1.image.oc1.eu-frankfurt-1.ddd',
  availabilityDomains: ['AD-1', 'AD-2', 'AD-3'],
};

type FetchResult = { status: number; ok: boolean; json: () => Promise<unknown> };
type FetchStub = (url: string, init?: RequestInit) => FetchResult;

function stubFetch(handler: FetchStub) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  );
}

const OK = (body: unknown, status = 200): FetchResult => ({
  status,
  ok: true,
  json: async () => body,
});
const ERR = (body: unknown, status = 500): FetchResult => ({
  status,
  ok: false,
  json: async () => body,
});

const SPEC = {
  serverId: 'srv-1',
  name: 'oracle-fra-1',
  region: 'eu-frankfurt-1',
  size: 'VM.Standard.A1.Flex',
  arch: 'arm64' as const,
  userData: '#!/bin/bash\necho hi',
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getProviderCredentials).mockReset();
  vi.mocked(getProviderCredentials).mockResolvedValue(ORACLE_CREDS);
});
afterEach(() => vi.unstubAllGlobals());

describe('oracleAdapter.provision', () => {
  it('POSTs the launch-instance body to the region iaas endpoint with the first AD', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return OK({ id: 'ocid1.instance.oc1..zzz', lifecycleState: 'PROVISIONING' });
    });

    const ref = await oracleAdapter.provision(SPEC);

    expect(capturedUrl).toBe('https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances/');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Signature version="1"/);
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      availabilityDomain: 'AD-1',
      compartmentId: ORACLE_CREDS.compartmentId,
      shape: 'VM.Standard.A1.Flex',
      shapeConfig: { ocpus: 2, memoryInGBs: 12 },
      displayName: 'oracle-fra-1',
      sourceDetails: { sourceType: 'image', imageId: ORACLE_CREDS.imageId },
      metadata: { user_data: Buffer.from(SPEC.userData).toString('base64') },
    });
    expect(ref).toEqual({
      instanceId: 'ocid1.instance.oc1..zzz',
      availabilityDomain: 'AD-1',
      ip: undefined,
    });
  });

  it('retries the next AD when one is out of host capacity', async () => {
    const seenADs: string[] = [];
    stubFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      seenADs.push(body.availabilityDomain);
      if (body.availabilityDomain === 'AD-1') {
        return ERR({ code: 'InternalError', message: 'Out of host capacity.' }, 500);
      }
      return OK({ id: 'ocid1.instance.oc1..ad2', lifecycleState: 'PROVISIONING' });
    });

    const ref = await oracleAdapter.provision(SPEC);
    expect(seenADs).toEqual(['AD-1', 'AD-2']);
    expect(ref.instanceId).toBe('ocid1.instance.oc1..ad2');
    expect(ref.availabilityDomain).toBe('AD-2');
  });

  it('throws a clear error when every AD is out of capacity', async () => {
    stubFetch(() => ERR({ code: 'InternalError', message: 'Out of host capacity.' }, 500));

    await expect(oracleAdapter.provision(SPEC)).rejects.toThrow(
      'oracle: out of ARM capacity in all availability domains',
    );
  });

  it('throws immediately (no AD retry) on a non-capacity error', async () => {
    const calls: string[] = [];
    stubFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      calls.push(body.availabilityDomain);
      return ERR(
        {
          code: 'NotAuthenticated',
          message: 'The required information to complete authentication was not provided.',
        },
        401,
      );
    });

    await expect(oracleAdapter.provision(SPEC)).rejects.toThrow(/authentication/i);
    expect(calls).toEqual(['AD-1']);
  });
});

describe('oracleAdapter.status', () => {
  it('maps RUNNING -> running and resolves the public ip via VNIC lookups', async () => {
    stubFetch((url) => {
      if (url.includes('/instances/ocid1.instance.oc1..zzz')) {
        return OK({ id: 'ocid1.instance.oc1..zzz', lifecycleState: 'RUNNING' });
      }
      if (url.includes('/vnicAttachments')) {
        return OK([{ vnicId: 'ocid1.vnic.oc1..vvv', lifecycleState: 'ATTACHED' }]);
      }
      if (url.includes('/vnics/ocid1.vnic.oc1..vvv')) {
        return OK({ publicIp: '9.9.9.9' });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const st = await oracleAdapter.status({ instanceId: 'ocid1.instance.oc1..zzz' });
    expect(st.state).toBe('running');
    expect(st.ip).toBe('9.9.9.9');
  });

  it('maps PROVISIONING/STARTING -> creating', async () => {
    stubFetch(() => OK({ lifecycleState: 'PROVISIONING' }));
    expect((await oracleAdapter.status({ instanceId: 'i' })).state).toBe('creating');
    stubFetch(() => OK({ lifecycleState: 'STARTING' }));
    expect((await oracleAdapter.status({ instanceId: 'i' })).state).toBe('creating');
  });

  it('maps TERMINATED/TERMINATING -> terminated', async () => {
    stubFetch(() => OK({ lifecycleState: 'TERMINATED' }));
    expect((await oracleAdapter.status({ instanceId: 'i' })).state).toBe('terminated');
    stubFetch(() => OK({ lifecycleState: 'TERMINATING' }));
    expect((await oracleAdapter.status({ instanceId: 'i' })).state).toBe('terminated');
  });

  it('returns ip undefined when the VNIC is not ready yet', async () => {
    stubFetch((url) => {
      if (url.includes('/vnicAttachments')) return OK([]);
      return OK({ lifecycleState: 'RUNNING' });
    });
    const st = await oracleAdapter.status({ instanceId: 'i' });
    expect(st.state).toBe('running');
    expect(st.ip).toBeUndefined();
  });
});

describe('oracleAdapter.destroy', () => {
  it('DELETEs the instance with preserveBootVolume=false', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? '';
      return OK({}, 200);
    });

    await oracleAdapter.destroy({ instanceId: 'ocid1.instance.oc1..zzz' });
    expect(capturedUrl).toBe(
      'https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances/ocid1.instance.oc1..zzz?preserveBootVolume=false',
    );
    expect(capturedMethod).toBe('DELETE');
  });

  it('treats a 404 as success (already gone)', async () => {
    stubFetch(() => ERR({ code: 'NotFound', message: 'gone' }, 404));
    await expect(
      oracleAdapter.destroy({ instanceId: 'ocid1.instance.oc1..zzz' }),
    ).resolves.toBeUndefined();
  });

  it('throws on other non-2xx', async () => {
    stubFetch(() => ERR({ code: 'ServiceError', message: 'boom' }, 500));
    await expect(oracleAdapter.destroy({ instanceId: 'i' })).rejects.toThrow(/boom/);
  });
});
