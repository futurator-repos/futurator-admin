// Pipeline v1 — Story 6.4. Hourly email digest of unresolved attention items.
//
// Per-user (single user in v1, designed for multi):
//   1. Skip if user.emailDigestEnabled !== true.
//   2. Query unresolved attention items created in the last hour across
//      every plan the user can see.
//   3. If any, send a digest email via SES with subject
//      "[Futurator] N attention items waiting".
//
// Rate-limited to 1 digest per user per hour by virtue of being an hourly
// cron. SES sandbox mode is OK for v1 (single verified sender + recipient).

import * as planRepo from '../shared/repositories/plan-repository';
import * as attentionRepo from '../shared/repositories/attention-items-repository';
import * as userRepo from '../shared/repositories/user-repository';
import { log } from '../shared/logger';

interface UserProfileExt {
  emailDigestEnabled?: boolean;
  email?: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export const handler = async () => {
  try {
    const users = await userRepo.getAllUsers();
    const cutoff = new Date(Date.now() - ONE_HOUR_MS).toISOString();

    let sent = 0;
    for (const user of users) {
      const ext = user as unknown as UserProfileExt;
      if (!ext.emailDigestEnabled) continue;

      // Aggregate fresh items across every plan. v1 has a single user, so
      // we just walk every plan; multi-user filtering belongs in a later
      // iteration once Plan rows carry an ownerUserId.
      const plans = await planRepo.getAllPlans();
      const items: Array<{ planName: string; title: string; severity: string }> = [];
      for (const plan of plans) {
        const planItems = await attentionRepo.listAttentionItems(plan.planId);
        for (const it of planItems) {
          if (it.status !== 'resolved' && (it.createdAt || '') >= cutoff) {
            items.push({ planName: plan.name, title: it.title, severity: it.severity });
          }
        }
      }

      if (items.length === 0) continue;

      // V1 stub: log the digest payload. SES wiring (verified sender, IAM
      // policy) lands in a follow-up — the cron Lambda framework is in
      // place so flipping the toggle works once SES is configured.
      log('info', 'attention-digest', `would email ${user.email || user.userId}`, {
        userId: user.userId,
        unresolvedCount: items.length,
        sample: items.slice(0, 3),
      });
      sent += 1;
    }

    log('info', 'attention-digest', 'tick complete', { sent });
  } catch (err) {
    log('error', 'attention-digest', 'top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
