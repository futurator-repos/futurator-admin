import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  TagResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';

const DRY_RUN = process.argv.includes('--dry-run');

const TAG_MAPPING: Record<string, string> = {
  evidencegraph: 'mbe',
  contento: 'contento',
  applicator: 'applicator',
  gomad: 'gomad',
  debatator: 'gomad',
  atlassinator: 'atlassinator',
  dasher: 'dasher',
  songster: 'songster',
  mycelium: 'mycelium',
  'futurator-admin': 'admin-hub',
  'futurator-core': 'identity-broker',
  sellebra: 'sellebra',
};

const SERVICE_ROLE_MAP: Record<string, string> = {
  dynamodb: 'storage',
  s3: 'storage',
  lambda: 'compute',
  ecs: 'compute',
  ecr: 'registry',
  cloudfront: 'cdn',
  'api-gateway': 'networking',
  cognito: 'auth',
  ses: 'messaging',
  sqs: 'messaging',
  sns: 'messaging',
  events: 'scheduling',
};

function inferProject(arn: string, name: string): string | null {
  const combined = `${arn} ${name}`.toLowerCase();
  for (const [pattern, projectId] of Object.entries(TAG_MAPPING)) {
    if (combined.includes(pattern)) return projectId;
  }
  return null;
}

function inferServiceRole(arn: string): string {
  for (const [svc, role] of Object.entries(SERVICE_ROLE_MAP)) {
    if (arn.includes(`:${svc}:`)) return role;
  }
  return 'other';
}

async function bulkTag() {
  const client = new ResourceGroupsTaggingAPIClient({ region: 'us-east-1' });
  let tagged = 0;
  let skipped = 0;
  let paginationToken: string | undefined;

  console.log(DRY_RUN ? '🔍 DRY RUN — no changes will be made\n' : '🏷️  Applying tags...\n');

  do {
    const result = await client.send(
      new GetResourcesCommand({
        PaginationToken: paginationToken || undefined,
        ResourcesPerPage: 100,
      }),
    );

    for (const resource of result.ResourceTagMappingList || []) {
      const arn = resource.ResourceARN!;
      const existingTags: Record<string, string> = {};
      for (const tag of resource.Tags || []) {
        existingTags[tag.Key!] = tag.Value!;
      }

      if (existingTags['futurator:project']) {
        skipped++;
        continue;
      }

      const name = arn.split(/[:/]/).pop() || '';
      const projectId = inferProject(arn, name);
      if (!projectId) {
        console.log(`  ⚠ Cannot map: ${arn}`);
        skipped++;
        continue;
      }

      const tags: Record<string, string> = {
        'futurator:project': projectId,
        'futurator:environment': 'production',
        'futurator:service-role': inferServiceRole(arn),
        'futurator:managed-by': 'manual',
      };

      if (DRY_RUN) {
        console.log(`  Would tag ${arn} → ${projectId}`);
      } else {
        await client.send(new TagResourcesCommand({ ResourceARNList: [arn], Tags: tags }));
        console.log(`  ✓ Tagged ${arn} → ${projectId}`);
      }
      tagged++;
    }

    paginationToken = result.PaginationToken;
  } while (paginationToken);

  console.log(`\nDone! Tagged: ${tagged}, Skipped: ${skipped}`);
}

bulkTag().catch(console.error);
