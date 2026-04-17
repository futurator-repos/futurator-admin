import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Adapter around DynamoDBDocumentClient for the NDJSON forwarder.
 * Only two calls are needed: putEvent (idempotent) and queryMaxSeq.
 */
export function createDdbEventStore({ ddb, tableName }) {
  if (!ddb) throw new Error('createDdbEventStore: ddb client is required');
  if (!tableName) throw new Error('createDdbEventStore: tableName is required');

  async function putEvent(item) {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(eventSeq)',
      })
    );
  }

  async function queryMaxSeq(jobId) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'jobId = :jobId',
        ExpressionAttributeValues: { ':jobId': jobId },
        ProjectionExpression: 'eventSeq',
        ScanIndexForward: false,
        Limit: 1,
      })
    );
    const items = result.Items || [];
    if (items.length === 0) return 0;
    const seqStr = items[0].eventSeq || '000000';
    const n = parseInt(seqStr, 10);
    return Number.isFinite(n) ? n : 0;
  }

  return { putEvent, queryMaxSeq };
}
