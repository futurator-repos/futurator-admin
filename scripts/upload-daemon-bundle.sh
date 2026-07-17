#!/usr/bin/env bash
#
# upload-daemon-bundle.sh — push the local daemon/ tree to the S3 prefix that
# fleet-box cloud-init bootstraps pull from (DAEMON_BUNDLE_S3_URI in
# sst.config.ts / functions/shared/services/compute-providers/cloud-init.ts:
# `aws s3 sync ${opts.bundleS3Uri} /opt/futurator/daemon/`).
#
# Usage:
#   ./scripts/upload-daemon-bundle.sh
#
# NO --delete: this prefix is shared infrastructure that live fleet boxes
# sync FROM on every boot (cloud-init's bundle-sync step is idempotent and
# re-runs on `gcloud compute instances reset`, see below). A stray local
# rm/rename should not delete files a running box still depends on between
# deploys — sync-with-delete here would propagate a half-finished local
# tree straight into every fleet box's next reboot. Additive-only push;
# pruning stale objects is a separate, deliberate action.
#
# Excludes mirror rsync-daemon.sh's EC2 push (node_modules, .env, *.log) plus
# __tests__ dirs, which have no business shipping to a runtime bundle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_DAEMON="$REPO_ROOT/daemon/"
BUNDLE_S3_URI="s3://futurator-admin-production-adminsiteassetsbucket-bcsesuts/develope-it/daemon/"
REGION="eu-central-1"

if [[ ! -d "$LOCAL_DAEMON" ]]; then
  echo "error: local daemon dir not found at $LOCAL_DAEMON" >&2
  exit 1
fi

echo ">>> Syncing $LOCAL_DAEMON -> $BUNDLE_S3_URI (region $REGION, no --delete)"

SYNC_OUT="$(
  aws s3 sync "$LOCAL_DAEMON" "$BUNDLE_S3_URI" \
    --exclude 'node_modules/*' \
    --exclude '**/__tests__/*' \
    --exclude '.env*' \
    --exclude '*.log' \
    --region "$REGION"
)"

echo "$SYNC_OUT"

OBJECT_COUNT="$(printf '%s\n' "$SYNC_OUT" | grep -c '^upload:' || true)"
echo ">>> synced $OBJECT_COUNT object(s) to $BUNDLE_S3_URI"

echo ">>> Reminder: this prefix is pulled by fleet-box cloud-init on every boot"
echo "    (aws s3 sync \$DAEMON_BUNDLE_S3_URI /opt/futurator/daemon/, see"
echo "    functions/shared/services/compute-providers/cloud-init.ts). Already-"
echo "    running boxes do NOT pick this up until they reboot — GCE/Hetzner/"
echo "    Oracle re-run the startup-script on every boot, so"
echo "    \`gcloud compute instances reset <name>\` (or the equivalent"
echo "    provider reboot) re-runs the idempotent bootstrap and picks up this"
echo "    bundle without a full re-provision."
