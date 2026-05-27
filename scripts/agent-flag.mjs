#!/usr/bin/env node
/**
 * agent-flag — operator CLI for the global pause/resume switch.
 *
 * 2026-05-27 PR B.f. Reads/writes the `futurator-agent-flags` DDB table
 * directly using the operator's AWS profile (same pattern as migrate-
 * brownfield.mjs — no API hop, no JWT, no admin auth required at the API
 * level when the operator is already logged in to AWS).
 *
 * USAGE
 *   npm run agent:pause           # set agent.paused = 'true'
 *   npm run agent:resume          # set agent.paused = 'false'
 *   npm run agent:status          # print all flag rows
 *
 * The daemon polls `agent.paused` every 5s (cached) and skips PENDING job
 * dispatch when 'true'. In-flight jobs complete normally; only NEW work
 * is blocked.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { execSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';

const TABLE_NAME = process.env.AGENT_FLAGS_TABLE || 'futurator-agent-flags';
const REGION = process.env.AWS_REGION || 'us-east-1';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function operatorTag() {
  // CLI shortcuts run as the local operator — prefer git user.email if
  // available, otherwise fall back to OS user@host.
  try {
    const gitEmail = execSync('git config --global user.email', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (gitEmail) return `cli:${gitEmail}`;
  } catch {
    /* git not configured */
  }
  try {
    return `cli:${userInfo().username}@${hostname()}`;
  } catch {
    return 'cli:unknown';
  }
}

async function cmdPause() {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        flagName: 'agent.paused',
        value: 'true',
        updatedBy: operatorTag(),
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  console.log('✔ agent.paused = true');
  console.log('  Daemon picks up within 5s (cached). In-flight jobs complete normally.');
}

async function cmdResume() {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        flagName: 'agent.paused',
        value: 'false',
        updatedBy: operatorTag(),
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  console.log('✔ agent.paused = false');
  console.log('  Daemon picks up within 5s (cached) and resumes PENDING-job dispatch.');
}

async function cmdStatus() {
  const paused = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { flagName: 'agent.paused' } }),
  );
  if (paused?.Item) {
    console.log(
      `agent.paused = ${paused.Item.value}  (updated by ${paused.Item.updatedBy} at ${paused.Item.updatedAt})`,
    );
  } else {
    console.log('agent.paused = (unset → defaults to false)');
  }
  const all = await ddb.send(new ScanCommand({ TableName: TABLE_NAME }));
  const others = (all?.Items ?? []).filter((r) => r.flagName !== 'agent.paused');
  if (others.length > 0) {
    console.log('\nOther flags:');
    for (const f of others) {
      console.log(`  ${f.flagName} = ${f.value}  (by ${f.updatedBy} at ${f.updatedAt})`);
    }
  }
}

const subcmd = process.argv[2];
const handlers = { pause: cmdPause, resume: cmdResume, status: cmdStatus };
const handler = handlers[subcmd];
if (!handler) {
  console.error(`Usage: agent-flag <pause|resume|status>`);
  process.exit(2);
}
handler().catch((err) => {
  console.error(`agent-flag ${subcmd} failed:`, err.message);
  process.exit(1);
});
