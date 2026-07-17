export interface BootstrapOpts {
  serverId: string;
  enrollToken: string;
  adminApiUrl: string; // 'https://hub.futurator.ai'
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  maxConcurrent: number;
  bundleS3Uri: string; // env DAEMON_BUNDLE_S3_URI
  arch: 'arm64' | 'x86_64';
}

/**
 * Builds the cloud-init/user-data bootstrap script for a newly-provisioned
 * server. The script installs Node, awscli, and the Claude CLI, fetches the
 * daemon bundle + Claude OAuth credentials from the admin API, then installs
 * and starts the `futurator-daemon` systemd unit.
 */
export function buildBootstrapScript(opts: BootstrapOpts): string {
  const awsCliArch = opts.arch === 'arm64' ? 'aarch64' : 'x86_64';

  return `#!/bin/bash
set -euo pipefail
# GCE's metadata script runner executes startup-scripts with NO \$HOME set, so
# under \`set -u\` any \$HOME reference aborts the whole bootstrap (observed:
# "line 11: HOME: unbound variable" — claude installed, daemon never did).
# Pin it: this always runs as root, on every provider.
export HOME=/root
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl unzip jq
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# awscli v2 (arch-aware). --update makes this re-runnable: GCE re-runs the
# startup-script on EVERY boot, and the plain installer exits 1 with "Found
# preexisting AWS CLI installation" — which under \`set -e\` killed the whole
# script before the daemon-bundle sync below, so reboots silently kept running
# stale code and a box could never repair itself.
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awsCliArch}.zip" -o /tmp/awscli.zip
rm -rf /tmp/aws
unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install --update
# claude native binary — installs to \$HOME/.local/bin
curl -fsSL https://claude.ai/install.sh | bash
ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude || true
mkdir -p /opt/futurator/daemon /etc/futurator /root/.claude
cat > /etc/futurator/daemon.env <<'ENVEOF'
SERVER_ID=${opts.serverId}
ENROLL_TOKEN=${opts.enrollToken}
ADMIN_API_URL=${opts.adminApiUrl}
AWS_ACCESS_KEY_ID=${opts.awsAccessKeyId}
AWS_SECRET_ACCESS_KEY=${opts.awsSecretAccessKey}
AWS_REGION=${opts.awsRegion}
DAEMON_SOURCE=${opts.serverId}
DAEMON_QUEUE_ONLY=0
MAX_CONCURRENT=${opts.maxConcurrent}
CLAUDE_CREDENTIALS_PATH=/root/.claude/.credentials.json
ENVEOF
set -a; source /etc/futurator/daemon.env; set +a
# fetch Claude OAuth creds from the admin API
curl -fsS -H "x-server-token: $ENROLL_TOKEN" "$ADMIN_API_URL/api/servers/agent-credentials" -o /root/.claude/.credentials.json
chmod 600 /root/.claude/.credentials.json
# A 200 is not proof: pointed at the site URL this endpoint returned the SPA's
# index.html, and curl -f wrote 11KB of HTML here as if it were credentials.
# Verify it is really Claude OAuth JSON. Do NOT exit on failure — the daemon
# must still install so it can report its auth state in its heartbeat; a box
# that reports "no auth" is fixable, one that never reports is a mystery.
if jq -e '.claudeAiOauth.accessToken // .accessToken' /root/.claude/.credentials.json >/dev/null 2>&1; then
  echo "[bootstrap] Claude OAuth credentials OK"
else
  echo "[bootstrap] ERROR: $ADMIN_API_URL/api/servers/agent-credentials did not return Claude OAuth JSON."
  echo "[bootstrap] first bytes: $(head -c 60 /root/.claude/.credentials.json | tr -d '\\n')"
  rm -f /root/.claude/.credentials.json
fi
aws s3 sync ${opts.bundleS3Uri} /opt/futurator/daemon/
cd /opt/futurator/daemon && npm install --omit=dev
cat > /etc/systemd/system/futurator-daemon.service <<'UNITEOF'
[Unit]
Description=Futurator agent daemon
After=network-online.target
[Service]
EnvironmentFile=/etc/futurator/daemon.env
ExecStart=/usr/bin/node /opt/futurator/daemon/agent-daemon.mjs
Restart=always
RestartSec=10
User=root
WorkingDirectory=/opt/futurator/daemon
[Install]
WantedBy=multi-user.target
UNITEOF
# "enable --now" starts the unit only if it is stopped, so on a re-run it would
# leave the OLD process serving while the synced code sits unused on disk.
# restart always adopts what we just pulled.
systemctl daemon-reload
systemctl enable futurator-daemon
systemctl restart futurator-daemon
`;
}
