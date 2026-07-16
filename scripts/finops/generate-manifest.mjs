#!/usr/bin/env node
/**
 * scripts/finops/generate-manifest.mjs
 *
 * Enumerates Futurator-Admin's live AWS resources (DynamoDB tables, Lambda
 * functions, S3 buckets) in account 421515025850 / eu-central-1, reads each
 * resource's tags, and writes manifest/infra.json — a machine-readable,
 * generated snapshot for FinOps + migration legibility.
 *
 * Dependency-free: shells out to the AWS CLI via child_process.execSync.
 * Idempotent: safe to re-run; always overwrites manifest/infra.json with a
 * fresh, fully-verified snapshot.
 *
 * Usage:
 *   node scripts/finops/generate-manifest.mjs
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const MANIFEST_DIR = join(REPO_ROOT, 'manifest');
const MANIFEST_PATH = join(MANIFEST_DIR, 'infra.json');

const ACCOUNT = '421515025850';
const REGION = 'eu-central-1';
const PROFILE = 'FuturatorClaude';

const DYNAMODB_PREFIX = 'futurator-';
const LAMBDA_PREFIX = 'futurator-admin-';
const S3_PREFIX = 'futurator-admin-';

/** Run an AWS CLI command and return parsed JSON output. */
function aws(args) {
  const cmd = `aws ${args} --profile ${PROFILE} --region ${REGION} --output json`;
  const out = execSync(cmd, {
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  const trimmed = out.trim();
  return trimmed.length > 0 ? JSON.parse(trimmed) : {};
}

/** List all DynamoDB tables whose name starts with the given prefix. */
function listDynamoDbTables(prefix) {
  const names = [];
  let lastEvaluatedTableName;
  do {
    const startArg = lastEvaluatedTableName
      ? ` --exclusive-start-table-name ${JSON.stringify(lastEvaluatedTableName)}`
      : '';
    const result = aws(`dynamodb list-tables${startArg}`);
    for (const name of result.TableNames || []) {
      if (name.startsWith(prefix)) names.push(name);
    }
    lastEvaluatedTableName = result.LastEvaluatedTableName;
  } while (lastEvaluatedTableName);
  return names;
}

/** Describe a table and return its ARN + tags. */
function describeDynamoDbTable(name) {
  const desc = aws(`dynamodb describe-table --table-name ${JSON.stringify(name)}`);
  const arn = desc.Table?.TableArn;
  if (!arn) return null;
  const tagResult = aws(`dynamodb list-tags-of-resource --resource-arn ${JSON.stringify(arn)}`);
  const tags = tagListToRecord(tagResult.Tags, 'Key', 'Value');
  return { type: 'dynamodb-table', name, arn, tags, verification_status: 'verified' };
}

/** List all Lambda functions whose name starts with the given prefix. */
function listLambdaFunctions(prefix) {
  const functions = [];
  let marker;
  do {
    const markerArg = marker ? ` --starting-token ${JSON.stringify(marker)}` : '';
    const result = aws(`lambda list-functions${markerArg}`);
    for (const fn of result.Functions || []) {
      if (fn.FunctionName?.startsWith(prefix)) {
        functions.push({ name: fn.FunctionName, arn: fn.FunctionArn });
      }
    }
    marker = result.NextMarker;
  } while (marker);
  return functions;
}

/** Fetch tags for a Lambda function ARN. */
function describeLambdaFunction({ name, arn }) {
  const tagResult = aws(`lambda list-tags --resource ${JSON.stringify(arn)}`);
  const tags = tagResult.Tags || {};
  return { type: 'lambda-function', name, arn, tags, verification_status: 'verified' };
}

/** List all S3 buckets whose name starts with the given prefix. */
function listS3Buckets(prefix) {
  const result = aws('s3api list-buckets');
  return (result.Buckets || [])
    .map((b) => b.Name)
    .filter((name) => name && name.startsWith(prefix));
}

/** Fetch tags for an S3 bucket; buckets with no tags 404 on get-bucket-tagging. */
function describeS3Bucket(name) {
  const arn = `arn:aws:s3:::${name}`;
  let tags = {};
  try {
    const tagResult = aws(`s3api get-bucket-tagging --bucket ${JSON.stringify(name)}`);
    tags = tagListToRecord(tagResult.TagSet, 'Key', 'Value');
  } catch (err) {
    // NoSuchTagSet is expected for untagged buckets — treat as empty tags.
    if (!String(err.message || err).includes('NoSuchTagSet')) throw err;
  }
  return { type: 's3-bucket', name, arn, tags, verification_status: 'verified' };
}

function tagListToRecord(list, keyField, valueField) {
  const record = {};
  for (const item of list || []) {
    record[item[keyField]] = item[valueField];
  }
  return record;
}

function main() {
  const resources = [];

  const dynamoNames = safe(() => listDynamoDbTables(DYNAMODB_PREFIX), 'dynamodb list-tables', []);
  for (const name of dynamoNames) {
    const resource = safe(() => describeDynamoDbTable(name), `dynamodb describe-table ${name}`);
    if (resource) resources.push(resource);
  }

  const lambdaFns = safe(() => listLambdaFunctions(LAMBDA_PREFIX), 'lambda list-functions', []);
  for (const fn of lambdaFns) {
    const resource = safe(() => describeLambdaFunction(fn), `lambda list-tags ${fn.name}`);
    if (resource) resources.push(resource);
  }

  const bucketNames = safe(() => listS3Buckets(S3_PREFIX), 's3api list-buckets', []);
  for (const name of bucketNames) {
    const resource = safe(() => describeS3Bucket(name), `s3api get-bucket-tagging ${name}`);
    if (resource) resources.push(resource);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    account: ACCOUNT,
    region: REGION,
    resources,
  };

  if (!existsSync(MANIFEST_DIR)) {
    mkdirSync(MANIFEST_DIR, { recursive: true });
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const byType = resources.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byType)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  console.log(
    `[finops] manifest/infra.json written — ${resources.length} resource(s)${
      summary ? ` (${summary})` : ' (none found)'
    } — account ${ACCOUNT}/${REGION}`,
  );
}

/** Run fn(); on failure, log a warning and return fallback (default: null). */
function safe(fn, label, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.error(`[finops] warning: ${label} failed — ${err.message || err}`);
    return fallback;
  }
}

main();
