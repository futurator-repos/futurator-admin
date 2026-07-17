import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hetznerAdapter } from '../hetzner';

vi.mock('../../provider-credentials-sm', () => ({
  getProviderCredentials: vi.fn(),
}));

import { getProviderCredentials } from '../../provider-credentials-sm';

type FetchStub = (
  url: string,
  init?: RequestInit,
) => { status: number; ok: boolean; json: () => Promise<unknown> };

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
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getProviderCredentials).mockReset();
  vi.mocked(getProviderCredentials).mockResolvedValue({ token: 'hetzner-test-token' });
});
afterEach(() => vi.unstubAllGlobals());

describe('hetznerAdapter.provision', () => {
  it('POSTs to the Hetzner servers endpoint with bearer token and mapped body', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return OK({
        server: { id: 123, public_net: { ipv4: { ip: '1.2.3.4' } } },
      });
    });

    const ref = await hetznerAdapter.provision({
      serverId: 'srv-1',
      name: 'hetzner-fsn-1',
      region: 'fsn1',
      size: 'cax11',
      arch: 'arm64',
      userData: '#!/bin/bash\necho hi',
    });

    expect(capturedUrl).toBe('https://api.hetzner.cloud/v1/servers');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer hetzner-test-token',
    );
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      // Slugged label + serverId suffix — Hetzner validates RFC1123 hostnames
      // and would reject a free-form operator label (see naming.test.ts).
      name: 'hetzner-fsn-1-srv1',
      server_type: 'cax11',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      user_data: '#!/bin/bash\necho hi',
    });

    expect(ref).toEqual({ instanceId: '123', ip: '1.2.3.4' });
  });

  it('throws with the API error message on non-2xx', async () => {
    stubFetch(() => ERR('invalid server_type', 422));

    await expect(
      hetznerAdapter.provision({
        serverId: 'srv-1',
        name: 'hetzner-fsn-1',
        region: 'fsn1',
        size: 'bogus',
        arch: 'arm64',
        userData: '',
      }),
    ).rejects.toThrow(/invalid server_type/);
  });
});

describe('hetznerAdapter.destroy', () => {
  it('DELETEs /servers/:id', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? '';
      return OK({}, 200);
    });

    await hetznerAdapter.destroy({ instanceId: '123' });

    expect(capturedUrl).toBe('https://api.hetzner.cloud/v1/servers/123');
    expect(capturedMethod).toBe('DELETE');
  });

  it('treats a 404 as success (already gone)', async () => {
    stubFetch(() => ERR('server not found', 404));

    await expect(hetznerAdapter.destroy({ instanceId: '999' })).resolves.toBeUndefined();
  });

  it('throws with the API error message on other non-2xx', async () => {
    stubFetch(() => ERR('unauthorized', 401));

    await expect(hetznerAdapter.destroy({ instanceId: '123' })).rejects.toThrow(/unauthorized/);
  });
});

describe('hetznerAdapter.status', () => {
  it('maps running -> running with ip', async () => {
    stubFetch(() => OK({ server: { status: 'running', public_net: { ipv4: { ip: '5.6.7.8' } } } }));

    const status = await hetznerAdapter.status({ instanceId: '123' });
    expect(status).toEqual({ state: 'running', ip: '5.6.7.8', detail: undefined });
  });

  it('maps initializing/starting -> creating', async () => {
    stubFetch(() => OK({ server: { status: 'initializing', public_net: { ipv4: { ip: null } } } }));
    expect((await hetznerAdapter.status({ instanceId: '123' })).state).toBe('creating');

    stubFetch(() => OK({ server: { status: 'starting', public_net: { ipv4: { ip: null } } } }));
    expect((await hetznerAdapter.status({ instanceId: '123' })).state).toBe('creating');
  });

  it('maps off -> stopped', async () => {
    stubFetch(() => OK({ server: { status: 'off', public_net: { ipv4: { ip: null } } } }));
    expect((await hetznerAdapter.status({ instanceId: '123' })).state).toBe('stopped');
  });

  it('throws with the API error message on non-2xx', async () => {
    stubFetch(() => ERR('not found', 404));

    await expect(hetznerAdapter.status({ instanceId: '123' })).rejects.toThrow(/not found/);
  });
});
