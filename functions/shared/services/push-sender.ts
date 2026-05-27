/**
 * push-sender.ts — 2026-05-27 PR D.f.
 *
 * Sends a Web Push notification using the VAPID protocol. Wraps the
 * `web-push` library. v1 surfaces:
 *
 *   - sendToOperator(operatorId, payload) — fan out to every subscription
 *     for the operator. Prunes 404/410-responding subscriptions inline.
 *   - sendToSubscription(sub, payload) — single-device send for testing.
 *
 * VAPID keys live in Secrets Manager at `futurator/push/vapid-keys`. The
 * secret body is a JSON document `{ publicKey, privateKey, subject }`
 * where `subject` is a mailto: URI per the Web Push spec. Generate keys
 * via `npx web-push generate-vapid-keys` and put the JSON in the secret
 * before the first send attempt.
 *
 * Failure modes:
 *   - 404 / 410: subscription expired or unsubscribed → prune from DDB.
 *   - 4xx other: VAPID config error → log + bubble (operator must rotate).
 *   - 5xx: Push gateway transient → log + drop (next emit retries).
 *
 * Payload shape (browser receives this in the `push` event):
 *   { title, body, url?, tag?, requireInteraction?, data? }
 *
 * The service worker renders the notification + handles click → deep link.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import * as pushSubscriptionsRepo from '../repositories/push-subscriptions-repository';

const sm = new SecretsManagerClient({});

const VAPID_SECRET_NAME = process.env.PUSH_VAPID_SECRET_NAME || 'futurator/push/vapid-keys';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let _vapidCache: { keys: VapidKeys; fetchedAt: number } | null = null;
const VAPID_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PushPayload {
  title: string;
  body: string;
  /** Deep link to open when the operator taps. Absolute or path under origin. */
  url?: string;
  /** Notification tag for grouping (e.g., 'merge-approval'). */
  tag?: string;
  /** When true, the notification persists until the operator dismisses. */
  requireInteraction?: boolean;
  /** Arbitrary keyed data exposed to the service worker. */
  data?: Record<string, unknown>;
}

async function loadVapid(): Promise<VapidKeys | null> {
  if (_vapidCache && Date.now() - _vapidCache.fetchedAt < VAPID_CACHE_TTL_MS) {
    return _vapidCache.keys;
  }
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: VAPID_SECRET_NAME }));
    if (!res.SecretString) return null;
    const parsed = JSON.parse(res.SecretString) as Partial<VapidKeys>;
    if (!parsed.publicKey || !parsed.privateKey || !parsed.subject) return null;
    const keys: VapidKeys = {
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      subject: parsed.subject,
    };
    _vapidCache = { keys, fetchedAt: Date.now() };
    return keys;
  } catch (err) {
    console.warn(`[push-sender] VAPID secret load failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Lazy-load `web-push`. The module is imported dynamically so a Lambda that
 * never sends push notifications doesn't pay the cold-start cost.
 *
 * Returns null when the package is absent (intentional during incremental
 * rollout — the caller falls back to no-op).
 */
async function loadWebPush(): Promise<typeof import('web-push') | null> {
  try {
    return await import('web-push');
  } catch (err) {
    console.warn(
      `[push-sender] web-push package not installed: ${(err as Error).message}. ` +
        `Install with \`npm install web-push @types/web-push\` to enable push.`,
    );
    return null;
  }
}

/**
 * Send a payload to every subscription owned by the operator. Best-effort:
 * individual subscription failures are pruned (on 404/410) or logged.
 *
 * Returns { sent, pruned, errors }. Caller can use this for fan-out stats.
 */
export interface SendToOperatorResult {
  sent: number;
  pruned: number;
  errors: number;
}

export async function sendToOperator(
  operatorId: string,
  payload: PushPayload,
): Promise<SendToOperatorResult> {
  const subscriptions = await pushSubscriptionsRepo.listSubscriptionsByOperator(operatorId);
  if (subscriptions.length === 0) {
    return { sent: 0, pruned: 0, errors: 0 };
  }
  const vapid = await loadVapid();
  const webPush = await loadWebPush();
  if (!vapid || !webPush) {
    console.warn(
      `[push-sender] missing VAPID keys or web-push package; cannot send to ${operatorId} ` +
        `(${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'} pending)`,
    );
    return { sent: 0, pruned: 0, errors: subscriptions.length };
  }

  webPush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  let sent = 0;
  let pruned = 0;
  let errors = 0;
  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
      );
      sent += 1;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription expired — prune.
        await pushSubscriptionsRepo.deleteSubscription(sub.subscriptionId).catch(() => {});
        pruned += 1;
      } else {
        errors += 1;
        console.warn(
          `[push-sender] send failed for ${sub.subscriptionId} (status=${statusCode}): ${(err as Error).message}`,
        );
      }
    }
  }
  return { sent, pruned, errors };
}

/** Fire-and-forget wrapper for callers that don't care about the result. */
export function sendToOperatorAsync(operatorId: string, payload: PushPayload): void {
  void sendToOperator(operatorId, payload).catch((err) => {
    console.warn(`[push-sender] sendToOperatorAsync uncaught: ${(err as Error).message}`);
  });
}

/**
 * Return the VAPID public key for the client-side subscribe() call. The
 * browser needs this to encrypt the subscription endpoint; the matching
 * private key stays server-side.
 */
export async function getVapidPublicKey(): Promise<string | null> {
  const vapid = await loadVapid();
  return vapid?.publicKey ?? null;
}

/**
 * 2026-05-27 PR D.f — broadcast to every operator's subscriptions.
 *
 * Used by sources that don't know the operatorId (the DeployerLambda
 * cron, CloudWatch alarms, daily-spend warnings). At v1 scale there's
 * effectively one operator, so this is cheap (~1 Query per operator).
 *
 * Fire-and-forget by default. Returns aggregate stats for diagnostics.
 */
export async function sendToAllOperators(payload: PushPayload): Promise<SendToOperatorResult> {
  // We don't have a `listAllOperators()` helper — Scan the subscriptions
  // table and project the unique operatorIds. Bounded by v1 device count.
  const allSubs = await listUniqueOperatorIds();
  let sent = 0;
  let pruned = 0;
  let errors = 0;
  for (const operatorId of allSubs) {
    const result = await sendToOperator(operatorId, payload);
    sent += result.sent;
    pruned += result.pruned;
    errors += result.errors;
  }
  return { sent, pruned, errors };
}

export function sendToAllOperatorsAsync(payload: PushPayload): void {
  void sendToAllOperators(payload).catch((err) => {
    console.warn(`[push-sender] sendToAllOperatorsAsync uncaught: ${(err as Error).message}`);
  });
}

async function listUniqueOperatorIds(): Promise<string[]> {
  // Lazy import to keep the module's load surface tight. Bounded full scan
  // — see the comment on listSubscriptionsByOperator.
  const { docClient } = await import('../dynamo-client');
  const { TABLE_NAMES } = await import('../dynamo-client');
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.pushSubscriptions,
      ProjectionExpression: 'operatorId',
    }),
  );
  const seen = new Set<string>();
  for (const item of (result.Items as { operatorId?: string }[] | undefined) ?? []) {
    if (item.operatorId) seen.add(item.operatorId);
  }
  return Array.from(seen);
}
