import { describe, it, expect } from 'vitest';
import { resolveServerId } from '../server-identity.mjs';

describe('resolveServerId (Servers-module Task 18)', () => {
  it('returns env.SERVER_ID verbatim when set (fleet daemons)', () => {
    expect(
      resolveServerId({ SERVER_ID: 'srv_hetzner_fsn_1', DAEMON_SOURCE: 'ec2' }),
    ).toBe('srv_hetzner_fsn_1');
  });

  it("maps legacy DAEMON_SOURCE 'ec2' → srv_ec2_main when SERVER_ID is unset", () => {
    expect(resolveServerId({ DAEMON_SOURCE: 'ec2' })).toBe('srv_ec2_main');
  });

  it("maps legacy DAEMON_SOURCE 'local' — and anything else — → srv_local_mac", () => {
    expect(resolveServerId({ DAEMON_SOURCE: 'local' })).toBe('srv_local_mac');
    expect(resolveServerId({})).toBe('srv_local_mac');
    expect(resolveServerId({ DAEMON_SOURCE: 'something-unknown' })).toBe('srv_local_mac');
  });
});
