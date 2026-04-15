import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';

const MANDATORY_TAGS = [
  'futurator:project',
  'futurator:environment',
  'futurator:service-role',
  'futurator:managed-by',
];
const REGIONS = ['us-east-1'];

interface ResourceReport {
  arn: string;
  tags: Record<string, string>;
  missingTags: string[];
  compliant: boolean;
  project: string;
}

async function audit() {
  const resources: ResourceReport[] = [];

  for (const region of REGIONS) {
    const client = new ResourceGroupsTaggingAPIClient({ region });
    let paginationToken: string | undefined;

    do {
      const result = await client.send(
        new GetResourcesCommand({
          PaginationToken: paginationToken || undefined,
          ResourcesPerPage: 100,
        }),
      );

      for (const resource of result.ResourceTagMappingList || []) {
        const tags: Record<string, string> = {};
        for (const tag of resource.Tags || []) {
          tags[tag.Key!] = tag.Value!;
        }

        const missingTags = MANDATORY_TAGS.filter((t) => !(t in tags));
        resources.push({
          arn: resource.ResourceARN!,
          tags,
          missingTags,
          compliant: missingTags.length === 0,
          project: tags['futurator:project'] || 'untagged',
        });
      }

      paginationToken = result.PaginationToken;
    } while (paginationToken);
  }

  const compliant = resources.filter((r) => r.compliant).length;
  const grouped = resources.reduce(
    (acc, r) => {
      (acc[r.project] = acc[r.project] || []).push(r);
      return acc;
    },
    {} as Record<string, ResourceReport[]>,
  );

  const report = {
    summary: {
      totalResources: resources.length,
      compliant,
      nonCompliant: resources.length - compliant,
      compliancePercentage:
        resources.length > 0 ? Math.round((compliant / resources.length) * 100) : 100,
    },
    byProject: Object.fromEntries(
      Object.entries(grouped).map(([project, items]) => [
        project,
        {
          total: items.length,
          compliant: items.filter((i) => i.compliant).length,
          resources: items,
        },
      ]),
    ),
  };

  console.log(JSON.stringify(report, null, 2));
}

audit().catch(console.error);
