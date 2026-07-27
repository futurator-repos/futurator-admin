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

  // The daemon must run NON-ROOT (Claude refuses --dangerously-skip-permissions
  // as root) AND specifically as `ubuntu` with home /home/ubuntu: the daemon
  // hardcodes ~15 paths under /home/ubuntu (queue-runs, repos, projects,
  // worktrees, the creds default) because on EC2 it runs as the ubuntu user.
  // GCE/Hetzner/Oracle images have no ubuntu user by default, so we create one
  // and mirror EC2 exactly — far more robust than rewriting every path. The
  // bootstrap body still runs as root (how metadata runners invoke it) and
  // drops to this user for the parts that must not be root.
  const USER = 'ubuntu';
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
mkdir -p /opt/futurator/daemon /etc/futurator /var/log/futurator/events
# The user's OWN dirs must be user-owned before we install Claude as them: the
# installer writes to ~/.claude/downloads, and a root-created ~/.claude fails
# "Permission denied" under sudo -u. install -d sets the owner atomically.
install -d -o ${USER} -g ${USER} ${HOME}/.claude

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
# Playwright Chromium for the story-gate browser probes (EC2 gets this via
# rsync-daemon.sh; fleet boxes must self-provision it or every browser AC
# fails "Executable doesn't exist"). install-deps aptly runs as root here;
# the browser cache itself must belong to the daemon user. Idempotent.
npx --prefix /opt/futurator/daemon playwright install-deps chromium || true
sudo -u ${USER} -H bash -c 'cd /opt/futurator/daemon && npx playwright install chromium' || true
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

# ── Fleet-box self-maintenance timers (2026-07-27 incident: one box hit disk-full
# + expired-OAuth in a day and wedged every build). Units ship in the synced
# bundle with correct /opt/futurator/daemon paths. Idempotent on every re-boot.
#   • disk-gc      — DAILY GC of npm/.cache/stale-worktree cruft (Chromium kept).
#   • oauth-refresh— re-pull fresh Claude Max tokens every 3h (boot fetch expires).
chmod +x /opt/futurator/daemon/scripts/disk-gc.sh /opt/futurator/daemon/scripts/oauth-refresh.sh 2>/dev/null || true
cp /opt/futurator/daemon/systemd/futurator-disk-gc.service       /etc/systemd/system/ || true
cp /opt/futurator/daemon/systemd/futurator-disk-gc.timer         /etc/systemd/system/ || true
cp /opt/futurator/daemon/systemd/futurator-oauth-refresh.service /etc/systemd/system/ || true
cp /opt/futurator/daemon/systemd/futurator-oauth-refresh.timer   /etc/systemd/system/ || true

# "enable --now" starts the unit only if it is stopped, so on a re-run it would
# leave the OLD process serving while the synced code sits unused on disk.
# restart always adopts what we just pulled.
systemctl daemon-reload
systemctl enable futurator-daemon
systemctl enable --now futurator-disk-gc.timer futurator-oauth-refresh.timer || true
systemctl restart futurator-daemon
`;
}
