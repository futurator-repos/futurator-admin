/**
 * Local-equivalent of functions/shared/export-public-projects.ts.
 *
 * Scans the projects DynamoDB table, filters/shapes the published projects
 * the same way the Lambda does, writes the resulting JSON to the futurator.ai
 * public bucket, and invalidates the CloudFront cache.
 *
 * Run when you need to force-regenerate data/projects.json without going
 * through the admin hub UI — e.g. after an accidental `aws s3 sync --delete`
 * wiped the file, or when debugging the export pipeline.
 *
 * Usage:
 *   npx tsx scripts/trigger-export.ts
 *
 * Uses the caller's default AWS credentials and the hardcoded dev-stage
 * resource names below. Idempotent — safe to run any number of times.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';

const REGION = 'us-east-1';
const TABLE = 'futurator-admin-dev-ProjectsTableTable-swomtonk';
const BUCKET = 'futurator-ai-website';
const DISTRIBUTION_ID = 'E1BI1YWMTLSDTE';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });
const cloudfront = new CloudFrontClient({ region: REGION });

interface ProjectRow {
  projectId: string;
  name: string;
  status?: string;
  homepageOrder?: number;
  publishedToHomepage?: boolean;
  descriptions?: {
    headline?: string;
    brief?: string;
    summary?: string;
    homepageFlags?: { headline?: boolean; brief?: boolean; summary?: boolean };
  };
  media?: Array<{ url?: string; alt?: string; order?: number; showOnHomepage?: boolean }>;
  awsServices?: string[];
}

async function main() {
  console.log(`Scanning ${TABLE}…`);
  const { Items } = await ddb.send(new ScanCommand({ TableName: TABLE }));
  const projects = (Items || []) as ProjectRow[];
  console.log(`  Found ${projects.length} total projects`);

  const published = projects
    .filter((p) => p.publishedToHomepage === true)
    .sort((a, b) => (a.homepageOrder ?? 0) - (b.homepageOrder ?? 0))
    .map((p) => ({
      name: p.name,
      headline: p.descriptions?.homepageFlags?.headline ? p.descriptions.headline : undefined,
      brief: p.descriptions?.homepageFlags?.brief ? p.descriptions.brief : undefined,
      summary: p.descriptions?.homepageFlags?.summary ? p.descriptions.summary : undefined,
      media: (p.media || [])
        .filter((m) => m.showOnHomepage)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(({ url, alt, order }) => ({ url, alt, order })),
      status: p.status,
      services: p.awsServices || [],
      order: p.homepageOrder ?? 0,
    }));

  console.log(`  Published (publishedToHomepage=true): ${published.length}`);
  published.forEach((p) => {
    const mediaCount = p.media.length;
    console.log(`    - ${p.name} (order ${p.order}, ${mediaCount} media)`);
  });

  const body = JSON.stringify(published);
  console.log(`\nWriting ${body.length} bytes to s3://${BUCKET}/data/projects.json…`);
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'data/projects.json',
      Body: body,
      ContentType: 'application/json',
      CacheControl: 'public, max-age=300',
    }),
  );
  console.log('  OK');

  console.log(`\nInvalidating CloudFront /data/projects.json on ${DISTRIBUTION_ID}…`);
  const inv = await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: DISTRIBUTION_ID,
      InvalidationBatch: {
        CallerReference: `manual-${Date.now()}`,
        Paths: { Quantity: 1, Items: ['/data/projects.json'] },
      },
    }),
  );
  console.log(`  Invalidation ID: ${inv.Invalidation?.Id}`);

  console.log('\nDone. Verify with: curl -s https://futurator.ai/data/projects.json | jq .');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
