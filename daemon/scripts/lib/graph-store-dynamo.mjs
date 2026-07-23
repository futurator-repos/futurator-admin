/**
 * graph-store-dynamo.mjs — DynamoDB-backed GraphStore (source of truth).
 *
 * Story S0.2. Two tables (`futurator-graph-nodes` + `futurator-graph-edges`)
 * with the adjacency-list + reverse-GSI schema documented in `graph-store.mjs`.
 * Runs from ANY fleet host AND from Lambda (bolt never could — KD-1). Node/edge
 * key derivation is shared with the memory impl via `buildNodeItem`/
 * `buildEdgeItem`, so both pass the same interface suite.
 *
 * BatchWrite is chunked at 25 (the DynamoDB limit) with exponential backoff on
 * UnprocessedItems. All queries paginate on LastEvaluatedKey.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  buildNodeItem,
  buildEdgeItem,
  toNode,
  toEdge,
  edgeSrc,
  nodeKindKey,
  nodeFileKey,
  DEFAULT_INDEXES,
  MUTABLE_NODE_ATTRS,
} from './graph-store.mjs';

const BATCH_SIZE = 25;
const MAX_BATCH_RETRIES = 6;
const BASE_BACKOFF_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} opts.nodesTable  DynamoDB nodes table name
 * @param {string} opts.edgesTable  DynamoDB edges table name
 * @param {string} [opts.region]    AWS region (default: env AWS_REGION / eu-central-1)
 * @param {object} [opts.indexes]   GSI name overrides (see DEFAULT_INDEXES)
 * @param {object} [opts.client]    a pre-built DynamoDBDocumentClient (tests)
 */
export function createDynamoGraphStore(opts = {}) {
  const nodesTable = opts.nodesTable ?? process.env.GRAPH_NODES_TABLE;
  const edgesTable = opts.edgesTable ?? process.env.GRAPH_EDGES_TABLE;
  if (!nodesTable || !edgesTable) {
    throw new Error('graph-store-dynamo: nodesTable and edgesTable are required');
  }
  const idx = { ...DEFAULT_INDEXES, ...(opts.indexes ?? {}) };
  const region = opts.region ?? process.env.AWS_REGION ?? 'eu-central-1';

  const ddb =
    opts.client ??
    DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });

  /** BatchWrite `requests` to `table`, chunked at 25, retrying UnprocessedItems. */
  async function batchWrite(table, requests) {
    for (let i = 0; i < requests.length; i += BATCH_SIZE) {
      let batch = requests.slice(i, i + BATCH_SIZE);
      let attempt = 0;
      while (batch.length) {
        const res = await ddb.send(
          new BatchWriteCommand({ RequestItems: { [table]: batch } }),
        );
        const unprocessed = res.UnprocessedItems?.[table] ?? [];
        if (unprocessed.length === 0) break;
        if (++attempt > MAX_BATCH_RETRIES) {
          throw new Error(
            `graph-store-dynamo: ${unprocessed.length} unprocessed items on ${table} after ${MAX_BATCH_RETRIES} retries`,
          );
        }
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
        await sleep(backoff);
        batch = unprocessed;
      }
    }
  }

  /** Run a Query to exhaustion, paginating on LastEvaluatedKey. */
  async function queryAll(params) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
      if (res.Items?.length) items.push(...res.Items);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  return {
    async putNodes(projectId, nodes = []) {
      const requests = nodes.map((node) => ({
        PutRequest: { Item: buildNodeItem(projectId, node) },
      }));
      await batchWrite(nodesTable, requests);
      return requests.length;
    },

    async putEdges(projectId, edgeList = []) {
      const requests = edgeList.map((edge) => ({
        PutRequest: { Item: buildEdgeItem(projectId, edge) },
      }));
      await batchWrite(edgesTable, requests);
      return requests.length;
    },

    async getNode(projectId, nodeId) {
      const res = await ddb.send(
        new GetCommand({ TableName: nodesTable, Key: { projectId, nodeId } }),
      );
      return toNode(res.Item ?? null);
    },

    async outEdges(projectId, nodeId, { type } = {}) {
      const items = await queryAll({
        TableName: edgesTable,
        KeyConditionExpression: type ? '#src = :src AND begins_with(#sk, :pfx)' : '#src = :src',
        ExpressionAttributeNames: type ? { '#src': 'src', '#sk': 'sk' } : { '#src': 'src' },
        ExpressionAttributeValues: type
          ? { ':src': edgeSrc(projectId, nodeId), ':pfx': `${type}|` }
          : { ':src': edgeSrc(projectId, nodeId) },
      });
      return items.map(toEdge);
    },

    async inEdges(projectId, nodeId, { type } = {}) {
      const items = await queryAll({
        TableName: edgesTable,
        IndexName: idx.reverse,
        KeyConditionExpression: type ? '#dst = :dst AND begins_with(#rsk, :pfx)' : '#dst = :dst',
        ExpressionAttributeNames: type ? { '#dst': 'dst', '#rsk': 'rsk' } : { '#dst': 'dst' },
        ExpressionAttributeValues: type
          ? { ':dst': edgeSrc(projectId, nodeId), ':pfx': `${type}|` }
          : { ':dst': edgeSrc(projectId, nodeId) },
      });
      return items.map(toEdge);
    },

    async queryByKind(projectId, kind) {
      const items = await queryAll({
        TableName: nodesTable,
        IndexName: idx.kind,
        KeyConditionExpression: '#kk = :kk',
        ExpressionAttributeNames: { '#kk': 'kindKey' },
        ExpressionAttributeValues: { ':kk': nodeKindKey(projectId, kind) },
      });
      return items.map(toNode);
    },

    async queryByFile(projectId, file) {
      const items = await queryAll({
        TableName: nodesTable,
        IndexName: idx.file,
        KeyConditionExpression: '#fk = :fk',
        ExpressionAttributeNames: { '#fk': 'fileKey' },
        ExpressionAttributeValues: { ':fk': nodeFileKey(projectId, file) },
      });
      return items.map(toNode);
    },

    async listNodes(projectId) {
      const items = await queryAll({
        TableName: nodesTable,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'projectId' },
        ExpressionAttributeValues: { ':p': projectId },
      });
      return items.map(toNode);
    },

    async listEdges(projectId) {
      const items = await queryAll({
        TableName: edgesTable,
        IndexName: idx.project,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'projectId' },
        ExpressionAttributeValues: { ':p': projectId },
      });
      return items.map(toEdge);
    },

    async setNodeAttrs(projectId, nodeId, attrs = {}) {
      const sets = [];
      const names = {};
      const values = {};
      for (const k of MUTABLE_NODE_ATTRS) {
        if (attrs[k] === undefined) continue;
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = attrs[k];
      }
      // kind/file mutations also re-derive their composite GSI keys.
      if (attrs.kind !== undefined) {
        sets.push('#kind = :kind', '#kindKey = :kindKey');
        names['#kind'] = 'kind';
        names['#kindKey'] = 'kindKey';
        values[':kind'] = attrs.kind;
        values[':kindKey'] = nodeKindKey(projectId, attrs.kind);
      }
      if (attrs.file !== undefined) {
        sets.push('#file = :file', '#fileKey = :fileKey');
        names['#file'] = 'file';
        names['#fileKey'] = 'fileKey';
        values[':file'] = attrs.file;
        values[':fileKey'] = nodeFileKey(projectId, attrs.file);
      }
      if (!sets.length) return false;
      await ddb.send(
        new UpdateCommand({
          TableName: nodesTable,
          Key: { projectId, nodeId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    },

    async deleteProject(projectId) {
      // Nodes: main-table query on the partition key, delete by {projectId,nodeId}.
      const nodeItems = await queryAll({
        TableName: nodesTable,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'projectId' },
        ExpressionAttributeValues: { ':p': projectId },
        ProjectionExpression: 'projectId, nodeId',
      });
      await batchWrite(
        nodesTable,
        nodeItems.map((it) => ({
          DeleteRequest: { Key: { projectId: it.projectId, nodeId: it.nodeId } },
        })),
      );

      // Edges: project-index query returns the base keys (src, sk) for deletion.
      const edgeItems = await queryAll({
        TableName: edgesTable,
        IndexName: idx.project,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'projectId' },
        ExpressionAttributeValues: { ':p': projectId },
        ProjectionExpression: 'src, sk',
      });
      await batchWrite(
        edgesTable,
        edgeItems.map((it) => ({ DeleteRequest: { Key: { src: it.src, sk: it.sk } } })),
      );

      return { nodes: nodeItems.length, edges: edgeItems.length };
    },

    // Exposed for symmetry / potential direct use; harmless no-op close.
    async close() {},
  };
}
