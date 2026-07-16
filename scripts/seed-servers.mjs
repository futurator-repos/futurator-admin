#!/usr/bin/env node
/**
 * seed-servers — one-shot, idempotent writer for the two "legacy" fleet
 * rows in `futurator-servers`: the always-on EC2 box (`srv_ec2_main`) and
 * the operator's Mac (`srv_local_mac`). These two servers fetch Claude
 * OAuth credentials the legacy way (Keychain → SSM sync, not the new
 * `x-server-token` enrollment flow), so they get `enrollTokenHash: 'SEEDED'`
 * instead of a real hashed token.
 *
 * This script only WRITES rows — it never runs, stops, or provisions
 * anything. Safe to re-run: each row is written with
 * `ConditionExpression: 'attribute_not_exists(serverId)'`, so a repeat
 * invocation no-ops with an "already seeded" log line instead of
 * clobbering operator edits (enabled/costPerHour/etc.) made via the UI.
 *
 * USAGE
 *   node scripts/seed-servers.mjs --yes
 *
 * Without `--yes` the script prints the two rows it would write and exits
 * without touching DynamoDB (dry-run / confirmation gate).
 *
 * ENV
 *   SERVERS_TABLE   DynamoDB table name (default: 'futurator-servers')
 *   AWS_REGION      injected by the operator's shell/SST env; never
 *                   hardcode a region here (see CLAUDE.md constraints)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.SERVERS_TABLE || 'futurator-servers';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function nowIso() {
  return new Date().toISOString();
}

function buildRows() {
  const ts = nowIso();
  return [
    {
      serverId: 'srv_ec2_main',
      name: 'EC2 (main)',
      provider: 'aws',
      serviceType: 'vm',
      region: 'eu-central-1',
      // Best-effort record of the current instance shape; update via
      // `PUT /api/servers/srv_ec2_main` once the real instance is known
      // precisely (see docs/deployment.md "EC2 daemon — full operations").
      size: 't3.small',
      arch: 'x86_64',
      status: 'ACTIVE',
      enabled: true,
      maxConcurrent: 2,
      // Approximate on-demand price for the size above; informative only
      // (spec §7 costPerHour is a sort key, not a billing source of truth).
      costPerHour: 0.0208,
      providerRef: {},
      enrollTokenHash: 'SEEDED',
      createdAt: ts,
      updatedAt: ts,
    },
    {
      serverId: 'srv_local_mac',
      name: 'Local (Mac)',
      provider: 'local',
      serviceType: 'local-machine',
      region: 'local',
      size: 'workstation',
      arch: 'arm64',
      status: 'ACTIVE',
      enabled: true,
      maxConcurrent: 2,
      costPerHour: 0,
      providerRef: {},
      enrollTokenHash: 'SEEDED',
      createdAt: ts,
      updatedAt: ts,
    },
  ];
}

async function seedRow(row) {
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE,
        Item: row,
        ConditionExpression: 'attribute_not_exists(serverId)',
      }),
    );
    console.log(`seeded ${row.serverId}`);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(`already seeded ${row.serverId}`);
      return;
    }
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const rows = buildRows();

  console.log(`Table: ${TABLE}`);
  console.log(`Rows to seed (idempotent — skips rows that already exist):`);
  for (const row of rows) {
    console.log(`  - ${row.serverId} (provider=${row.provider}, region=${row.region})`);
  }

  if (!confirmed) {
    console.log('\nDry run only — re-run with --yes to write these rows.');
    return;
  }

  for (const row of rows) {
    await seedRow(row);
  }
  console.log('Done!');
}

// Run only when invoked as a script (not when imported by tests).
const isMainModule =
  typeof import.meta !== 'undefined' &&
  import.meta.url &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { buildRows, main };
