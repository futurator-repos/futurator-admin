/**
 * S3 Wiki Backup Module
 * Story MY-1.6
 *
 * Reusable module for backing up wiki knowledge/ directory to S3.
 * Uses `aws s3 sync --delete` for differential uploads.
 *
 * Non-blocking: errors are caught and logged, never propagated
 * to callers unless explicitly requested.
 *
 * Exports:
 *   backupToS3(projectId, knowledgeDir, options)  — Sync to S3
 *
 * Environment:
 *   AWS credentials via EC2 IAM role (develope-it-ec2-ssm)
 *
 * Usage:
 *   import { backupToS3 } from './lib/s3-backup.mjs';
 *   await backupToS3('spyhunter', '/home/ubuntu/projects/spyhunter/knowledge');
 *
 * @module s3-backup
 */

import { execFile } from 'node:child_process';

const S3_BUCKET = 'futurator-ai-website';
const S3_PREFIX = 'knowledge-live';
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Execute a command and return { stdout, stderr, exitCode }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function execCommand(cmd, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const proc = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code || 1 : 0,
      });
    });
  });
}

/**
 * Count lines in aws s3 sync output that indicate uploaded files.
 * Lines like "upload: ./file.md to s3://..." indicate a file was uploaded.
 * @param {string} stdout
 * @returns {number}
 */
function countUploadedFiles(stdout) {
  if (!stdout) return 0;
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('upload:') || line.startsWith('delete:'))
    .length;
}

/**
 * Backup the wiki knowledge/ directory to S3.
 *
 * Uses `aws s3 sync --delete` to:
 *   - Upload new and changed files
 *   - Delete files from S3 that were removed locally
 *
 * @param {string} projectId — Project identifier (e.g., 'spyhunter')
 * @param {string} knowledgeDir — Absolute path to the knowledge/ directory
 * @param {object} [options]
 * @param {string} [options.bucket] — S3 bucket name (default: futurator-ai-website)
 * @param {string} [options.prefix] — S3 prefix (default: knowledge-live)
 * @param {number} [options.timeoutMs] — Timeout in milliseconds (default: 30000)
 * @param {boolean} [options.throwOnError] — Whether to throw on failure (default: false)
 * @returns {Promise<{success: boolean, filesChanged: number, durationMs: number, error?: string}>}
 */
export async function backupToS3(projectId, knowledgeDir, options = {}) {
  const bucket = options.bucket || S3_BUCKET;
  const prefix = options.prefix || S3_PREFIX;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const throwOnError = options.throwOnError || false;

  const s3Path = `s3://${bucket}/${prefix}/${projectId}/`;
  const startTime = Date.now();

  console.log(`[s3-backup] Syncing ${knowledgeDir} -> ${s3Path}`);

  try {
    // First, verify AWS CLI is available
    const awsCheck = await execCommand('aws', ['--version'], 5000);
    if (awsCheck.exitCode !== 0) {
      throw new Error('AWS CLI not available or not in PATH');
    }

    // Run aws s3 sync with --delete
    const result = await execCommand(
      'aws',
      ['s3', 'sync', knowledgeDir, s3Path, '--delete'],
      timeoutMs
    );

    const durationMs = Date.now() - startTime;

    if (result.exitCode !== 0) {
      const errMsg = result.stderr.trim() || `aws s3 sync exited with code ${result.exitCode}`;

      // Check for timeout
      if (durationMs >= timeoutMs - 100) {
        console.warn(
          `[s3-backup] WARNING: S3 sync timed out after ${timeoutMs}ms for ${projectId}`
        );
      }

      console.error(`[s3-backup] ERROR: S3 sync failed for ${projectId}: ${errMsg}`);

      if (throwOnError) {
        throw new Error(errMsg);
      }

      return { success: false, filesChanged: 0, durationMs, error: errMsg };
    }

    const filesChanged = countUploadedFiles(result.stdout);
    const durationSec = (durationMs / 1000).toFixed(1);

    console.log(
      `[s3-backup] Synced ${projectId} knowledge to S3 (${filesChanged} files changed, ${durationSec}s)`
    );

    return { success: true, filesChanged, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(`[s3-backup] ERROR: S3 sync failed for ${projectId}: ${err.message}`);

    if (throwOnError) {
      throw err;
    }

    return { success: false, filesChanged: 0, durationMs, error: err.message };
  }
}

/**
 * Restore wiki from S3 backup (reverse sync).
 *
 * @param {string} projectId — Project identifier
 * @param {string} knowledgeDir — Absolute path to the knowledge/ directory
 * @param {object} [options]
 * @param {string} [options.bucket] — S3 bucket name
 * @param {string} [options.prefix] — S3 prefix
 * @param {number} [options.timeoutMs] — Timeout in milliseconds
 * @returns {Promise<{success: boolean, filesChanged: number, durationMs: number, error?: string}>}
 */
export async function restoreFromS3(projectId, knowledgeDir, options = {}) {
  const bucket = options.bucket || S3_BUCKET;
  const prefix = options.prefix || S3_PREFIX;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const s3Path = `s3://${bucket}/${prefix}/${projectId}/`;
  const startTime = Date.now();

  console.log(`[s3-backup] Restoring ${s3Path} -> ${knowledgeDir}`);

  const result = await execCommand(
    'aws',
    ['s3', 'sync', s3Path, knowledgeDir, '--delete'],
    timeoutMs
  );

  const durationMs = Date.now() - startTime;

  if (result.exitCode !== 0) {
    const errMsg = result.stderr.trim() || `aws s3 sync exited with code ${result.exitCode}`;
    throw new Error(`S3 restore failed for ${projectId}: ${errMsg}`);
  }

  const filesChanged = countUploadedFiles(result.stdout);
  console.log(
    `[s3-backup] Restored ${projectId} knowledge from S3 (${filesChanged} files, ${(durationMs / 1000).toFixed(1)}s)`
  );

  return { success: true, filesChanged, durationMs };
}
