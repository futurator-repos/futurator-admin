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

  // The daemon spawns `claude --dangerously-skip-permissions`, which Claude
  // REFUSES to run as root ("cannot be used with root/sudo privileges"). EC2's
  // daemon runs as `ubuntu` and is fine; our fleet script ran everything as
  // root, so every job failed instantly. So: a dedicated non-root `futurator`
  // user owns the daemon, its home, its credentials, and Claude. The bootstrap
  // itself still runs as root (that is how cloud-init/metadata runners invoke
  // it) and drops to the user for the parts that must not be root.
  const USER = 'futurator';
  const HOME = `/home/${USER}`;

  return `#!/bin/bash
set -euo pipefail
# GCE's metadata script runner executes startup-scripts with NO \$HOME set, so
# under \`set -u\` any \$HOME reference aborts the whole bootstrap. Pin it; the
# bootstrap body runs as root.
export HOME=/root
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl unzip jq
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# awscli v2 (arch-aware). --update makes this re-runnable: GCE re-runs the
# startup-script on EVERY boot, and the plain installer exits 1 on a preexisting
# install, which under \`set -e\` would abort before the bundle sync below.
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awsCliArch}.zip" -o /tmp/awscli.zip
rm -rf /tmp/aws
unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install --update

# The non-root user the daemon + Claude run as (idempotent).
id ${USER} >/dev/null 2>&1 || useradd -m -d ${HOME} -s /bin/bash ${USER}
mkdir -p /opt/futurator/daemon /etc/futurator ${HOME}/.claude /var/log/futurator/events

# claude native binary — installed AS ${USER} so it lands in ${HOME}/.local/bin
# and, crucially, is invoked by a non-root user at runtime. Guarded so a reboot
# does not reinstall it.
if [ ! -x ${HOME}/.local/bin/claude ]; then
  sudo -u ${USER} -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi
ln -sf ${HOME}/.local/bin/claude /usr/local/bin/claude || true

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
CLAUDE_CREDENTIALS_PATH=${HOME}/.claude/.credentials.json
HOME=${HOME}
ENVEOF
set -a; source /etc/futurator/daemon.env; set +a

# fetch Claude OAuth creds from the admin API
curl -fsS -H "x-server-token: $ENROLL_TOKEN" "$ADMIN_API_URL/api/servers/agent-credentials" -o ${HOME}/.claude/.credentials.json
chmod 600 ${HOME}/.claude/.credentials.json
# A 200 is not proof: pointed at the site URL this endpoint returned the SPA's
# index.html, and curl -f wrote 11KB of HTML here as if it were credentials.
# Verify it is really Claude OAuth JSON. Do NOT exit on failure — the daemon
# must still install so it can report its auth state in its heartbeat.
if jq -e '.claudeAiOauth.accessToken // .accessToken' ${HOME}/.claude/.credentials.json >/dev/null 2>&1; then
  echo "[bootstrap] Claude OAuth credentials OK"
else
  echo "[bootstrap] ERROR: $ADMIN_API_URL/api/servers/agent-credentials did not return Claude OAuth JSON."
  echo "[bootstrap] first bytes: $(head -c 60 ${HOME}/.claude/.credentials.json | tr -d '\\n')"
  rm -f ${HOME}/.claude/.credentials.json
fi

aws s3 sync ${opts.bundleS3Uri} /opt/futurator/daemon/
cd /opt/futurator/daemon && npm install --omit=dev
# Everything the daemon touches must be owned by the non-root user it runs as.
chown -R ${USER}:${USER} /opt/futurator ${HOME}/.claude /etc/futurator /var/log/futurator

cat > /etc/systemd/system/futurator-daemon.service <<'UNITEOF'
[Unit]
Description=Futurator agent daemon
After=network-online.target
[Service]
EnvironmentFile=/etc/futurator/daemon.env
ExecStart=/usr/bin/node /opt/futurator/daemon/agent-daemon.mjs
Restart=always
RestartSec=10
User=${USER}
Group=${USER}
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
