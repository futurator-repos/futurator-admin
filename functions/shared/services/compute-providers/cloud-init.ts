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
# awscli v2 (arch-aware)
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awsCliArch}.zip" -o /tmp/awscli.zip
unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install
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
systemctl daemon-reload && systemctl enable --now futurator-daemon
`;
}
