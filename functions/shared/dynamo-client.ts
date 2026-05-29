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
  partyEvents: process.env.PARTY_EVENTS_TABLE || 'futurator-party-events',
  epicWorkflows: process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows',
  projectRegistry: process.env.PROJECT_REGISTRY_TABLE || 'futurator-project-registry',
  partyProjects: process.env.PARTY_PROJECTS_TABLE || 'futurator-party-projects',
  partySessions: process.env.PARTY_SESSIONS_TABLE || 'futurator-party-sessions',
  partyInlineQuestions:
    process.env.PARTY_INLINE_QUESTIONS_TABLE || 'futurator-party-inline-questions',
  plans: process.env.PLANS_TABLE || 'futurator-plans',
  apps: process.env.APPS_TABLE || 'futurator-apps',
  attentionItems: process.env.ATTENTION_ITEMS_TABLE || 'futurator-attention-items',
  // Story C (agentic-integration, 2026-05-29) — durable wave-merge conflict
  // telemetry. PK planId, SK conflictId (epoch-ms-prefixed). GSI
  // appId-createdAt for the cross-plan conflict-rate view.
  waveConflicts: process.env.WAVE_CONFLICTS_TABLE || 'futurator-wave-conflicts',
  // Pipeline v1 — Epic 3 (Talk-to-agent) tables.
  agentSessions: process.env.AGENT_SESSIONS_TABLE || 'futurator-agent-sessions',
  agentConversations: process.env.AGENT_CONVERSATIONS_TABLE || 'futurator-agent-conversations',
  // Pipeline v2 Phase 1 — Story 1.8.6: cron-aggregated cohort baselines.
  timingSummary: process.env.TIMING_SUMMARY_TABLE || 'futurator-timing-summary',
  // Pipeline v2 Phase 3 — Story 3-E-3-1 (PR-76): Reflection Inbox storage.
  // Partition by projectSlug so the labs UI per-project view + the cross-
  // project /labs/reflections list both read efficiently. Sort key is the
  // proposal id (ULID-shape).
  reflections: process.env.REFLECTIONS_TABLE || 'futurator-reflections',
  // Epic 18 — Story 18.2: Free Claude Code Agent sessions. One row per
  // session; PK sessionId; GSI1 operator-recent-index; GSI2 scope-recent-index;
  // 90-day TTL via `expiresAt` (epoch seconds).
  freeAgentSessions: process.env.FREE_AGENT_SESSIONS_TABLE || 'futurator-free-agent-sessions',
  // Epic 18 — Story 18.6: Free Claude Code Agent conversation messages.
  // PK sessionId, SK messageIndex (zero-padded 6-digit). 90-day TTL.
  freeAgentConversations:
    process.env.FREE_AGENT_CONVERSATIONS_TABLE || 'futurator-free-agent-conversations',
  // 2026-05-27 PR B — global agent feature flags (e.g. `agent.paused`).
  // PK: flagName. Read by daemon (pre-claim gate) + API (GET state).
  agentFlags: process.env.AGENT_FLAGS_TABLE || 'futurator-agent-flags',
  // 2026-05-27 PR B — per-job spend log. PK: logId. GSI1 date+createdAt for
  // `getDailySpend(today)`. 90d TTL.
  agentSpendLog: process.env.AGENT_SPEND_LOG_TABLE || 'futurator-agent-spend-log',
  // 2026-05-27 PR C.e — per-(plan,wave) fix-attempt counter. PK: cycleKey
  // = `${planId}#${waveNumber}`. 30d TTL.
  fixCycles: process.env.FIX_CYCLES_TABLE || 'futurator-fix-cycles',
  // 2026-05-27 PR D.a — per-AttentionCategory remediation policy.
  // PK: category. Body: { policy, updatedBy, updatedAt }.
  remediationPolicies: process.env.REMEDIATION_POLICIES_TABLE || 'futurator-remediation-policies',
  // 2026-05-27 PR D.f — PWA push subscriptions. PK: subscriptionId. GSI1
  // operator-index for "all devices for this operator" lookups.
  pushSubscriptions: process.env.PUSH_SUBSCRIPTIONS_TABLE || 'futurator-push-subscriptions',
} as const;
