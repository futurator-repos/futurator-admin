#!/usr/bin/env node
/**
 * Pre-epic wipe — App/Plan v1 (Story 1.5).
 *
 * Deletes ALL rows from the Plans table and cascades to ALL rows in the
 * Epic Workflows table. Existing Plans/Epics are throwaway prototypes
 * (per operator confirmation 2026-04-27); the new App/Plan v1 schema starts
 * from a clean slate.
 *
 * EXPLICITLY DOES NOT TOUCH:
 *   - Projects table (active Project Registry — Epic 2 of base build, used by
 *     the AWS portfolio dashboard, cost tracking, resource map)
 *   - Apps table (newly created in Story 1.4; should be empty anyway)
 *   - Agent jobs / events / sessions / conversations (orphaned rows are
 *     harmless and may carry useful debugging context)
 *   - S3 deploy bundles (operator may want to roll back)
 *   - EC2 working folders at /home/ubuntu/projects/* (manual operator cleanup
 *     via SSM if needed; this script does NOT shell out)
 *
 * Run with explicit confirmation:
 *   node scripts/wipe-pre-app-plan-v1.mjs --yes-really-wipe-everything
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const PLANS_TABLE = process.env.PLANS_TABLE || 'futurator-plans';
const EPIC_WORKFLOWS_TABLE = process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);

function abort(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function confirmFlagPresent() {
  if (!process.argv.includes('--yes-really-wipe-everything')) {
    abort(
      'Refusing to run without --yes-really-wipe-everything. This is destructive — re-read the file header before invoking.',
    );
  }
}

async function scanAllKeys(tableName, keyAttribute) {
  const keys = [];
  let lastEvaluatedKey;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: '#k',
        ExpressionAttributeNames: { '#k': keyAttribute },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    for (const item of result.Items || []) {
      keys.push(item[keyAttribute]);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return keys;
}

/**
 * Delete a list of items from a table by single-attribute primary key.
 * Uses BatchWriteCommand in chunks of 25 (DDB limit).
 */
async function batchDelete(tableName, keyAttribute, keys) {
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    const requestItems = {
      [tableName]: chunk.map((k) => ({
        DeleteRequest: { Key: { [keyAttribute]: k } },
      })),
    };
    await docClient.send(new BatchWriteCommand({ RequestItems: requestItems }));
    console.log(`  deleted ${Math.min(i + 25, keys.length)} / ${keys.length} from ${tableName}`);
  }
}

async function main() {
  confirmFlagPresent();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Pre-App/Plan-v1 Wipe');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Plans table:  ${PLANS_TABLE}`);
  console.log(`  Epics table:  ${EPIC_WORKFLOWS_TABLE}`);
  console.log(`  Region:       ${process.env.AWS_REGION || 'us-east-1'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();

  console.log('▸ Scanning Plans table…');
  const planIds = await scanAllKeys(PLANS_TABLE, 'planId');
  console.log(`  ${planIds.length} Plans found.`);

  console.log('▸ Scanning Epic Workflows table…');
  const epicIds = await scanAllKeys(EPIC_WORKFLOWS_TABLE, 'epicId');
  console.log(`  ${epicIds.length} Epics found.`);

  if (planIds.length === 0 && epicIds.length === 0) {
    console.log('Nothing to delete. Exiting.');
    return;
  }

  console.log();
  console.log('▸ Deleting Plans…');
  if (planIds.length > 0) {
    await batchDelete(PLANS_TABLE, 'planId', planIds);
  }

  console.log('▸ Deleting Epics…');
  if (epicIds.length > 0) {
    await batchDelete(EPIC_WORKFLOWS_TABLE, 'epicId', epicIds);
  }

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ Wipe complete. ${planIds.length} Plans + ${epicIds.length} Epics deleted.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log('Next steps (manual, NOT performed by this script):');
  console.log('  1. SSH to the daemon EC2 and clear stale folders:');
  console.log('     ssh ubuntu@<ec2> "rm -rf /home/ubuntu/projects/*"');
  console.log('  2. Optionally clean S3 deploy bundles you no longer want:');
  console.log('     aws s3 rm s3://futurator-ai-website/apps/<old-slug>/ --recursive');
  console.log('  3. Run sst deploy to provision the new Apps table + Plans GSI.');
}

main().catch((err) => {
  console.error('✖ Wipe failed:', err);
  process.exit(1);
});
