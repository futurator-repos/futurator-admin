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

  // Regression: GCE's metadata script runner gives startup-scripts NO $HOME.
  // Under `set -u` the bootstrap aborted at the first $HOME reference — claude
  // installed, the daemon never did, and the server sat in BOOTSTRAPPING
  // forever. The script runs on a bare VM with an empty environment, so every
  // variable it reads it must first define. (`bash -n` can't check this — it
  // parses without evaluating, and passes the buggy script happily.)
  it('reads no variable it does not define itself', () => {
    const script = buildBootstrapScript(opts());
    const assigned = new Set<string>();
    for (const m of script.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)) {
      assigned.add(m[1]);
    }
    const referenced = new Set<string>();
    for (const m of script.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
      referenced.add(m[1]);
    }
    const external = [...referenced].filter((v) => !assigned.has(v));
    expect(external).toEqual([]);
  });

  it('exports HOME for set -u safety and uses literal paths, not $HOME', () => {
    const script = buildBootstrapScript(opts());
    // The bootstrap body still runs as root and must define HOME (GCE gives it
    // none) so `set -u` does not abort on any incidental $HOME reference.
    expect(script).toContain('export HOME=/root');
    // But paths are now literal (/home/futurator/...), so a stray unbound $HOME
    // can't creep back in. If any $HOME/ dereference exists it must follow the
    // export (belt and braces); today there are none.
    const homeExport = script.indexOf('export HOME=');
    const firstUse = script.indexOf('$HOME/');
    if (firstUse !== -1) expect(firstUse).toBeGreaterThan(homeExport);
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
    expect(script).toContain('systemctl enable futurator-daemon');
  });

  // Regression: the daemon spawns `claude --dangerously-skip-permissions`, which
  // Claude refuses to run as root — so a root-owned daemon failed EVERY job
  // instantly ("cannot be used with root/sudo privileges"). The unit must run
  // as the non-root futurator user, and Claude must be installed AS that user
  // so the binary it invokes was never a root install.
  it('runs the daemon as a non-root user, and Claude belongs to that user', () => {
    const script = buildBootstrapScript(opts());
    expect(script).toContain('User=futurator');
    expect(script).not.toMatch(/^User=root$/m);
    // creds + daemon live under the user's home, owned by them
    expect(script).toContain('CLAUDE_CREDENTIALS_PATH=/home/futurator/.claude/.credentials.json');
    expect(script).toContain('chown -R futurator:futurator');
    // Claude installed as the user (sudo -u), not as root
    expect(script).toMatch(/sudo -u futurator[^\n]*claude\.ai\/install\.sh/);
  });

  // Regression: GCE re-runs the startup-script on EVERY boot. The plain awscli
  // installer exits 1 on an existing install ("Found preexisting AWS CLI
  // installation"), which under `set -e` aborted the script before the bundle
  // sync — so a rebooted box silently kept running stale daemon code and could
  // never repair itself. Our own Stop/Start toggle reboots the VM, so this is
  // on the happy path, not an edge case.
  it('is re-runnable: every step tolerates an already-provisioned box', () => {
    const script = buildBootstrapScript(opts());
    // awscli: updates instead of dying on a preexisting install.
    expect(script).toContain('/tmp/aws/install --update');
    // and restarts the daemon so the freshly-synced code is what actually runs
    // (`enable --now` no-ops when the unit is already running).
    expect(script).toContain('systemctl restart futurator-daemon');
    // directories/symlinks/config use force/idempotent forms.
    expect(script).toContain('mkdir -p');
    expect(script).toContain('ln -sf');
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
    expect(script).toContain('chmod 600 /home/futurator/.claude/.credentials.json');
  });
});
