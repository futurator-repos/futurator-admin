export interface AWSResource {
  projectId: string;
  resourceArn: string;
  serviceType: string;
  resourceName: string;
  region: string;
  tags: Record<string, string>;
  config: Record<string, string>;
  tagCompliant: boolean;
  discoveredAt: string;
}

export interface ResourceSummary {
  totalResources: number;
  byServiceType: Record<string, number>;
  overallCompliance: number;
  byProject: ProjectResourceSummary[];
}

export interface ProjectResourceSummary {
  projectId: string;
  resourceCount: number;
  complianceScore: number;
}
