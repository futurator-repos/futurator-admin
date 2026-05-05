/**
 * party-docs-sync — copies an admin-uploaded document from S3 to the project
 * folder on EC2 so Claude's Read tool picks it up during the next Party turn.
 *
 * Job payload (ctx.job.partyDocsSyncPayload):
 *   { projectId, projectPath, filename, s3Bucket, s3Key }
 *
 * Implementation: shells `aws s3 cp` rather than using the SDK so the EC2's
 * instance role drives auth (no additional plumbing).
 *
 * Destination path: `<projectPath>/docs/<filename>`. The docs/ directory is
 * created if missing. On success: emit `party.docs.sync.completed`; on
 * failure: `party.docs.sync.failed` with the non-zero exit code.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function runPartyDocsSync(job, ctx) {
  const p = job.partyDocsSyncPayload || {};
  const { projectId, projectPath, filename, s3Bucket, s3Key } = p;
  const { pushEvent } = ctx;

  if (!projectId || !projectPath || !filename || !s3Bucket || !s3Key) {
    throw new Error('runPartyDocsSync: partyDocsSyncPayload incomplete');
  }

  await pushEvent(job.jobId, 'start', '__party__', 'party.docs.sync.started', {
    projectId,
    filename,
    s3Key,
  });

  const docsDir = join(projectPath, 'docs');
  mkdirSync(docsDir, { recursive: true });
  const dest = join(docsDir, filename);
  const source = `s3://${s3Bucket}/${s3Key}`;

  try {
    await runS3Cp(source, dest);
    await pushEvent(job.jobId, 'done', '__party__', 'party.docs.sync.completed', {
      projectId,
      filename,
      dest,
    });
    return { ok: true, dest };
  } catch (err) {
    const reason = err.message || String(err);
    await pushEvent(job.jobId, 'error', '__party__', 'party.docs.sync.failed', {
      projectId,
      filename,
      reason,
    });
    throw err;
  }
}

function runS3Cp(source, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', ['s3', 'cp', source, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`aws s3 cp exited ${code}: ${stderr.trim()}`));
    });
  });
}
