import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AttentionItem, AttentionStatus } from '../types/attention';

export async function listAttentionItems(planId: string): Promise<AttentionItem[]> {
  const out: AttentionItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.attentionItems,
        KeyConditionExpression: 'planId = :planId',
        ExpressionAttributeValues: { ':planId': planId },
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as AttentionItem[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

export async function getAttentionItem(
  planId: string,
  itemId: string,
): Promise<AttentionItem | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.attentionItems, Key: { planId, itemId } }),
  );
  return (result.Item as AttentionItem) || null;
}

export async function createAttentionItem(item: AttentionItem): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.attentionItems, Item: item }));
}

export async function updateAttentionStatus(
  planId: string,
  itemId: string,
  status: AttentionStatus,
): Promise<AttentionItem | null> {
  const now = new Date().toISOString();
  const resolvedAt = status === 'resolved' ? now : null;
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.attentionItems,
      Key: { planId, itemId },
      UpdateExpression: 'SET #status = :status, resolvedAt = :resolvedAt',
      ConditionExpression: 'attribute_exists(itemId)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':resolvedAt': resolvedAt },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return (result.Attributes as AttentionItem) || null;
}
