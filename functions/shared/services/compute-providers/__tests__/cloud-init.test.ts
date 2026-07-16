import { describe, it, expect } from 'vitest';
import { buildBootstrapScript, type BootstrapOpts } from '../cloud-init';

const opts = (o: Partial<BootstrapOpts> = {}): BootstrapOpts => ({
  serverId: 'srv_abc123',
  enrollToken: 'tok_xyz789',
  adminApiUrl: 'https://hub.futurator.ai',
  awsAccessKeyId: 'AKIAEXAMPLE',
  awsSecretAccessKey: 'secretExample',
  awsRegion: 'eu-central-1',
  maxConcurrent: 3,
  bundleS3Uri: 's3://futurator-daemon-bundles/latest/',
  arch: 'arm64',
  ...o,
});

describe('buildBootstrapScript', () => {
  it('starts with a bash shebang', () => {
    const script = buildBootstrapScript(opts());
    expect(script.startsWith('#!/bin/bash')).toBe(true);
  });

  it('embeds the server id, enroll token, and DAEMON_SOURCE', () => {
    const script = buildBootstrapScript(
      opts({ serverId: 'srv_abc123', enrollToken: 'tok_xyz789' }),
    );
    expect(script).toContain('SERVER_ID=srv_abc123');
    expect(script).toContain('ENROLL_TOKEN=tok_xyz789');
    expect(script).toContain('DAEMON_SOURCE=srv_abc123');
  });

  it('syncs the daemon bundle from the given S3 URI', () => {
    const script = buildBootstrapScript(
      opts({ bundleS3Uri: 's3://futurator-daemon-bundles/latest/' }),
    );
    expect(script).toContain('aws s3 sync s3://futurator-daemon-bundles/latest/');
  });

  it('installs and enables the futurator-daemon systemd unit', () => {
    const script = buildBootstrapScript(opts());
    expect(script).toContain('/etc/systemd/system/futurator-daemon.service');
    expect(script).toContain('systemctl enable --now futurator-daemon');
  });

  it('uses the aarch64 awscli URL for arm64', () => {
    const script = buildBootstrapScript(opts({ arch: 'arm64' }));
    expect(script).toContain('https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip');
    expect(script).not.toContain('awscli-exe-linux-x86_64.zip');
  });

  it('uses the x86_64 awscli URL for x86_64', () => {
    const script = buildBootstrapScript(opts({ arch: 'x86_64' }));
    expect(script).toContain('https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip');
    expect(script).not.toContain('awscli-exe-linux-aarch64.zip');
  });

  it('fetches Claude OAuth creds with the x-server-token header', () => {
    const script = buildBootstrapScript(
      opts({ adminApiUrl: 'https://hub.futurator.ai', enrollToken: 'tok_xyz789' }),
    );
    expect(script).toContain(
      'curl -fsS -H "x-server-token: $ENROLL_TOKEN" "$ADMIN_API_URL/api/servers/agent-credentials"',
    );
  });

  it('chmods the credentials file to 600', () => {
    const script = buildBootstrapScript(opts());
    expect(script).toContain('chmod 600 /root/.claude/.credentials.json');
  });
});
