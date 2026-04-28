/**
 * pat-age-check.ts — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Daily cron. Reads the last PAT rotation timestamp from SSM and writes
 * an attention item when the PAT is approaching or past its recommended
 * quarterly rotation cadence.
 *
 * Thresholds:
 *   <  80 days — no action
 *   >= 80 days — writes 'low'-severity attention item ("due for rotation")
 *   >= 100 days — escalates to 'medium' severity
 *
 * Missing timestamp (never rotated via the UI) → writes a 'low'-severity
 * informational item prompting the operator to set a baseline.
 *
 * The PAT value is NEVER read, logged, or included in any attention item.
 *
 * Deduplication: the cron checks for an existing open attention item with
 * category 'other' and title prefix matching the PAT age sentinel before
 * writing, to avoid creating duplicate rows on consecutive runs.
 *
 * NOTE: AttentionItems require a planId. Infrastructure-level items use the
 * reserved planId `_system`. The attention-items table is keyed (planId, itemId)
 * so `_system` items do not pollute plan-specific views unless the UI explicitly
 * queries planId='_system'.
 */

import { SSMClient } from '@aws-sdk/client-ssm';
import { log } from '../shared/logger';
import { readRotatedAt } from '../shared/github/rotate-pat';
import * as attentionRepo from '../shared/repositories/attention-items-repository';
import type { AttentionItem, AttentionSeverity } from '../shared/types/attention';

const SYSTEM_PLAN_ID = '_system';
const PAT_AGE_ITEM_TITLE_PREFIX = 'GitHub PAT';
const PAT_AGE_ITEM_ID = 'github-pat-age-sentinel'; // stable ID so the row is overwritten

const WARN_DAYS = 80;
const ESCALATE_DAYS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ssmClient = new SSMClient({ region: 'us-east-1' });

/** Returns the age in days between an ISO timestamp and now. */
function ageInDays(isoString: string): number {
  const ts = Date.parse(isoString);
  if (isNaN(ts)) return 0;
  return Math.floor((Date.now() - ts) / MS_PER_DAY);
}

export const handler = async (): Promise<void> => {
  log('info', 'pat-age-check', 'Starting PAT age check');

  try {
    const rotatedAt = await readRotatedAt(ssmClient);

    if (rotatedAt === null) {
      // Never recorded — write an informational item.
      await writeOrUpdateAttentionItem({
        severity: 'low',
        title: `${PAT_AGE_ITEM_TITLE_PREFIX} rotation timestamp missing`,
        body: 'The GitHub PAT rotation timestamp has never been recorded via the Settings → GitHub panel. Navigate to Settings → GitHub and rotate the PAT to establish a baseline. See docs/runbooks/pat-rotation.md.',
      });
      log('info', 'pat-age-check', 'No rotation timestamp found — wrote info attention item');
      return;
    }

    const ageDays = ageInDays(rotatedAt);
    log('info', 'pat-age-check', 'PAT age computed', { ageDays, rotatedAt });

    if (ageDays < WARN_DAYS) {
      // Within cadence — clear any existing open item by resolving it.
      await resolveExistingItem();
      log('info', 'pat-age-check', 'PAT within rotation cadence — no action');
      return;
    }

    const severity: AttentionSeverity = ageDays >= ESCALATE_DAYS ? 'medium' : 'low';
    const rotatedDate = rotatedAt.slice(0, 10); // YYYY-MM-DD

    await writeOrUpdateAttentionItem({
      severity,
      title: `${PAT_AGE_ITEM_TITLE_PREFIX} due for rotation (last rotated ${rotatedDate})`,
      body: `The GitHub PAT was last rotated ${ageDays} day${ageDays !== 1 ? 's' : ''} ago. The recommended cadence is quarterly (every 90 days). Navigate to Settings → GitHub to rotate. See docs/runbooks/pat-rotation.md.`,
    });

    log('info', 'pat-age-check', 'Wrote PAT age attention item', { ageDays, severity });
  } catch (err) {
    log('error', 'pat-age-check', 'PAT age check failed', { error: String(err) });
  }
};

async function writeOrUpdateAttentionItem({
  severity,
  title,
  body,
}: {
  severity: AttentionSeverity;
  title: string;
  body: string;
}): Promise<void> {
  // Check for an existing item to avoid duplicate writes.
  const existing = await attentionRepo.getAttentionItem(SYSTEM_PLAN_ID, PAT_AGE_ITEM_ID);

  if (existing && existing.status !== 'resolved') {
    // Already open — update title/body/severity in-place by overwriting.
  }

  const now = new Date().toISOString();
  const item: AttentionItem = {
    planId: SYSTEM_PLAN_ID,
    itemId: PAT_AGE_ITEM_ID,
    createdAt: existing?.createdAt ?? now,
    resolvedAt: null,
    severity,
    category: 'other',
    title,
    body,
    context: {},
    suggestedActions: [{ label: 'Rotate PAT', kind: 'archive' as const }],
    status: 'open',
  };

  await attentionRepo.createAttentionItem(item);
}

async function resolveExistingItem(): Promise<void> {
  const existing = await attentionRepo.getAttentionItem(SYSTEM_PLAN_ID, PAT_AGE_ITEM_ID);
  if (existing && existing.status !== 'resolved') {
    await attentionRepo.updateAttentionStatus(SYSTEM_PLAN_ID, PAT_AGE_ITEM_ID, 'resolved');
  }
}
