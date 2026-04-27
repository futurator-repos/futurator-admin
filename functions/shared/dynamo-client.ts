import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAMES = {
  projects: process.env.PROJECTS_TABLE || 'futurator-admin-projects',
  costs: process.env.COSTS_TABLE || 'futurator-admin-costs',
  resources: process.env.RESOURCES_TABLE || 'futurator-admin-resources',
  audits: process.env.AUDITS_TABLE || 'futurator-admin-audits',
  schedules: process.env.SCHEDULES_TABLE || 'futurator-admin-schedules',
  users: process.env.USERS_TABLE || 'futurator-admin-users',
  alerts: process.env.ALERTS_TABLE || 'futurator-admin-alerts',
  agentJobs: process.env.AGENT_JOBS_TABLE || 'futurator-agent-jobs',
  agentEvents: process.env.AGENT_EVENTS_TABLE || 'futurator-agent-events',
  epicWorkflows: process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows',
  projectRegistry: process.env.PROJECT_REGISTRY_TABLE || 'futurator-project-registry',
  partyProjects: process.env.PARTY_PROJECTS_TABLE || 'futurator-party-projects',
  partySessions: process.env.PARTY_SESSIONS_TABLE || 'futurator-party-sessions',
  plans: process.env.PLANS_TABLE || 'futurator-plans',
  attentionItems: process.env.ATTENTION_ITEMS_TABLE || 'futurator-attention-items',
  // Pipeline v1 — Epic 3 (Talk-to-agent) tables.
  agentSessions: process.env.AGENT_SESSIONS_TABLE || 'futurator-agent-sessions',
  agentConversations: process.env.AGENT_CONVERSATIONS_TABLE || 'futurator-agent-conversations',
} as const;
