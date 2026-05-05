/**
 * party-docs-unlink — removes a Party doc from the EC2 project folder.
 *
 * Job payload (job.partyDocsUnlinkPayload):
 *   { projectId, projectPath, filename }
 *
 * S3 delete happens in the API Lambda (admin side) before this job runs.
 * Unknown/missing files are non-fatal — we emit `.completed` either way.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export async function runPartyDocsUnlink(job, ctx) {
  const p = job.partyDocsUnlinkPayload || {};
  const { projectId, projectPath, filename } = p;
  const { pushEvent } = ctx;

  if (!projectId || !projectPath || !filename) {
    throw new Error('runPartyDocsUnlink: partyDocsUnlinkPayload incomplete');
  }

  await pushEvent(job.jobId, 'start', '__party__', 'party.docs.unlink.started', {
    projectId,
    filename,
  });

  const target = join(projectPath, 'docs', filename);
  let removed = false;
  if (existsSync(target)) {
    try {
      unlinkSync(target);
      removed = true;
    } catch (err) {
      // Non-fatal — the S3 authoritative delete already succeeded at API layer.
      // Log and move on.
      await pushEvent(job.jobId, 'warn', '__party__', 'party.docs.unlink.completed', {
        projectId,
        filename,
        removed: false,
        warn: err.message || String(err),
      });
      return { ok: true, removed: false };
    }
  }

  await pushEvent(job.jobId, 'done', '__party__', 'party.docs.unlink.completed', {
    projectId,
    filename,
    removed,
  });
  return { ok: true, removed };
}
