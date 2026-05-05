import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

const jobIds = ['f96e158e-4de4-493f-84ae-ccd95bb424af','bc95fcc4-9996-4a0a-b8bb-c1ccd1dbd406','8a437af2-85b4-4fdf-9aba-247120ad01be','e2b15517-6c89-4408-aebf-d493491ada05','8ea1d885-1e0f-4265-aac2-82eb546fa22f','a1671643-625d-47b1-bf09-9ff1eec782c2'];
const counts = {};
for (const j of jobIds) {
  let lk;
  do {
    const r = await ddb.send(new QueryCommand({TableName:'futurator-agent-events', KeyConditionExpression:'jobId = :j', ExpressionAttributeValues:{':j':j}, ExclusiveStartKey:lk}));
    for (const e of r.Items||[]) {
      counts[e.eventType] = (counts[e.eventType]||0)+1;
    }
    lk = r.LastEvaluatedKey;
  } while (lk);
}
console.log(JSON.stringify(counts, null, 2));
