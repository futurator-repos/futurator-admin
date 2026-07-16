#!/bin/bash
# futurator-oauth-sync — push fresh Claude Code OAuth tokens from Mac Keychain
# to the EC2 daemon so it keeps authenticating against your Max subscription
# (flat fee) instead of burning API credits.
#
# Run manually once to verify, then install as a launchd agent via
# scripts/install-mac-oauth-sync.sh so it runs every 4 hours.

set -euo pipefail

INSTANCE_ID="${FUTURATOR_EC2_INSTANCE_ID:-i-0826d68c316ae97dd}"
REGION="${AWS_REGION:-eu-central-1}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$(whoami)}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-Claude Code-credentials}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# 1. Check AWS CLI is logged in (this fires if user's SSO/access-keys are expired).
if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  log "ERROR: aws sts get-caller-identity failed — refresh your AWS credentials."
  exit 2
fi

# 2. Pull OAuth JSON from Keychain.
if ! CREDS=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null); then
  log "ERROR: Claude Code credentials not found in Keychain."
  log "       Run 'claude' once and sign in, then retry."
  exit 3
fi

if [ -z "$CREDS" ]; then
  log "ERROR: Keychain returned empty credentials."
  exit 3
fi

# 3. Validate it looks like Claude OAuth JSON (accessToken present, either at
#    top level or under a claudeAiOauth / oauth envelope).
if ! echo "$CREDS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ok = any(
    (isinstance(d.get(k), dict) and 'accessToken' in d[k])
    for k in ('claudeAiOauth', 'oauth')
) or 'accessToken' in d
sys.exit(0 if ok else 1)
" 2>/dev/null; then
  log "ERROR: Keychain entry doesn't look like Claude OAuth JSON."
  exit 4
fi

BYTES=$(printf '%s' "$CREDS" | wc -c | tr -d ' ')
log "Keychain OAuth JSON: ${BYTES} bytes"

# 4. Push to EC2 via SSM. Uses base64 to survive shell escaping.
B64=$(printf '%s' "$CREDS" | base64 | tr -d '\n')
WRITE_CMD="mkdir -p /home/ubuntu/.claude && echo '${B64}' | base64 -d > /home/ubuntu/.claude/.credentials.json && chown ubuntu:ubuntu /home/ubuntu/.claude/.credentials.json && chmod 600 /home/ubuntu/.claude/.credentials.json && pkill -USR1 -f 'agent-daemon.mjs' || true"

PARAMS_FILE=$(mktemp)
cat > "$PARAMS_FILE" <<EOF
{"commands": ["${WRITE_CMD}"]}
EOF

# Non-fatal: the EC2 box is optional post-migration (fleet servers get creds
# via the Secrets Manager mirror below + the admin API relay instead).
if CID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --document-name AWS-RunShellScript \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text 2>&1); then
  log "Pushed OAuth to EC2 (SSM CommandId=$CID). Daemon signalled via SIGUSR1 — will re-probe in seconds."
else
  log "WARN: SSM push to EC2 ($INSTANCE_ID) failed — skipping (fleet uses the Secrets Manager mirror): $CID"
fi
rm -f "$PARAMS_FILE"

# 5. Mirror to Secrets Manager so fleet servers (non-AWS: Hetzner/Oracle/GCP)
#    can fetch the same creds via the admin API relay (GET /api/servers/
#    agent-credentials). Reuses the exact Keychain JSON already validated above.
if aws secretsmanager put-secret-value \
  --secret-id futurator/claude-oauth-credentials \
  --secret-string "$CREDS" \
  --region "$REGION" >/dev/null 2>&1; then
  log "Mirrored OAuth to Secrets Manager (futurator/claude-oauth-credentials)."
elif aws secretsmanager create-secret \
  --name futurator/claude-oauth-credentials \
  --secret-string "$CREDS" \
  --region "$REGION" >/dev/null 2>&1; then
  log "Created Secrets Manager secret futurator/claude-oauth-credentials."
else
  log "WARN: could not mirror OAuth to Secrets Manager (fleet relay may be stale)."
fi
