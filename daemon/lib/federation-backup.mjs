/**
 * federation-backup.mjs — Pipeline v2 Phase 3 / Story 3-C-1-1.
 *
 * Daily S3 sync of the parsed federation manifest. EC2 instance replacement
 * recovery: an operator who loses the EBS-backed `~/.futurator/skill-
 * federation.yaml` can restore from `s3://futurator-config/<operator-id>/
 * skill-federation.yaml`.
 *
 * Why S3 not a snapshot: the manifest is small (< 4KB typical), changes
 * rarely, and operators may want to read/edit it from outside the daemon
 * EC2 box (e.g. from a laptop). S3 with object versioning enabled gives
 * append-only history for free.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { stringify as yamlStringify } from 'yaml';

const REGION = process.env.AWS_REGION || 'us-east-1';
const BACKUP_BUCKET = process.env.FUTURATOR_CONFIG_BUCKET || 'futurator-config';
const OPERATOR_ID = process.env.FUTURATOR_OPERATOR_ID || 'default';
const BACKUP_KEY = `${OPERATOR_ID}/skill-federation.yaml`;

const DAILY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000; // wait 1 min after daemon boot before first backup

let s3Client = null;
function getS3() {
  if (!s3Client) s3Client = new S3Client({ region: REGION });
  return s3Client;
}

/**
 * One-shot backup of the given manifest to S3.
 * @param {object} manifest the parsed federation manifest
 * @returns {Promise<{ bucket: string, key: string }>}
 */
export async function backupFederation(manifest) {
  const body = yamlStringify(manifest);
  await getS3().send(
    new PutObjectCommand({
      Bucket: BACKUP_BUCKET,
      Key: BACKUP_KEY,
      Body: body,
      ContentType: 'application/yaml',
      Metadata: {
        'manifest-version': String(manifest['manifest-version']),
        'source-count': String(manifest.sources?.length ?? 0),
      },
    }),
  );
  return { bucket: BACKUP_BUCKET, key: BACKUP_KEY };
}

/**
 * Schedule daily federation backups. Returns the interval handle for
 * shutdown teardown.
 *
 * @param {() => object} getCurrentManifest cache.get-like accessor
 * @param {(level: string, msg: string) => void} [logFn] daemon log function
 * @returns {{ intervalHandle: ReturnType<typeof setInterval>, startupTimer: ReturnType<typeof setTimeout> }}
 */
export function startFederationBackupSchedule(getCurrentManifest, logFn = null) {
  const log = logFn || (() => {});

  const tick = async () => {
    try {
      const result = getCurrentManifest();
      const manifest = result?.manifest ?? result;
      if (!manifest || typeof manifest !== 'object') {
        log('warn', 'federation-backup: no manifest available, skipping tick');
        return;
      }
      const { bucket, key } = await backupFederation(manifest);
      log('info', `federation-backup: synced to s3://${bucket}/${key}`);
    } catch (e) {
      log('error', `federation-backup failed: ${e.message}`);
    }
  };

  const startupTimer = setTimeout(tick, STARTUP_DELAY_MS);
  const intervalHandle = setInterval(tick, DAILY_MS);
  return { intervalHandle, startupTimer };
}
