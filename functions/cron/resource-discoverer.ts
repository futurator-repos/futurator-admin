import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import { putResource } from '../shared/repositories/resource-repository';
import { log } from '../shared/logger';
import type { AWSResource } from '../shared/types';

const MANDATORY_TAGS = [
  'futurator:project',
  'futurator:environment',
  'futurator:service-role',
  'futurator:managed-by',
];
const REGIONS = ['eu-central-1'];

function inferServiceType(arn: string): string {
  if (arn.includes(':dynamodb:')) return 'dynamodb';
  if (arn.includes(':s3:') || arn.includes(':s3:::')) return 's3';
  if (arn.includes(':lambda:')) return 'lambda';
  if (arn.includes(':ecs:')) return 'ecs';
  if (arn.includes(':ecr:')) return 'ecr';
  if (arn.includes(':cloudfront:')) return 'cloudfront';
  if (arn.includes(':apigateway:')) return 'api-gateway';
  if (arn.includes(':cognito-idp:')) return 'cognito';
  if (arn.includes(':events:')) return 'eventbridge';
  if (arn.includes(':sqs:')) return 'sqs';
  if (arn.includes(':sns:')) return 'sns';
  if (arn.includes(':logs:')) return 'cloudwatch';
  if (arn.includes(':ec2:')) return 'ec2';
  return 'other';
}

function extractName(arn: string): string {
  const parts = arn.split(/[:/]/);
  return parts[parts.length - 1] || arn;
}

export const handler = async () => {
  const startTime = Date.now();
  let totalResources = 0;

  try {
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
          const arn = resource.ResourceARN!;
          const tags: Record<string, string> = {};
          for (const tag of resource.Tags || []) {
            tags[tag.Key!] = tag.Value!;
          }

          const projectId = tags['futurator:project'] || 'untagged';
          const tagCompliant = MANDATORY_TAGS.every((t) => t in tags);

          const awsResource: AWSResource = {
            projectId,
            resourceArn: arn,
            serviceType: inferServiceType(arn),
            resourceName: extractName(arn),
            region,
            tags,
            config: {},
            tagCompliant,
            discoveredAt: new Date().toISOString(),
          };

          await putResource(awsResource);
          totalResources++;
        }

        paginationToken = result.PaginationToken;
      } while (paginationToken);
    }

    log('info', 'resource-discoverer', 'Completed', {
      totalResources,
      duration: Date.now() - startTime,
    });
  } catch (error) {
    log('error', 'resource-discoverer', 'Failed', { error: String(error), totalResources });
  }
};
