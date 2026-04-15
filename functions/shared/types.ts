export type ProjectStatus = 'planning' | 'in-progress' | 'beta' | 'active';
export type ProjectCategory =
  | 'independent-companies'
  | 'joint-venture'
  | 'personal'
  | 'shared-infra';

export interface ProjectDescriptions {
  headline: string;
  brief: string;
  summary: string;
  full: string;
  aiContext: string;
  homepageFlags: {
    headline: boolean;
    brief: boolean;
    summary: boolean;
  };
}

export interface ProjectMedia {
  id: string;
  url: string;
  alt: string;
  showOnHomepage: boolean;
  order: number;
}

export interface Feature {
  id: string;
  name: string;
  status: ProjectStatus;
  awsServices: string[];
  aiProviders: string[];
  integrations: string[];
}

export interface Project {
  projectId: string;
  name: string;
  status: ProjectStatus;
  category: ProjectCategory;
  descriptions: ProjectDescriptions;
  media: ProjectMedia[];
  features: Feature[];
  awsServices: string[];
  team: string[];
  budget?: { monthlyLimit: number };
  publishedToHomepage: boolean;
  homepageOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CostRecord {
  projectId: string;
  date: string;
  provider: string;
  totalAmount: number;
  currency: string;
  breakdown: Record<string, number>;
  forecast?: { endOfMonth: number; confidence: 'low' | 'medium' | 'high' };
  anomalies?: {
    service: string;
    amount: number;
    expectedAmount: number;
    severity: 'low' | 'medium' | 'high';
  }[];
}

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

export interface AuditResult {
  projectId: string;
  auditDate: string;
  tagComplianceScore: number;
  totalResources: number;
  compliantResources: number;
  issues?: { rule: string; resource: string; severity: string; detail: string }[];
}

export interface Schedule {
  scheduleId: string;
  resourceType: 'ec2' | 'ecs';
  resourceId: string;
  projectId: string;
  action: 'start' | 'stop';
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  lastExecution?: { time: string; result: 'success' | 'failure' };
}

export interface DirectoryUser {
  userId: string;
  email: string;
  name: string;
  projects: Record<string, { role: string; lastLogin?: string }>;
  syncedAt: string;
}

export interface Alert {
  alertId: string;
  timestamp: string;
  projectId: string;
  type: 'cloudwatch-alarm' | 'budget-breach' | 'cost-anomaly';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  state?: string;
}
