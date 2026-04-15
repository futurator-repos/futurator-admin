import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import { putAuditResult } from '../shared/repositories/audit-repository';
import { log } from '../shared/logger';
import { format } from 'date-fns';

const MANDATORY_TAGS = [
  'futurator:project',
  'futurator:environment',
  'futurator:service-role',
  'futurator:managed-by',
];

export const handler = async () => {
  const startTime = Date.now();
  const auditDate = format(new Date(), 'yyyy-MM-dd');

  try {
    const client = new ResourceGroupsTaggingAPIClient({ region: 'us-east-1' });
    const projectStats = new Map<
      string,
      {
        total: number;
        compliant: number;
        issues: { rule: string; resource: string; severity: string; detail: string }[];
      }
    >();

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

        const projectId = tags['futurator:project'] || 'GLOBAL';
        if (!projectStats.has(projectId)) {
          projectStats.set(projectId, { total: 0, compliant: 0, issues: [] });
        }
        const stats = projectStats.get(projectId)!;
        stats.total++;

        const missingTags = MANDATORY_TAGS.filter((t) => !(t in tags));
        if (missingTags.length === 0) {
          stats.compliant++;
        } else {
          stats.issues.push({
            rule: 'missing-mandatory-tags',
            resource: resource.ResourceARN!,
            severity: 'warning',
            detail: `Missing tags: ${missingTags.join(', ')}`,
          });
        }
      }

      paginationToken = result.PaginationToken;
    } while (paginationToken);

    for (const [projectId, stats] of projectStats) {
      await putAuditResult({
        projectId,
        auditDate,
        tagComplianceScore:
          stats.total > 0 ? Math.round((stats.compliant / stats.total) * 100) : 100,
        totalResources: stats.total,
        compliantResources: stats.compliant,
        issues: stats.issues,
      });
    }

    log('info', 'tag-auditor', 'Completed', {
      projects: projectStats.size,
      duration: Date.now() - startTime,
    });
  } catch (error) {
    log('error', 'tag-auditor', 'Failed', { error: String(error) });
  }
};
