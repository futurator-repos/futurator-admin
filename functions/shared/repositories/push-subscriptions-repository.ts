/**
 * push-subscriptions-repository.ts — 2026-05-27 PR D.f.
 *
 * One row per device (browser → operator → endpoint). The push-sender
 * resolves "all subscriptions for this operator" via GSI1 to fan out a
 * notification to every device.
 *
 * Schema:
 *   PK: subscriptionId (uuid generated server-side)
 *   GSI1: operator-index (operatorId)
 *   body: { endpoint, keys: { p256dh, auth }, userAgent?, createdAt }
 *
 * No TTL — operators may use the same browser for months. The push-sender
 * prunes 404/410-responding subscriptions (the Push gateway tells us when
 * a sub has expired) inside its send loop.
 */

import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { docClient, TABLE_NAMES } from '../dynamo-client';

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionRow {
  subscriptionId: string;
  operatorId: string;
  endpoint: string;
  keys: PushSubscriptionKeys;
  userAgent?: string;
  createdAt: string;
}

export interface CreateSubscriptionInput {
  operatorId: string;
  endpoint: string;
  keys: PushSubscriptionKeys;
  userAgent?: string;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<PushSubscriptionRow> {
  const row: PushSubscriptionRow = {
    subscriptionId: randomUUID(),
    operatorId: input.operatorId,
    endpoint: input.endpoint,
    keys: input.keys,
    userAgent: input.userAgent,
    createdAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.pushSubscriptions, Item: row }));
  return row;
}

export async function getSubscription(subscriptionId: string): Promise<PushSubscriptionRow | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.pushSubscriptions,
      Key: { subscriptionId },
    }),
  );
  return (result.Item as PushSubscriptionRow | undefined) ?? null;
}

export async function listSubscriptionsByOperator(
  operatorId: string,
): Promise<PushSubscriptionRow[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.pushSubscriptions,
      IndexName: 'operator-index',
      KeyConditionExpression: 'operatorId = :op',
      ExpressionAttributeValues: { ':op': operatorId },
    }),
  );
  return (result.Items as PushSubscriptionRow[] | undefined) ?? [];
}

export async function deleteSubscription(subscriptionId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAMES.pushSubscriptions,
      Key: { subscriptionId },
    }),
  );
}
