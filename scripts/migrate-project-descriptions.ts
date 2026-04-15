import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const TABLE_NAME = process.env.PROJECTS_TABLE || 'futurator-admin-projects';

async function migrate() {
  console.log(`Migrating projects in table: ${TABLE_NAME}`);

  const { Items: projects } = await client.send(new ScanCommand({ TableName: TABLE_NAME }));

  if (!projects || projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  let migrated = 0;
  let skipped = 0;

  for (const project of projects) {
    // Idempotency: skip if already migrated
    if (project.descriptions) {
      console.log(`  SKIP: ${project.name} (already migrated)`);
      skipped++;
      continue;
    }

    const brief = project.brief || '';
    const headline = brief.substring(0, 60);

    const descriptions = {
      headline,
      brief: brief.substring(0, 140),
      summary: '',
      full: '',
      aiContext: '',
      homepageFlags: { headline: false, brief: false, summary: false },
    };

    // Expand features with new arrays
    const features = (project.features || []).map((f: Record<string, unknown>) => ({
      ...f,
      aiProviders: f.aiProviders || [],
      integrations: f.integrations || [],
    }));

    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { projectId: project.projectId },
        UpdateExpression:
          'SET descriptions = :desc, media = :media, publishedToHomepage = :pub, homepageOrder = :ord, features = :feat, updatedAt = :ts REMOVE brief',
        ExpressionAttributeValues: {
          ':desc': descriptions,
          ':media': [],
          ':pub': false,
          ':ord': 0,
          ':feat': features,
          ':ts': new Date().toISOString(),
        },
      }),
    );

    console.log(`  MIGRATED: ${project.name} (headline: "${headline.substring(0, 30)}...")`);
    migrated++;
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}, Total: ${projects.length}`);
}

migrate().catch(console.error);
