/**
 * graph-purge.ts — Story S2.3 (EU-migration completion plan).
 *
 * Replaces the old SSM/`mgconsole` Memgraph wipe (`MATCH (n {projectId}) DETACH
 * DELETE n`) in `DELETE /api/apps/:appId`. The graph source of truth is now the
 * DynamoDB pair `futurator-graph-nodes` / `futurator-graph-edges` (KD-1 — see
 * `daemon/scripts/lib/graph-store.mjs` for the canonical schema/key derivation
 * this mirrors). Runs directly from Lambda — zero EC2/SSM.
 *
 * Schema (mirrors graph-store.mjs — do not re-derive keys differently here):
 *   NODES: PK `projectId`, SK `nodeId`.
 *   EDGES: PK `src` (=`${projectId}|${nodeId}`), SK `sk`; `project-index` GSI
 *          (hashKey `projectId`, rangeKey `sk`) lists every edge for a project
 *          without crossing partitions.
 *
 * Both partitions are queried strictly by `projectId` (nodes: table PK; edges:
 * `project-index` GSI hash key) — no query ever spans projects, so a purge can
 * never touch another app's rows.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const BATCH_SIZE = 25;
const MAX_BATCH_RETRIES = 6;
const BASE_BACKOFF_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

/** Injectable for tests; defaults to the shared Lambda client + env table names. */
export interface GraphPurgeDeps {
  docClient?: DynamoDBDocumentClient;
  nodesTable?: string;
  edgesTable?: string;
  /** GSI name on the edges table mapping `projectId` → every edge row. Default `project-index`. */
  projectIndex?: string;
}

export interface GraphPurgeResult {
  nodesDeleted: number;
  edgesDeleted: number;
}

/** Run a Query to exhaustion, paginating on LastEvaluatedKey. */
async function queryAll(
  ddb: DynamoDBDocumentClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * BatchWrite `requests` to `table`, chunked at 25 (the DynamoDB limit), retrying
 * UnprocessedItems with exponential backoff (mirrors `graph-store-dynamo.mjs`).
 */
async function batchWrite(
  ddb: DynamoDBDocumentClient,
  table: string,
  requests: { DeleteRequest: { Key: Record<string, unknown> } }[],
): Promise<void> {
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    let batch = requests.slice(i, i + BATCH_SIZE);
    let attempt = 0;
    while (batch.length) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: batch } }));
      const unprocessed = (res.UnprocessedItems?.[table] ?? []) as typeof batch;
      if (unprocessed.length === 0) break;
      if (++attempt > MAX_BATCH_RETRIES) {
        throw new Error(
          `graph-purge: ${unprocessed.length} unprocessed items on ${table} after ${MAX_BATCH_RETRIES} retries`,
        );
      }
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
      await sleep(backoff);
      batch = unprocessed;
    }
  }
}

/**
 * Purge every node + edge row belonging to `projectId` (== appId) from the
 * graph store. Best-effort at the caller's discretion — this throws on a real
 * DynamoDB failure (unlike the old mgconsole path, there is no "daemon
 * unreachable" case to swallow; a thrown error here is a genuine fault the
 * `results[]` cascade in `DELETE /api/apps/:appId` should surface).
 *
 * @returns counts for the `{step:'graph', detail:'N nodes + M edges deleted'}` result row.
 */
export async function purgeProjectGraph(
  projectId: string,
  deps: GraphPurgeDeps = {},
): Promise<GraphPurgeResult> {
  if (!projectId) throw new Error('graph-purge: projectId is required');

  const ddb = deps.docClient ?? docClient;
  const nodesTable = deps.nodesTable ?? process.env.GRAPH_NODES_TABLE;
  const edgesTable = deps.edgesTable ?? process.env.GRAPH_EDGES_TABLE;
  const projectIndex = deps.projectIndex ?? 'project-index';

  if (!nodesTable || !edgesTable) {
    // Graph tables not provisioned/wired in this environment — nothing to purge.
    return { nodesDeleted: 0, edgesDeleted: 0 };
  }

  // Nodes: main-table query on the partition key (projectId), delete by {projectId, nodeId}.
  const nodeItems = await queryAll(ddb, {
    TableName: nodesTable,
    KeyConditionExpression: '#p = :p',
    ExpressionAttributeNames: { '#p': 'projectId' },
    ExpressionAttributeValues: { ':p': projectId },
    ProjectionExpression: 'projectId, nodeId',
  });
  await batchWrite(
    ddb,
    nodesTable,
    nodeItems.map((it) => ({
      DeleteRequest: { Key: { projectId: it.projectId, nodeId: it.nodeId } },
    })),
  );

  // Edges: project-index GSI query (projectId → sk) returns the base keys
  // (src, sk) needed to delete from the underlying table.
  const edgeItems = await queryAll(ddb, {
    TableName: edgesTable,
    IndexName: projectIndex,
    KeyConditionExpression: '#p = :p',
    ExpressionAttributeNames: { '#p': 'projectId' },
    ExpressionAttributeValues: { ':p': projectId },
    ProjectionExpression: 'src, sk',
  });
  await batchWrite(
    ddb,
    edgesTable,
    edgeItems.map((it) => ({ DeleteRequest: { Key: { src: it.src, sk: it.sk } } })),
  );

  return { nodesDeleted: nodeItems.length, edgesDeleted: edgeItems.length };
}
