import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { getAllProjects } from './repositories/project-repository';

const s3 = new S3Client({ region: 'us-east-1' });
const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
const BUCKET = process.env.FUTURATOR_PUBLIC_BUCKET || '';
const DISTRIBUTION_ID = process.env.FUTURATOR_CF_DISTRIBUTION_ID || '';

export async function exportPublicProjects(): Promise<void> {
  if (!BUCKET) {
    console.warn('[export] FUTURATOR_PUBLIC_BUCKET not set, skipping export');
    return;
  }

  try {
    const projects = await getAllProjects();

    const published = projects
      .filter((p) => p.publishedToHomepage)
      .sort((a, b) => (a.homepageOrder || 0) - (b.homepageOrder || 0))
      .map((p) => ({
        name: p.name,
        headline: p.descriptions?.homepageFlags?.headline ? p.descriptions.headline : undefined,
        brief: p.descriptions?.homepageFlags?.brief ? p.descriptions.brief : undefined,
        summary: p.descriptions?.homepageFlags?.summary ? p.descriptions.summary : undefined,
        media: (p.media || [])
          .filter((m) => m.showOnHomepage)
          .sort((a, b) => a.order - b.order)
          .map(({ url, alt, order }) => ({ url, alt, order })),
        status: p.status,
        services: p.awsServices || [],
        order: p.homepageOrder || 0,
      }));

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'data/projects.json',
        Body: JSON.stringify(published),
        ContentType: 'application/json',
        CacheControl: 'public, max-age=300',
      }),
    );

    console.log(`[export] Wrote ${published.length} projects to s3://${BUCKET}/data/projects.json`);

    // Fire-and-forget CloudFront cache invalidation
    if (DISTRIBUTION_ID) {
      cloudfront
        .send(
          new CreateInvalidationCommand({
            DistributionId: DISTRIBUTION_ID,
            InvalidationBatch: {
              CallerReference: `projects-${Date.now()}`,
              Paths: { Quantity: 1, Items: ['/data/projects.json'] },
            },
          }),
        )
        .catch((err) => console.error('[export] CloudFront invalidation failed:', err));
      console.log(`[export] CloudFront invalidation requested for distribution ${DISTRIBUTION_ID}`);
    }
  } catch (error) {
    console.error('[export] Failed to export public projects:', error);
    // Non-blocking: don't throw — the project save should still succeed
  }
}
