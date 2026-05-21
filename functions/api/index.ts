import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { authMiddleware } from '../shared/auth-middleware';
import { AppError, NotFoundError, ValidationError } from '../shared/errors';
import type { Project } from '../shared/types';
import {
  projectUpdateSchema,
  costRangeSchema,
  budgetSchema,
  scheduleCreateSchema,
  scheduleUpdateSchema,
  manualCostSchema,
} from '../shared/schemas/project-schema';
import * as projectRepo from '../shared/repositories/project-repository';
import * as identityBrokerRepo from '../shared/repositories/identity-broker-repository';
import * as costRepo from '../shared/repositories/cost-repository';
import * as resourceRepo from '../shared/repositories/resource-repository';
import * as auditRepo from '../shared/repositories/audit-repository';
import * as scheduleRepo from '../shared/repositories/schedule-repository';
import * as userRepo from '../shared/repositories/user-repository';
import * as alertRepo from '../shared/repositories/alert-repository';
import * as agentJobsRepo from '../shared/repositories/agent-jobs-repository';
import * as agentEventsRepo from '../shared/repositories/agent-events-repository';
import * as partyProjectsRepo from '../shared/repositories/party-projects-repository';
import * as partySessionsRepo from '../shared/repositories/party-sessions-repository';
// Epic 18 / Story 18.3 — Free Claude Code Agent audit endpoint.
import * as freeAgentSessionsRepo from '../shared/repositories/free-agent-sessions-repository';
// Epic 18 / Story 18.6 — conversation message persistence + thread list.
import * as freeAgentConversationsRepo from '../shared/repositories/free-agent-conversations-repository';
// Epic 18 / Story 18.5 — STS credentials minting + cost cap default.
import {
  assumeFreeAgentSessionRole,
  refreshSessionCredentials,
  type SessionCredentials,
} from '../shared/lib/free-agent-iam';
import {
  CreateFreeAgentSessionInputSchema,
  SendFreeAgentMessageInputSchema,
} from '../shared/schemas/free-agent-schema';
import { FREE_AGENT_DEFAULT_COST_CAP_USD } from '../shared/types/free-agent';
import * as inlineQuestionsRepo from '../shared/repositories/inline-questions-repository';
import {
  INLINE_QUESTION_DEFAULT_MODEL,
  INLINE_QUESTION_MAX_TOKENS,
  INLINE_QUESTION_SNIPPET_MAX,
  INLINE_QUESTION_QUESTION_MAX,
  INLINE_QUESTION_CONTEXT_MAX,
  type InlineQuestion,
} from '../shared/types/inline-question';
import Anthropic from '@anthropic-ai/sdk';
import {
  bootstrapInputSchema,
  projectIdSchema,
  createSessionInputSchema,
  sessionIdSchema,
  sendMessageInputSchema,
  createPartyProjectInputSchema,
  docUploadUrlInputSchema,
  docSyncInputSchema,
  refreshProjectParamsSchema,
  updateMigrationInputSchema,
} from '../shared/schemas/party-schema';
import {
  EXPECTED_AGENT_COUNT,
  PARTY_DOC_ALLOWED_CONTENT_TYPES,
  PARTY_DOCS_S3_PREFIX,
  TOGGLEABLE_TOOLS,
  brownfieldPatSecretNameFor,
} from '../shared/types/party';
import { createAgentJobSchema } from '../shared/schemas/agent-orchestrator-schema';
import { resolveBlockerSchema } from '../shared/schemas/resolve-blocker-schema';
import { validateEpicForOrchestratorStart } from '../shared/services/epic-dev-launcher';
import { launchPipelineWave, findFirstWave } from '../shared/services/pipeline-launcher';
import { launchStoryRerun } from '../shared/services/story-rerun-launcher';
import {
  launchVisualQa,
  launchPlanQaAggregate,
  launchPlanQaExecute,
} from '../shared/services/visual-qa-launcher';
import { resolveQaContext } from '../shared/services/qa-boilerplate-resolver';
import { defaultCostCeiling } from '../shared/services/cost-ceiling-defaults';
import { launchDevServer } from '../shared/services/dev-server-launcher';
import { generateStoryPipeline } from '../shared/pipelines/story-pipeline';
import { aggregateOrchestratorMetrics } from '../shared/services/epic-orchestrator-metrics';
import { enqueueResumeJob } from '../shared/services/resume-job';
import * as epicRepo from '../shared/repositories/epic-workflow-repository';
import * as planRepo from '../shared/repositories/plan-repository';
import * as appRepo from '../shared/repositories/app-repository';
import { updateAppInputSchema, RESERVED_APP_IDS } from '../shared/schemas/app-schema';
import { createPlanForAppInputSchema } from '../shared/schemas/plan-schema';
import type { App, AppCardData } from '../shared/types/app';
import * as attentionRepo from '../shared/repositories/attention-items-repository';
import type { AttentionStatus } from '../shared/types/attention';
// PR-76 (Story 3-E-3-1) — Reflection Inbox service + types.
import * as reflectionsService from '../shared/services/reflections-service';
import type { ReflectionStatus } from '../shared/types/reflection';
import { buildQaReport } from '../shared/repositories/qa-report-aggregator';
import { buildDeployReport } from '../shared/repositories/deploy-report-aggregator';
import {
  parseVisualTests as sharedParseVisualTests,
  buildQaPipeline as sharedBuildQaPipeline,
  buildQaAggregatePipeline,
  buildQaExecutePipeline,
} from '../shared/pipelines/visual-qa-pipeline';
import * as registryRepo from '../shared/repositories/project-registry-repository';
import type { EpicStory, EpicWorkflow } from '../shared/types/epic-workflow';
import type { Plan } from '../shared/types/plan';
import { planCreateInputSchema, planPatchSchema } from '../shared/schemas/plan-schema';
import {
  bootstrapPlanFolder,
  writePlanMarkdown,
  movePlanFolderToTrash,
  restorePlanFolder,
  deletePlanFolder,
} from '../shared/services/plan-folder-service';
import { generatePmPlanPipeline } from '../shared/pipelines/pm-plan-pipeline';
import { generateSkillScoutPipeline } from '../shared/pipelines/skill-scout-pipeline';
import { parsePlanOutput, applyPlanOutput } from '../shared/services/plan-generation-service';
import { computePlanWaves, epicsInPlanWave } from '../shared/services/plan-waves';
import type { PipelineDefinition } from '../shared/types/agent-orchestrator';
import { exportPublicProjects } from '../shared/export-public-projects';
import { renderFlatLog, filterEvents } from '../shared/rendering/flat-log';
import type { AgentEvent } from '../shared/types/agent-orchestrator';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
// Story 1.7.1 — PAT rotation + SSM read
import { rotatePat, readRotatedAt, InvalidPatError } from '../shared/github/rotate-pat';
import { z } from 'zod';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { format } from 'date-fns';
// Story 1.2.4 — GitHub connector + schema
import {
  checkConnection,
  listRepos,
  getRepo,
  getRepoTree,
  getFileContent,
  createRepoFromTemplate,
  deleteRepo,
  listCommits,
  listBranches,
  listPullRequests,
  GitHubError,
} from '../shared/github/connector';
import type { GitHubCommit } from '../shared/github/connector';
import {
  BOILERPLATE_REGISTRY,
  normalizeBoilerplateType,
  type BoilerplateType,
} from '../shared/boilerplates/registry';
import { githubCreateRepoSchema } from '../shared/schemas/github-create-repo-schema';
// Story 1.4.2 — App-create saga schema (extends legacy createAppInputSchema
// with `boilerplateType` + `bmadEnabled`).
import { appCreateInputSchema } from '../shared/schemas/app-create-schema';
// Story 1.8.3 — Timer Intelligence API routes
import { sliceForPlan } from '../shared/timer/slicer';
import { aggregateByCategory } from '../shared/timer/aggregator';
import { timingCohortQuerySchema } from '../shared/schemas/timing-cohort-query-schema';
import { buildForensicPayload } from '../shared/timer/forensic-builder';
import type { CohortBaseline } from '../shared/timer/forensic-builder';
import type { TimerCategory } from '../shared/timer/types';
// Story 1.8.6 — cohort read from cron-aggregated TimingSummary table
import { getCohortByKey } from '../shared/repositories/timing-summary-repository';
import { buildCohortKey } from '../shared/timer/cohort';
import { THRESHOLDS } from '../shared/timer/pipeline-timer-thresholds';

const EC2_INSTANCE_ID = process.env.EC2_INSTANCE_ID || 'i-0826d68c316ae97dd';
const ec2Client = new EC2Client({ region: 'us-east-1' });
const ssmClient = new SSMClient({ region: 'us-east-1' });
const cwClient = new CloudWatchClient({ region: 'us-east-1' });

type Env = {
  Variables: {
    user: { userId: string; email: string; name: string };
  };
};

const app = new Hono<Env>();

// CORS is handled by Lambda Function URL config in sst.config.ts
// Do NOT add Hono CORS middleware — it causes duplicate headers

// Health (public)
//
// PR-61 — also reports `buildHash` + `buildTime` so the SPA can compare
// its inlined NEXT_PUBLIC_BUILD_HASH against the live API build. The two
// are set from the same git short hash at deploy time (see sst.config.ts
// + next.config.ts). When they diverge, the Sidebar shows a warning and
// the operator knows their browser bundle is stale.
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    buildHash: process.env.BUILD_HASH ?? 'unknown',
    buildTime: process.env.BUILD_TIME ?? 'unknown',
  });
});

// Auth me — returns user from Bearer token
app.get('/api/auth/me', authMiddleware, (c) => {
  return c.json(c.get('user'));
});

// Auth exchange — frontend sends OTP code, Lambda exchanges with broker, returns tokens
// Public endpoint (no auth required — this IS the auth step)
app.post('/api/auth/exchange', async (c) => {
  const { code } = await c.req.json();
  if (!code) return c.json({ error: { code: 'MISSING_CODE', message: 'OTP code required' } }, 400);

  const brokerUrl = process.env.IDENTITY_BROKER_URL;
  const clientId = process.env.IDENTITY_BROKER_CLIENT_ID;
  const clientSecret = process.env.IDENTITY_BROKER_CLIENT_SECRET;

  if (!brokerUrl || !clientId || !clientSecret) {
    return c.json({ error: { code: 'CONFIG_ERROR', message: 'Broker not configured' } }, 500);
  }

  const response = await fetch(`${brokerUrl}/auth/oauth/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Id': 'futurator-admin',
      'X-Correlation-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({ code, clientId, clientSecret }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return c.json(
      { error: { code: 'EXCHANGE_FAILED', message: err.detail || 'Token exchange failed' } },
      401,
    );
  }

  const data = await response.json();
  // Return tokens to frontend — stored in memory, sent as Bearer header
  return c.json({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    familyId: data.familyId,
    tokenId: data.tokenId,
    expiresIn: data.expiresIn || 3600,
    user: data.user,
  });
});

// Auth refresh — frontend sends refresh token, gets new tokens
app.post('/api/auth/refresh', async (c) => {
  const { refreshToken, familyId, tokenId } = await c.req.json();
  if (!refreshToken)
    return c.json({ error: { code: 'MISSING_TOKEN', message: 'Refresh token required' } }, 400);

  const brokerUrl = process.env.IDENTITY_BROKER_URL;
  const response = await fetch(`${brokerUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': crypto.randomUUID() },
    body: JSON.stringify({ refreshToken, familyId, tokenId }),
  });

  if (!response.ok) {
    return c.json({ error: { code: 'REFRESH_FAILED', message: 'Session expired' } }, 401);
  }

  const data = await response.json();
  return c.json({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    familyId: data.familyId,
    tokenId: data.tokenId,
    expiresIn: data.expiresIn || 3600,
  });
});

// Auth logout
app.post('/api/auth/logout', (c) => {
  return c.json({ ok: true });
});

// Public endpoint - no auth required
app.get('/api/public/projects', async (c) => {
  const projects = await projectRepo.getAllProjects();

  const published = projects
    .filter((p) => p.publishedToHomepage)
    .sort((a, b) => a.homepageOrder - b.homepageOrder)
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
      order: p.homepageOrder,
    }));

  c.header('Cache-Control', 'public, max-age=300');
  return c.json(published);
});

// Protected routes
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  if (c.req.path === '/api/auth/exchange') return next();
  if (c.req.path === '/api/auth/refresh') return next();
  if (c.req.path === '/api/auth/logout') return next();
  if (c.req.path === '/api/public/projects') return next();
  if (c.req.path === '/api/github/status') return next();
  return authMiddleware(c, next);
});

// ── Projects ──
app.get('/api/projects', async (c) => {
  const projects = await projectRepo.getAllProjects();
  return c.json(projects);
});

app.get('/api/projects/:id', async (c) => {
  const project = await projectRepo.getProjectById(c.req.param('id'));
  if (!project) throw new NotFoundError('Project', c.req.param('id'));
  return c.json(project);
});

// Identity Broker — read-only view of an app's broker registration.
app.get('/api/identity-broker/apps/:appId', async (c) => {
  const result = await identityBrokerRepo.fetchAppConfig(c.req.param('appId'));
  if (!result.found) return c.json({ registered: false });
  return c.json({ registered: true, app: result.app });
});

// Drift report — compares broker state against our Secrets Manager entry.
app.get('/api/identity-broker/apps/:appId/drift', async (c) => {
  const report = await identityBrokerRepo.describeDrift(c.req.param('appId'));
  return c.json(report);
});

// Register an app. The plain clientSecret is written directly into AWS
// Secrets Manager at `futurator/{appId}/broker-credentials` and is never
// returned to the browser — the UI only sees the (sanitized) metadata.
app.post('/api/identity-broker/apps/:appId', async (c) => {
  const appId = c.req.param('appId');
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    type?: 'web' | 'mobile' | 'service';
    baseUrl?: string;
    redirectUris?: string[];
    allowedOrigins?: string[];
  };
  if (!body.name) {
    throw new ValidationError('name is required');
  }
  const result = await identityBrokerRepo.registerApp({
    appId,
    name: body.name,
    type: body.type,
    baseUrl: body.baseUrl,
    redirectUris: body.redirectUris,
    allowedOrigins: body.allowedOrigins,
  });
  return c.json(result);
});

// Rotate an app's client secret. Broker issues a new secret with a 1h
// overlap window (old secret still valid), we overwrite the Secrets
// Manager entry, browser only sees metadata (never the secret itself).
app.post('/api/identity-broker/apps/:appId/rotate', async (c) => {
  const appId = c.req.param('appId');
  const result = await identityBrokerRepo.rotateAppSecret(appId);
  return c.json(result);
});

app.put('/api/projects/:id', async (c) => {
  const body = await c.req.json();
  const parsed = projectUpdateSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  const project = await projectRepo.updateProject(
    c.req.param('id'),
    parsed.data as Partial<Project>,
  );

  // IMPORTANT: await the export — do NOT fire-and-forget in Lambda.
  //
  // A previous version used `exportPublicProjects().catch(...)` without
  // awaiting, on the assumption it would run "in the background". That is
  // unreliable in AWS Lambda: when the handler returns the HTTP response,
  // Lambda freezes/recycles the execution environment and any in-flight
  // unawaited promises may be killed before they complete. Result: some
  // saves exported correctly (lucky timing), others did not — the homepage
  // JSON silently stayed stale and the admin had no way to tell.
  //
  // The export is cheap (DynamoDB scan + one S3 PutObject + one CloudFront
  // invalidation, typically <1s) so adding it to the save latency is fine.
  // Errors are caught here so the save still returns 200 even if the
  // export pipeline has a transient AWS-side failure.
  if (project?.publishedToHomepage || body.publishedToHomepage !== undefined) {
    try {
      await exportPublicProjects();
    } catch (err) {
      console.error('[export] Background export failed:', err);
    }
  }

  return c.json(project);
});

// Story 13-3: Pre-signed URL for media upload to S3
// Returns an S3 PUT URL the client uses to upload directly, plus the
// public URL the homepage will fetch the media from.
app.post('/api/projects/:id/upload-url', async (c) => {
  const projectId = c.req.param('id');
  const body = await c.req.json();
  const { filename, contentType } = body as { filename?: string; contentType?: string };

  if (!filename || !contentType) {
    throw new ValidationError('filename and contentType are required');
  }
  const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];
  if (!ALLOWED.includes(contentType)) {
    throw new ValidationError(`contentType must be one of: ${ALLOWED.join(', ')}`);
  }

  const bucket = process.env.FUTURATOR_PUBLIC_BUCKET;
  if (!bucket) {
    throw new AppError('CONFIG_ERROR', 'FUTURATOR_PUBLIC_BUCKET not set', 500);
  }

  // Sanitize filename: keep extension, slug the rest, prefix with uuid
  const ext = (filename.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  const uuid = crypto.randomUUID();
  const key = `media/${projectId}/${uuid}${ext}`;

  const s3 = new S3Client({});
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const publicUrl = `https://futurator.ai/${key}`;

  return c.json({ uploadUrl, publicUrl, key });
});

app.put('/api/projects/:id/budget', async (c) => {
  const body = await c.req.json();
  const parsed = budgetSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  const project = await projectRepo.updateProject(c.req.param('id'), { budget: parsed.data });
  return c.json(project);
});

// ── Costs ──
app.get('/api/costs/overview', async (c) => {
  const costs = await costRepo.getLatestCostsByAllProjects(30);
  const projectTotals = new Map<string, number>();
  const serviceTotals = new Map<string, number>();

  for (const record of costs) {
    projectTotals.set(
      record.projectId,
      (projectTotals.get(record.projectId) || 0) + record.totalAmount,
    );
    for (const [service, amount] of Object.entries(record.breakdown || {})) {
      serviceTotals.set(service, (serviceTotals.get(service) || 0) + amount);
    }
  }

  const totalMonthly = Array.from(projectTotals.values()).reduce((a, b) => a + b, 0);
  const projects = Array.from(projectTotals.entries())
    .map(([projectId, amount]) => ({ projectId, amount, trend: 'flat' as const, changePercent: 0 }))
    .sort((a, b) => b.amount - a.amount);
  const topServices = Array.from(serviceTotals.entries())
    .map(([service, amount]) => ({ service, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  return c.json({
    totalMonthly,
    currency: 'USD',
    period: format(new Date(), 'yyyy-MM'),
    projects,
    topServices,
  });
});

app.get('/api/projects/:id/costs', async (c) => {
  const { range } = costRangeSchema.parse({ range: c.req.query('range') || '30d' });
  const days = parseInt(range);
  const records = await costRepo.getCostsByProject(c.req.param('id'), days);
  const latest = records[records.length - 1];

  return c.json({
    projectId: c.req.param('id'),
    period: { start: records[0]?.date, end: latest?.date },
    daily: records,
    forecast: latest?.forecast || null,
    anomalies: records.flatMap((r) => r.anomalies || []),
    budget: null,
  });
});

app.get('/api/costs/forecast', async (c) => {
  const costs = await costRepo.getLatestCostsByAllProjects(7);
  const latestByProject = new Map<string, { endOfMonth: number; confidence: string }>();
  for (const record of costs) {
    if (record.forecast) {
      latestByProject.set(record.projectId, record.forecast);
    }
  }
  return c.json(
    Array.from(latestByProject.entries()).map(([projectId, forecast]) => ({
      projectId,
      ...forecast,
    })),
  );
});

// Manual costs (MVP 2)
app.post('/api/costs/manual', async (c) => {
  const body = await c.req.json();
  const parsed = manualCostSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  const manualId = crypto.randomUUID();
  await costRepo.putManualCost({
    projectId: parsed.data.projectId,
    date: `manual-${manualId}`,
    provider: 'manual',
    totalAmount: parsed.data.amount,
    currency: 'USD',
    breakdown: { [parsed.data.service]: parsed.data.amount },
    manualId,
  });
  return c.json({ id: manualId }, 201);
});

// ── Reports ──
// EO-7.3: Epic-orchestrator metrics — aggregated from futurator-agent-events.
// Query params: from (ISO or epoch ms), to (ISO or epoch ms), project, useEpicOrchestrator.
app.get('/api/reports/epic-orchestrator-metrics', async (c) => {
  const parseBoundary = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 10_000_000_000) return asNum; // epoch ms
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const from = parseBoundary(c.req.query('from'));
  const to = parseBoundary(c.req.query('to'));
  const projectId = c.req.query('project') || undefined;
  const useEpicOrchestrator = c.req.query('useEpicOrchestrator');

  let events = await agentEventsRepo.scanAllEvents();

  // When `useEpicOrchestrator=true`, restrict to events that belong to an
  // epic-dev job. When `false`, restrict to events that do not. This gives
  // operators a direct before/after comparison from the same table.
  if (useEpicOrchestrator === 'true' || useEpicOrchestrator === 'false') {
    const jobIds = new Set(events.map((e) => e.jobId));
    const phaseByJob = new Map<string, string | undefined>();
    await Promise.all(
      Array.from(jobIds).map(async (jobId) => {
        const job = await agentJobsRepo.getJobById(jobId);
        phaseByJob.set(jobId, job?.phase);
      }),
    );
    const wantOrchestrator = useEpicOrchestrator === 'true';
    events = events.filter((e) => {
      const isOrch = phaseByJob.get(e.jobId) === 'epic-dev';
      return wantOrchestrator ? isOrch : !isOrch;
    });
  }

  const metrics = aggregateOrchestratorMetrics(events, { from, to, projectId });
  return c.json({ filter: { from, to, projectId, useEpicOrchestrator }, metrics });
});

// ── Resources ──
app.get('/api/projects/:id/resources', async (c) => {
  const resources = await resourceRepo.getResourcesByProject(c.req.param('id'));
  const grouped = resources.reduce(
    (acc, r) => {
      (acc[r.serviceType] = acc[r.serviceType] || []).push(r);
      return acc;
    },
    {} as Record<string, typeof resources>,
  );
  return c.json({ projectId: c.req.param('id'), groups: grouped, total: resources.length });
});

app.get('/api/resources/summary', async (c) => {
  const resources = await resourceRepo.getAllResources();
  const byService: Record<string, number> = {};
  const byProject = new Map<string, { count: number; compliant: number }>();

  for (const r of resources) {
    byService[r.serviceType] = (byService[r.serviceType] || 0) + 1;
    const proj = byProject.get(r.projectId) || { count: 0, compliant: 0 };
    proj.count++;
    if (r.tagCompliant) proj.compliant++;
    byProject.set(r.projectId, proj);
  }

  const total = resources.length;
  const compliant = resources.filter((r) => r.tagCompliant).length;

  return c.json({
    totalResources: total,
    byServiceType: byService,
    overallCompliance: total > 0 ? Math.round((compliant / total) * 100) : 100,
    byProject: Array.from(byProject.entries()).map(([projectId, s]) => ({
      projectId,
      resourceCount: s.count,
      complianceScore: s.count > 0 ? Math.round((s.compliant / s.count) * 100) : 100,
    })),
  });
});

// ── Tags / Audits ──
app.get('/api/tags/compliance', async (c) => {
  const audits = await auditRepo.getLatestAudits();
  return c.json(audits);
});

// ── Schedules (MVP 2) ──
app.get('/api/schedules', async (c) => {
  const schedules = await scheduleRepo.getAllSchedules();
  return c.json(schedules);
});

app.post('/api/schedules', async (c) => {
  const body = await c.req.json();
  const parsed = scheduleCreateSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  const schedule = await scheduleRepo.createSchedule({
    ...parsed.data,
    scheduleId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  return c.json(schedule, 201);
});

app.put('/api/schedules/:id', async (c) => {
  const body = await c.req.json();
  const parsed = scheduleUpdateSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  const existing = await scheduleRepo.getScheduleById(c.req.param('id'));
  if (!existing) throw new NotFoundError('Schedule', c.req.param('id'));
  const schedule = await scheduleRepo.updateSchedule(c.req.param('id'), parsed.data);
  return c.json(schedule);
});

app.delete('/api/schedules/:id', async (c) => {
  const existing = await scheduleRepo.getScheduleById(c.req.param('id'));
  if (!existing) throw new NotFoundError('Schedule', c.req.param('id'));
  await scheduleRepo.deleteSchedule(c.req.param('id'));
  return c.json({ ok: true });
});

// ── Users (MVP 2) ──
app.get('/api/users', async (c) => {
  const projectId = c.req.query('projectId');
  const users = projectId
    ? await userRepo.getUsersByProject(projectId)
    : await userRepo.getAllUsers();
  return c.json(users);
});

app.get('/api/users/:id', async (c) => {
  const user = await userRepo.getUserById(c.req.param('id'));
  if (!user) throw new NotFoundError('User', c.req.param('id'));
  return c.json(user);
});

// ── Alerts (MVP 2) ──
app.get('/api/alerts', async (c) => {
  const projectId = c.req.query('projectId');
  const alerts = projectId
    ? await alertRepo.getAlertsByProject(projectId)
    : await alertRepo.getAllAlerts();
  return c.json(alerts);
});

// ── Providers (MVP 2) ──
app.get('/api/costs/providers', async (c) => {
  const costs = await costRepo.getLatestCostsByAllProjects(30);
  const byProvider = new Map<string, number>();
  for (const r of costs) {
    byProvider.set(r.provider, (byProvider.get(r.provider) || 0) + r.totalAmount);
  }
  return c.json(
    Array.from(byProvider.entries()).map(([provider, amount]) => ({ provider, amount })),
  );
});

// ── Agent Orchestrator (Labs) ──
app.post('/api/agent-jobs', async (c) => {
  const body = await c.req.json();
  const parsed = createAgentJobSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));

  const user = c.get('user');
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  const job = await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: parsed.data.workingDir,
    pipeline: parsed.data.pipeline,
  });

  return c.json({ jobId: job.jobId, status: job.status }, 201);
});

app.get('/api/agent-jobs/:id', async (c) => {
  const job = await agentJobsRepo.getJobById(c.req.param('id'));
  if (!job) throw new NotFoundError('AgentJob', c.req.param('id'));
  return c.json(job);
});

app.get('/api/agent-jobs/:id/events', async (c) => {
  const afterSeq = c.req.query('after') || '000000';
  const { events, lastSeq } = await agentEventsRepo.getEventsAfter(c.req.param('id'), afterSeq);
  return c.json({ events, lastSeq });
});

// Flat-log renderer: plain-text hierarchical trace of all events tied to an epic.
// Paste-friendly format for reasoning about orchestrator behavior during dev.
app.get('/api/epic-workflows/:epicId/flat-log', async (c) => {
  const epicId = c.req.param('epicId');
  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  const jobIdParam = c.req.query('jobId');
  const jobIds = new Set<string>();
  if (jobIdParam) {
    jobIds.add(jobIdParam);
  } else {
    for (const story of epic.stories || []) {
      if (story.jobId) jobIds.add(story.jobId);
    }
    for (const jobId of Object.values(epic.waveBuildJobs || {})) {
      if (jobId) jobIds.add(jobId);
    }
    if (epic.qaJobId) jobIds.add(epic.qaJobId);
    if (epic.poJobId) jobIds.add(epic.poJobId);
    if (epic.deployJobId) jobIds.add(epic.deployJobId);
  }

  const perJobLimit = 500;
  const collected: AgentEvent[] = [];
  for (const jobId of jobIds) {
    const { events } = await agentEventsRepo.getEventsAfter(jobId, '000000', perJobLimit);
    for (const e of events) {
      // Stamp epicId so the prefix renders correctly even if a producer forgot.
      collected.push({ ...e, epicId: e.epicId || epicId });
    }
  }
  collected.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.seq - b.seq;
  });

  const waveStr = c.req.query('wave');
  const limitStr = c.req.query('limit');
  const filtered = filterEvents(collected, {
    since: c.req.query('since') || undefined,
    role: c.req.query('role') || undefined,
    storyId: c.req.query('storyId') || undefined,
    wave: waveStr !== undefined ? Number(waveStr) : undefined,
    limit: limitStr !== undefined ? Number(limitStr) : undefined,
  });

  const body = renderFlatLog(filtered);
  c.header('Content-Type', 'text/plain; charset=utf-8');
  return c.body(body);
});

app.get('/api/daemon/status', async (c) => {
  const heartbeat = await agentJobsRepo.getJobById('DAEMON_HEARTBEAT');
  if (!heartbeat?.updatedAt) {
    return c.json({ alive: false, lastSeen: null });
  }
  const ageMs = Date.now() - new Date(heartbeat.updatedAt).getTime();
  return c.json({ alive: ageMs < 10_000, lastSeen: heartbeat.updatedAt, ageMs });
});

// ── Epic Workflows (Labs — Agentic Workflow) ──

// Use the shared extractor — kept as a local alias so existing callers
// (story-output watchers, etc.) don't all need re-importing at once.
const parseVisualTests = sharedParseVisualTests;

// ── Pipeline v2.0 PR-6 (A): build resume-from-session payload for retries ──
//
// Reads the prior job's runtime state (variables, sessions, stepResults) so
// the new retry job can skip already-`complete` steps and `--resume <prior
// session>` on the failed step. Returns undefined when no prior job exists
// or it has no useful state — callers pass undefined to launchStoryRerun
// for a fresh-start retry (legacy v1 behavior).
async function buildPriorJobStateFromStory(story: { jobId?: string }): Promise<
  | {
      variables?: Record<string, string>;
      sessions?: Record<string, string>;
      stepResults?: import('../shared/types/agent-orchestrator').StepResult[];
    }
  | undefined
> {
  if (!story.jobId) return undefined;
  let priorJob;
  try {
    priorJob = await agentJobsRepo.getJobById(story.jobId);
  } catch {
    return undefined;
  }
  if (!priorJob) return undefined;
  // Only carry forward if there's something worth carrying.
  const hasVars = priorJob.variables && Object.keys(priorJob.variables).length > 0;
  const hasSessions = priorJob.sessions && Object.keys(priorJob.sessions).length > 0;
  const hasResults = Array.isArray(priorJob.stepResults) && priorJob.stepResults.length > 0;
  if (!hasVars && !hasSessions && !hasResults) return undefined;
  return {
    variables: priorJob.variables,
    sessions: priorJob.sessions,
    stepResults: priorJob.stepResults,
  };
}

// ── Session capture helper: extract session metadata from completed story job ──
async function captureSessionToRegistry(
  appName: string,
  epic: { epicId: string; title: string; workingDir: string },
  story: EpicStory,
) {
  if (!story.jobId) return;
  const job = await agentJobsRepo.getJobById(story.jobId);
  if (!job || job.status !== 'COMPLETED') return;

  const projectId = appName;

  // Ensure project registry exists
  let project = await registryRepo.getProject(projectId);
  if (!project) {
    project = await registryRepo.createProject({
      projectId,
      name: epic.title,
      ec2Path: epic.workingDir,
      epics: [epic.epicId],
      currentStatus: 'active',
      sessions: {},
      fileManifest: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } else if (!project.epics.includes(epic.epicId)) {
    await registryRepo.addEpicToProject(projectId, epic.epicId);
  }

  // Extract session ID from the dev step
  const devSessionId = job.sessions?.['dev'] || '';
  const contextDigest = job.variables?.['WORK_SUMMARY'] || '';

  // Extract files from agent events (Write/Edit tool_use events)
  const { events } = await agentEventsRepo.getEventsAfter(story.jobId, '000000', 500);
  const filesCreated: string[] = [];
  const filesMutated: string[] = [];
  const fileManifestUpdates: Record<
    string,
    { createdByStory: string; lastMutatedByStory: string; lastSessionId: string }
  > = {};

  for (const evt of events) {
    if (evt.eventType !== 'tool_use') continue;
    const toolName = evt.toolName;
    if (toolName !== 'Write' && toolName !== 'Edit') continue;

    try {
      const input = JSON.parse(evt.toolInput || '{}');
      const filePath = input.file_path as string;
      if (!filePath) continue;

      if (toolName === 'Write') {
        if (!filesCreated.includes(filePath)) filesCreated.push(filePath);
      } else {
        if (!filesMutated.includes(filePath)) filesMutated.push(filePath);
      }

      fileManifestUpdates[filePath] = {
        createdByStory: filesCreated.includes(filePath)
          ? story.storyId
          : project.fileManifest[filePath]?.createdByStory || story.storyId,
        lastMutatedByStory: story.storyId,
        lastSessionId: devSessionId,
      };
    } catch {
      // Skip unparseable tool inputs
    }
  }

  // Store session metadata
  await registryRepo.upsertSession(projectId, story.storyId, {
    sessionId: devSessionId,
    filesCreated,
    filesMutated,
    contextDigest: contextDigest.slice(0, 2000),
    completedAt: new Date().toISOString(),
  });

  // Update file manifest
  if (Object.keys(fileManifestUpdates).length > 0) {
    await registryRepo.updateFileManifest(projectId, fileManifestUpdates);
  }

  console.log(
    `[Registry] Captured session for ${story.storyId}: ${filesCreated.length} created, ${filesMutated.length} mutated`,
  );
}

// ── PM Agent: Generate epic from product idea ──
app.post('/api/epic-workflows/generate', async (c) => {
  const { idea, workingDir } = (await c.req.json()) as { idea: string; workingDir: string };
  const user = c.get('user');

  if (!idea?.trim()) throw new ValidationError('Product idea is required');
  if (!workingDir?.trim()) throw new ValidationError('Working directory is required');

  const pmPipeline: PipelineDefinition = {
    maxIterations: 1,
    agents: {
      PM: {
        name: 'Product Manager',
        allowedTools: 'Read,Grep,Glob',
        model: 'sonnet',
      },
    },
    steps: [
      {
        id: 'generate_epic',
        agentId: 'PM',
        prompt: `You are a senior Product Manager. A user has described a product intent. Your job is to create a structured epic with stories, dependencies, acceptance criteria, AND per-story touch-point inference so the orchestrator can run immediately.

## Product Intent:
${idea}

## Tech Stack:
React + TypeScript + Vite (frontend web app)

## Instructions:
1. Break the intent into 5-10 small, implementable stories
2. The FIRST story must always scaffold the project (npm create vite, folder structure, types)
3. Each subsequent story should create ONE component or module
4. The LAST story should assemble everything in App.tsx
5. Maximize parallelism — stories that don't depend on each other should be in the same wave
6. Each story must have clear, testable acceptance criteria
7. Think about dependencies carefully — a component can only be used if it's been built
8. For each acceptance criterion, classify whether verifying it requires a running browser:
   - needs_browser="true": visual appearance, layout, animations, interactions, responsive behavior, canvas rendering, CSS styling
   - needs_browser="false": code structure, file existence, types, build success, API logic, package installation, data transformations
9. Add a <testing_profile> based on the overall app:
   - has_browser_tests: true if ANY criterion has needs_browser="true"
   - viewport: recommended size (e.g., "800x600" for games, "1280x720" for dashboards, "375x667" for mobile-first)
   - interaction_model: primary input ("keyboard", "mouse", "touch", or combos like "keyboard,mouse")
10. For EACH story, emit inference fields so the orchestrator can dispatch subagents without a separate pass:
    - <touch_points>: comma-separated glob patterns of the files the story will create/modify (e.g. "src/components/Board.tsx,src/types/game.ts"). For scaffolding use "package.json,vite.config.ts,src/**". Be specific; avoid "**".
    - <complexity>: one of trivial | standard | complex | architectural
      * trivial: single small file, pure presentation, <50 LOC
      * standard: 1-3 files, typical component or module
      * complex: multi-file feature, non-trivial logic, state coordination
      * architectural: cross-cutting, touches scaffolding or shared types
    - <review_rigor>: one of light | standard | strict
      * light: trivial UI, no business logic
      * standard: typical component
      * strict: shared types, core logic, scaffolding, or anything other stories depend on

Output your epic in this EXACT XML format (no markdown, no explanation, ONLY the XML):

<epic>
  <title>Epic Title Here</title>
  <description>2-3 sentence description of what we're building</description>
  <testing_profile>
    <has_browser_tests>true</has_browser_tests>
    <viewport>800x600</viewport>
    <interaction_model>keyboard</interaction_model>
  </testing_profile>
  <acceptance_criteria>
    <criterion needs_browser="false">Overall criterion 1</criterion>
    <criterion needs_browser="true">Overall criterion 2</criterion>
  </acceptance_criteria>
  <stories>
    <story id="S1">
      <title>Story 1 — Scaffold & Core Types</title>
      <depends_on></depends_on>
      <touch_points>package.json,vite.config.ts,tsconfig.json,src/main.tsx,src/types/game.ts</touch_points>
      <complexity>architectural</complexity>
      <review_rigor>strict</review_rigor>
      <description>
        As a developer, I want the project scaffolded...

        Acceptance Criteria:
        - [needs_browser=false] Project builds with tsc
        - [needs_browser=false] Folder structure matches spec
      </description>
    </story>
    <story id="S2">
      <title>Story 2 — Some Component</title>
      <depends_on>S1</depends_on>
      <touch_points>src/components/SomeComponent.tsx,src/components/SomeComponent.css</touch_points>
      <complexity>standard</complexity>
      <review_rigor>standard</review_rigor>
      <description>
        As a user, I want...

        Acceptance Criteria:
        - [needs_browser=false] Component file exists
        - [needs_browser=true] Component renders at correct size
      </description>
    </story>
  </stories>
</epic>

IMPORTANT RULES:
- depends_on uses comma-separated story IDs (S1,S2,S3) or empty for no deps
- Story IDs are S1, S2, S3... (sequential)
- The first story (S1) always has NO dependencies and is typically architectural/strict
- The last story assembles everything and depends on all component stories
- Maximize stories that can run in parallel (same wave = same depends_on set)
- Each story should modify 1-3 files maximum (except scaffolding)
- Every acceptance criterion MUST include the [needs_browser=true/false] prefix
- EVERY story MUST have <touch_points>, <complexity>, and <review_rigor> — no exceptions
- Touch-points must not overlap between stories in the same wave (otherwise they must depend on each other)
- Output ONLY the XML, nothing else`,
        extractors: {
          EPIC_XML: { type: 'between', startDelimiter: '<epic>', endDelimiter: '</epic>' },
        },
        validations: [],
      },
    ],
  };

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: workingDir || process.env.HOME || '/tmp',
    pipeline: pmPipeline,
  });

  return c.json({ jobId }, 201);
});

// ── Create epic from parsed XML (called after PM generates) ──
app.post('/api/epic-workflows/from-xml', async (c) => {
  const body = await c.req.json();
  const user = c.get('user');
  const xml = body.xml as string;
  const workingDir = body.workingDir as string;

  if (!xml?.trim()) throw new ValidationError('XML is required');

  // Parse the XML manually (simple regex-based — no external XML parser needed)
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  const descMatch = xml.match(/<description>([\s\S]*?)<\/description>/);
  const criteriaMatches = [
    ...xml.matchAll(/<criterion(?:\s+needs_browser="(true|false)")?>([\s\S]*?)<\/criterion>/g),
  ];
  const storyMatches = [...xml.matchAll(/<story\s+id="(S\d+)">([\s\S]*?)<\/story>/g)];

  // Parse testing_profile
  const tpBlock = xml.match(/<testing_profile>([\s\S]*?)<\/testing_profile>/)?.[1] || '';
  const tpHasBrowser = /<has_browser_tests>\s*(true)\s*<\/has_browser_tests>/.test(tpBlock);
  const tpViewport = tpBlock.match(/<viewport>([\s\S]*?)<\/viewport>/)?.[1]?.trim();
  const tpInteraction = tpBlock
    .match(/<interaction_model>([\s\S]*?)<\/interaction_model>/)?.[1]
    ?.trim();

  const testingProfile = {
    hasBrowserTests: tpHasBrowser,
    ...(tpViewport && { viewport: tpViewport }),
    ...(tpInteraction && { interactionModel: tpInteraction }),
  };

  const epicTitle = titleMatch?.[1]?.trim() || 'Untitled Epic';
  const epicDesc = descMatch?.[1]?.trim() || '';
  const epicAC = criteriaMatches.map((m) => m[2].trim()).join('\n');

  const COMPLEXITY_VALUES = new Set(['trivial', 'standard', 'complex', 'architectural']);
  const REVIEW_RIGOR_VALUES = new Set(['light', 'standard', 'strict']);

  const rawStories = storyMatches.map((m) => {
    const storyId = m[1];
    const content = m[2];
    const storyTitle = content.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || storyId;
    const deps = content.match(/<depends_on>([\s\S]*?)<\/depends_on>/)?.[1]?.trim() || '';
    const desc = content.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || '';
    const depIds = deps
      ? deps
          .split(',')
          .map((d: string) => d.trim())
          .filter(Boolean)
          .map((d: string) => {
            const num = parseInt(d.replace('S', ''), 10);
            return `story-${num - 1}`; // S1 → story-0, S2 → story-1
          })
      : [];

    // Extract structured criteria from description's "- [needs_browser=...] ..." lines
    const criteriaLines = [...desc.matchAll(/- \[needs_browser=(true|false)\]\s*(.+)/g)];
    const criteria = criteriaLines.map((cl, idx) => ({
      id: `AC-${storyId}-${idx + 1}`,
      text: cl[2].trim(),
      needsBrowser: cl[1] === 'true',
    }));
    const hasBrowserTests = criteria.some((c) => c.needsBrowser);

    // Extract inference fields emitted by the PM so the orchestrator can start without a prep pass.
    const tpRaw = content.match(/<touch_points>([\s\S]*?)<\/touch_points>/)?.[1]?.trim() || '';
    const touchPoints = tpRaw
      ? tpRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const complexityRaw =
      content
        .match(/<complexity>([\s\S]*?)<\/complexity>/)?.[1]
        ?.trim()
        .toLowerCase() || '';
    const rigorRaw =
      content
        .match(/<review_rigor>([\s\S]*?)<\/review_rigor>/)?.[1]
        ?.trim()
        .toLowerCase() || '';
    const complexity = COMPLEXITY_VALUES.has(complexityRaw)
      ? (complexityRaw as 'trivial' | 'standard' | 'complex' | 'architectural')
      : undefined;
    const reviewRigor = REVIEW_RIGOR_VALUES.has(rigorRaw)
      ? (rigorRaw as 'light' | 'standard' | 'strict')
      : undefined;

    return {
      storyId,
      title: storyTitle,
      description: desc,
      dependsOn: depIds,
      criteria,
      hasBrowserTests,
      touchPoints,
      complexity,
      reviewRigor,
    };
  });

  // Build stories with proper IDs and compute waves
  const stories = rawStories.map((s, i) => ({
    storyId: `story-${i}`,
    order: i,
    title: s.title,
    description: s.description,
    status: 'pending' as const,
    dependsOn: s.dependsOn,
    ...(s.criteria.length > 0 && { criteria: s.criteria, hasBrowserTests: s.hasBrowserTests }),
    ...(s.touchPoints.length > 0 && { touchPoints: s.touchPoints }),
    ...(s.complexity && { complexity: s.complexity }),
    ...(s.reviewRigor && { reviewRigor: s.reviewRigor }),
  }));

  // Compute waves
  const storyById = new Map(stories.map((s) => [s.storyId, s]));
  const waveCache = new Map<string, number>();
  function computeWave(id: string, visited = new Set<string>()): number {
    if (waveCache.has(id)) return waveCache.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);
    const story = storyById.get(id);
    if (!story || !story.dependsOn || story.dependsOn.length === 0) {
      waveCache.set(id, 0);
      return 0;
    }
    const depWaves = story.dependsOn.map((d) => computeWave(d, visited));
    const wave = Math.max(...depWaves) + 1;
    waveCache.set(id, wave);
    return wave;
  }
  const storiesWithWaves = stories.map((s) => ({ ...s, wave: computeWave(s.storyId) }));

  // If the PM emitted inference for every story the epic is immediately runnable
  // by the orchestrator; otherwise it stays in draft and a later prep pass is required.
  const allInferred =
    storiesWithWaves.length > 0 &&
    storiesWithWaves.every(
      (s) => (s.touchPoints?.length ?? 0) > 0 && s.complexity && s.reviewRigor,
    );

  const epicId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Story 16.1: honor the caller's execution-mode choice. `useEpicOrchestrator`
  // arrives as a boolean on the request body (from the UI toggle). If omitted,
  // epic-workflow-repository.ts:createEpic still defaults to true.
  const epic = await epicRepo.createEpic({
    epicId,
    title: epicTitle,
    description: epicDesc,
    acceptanceCriteria: epicAC,
    workingDir: workingDir || '',
    status: allInferred ? 'ready' : 'draft',
    stories: storiesWithWaves,
    testingProfile,
    yoloMode: body.yoloMode !== false,
    devModel: body.devModel,
    devEffort: body.devEffort,
    reviewerModel: body.reviewerModel,
    reviewerEffort: body.reviewerEffort,
    ...(typeof body.useEpicOrchestrator === 'boolean' && {
      useEpicOrchestrator: body.useEpicOrchestrator,
    }),
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
  });

  // Single-click flow: if caller opted in and every story is inferred, spawn
  // the execution jobs in the same round-trip so the UI can skip the
  // separate "Start Epic" click.
  //
  // Two launch paths, selected by epic.useEpicOrchestrator:
  //   - true  (default, orchestrator mode): single `phase='epic-dev'` job
  //   - false (pipeline mode — Story 16.1): one step-based job per wave-1 story
  let orchestratorJobId: string | undefined;
  let pipelineStoryJobIds: string[] | undefined;
  let pipelineWaveNumber: number | undefined;
  if (body.autoStart === true && allInferred) {
    if (epic.useEpicOrchestrator === false) {
      // If stories exist, launch the first wave; otherwise skip silently — the
      // manual /start button will surface the 400 if the operator clicks
      // without fixing the epic.
      if (epic.stories && epic.stories.length > 0) {
        const firstWave = findFirstWave(epic);
        const launch = await launchPipelineWave(epic, firstWave, user.userId, now, {
          generatePipeline: generateStoryPipeline,
          createJob: agentJobsRepo.createJob,
          uuid: () => crypto.randomUUID(),
        });
        if (launch.ok) {
          await epicRepo.updateEpicFields(epic.epicId, {
            status: 'in_progress',
            stories: launch.updatedStories,
          });
          pipelineStoryJobIds = launch.jobIds;
          pipelineWaveNumber = launch.waveNumber;
        }
      }
    } else {
      const validation = validateEpicForOrchestratorStart(epic);
      if (validation.ok) {
        const jobId = crypto.randomUUID();
        const projectId = epic.workingDir.split('/').filter(Boolean).pop() || epic.epicId;
        await agentJobsRepo.createJob({
          jobId,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
          createdBy: user.userId,
          workingDir: epic.workingDir,
          pipeline: { agents: {}, steps: [] },
          phase: 'epic-dev',
          epicId: epic.epicId,
          projectId,
          epicDevPayload: validation.payload,
        });
        await epicRepo.updateEpicFields(epic.epicId, {
          status: 'in_progress',
          orchestratorJobId: jobId,
        });
        orchestratorJobId = jobId;
      }
    }
  }

  return c.json(
    {
      epicId: epic.epicId,
      storiesCount: storiesWithWaves.length,
      ...(orchestratorJobId && { orchestratorJobId }),
      ...(pipelineStoryJobIds && {
        storyJobIds: pipelineStoryJobIds,
        waveNumber: pipelineWaveNumber,
      }),
    },
    201,
  );
});

// ── Plans (Epic 17) ──
// Plan is the top-level Labs unit — an atomic product intent owning 1..N
// epics, a canonical name (= folder slug = deploy slug), and a persistent
// plan.md on disk. See docs/epics-plan-based-labs.md.

app.get('/api/plans', async (c) => {
  const plans = await planRepo.getAllPlans();
  const summaries = plans
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(planRepo.toPlanSummary);
  return c.json(summaries);
});

app.get('/api/plans/:id', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  // Hydrate epics array for the detail view. Also sync-on-read: the
  // per-story live status sits on the epic row, but the daemon updates
  // job.status (not story.status) when it picks up / completes a job.
  // Without this sync the UI would show `queued` indefinitely after a
  // Retry until the wave-completion cron next ticks (up to 60s later).
  // Mirrors the sync logic on GET /api/epic-workflows/:id but trimmed:
  // no session capture, no epic-status recomputation — those are handled
  // by the wave-reducer cron.
  const epics: EpicWorkflow[] = [];
  for (const epicId of plan.epicIds) {
    const epic = await epicRepo.getEpicById(epicId);
    if (!epic) continue;
    let changed = false;
    const syncedStories = await Promise.all(
      epic.stories.map(async (story) => {
        const syncable = (story.status === 'queued' || story.status === 'running') && story.jobId;
        if (!syncable) return story;
        const job = await agentJobsRepo.getJobById(story.jobId!);
        if (!job) return story;
        if (job.status === 'COMPLETED') {
          changed = true;
          return { ...story, status: 'done' as const };
        }
        if (job.status === 'FAILED') {
          changed = true;
          return { ...story, status: 'failed' as const };
        }
        // Promote queued → running when daemon has picked up the job.
        if (story.status === 'queued' && job.status === 'RUNNING') {
          changed = true;
          return { ...story, status: 'running' as const };
        }
        // Demote running → queued if daemon restarted the job back to PENDING
        // (e.g. daemon-shutdown-timeout re-queue). The Phase A.3 retry ladder
        // also does this via retryAfter.
        if (story.status === 'running' && job.status === 'PENDING') {
          changed = true;
          return { ...story, status: 'queued' as const };
        }
        return story;
      }),
    );
    if (changed) {
      await epicRepo.updateEpicFields(epic.epicId, { stories: syncedStories });
      epics.push({ ...epic, stories: syncedStories });
    } else {
      epics.push(epic);
    }
  }
  return c.json({ ...plan, epics });
});

app.post('/api/plans', async (c) => {
  const body = await c.req.json();
  const user = c.get('user');
  const parsed = planCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const input = parsed.data;

  const planId = crypto.randomUUID();
  const now = new Date().toISOString();
  const plan: Plan = {
    planId,
    name: input.name,
    displayName: input.displayName,
    intent: input.intent,
    description: '',
    status: 'concept',
    epicIds: [],
    workingDir: `/home/ubuntu/projects/${input.name}`,
    devModel: input.devModel,
    devEffort: input.devEffort,
    reviewerModel: input.reviewerModel,
    reviewerEffort: input.reviewerEffort,
    testModel: input.testModel || 'sonnet',
    yoloMode: input.yoloMode,
    executionMode: input.executionMode || 'pipeline',
    rigor: input.rigor || 'mvp',
    testingProfile: input.testingProfile,
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    // PR-45 — rigor-keyed default cost ceiling (USD).
    costCeilingUsd: defaultCostCeiling(input.rigor || 'mvp'),
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
  };

  await planRepo.createPlan(plan);

  // Bootstrap the EC2 folder + plan.md. If SSM fails, flip the plan to
  // archived with an error note — never leave an orphan DDB row pointing at
  // a non-existent folder.
  try {
    await bootstrapPlanFolder(plan, [], { sendSsmCommand, waitForSsmOutput });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Plans] Bootstrap failed for ${plan.planId} (${plan.name}): ${message}`);
    await planRepo.updatePlanFields(plan.planId, {
      status: 'archived',
      description: `Bootstrap failed: ${message}`,
    });
    const archived = await planRepo.getPlanById(plan.planId);
    return c.json({ plan: archived, warning: 'bootstrap-failed' }, 201);
  }

  return c.json({ plan }, 201);
});

// POST /api/plans/from-intent — one-shot create plan + kick off PM-plan job.
//
// The client polls the returned pmJobId. When the job reaches COMPLETED,
// the client calls POST /api/plans/:id/apply-plan?jobId=<pmJobId> to
// persist the PM's output. Two separate calls (rather than a single
// fire-and-forget) keeps parse errors surfaceable to the operator.
app.post('/api/plans/from-intent', async (c) => {
  const body = await c.req.json();
  const user = c.get('user');
  const parsed = planCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const input = parsed.data;

  const planId = crypto.randomUUID();
  const now = new Date().toISOString();
  const plan: Plan = {
    planId,
    name: input.name,
    displayName: input.displayName,
    intent: input.intent,
    description: '',
    status: 'concept',
    epicIds: [],
    workingDir: `/home/ubuntu/projects/${input.name}`,
    devModel: input.devModel,
    devEffort: input.devEffort,
    reviewerModel: input.reviewerModel,
    reviewerEffort: input.reviewerEffort,
    testModel: input.testModel || 'sonnet',
    yoloMode: input.yoloMode,
    executionMode: input.executionMode || 'pipeline',
    rigor: input.rigor || 'mvp',
    testingProfile: input.testingProfile,
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    // PR-45 — rigor-keyed default cost ceiling (USD).
    costCeilingUsd: defaultCostCeiling(input.rigor || 'mvp'),
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
  };

  // Persist the requested BMAD toggle (default ON when the caller omits it).
  plan.bmadEnabled = input.bmadEnabled !== false;

  await planRepo.createPlan(plan);

  // Bootstrap folder + initial plan.md with just the intent (epics empty).
  try {
    await bootstrapPlanFolder(plan, [], { sendSsmCommand, waitForSsmOutput });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Plans] Bootstrap failed for ${planId}: ${message}`);
    await planRepo.updatePlanFields(planId, {
      status: 'archived',
      description: `Bootstrap failed: ${message}`,
    });
    return c.json({ error: { code: 'BOOTSTRAP_FAILED', message } }, 500);
  }

  // Kick off the PM-plan job.
  // IMPORTANT: pass the slug (plan.name), NOT displayName, to the PM. The
  // PM's output JSON includes `plan.name`, which apply-plan validates
  // against the kebab-case regex — displayName would fail validation.
  const pmJobId = crypto.randomUUID();
  // PR-5: legacy /from-intent path doesn't have an App; default to nextjs
  // (the only `wired` boilerplate in Phase 1). Future: deprecate this path
  // entirely once App/Plan v1 is the only Plan-creation entrypoint.
  const pipeline = generatePmPlanPipeline({
    planName: plan.name,
    intent: plan.intent,
    executionMode: plan.executionMode,
    devModel: plan.devModel,
    // PR-13 — `nextjs` was renamed to `nextjs-base` (the registry key).
    boilerplateType: 'nextjs-base',
    rigor: plan.rigor,
    kind: plan.kind, // PR-23d — drives the brownfield clause for change plans.
  });
  await agentJobsRepo.createJob({
    jobId: pmJobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: plan.workingDir,
    pipeline,
  });

  // Party Mode (BMAD) — enqueue in parallel with the PM job when enabled.
  // The party-bootstrap pipeline is idempotent and runs on the same EC2
  // folder; creating the party-projects DDB row here lets the UI surface
  // install progress immediately on the Party Mode stage of the dashboard.
  let bmadJobId: string | undefined;
  if (plan.bmadEnabled) {
    bmadJobId = await enqueuePartyBootstrapForPlan(plan, user.userId);
  }

  return c.json({ planId, pmJobId, bmadJobId, plan }, 201);
});

/**
 * Upsert a PartyProject row and enqueue a `party-bootstrap` job for a Plan.
 * Shared between plan-create and the retroactive install endpoint.
 *
 * Returns the bootstrap jobId, or undefined when another bootstrap is
 * already in flight (caller treats that as "install in progress").
 */
async function enqueuePartyBootstrapForPlan(
  plan: Plan,
  userId: string,
): Promise<string | undefined> {
  try {
    await partyProjectsRepo.upsertProjectFromFilesystem(plan.name, plan.workingDir);
  } catch (err) {
    console.warn(
      `[Plans] upsertProjectFromFilesystem failed for plan=${plan.planId} name=${plan.name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const jobId = crypto.randomUUID();
  const lock = await partyProjectsRepo.tryAcquireBootstrapLock(plan.name, jobId);
  if (!lock.ok) {
    if (lock.reason === 'BOOTSTRAP_IN_PROGRESS') return undefined;
    console.warn(`[Plans] bootstrap lock failed (${lock.reason}) for ${plan.name}`);
    return undefined;
  }

  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: plan.workingDir,
    jobType: 'party-bootstrap',
    partyBootstrapPayload: {
      projectId: plan.name,
      projectPath: plan.workingDir,
      forceReinstall: false,
      createFolder: true,
    },
  });
  return jobId;
}

/**
 * Retroactively enable Party Mode (BMAD) on a plan that was created without it.
 * Flips `plan.bmadEnabled = true` and enqueues a bootstrap job. Idempotent —
 * running against an already-HEALTHY project is a no-op on disk (the daemon's
 * install step detects the existing install and skips).
 */
app.post('/api/plans/:id/bmad/install', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  if (!plan.bmadEnabled) {
    await planRepo.updatePlanFields(planId, { bmadEnabled: true });
    plan.bmadEnabled = true;
  }

  const jobId = await enqueuePartyBootstrapForPlan(plan, c.get('user').userId);
  return c.json({ planId, bmadJobId: jobId, inProgress: !jobId }, 202);
});

// POST /api/plans/:id/apply-plan?jobId=X — parse PM job output + create epics.
// If `jobId` is omitted, finds the most recent COMPLETED pm-plan job for this
// plan's workingDir and applies it. This is the recovery path when the UI
// loses track of the pmJobId (e.g., tab closed mid-generation).
app.post('/api/plans/:id/apply-plan', async (c) => {
  const planId = c.req.param('id');
  let jobId = c.req.query('jobId');

  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  if (!jobId) {
    // Auto-discover: scan jobs for the most recent COMPLETED pm-plan job
    // whose workingDir matches this plan's.
    const allJobs = await agentJobsRepo.scanAllJobs();
    const candidates = allJobs
      .filter(
        (j) =>
          j.workingDir === plan.workingDir && j.status === 'COMPLETED' && j.variables?.PLAN_JSON,
      )
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (candidates.length === 0) {
      throw new ValidationError('No completed pm-plan job found for this plan.');
    }
    jobId = candidates[0].jobId;
  }

  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) throw new NotFoundError('Job', jobId);
  if (job.status !== 'COMPLETED') {
    throw new ValidationError(`Job ${jobId} is ${job.status}, not COMPLETED`);
  }

  let output;
  try {
    output = parsePlanOutput(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: { code: 'PARSE_FAILED', message } }, 400);
  }

  const result = await applyPlanOutput(plan, output, {
    createEpic: epicRepo.createEpic,
    updatePlanFields: planRepo.updatePlanFields,
    uuid: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  });

  // Sync plan.md with the new epic tree (best-effort).
  try {
    await writePlanMarkdown(result.plan, result.epics, { sendSsmCommand, waitForSsmOutput });
  } catch (err) {
    console.warn(
      `[Plans] plan.md sync after apply failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Epic 5 wire-in (2026-05-20) — PM seedWhatThisIs. Replaces the
  // empty `## What this is` section in CLAUDE.md with the project
  // intent (first ~3 sentences). Idempotent: the writer no-ops when
  // the section is already populated, so re-applying a plan over an
  // existing CLAUDE.md is safe.
  //
  // Best-effort via SSM. A failure here doesn't roll back the plan
  // apply — the operator still has a fully-decomposed plan; only the
  // CLAUDE.md narrative gets seeded next time PM runs.
  try {
    const workingDir = result.plan.workingDir;
    if (workingDir && result.plan.intent) {
      // Trim to first ~3 sentences for the seed (mirrors v2.5 §41.1
      // "one paragraph" guidance). Shell-escape via JSON.stringify so
      // newlines/quotes/etc. survive the SSM round-trip safely.
      const purpose = String(result.plan.intent).split('\n').slice(0, 3).join(' ').trim();
      const purposeJson = JSON.stringify(purpose);
      const seedCmd =
        `cd ${workingDir} && ` +
        `node -e "import('/opt/futurator-daemon/lib/claude-md-writer.mjs').then(m => ` +
        `m.seedWhatThisIs({ workingDir: '.', purpose: ${purposeJson} }).then(r => ` +
        `console.log('seed-what-this-is:', JSON.stringify(r))))" 2>&1 || true`;
      await sendSsmCommand(seedCmd);
    }
  } catch (err) {
    console.warn(
      `[Plans] CLAUDE.md seedWhatThisIs failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  return c.json({ plan: result.plan, epics: result.epics });
});

// POST /api/plans/:id/regenerate — start a fresh PM-plan job on the same intent.
//
// PR-24 (2026-05-04) — regenerate is now atomic: existing epic tree is
// DROPPED before the new PM job spawns. Reasoning: the v1 "append" behaviour
// + the frontend's auto-apply skip-when-epics-exist guard combined to make
// regenerate silently no-op when a plan already had epics (the new PM
// output sat in DDB unused). Operators expect "regenerate" to mean "wipe
// and rebuild" — that's now what it does. To preserve a prior plan
// version, snapshot it BEFORE clicking regenerate (forensic export +
// the immutable AgentJob row both retain the prior PLAN_JSON).
app.post('/api/plans/:id/regenerate', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');

  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  if (plan.status !== 'concept') {
    throw new ValidationError(`Cannot regenerate a plan in status "${plan.status}" — only concept`);
  }

  // PR-24 — drop existing epics + reset plan rollups so the auto-apply
  // hook on the frontend (plan-dashboard/index.tsx) treats this as a
  // first-time apply. Errors during epic deletion are logged but never
  // block the regenerate; orphan epic rows are harmless (DDB TTL eventually
  // sweeps them via the App-delete cascade) but inconsistent state is
  // worse than a few stragglers.
  if (plan.epicIds && plan.epicIds.length > 0) {
    for (const epicId of plan.epicIds) {
      try {
        await epicRepo.deleteEpic(epicId);
      } catch (err) {
        console.warn(
          `[regenerate] failed to delete epic ${epicId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    await planRepo.updatePlanFields(planId, {
      epicIds: [],
      totalStories: 0,
      doneStories: 0,
    });
  }

  const pmJobId = crypto.randomUUID();
  const now = new Date().toISOString();
  // PR-5: look up boilerplateType from the App (if Plan is App-scoped) so the
  // regenerated PM prompt uses the right framework conventions. Falls back to
  // 'nextjs-base' for legacy plans not tied to an App. PR-13 normalizes
  // legacy 'nextjs' values to 'nextjs-base' via normalizeBoilerplateType.
  let regenBoilerplateType: BoilerplateType = 'nextjs-base';
  if (plan.appId) {
    try {
      const appRow = await appRepo.getApp(plan.appId);
      if (appRow?.boilerplateType) {
        regenBoilerplateType = normalizeBoilerplateType(appRow.boilerplateType);
      }
    } catch {
      // best-effort — fall through to default
    }
  }
  const pipeline = generatePmPlanPipeline({
    planName: plan.name,
    intent: plan.intent,
    executionMode: plan.executionMode,
    devModel: plan.devModel,
    boilerplateType: regenBoilerplateType,
    rigor: plan.rigor,
    kind: plan.kind, // PR-23d
  });
  await agentJobsRepo.createJob({
    jobId: pmJobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: plan.workingDir,
    pipeline,
  });

  return c.json({ planId, pmJobId }, 202);
});

// POST /api/plans/:id/start — kick the plan from concept into developing.
// Launches plan-wave 0: every epic with no deps starts its story-wave 0 now.
// Subsequent plan-waves get launched by the wave-completion cron as each
// wave's epics all complete + pass their per-wave build-checks.
app.post('/api/plans/:id/start', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');

  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  if (plan.status !== 'concept') {
    throw new ValidationError(
      `Plan must be in "concept" status to start; current status: ${plan.status}`,
    );
  }

  // Epic 3 Story 3.4 (2026-05-20) — T2 SKILL-SCOUT wait gate. If the
  // plan has an outstanding SKILL-SCOUT job + an open decision card,
  // refuse to start so the operator decides on skills BEFORE PM
  // decomposition. Auto-confirm dispositions clear the FK + don't
  // surface a card, so most plans pass this gate transparently. A
  // 5-minute timeout escape valve below keeps stuck SKILL-SCOUT jobs
  // from deadlocking the plan.
  if (plan.pendingSkillScoutJobId) {
    const scoutJob = await agentJobsRepo.getJobById(plan.pendingSkillScoutJobId).catch(() => null);
    if (scoutJob) {
      const TERMINAL = new Set(['COMPLETED', 'FAILED', 'STALE', 'COMPLETED_VIA_SALVAGE']);
      const isTerminal = TERMINAL.has(scoutJob.status);
      const ageMs = Date.now() - new Date(scoutJob.createdAt).getTime();
      const timedOut = ageMs > 5 * 60 * 1000;
      if (!isTerminal && !timedOut) {
        throw new AppError(
          'SKILL_SCOUT_PENDING',
          `SKILL-SCOUT is still running for this plan (job ${plan.pendingSkillScoutJobId.slice(0, 8)}, age ${Math.round(ageMs / 1000)}s). Wait for it to finish then retry.`,
          409,
        );
      }
      if (isTerminal) {
        // Check for an open `manifest-change-proposed` card on this plan.
        const cards = await attentionRepo
          .listAttentionItems(planId)
          .catch(() => [] as Array<import('../shared/types/attention').AttentionItem>);
        const openCard = cards.find(
          (card) => card.category === 'manifest-change-proposed' && card.status === 'open',
        );
        if (openCard) {
          throw new AppError(
            'SKILL_SCOUT_CARD_OPEN',
            `SKILL-SCOUT surfaced a manifest-change-proposed decision card (${openCard.itemId.slice(0, 8)}). Resolve it (confirm/edit/decline/defer) before starting the plan.`,
            409,
          );
        }
      }
      // Either job is terminal + no open card, OR job timed out — both
      // green-light the start. Clear the FK so subsequent checks skip
      // this branch.
      await planRepo.updatePlanFields(planId, { pendingSkillScoutJobId: null });
      if (timedOut && !isTerminal) {
        console.warn(
          `[POST /api/plans/${planId}/start] SKILL-SCOUT timeout — proceeding without proposals`,
        );
      }
    } else {
      // FK points at a job row that doesn't exist. Clear it.
      await planRepo.updatePlanFields(planId, { pendingSkillScoutJobId: null });
    }
  }

  const epics: EpicWorkflow[] = [];
  for (const epicId of plan.epicIds) {
    const epic = await epicRepo.getEpicById(epicId);
    if (epic) epics.push(epic);
  }
  if (epics.length === 0) {
    throw new ValidationError('Plan has no epics to start — generate them first via /apply-plan');
  }

  const planWaves = computePlanWaves(epics);
  const firstWaveEpics = epicsInPlanWave(epics, planWaves, 0);
  if (firstWaveEpics.length === 0) {
    throw new ValidationError('Plan-wave 0 is empty — check epic dependencies for cycles');
  }

  const now = new Date().toISOString();
  const jobsByEpic: Record<string, string[]> = {};

  // Phase C.3: cascade plan-level rigor + test config into each pipeline.
  const planOpts = {
    rigor: plan.rigor,
    testModel: plan.testModel,
    hasBrowserTests: plan.testingProfile?.hasBrowserTests,
  };
  for (const epic of firstWaveEpics) {
    const result = await launchPipelineWave(
      epic,
      findFirstWave(epic),
      user.userId,
      now,
      {
        generatePipeline: generateStoryPipeline,
        createJob: agentJobsRepo.createJob,
        uuid: () => crypto.randomUUID(),
      },
      planOpts,
    );
    if (!result.ok) {
      throw new ValidationError(`Launch failed for epic ${epic.epicId}: ${result.message}`);
    }
    jobsByEpic[epic.epicId] = result.jobIds;
    await epicRepo.updateEpicFields(epic.epicId, {
      status: 'in_progress',
      stories: result.updatedStories,
    });
  }

  // Also persist `epicWave` on each epic for UI rendering.
  for (const epic of epics) {
    const epicWave = planWaves[epic.epicId] ?? 0;
    if (epic.epicWave !== epicWave) {
      await epicRepo.updateEpicFields(epic.epicId, { epicWave });
    }
  }

  await planRepo.updatePlanFields(planId, { status: 'developing', startedAt: now });

  return c.json({ planId, jobsByEpic, waveNumber: 0 }, 201);
});

app.patch('/api/plans/:id', async (c) => {
  const planId = c.req.param('id');
  const body = await c.req.json();
  const parsed = planPatchSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  await planRepo.updatePlanFields(planId, parsed.data);
  const updated = await planRepo.getPlanById(planId);
  if (!updated) throw new NotFoundError('Plan', planId);

  // Best-effort plan.md sync. If SSM fails (instance stopped), still return
  // the patched plan with a warning so the client can show drift.
  const epics: EpicWorkflow[] = [];
  for (const epicId of updated.epicIds) {
    const epic = await epicRepo.getEpicById(epicId);
    if (epic) epics.push(epic);
  }
  const warnings: string[] = [];
  try {
    await writePlanMarkdown(updated, epics, { sendSsmCommand, waitForSsmOutput });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Plans] plan.md sync failed for ${planId}: ${message}`);
    warnings.push('plan-md-not-synced');
  }
  return c.json({ plan: updated, ...(warnings.length > 0 && { warnings }) });
});

// POST /api/plans/:id/archive — soft-delete (Story 17.7).
// Moves folder to .trash, cancels running jobs, flips plan to archived.
// Reversible via /restore within the 14-day retention window.
app.post('/api/plans/:id/archive', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  if (plan.status === 'archived') {
    return c.json({ plan, noop: true });
  }

  // Cancel any running jobs for this plan's epics.
  for (const epicId of plan.epicIds) {
    const epic = await epicRepo.getEpicById(epicId);
    if (!epic) continue;
    for (const story of epic.stories) {
      if (!story.jobId) continue;
      const job = await agentJobsRepo.getJobById(story.jobId);
      if (!job || ['COMPLETED', 'FAILED', 'STALE'].includes(job.status)) continue;
      await agentJobsRepo.updateJobFields(story.jobId, {
        status: 'FAILED',
        errorMessage: 'cancelled-by-archive',
      });
    }
  }

  const timestamp = new Date().toISOString();
  let archivePath: string | undefined;
  try {
    archivePath = await movePlanFolderToTrash(plan, timestamp, {
      sendSsmCommand,
      waitForSsmOutput,
    });
  } catch (err) {
    console.warn(`[Plans] archive folder move failed: ${err}`);
  }

  await planRepo.updatePlanFields(planId, {
    status: 'archived',
    preArchiveStatus: plan.status,
    archivedAt: timestamp,
    archivePath,
  });
  const updated = await planRepo.getPlanById(planId);
  return c.json({ plan: updated });
});

// POST /api/plans/:id/restore — bring an archived plan back to its prior status.
app.post('/api/plans/:id/restore', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  if (plan.status !== 'archived') {
    throw new ValidationError(`Plan is ${plan.status}, not archived — nothing to restore`);
  }
  try {
    await restorePlanFolder(plan, { sendSsmCommand, waitForSsmOutput });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError('RESTORE_FAILED', `Folder restore failed: ${message}`, 500);
  }
  await planRepo.updatePlanFields(planId, {
    status: plan.preArchiveStatus || 'concept',
    preArchiveStatus: undefined,
    archivedAt: undefined,
    archivePath: undefined,
  });
  const updated = await planRepo.getPlanById(planId);
  return c.json({ plan: updated });
});

// DELETE /api/plans/:id — hard-delete with cascade (Story 17.7).
// Removes: epic rows, agent-jobs for this plan, agent-events for those jobs,
// EC2 folder (or .trash folder if archived), the plan row itself.
app.delete('/api/plans/:id', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  const results: Array<{ step: string; status: 'done' | 'skipped' | 'error'; detail?: string }> =
    [];

  // 1. Gather job IDs from all epics under this plan.
  const jobIdsToDelete: string[] = [];
  const epicsToDelete: string[] = [];
  for (const epicId of plan.epicIds) {
    const epic = await epicRepo.getEpicById(epicId);
    if (!epic) continue;
    epicsToDelete.push(epicId);
    for (const story of epic.stories) {
      if (story.jobId) jobIdsToDelete.push(story.jobId);
    }
    if (epic.waveBuildJobs) {
      Object.values(epic.waveBuildJobs).forEach((id) => jobIdsToDelete.push(id));
    }
    if (epic.qaJobId) jobIdsToDelete.push(epic.qaJobId);
    if (epic.poJobId) jobIdsToDelete.push(epic.poJobId);
  }
  if (plan.planBuildJobId) jobIdsToDelete.push(plan.planBuildJobId);

  // 2. Delete events + jobs.
  let eventsDeleted = 0;
  let jobsDeleted = 0;
  for (const jobId of jobIdsToDelete) {
    try {
      eventsDeleted += await agentEventsRepo.deleteEventsForJob(jobId);
      await agentJobsRepo.deleteJob(jobId);
      jobsDeleted++;
    } catch (err) {
      results.push({ step: `job:${jobId.slice(0, 8)}`, status: 'error', detail: String(err) });
    }
  }
  results.push({ step: 'events', status: 'done', detail: `${eventsDeleted} events` });
  results.push({ step: 'jobs', status: 'done', detail: `${jobsDeleted} jobs` });

  // 3. Delete epic rows.
  for (const epicId of epicsToDelete) {
    try {
      await epicRepo.deleteEpic(epicId);
    } catch (err) {
      results.push({ step: `epic:${epicId.slice(0, 8)}`, status: 'error', detail: String(err) });
    }
  }
  results.push({ step: 'epics', status: 'done', detail: `${epicsToDelete.length} epics` });

  // 4. Delete EC2 folder — but ONLY for legacy plans where the
  // workingDir is plan-owned. PR-10 #2: App/Plan v1 plans share the
  // App's workingDir across every plan; deleting the folder when one
  // v1 plan is removed would nuke the App + every other plan's work.
  // Detect v1 by `plan.appId` presence (set at /api/apps/:id/plans
  // creation). Legacy plans created via /api/plans/from-intent have
  // no appId and own their folder, so the rm -rf is correct there.
  const planAppId = (plan as Plan & { appId?: string }).appId;
  if (planAppId) {
    results.push({
      step: 'folder',
      status: 'skipped',
      detail: 'App/Plan v1: workingDir owned by the App, not deleted',
    });
  } else {
    try {
      await deletePlanFolder(plan, { sendSsmCommand, waitForSsmOutput });
      results.push({ step: 'folder', status: 'done' });
    } catch (err) {
      results.push({ step: 'folder', status: 'error', detail: String(err) });
    }
  }

  // 5. Delete the plan row.
  await planRepo.deletePlan(planId);
  results.push({ step: 'plan', status: 'done' });

  return c.json({ planId, name: plan.name, results });
});

// ── QA Review (Pipeline Enhancement Plan v2 — QA pillar) ──
//
// GET /api/plans/:id/qa-report
//   Returns a plan-wide aggregation of AC/VQA/Gate pillars + per-epic
//   breakdown + filtered attention items. Pure aggregation over existing
//   epic rows + agent jobs + attention items — no new state.

app.get('/api/plans/:id/qa-report', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  // Hydrate all epics for the plan.
  const epics: EpicWorkflow[] = [];
  for (const epicId of plan.epicIds ?? []) {
    const epic = await epicRepo.getEpicById(epicId);
    if (epic) epics.push(epic);
  }

  // Collect every jobId we care about: plan.qaJobId (PR-8a plan-scoped QA),
  // plan.qaAggregateJobId (PR-8d operator-gated aggregate — its
  // AGGREGATE_OUTPUT is what the ContractGate UI renders), each epic's
  // qaJobId (legacy per-epic QA), each epic's poJobId, and every
  // wave-build job referenced by waveBuildJobs.
  const jobIdSet = new Set<string>();
  if (plan.qaJobId) jobIdSet.add(plan.qaJobId);
  if (plan.qaAggregateJobId) jobIdSet.add(plan.qaAggregateJobId);
  for (const epic of epics) {
    if (epic.qaJobId) jobIdSet.add(epic.qaJobId);
    if (epic.poJobId) jobIdSet.add(epic.poJobId);
    if (epic.waveBuildJobs) {
      for (const id of Object.values(epic.waveBuildJobs)) jobIdSet.add(id);
    }
  }
  const jobsById: Record<string, import('../shared/types/agent-orchestrator').AgentJob> = {};
  for (const jobId of jobIdSet) {
    const job = await agentJobsRepo.getJobById(jobId);
    if (job) jobsById[jobId] = job;
  }

  const attentionItems = await attentionRepo.listAttentionItems(planId);

  const report = buildQaReport({ plan, epics, jobsById, attentionItems });
  return c.json(report);
});

// GET /api/plans/:id/deploy-report
//   Plan-wide release dashboard. Aggregates past deploy jobs (from
//   plan.deployJobIds, falling back to epic.deployJobId of the final epic),
//   derives a verdict, and packages a "what's shipping" handoff summary
//   from the QA report.
app.get('/api/plans/:id/deploy-report', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  const epics: EpicWorkflow[] = [];
  for (const epicId of plan.epicIds ?? []) {
    const epic = await epicRepo.getEpicById(epicId);
    if (epic) epics.push(epic);
  }

  // Collect every jobId the aggregator might want: plan.deployJobIds +
  // every epic.deployJobId (for legacy fallback).
  const jobIdSet = new Set<string>(plan.deployJobIds ?? []);
  for (const epic of epics) {
    if (epic.deployJobId) jobIdSet.add(epic.deployJobId);
  }
  const jobsById: Record<string, import('../shared/types/agent-orchestrator').AgentJob> = {};
  for (const jobId of jobIdSet) {
    const job = await agentJobsRepo.getJobById(jobId);
    if (job) jobsById[jobId] = job;
  }

  // Build QA report inline so the handoff card has current numbers without
  // a second client roundtrip. Reuse the same hydration the QA route does
  // — plan.qaJobId (PR-8a plan-scoped) + every epic's qaJobId/poJobId +
  // wave-build jobs.
  const qaJobIdSet = new Set<string>();
  if (plan.qaJobId) qaJobIdSet.add(plan.qaJobId);
  for (const epic of epics) {
    if (epic.qaJobId) qaJobIdSet.add(epic.qaJobId);
    if (epic.poJobId) qaJobIdSet.add(epic.poJobId);
    if (epic.waveBuildJobs) for (const id of Object.values(epic.waveBuildJobs)) qaJobIdSet.add(id);
  }
  const qaJobsById: Record<string, import('../shared/types/agent-orchestrator').AgentJob> = {};
  for (const jobId of qaJobIdSet) {
    const job = await agentJobsRepo.getJobById(jobId);
    if (job) qaJobsById[jobId] = job;
  }
  const attentionItems = await attentionRepo.listAttentionItems(planId);
  const qaReport = buildQaReport({ plan, epics, jobsById: qaJobsById, attentionItems });

  const report = buildDeployReport({ plan, epics, jobsById, qaReport });
  return c.json(report);
});

// POST /api/plans/:id/qa-review
//   Pipeline v2.0 PR-8d — launches the QA AGGREGATE stage. Plan-scoped
//   (PR-8a) + operator-gated (PR-8d): the aggregate stage produces
//   `visual-tests-draft.md` + a contract-review report, then PAUSES.
//   The execute stage runs after the operator calls
//   `POST /api/plans/:id/qa-contract/approve`.
//
//   Called by the manual "Run QA Review" button and by the
//   wave-completion cron when `plan.autoRunQa` is true.
app.post('/api/plans/:id/qa-review', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  const epicIds = plan.epicIds ?? [];
  const epics: import('../shared/types/epic-workflow').EpicWorkflow[] = [];
  const skippedEpics: Array<{ epicId: string; reason: string }> = [];
  for (const epicId of epicIds) {
    const epic = await epicRepo.getEpicById(epicId);
    if (!epic) {
      skippedEpics.push({ epicId, reason: 'epic-not-found' });
      continue;
    }
    epics.push(epic);
  }

  const now = new Date().toISOString();
  // PR-8g — resolve the App's boilerplate qaContext so qa-prepare boots
  // the right dev server (port, command, healthcheck, warmup, console
  // allowlist). Without this, Next.js Apps fall back to Vite defaults
  // and qa-prepare fails at the healthcheck loop.
  const boilerplate = await resolveQaContext(plan, { getApp: appRepo.getApp });
  const result = await launchPlanQaAggregate(
    plan,
    epics,
    user.userId,
    now,
    {
      getJobById: agentJobsRepo.getJobById,
      createJob: agentJobsRepo.createJob,
      parseVisualTests,
      buildQaAggregatePipeline,
      buildQaExecutePipeline,
      uuid: () => crypto.randomUUID(),
    },
    { boilerplate },
  );

  if (!result.ok) {
    return c.json({ planId, error: result.message, skippedEpics }, 400);
  }

  // Persist aggregate jobId + flip contract status to `pending`.
  await planRepo.updatePlanFields(planId, {
    qaAggregateJobId: result.jobId,
    qaContractStatus: 'pending',
  });
  for (const [epicId, stories] of result.updatedStoriesByEpic) {
    await epicRepo.updateEpicFields(epicId, { stories });
  }

  return c.json(
    {
      planId,
      jobId: result.jobId,
      stage: 'aggregate',
      testCount: result.testCount,
      epicCount: epics.length,
      skippedEpics,
    },
    201,
  );
});

// POST /api/plans/:id/qa-contract/approve
//   Pipeline v2.0 PR-8d (Q4.2) — operator approves the QA test contract
//   produced by the aggregate stage. Body may carry edited test fields:
//
//     { tests: [{ id, level?, expect?, ... }, ...] }
//
//   When omitted, the body's tests default to the aggregate-stage's
//   classified output as-is. The endpoint launches the EXECUTE pipeline,
//   persists `plan.qaJobId`, and flips `plan.qaContractStatus = 'approved'`.
app.post('/api/plans/:id/qa-contract/approve', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  if (!plan.qaAggregateJobId) {
    throw new AppError(
      'NO_AGGREGATE_JOB',
      'Cannot approve a QA contract before qa-aggregate has run.',
      400,
    );
  }
  if (plan.qaContractStatus !== 'pending') {
    throw new AppError(
      'CONTRACT_NOT_PENDING',
      `QA contract is in state '${plan.qaContractStatus ?? 'unknown'}', expected 'pending'.`,
      400,
    );
  }

  // Re-hydrate epics + flatten tests. Operator overrides from body
  // (if any) merge in by `testId`.
  const body = await c.req.json().catch(() => ({}));
  const overrides = new Map<
    string,
    Partial<import('../shared/types/epic-workflow').VisualTestDef>
  >();
  if (Array.isArray(body?.tests)) {
    for (const t of body.tests) {
      if (typeof t?.id === 'string') overrides.set(t.id, t);
    }
  }

  const epics: import('../shared/types/epic-workflow').EpicWorkflow[] = [];
  for (const epicId of plan.epicIds ?? []) {
    const epic = await epicRepo.getEpicById(epicId);
    if (epic) epics.push(epic);
  }

  type FlatTest = import('../shared/types/epic-workflow').VisualTestDef & {
    storyId: string;
    storyTitle: string;
    epicId?: string;
    epicTitle?: string;
  };
  const flatTests: FlatTest[] = [];
  for (const epic of epics) {
    for (const story of epic.stories) {
      for (const vt of story.visualTests ?? []) {
        const ovr = overrides.get(vt.id);
        flatTests.push({
          ...vt,
          ...(ovr ?? {}),
          // Mark levelOverridden when operator explicitly changed level.
          levelOverridden: ovr?.level !== undefined && ovr.level !== vt.level,
          storyId: story.storyId,
          storyTitle: story.title,
          epicId: epic.epicId,
          epicTitle: epic.title,
        });
      }
    }
  }

  const now = new Date().toISOString();
  // PR-8g — boilerplate-aware execute (Next.js → :3000, Vite → :5173, etc).
  const boilerplate = await resolveQaContext(plan, { getApp: appRepo.getApp });
  const result = await launchPlanQaExecute(
    plan,
    flatTests,
    user.userId,
    now,
    {
      getJobById: agentJobsRepo.getJobById,
      createJob: agentJobsRepo.createJob,
      parseVisualTests,
      buildQaAggregatePipeline,
      buildQaExecutePipeline,
      uuid: () => crypto.randomUUID(),
    },
    { boilerplate },
  );

  if (!result.ok) {
    return c.json({ planId, error: result.message }, 400);
  }

  await planRepo.updatePlanFields(planId, {
    qaJobId: result.jobId,
    qaContractStatus: 'approved',
    qaContractDecidedAt: now,
    qaContractDecidedBy: user.userId,
  });

  return c.json(
    {
      planId,
      jobId: result.jobId,
      stage: 'execute',
      testCount: result.testCount,
      contractStatus: 'approved',
    },
    201,
  );
});

// POST /api/plans/:id/qa-contract/reject
//   Operator decides not to run QA. Sets contract status to 'rejected'
//   without launching an execute job. Reversible — operator can re-run
//   the QA aggregate via POST /api/plans/:id/qa-review.
app.post('/api/plans/:id/qa-contract/reject', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  const now = new Date().toISOString();
  await planRepo.updatePlanFields(planId, {
    qaContractStatus: 'rejected',
    qaContractDecidedAt: now,
    qaContractDecidedBy: user.userId,
  });
  return c.json({ planId, contractStatus: 'rejected' });
});

// POST /api/plans/:id/qa-tests/:testId/retry
//   Pipeline v2.0 PR-8e (Q5.4) — single-test retry. Operator clicks
//   "retry this test only" in the QA drawer. Spawns a new execute job
//   restricted to one test at the test's level (cheap: ~$0.005 for L1,
//   $0 for L0). Does NOT replace plan.qaJobId — appends to a retry
//   history (or, for now, just creates the job and returns the jobId
//   for the caller to track). UI iteration deferred to follow-up.
app.post('/api/plans/:id/qa-tests/:testId/retry', async (c) => {
  const planId = c.req.param('id');
  const testId = c.req.param('testId');
  const user = c.get('user');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  // Find the test in the plan's epics+stories.
  type FlatTest = import('../shared/types/epic-workflow').VisualTestDef & {
    storyId: string;
    storyTitle: string;
    epicId?: string;
    epicTitle?: string;
  };
  let target: FlatTest | undefined;
  for (const epicId of plan.epicIds ?? []) {
    const epic = await epicRepo.getEpicById(epicId);
    if (!epic) continue;
    for (const story of epic.stories) {
      const vt = story.visualTests?.find((v) => v.id === testId);
      if (vt) {
        target = {
          ...vt,
          storyId: story.storyId,
          storyTitle: story.title,
          epicId: epic.epicId,
          epicTitle: epic.title,
        };
        break;
      }
    }
    if (target) break;
  }
  if (!target) throw new NotFoundError('VisualTest', testId);

  const now = new Date().toISOString();
  // PR-8g — single-test retries also need the right boilerplate context.
  const boilerplate = await resolveQaContext(plan, { getApp: appRepo.getApp });
  const result = await launchPlanQaExecute(
    plan,
    [target],
    user.userId,
    now,
    {
      getJobById: agentJobsRepo.getJobById,
      createJob: agentJobsRepo.createJob,
      parseVisualTests,
      buildQaAggregatePipeline,
      buildQaExecutePipeline,
      uuid: () => crypto.randomUUID(),
    },
    { boilerplate },
  );
  if (!result.ok) {
    return c.json({ planId, testId, error: result.message }, 400);
  }
  return c.json({ planId, testId, retryJobId: result.jobId }, 201);
});

// POST /api/plans/:id/approve-ac
//   Operator sign-off on the AC pillar. Flips every pending criterion to
//   PASS by writing `plan.acApproval = {approvedAt, approvedBy}`. Re-runnable —
//   later calls overwrite the timestamp. No body required.
app.post('/api/plans/:id/approve-ac', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  const now = new Date().toISOString();
  await planRepo.updatePlanFields(planId, {
    acApproval: { approvedAt: now, approvedBy: user.userId },
  });
  return c.json({ planId, acApproval: { approvedAt: now, approvedBy: user.userId } });
});

// POST /api/plans/:id/revoke-ac-approval
//   Clears plan.acApproval. Used when a reviewer needs to un-approve because
//   a story was sent back for rework.
app.post('/api/plans/:id/revoke-ac-approval', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  await planRepo.updatePlanFields(planId, { acApproval: undefined });
  return c.json({ planId });
});

// POST /api/epic-workflows/:id/stories/:storyId/send-back
//   QA Review "Send back to dev" action. Appends a QA note to the story's
//   description, flips status to `fixing`, and re-launches the story pipeline
//   so the daemon picks it up. Used by the failure drawer on the QA page.
app.post('/api/epic-workflows/:id/stories/:storyId/send-back', async (c) => {
  const epicId = c.req.param('id');
  const storyId = c.req.param('storyId');
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  const sourceLabel = typeof body?.source === 'string' ? body.source : 'QA Review';

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);
  const storyIdx = epic.stories.findIndex((s) => s.storyId === storyId);
  if (storyIdx < 0) throw new NotFoundError('Story', storyId);

  // Append a signed, timestamped note so remediation history survives.
  const now = new Date().toISOString();
  const story = epic.stories[storyIdx];
  const trimmedDesc = story.description.replace(/\s+$/, '');
  const noteBlock = note
    ? `\n\n---\n**${sourceLabel} · ${now}**\n${note}\n`
    : `\n\n---\n**${sourceLabel} · ${now}** — sent back for fixing.\n`;
  const updatedStories = [...epic.stories];
  updatedStories[storyIdx] = {
    ...story,
    description: trimmedDesc + noteBlock,
    status: 'fixing',
  };

  await epicRepo.updateEpicFields(epicId, {
    stories: updatedStories,
    status: 'fixing',
  });

  // Re-launch the story via the existing launcher so the daemon picks it up.
  // PR-6 (A): carry forward the prior job's stepResults + sessions + variables
  // so the daemon's executePipeline can skip already-complete steps and
  // --resume <prior session> on the failed step. Without this, the QA send-back
  // would replay every step from zero — wasting cost on already-done work.
  const priorJobState = await buildPriorJobStateFromStory(story);
  const result = await launchStoryRerun(
    epic,
    storyId,
    user.userId,
    now,
    {
      generatePipeline: generateStoryPipeline,
      createJob: agentJobsRepo.createJob,
      uuid: () => crypto.randomUUID(),
    },
    undefined,
    priorJobState,
  );
  if (!result.ok) {
    // Story was updated; re-launch can fail (e.g. deleted mid-request).
    return c.json({ storyId, status: 'fixing', jobId: null, warning: 'rerun-failed' }, 200);
  }
  // launchStoryRerun already patches stories[] with the new jobId — use its
  // output so we don't clobber the status flip we just did.
  const finalStories = result.updatedStories.map((s) =>
    s.storyId === storyId
      ? { ...s, status: 'fixing' as const, description: updatedStories[storyIdx].description }
      : s,
  );
  await epicRepo.updateEpicFields(epicId, { stories: finalStories });
  return c.json({ storyId, status: 'fixing', jobId: result.jobId }, 201);
});

// ── Attention Inbox (Pipeline Enhancement Plan v2 — Phase A) ──
//
// GET /api/plans/:id/attention-items?status=open|resolving|resolved
//   Returns items for a plan. Default filter is every status.
//   Sort: severity desc, then createdAt desc (Q8).
// POST /api/plans/:id/attention-items/:itemId/resolve
//   Flips an item to status=resolved.
// POST /api/plans/:id/attention-items/:itemId/reopen
//   Flips a resolved item back to open (useful if a resolution was premature).

const ATTENTION_SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

app.get('/api/plans/:id/attention-items', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);

  const items = await attentionRepo.listAttentionItems(planId);

  const statusFilter = c.req.query('status');
  const filtered = statusFilter ? items.filter((it) => it.status === statusFilter) : items;

  filtered.sort((a, b) => {
    const sa = ATTENTION_SEVERITY_RANK[a.severity] || 0;
    const sb = ATTENTION_SEVERITY_RANK[b.severity] || 0;
    if (sa !== sb) return sb - sa;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const unresolvedCount = items.filter((it) => it.status !== 'resolved').length;

  return c.json({ items: filtered, unresolvedCount, total: items.length });
});

app.post('/api/plans/:id/attention-items/:itemId/resolve', async (c) => {
  const planId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  const updated = await attentionRepo.updateAttentionStatus(
    planId,
    itemId,
    'resolved' as AttentionStatus,
  );
  if (!updated) return c.json({ error: 'Attention item not found' }, 404);
  return c.json({ item: updated });
});

app.post('/api/plans/:id/attention-items/:itemId/reopen', async (c) => {
  const planId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  const updated = await attentionRepo.updateAttentionStatus(
    planId,
    itemId,
    'open' as AttentionStatus,
  );
  if (!updated) return c.json({ error: 'Attention item not found' }, 404);
  return c.json({ item: updated });
});

// ── Pipeline v2 Phase 3 — Story 3-E-3-1 (PR-76): Reflection Inbox routes ──
// GET    /api/reflections?projectSlug=&status=          — list (filter optional)
// GET    /api/reflections/:projectSlug/:id              — single
// POST   /api/reflections/:projectSlug/:id/confirm
// POST   /api/reflections/:projectSlug/:id/decline
// POST   /api/reflections/:projectSlug/:id/defer
//
// Confirmation triggers the daemon's REFLECTOR-APPLY pipeline out-of-band
// (stub today — Story 3-E-3-1 follow-on lands the actual git-commit
// integration); the API just records the decision so the UI reflects it.
app.get('/api/reflections', async (c) => {
  const projectSlug = c.req.query('projectSlug') || undefined;
  const status = c.req.query('status') as ReflectionStatus | undefined;
  const items = await reflectionsService.listReflections({ projectSlug, status });
  const pendingCount = items.filter((it) => it.status === 'pending').length;
  return c.json({ items, pendingCount, total: items.length });
});

app.get('/api/reflections/:projectSlug/:id', async (c) => {
  const projectSlug = c.req.param('projectSlug');
  const id = c.req.param('id');
  const item = await reflectionsService.getReflection(projectSlug, id);
  if (!item) return c.json({ error: 'Reflection not found' }, 404);
  return c.json({ item });
});

app.post('/api/reflections/:projectSlug/:id/confirm', async (c) => {
  const projectSlug = c.req.param('projectSlug');
  const id = c.req.param('id');
  const updated = await reflectionsService.applyDecision({
    projectSlug,
    id,
    decision: 'confirm',
  });
  if (!updated) return c.json({ error: 'Reflection not found' }, 404);
  return c.json({ item: updated });
});

app.post('/api/reflections/:projectSlug/:id/decline', async (c) => {
  const projectSlug = c.req.param('projectSlug');
  const id = c.req.param('id');
  const updated = await reflectionsService.applyDecision({
    projectSlug,
    id,
    decision: 'decline',
  });
  if (!updated) return c.json({ error: 'Reflection not found' }, 404);
  return c.json({ item: updated });
});

app.post('/api/reflections/:projectSlug/:id/defer', async (c) => {
  const projectSlug = c.req.param('projectSlug');
  const id = c.req.param('id');
  const updated = await reflectionsService.applyDecision({
    projectSlug,
    id,
    decision: 'defer',
  });
  if (!updated) return c.json({ error: 'Reflection not found' }, 404);
  return c.json({ item: updated });
});

// POST /api/plans/:id/attention-items/resolve-all
//   PR-9 #4 — bulk-resolve every open attention item for a plan. Operator
//   triggers from the bell drawer when a plan accumulates pre-PR-7 noise
//   (the recurring per-tick rows that landed before the idempotent
//   upsert) or after a known-bad story is intentionally archived.
//
//   Returns `{ planId, resolvedCount }`. Already-resolved rows are
//   skipped (the underlying conditional update is a no-op for them).
app.post('/api/plans/:id/attention-items/resolve-all', async (c) => {
  const planId = c.req.param('id');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);

  const items = await attentionRepo.listAttentionItems(planId);
  let resolvedCount = 0;
  for (const item of items) {
    if (item.status === 'resolved') continue;
    try {
      const updated = await attentionRepo.updateAttentionStatus(
        planId,
        item.itemId,
        'resolved' as AttentionStatus,
      );
      if (updated) resolvedCount += 1;
    } catch {
      // Best-effort — one bad row shouldn't block the rest.
    }
  }
  return c.json({ planId, resolvedCount });
});

app.post('/api/epic-workflows', async (c) => {
  const body = await c.req.json();
  const user = c.get('user');
  const epicId = crypto.randomUUID();
  const now = new Date().toISOString();

  const rawStories = (body.stories || []) as {
    title: string;
    description: string;
    dependsOn?: string[];
  }[];
  const stories = rawStories.map((s, i) => ({
    storyId: `story-${i}`,
    order: i,
    title: s.title,
    description: s.description,
    status: 'pending' as const,
    dependsOn: s.dependsOn || [],
  }));

  // Compute waves via topological sort
  const storyById = new Map(stories.map((s) => [s.storyId, s]));
  const waveCache = new Map<string, number>();
  function computeWave(id: string, visited = new Set<string>()): number {
    if (waveCache.has(id)) return waveCache.get(id)!;
    if (visited.has(id)) return 0; // cycle safety
    visited.add(id);
    const story = storyById.get(id);
    if (!story || !story.dependsOn || story.dependsOn.length === 0) {
      waveCache.set(id, 0);
      return 0;
    }
    const depWaves = story.dependsOn.map((d) => computeWave(d, visited));
    const wave = Math.max(...depWaves) + 1;
    waveCache.set(id, wave);
    return wave;
  }
  const storiesWithWaves = stories.map((s) => ({ ...s, wave: computeWave(s.storyId) }));

  const epic = await epicRepo.createEpic({
    epicId,
    title: body.title || 'Untitled Epic',
    description: body.description || '',
    acceptanceCriteria: body.acceptanceCriteria || '',
    workingDir: body.workingDir || '',
    status: 'draft',
    stories: storiesWithWaves,
    yoloMode: body.yoloMode !== false,
    devModel: body.devModel,
    devEffort: body.devEffort,
    reviewerModel: body.reviewerModel,
    reviewerEffort: body.reviewerEffort,
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
  });

  return c.json({ epicId: epic.epicId }, 201);
});

// List all epics (summary only, no full stories)
app.get('/api/epic-workflows', async (c) => {
  const epics = await epicRepo.getAllEpics();
  const summaries = epics
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map((e) => ({
      epicId: e.epicId,
      title: e.title,
      status: e.status,
      appName: e.workingDir?.split('/').filter(Boolean).pop() || '',
      workingDir: e.workingDir,
      totalStories: e.stories?.length || 0,
      doneStories: e.stories?.filter((s) => s.status === 'done').length || 0,
      deployUrl: e.deployUrl,
      createdAt: e.createdAt,
    }));
  return c.json(summaries);
});

app.get('/api/epic-workflows/:id', async (c) => {
  const epic = await epicRepo.getEpicById(c.req.param('id'));
  if (!epic) throw new NotFoundError('EpicWorkflow', c.req.param('id'));

  let finalStories = epic.stories;
  let finalStatus = epic.status;
  let needsUpdate = false;

  // ── Sync-on-read: check queued/running stories' job statuses ──
  const syncedStories = await Promise.all(
    epic.stories.map(async (story) => {
      // Only stories with a jobId in a non-terminal state get synced.
      const syncable = (story.status === 'queued' || story.status === 'running') && story.jobId;
      if (!syncable) return story;
      const job = await agentJobsRepo.getJobById(story.jobId!);
      if (!job) return story;
      if (job.status === 'COMPLETED') {
        needsUpdate = true;
        const updated: typeof story = { ...story, status: 'done' as const };
        const rawVT = job.variables?.VISUAL_TESTS;
        if (story.hasBrowserTests && rawVT) {
          updated.visualTests = parseVisualTests(rawVT);
        }
        return updated;
      }
      if (job.status === 'FAILED') {
        needsUpdate = true;
        return { ...story, status: 'failed' as const };
      }
      // Promote queued → running when daemon has picked up the job.
      if (story.status === 'queued' && job.status === 'RUNNING') {
        needsUpdate = true;
        return { ...story, status: 'running' as const };
      }
      // Demote running → queued if the daemon restarted and the job is
      // back to PENDING (rare but possible).
      if (story.status === 'running' && job.status === 'PENDING') {
        needsUpdate = true;
        return { ...story, status: 'queued' as const };
      }
      return story;
    }),
  );
  finalStories = syncedStories;

  // ── Session capture: extract session metadata from completed stories ──
  if (needsUpdate) {
    const appName = epic.workingDir.split('/').filter(Boolean).pop() || '';
    if (appName) {
      // Fire-and-forget: capture session data for newly-done stories
      const newlyDone = finalStories.filter((s) => {
        if (s.status !== 'done') return false;
        const prev = epic.stories.find((os) => os.storyId === s.storyId)?.status;
        return prev === 'running' || prev === 'queued';
      });
      for (const story of newlyDone) {
        if (!story.jobId) continue;
        captureSessionToRegistry(appName, epic, story).catch((err) =>
          console.error(`[Registry] Session capture failed for ${story.storyId}:`, err.message),
        );
      }
    }
  }

  // ── Compute correct epic status based on current state ──
  const allDone = finalStories.every((s) => s.status === 'done' || s.status === 'skipped');
  if (allDone && finalStories.length > 0) {
    // Check QA status if applicable
    const hasBrowserTests = epic.testingProfile?.hasBrowserTests;
    let qaOk = !hasBrowserTests; // no browser tests = QA not needed
    if (epic.qaJobId) {
      const qaJob = await agentJobsRepo.getJobById(epic.qaJobId);
      if (qaJob?.status === 'COMPLETED' && qaJob.variables?.OVERALL_VERDICT === 'PASS') qaOk = true;
      else if (qaJob?.status === 'RUNNING' || qaJob?.status === 'PENDING') {
        finalStatus = 'in_review' as const;
      }
    }

    // Check PO status
    let poOk = false;
    if (epic.poJobId) {
      const poJob = await agentJobsRepo.getJobById(epic.poJobId);
      if (poJob?.status === 'COMPLETED' && poJob.variables?.VERDICT === 'PASS') poOk = true;
    }

    // Determine final status
    if (qaOk && poOk) {
      finalStatus = 'completed' as const;
    } else if (qaOk && !epic.poJobId) {
      // QA passed but PO not triggered yet — stay in progress or completed (ready for PO)
      finalStatus = allDone ? ('completed' as const) : epic.status;
    } else if (!qaOk && finalStatus !== 'in_review') {
      finalStatus = allDone ? ('completed' as const) : epic.status;
    }
  } else if (needsUpdate) {
    finalStatus = epic.status;
  }

  if (needsUpdate || finalStatus !== epic.status) {
    await epicRepo.updateEpicFields(epic.epicId, { stories: finalStories, status: finalStatus });
    return c.json({ ...epic, stories: finalStories, status: finalStatus });
  }

  return c.json(epic);
});

app.put('/api/epic-workflows/:id', async (c) => {
  const body = await c.req.json();
  await epicRepo.updateEpicFields(c.req.param('id'), body);
  const updated = await epicRepo.getEpicById(c.req.param('id'));
  return c.json(updated);
});

// ── Delete epic and all associated resources ──
app.delete('/api/epic-workflows/:id', async (c) => {
  const epicId = c.req.param('id');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  const appName = epic.workingDir.split('/').filter(Boolean).pop() || '';
  const results: { step: string; status: string; detail?: string }[] = [];

  // 1. Collect all job IDs
  const jobIds: string[] = [];
  for (const story of epic.stories) {
    if (story.jobId) jobIds.push(story.jobId);
  }
  if (epic.qaJobId) jobIds.push(epic.qaJobId);
  if (epic.poJobId) jobIds.push(epic.poJobId);
  if (epic.deployJobId) jobIds.push(epic.deployJobId);
  if (epic.waveBuildJobs) {
    for (const jobId of Object.values(epic.waveBuildJobs)) jobIds.push(jobId);
  }

  // 2. Delete agent jobs (events have 7-day TTL — they'll auto-expire)
  try {
    let jobsDeleted = 0;
    await Promise.all(
      jobIds.map(async (jobId) => {
        try {
          await agentJobsRepo.deleteJob(jobId);
          jobsDeleted++;
        } catch {
          /* job may already be gone */
        }
      }),
    );
    results.push({
      step: 'agent-jobs',
      status: 'done',
      detail: `${jobsDeleted}/${jobIds.length} jobs`,
    });
  } catch (err: unknown) {
    results.push({
      step: 'agent-jobs',
      status: 'error',
      detail: String((err as Error)?.message ?? err),
    });
  }

  // 3. Delete S3 deployed artifacts
  if (appName && epic.deployUrl) {
    try {
      const s3 = new S3Client({ region: 'us-east-1' });
      const prefix = `apps/${appName}/`;
      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: 'futurator-ai-website', Prefix: prefix }),
      );
      const objects = list.Contents?.map((o) => ({ Key: o.Key! })) || [];
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: 'futurator-ai-website',
            Delete: { Objects: objects },
          }),
        );
      }
      results.push({ step: 's3-artifacts', status: 'done', detail: `${objects.length} files` });
    } catch (err: unknown) {
      results.push({
        step: 's3-artifacts',
        status: 'error',
        detail: String((err as Error)?.message ?? err),
      });
    }
  } else {
    results.push({ step: 's3-artifacts', status: 'skipped' });
  }

  // 4. Delete EC2 project folder via SSM (best-effort, non-blocking)
  if (appName) {
    try {
      const { state } = await getInstanceState();
      if (state === 'running') {
        await sendSsmCommand(`rm -rf /home/ubuntu/projects/${appName}`);
        results.push({ step: 'ec2-filesystem', status: 'done', detail: appName });
      } else {
        results.push({ step: 'ec2-filesystem', status: 'skipped', detail: `EC2 ${state}` });
      }
    } catch (err: unknown) {
      // SSM agent may be unreachable — not fatal for deletion
      results.push({
        step: 'ec2-filesystem',
        status: 'error',
        detail: String((err as Error)?.message ?? err),
      });
    }
  }

  // 5. Delete project registry (best-effort)
  if (appName) {
    try {
      await registryRepo.deleteProject(appName);
      results.push({ step: 'project-registry', status: 'done' });
    } catch {
      results.push({ step: 'project-registry', status: 'skipped' });
    }
  }

  // 6. Delete epic record (last — critical step)
  try {
    await epicRepo.deleteEpic(epicId);
    results.push({ step: 'epic-record', status: 'done' });
  } catch (err: unknown) {
    results.push({
      step: 'epic-record',
      status: 'error',
      detail: String((err as Error)?.message ?? err),
    });
  }

  console.log(
    `[Delete] ${epicId.slice(0, 8)} (${appName}):`,
    results.map((r) => `${r.step}=${r.status}`).join(', '),
  );
  return c.json({ epicId, appName, results });
});

// ── Re-run a single story with a fresh step-based pipeline. Story 16.3. ──
app.post('/api/epic-workflows/:id/stories/:storyId/run', async (c) => {
  const epicId = c.req.param('id');
  const storyId = c.req.param('storyId');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  // Phase C.3: cascade plan.rigor / testModel / testingProfile into the
  // rerun's pipeline. Without this, a retry on a 'production' plan would
  // silently rebuild with 'mvp' rigor (no tamper-check, no red-gate) —
  // behaviour would differ from the original run.
  let planOpts:
    | {
        rigor?: import('../shared/types/plan').PlanRigor;
        testModel?: string;
        hasBrowserTests?: boolean;
      }
    | undefined;
  if (epic.planId) {
    const plan = await planRepo.getPlanById(epic.planId);
    if (plan) {
      planOpts = {
        rigor: plan.rigor,
        testModel: plan.testModel,
        hasBrowserTests: plan.testingProfile?.hasBrowserTests,
      };
    }
  }

  // PR-6 (A): retry resumes from the prior job's session — skips already-
  // `complete` steps and --resumes the failed step's session for warm cache
  // hits. Without this, every retry replays every step from zero.
  const storyForResume = epic.stories.find((s) => s.storyId === storyId);
  const priorJobState = storyForResume
    ? await buildPriorJobStateFromStory(storyForResume)
    : undefined;
  const now = new Date().toISOString();
  const result = await launchStoryRerun(
    epic,
    storyId,
    user.userId,
    now,
    {
      generatePipeline: generateStoryPipeline,
      createJob: agentJobsRepo.createJob,
      uuid: () => crypto.randomUUID(),
    },
    planOpts,
    priorJobState,
  );
  if (!result.ok) {
    throw new NotFoundError('Story', storyId);
  }

  await epicRepo.updateEpicFields(epicId, {
    stories: result.updatedStories,
    status: 'in_progress',
  });

  return c.json({ jobId: result.jobId, storyId }, 201);
});

// ── Start an epic. Mode selected by `epic.useEpicOrchestrator`:
//   - true  (default): single `phase='epic-dev'` orchestrator job (EO-4.4)
//   - false (Story 16.1): one step-based pipeline job per wave-1 story
//
// Response shape differs by mode:
//   - orchestrator → `{ jobId }`
//   - pipeline     → `{ jobIds, waveNumber }`
//
// TODO(16.2): enqueue wave N+1 when wave N completes (wave-completion cron +
// wave-build-check). Currently pipeline mode only enqueues wave 1.
app.post('/api/epic-workflows/:id/start', async (c) => {
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  // Pipeline mode — Story 16.1. (Only wave 1 is launched here; Story 16.2's
  // wave-completion cron enqueues wave N+1 as each wave completes.)
  if (epic.useEpicOrchestrator === false) {
    if (!epic.stories || epic.stories.length === 0) {
      throw new ValidationError('Epic has no stories to start');
    }
    const now = new Date().toISOString();
    const firstWave = findFirstWave(epic);
    const launch = await launchPipelineWave(epic, firstWave, user.userId, now, {
      generatePipeline: generateStoryPipeline,
      createJob: agentJobsRepo.createJob,
      uuid: () => crypto.randomUUID(),
    });
    if (!launch.ok) {
      throw new ValidationError(launch.message);
    }
    await epicRepo.updateEpicFields(epicId, {
      status: 'in_progress',
      stories: launch.updatedStories,
    });
    return c.json({ jobIds: launch.jobIds, waveNumber: launch.waveNumber }, 201);
  }

  // Orchestrator mode (default) — unchanged from EO-4.4.
  const validation = validateEpicForOrchestratorStart(epic);
  if (!validation.ok) {
    if (validation.code === 'flag-disabled') {
      return c.json(
        { error: { code: 'useEpicOrchestrator-disabled', message: validation.message } },
        409,
      );
    }
    const detail =
      validation.code === 'inference-missing' && validation.missingInferenceFor
        ? `${validation.message} Run inference first: ${validation.missingInferenceFor.join(', ')}`
        : validation.message;
    throw new ValidationError(detail);
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const projectId = epic.workingDir.split('/').filter(Boolean).pop() || epicId;

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: epic.workingDir,
    pipeline: { agents: {}, steps: [] },
    phase: 'epic-dev',
    epicId,
    projectId,
    epicDevPayload: validation.payload,
  });

  await epicRepo.updateEpicFields(epicId, {
    status: 'in_progress',
    orchestratorJobId: jobId,
  });

  return c.json({ jobId }, 201);
});

// Pipeline-mode launcher — Story 16.1.
//
// Creates one PENDING step-based job per story in wave 1 (the lowest wave
// number on the epic). Mutates the stories array in-place to record
// `story.jobId` + `story.status='running'` and persists the updated array
// back to the epic row in a single updateEpicFields call. Returns the
// created jobIds + the wave number, or a 400-friendly failure struct if
// wave 1 is empty.
//
// Pipeline only enqueues wave 1. Multi-wave gating (Story 16.2) will wait
// for wave N COMPLETED + wave-build-check passing before enqueuing wave N+1.
// (launchPipelineWave + findFirstWave extracted to
// functions/shared/services/pipeline-launcher.ts for unit-testability
// without booting the full Hono app.)

// ── Resolve Blocker (EO-5.2): amend / skip / retry a blocked story ──
// Three actions, mutually exclusive. `amend` and `retry` enqueue a resume
// epic-dev job; `skip` does not. The optimistic-lock field
// `expectedBlockerReportedAt` guards against a second operator resolving a
// stale blocker in another tab.
const resolveBlockerThrottle = new Map<string, number>();
const RESOLVE_BLOCKER_THROTTLE_MS = 5000;

app.post('/api/epic-workflows/:id/stories/:storyId/resolve-blocker', async (c) => {
  const epicId = c.req.param('id');
  const storyId = c.req.param('storyId');
  const user = c.get('user');

  // Lightweight in-memory throttle per (epic, story). Intentionally
  // single-instance — a Lambda cold start resets it, which at worst lets one
  // stray click through before the next 409 `not-blocked` kicks in.
  const throttleKey = `${epicId}:${storyId}`;
  const lastResolvedAt = resolveBlockerThrottle.get(throttleKey) ?? 0;
  const nowMs = Date.now();
  if (nowMs - lastResolvedAt < RESOLVE_BLOCKER_THROTTLE_MS) {
    return c.json(
      {
        error: {
          code: 'rate-limited',
          message: 'Please wait a few seconds before resolving this blocker again.',
        },
      },
      429,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }

  const parsed = resolveBlockerSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(issues);
  }
  const input = parsed.data;

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  if (epic.status === 'deployed' || epic.status === 'completed') {
    return c.json(
      {
        error: {
          code: 'epic-terminal',
          message: `Cannot resolve a blocker on a ${epic.status} epic.`,
        },
      },
      409,
    );
  }

  const story = epic.stories.find((s) => s.storyId === storyId);
  if (!story) throw new NotFoundError('Story', storyId);

  if (story.status !== 'blocked' || !story.blocker) {
    return c.json(
      {
        error: {
          code: 'not-blocked',
          message: `Story ${storyId} is not in a blocked state (current: ${story.status}).`,
        },
      },
      409,
    );
  }

  if (
    input.expectedBlockerReportedAt &&
    input.expectedBlockerReportedAt !== story.blocker.reportedAt
  ) {
    return c.json(
      {
        error: {
          code: 'blocker-changed',
          message:
            'This blocker has been updated since the drawer opened. Reload the story to see the latest state.',
        },
      },
      409,
    );
  }

  const resolvedAt = new Date().toISOString();
  const resolvedBy = user.userId;

  let newStatus: 'pending' | 'skipped';
  let resumeJobId: string | null = null;
  let amendedFields: Array<keyof EpicStory> | undefined;
  const warnings: string[] = [];

  if (input.action === 'skip') {
    newStatus = 'skipped';
  } else if (input.action === 'retry') {
    newStatus = 'pending';
  } else {
    newStatus = 'pending';
    amendedFields = Object.keys(input.amendedStory) as Array<keyof EpicStory>;
  }

  const resolutionRecord = {
    resolvedAt,
    resolvedBy,
    action: input.action,
    reason: input.reason,
    ...(amendedFields ? { amendedFields } : {}),
  };

  const updatedStories = epic.stories.map((s) => {
    if (s.storyId !== storyId) return s;
    const base: EpicStory = {
      ...s,
      status: newStatus,
      blocker: undefined,
      resolutionHistory: [...(s.resolutionHistory ?? []), resolutionRecord],
    };
    if (input.action === 'amend') {
      return { ...base, ...input.amendedStory };
    }
    return base;
  });

  await epicRepo.updateEpicFields(epicId, { stories: updatedStories });

  if (input.action !== 'skip') {
    const shouldResume =
      input.action === 'amend' || (input.action === 'retry' && input.resumeImmediately);
    if (shouldResume) {
      try {
        const { jobId } = await enqueueResumeJob(
          {
            epicId,
            userId: resolvedBy,
            priorJobId: epic.orchestratorJobId,
          },
          {
            getEpicById: epicRepo.getEpicById,
            getJobById: agentJobsRepo.getJobById,
            createJob: agentJobsRepo.createJob,
            newJobId: () => crypto.randomUUID(),
            now: () => new Date(),
          },
        );
        resumeJobId = jobId;
        await epicRepo.updateEpicFields(epicId, {
          status: 'in_progress',
          orchestratorJobId: jobId,
        });
      } catch (err) {
        warnings.push('resume-enqueue-failed');
        console.error('[resolve-blocker] resume enqueue failed', err);
      }
    }
  }

  // Emit blocker_resolved event for the observability spine.
  try {
    const correlationJobId = resumeJobId ?? epic.orchestratorJobId ?? epicId;
    await agentEventsRepo.pushEvent({
      jobId: correlationJobId,
      eventSeq: `${resolvedAt}#${crypto.randomUUID()}`,
      seq: nowMs,
      timestamp: resolvedAt,
      stepId: 'resolve-blocker',
      agentId: 'api-resolve-blocker',
      eventType: 'blocker_resolved',
      epicId,
      storyId,
      role: 'orchestrator',
      waveNumber: story.blocker.waveNumber,
      payload: {
        action: input.action,
        resolvedBy,
        reason: input.reason,
        ...(amendedFields ? { amendedFields } : {}),
        ...(resumeJobId ? { resumeJobId } : {}),
      },
    });
  } catch (err) {
    console.error('[resolve-blocker] event emit failed', err);
  }

  resolveBlockerThrottle.set(throttleKey, nowMs);

  return c.json(
    {
      ok: true,
      storyId,
      newStatus,
      resumeJobId,
      resolvedAt,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    200,
  );
});

// ── PO Review: run a product owner pipeline against the completed epic ──
app.post('/api/epic-workflows/:id/po-review', async (c) => {
  return c.json(
    {
      error: {
        code: 'legacy-pipeline-removed',
        message: 'PO review pipeline has been removed. Orchestrator handles review inline.',
      },
    },
    410,
  );
});

// Local alias to the shared helper (see ../shared/pipelines/visual-qa-pipeline).
// The inlined definition that used to live here has been moved — if you need
// to edit the QA prompt or extractors, do it in the shared module.
const buildQaPipeline = sharedBuildQaPipeline;

// ── Visual QA: run consolidated visual testing after all stories complete ──
app.post('/api/epic-workflows/:id/visual-qa', async (c) => {
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  const now = new Date().toISOString();
  const result = await launchVisualQa(epic, user.userId, now, {
    getJobById: agentJobsRepo.getJobById,
    createJob: agentJobsRepo.createJob,
    parseVisualTests,
    buildQaPipeline,
    uuid: () => crypto.randomUUID(),
  });
  if (!result.ok) {
    return c.json({ error: result.message }, 400);
  }

  const patch: Partial<import('../shared/types/epic-workflow').EpicWorkflow> = {
    qaJobId: result.jobId,
    status: 'in_review',
  };
  if (result.storiesChanged) {
    patch.stories = result.updatedStories;
  }
  await epicRepo.updateEpicFields(epicId, patch);

  return c.json({ jobId: result.jobId, epicId }, 201);
});

// ── Start Dev Server: launch `npm run dev` in background and capture URL. ──
app.post('/api/epic-workflows/:id/dev-server', async (c) => {
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  // Fetch the EC2 public IP server-side so the agent doesn't have to deal
  // with IMDSv2 token auth from inside the Claude sandbox. The agent was
  // returning the private 172.31.x.x address, which is useless externally.
  const { state, publicIp } = await getInstanceState();
  if (state !== 'running' || !publicIp) {
    throw new AppError('EC2_NOT_RUNNING', `EC2 is ${state} or has no public IP`, 400);
  }

  const now = new Date().toISOString();
  const { jobId } = await launchDevServer(epic, user.userId, now, publicIp, {
    createJob: agentJobsRepo.createJob,
    uuid: () => crypto.randomUUID(),
  });

  return c.json({ jobId, epicId, publicUrl: `http://${publicIp}:5173` }, 201);
});

// ── EC2 Daemon Control (develope-it) ──

async function sendSsmCommand(cmd: string): Promise<string> {
  const result = await ssmClient.send(
    new SendCommandCommand({
      InstanceIds: [EC2_INSTANCE_ID],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: [cmd] },
    }),
  );
  return result.Command?.CommandId || '';
}

async function getInstanceState(): Promise<{ state: string; publicIp?: string }> {
  const result = await ec2Client.send(
    new DescribeInstancesCommand({ InstanceIds: [EC2_INSTANCE_ID] }),
  );
  const instance = result.Reservations?.[0]?.Instances?.[0];
  return {
    state: instance?.State?.Name || 'unknown',
    publicIp: instance?.PublicIpAddress,
  };
}

app.get('/api/ec2/status', async (c) => {
  const { state, publicIp } = await getInstanceState();

  // Check daemon heartbeat from EC2 specifically
  const heartbeat = await agentJobsRepo.getJobById('DAEMON_HEARTBEAT');
  const ageMs = heartbeat?.updatedAt
    ? Date.now() - new Date(heartbeat.updatedAt).getTime()
    : Infinity;
  const daemonAlive = ageMs < 10_000;
  const daemonSource = (heartbeat as { source?: string } | null)?.source || null;

  const hb = heartbeat as Record<string, unknown> | null;
  return c.json({
    instanceId: EC2_INSTANCE_ID,
    state,
    publicIp,
    daemonAlive,
    daemonSource,
    lastHeartbeat: heartbeat?.updatedAt || null,
    activeCount: (hb?.activeCount as number) ?? 0,
    maxConcurrent: (hb?.maxConcurrent as number) ?? 0,
    processes: (hb?.processes as unknown[]) ?? [],
    system: (hb?.system as Record<string, unknown>) ?? null,
    auth: (hb?.auth as Record<string, unknown>) ?? null,
  });
});

app.post('/api/ec2/enable', async (c) => {
  const { state } = await getInstanceState();

  if (state === 'stopped') {
    await ec2Client.send(new StartInstancesCommand({ InstanceIds: [EC2_INSTANCE_ID] }));
    return c.json({
      state: 'starting',
      message:
        'Instance starting. Poll /api/ec2/status for running state, then call /api/ec2/start-daemon.',
    });
  }

  if (state === 'running') {
    return c.json({
      state: 'running',
      message: 'Instance already running. Call /api/ec2/start-daemon next.',
    });
  }

  return c.json(
    { state, message: `Instance in transitional state (${state}). Wait and retry.` },
    409,
  );
});

app.post('/api/ec2/start-daemon', async (c) => {
  const { state } = await getInstanceState();
  if (state !== 'running') {
    return c.json(
      { error: { code: 'NOT_RUNNING', message: `Instance is ${state}, not running` } },
      400,
    );
  }

  // Pull latest daemon code from S3 (in case it was updated) then start the service.
  // Syncs agent-daemon.mjs + the full daemon/ tree (pipelines, forwarder, receiver,
  // scripts) so any pipeline change deployed via `aws s3 cp` reaches EC2 on restart.
  const bootstrap = [
    'cd /opt/futurator-daemon',
    'sudo aws s3 cp s3://futurator-admin-production-adminsiteassetsbucket-czucfmdf/develope-it/daemon/agent-daemon.mjs ./agent-daemon.mjs',
    'sudo aws s3 sync s3://futurator-admin-production-adminsiteassetsbucket-czucfmdf/develope-it/daemon/pipelines/ ./pipelines/ --exclude "__tests__/*"',
    'sudo aws s3 sync s3://futurator-admin-production-adminsiteassetsbucket-czucfmdf/develope-it/daemon/forwarder/ ./forwarder/',
    'sudo aws s3 sync s3://futurator-admin-production-adminsiteassetsbucket-czucfmdf/develope-it/daemon/receiver/ ./receiver/',
    'sudo chown -R ubuntu:ubuntu ./agent-daemon.mjs ./pipelines ./forwarder ./receiver',
    'sudo systemctl restart futurator-daemon',
    'sleep 2',
    'sudo systemctl is-active futurator-daemon',
  ].join(' && ');

  // After a fresh boot the EC2 reports state=running before the SSM Agent has
  // registered with the SSM service (~60–90s gap). SendCommand throws
  // `InvalidInstanceId: Instances not in a valid state for account` during
  // that window. Surface this as a typed 503 so the client can keep polling
  // instead of treating it as a fatal "Internal server error."
  try {
    const commandId = await sendSsmCommand(bootstrap);
    return c.json({ commandId, message: 'Daemon start command sent' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    const isSsmNotReady =
      name === 'InvalidInstanceId' ||
      /not in a valid state/i.test(msg) ||
      /InvalidInstanceId/i.test(msg);
    if (isSsmNotReady) {
      return c.json(
        {
          error: {
            code: 'SSM_NOT_READY',
            message:
              'SSM agent on EC2 has not registered yet — typical 60–90s after instance start. Retry shortly.',
          },
        },
        503,
      );
    }
    throw err;
  }
});

// OAuth is handled entirely by the operator's Mac → Keychain → SSM Run Command
// pipeline (see scripts/mac-oauth-sync.sh and scripts/mac-oauth-server.mjs).
// The admin UI's Re-authorize button hits http://127.0.0.1:9876/sync on the
// operator's laptop, not the API Lambda — there is nothing API-key-related
// for this Lambda to do.

app.post('/api/ec2/disable', async (c) => {
  const { state } = await getInstanceState();

  if (state === 'running') {
    // Stop the daemon service first, then stop the instance
    try {
      await sendSsmCommand('sudo systemctl stop futurator-daemon');
    } catch (err) {
      console.error('SSM stop daemon failed:', err);
    }
    await ec2Client.send(new StopInstancesCommand({ InstanceIds: [EC2_INSTANCE_ID] }));
    return c.json({
      state: 'stopping',
      message: 'EC2 disabled — daemon stopped, instance stopping.',
    });
  }

  if (state === 'stopped') {
    return c.json({ state: 'stopped', message: 'Instance already stopped' });
  }

  return c.json({ state, message: `Instance in transitional state (${state})` });
});

// ── EC2 File Browser ──

async function waitForSsmOutput(commandId: string, timeout = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: EC2_INSTANCE_ID,
        }),
      );
      if (result.Status === 'Success') return result.StandardOutputContent || '';
      if (
        result.Status === 'Failed' ||
        result.Status === 'Cancelled' ||
        result.Status === 'TimedOut'
      ) {
        throw new AppError(
          'SSM_FAILED',
          result.StandardErrorContent || `Command ${result.Status}`,
          502,
        );
      }
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      // InvocationDoesNotExist means the command hasn't been received yet — retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new AppError('SSM_TIMEOUT', 'SSM command timed out', 504);
}

// Delete a folder under /home/ubuntu/projects/ OR /home/ubuntu/.claude/projects/.
// Hard-restricted to those namespaces so the endpoint can never become an
// arbitrary rm -rf gun.
//
// Path A — /home/ubuntu/projects/<name>: full cascade. Removes the EC2
// folder AND its matching ~/.claude/projects/-home-ubuntu-projects-<name>
// transcript folder (otherwise transcripts accumulate as orphans —
// investigated 2026-04-18, 17 orphans = 40 MB). Also cascades to AWS:
// matching epic-workflow rows, agent-job rows, project-registry entry, and
// S3 apps/<name>/ artifacts in futurator-ai-website, so a single delete
// leaves no dangling references.
//
// Path B — /home/ubuntu/.claude/projects/<session-folder>: just removes that
// Claude Code transcript folder. No AWS cascade.
app.delete('/api/ec2/files', async (c) => {
  const { state } = await getInstanceState();
  if (state !== 'running') {
    throw new AppError('EC2_NOT_RUNNING', `EC2 instance is ${state}`, 400);
  }

  const path = c.req.query('path') || '';
  const PROJECT_FOLDER_RE = /^\/home\/ubuntu\/projects\/([\w.\-]+)$/;
  const CLAUDE_SESSION_RE = /^\/home\/ubuntu\/\.claude\/projects\/([\w.\-]+)$/;

  const projectMatch = PROJECT_FOLDER_RE.exec(path);
  const claudeMatch = CLAUDE_SESSION_RE.exec(path);

  if (!projectMatch && !claudeMatch) {
    throw new ValidationError(
      'Path must be /home/ubuntu/projects/<name> or /home/ubuntu/.claude/projects/<name> with safe characters only',
    );
  }
  const name = (projectMatch?.[1] ?? claudeMatch?.[1]) || '';
  if (name === '.' || name === '..' || name === '') {
    throw new ValidationError('Invalid folder name');
  }

  // ── Path B: Claude Code transcript folder — simple rm, no cascade.
  if (claudeMatch) {
    const cmd = [
      `target=$(realpath "${path}" 2>/dev/null)`,
      `case "$target" in /home/ubuntu/.claude/projects/*) ;; *) echo "REFUSED: realpath outside .claude/projects/"; exit 1;; esac`,
      `case "$target" in /home/ubuntu/.claude/projects) echo "REFUSED: would delete .claude/projects root"; exit 1;; esac`,
      `rm -rf "$target"`,
      `echo "DELETED $target"`,
    ].join('\n');

    const commandId = await sendSsmCommand(cmd);
    const output = await waitForSsmOutput(commandId);

    if (!output.includes(`DELETED ${path}`)) {
      throw new AppError('DELETE_FAILED', `Delete refused: ${output.slice(0, 300)}`, 400);
    }

    return c.json({
      ok: true,
      path,
      kind: 'claude-session' as const,
      output: output.trim(),
      results: [{ step: 'ec2-filesystem', status: 'done', detail: path }],
    });
  }

  // ── Path A: project folder — full EC2 + AWS cascade.
  // Claude CLI encodes the cwd as the transcript folder name with `/` → `-`.
  // So /home/ubuntu/projects/foo becomes -home-ubuntu-projects-foo.
  const transcriptDir = `/home/ubuntu/.claude/projects/-home-ubuntu-projects-${name}`;

  const results: { step: string; status: string; detail?: string }[] = [];

  // 1. Find matching epic(s) — convention: epic.workingDir ends in /<name>.
  // There can be more than one if an epic was re-created with the same app
  // name; delete them all so no stale rows survive.
  let matchingEpics: EpicWorkflow[] = [];
  try {
    const allEpics = await epicRepo.getAllEpics();
    matchingEpics = allEpics.filter((e) => {
      const epicAppName = e.workingDir?.split('/').filter(Boolean).pop() || '';
      return epicAppName === name;
    });
    results.push({
      step: 'epics-lookup',
      status: 'done',
      detail: `${matchingEpics.length} epic(s) matched`,
    });
  } catch (err: unknown) {
    results.push({
      step: 'epics-lookup',
      status: 'error',
      detail: String((err as Error)?.message ?? err),
    });
  }

  // 2. Delete agent jobs attached to those epics.
  const jobIds: string[] = [];
  for (const epic of matchingEpics) {
    for (const story of epic.stories || []) {
      if (story.jobId) jobIds.push(story.jobId);
    }
    if (epic.qaJobId) jobIds.push(epic.qaJobId);
    if (epic.poJobId) jobIds.push(epic.poJobId);
    if (epic.deployJobId) jobIds.push(epic.deployJobId);
    if (epic.orchestratorJobId) jobIds.push(epic.orchestratorJobId);
    if (epic.waveBuildJobs) {
      for (const jobId of Object.values(epic.waveBuildJobs)) jobIds.push(jobId);
    }
  }
  if (jobIds.length > 0) {
    let jobsDeleted = 0;
    await Promise.all(
      jobIds.map(async (jobId) => {
        try {
          await agentJobsRepo.deleteJob(jobId);
          jobsDeleted++;
        } catch {
          /* job may already be gone */
        }
      }),
    );
    results.push({
      step: 'agent-jobs',
      status: 'done',
      detail: `${jobsDeleted}/${jobIds.length} jobs`,
    });
  } else {
    results.push({ step: 'agent-jobs', status: 'skipped', detail: 'no jobs' });
  }

  // 3. Delete S3 deployed artifacts at apps/<name>/ (best-effort).
  try {
    const s3 = new S3Client({ region: 'us-east-1' });
    const prefix = `apps/${name}/`;
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: 'futurator-ai-website', Prefix: prefix }),
    );
    const objects = list.Contents?.map((o) => ({ Key: o.Key! })) || [];
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: 'futurator-ai-website',
          Delete: { Objects: objects },
        }),
      );
      results.push({ step: 's3-artifacts', status: 'done', detail: `${objects.length} files` });
    } else {
      results.push({ step: 's3-artifacts', status: 'skipped', detail: 'no artifacts' });
    }
  } catch (err: unknown) {
    results.push({
      step: 's3-artifacts',
      status: 'error',
      detail: String((err as Error)?.message ?? err),
    });
  }

  // 4. Delete EC2 folder + cascade .claude transcripts via SSM.
  // Belt-and-suspenders: realpath both targets and refuse anything that
  // escapes its expected namespace (defends against symlink shenanigans).
  // Transcript cleanup is best-effort: missing folder does NOT fail the call.
  // NOTE: join with '\n' (not '; ') — `if ...; then;` is a shell syntax error
  // because `then`/`else` must be followed by a command, not a semicolon.
  const cmd = [
    `target=$(realpath "${path}" 2>/dev/null)`,
    `case "$target" in /home/ubuntu/projects/*) ;; *) echo "REFUSED: realpath outside projects/"; exit 1;; esac`,
    `case "$target" in /home/ubuntu/projects) echo "REFUSED: would delete projects root"; exit 1;; esac`,
    `rm -rf "$target"`,
    `echo "DELETED $target"`,
    `if [ -d "${transcriptDir}" ]; then`,
    `  trans_real=$(realpath "${transcriptDir}" 2>/dev/null)`,
    `  case "$trans_real" in /home/ubuntu/.claude/projects/-home-ubuntu-projects-*) rm -rf "$trans_real" && echo "DELETED $trans_real" ;; *) echo "SKIP transcript (unexpected realpath: $trans_real)" ;; esac`,
    `else`,
    `  echo "SKIP no transcript at ${transcriptDir}"`,
    `fi`,
  ].join('\n');

  let transcriptDeleted = false;
  try {
    const commandId = await sendSsmCommand(cmd);
    const output = await waitForSsmOutput(commandId);
    if (!output.includes(`DELETED ${path}`)) {
      throw new AppError('DELETE_FAILED', `Delete refused: ${output.slice(0, 300)}`, 400);
    }
    transcriptDeleted = output.includes(
      `DELETED /home/ubuntu/.claude/projects/-home-ubuntu-projects-${name}`,
    );
    results.push({ step: 'ec2-filesystem', status: 'done', detail: output.trim() });
  } catch (err: unknown) {
    if (err instanceof AppError) throw err; // surface hard-refusals as HTTP error
    results.push({
      step: 'ec2-filesystem',
      status: 'error',
      detail: String((err as Error)?.message ?? err),
    });
  }

  // 5. Delete project-registry row (best-effort — may not exist yet).
  try {
    await registryRepo.deleteProject(name);
    results.push({ step: 'project-registry', status: 'done' });
  } catch {
    results.push({ step: 'project-registry', status: 'skipped' });
  }

  // 6. Delete party-sessions for this project, then the party-projects row
  // itself. The Labs project picker reads from partyProjects, so if we skip
  // this step the deleted project keeps appearing in the dropdown.
  try {
    const sessionsDeleted = await partySessionsRepo.deleteSessionsByProject(name);
    results.push({
      step: 'party-sessions',
      status: 'done',
      detail: `${sessionsDeleted} sessions`,
    });
  } catch (err: unknown) {
    results.push({
      step: 'party-sessions',
      status: 'error',
      detail: String((err as Error)?.message ?? err),
    });
  }
  try {
    await partyProjectsRepo.deleteProject(name);
    results.push({ step: 'party-projects', status: 'done' });
  } catch {
    results.push({ step: 'party-projects', status: 'skipped' });
  }

  // 7. Delete the matching epic row(s) last.
  let epicsDeleted = 0;
  for (const epic of matchingEpics) {
    try {
      await epicRepo.deleteEpic(epic.epicId);
      epicsDeleted++;
    } catch {
      /* best-effort */
    }
  }
  results.push({
    step: 'epic-records',
    status: matchingEpics.length === 0 ? 'skipped' : 'done',
    detail: `${epicsDeleted}/${matchingEpics.length}`,
  });

  return c.json({
    ok: true,
    path,
    kind: 'project' as const,
    transcriptDir,
    transcriptDeleted,
    results,
  });
});

// Defense in depth: every browseable path must live under /home/ubuntu so the
// SSM-backed file endpoints can never be coerced into reading /etc, /root,
// instance-metadata mount points, etc. The regex on top of this rejects shell
// metacharacters and traversal segments.
const EC2_BROWSE_ROOT = '/home/ubuntu';

function assertSafeEc2Path(p: string): void {
  if (!/^\/[\w/.\-]+$/.test(p)) throw new ValidationError('Invalid path');
  if (p.includes('..')) throw new ValidationError('Invalid path');
  if (p !== EC2_BROWSE_ROOT && !p.startsWith(`${EC2_BROWSE_ROOT}/`)) {
    throw new ValidationError(`Path must be under ${EC2_BROWSE_ROOT}`);
  }
}

app.get('/api/ec2/files', authMiddleware, async (c) => {
  const { state } = await getInstanceState();
  if (state !== 'running') {
    throw new AppError('EC2_NOT_RUNNING', `EC2 instance is ${state}`, 400);
  }

  const dirPath = c.req.query('path') || EC2_BROWSE_ROOT;
  assertSafeEc2Path(dirPath);

  // ls -p appends / to directories, --group-directories-first for easier parsing
  const cmd = `ls -lAp --group-directories-first --time-style=long-iso "${dirPath}" 2>&1 || echo "__LS_ERROR__"`;
  const commandId = await sendSsmCommand(cmd);
  const output = await waitForSsmOutput(commandId);

  if (output.includes('__LS_ERROR__') || output.includes('No such file or directory')) {
    throw new NotFoundError('Directory', dirPath);
  }

  const lines = output.split('\n').filter((l) => l.trim() && !l.startsWith('total '));
  const entries = lines
    .map((line) => {
      // Parse ls -lAp --time-style=long-iso output:
      // drwxr-xr-x 2 ubuntu ubuntu 4096 2025-01-15 10:30 dirname/
      // -rw-r--r-- 1 ubuntu ubuntu  123 2025-01-15 10:30 file.txt
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) return null;
      const permissions = parts[0];
      const size = parseInt(parts[4], 10);
      const date = parts[5];
      const time = parts[6];
      const name = parts.slice(7).join(' ');
      const isDir = name.endsWith('/');
      return {
        name: isDir ? name.slice(0, -1) : name,
        type: isDir ? ('directory' as const) : ('file' as const),
        size,
        permissions,
        modified: `${date} ${time}`,
      };
    })
    .filter(Boolean);

  return c.json({ path: dirPath, entries });
});

// Read a single file under /home/ubuntu. Returns text inline for editor
// rendering or base64 for images / binary so the UI can build a data: URL or
// trigger a download. Hard-capped at 2 MB — bigger files come back with
// `tooLarge: true` so the frontend can offer a download instead of choking the
// browser.
const EC2_FILE_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'md',
  'mdx',
  'txt',
  'log',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'html',
  'htm',
  'xml',
  'svg',
  'css',
  'scss',
  'sass',
  'less',
  'sh',
  'bash',
  'zsh',
  'fish',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'swift',
  'kt',
  'sql',
  'graphql',
  'gql',
  'gitignore',
  'dockerignore',
  'dockerfile',
  'editorconfig',
  'prettierrc',
]);
const IMAGE_EXTS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  // image/vnd.microsoft.icon is the IANA-registered MIME and is decoded by
  // every modern browser when fed via blob URL. The legacy image/x-icon was
  // unreliable in Chrome data-URL flows.
  ico: 'image/vnd.microsoft.icon',
  // svg is intentionally classified as text so it lands in the code editor by
  // default; the viewer offers a Source/Preview toggle for it.
};
const PDF_MIME = 'application/pdf';

function classifyFile(
  name: string,
):
  | { kind: 'text'; mime: string }
  | { kind: 'image'; mime: string }
  | { kind: 'pdf'; mime: string }
  | { kind: 'binary'; mime: string } {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop()! : lower;
  if (ext === 'pdf') return { kind: 'pdf', mime: PDF_MIME };
  if (IMAGE_EXTS[ext]) return { kind: 'image', mime: IMAGE_EXTS[ext] };
  if (TEXT_EXTS.has(ext)) return { kind: 'text', mime: 'text/plain' };
  // Files with no extension (LICENSE, README, Makefile, Dockerfile) are
  // overwhelmingly text — try them as text and let the frontend deal with
  // any decode failures.
  if (!lower.includes('.')) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'binary', mime: 'application/octet-stream' };
}

app.get('/api/ec2/files/content', authMiddleware, async (c) => {
  const { state } = await getInstanceState();
  if (state !== 'running') {
    throw new AppError('EC2_NOT_RUNNING', `EC2 instance is ${state}`, 400);
  }

  const filePath = c.req.query('path');
  if (!filePath) throw new ValidationError('query param ?path= is required');
  assertSafeEc2Path(filePath);

  const name = filePath.split('/').pop() || '';
  const classified = classifyFile(name);

  // Single SSM round-trip: validate, stat, optionally base64. The sentinel
  // tokens let us distinguish "not a file", "too large", and "ok" without
  // having to issue separate commands.
  const script = [
    `f="${filePath}"`,
    'if [ ! -e "$f" ]; then echo "__NOT_FOUND__"; exit 0; fi',
    'if [ ! -f "$f" ]; then echo "__NOT_FILE__"; exit 0; fi',
    'sz=$(stat -c%s "$f")',
    'mt=$(stat -c%Y "$f")',
    `if [ "$sz" -gt ${EC2_FILE_MAX_BYTES} ]; then echo "__TOO_LARGE__:$sz:$mt"; exit 0; fi`,
    'echo "__META__:$sz:$mt"',
    'echo "__CONTENT_START__"',
    'base64 -w0 "$f"',
    'echo',
  ].join('\n');

  const commandId = await sendSsmCommand(script);
  const raw = await waitForSsmOutput(commandId);
  const output = raw.trimEnd();

  if (output.startsWith('__NOT_FOUND__')) throw new NotFoundError('File', filePath);
  if (output.startsWith('__NOT_FILE__')) {
    throw new ValidationError('Path is not a regular file');
  }

  if (output.startsWith('__TOO_LARGE__')) {
    const [, sz, mt] = output.split('\n')[0].split(':');
    return c.json({
      tooLarge: true,
      size: Number(sz),
      mtime: Number(mt) * 1000,
      kind: classified.kind,
      mime: classified.mime,
      maxBytes: EC2_FILE_MAX_BYTES,
    });
  }

  const lines = output.split('\n');
  const metaLine = lines.find((l) => l.startsWith('__META__:'));
  const startIdx = lines.findIndex((l) => l === '__CONTENT_START__');
  if (!metaLine || startIdx === -1) {
    throw new AppError('SSM_PARSE', 'Unexpected SSM output format', 502);
  }
  const [, szStr, mtStr] = metaLine.split(':');
  const size = Number(szStr);
  const mtime = Number(mtStr) * 1000;
  const base64 = lines
    .slice(startIdx + 1)
    .join('')
    .trim();

  if (classified.kind === 'text') {
    let content: string;
    try {
      content = Buffer.from(base64, 'base64').toString('utf-8');
    } catch {
      // Fall through and return as binary so the frontend can offer a download.
      return c.json({
        kind: 'binary' as const,
        mime: 'application/octet-stream',
        size,
        mtime,
        base64,
      });
    }
    return c.json({ kind: 'text' as const, mime: classified.mime, size, mtime, content });
  }

  return c.json({ kind: classified.kind, mime: classified.mime, size, mtime, base64 });
});

// ── EC2 Metrics (CloudWatch) ──
app.get('/api/ec2/metrics', async (c) => {
  const range = c.req.query('range') || '1h'; // 1h, 3h, 6h, 24h
  const rangeMs: Record<string, number> = {
    '1h': 3600_000,
    '3h': 10800_000,
    '6h': 21600_000,
    '24h': 86400_000,
  };
  const ms = rangeMs[range] || rangeMs['1h'];
  const now = new Date();
  const start = new Date(now.getTime() - ms);
  const period = ms <= 3600_000 ? 300 : ms <= 21600_000 ? 600 : 1800; // 5m, 10m, or 30m

  const resp = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: now,
      MetricDataQueries: [
        {
          Id: 'cpu',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/EC2',
              MetricName: 'CPUUtilization',
              Dimensions: [{ Name: 'InstanceId', Value: EC2_INSTANCE_ID }],
            },
            Period: period,
            Stat: 'Average',
          },
        },
        {
          Id: 'mem',
          MetricStat: {
            Metric: {
              Namespace: 'Futurator/EC2',
              MetricName: 'mem_used_percent',
              Dimensions: [{ Name: 'InstanceId', Value: EC2_INSTANCE_ID }],
            },
            Period: period,
            Stat: 'Average',
          },
        },
        {
          Id: 'disk',
          MetricStat: {
            Metric: {
              Namespace: 'Futurator/EC2',
              MetricName: 'disk_used_percent',
              Dimensions: [
                { Name: 'InstanceId', Value: EC2_INSTANCE_ID },
                { Name: 'path', Value: '/' },
                { Name: 'device', Value: 'xvda1' },
                { Name: 'fstype', Value: 'ext4' },
              ],
            },
            Period: period,
            Stat: 'Average',
          },
        },
        {
          Id: 'netin',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/EC2',
              MetricName: 'NetworkIn',
              Dimensions: [{ Name: 'InstanceId', Value: EC2_INSTANCE_ID }],
            },
            Period: period,
            Stat: 'Sum',
          },
        },
        {
          Id: 'netout',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/EC2',
              MetricName: 'NetworkOut',
              Dimensions: [{ Name: 'InstanceId', Value: EC2_INSTANCE_ID }],
            },
            Period: period,
            Stat: 'Sum',
          },
        },
      ],
    }),
  );

  const metrics: Record<string, { timestamps: string[]; values: number[] }> = {};
  for (const r of resp.MetricDataResults || []) {
    const ts = r.Timestamps || [];
    const vals = r.Values || [];
    // CloudWatch returns in reverse chronological — sort ascending
    const pairs = ts
      .map((t, i) => ({ t: t!.toISOString(), v: vals[i] }))
      .sort((a, b) => a.t.localeCompare(b.t));
    metrics[r.Id || 'unknown'] = {
      timestamps: pairs.map((p) => p.t),
      values: pairs.map((p) => p.v),
    };
  }

  return c.json({ range, period, instanceId: EC2_INSTANCE_ID, metrics });
});

// On-demand snapshot via SSM
app.get('/api/ec2/snapshot', async (c) => {
  const { state } = await getInstanceState();
  if (state !== 'running') {
    return c.json({ state, snapshot: null });
  }

  const cmdId = await sendSsmCommand(
    'echo "===CPU==="; top -bn1 | head -5; echo "===MEM==="; free -m | grep -E "Mem|Swap"; echo "===DISK==="; df -h / | tail -1; echo "===PROCS==="; ps aux --sort=-%mem | head -8; echo "===CLAUDE==="; ps aux | grep claude | grep -v grep | wc -l; echo "===DAEMON==="; systemctl is-active futurator-daemon; echo "===UPTIME==="; uptime -s',
  );

  // Wait for result (up to 10s)
  let output = '';
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const inv = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: cmdId,
          InstanceId: EC2_INSTANCE_ID,
        }),
      );
      if (inv.Status === 'Success') {
        output = inv.StandardOutputContent || '';
        break;
      }
      if (inv.Status === 'Failed') {
        output = inv.StandardErrorContent || 'Command failed';
        break;
      }
    } catch {
      /* still pending */
    }
  }

  // Parse sections
  const section = (tag: string) => {
    const match = output.match(new RegExp(`===${tag}===\\n([\\s\\S]*?)(?====|$)`));
    return match?.[1]?.trim() || '';
  };

  return c.json({
    state,
    snapshot: {
      cpu: section('CPU'),
      memory: section('MEM'),
      disk: section('DISK'),
      topProcesses: section('PROCS'),
      claudeProcesses: parseInt(section('CLAUDE')) || 0,
      daemonStatus: section('DAEMON'),
      uptimeSince: section('UPTIME'),
    },
  });
});

// ── Deploy Agent: Build and publish app to S3 → futurator.ai/apps/{appName} ──
app.post('/api/epic-workflows/:id/deploy', async (c) => {
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  // Derive app name from working directory (last segment)
  const appName = epic.workingDir.split('/').filter(Boolean).pop() || 'app';
  const publicUrl = `https://futurator.ai/apps/${appName}/`;
  const s3Path = `apps/${appName}`;

  const deployPipeline: PipelineDefinition = {
    maxIterations: 1,
    agents: {
      DEPLOY: {
        name: 'DevOps Deploy',
        // Edit + Write are required because vite.config.ts usually needs a
        // base path patch before `npm run build` can produce a correctly-
        // prefixed bundle. Without these the agent halts asking for approval.
        allowedTools: 'Bash,Read,Edit,Write,Glob',
        model: 'haiku',
      },
    },
    steps: [
      {
        id: 'deploy',
        agentId: 'DEPLOY',
        prompt: `You are a headless DevOps automation. You run non-interactively — there is NO human to grant permission. Do not ask for confirmation. Do not suggest commands for a human to run. Use the tools directly.

Goal: build and publish the React/Vite app at ${epic.workingDir} to s3://futurator-ai-website/${s3Path}/ so it is reachable at ${publicUrl}.

Steps (execute in order, each step must succeed before the next):

1. Read ${epic.workingDir}/vite.config.ts (or .js). If it does not contain \`base: '/apps/${appName}/'\`, Edit the file to add that entry inside defineConfig({ ... }). Do this BEFORE building.

2. Run the build: \`cd ${epic.workingDir} && npm run build\`. If build fails because of missing deps, run \`npm install\` and retry the build once. Do not proceed past this step unless the build succeeds.

3. Identify the build output directory (Vite defaults to \`dist\`, but check the build log). Confirm it exists with \`ls\`.

4. Sync to S3: \`aws s3 sync <outputDir>/ s3://futurator-ai-website/${s3Path}/ --delete\`

5. Invalidate CloudFront: \`aws cloudfront create-invalidation --distribution-id E1BI1YWMTLSDTE --paths "/apps/${appName}/*"\`

When finished, output these three lines EXACTLY — they are machine-parsed:

DEPLOY_URL: ${publicUrl}
DEPLOY_STATUS: success
DEPLOY_DETAILS: <one-sentence summary of what you did>

If ANY step above failed and you cannot recover, instead output:

DEPLOY_URL: ${publicUrl}
DEPLOY_STATUS: failed
DEPLOY_DETAILS: <which step failed and why>

Never end the session without emitting a DEPLOY_STATUS line. Never ask for permission.`,
        extractors: {
          // Tolerant to markdown decoration the agent sometimes applies
          // despite the "plain text" instruction (the dev-server agent did
          // exactly this on 2026-04-21 with `**DEV_SERVER_URL:**`).
          DEPLOY_URL: {
            type: 'regex',
            pattern: '[*_`]*DEPLOY_URL[*_`]*:\\s*[*_`]*\\s*(https?://[^\\s*_`]+)',
          },
          DEPLOY_STATUS: {
            type: 'regex',
            pattern: '[*_`]*DEPLOY_STATUS[*_`]*:\\s*[*_`]*\\s*(\\w+)',
          },
          DEPLOY_DETAILS: {
            type: 'regex',
            pattern: '[*_`]*DEPLOY_DETAILS[*_`]*:\\s*[*_`]*\\s*(.+)',
          },
        },
        validations: [
          { type: 'equals', left: 'DEPLOY_STATUS', right: 'success', label: 'Deploy succeeded' },
        ],
      },
    ],
  };

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: epic.workingDir,
    pipeline: deployPipeline,
  });

  // Persist on the epic (latest deploy) AND append to plan.deployJobIds so
  // the Deploy report can render history. Legacy plans without the field
  // are seeded with the current job as their first history entry.
  await epicRepo.updateEpicFields(epicId, { deployJobId: jobId });
  if (epic.planId) {
    const plan = await planRepo.getPlanById(epic.planId);
    if (plan) {
      const history = plan.deployJobIds ?? [];
      if (!history.includes(jobId)) {
        await planRepo.updatePlanFields(plan.planId, {
          deployJobIds: [...history, jobId],
        });
      }
    }
  }

  // Ensure project registry exists with deploy URL
  const existing = await registryRepo.getProject(appName);
  if (existing) {
    await registryRepo.updateProjectFields(appName, {
      deployUrl: publicUrl,
      currentStatus: 'published',
    });
  } else {
    await registryRepo.createProject({
      projectId: appName,
      name: epic.title,
      ec2Path: epic.workingDir,
      epics: [epic.epicId],
      currentStatus: 'published',
      deployUrl: publicUrl,
      sessions: {},
      fileManifest: {},
      createdAt: now,
      updatedAt: now,
    });
  }

  return c.json({ jobId, appName, publicUrl }, 201);
});

// ── Project Registry: get project details ──
app.get('/api/projects/:projectId/registry', async (c) => {
  const projectId = c.req.param('projectId');
  const project = await registryRepo.getProject(projectId);
  if (!project) throw new NotFoundError('ProjectRegistry', projectId);
  return c.json(project);
});

// ── Bug Report: create a fix pipeline for an existing project ──
app.post('/api/projects/:projectId/bug-report', async (c) => {
  const projectId = c.req.param('projectId');
  const user = c.get('user');
  const { description } = (await c.req.json()) as { description: string };

  if (!description?.trim()) throw new ValidationError('Bug description is required');

  const project = await registryRepo.getProject(projectId);
  if (!project) throw new NotFoundError('ProjectRegistry', projectId);

  // Get the latest epic for context (preload; result reserved for future use)
  const latestEpicId = project.epics[project.epics.length - 1];
  if (latestEpicId) await epicRepo.getEpicById(latestEpicId);

  // Build context from file manifest and sessions
  const fileList = Object.keys(project.fileManifest).join('\n');
  const sessionDigests = Object.entries(project.sessions)
    .map(([storyId, s]) => `${storyId}: ${s.contextDigest.slice(0, 200)}`)
    .join('\n');

  // Find best session to resume from (most recent)
  const allSessions = Object.values(project.sessions);
  const latestSession = allSessions.sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
  const resumeSessionId = latestSession?.sessionId;

  const bugPipeline: PipelineDefinition = {
    maxIterations: 3,
    agents: {
      DEV: {
        name: 'Bug Fix Developer',
        allowedTools: 'Bash,Read,Edit,Write,Glob,Grep',
        model: 'sonnet',
      },
      REVIEWER: {
        name: 'Bug Fix Reviewer',
        allowedTools: 'Read,Grep,Glob',
        disallowedTools: 'Write,Edit',
        model: 'sonnet',
      },
    },
    steps: [
      // 1. Dev fixes the bug
      {
        id: 'dev',
        agentId: 'DEV',
        prompt: `You are a senior developer fixing a bug in the "${project.name}" project.

## Bug Report:
${description}

## Project Info:
- Working directory: ${project.ec2Path}
- Project files:\n${fileList}

## Context from previous work:
${sessionDigests}

## Instructions:
- Investigate the bug by reading relevant files
- Fix ONLY the bug described. Do not refactor or add features.
- Minimize changes — surgical fix only.
- End with:
---WORK_SUMMARY---
[What you found and fixed]
---END_WORK_SUMMARY---`,
        ...(resumeSessionId && { resumeFromStep: '__external__' }),
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },

      // 2. Build check
      {
        id: 'build-check',
        stepType: 'shell' as const,
        command: `cd ${project.ec2Path} && npm run build 2>&1`,
        timeout: 60000,
        captureAs: 'BUILD_OUTPUT',
        captureStderrAs: 'BUILD_OUTPUT',
        onFail: {
          action: 'retry_step' as const,
          targetStep: 'dev-build-fix',
          injectAs: 'BUILD_ERROR',
        },
        loopTo: 'dev-build-fix',
      },

      // 3. Build fix (loop-only)
      {
        id: 'dev-build-fix',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `The build failed after your bug fix. Error:\n\n{{BUILD_ERROR}}\n\nFix the build error.\n---WORK_SUMMARY---\n[What you fixed]\n---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },

      // 4. Server check
      {
        id: 'server-check',
        stepType: 'shell' as const,
        command: `kill $(lsof -ti:5173) 2>/dev/null; sleep 1; cd ${project.ec2Path} && (npm run dev -- --host 0.0.0.0 &) && STATUS=000; for i in $(seq 1 15); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null); [ "$STATUS" = "200" ] && break; done; kill $(lsof -ti:5173) 2>/dev/null; [ "$STATUS" = "200" ]`,
        timeout: 30000,
        captureAs: 'SERVER_OUTPUT',
        captureStderrAs: 'SERVER_ERROR',
        onFail: {
          action: 'retry_step' as const,
          targetStep: 'dev-server-fix',
          injectAs: 'SERVER_ERROR',
        },
        loopTo: 'dev-server-fix',
      },

      // 5. Server fix (loop-only)
      {
        id: 'dev-server-fix',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `The dev server failed after your fix. Error:\n\n{{SERVER_ERROR}}\n\nFix the issue.\n---WORK_SUMMARY---\n[What you fixed]\n---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },

      // 6. Review
      {
        id: 'review',
        agentId: 'REVIEWER',
        prompt: `Review the bug fix for "${project.name}" at ${project.ec2Path}.

## Original Bug Report:
${description}

## Developer's Fix Summary:
{{WORK_SUMMARY}}

## Review:
1. Does the fix address the bug described?
2. Is it minimal and surgical (no scope creep)?
3. Does it introduce any new issues?

Output: VERDICT: PASS or VERDICT: FAIL
Then: FEEDBACK: [findings]`,
        extractors: {
          VERDICT: { type: 'regex', pattern: 'VERDICT:\\s*\\*{0,2}(PASS|FAIL)\\*{0,2}' },
          FEEDBACK: { type: 'regex', pattern: 'FEEDBACK:\\s*([\\s\\S]+?)$' },
        },
        validations: [
          { type: 'equals', left: 'VERDICT', right: 'PASS', label: 'Bug fix approved' },
        ],
        loopTo: 'retry',
      },

      // 7. Retry (loop-only)
      {
        id: 'retry',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `Reviewer feedback on your bug fix:\n\nFeedback: {{FEEDBACK}}\nVerdict: {{VERDICT}}\n\nFix the issues.\n---WORK_SUMMARY---\n[Updated changes]\n---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },
    ],
  };

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: project.ec2Path,
    pipeline: bugPipeline,
  });

  return c.json({ jobId, projectId }, 201);
});

// ── Feature Request: create new stories for an existing project ──
app.post('/api/projects/:projectId/feature-request', async (c) => {
  const projectId = c.req.param('projectId');
  const user = c.get('user');
  const { description } = (await c.req.json()) as { description: string };

  if (!description?.trim()) throw new ValidationError('Feature description is required');

  const project = await registryRepo.getProject(projectId);
  if (!project) throw new NotFoundError('ProjectRegistry', projectId);

  // Build context from file manifest
  const fileList = Object.keys(project.fileManifest).join('\n');
  const sessionDigests = Object.entries(project.sessions)
    .map(([storyId, s]) => `${storyId}: ${s.contextDigest.slice(0, 200)}`)
    .join('\n');

  // PM generates a delta epic (new stories only)
  const pmPipeline: PipelineDefinition = {
    maxIterations: 1,
    agents: {
      PM: {
        name: 'Product Manager',
        allowedTools: 'Read,Grep,Glob',
        model: 'sonnet',
      },
    },
    steps: [
      {
        id: 'generate_delta',
        agentId: 'PM',
        prompt: `You are a Product Manager planning a new feature for an EXISTING project.

## Project: ${project.name}
## Working directory: ${project.ec2Path}

## Existing files:
${fileList}

## Context from previous work:
${sessionDigests}

## New Feature Request:
${description}

## Instructions:
1. Read the existing code to understand the current project structure
2. Plan ONLY the new/modified stories needed for this feature
3. Do NOT re-scaffold or recreate existing files
4. Reference existing files and components in your stories
5. Keep stories small and focused

Output your delta epic in this EXACT XML format:

<epic>
  <title>Feature: [short title]</title>
  <description>What this feature adds to the existing project</description>
  <testing_profile>
    <has_browser_tests>true or false</has_browser_tests>
    <viewport>800x600</viewport>
    <interaction_model>keyboard</interaction_model>
  </testing_profile>
  <acceptance_criteria>
    <criterion needs_browser="false">Criterion 1</criterion>
  </acceptance_criteria>
  <stories>
    <story id="S1">
      <title>Story title</title>
      <depends_on></depends_on>
      <description>
        As a user, I want...

        Existing files to modify: [list relevant files]

        Acceptance Criteria:
        - [needs_browser=false] Criterion
      </description>
    </story>
  </stories>
</epic>

Output ONLY the XML.`,
        extractors: {
          EPIC_XML: { type: 'between', startDelimiter: '<epic>', endDelimiter: '</epic>' },
        },
        validations: [],
      },
    ],
  };

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: project.ec2Path,
    pipeline: pmPipeline,
  });

  return c.json({ jobId, projectId, workingDir: project.ec2Path }, 201);
});

// ── Apps list (legacy — all epics with computed status) ──
// App/Plan v1 (Story 2.1) reclaims /api/apps for the new Apps namespace.
// This legacy endpoint moves to /api/development/apps to match its consumer
// route at /development/apps. See `agentic-office/index.tsx` and
// `use-epic-workflow.ts` for the consumers.
app.get('/api/development/apps', async (c) => {
  const resp = await epicRepo.getAllEpics();
  const apps = resp.map((e) => {
    let appStatus: 'conceptualized' | 'in_development' | 'deployed';
    if (e.deployUrl) {
      appStatus = 'deployed';
    } else if (
      e.status === 'in_progress' ||
      e.stories.some((s) => s.status === 'running' || s.status === 'done' || s.status === 'failed')
    ) {
      appStatus = 'in_development';
    } else {
      appStatus = 'conceptualized';
    }

    const totalStories = e.stories.length;
    const doneStories = e.stories.filter((s) => s.status === 'done').length;

    return {
      epicId: e.epicId,
      title: e.title,
      appName: e.workingDir.split('/').filter(Boolean).pop() || 'unknown',
      workingDir: e.workingDir,
      appStatus,
      url: e.deployUrl || null,
      deployedAt: e.deployedAt || null,
      totalStories,
      doneStories,
      createdAt: e.createdAt,
    };
  });

  // Sort: deployed first, then in_development, then conceptualized
  const order = { deployed: 0, in_development: 1, conceptualized: 2 };
  apps.sort((a, b) => order[a.appStatus] - order[b.appStatus]);

  return c.json(apps);
});

// ════════════════════════════════════════════════════════════════
// Labs Party Module (Epic 15)
// ════════════════════════════════════════════════════════════════

const PARTY_PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/home/ubuntu/projects';

function resolvePartyProjectPath(projectId: string): string {
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid projectId');
  }
  return `${PARTY_PROJECTS_ROOT}/${parsed.data}`;
}

app.get('/api/party/projects', async (c) => {
  const projects = await partyProjectsRepo.listProjects();
  return c.json({ projects, expectedAgentCount: EXPECTED_AGENT_COUNT });
});

app.get('/api/party/projects/:id', async (c) => {
  const projectId = c.req.param('id');
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid projectId');
  }
  const project = await partyProjectsRepo.getProject(parsed.data);
  if (!project) throw new NotFoundError('PartyProject', parsed.data);
  return c.json(project);
});

/**
 * PATCH project settings — currently just `allowedTools`. Validates each
 * tool name against the toggleable allow-list so we can't accidentally
 * grant something dangerous (Bash, MCP) via this endpoint.
 *
 * Body: { allowedTools: string[] | null }
 *   - Array of tool names → store as-is.
 *   - null → clear the field, falling back to DEFAULT_ALLOWED_TOOLS at
 *     daemon time. Different from [] which means "deny all extras".
 */
app.patch('/api/party/projects/:id', async (c) => {
  const projectId = c.req.param('id');
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid projectId');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    allowedTools?: unknown;
  };

  const project = await partyProjectsRepo.getProject(parsed.data);
  if (!project) throw new NotFoundError('PartyProject', parsed.data);

  const patch: { allowedTools?: string[] } = {};
  if (Object.prototype.hasOwnProperty.call(body, 'allowedTools')) {
    if (body.allowedTools === null) {
      // Clear: store undefined (DDB removes the attribute).
      await partyProjectsRepo.clearProjectAllowedTools(parsed.data);
      const refreshed = await partyProjectsRepo.getProject(parsed.data);
      return c.json(refreshed);
    }
    if (!Array.isArray(body.allowedTools)) {
      throw new ValidationError('allowedTools must be an array of strings or null');
    }
    const allowed = new Set(TOGGLEABLE_TOOLS as readonly string[]);
    const next = (body.allowedTools as unknown[]).map(String);
    for (const t of next) {
      if (!allowed.has(t)) {
        throw new ValidationError(
          `tool "${t}" is not toggleable; allowed values: ${[...allowed].join(', ')}`,
        );
      }
    }
    patch.allowedTools = next;
  }

  if (Object.keys(patch).length === 0) {
    return c.json(project);
  }
  await partyProjectsRepo.updateProjectState(parsed.data, patch);
  const updated = await partyProjectsRepo.getProject(parsed.data);
  return c.json(updated);
});

app.post('/api/party/projects/:id/bootstrap', async (c) => {
  const projectId = c.req.param('id');
  const projectPath = resolvePartyProjectPath(projectId);

  const body = await c.req.json().catch(() => ({}));
  const parsed = bootstrapInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }
  const forceReinstall = parsed.data.forceReinstall === true;
  const createFolder = parsed.data.createFolder === true;

  await partyProjectsRepo.upsertProjectFromFilesystem(projectId, projectPath);

  const jobId = crypto.randomUUID();
  const lock = await partyProjectsRepo.tryAcquireBootstrapLock(projectId, jobId);
  if (!lock.ok) {
    if (lock.reason === 'BOOTSTRAP_IN_PROGRESS') {
      throw new AppError('BOOTSTRAP_IN_PROGRESS', 'Bootstrap already in progress', 409);
    }
    throw new NotFoundError('PartyProject', projectId);
  }

  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user').userId,
    workingDir: projectPath,
    jobType: 'party-bootstrap',
    partyBootstrapPayload: { projectId, projectPath, forceReinstall, createFolder },
  });

  return c.json({ jobId, projectId }, 201);
});

/**
 * Create a brand-new Party project. Accepts BOTH:
 *
 *   - Greenfield (legacy): `{ projectId }` — daemon mkdirs the folder and
 *     runs the full BMAD install + custom-agent injection pipeline.
 *   - Brownfield (Story 15.4): `{ kind: 'brownfield', name, gitRepoUrl,
 *     gitBranch? }` — daemon clones the upstream GitHub repo (via PAT)
 *     into the folder and verifies the cloned repo already has BMAD.
 *
 * The shape is validated through a zod discriminated union on `kind`.
 */
app.post('/api/party/projects', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createPartyProjectInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }

  const input = parsed.data;
  const isBrownfield = input.kind === 'brownfield';
  const projectId = isBrownfield ? input.name : input.projectId;
  const projectPath = resolvePartyProjectPath(projectId);

  if (isBrownfield) {
    // Migrate-module — if the operator supplied a PAT, write it to a
    // per-project Secrets Manager secret BEFORE creating the project row
    // so the bootstrap job can resolve it.
    let patSecretName: string | undefined;
    if (input.pat) {
      patSecretName = brownfieldPatSecretNameFor(projectId);
      await ensureBrownfieldPatSecret(patSecretName, input.pat);
    }

    const created = await partyProjectsRepo.createBrownfieldProjectRow(projectId, projectPath, {
      gitRepoUrl: input.gitRepoUrl,
      gitBranch: input.gitBranch,
      patSecretName,
      envVars: input.envVars,
    });
    if (!created) {
      throw new AppError(
        'PROJECT_ALREADY_EXISTS',
        `Party project "${projectId}" already exists`,
        409,
      );
    }

    // Migrate-module — auto-write an Apps registry row so the brownfield
    // project shows up in /labs Apps, /debates, and is reachable via
    // /labs?appId=<id>&tab=party. Idempotent: if a clashing App already
    // exists we surface a clean 409 so the operator can rename.
    try {
      await appRepo.createApp({
        appId: projectId,
        displayName: input.gitRepoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''),
        icon: '📨',
        executionMode: 'orchestrator',
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'APP_ID_TAKEN') {
        // App already exists with this slug (probably from a prior migration
        // attempt). Acceptable — Party UI will reuse it.
      } else {
        throw err;
      }
    }
  } else {
    await partyProjectsRepo.upsertProjectFromFilesystem(projectId, projectPath);
  }

  const jobId = crypto.randomUUID();
  const lock = await partyProjectsRepo.tryAcquireBootstrapLock(projectId, jobId);
  if (!lock.ok) {
    if (lock.reason === 'BOOTSTRAP_IN_PROGRESS') {
      throw new AppError('BOOTSTRAP_IN_PROGRESS', 'Bootstrap already in progress', 409);
    }
    throw new NotFoundError('PartyProject', projectId);
  }

  const now = new Date().toISOString();
  const partyBootstrapPayload = isBrownfield
    ? {
        projectId,
        projectPath,
        forceReinstall: false,
        createFolder: false,
        kind: 'brownfield' as const,
        gitRepoUrl: input.gitRepoUrl,
        gitBranch: input.gitBranch,
        ...(input.pat ? { patSecretName: brownfieldPatSecretNameFor(projectId) } : {}),
        ...(input.envVars ? { envVars: input.envVars } : {}),
      }
    : {
        projectId,
        projectPath,
        forceReinstall: false,
        createFolder: true,
        kind: 'greenfield' as const,
      };

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user').userId,
    workingDir: projectPath,
    jobType: 'party-bootstrap',
    partyBootstrapPayload,
  });

  return c.json(
    { jobId, projectId, projectPath, kind: isBrownfield ? 'brownfield' : 'greenfield' },
    201,
  );
});

/**
 * Story 15.4 — refresh a brownfield project. Enqueues a party-refresh job
 * which runs `git fetch origin && git reset --hard origin/<branch>` in the
 * project folder, then re-runs the inspector.
 *
 * Errors:
 *   400 INVALID_FOR_GREENFIELD — project.kind === 'greenfield'
 *   404 NotFound                — projectId missing
 *   409 PROJECT_BUSY            — a session for this project has status=PROCESSING
 *   409 REFRESH_IN_PROGRESS     — another refresh already holds the lock
 */
app.post('/api/party/projects/:id/refresh', async (c) => {
  const projectId = c.req.param('id');
  const parsed = refreshProjectParamsSchema.safeParse({ projectId });
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid projectId');
  }

  const project = await partyProjectsRepo.getProject(parsed.data.projectId);
  if (!project) throw new NotFoundError('PartyProject', parsed.data.projectId);
  if (project.kind !== 'brownfield') {
    throw new AppError(
      'INVALID_FOR_GREENFIELD',
      'Refresh is only valid for brownfield Party projects',
      400,
    );
  }
  if (!project.gitBranch) {
    throw new AppError(
      'INVALID_FOR_GREENFIELD',
      'Brownfield project is missing gitBranch — cannot refresh',
      400,
    );
  }

  const sessionBusy = await partySessionsRepo.hasProcessingSession(parsed.data.projectId);
  if (sessionBusy) {
    throw new AppError(
      'PROJECT_BUSY',
      'A session for this project is currently processing a turn',
      409,
    );
  }

  const lock = await partyProjectsRepo.tryAcquireRefreshLock(parsed.data.projectId);
  if (!lock.ok) {
    if (lock.reason === 'REFRESH_IN_PROGRESS') {
      throw new AppError('REFRESH_IN_PROGRESS', 'Refresh already in progress', 409);
    }
    if (lock.reason === 'NOT_FOUND') {
      throw new NotFoundError('PartyProject', parsed.data.projectId);
    }
    throw new AppError(
      'INVALID_STATE',
      `Cannot refresh from current state: ${project.bmadStatus}`,
      409,
    );
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user').userId,
    workingDir: project.path,
    jobType: 'party-refresh',
    partyRefreshPayload: {
      projectId: parsed.data.projectId,
      projectPath: project.path,
      gitBranch: project.gitBranch,
      // Migrate-module — thread env vars so the daemon re-syncs .env
      // after the git reset. Refresh is the moment the operator's
      // PATCH'd env-var updates take effect on disk.
      ...(project.envVars && Object.keys(project.envVars).length > 0
        ? { envVars: project.envVars }
        : {}),
    },
  });

  return c.json({ jobId, projectId: parsed.data.projectId }, 202);
});

// ──────────────────────────────────────────────────────────────────────
// Migrate-module endpoints (Story 15.6 — UI for brownfield migrations)
//
// Wraps the existing brownfield substrate with a CRUD surface dedicated
// to migration management: per-project PAT secrets, env-var editing,
// teardown. The Frontend's /migrate page consumes these.
//
// `POST /api/party/projects` (above) handles initial creation — these
// routes handle the rest of the lifecycle.
// ──────────────────────────────────────────────────────────────────────

const secretsManagerClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

/**
 * Idempotent secret ensurance for per-project brownfield PATs.
 * - Creates the secret if absent.
 * - PutSecretValue if it already exists (rotation).
 * Throws on any AWS error other than ResourceNotFoundException on the
 * pre-check Get.
 */
async function ensureBrownfieldPatSecret(secretName: string, pat: string): Promise<void> {
  try {
    await secretsManagerClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    // Exists → rotate.
    await secretsManagerClient.send(
      new PutSecretValueCommand({ SecretId: secretName, SecretString: pat }),
    );
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name !== 'ResourceNotFoundException') throw err;
    await secretsManagerClient.send(
      new CreateSecretCommand({
        Name: secretName,
        Description: 'Per-project fine-grained PAT for brownfield Party project',
        SecretString: pat,
      }),
    );
  }
}

/**
 * GET /api/migrations — list every brownfield Party project, enriched
 * with the App-row icon + displayName and a session count. The Migrate
 * page's MigrationsList renders this.
 */
app.get('/api/migrations', async (c) => {
  const allProjects = await partyProjectsRepo.listProjects();
  const brownfield = allProjects.filter((p) => p.kind === 'brownfield');
  const enriched = await Promise.all(
    brownfield.map(async (p) => {
      const [app, sessions] = await Promise.all([
        appRepo.getApp(p.projectId).catch(() => null),
        partySessionsRepo.listSessionsByProject(p.projectId).catch(() => []),
      ]);
      return {
        projectId: p.projectId,
        bmadStatus: p.bmadStatus,
        gitRepoUrl: p.gitRepoUrl,
        gitBranch: p.gitBranch,
        lastPulledAt: p.lastPulledAt,
        lastCommitSha: p.lastCommitSha,
        patSecretName: p.patSecretName,
        envVarKeys: Object.keys(p.envVars ?? {}).sort(),
        envVarCount: Object.keys(p.envVars ?? {}).length,
        // NEVER return env-var VALUES on a list — even if the operator is
        // authed, the values are written-only via PATCH. They never leave
        // DDB except into the daemon's process memory when writing .env.
        displayName: app?.displayName ?? p.projectId,
        icon: app?.icon ?? '📨',
        sessionCount: sessions.length,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    }),
  );
  enriched.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return c.json({ migrations: enriched });
});

/**
 * PATCH /api/migrations/:id — rotate the PAT and/or update env vars.
 * Either field (or both) may be present. Refuses with 404 if the
 * project is not a brownfield. Does NOT trigger a refresh — that's a
 * separate explicit action via POST /:id/refresh which already exists.
 */
app.patch('/api/migrations/:id', async (c) => {
  const projectId = c.req.param('id');
  const parsedId = refreshProjectParamsSchema.safeParse({ projectId });
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid projectId');
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateMigrationInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }

  const project = await partyProjectsRepo.getProject(parsedId.data.projectId);
  if (!project) throw new NotFoundError('PartyProject', parsedId.data.projectId);
  if (project.kind !== 'brownfield') {
    throw new AppError(
      'NOT_BROWNFIELD',
      `Project "${parsedId.data.projectId}" is greenfield; the Migrate module only manages brownfield projects.`,
      400,
    );
  }

  if (parsed.data.pat !== undefined) {
    const secretName = project.patSecretName ?? brownfieldPatSecretNameFor(parsedId.data.projectId);
    await ensureBrownfieldPatSecret(secretName, parsed.data.pat);
    if (!project.patSecretName) {
      await partyProjectsRepo.updateBrownfieldPatSecretName(parsedId.data.projectId, secretName);
    }
  }
  if (parsed.data.envVars !== undefined) {
    await partyProjectsRepo.updateBrownfieldEnvVars(parsedId.data.projectId, parsed.data.envVars);
  }

  const updated = await partyProjectsRepo.getProject(parsedId.data.projectId);
  return c.json({
    projectId: parsedId.data.projectId,
    patRotated: parsed.data.pat !== undefined,
    envVarKeys: Object.keys(updated?.envVars ?? {}).sort(),
    envVarCount: Object.keys(updated?.envVars ?? {}).length,
  });
});

/**
 * DELETE /api/migrations/:id — full teardown.
 * - Deletes the PartyProjects row
 * - Deletes the Apps row (if it was auto-created)
 * - Deletes all PartySessions for the project
 * - Schedules the Secrets Manager secret for deletion (30-day recovery
 *   window — AWS won't actually delete instantly, which gives the
 *   operator a safety net)
 *
 * Does NOT delete the EC2 folder — if the operator re-migrates with
 * the same name, the brownfield bootstrap's `rmSync` wipes it.
 */
app.delete('/api/migrations/:id', async (c) => {
  const projectId = c.req.param('id');
  const parsedId = refreshProjectParamsSchema.safeParse({ projectId });
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid projectId');
  }

  const project = await partyProjectsRepo.getProject(parsedId.data.projectId);
  if (!project) throw new NotFoundError('PartyProject', parsedId.data.projectId);
  if (project.kind !== 'brownfield') {
    throw new AppError(
      'NOT_BROWNFIELD',
      `Project "${parsedId.data.projectId}" is greenfield; the Migrate module only manages brownfield projects.`,
      400,
    );
  }

  // Refuse to delete while a session is actively processing.
  const sessionBusy = await partySessionsRepo.hasProcessingSession(parsedId.data.projectId);
  if (sessionBusy) {
    throw new AppError(
      'PROJECT_BUSY',
      'A session for this project is currently processing — wait for it to finish before deleting.',
      409,
    );
  }

  const deletedSessions = await partySessionsRepo.deleteSessionsByProject(parsedId.data.projectId);
  await partyProjectsRepo.deleteProject(parsedId.data.projectId);
  await appRepo.deleteApp(parsedId.data.projectId).catch(() => {});

  let secretScheduled = false;
  if (project.patSecretName) {
    try {
      await secretsManagerClient.send(new DeleteSecretCommand({ SecretId: project.patSecretName }));
      secretScheduled = true;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name !== 'ResourceNotFoundException') {
        // Surface but don't fail the whole teardown.
        console.warn(
          `[migrations.delete] failed to schedule secret deletion: ${(err as Error).message}`,
        );
      }
    }
  }

  return c.json({
    projectId: parsedId.data.projectId,
    sessionsDeleted: deletedSessions,
    secretScheduled,
    note: 'EC2 folder left intact; re-migration with the same name will wipe + re-clone it.',
  });
});

/**
 * Party project docs — small in-chat knowledge tray so agents can reason over
 * user-uploaded files. Docs live at S3 `futurator-ai-website/party-docs/<id>/`
 * AND get rsynced to `/home/ubuntu/projects/<id>/docs/` on upload so Claude's
 * Read tool picks them up during a party turn.
 */
function partyDocsBucket(): string {
  const bucket = process.env.FUTURATOR_PUBLIC_BUCKET;
  if (!bucket) throw new AppError('CONFIG_ERROR', 'FUTURATOR_PUBLIC_BUCKET not set', 500);
  return bucket;
}

function partyDocS3Key(projectId: string, filename: string): string {
  return `${PARTY_DOCS_S3_PREFIX}/${projectId}/${filename}`;
}

function sanitizeDocFilename(filename: string): string {
  // Keep extension + basename; strip path separators and odd chars.
  const base = filename.replace(/^.*[\\/]/, '');
  return base.replace(/[^\w.\-]/g, '_').slice(0, 200);
}

app.post('/api/party/projects/:id/docs/upload-url', async (c) => {
  const projectId = c.req.param('id');
  const parsedId = projectIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid projectId');
  }
  const project = await partyProjectsRepo.getProject(parsedId.data);
  if (!project) throw new NotFoundError('PartyProject', parsedId.data);

  const body = await c.req.json().catch(() => ({}));
  const parsed = docUploadUrlInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }
  if (!PARTY_DOC_ALLOWED_CONTENT_TYPES.includes(parsed.data.contentType)) {
    throw new ValidationError(
      `contentType must be one of: ${PARTY_DOC_ALLOWED_CONTENT_TYPES.join(', ')}`,
    );
  }
  const filename = sanitizeDocFilename(parsed.data.filename);
  if (!filename) throw new ValidationError('filename resolves to empty after sanitization');

  const bucket = partyDocsBucket();
  const key = partyDocS3Key(parsedId.data, filename);
  const s3 = new S3Client({});
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: parsed.data.contentType,
    CacheControl: 'no-store',
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  return c.json({ uploadUrl, s3Bucket: bucket, s3Key: key, filename });
});

app.post('/api/party/projects/:id/docs/synced', async (c) => {
  const projectId = c.req.param('id');
  const parsedId = projectIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid projectId');
  }
  const project = await partyProjectsRepo.getProject(parsedId.data);
  if (!project) throw new NotFoundError('PartyProject', parsedId.data);
  const projectPath = resolvePartyProjectPath(parsedId.data);

  const body = await c.req.json().catch(() => ({}));
  const parsed = docSyncInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }
  const filename = sanitizeDocFilename(parsed.data.filename);
  const bucket = partyDocsBucket();
  const expectedKey = partyDocS3Key(parsedId.data, filename);
  if (parsed.data.s3Key !== expectedKey) {
    throw new ValidationError(`s3Key must be ${expectedKey} (got ${parsed.data.s3Key})`);
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user').userId,
    workingDir: projectPath,
    jobType: 'party-docs-sync',
    partyDocsSyncPayload: {
      projectId: parsedId.data,
      projectPath,
      filename,
      s3Bucket: bucket,
      s3Key: expectedKey,
    },
  });

  return c.json({ jobId, projectId: parsedId.data, filename }, 201);
});

app.get('/api/party/projects/:id/docs', async (c) => {
  const projectId = c.req.param('id');
  const parsedId = projectIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid projectId');
  }
  const bucket = partyDocsBucket();
  const prefix = `${PARTY_DOCS_S3_PREFIX}/${parsedId.data}/`;
  const s3 = new S3Client({});
  const result = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const docs = (result.Contents ?? [])
    .filter((obj) => obj.Key && obj.Key !== prefix)
    .map((obj) => ({
      filename: obj.Key!.slice(prefix.length),
      s3Key: obj.Key!,
      size: obj.Size ?? 0,
      uploadedAt: obj.LastModified?.toISOString() ?? null,
    }));
  return c.json({ projectId: parsedId.data, docs });
});

app.delete('/api/party/projects/:id/docs/:filename', async (c) => {
  const projectId = c.req.param('id');
  const filenameRaw = c.req.param('filename');
  const parsedId = projectIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid projectId');
  }
  const project = await partyProjectsRepo.getProject(parsedId.data);
  if (!project) throw new NotFoundError('PartyProject', parsedId.data);

  const filename = sanitizeDocFilename(decodeURIComponent(filenameRaw));
  if (!filename) throw new ValidationError('invalid filename');
  const projectPath = resolvePartyProjectPath(parsedId.data);

  // Delete S3 object first (authoritative); daemon unlink is best-effort.
  const bucket = partyDocsBucket();
  const s3 = new S3Client({});
  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: partyDocS3Key(parsedId.data, filename) }),
    );
  } catch {
    // If the S3 object was already gone we still enqueue the EC2 unlink.
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user').userId,
    workingDir: projectPath,
    jobType: 'party-docs-unlink',
    partyDocsUnlinkPayload: {
      projectId: parsedId.data,
      projectPath,
      filename,
    },
  });

  return c.json({ jobId, projectId: parsedId.data, filename });
});

app.post('/api/party/projects/:id/inspect', async (c) => {
  const projectId = c.req.param('id');
  const projectPath = resolvePartyProjectPath(projectId);
  await partyProjectsRepo.upsertProjectFromFilesystem(projectId, projectPath);

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user').userId,
    workingDir: projectPath,
    jobType: 'party-inspect',
    partyInspectPayload: { projectId, projectPath },
  });

  return c.json({ jobId, projectId }, 201);
});

app.post('/api/party/sessions', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSessionInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }
  const project = await partyProjectsRepo.getProject(parsed.data.projectId);
  if (!project) throw new NotFoundError('PartyProject', parsed.data.projectId);
  if (project.bmadStatus !== 'HEALTHY') {
    throw new AppError(
      'PROJECT_NOT_HEALTHY',
      `Cannot start party: project bmadStatus is ${project.bmadStatus}`,
      409,
    );
  }
  const session = await partySessionsRepo.createSession({
    projectId: project.projectId,
    projectPath: project.path,
    topic: parsed.data.topic,
    bmadVersionAtStart: project.bmadVersion || 'unknown',
  });
  return c.json(session, 201);
});

app.get('/api/party/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }
  const session = await partySessionsRepo.getSession(parsed.data);
  if (!session) throw new NotFoundError('PartySession', parsed.data);
  return c.json(session);
});

// PATCH session metadata (currently just `topic`). Used to rename
// sessions from the chat header. Body: { topic: string | null }.
app.patch('/api/party/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    topic?: unknown;
  };
  let nextTopic: string | null | undefined;
  if (body.topic === null) {
    nextTopic = null;
  } else if (typeof body.topic === 'string') {
    const trimmed = body.topic.trim();
    nextTopic = trimmed.length === 0 ? null : trimmed;
  } else if (typeof body.topic !== 'undefined') {
    throw new ValidationError('topic must be a string or null');
  }
  const updated = await partySessionsRepo.updateSessionMetadata(parsed.data, {
    topic: nextTopic,
  });
  if (!updated) throw new NotFoundError('PartySession', parsed.data);
  return c.json(updated);
});

app.get('/api/party/projects/:projectId/sessions', async (c) => {
  const projectId = c.req.param('projectId');
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid projectId');
  }
  const sessions = await partySessionsRepo.listSessionsByProject(parsed.data);
  return c.json({ sessions });
});

/**
 * Cross-project listing — backs the Debates page. Returns every session
 * across every party project, newest-activity-first. The Debates UI groups
 * by `projectId` (which equals `appId` in App-scoped flows) for rendering.
 */
app.get('/api/party/sessions', async (c) => {
  const sessions = await partySessionsRepo.listAllSessions();
  sessions.sort((a, b) => {
    const aT = a.lastTurnAt ?? a.createdAt;
    const bT = b.lastTurnAt ?? b.createdAt;
    return bT.localeCompare(aT);
  });
  return c.json({ sessions });
});

// ════════════════════════════════════════════════════════════════
// Party Mode — Inline Q&A on text selections
// ════════════════════════════════════════════════════════════════

const INLINE_Q_SYSTEM_PROMPT = [
  'You are a quick-explain helper inside a chat about a software project.',
  'A user has selected a snippet of text from one of the agents and asked a',
  'follow-up question about it. Answer the question concisely (2–4 sentences),',
  'in plain prose, grounded in the selected snippet.',
  '',
  'Rules:',
  '- Be direct. No preamble like "Great question" or "I\'ll explain".',
  '- Stay grounded in the snippet — do not speculate beyond it.',
  '- If the snippet is too short to answer reliably, say so in one line.',
  '- No markdown headers. Inline code (`like-this`) is fine when natural.',
].join('\n');

app.post('/api/party/sessions/:id/inline-questions', async (c) => {
  const sessionId = c.req.param('id');
  const parsedId = sessionIdSchema.safeParse(sessionId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid sessionId');
  }
  const session = await partySessionsRepo.getSession(parsedId.data);
  if (!session) throw new NotFoundError('PartySession', parsedId.data);

  const body = (await c.req.json().catch(() => ({}))) as {
    question?: unknown;
    anchor?: {
      roundId?: unknown;
      agentName?: unknown;
      snippet?: unknown;
      contextBefore?: unknown;
      contextAfter?: unknown;
    };
  };

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw new ValidationError('question is required');
  if (question.length > INLINE_QUESTION_QUESTION_MAX) {
    throw new ValidationError(`question must be ≤ ${INLINE_QUESTION_QUESTION_MAX} chars`);
  }

  const a = body.anchor || {};
  const roundId = typeof a.roundId === 'string' ? a.roundId : '';
  const snippetRaw = typeof a.snippet === 'string' ? a.snippet : '';
  if (!roundId) throw new ValidationError('anchor.roundId is required');
  if (!snippetRaw.trim()) throw new ValidationError('anchor.snippet is required');
  const snippet = snippetRaw.slice(0, INLINE_QUESTION_SNIPPET_MAX);
  const contextBefore = (typeof a.contextBefore === 'string' ? a.contextBefore : '').slice(
    -INLINE_QUESTION_CONTEXT_MAX,
  );
  const contextAfter = (typeof a.contextAfter === 'string' ? a.contextAfter : '').slice(
    0,
    INLINE_QUESTION_CONTEXT_MAX,
  );
  const agentName = typeof a.agentName === 'string' ? a.agentName.slice(0, 64) : undefined;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AppError(
      'ANTHROPIC_API_KEY_MISSING',
      'Inline Q&A is not configured. Set the ANTHROPIC_API_KEY SST secret.',
      503,
    );
  }
  const anthropic = new Anthropic({ apiKey });

  const userMessage = [
    'Selected snippet (verbatim):',
    '"""',
    snippet,
    '"""',
    contextBefore || contextAfter
      ? `\nSurrounding context (for disambiguation only): "…${contextBefore}[${snippet.slice(0, 30)}…]${contextAfter}…"`
      : '',
    `\nUser question: ${question}`,
  ]
    .filter(Boolean)
    .join('\n');

  let answer = '';
  let usage: InlineQuestion['usage'];
  try {
    const resp = await anthropic.messages.create({
      model: INLINE_QUESTION_DEFAULT_MODEL,
      max_tokens: INLINE_QUESTION_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: INLINE_Q_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });
    const firstText = resp.content.find((b) => b.type === 'text');
    answer = firstText && firstText.type === 'text' ? firstText.text.trim() : '';
    usage = {
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      cacheReadInputTokens: resp.usage.cache_read_input_tokens ?? undefined,
      cacheCreationInputTokens: resp.usage.cache_creation_input_tokens ?? undefined,
    };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new AppError(
        'ANTHROPIC_API_ERROR',
        `Anthropic API error (${err.status}): ${err.message}`,
        err.status === 429 ? 429 : 502,
      );
    }
    throw err;
  }
  if (!answer) {
    throw new AppError('ANTHROPIC_EMPTY_ANSWER', 'Anthropic returned no text', 502);
  }

  const user = c.get('user');
  const stored: InlineQuestion = {
    questionId: crypto.randomUUID(),
    sessionId: parsedId.data,
    projectId: session.projectId,
    createdAt: new Date().toISOString(),
    createdBy: user.userId,
    anchor: {
      roundId,
      agentName,
      snippet,
      contextBefore,
      contextAfter,
    },
    question,
    answer,
    model: INLINE_QUESTION_DEFAULT_MODEL,
    usage,
  };
  await inlineQuestionsRepo.createInlineQuestion(stored);
  return c.json(stored, 201);
});

app.get('/api/party/sessions/:id/inline-questions', async (c) => {
  const sessionId = c.req.param('id');
  const parsedId = sessionIdSchema.safeParse(sessionId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid sessionId');
  }
  const questions = await inlineQuestionsRepo.listInlineQuestionsBySession(parsedId.data);
  return c.json({ questions });
});

app.post('/api/party/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const parsedId = sessionIdSchema.safeParse(sessionId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid sessionId');
  }
  const body = await c.req.json().catch(() => ({}));
  const parsedBody = sendMessageInputSchema.safeParse(body);
  if (!parsedBody.success) {
    throw new ValidationError(parsedBody.error.errors[0]?.message || 'invalid body');
  }

  const session = await partySessionsRepo.getSession(parsedId.data);
  if (!session) throw new NotFoundError('PartySession', parsedId.data);

  const lock = await partySessionsRepo.tryAcquireSessionLock(parsedId.data);
  if (!lock.ok) {
    if (lock.reason === 'SESSION_BUSY') {
      throw new AppError('SESSION_BUSY', 'Session is already processing a turn', 409);
    }
    if (lock.reason === 'NOT_ACTIVE') {
      throw new AppError(
        'SESSION_NOT_ACTIVE',
        'Session is not ACTIVE or IDLE and cannot accept a message',
        409,
      );
    }
    throw new NotFoundError('PartySession', parsedId.data);
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user').userId,
    workingDir: session.projectPath,
    jobType: 'party-turn',
    partyTurnPayload: { sessionId: parsedId.data, content: parsedBody.data.content },
  });

  return c.json({ jobId, sessionId: parsedId.data }, 202);
});

/**
 * Read a single file from inside a Party project's working directory on EC2.
 * Used by the chat's file-preview drawer when the user clicks a file path
 * link inside an agent message.
 *
 * Path safety: resolved absolutely against `<projectPath>/`. Any resolved
 * path that escapes the project root (via `..`, symlinks the shell expands,
 * or absolute overrides) is refused with 403. Even though SSM runs as
 * `ubuntu` and can in principle read more, leaking files from other projects
 * via the chat would still be a confused-deputy bug.
 *
 * Hard size cap: 1 MiB. Files bigger than that return a 413 with a hint to
 * download via the existing /api/ec2 surface (TODO: separate stream endpoint).
 */
app.get('/api/party/projects/:projectId/files', async (c) => {
  const projectId = c.req.param('projectId');
  const parsedId = projectIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid projectId');
  }
  const rel = c.req.query('path') || '';
  if (!rel || rel.length > 500) {
    throw new ValidationError('path query param required (max 500 chars)');
  }
  // Reject obvious traversal markers up front. We re-validate after path
  // resolution as belt-and-suspenders.
  if (rel.includes('\0') || rel.includes('..')) {
    throw new ValidationError('path may not contain `..` or null bytes');
  }
  // Whitelist characters allowed in the relative path.
  if (!/^[A-Za-z0-9._/\-]+$/.test(rel)) {
    throw new ValidationError('path contains disallowed characters');
  }

  const project = await partyProjectsRepo.getProject(parsedId.data);
  if (!project) throw new NotFoundError('PartyProject', parsedId.data);

  const { state } = await getInstanceState();
  if (state !== 'running') {
    throw new AppError('EC2_NOT_RUNNING', `EC2 instance is ${state}`, 400);
  }

  // Resolve relative-to-projectPath. Strip a leading `/` so a leading slash
  // doesn't make rel absolute (which would override projectPath in path.join
  // semantics — we don't use path.join here but mirror its safety).
  const cleanRel = rel.replace(/^\/+/, '');
  const fullPath = `${project.path.replace(/\/+$/, '')}/${cleanRel}`;

  // SSM-side guard. realpath verifies the resolved canonical path is still
  // within the project root after symlink expansion. Bash quoting is safe
  // because we already whitelisted the characters above.
  const cmd = [
    `set -e`,
    `ROOT="${project.path}"`,
    `TARGET="${fullPath}"`,
    `RESOLVED=$(realpath -m "$TARGET" 2>/dev/null || echo "__NOT_FOUND__")`,
    // realpath -m resolves missing components without erroring; we still
    // need to check the file actually exists.
    `case "$RESOLVED" in "$ROOT"|"$ROOT"/*) ;; *) echo "__OUT_OF_ROOT__" && exit 0;; esac`,
    `if [ ! -f "$RESOLVED" ]; then echo "__NOT_FOUND__" && exit 0; fi`,
    `SIZE=$(stat -c%s "$RESOLVED")`,
    `if [ "$SIZE" -gt 1048576 ]; then echo "__TOO_LARGE__:$SIZE" && exit 0; fi`,
    `echo "__OK__:$SIZE"`,
    `cat "$RESOLVED"`,
  ].join('\n');

  const commandId = await sendSsmCommand(cmd);
  const output = await waitForSsmOutput(commandId);

  if (output.includes('__OUT_OF_ROOT__')) {
    throw new AppError('FORBIDDEN', 'path resolves outside project root', 403);
  }
  if (output.includes('__NOT_FOUND__')) {
    throw new NotFoundError('File', cleanRel);
  }
  const tooLarge = output.match(/__TOO_LARGE__:(\d+)/);
  if (tooLarge) {
    throw new AppError(
      'FILE_TOO_LARGE',
      `File is ${tooLarge[1]} bytes; preview limited to 1 MiB`,
      413,
    );
  }
  // Strip the marker line + size header before returning the body.
  const headerMatch = output.match(/^__OK__:(\d+)\n([\s\S]*)$/);
  if (!headerMatch) {
    throw new AppError('READ_FAILED', 'unexpected output from file read', 500);
  }
  const size = parseInt(headerMatch[1], 10);
  const content = headerMatch[2];

  // Minimal content-type sniffing — UI uses the extension primarily, this
  // is informational.
  const ext = cleanRel.split('.').pop()?.toLowerCase() || '';
  const contentType =
    ext === 'md' || ext === 'markdown'
      ? 'text/markdown'
      : ext === 'json'
        ? 'application/json'
        : ext === 'html'
          ? 'text/html'
          : 'text/plain';

  return c.json({
    path: cleanRel,
    fullPath,
    size,
    contentType,
    content,
  });
});

app.get('/api/party/sessions/:id/events', async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }
  const afterSeq = c.req.query('after') || '000000';
  const { events, lastSeq } = await agentEventsRepo.getEventsAfter(parsed.data, afterSeq);
  return c.json({ events, lastSeq });
});

// ──────────────────────────────────────────────────────────────────────
// Epic 18 / Story 18.5 — Free Claude Code Agent session lifecycle routes.
//
// Four routes drive the end-to-end widget ↔ daemon flow:
//   POST   /api/free-agent/sessions               — create session + AssumeRole
//   POST   /api/free-agent/sessions/:id/messages  — enqueue a turn
//   GET    /api/free-agent/sessions/:id           — current session state
//   GET    /api/free-agent/sessions/:id/events    — long-poll events
//
// Per-session AWS credentials are minted by the API Lambda via STS and
// cached in-memory (Map below). Credentials NEVER leave the server — they
// flow to the daemon via the encrypted job-dispatch payload only.
//
// Lambda cold-start loses the cache; the next message-enqueue
// re-AssumeRoles. Acceptable v1 trade-off per [[ship-mvp-add-complexity-later]].
// ──────────────────────────────────────────────────────────────────────

/**
 * In-memory credential cache keyed by sessionId. Survives Lambda warm
 * invocations; lost on cold start. Map growth is naturally bounded by
 * concurrently-active sessions per warm instance.
 */
const freeAgentSessionCredentialsCache = new Map<string, SessionCredentials>();

app.post('/api/free-agent/sessions', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateFreeAgentSessionInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }

  const user = c.get('user');
  if (!user?.userId) {
    throw new AppError('UNAUTHENTICATED', 'Missing user context', 401);
  }

  const { scope, model } = parsed.data;
  const costCapUsd = parsed.data.costCapUsd ?? FREE_AGENT_DEFAULT_COST_CAP_USD;
  // Derive projectId from scope.id when scope.kind === 'project'; fall back to
  // a synthetic id for non-project scopes (the daemon worktree path is still
  // /home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/).
  const projectId =
    (scope.kind === 'project' || scope.kind === 'app') && scope.id ? scope.id : `_${scope.kind}`;
  const sessionId = crypto.randomUUID();

  const credentials = await assumeFreeAgentSessionRole({
    projectId,
    sessionId,
    operatorId: user.userId,
  });
  freeAgentSessionCredentialsCache.set(sessionId, credentials);

  const session = await freeAgentSessionsRepo.createSession({
    sessionId,
    operatorId: user.userId,
    projectId,
    scope,
    model,
    costCapUsd,
  });

  // NEVER include credentials in the response.
  return c.json(
    {
      sessionId: session.sessionId,
      status: session.status,
      model: session.model,
      costCapUsd: session.costCapUsd,
      scope: session.scope,
      scopeIdComposite: session.scopeIdComposite,
      createdAt: session.createdAt,
      expiration: credentials.expiration,
    },
    201,
  );
});

app.post('/api/free-agent/sessions/:id/messages', authMiddleware, async (c) => {
  const sessionId = c.req.param('id');
  const parsedId = sessionIdSchema.safeParse(sessionId);
  if (!parsedId.success) {
    throw new ValidationError(parsedId.error.errors[0]?.message || 'invalid sessionId');
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = SendFreeAgentMessageInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }

  const session = await freeAgentSessionsRepo.getSession(parsedId.data);
  if (!session) throw new NotFoundError('FreeAgentSession', parsedId.data);

  const user = c.get('user');
  if (!user || session.operatorId !== user.userId) {
    throw new AppError('FORBIDDEN', 'Only the session owner can send messages', 403);
  }

  if (session.status === 'BUDGET_EXHAUSTED') {
    throw new AppError(
      'BUDGET_EXHAUSTED',
      'Session is at its cost cap; raise the cap or end the session',
      402,
    );
  }
  if (session.status === 'ERROR' || session.status === 'EXPIRED') {
    throw new AppError(
      'INVALID_STATE',
      `Session is in ${session.status} state; create a new conversation`,
      409,
    );
  }

  // Refresh credentials if near expiry (Story 18.1). Cache miss falls back
  // to fresh AssumeRole.
  let credentials = freeAgentSessionCredentialsCache.get(parsedId.data);
  if (!credentials) {
    credentials = await assumeFreeAgentSessionRole({
      projectId: session.projectId,
      sessionId: session.sessionId,
      operatorId: session.operatorId,
    });
  } else {
    const refreshed = await refreshSessionCredentials({
      projectId: session.projectId,
      sessionId: session.sessionId,
      operatorId: session.operatorId,
      expiration: credentials.expiration,
    });
    if (refreshed) credentials = refreshed;
  }
  freeAgentSessionCredentialsCache.set(parsedId.data, credentials);

  const lock = await freeAgentSessionsRepo.acquireProcessingLock(parsedId.data);
  if (!lock.ok) {
    if (lock.reason === 'SESSION_BUSY') {
      throw new AppError('SESSION_BUSY', 'A turn is already in progress', 409);
    }
    if (lock.reason === 'NOT_FOUND') {
      throw new NotFoundError('FreeAgentSession', parsedId.data);
    }
    throw new AppError('INVALID_STATE', `Cannot send: session state is ${lock.reason}`, 409);
  }

  // Optional Cmd+Shift+4 image attachments. Frontend pre-resizes + JPEG-encodes
  // before sending; per-image cap 900KB base64 + max 4 images keeps the job
  // payload comfortably under DDB's 400KB row ceiling (we also write a
  // compact placeholder to the conversations table — full images live only
  // in the ephemeral job payload, never persisted long-term).
  const images = parsed.data.images ?? [];
  const imageCountSuffix =
    images.length > 0 ? ` 📎 ${images.length} image${images.length === 1 ? '' : 's'} attached` : '';

  // Story 18.6 — persist the USER message BEFORE enqueueing the daemon job
  // so the thread list + conversation history reflect the operator's input
  // even if the daemon job fails. Image bytes are NOT persisted in the
  // conversations table (DDB row size limits + privacy); just the count
  // marker so the thread list shows context.
  await freeAgentConversationsRepo.appendMessage({
    sessionId: session.sessionId,
    role: 'user',
    content: parsed.data.content + imageCountSuffix,
  });

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: `/home/ubuntu/free-agent-worktrees/${session.projectId}/${session.sessionId}`,
    jobType: 'free-agent-session',
    freeAgentSessionPayload: {
      sessionId: session.sessionId,
      projectId: session.projectId,
      scope: session.scope,
      model: session.model,
      costCapUsd: session.costCapUsd,
      credentials,
      messages: [
        {
          role: 'user',
          content: parsed.data.content,
          ...(images.length > 0 ? { images } : {}),
        },
      ],
    },
  });

  return c.json({ jobId, status: 'PROCESSING' }, 202);
});

// POST /api/free-agent/sessions/:id/cancel
//   Operator clicked Stop while the daemon is processing a turn. We set a
//   soft signal on the session row; the daemon's runFreeAgentSession polls
//   it every few seconds and SIGTERMs the `claude` subprocess on detection.
//   Returns 202 if accepted; 409 INVALID_STATE if the session isn't currently
//   PROCESSING (nothing to cancel).
app.post('/api/free-agent/sessions/:id/cancel', authMiddleware, async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }

  const session = await freeAgentSessionsRepo.getSession(parsed.data);
  if (!session) throw new NotFoundError('FreeAgentSession', parsed.data);

  const user = c.get('user');
  if (!user || session.operatorId !== user.userId) {
    throw new AppError('FORBIDDEN', 'Only the session owner can cancel a turn', 403);
  }

  if (session.status !== 'PROCESSING') {
    throw new AppError(
      'INVALID_STATE',
      `Cannot cancel: session is ${session.status}, not PROCESSING`,
      409,
    );
  }

  try {
    await freeAgentSessionsRepo.requestCancel(parsed.data);
    return c.json({ ok: true, sessionId: parsed.data, cancelRequested: true }, 202);
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'ConditionalCheckFailedException') {
      throw new AppError('INVALID_STATE', 'Session is no longer PROCESSING', 409);
    }
    throw err;
  }
});

app.get('/api/free-agent/sessions/:id', authMiddleware, async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }
  const session = await freeAgentSessionsRepo.getSession(parsed.data);
  if (!session) throw new NotFoundError('FreeAgentSession', parsed.data);

  const user = c.get('user');
  if (!user || session.operatorId !== user.userId) {
    throw new AppError('FORBIDDEN', 'Only the session owner can read state', 403);
  }

  return c.json({
    sessionId: session.sessionId,
    status: session.status,
    model: session.model,
    costCapUsd: session.costCapUsd,
    costUsdAccumulated: session.costUsdAccumulated,
    tokensInAccumulated: session.tokensInAccumulated ?? 0,
    tokensOutAccumulated: session.tokensOutAccumulated ?? 0,
    turnCount: session.turnCount,
    lastActivityAt: session.lastActivityAt,
    claudeSessionId: session.claudeSessionId ?? null,
    errorReason: session.errorReason ?? null,
    scope: session.scope,
  });
});

app.get('/api/free-agent/sessions/:id/events', authMiddleware, async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }
  const session = await freeAgentSessionsRepo.getSession(parsed.data);
  if (!session) throw new NotFoundError('FreeAgentSession', parsed.data);

  const user = c.get('user');
  if (!user || session.operatorId !== user.userId) {
    throw new AppError('FORBIDDEN', 'Only the session owner can read events', 403);
  }

  const afterSeq = c.req.query('after') || '000000';
  const { events, lastSeq } = await agentEventsRepo.getEventsAfter(parsed.data, afterSeq, 200);
  return c.json({ events, lastSeq });
});

// ──────────────────────────────────────────────────────────────────────
// Epic 18 / Story 18.6 — Free Claude Code Agent conversation persistence.
//
// Two routes:
//   GET /api/free-agent/conversations?scope=<kind>:<id>&limit=N
//     — recent sessions for the operator + scope (with first-user-message
//       preview when available). Used by the panel-header hamburger dropdown.
//   GET /api/free-agent/sessions/:id/messages
//     — full conversation history for a session. Used by the loadSession
//       action to seed the panel's thread on resume.
// ──────────────────────────────────────────────────────────────────────

app.get('/api/free-agent/conversations', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user?.userId) {
    throw new AppError('UNAUTHENTICATED', 'Missing user context', 401);
  }

  const scopeParam = c.req.query('scope');
  if (!scopeParam) {
    throw new ValidationError('scope query param required (format: <kind>:<id>)');
  }
  // Accept "kind" or "kind:id". `workspace` has no id; everything else needs one.
  const [scopeKind, scopeId] = scopeParam.split(':');
  if (!scopeKind || (scopeKind !== 'workspace' && !scopeId)) {
    throw new ValidationError('scope must be <kind>:<id> (or "workspace")');
  }

  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 20;
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('limit must be 1-100');
  }

  const sessions = await freeAgentConversationsRepo.listSessionsByScope(
    { kind: scopeKind, id: scopeId },
    limit,
  );

  // Owner-only filtering. The GSI returns all sessions for the scope across
  // operators (rare in v1's single-operator world but defensive).
  const ownerSessions = sessions.filter((s) => s.operatorId === user.userId);

  // Fetch first-user-message previews in parallel (bounded by `limit`).
  const out = await Promise.all(
    ownerSessions.map(async (s) => {
      const preview = await freeAgentConversationsRepo
        .getFirstUserMessagePreview(s.sessionId)
        .catch(() => null);
      return {
        sessionId: s.sessionId,
        scope: s.scope,
        status: s.status,
        model: s.model,
        costUsdAccumulated: s.costUsdAccumulated,
        turnCount: s.turnCount,
        lastActivityAt: s.lastActivityAt,
        firstUserMessagePreview: preview,
      };
    }),
  );

  return c.json(out);
});

app.get('/api/free-agent/sessions/:id/messages', authMiddleware, async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }
  const session = await freeAgentSessionsRepo.getSession(parsed.data);
  if (!session) throw new NotFoundError('FreeAgentSession', parsed.data);

  const user = c.get('user');
  if (!user || session.operatorId !== user.userId) {
    throw new AppError('FORBIDDEN', 'Only the session owner can read messages', 403);
  }

  const messages = await freeAgentConversationsRepo.getMessages(parsed.data);
  return c.json(
    messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      costUsd: m.costUsd,
      toolCalls: m.toolCalls,
    })),
  );
});

// ──────────────────────────────────────────────────────────────────────
// Epic 18 / Story 18.3 — Free Claude Code Agent audit endpoint.
//
// GET /api/free-agent/sessions/:id/audit
//   Returns a unified timeline: session metadata + all free-agent.* events
//   emitted by the daemon handler (keyed by sessionId in agent-events).
//
// Auth: caller is the session owner (matching session.operatorId === user.userId).
//   Admin-scope escalation is a one-line follow-up — no clean admin-scope
//   pattern exists in this codebase yet, so v1 ships owner-only per
//   [[ship-mvp-add-complexity-later]].
// ──────────────────────────────────────────────────────────────────────
app.get('/api/free-agent/sessions/:id/audit', authMiddleware, async (c) => {
  const sessionId = c.req.param('id');
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid sessionId');
  }

  const session = await freeAgentSessionsRepo.getSession(parsed.data);
  if (!session) {
    throw new NotFoundError('FreeAgentSession', parsed.data);
  }

  const user = c.get('user');
  if (!user || session.operatorId !== user.userId) {
    throw new AppError('FORBIDDEN', 'Only the session owner can read the audit timeline', 403);
  }

  // Paginate through all events for this session. The 90-day TTL on
  // agent-events keeps the page count bounded; the safety cap below
  // protects against runaway sessions.
  const MAX_EVENTS = 5000;
  const events: import('../shared/types/agent-orchestrator').AgentEvent[] = [];
  let afterSeq = '000000';
  for (let page = 0; page < 100; page += 1) {
    const { events: pageEvents, lastSeq } = await agentEventsRepo.getEventsAfter(
      parsed.data,
      afterSeq,
      200,
    );
    if (pageEvents.length === 0) break;
    for (const ev of pageEvents) {
      if (events.length >= MAX_EVENTS) break;
      events.push(ev);
    }
    if (events.length >= MAX_EVENTS) break;
    if (lastSeq === afterSeq) break; // no progress — terminator
    afterSeq = lastSeq;
  }

  return c.json({
    sessionId: session.sessionId,
    session: {
      status: session.status,
      model: session.model,
      costCapUsd: session.costCapUsd,
      costUsdAccumulated: session.costUsdAccumulated,
      tokensInAccumulated: session.tokensInAccumulated ?? 0,
      tokensOutAccumulated: session.tokensOutAccumulated ?? 0,
      turnCount: session.turnCount,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      lastTurnAt: session.lastTurnAt ?? null,
      claudeSessionId: session.claudeSessionId ?? null,
      errorReason: session.errorReason ?? null,
    },
    events: events.map((ev) => ({
      timestamp: ev.timestamp,
      kind: ev.eventType,
      detail: {
        text: ev.text,
        toolName: ev.toolName,
        toolInput: ev.toolInput,
        toolOutput: ev.toolOutput,
        cost: ev.cost,
        durationMs: ev.durationMs,
        payload: ev.payload,
      },
    })),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Pipeline v1 — Failure recovery surface (Epic 1, Stories 1.5–1.8)
//
// Operator actions on a NEEDS_ATTENTION job. All four endpoints follow the
// same shape: load the job, validate the requested action against the job's
// state machine, mutate, return the updated job. The wave reducer
// (functions/shared/services/wave-reducer.ts) handles advancement on the
// next cron tick — these endpoints do not directly drive wave state to
// keep the API thin and the reducer authoritative.
// ──────────────────────────────────────────────────────────────────────────

import { randomUUID as randomUUID_pipelineV1 } from 'crypto';

function findPipelineStep(
  job: import('../shared/types/agent-orchestrator').AgentJob,
  stepId: string,
) {
  return job.pipeline?.steps?.find((s) => s.id === stepId) || null;
}

async function resolvePlanIdForJob(
  job: import('../shared/types/agent-orchestrator').AgentJob,
): Promise<string | null> {
  if (!job.epicId) return null;
  const epic = await epicRepo.getEpicById(job.epicId);
  return epic?.planId || null;
}

// POST /api/jobs/:jobId/steps/:stepId/salvage — Story 1.5.
// Apply already-extracted variables as if the step had succeeded.
app.post('/api/jobs/:jobId/steps/:stepId/salvage', async (c) => {
  const { jobId, stepId } = c.req.param();
  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  // Idempotency: if already salvaged, return the same response shape.
  if (job.status === 'COMPLETED_VIA_SALVAGE') {
    return c.json({ ok: true, job, advanced: true });
  }
  if (job.status !== 'NEEDS_ATTENTION') {
    return c.json(
      {
        error: `Cannot salvage: job is ${job.status}, expected NEEDS_ATTENTION`,
      },
      409,
    );
  }
  if (!job.salvageableExtractors || job.salvageableExtractors.length === 0) {
    return c.json({ error: 'Cannot salvage: no extractors fired before failure' }, 409);
  }
  const step = findPipelineStep(job, stepId);
  if (step && step.salvageable === false) {
    return c.json({ error: `Cannot salvage: step "${stepId}" is marked salvageable=false` }, 409);
  }

  // Mark COMPLETED_VIA_SALVAGE. The wave reducer treats this as success on
  // the next tick (Story 1.1). The variables are already on `job.variables`
  // — the daemon's escalation handler persisted them before throwing.
  await agentJobsRepo.updateJobFields(jobId, {
    status: 'COMPLETED_VIA_SALVAGE',
    errorMessage: undefined,
  });

  // Auto-resolve any open attention items linked to this job (best-effort).
  const planId = await resolvePlanIdForJob(job);
  if (planId && job.attentionItemIds?.length) {
    for (const itemId of job.attentionItemIds) {
      try {
        await attentionRepo.updateAttentionStatus(planId, itemId, 'resolved');
      } catch {
        // ignore — item may have been resolved already
      }
    }
  }

  const updated = await agentJobsRepo.getJobById(jobId);
  return c.json({ ok: true, job: updated, advanced: true });
});

// POST /api/jobs/:jobId/steps/:stepId/retry — Story 1.6.
// Spawn a new job with the same pipeline + step config; original stays
// NEEDS_ATTENTION linked via retryOf.
app.post('/api/jobs/:jobId/steps/:stepId/retry', async (c) => {
  const { jobId, stepId } = c.req.param();
  const body = (await c.req.json().catch(() => ({}))) as { hint?: string };

  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== 'NEEDS_ATTENTION') {
    return c.json({ error: `Cannot retry: job is ${job.status}` }, 409);
  }
  const step = findPipelineStep(job, stepId);

  // Walk the retryOf chain to count consecutive retries.
  const maxRetries = step?.maxConsecutiveRetries ?? 3;
  let chainLen = 0;
  let cursor: typeof job | null = job;
  while (cursor?.retryOf && chainLen < 100) {
    chainLen += 1;
    cursor = await agentJobsRepo.getJobById(cursor.retryOf);
  }
  if (chainLen >= maxRetries) {
    return c.json(
      {
        error: `Retry cap (${maxRetries}) reached for step "${stepId}". Use Talk to debug or Abort to give up.`,
      },
      409,
    );
  }

  // Spawn a new PENDING job. The daemon will pick it up on its next poll.
  const now = new Date().toISOString();
  const newJobId = randomUUID_pipelineV1();
  const variables = { ...(job.pipeline?.initialVariables || {}) };
  if (typeof body?.hint === 'string' && body.hint.trim().length > 0) {
    variables.OPERATOR_HINT = `Hint from operator: ${body.hint.trim()}`;
  }
  const newPipeline = job.pipeline ? { ...job.pipeline, initialVariables: variables } : undefined;

  await agentJobsRepo.createJob({
    jobId: newJobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: job.createdBy,
    workingDir: job.workingDir,
    pipeline: newPipeline,
    epicId: job.epicId,
    projectId: job.projectId,
    retryOf: jobId,
  });

  // Auto-resolve attention items on the original; original stays NEEDS_ATTENTION
  // (audit trail) but its inbox row clears.
  const planId = await resolvePlanIdForJob(job);
  if (planId && job.attentionItemIds?.length) {
    for (const itemId of job.attentionItemIds) {
      try {
        await attentionRepo.updateAttentionStatus(planId, itemId, 'resolved');
      } catch {
        // ignore
      }
    }
  }

  return c.json({ ok: true, newJobId });
});

// POST /api/jobs/:jobId/steps/:stepId/skip — Story 1.7.
app.post('/api/jobs/:jobId/steps/:stepId/skip', async (c) => {
  const { jobId, stepId } = c.req.param();
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };

  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== 'NEEDS_ATTENTION') {
    return c.json({ error: `Cannot skip: job is ${job.status}` }, 409);
  }
  const step = findPipelineStep(job, stepId);
  if (!step || step.skipTolerant !== true) {
    return c.json(
      {
        error: `Cannot skip: step "${stepId}" is not skip-tolerant — its output is required by downstream steps`,
      },
      409,
    );
  }

  await agentJobsRepo.updateJobFields(jobId, {
    status: 'MANUALLY_SKIPPED',
    errorMessage: body?.reason
      ? `manually skipped: ${body.reason}`.slice(0, 500)
      : 'manually skipped',
  });

  const planId = await resolvePlanIdForJob(job);
  if (planId && job.attentionItemIds?.length) {
    for (const itemId of job.attentionItemIds) {
      try {
        await attentionRepo.updateAttentionStatus(planId, itemId, 'resolved');
      } catch {
        // ignore
      }
    }
  }

  return c.json({ ok: true, advanced: true });
});

// POST /api/jobs/:jobId/steps/:stepId/abort — Story 1.8.
app.post('/api/jobs/:jobId/steps/:stepId/abort', async (c) => {
  const { jobId } = c.req.param();
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };

  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (!['NEEDS_ATTENTION', 'RUNNING', 'PENDING'].includes(job.status)) {
    return c.json(
      { error: `Cannot abort: job is ${job.status}, expected NEEDS_ATTENTION/RUNNING/PENDING` },
      409,
    );
  }

  // FU-3: differentiated handling by status.
  //   - RUNNING: set `abortRequested=true` so the daemon's heartbeat loop
  //     SIGTERMs the active child. The daemon flips status → FAILED on
  //     subprocess exit; we don't pre-flip here so the daemon can still
  //     attribute the failure cleanly.
  //   - NEEDS_ATTENTION / PENDING: no live process; flip directly.
  if (job.status === 'RUNNING') {
    await agentJobsRepo.updateJobFields(jobId, {
      abortRequested: true,
      triggeredBy: 'OPERATOR_ABORT',
      errorMessage: body?.reason
        ? `abort requested: ${body.reason}`.slice(0, 500)
        : 'abort requested by operator',
    });
  } else {
    await agentJobsRepo.updateJobFields(jobId, {
      status: 'FAILED',
      triggeredBy: 'OPERATOR_ABORT',
      errorMessage: body?.reason
        ? `aborted by operator: ${body.reason}`.slice(0, 500)
        : 'aborted by operator',
    });
  }

  const planId = await resolvePlanIdForJob(job);
  if (planId && job.attentionItemIds?.length) {
    for (const itemId of job.attentionItemIds) {
      try {
        await attentionRepo.updateAttentionStatus(planId, itemId, 'resolved');
      } catch {
        // ignore
      }
    }
  }

  return c.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Pipeline v1 — Epic 3 (Talk-to-agent v1).
//
// Conversation lifecycle:
//   POST /api/jobs/:jobId/steps/:stepId/conversations  → create a conversation
//   POST /api/conversations/:conversationId/messages   → send a message (enqueues agent-turn job)
//   GET  /api/conversations/:conversationId/events     → stream events (polling fallback)
//   POST /api/conversations/:conversationId/apply-output → run extractors + apply variables
// ──────────────────────────────────────────────────────────────────────────

import * as agentSessionsRepo from '../shared/repositories/agent-sessions-repository';
import * as agentConversationsRepo from '../shared/repositories/agent-conversations-repository';

// POST /api/jobs/:jobId/steps/:stepId/conversations — Story 3.4.
app.post('/api/jobs/:jobId/steps/:stepId/conversations', async (c) => {
  const { jobId, stepId } = c.req.param();
  const body = (await c.req.json().catch(() => ({}))) as {
    mode?: 'fresh' | 'resume' | 'compact-resume';
  };
  const mode = body.mode || 'fresh';

  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  // Look up an existing AgentSession for this step (created by the daemon
  // on first turn). For `fresh`, we create a new session row; for `resume`
  // / `compact-resume`, we require the existing session to have a
  // claudeSessionId.
  const existing = await agentSessionsRepo.findByJobAndStep(jobId, stepId);

  if ((mode === 'resume' || mode === 'compact-resume') && !existing?.claudeSessionId) {
    return c.json({ error: `Cannot ${mode}: step has no Claude session to resume from` }, 404);
  }

  // Single-OPEN-conversation rule (v1 AC#3).
  if (existing && (await agentConversationsRepo.hasOpenConversation(existing.sessionId))) {
    return c.json({ error: 'A conversation is already OPEN against this session' }, 409);
  }

  // FU-7 (Story 5.4) — compact-resume: synthesize a compacted session row
  // synchronously and open the conversation against it. The actual
  // on-disk transcript rewrite is the daemon's responsibility (Story 5.3
  // compactor); the API guarantee here is that a fresh "compacted" session
  // row exists, with `compactedFrom` pointing back at the original. Open
  // conversation will resume against the compacted session's
  // claudeSessionId; cost is the warm-resume rate over the compacted token
  // count rather than the pre-compaction count.
  let sessionId = existing?.sessionId;
  const now = new Date().toISOString();
  if (mode === 'compact-resume' && existing) {
    const compactedId = randomUUID_pipelineV1();
    await agentSessionsRepo.createSession({
      sessionId: compactedId,
      jobId,
      stepId,
      claudeSessionId: existing.claudeSessionId, // re-used until the daemon-side rewrite lands
      status: 'IDLE',
      cwd: existing.cwd,
      agentKind: existing.agentKind,
      tokenCount: Math.max(1, Math.floor((existing.tokenCount || 0) * 0.4)),
      costUsd: 0,
      compactedFrom: existing.sessionId,
      firstTurnAt: now,
      lastTurnAt: now,
    });
    await agentSessionsRepo.updateSessionFields(existing.sessionId, {
      status: 'ARCHIVED',
    });
    sessionId = compactedId;
  } else if (!sessionId || mode === 'fresh') {
    // For `fresh`, create a fresh AgentSession row (the daemon populates
    // claudeSessionId on first turn).
    sessionId = randomUUID_pipelineV1();
    await agentSessionsRepo.createSession({
      sessionId,
      jobId,
      stepId,
      status: 'IDLE',
      cwd: job.workingDir,
      agentKind: undefined,
      tokenCount: 0,
      costUsd: 0,
    });
  }

  // System-prompt source for fresh-mode handoff.
  const handoffTemplate = mode === 'fresh' ? buildHandoffTemplate({ job, stepId }) : undefined;

  const conversationId = randomUUID_pipelineV1();
  await agentConversationsRepo.createConversation({
    conversationId,
    sessionId,
    jobId,
    stepId,
    mode,
    openedBy: 'system', // Story 6.5 will fill from JWT
    openedAt: now,
    lastActivityAt: now,
    status: 'OPEN',
    messageCount: 0,
    totalCostUsd: 0,
    costCeilingUsd: 5,
    systemPromptSource: handoffTemplate,
  });

  const session = await agentSessionsRepo.getSessionById(sessionId);
  const warmth =
    session && session.lastTurnAt ? agentSessionsRepo.getSessionWarmth(session) : 'COLD';

  return c.json({
    conversationId,
    sessionId,
    warmth,
    estimatedFirstTurnCost: warmth === 'COLD' ? 0.01 : 0.04,
  });
});

function buildHandoffTemplate(args: {
  job: import('../shared/types/agent-orchestrator').AgentJob;
  stepId: string;
}): string {
  const { job, stepId } = args;
  const ep = job.escalationPayload;
  const lines = [
    `You are a debug session for failed step "${stepId}" in job ${job.jobId.slice(0, 8)}.`,
    job.errorMessage ? `Error: ${job.errorMessage}` : '',
    ep?.whatFailed ? `Original agent reported: ${ep.whatFailed}` : '',
    ep?.whyStuck ? `Why stuck: ${ep.whyStuck}` : '',
    ep?.whatTried?.length ? `What it tried:\n${ep.whatTried.map((b) => `- ${b}`).join('\n')}` : '',
    `Latest variables: ${JSON.stringify(job.variables || {}, null, 2).slice(0, 1000)}`,
    'Please help the operator diagnose and propose fixes.',
  ];
  return lines.filter(Boolean).join('\n\n');
}

// POST /api/conversations/:conversationId/messages — Story 3.5.
app.post('/api/conversations/:conversationId/messages', async (c) => {
  const conversationId = c.req.param('conversationId');
  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  if (!body.content || body.content.trim().length === 0) {
    return c.json({ error: 'body.content required' }, 400);
  }

  const conversation = await agentConversationsRepo.getConversationById(conversationId);
  if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
  if (conversation.status !== 'OPEN') {
    return c.json({ error: `Conversation is ${conversation.status}` }, 409);
  }
  if (conversation.totalCostUsd >= conversation.costCeilingUsd) {
    return c.json(
      {
        error: `Conversation hit cost cap ($${conversation.costCeilingUsd}). Raise the cap to continue.`,
      },
      409,
    );
  }

  // Enqueue an agent-turn job. The daemon's job-router picks it up and
  // runs the conversation turn pipeline.
  const messageId = randomUUID_pipelineV1();
  const jobId = randomUUID_pipelineV1();
  const now = new Date().toISOString();
  const session = await agentSessionsRepo.getSessionById(conversation.sessionId);
  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: conversation.openedBy,
    workingDir: session?.cwd || '/tmp',
    jobType: 'agent-turn',
    // Stash conversation context on a custom field; daemon reads it.
    agentTurnPayload: {
      conversationId,
      sessionId: conversation.sessionId,
      claudeSessionId: session?.claudeSessionId,
      content: body.content,
      mode: conversation.mode,
      systemPromptSource: conversation.systemPromptSource,
    },
  } as import('../shared/types/agent-orchestrator').AgentJob);

  await agentConversationsRepo.updateConversationFields(conversationId, {
    messageCount: conversation.messageCount + 1,
    lastActivityAt: now,
  });

  return c.json({ messageId, jobId });
});

// GET /api/conversations/:conversationId/events — Story 3.5.
// Polling-based fallback (SSE on Lambda is non-trivial in our SST setup).
app.get('/api/conversations/:conversationId/events', async (c) => {
  const conversationId = c.req.param('conversationId');
  const conversation = await agentConversationsRepo.getConversationById(conversationId);
  if (!conversation) return c.json({ error: 'Conversation not found' }, 404);

  const sinceParam = c.req.query('since') || '000000';
  // The conversation's events live in agent-events keyed by the agent-turn
  // job. We aggregate across all jobs that mention this conversationId.
  // For v1 simplicity, return events from the most recent agent-turn job.
  // (A real fan-out can be added when the inbox uses these.)
  return c.json({ events: [], lastSeq: sinceParam, conversation });
});

// POST /api/conversations/:conversationId/apply-output — Story 3.6 + Story C.5.
//
// Story C.5 enhancement: when the underlying step is `review` and the job
// was halted with `triggeredBy=REVIEWER_NEEDS_HUMAN`, the operator can pass
// the conversation's last turn text in the request body as `output`. If the
// text contains a parseable `---REVIEW_CRITERIA---` block, the daemon-side
// parser turns it into a deterministic verdict (pass/fail) and we write
// `VERDICT` + `FEEDBACK` onto the underlying job's variables before marking
// it COMPLETED_VIA_SALVAGE. The wave-completion reducer treats SALVAGE the
// same as a success and the wave advances.
//
// Backward compat: omit `output` and the endpoint behaves exactly like the
// original Story 3.6 — trust-the-operator path that just marks SALVAGE.
app.post('/api/conversations/:conversationId/apply-output', async (c) => {
  const conversationId = c.req.param('conversationId');
  const conversation = await agentConversationsRepo.getConversationById(conversationId);
  if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
  if (conversation.status === 'APPLIED') {
    return c.json({ ok: true, idempotent: true });
  }

  // Pull the underlying job so we can find the original step's extractors.
  const job = await agentJobsRepo.getJobById(conversation.jobId);
  if (!job) return c.json({ error: 'Backing job not found' }, 404);
  const step = job.pipeline?.steps?.find((s) => s.id === conversation.stepId);
  if (!step) return c.json({ error: 'Step not found in pipeline' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { output?: string };
  let appliedReviewVerdict:
    | { verdict: string; failedCount: number; humansCount: number }
    | undefined;

  // Story C.5 AC5: parse REVIEW_CRITERIA from the operator's reply when the
  // underlying job was halted on REVIEWER_NEEDS_HUMAN. Only fire when the
  // step is `review` so we don't reinterpret outputs from other talk flows.
  if (
    typeof body.output === 'string' &&
    body.output.length > 0 &&
    conversation.stepId === 'review' &&
    (job as { triggeredBy?: string }).triggeredBy === 'REVIEWER_NEEDS_HUMAN'
  ) {
    const { parseReviewCriteria, aggregateReviewVerdict, formatFailedReasonsForRetry } =
      await import('../shared/services/review-criteria-parser');
    const entries = parseReviewCriteria(body.output);
    const aggregate = aggregateReviewVerdict(entries);
    if (aggregate.verdict === 'pass' || aggregate.verdict === 'fail') {
      const existingVars = (job as { variables?: Record<string, string> }).variables || {};
      const newVars: Record<string, string> = {
        ...existingVars,
        VERDICT: aggregate.verdict === 'pass' ? 'PASS' : 'FAIL',
        FEEDBACK:
          aggregate.verdict === 'pass'
            ? '(operator approved via Talk-to-agent)'
            : formatFailedReasonsForRetry(aggregate.reasons),
        REVIEW_CRITERIA: body.output,
      };
      await agentJobsRepo.updateJobFields(conversation.jobId, {
        // The cast keeps the apply-output handler self-contained; the wider
        // AgentJob type already has `variables?: Record<string, string>`.
        variables: newVars,
      } as unknown as Parameters<typeof agentJobsRepo.updateJobFields>[1]);
      appliedReviewVerdict = {
        verdict: aggregate.verdict,
        failedCount: aggregate.reasons.failed.length,
        humansCount: aggregate.reasons.humans.length,
      };
    }
  }

  // Story 3.6 (FU-5) — operator-driven apply produces a distinct terminal
  // status (`COMPLETED_VIA_TALK`) so the audit trail differentiates Salvage
  // (raw output applied) from Talk (output produced via debug conversation).
  // Both classify as success in the wave reducer (Story 1.1).
  await agentJobsRepo.updateJobFields(conversation.jobId, {
    status: 'COMPLETED_VIA_TALK',
  });
  await agentConversationsRepo.updateConversationFields(conversationId, {
    status: 'APPLIED',
    appliedToJobAt: new Date().toISOString(),
  });

  return c.json({ ok: true, appliedReviewVerdict });
});

// ──────────────────────────────────────────────────────────────────────────
// Pipeline v1 — Epic 2 (Concurrency manager) + Epic 6 (QoS).
// ──────────────────────────────────────────────────────────────────────────

// GET /api/health/concurrency — Story 2.6. Reads the daemon-published
// SessionPool snapshot from the heartbeat row.
app.get('/api/health/concurrency', async (c) => {
  const heartbeat = (await agentJobsRepo.getJobById('DAEMON_HEARTBEAT')) as
    | (import('../shared/types/agent-orchestrator').AgentJob & {
        concurrency?: unknown;
      })
    | null;
  const concurrency = heartbeat?.concurrency || {
    ceiling: 0,
    slotsByClass: {
      interactive: { used: 0, max: 0 },
      critical: { used: 0 },
      background: { used: 0 },
    },
    queueDepth: 0,
    activeTokens: [],
    queued: [],
  };
  return c.json(concurrency);
});

// POST /api/jobs/:jobId/promote-class — Story 2.6 + Story 6.3.
// Updates the job's concurrencyClass. Daemon picks up the new class on the
// next heartbeat / next acquire (queued waiters are re-prioritized).
app.post('/api/jobs/:jobId/promote-class', async (c) => {
  const jobId = c.req.param('jobId');
  const body = (await c.req.json().catch(() => ({}))) as {
    to?: 'interactive' | 'critical' | 'background';
  };
  if (!body.to || !['interactive', 'critical', 'background'].includes(body.to)) {
    return c.json({ error: 'body.to must be interactive | critical | background' }, 400);
  }
  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  await agentJobsRepo.updateJobFields(jobId, { concurrencyClass: body.to });
  return c.json({ ok: true });
});

// POST /api/plans/:id/raise-cost-ceiling — Story 4.3.
app.post('/api/plans/:id/raise-cost-ceiling', async (c) => {
  const planId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    newCeilingUsd?: number;
    reason?: string;
  };
  if (!Number.isFinite(body.newCeilingUsd) || (body.newCeilingUsd ?? 0) <= 0) {
    return c.json({ error: 'body.newCeilingUsd must be a positive number' }, 400);
  }
  const plan = await planRepo.getPlanById(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  await planRepo.updatePlanFields(planId, { costCeilingUsd: body.newCeilingUsd });
  return c.json({ ok: true, newCeilingUsd: body.newCeilingUsd });
});

// POST /api/jobs/:jobId/raise-cost-ceiling — Story 4.3.
app.post('/api/jobs/:jobId/raise-cost-ceiling', async (c) => {
  const jobId = c.req.param('jobId');
  const body = (await c.req.json().catch(() => ({}))) as {
    newCeilingUsd?: number;
    reason?: string;
  };
  if (!Number.isFinite(body.newCeilingUsd) || (body.newCeilingUsd ?? 0) <= 0) {
    return c.json({ error: 'body.newCeilingUsd must be a positive number' }, 400);
  }
  const job = await agentJobsRepo.getJobById(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  await agentJobsRepo.updateJobFields(jobId, { costCeilingUsd: body.newCeilingUsd });
  return c.json({ ok: true, newCeilingUsd: body.newCeilingUsd });
});

// GET /api/profile + PUT /api/profile — Story 6.5.
app.get('/api/profile', async (c) => {
  const userId = c.req.header('x-user-id') || 'system'; // auth middleware fills this
  const user = await userRepo.getUserById(userId);
  return c.json({
    userId,
    email: user?.email || '',
    emailDigestEnabled: (user as { emailDigestEnabled?: boolean })?.emailDigestEnabled ?? false,
    timezone: (user as { timezone?: string })?.timezone ?? 'UTC',
  });
});

app.put('/api/profile', async (c) => {
  const userId = c.req.header('x-user-id') || 'system';
  const body = (await c.req.json().catch(() => ({}))) as {
    emailDigestEnabled?: boolean;
    timezone?: string;
  };
  await userRepo.updateUserProfile(userId, body);
  return c.json({ ok: true });
});

// GET /api/health/cost — Story 4.6 (daily widget data source).
app.get('/api/health/cost', async (c) => {
  const heartbeat = (await agentJobsRepo.getJobById('DAEMON_HEARTBEAT')) as
    | (import('../shared/types/agent-orchestrator').AgentJob & {
        dailyCostUsd?: number;
        dailyCeilingUsd?: number;
      })
    | null;
  return c.json({
    dailyCostUsd: heartbeat?.dailyCostUsd ?? 0,
    dailyCeilingUsd:
      heartbeat?.dailyCeilingUsd ?? Number(process.env.DEFAULT_DAILY_COST_CEILING_USD || '100'),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Pipeline v1 — Story 1.10. Cross-plan attention inbox (v0).
// Aggregate every plan's open attention items into a single feed for the
// operator's sidebar drawer. Per-plan endpoints already exist
// (/api/plans/:id/attention-items); this is the cross-plan rollup.
// ──────────────────────────────────────────────────────────────────────────

app.get('/api/attention', async (c) => {
  const statusFilter = c.req.query('status') || 'open';
  const plans = await planRepo.getAllPlans();
  const items: Array<import('../shared/types/attention').AttentionItem & { planName?: string }> =
    [];
  for (const plan of plans) {
    const planItems = await attentionRepo.listAttentionItems(plan.planId);
    for (const it of planItems) {
      if (statusFilter === 'all' || it.status === statusFilter) {
        items.push({ ...it, planName: plan.name });
      }
    }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({
    items,
    unresolvedCount: items.filter((it) => it.status !== 'resolved').length,
    total: items.length,
  });
});

// ─────────────────────────────────────────────────────────────────────
// App/Plan v1 — Plan lifecycle transitions (Epic 2, Story 2.6)
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/plans/:planId/transition — transition a Plan to a new status,
 * validated against `PLAN_LEGAL_TRANSITIONS`. When transitioning to
 * `abandoned`, the App's workingTreeStatus is flipped to
 * `dirty-from-abandoned-plan` (the daemon then refuses dispatches until
 * the operator clicks "Mark resolved"; see Story 6.5 + Epic 3).
 *
 * Body: `{ to: 'developing' | 'review' | 'delivered' | 'abandoned' | ... }`
 */
app.post('/api/plans/:planId/transition', authMiddleware, async (c) => {
  const planId = c.req.param('planId');
  const body = await c.req.json();
  const to = typeof body?.to === 'string' ? body.to : null;
  if (!to) {
    throw new ValidationError('Body must include `to: <PlanStatus>`.');
  }

  const updated = await planRepo.transitionPlanStatus(planId, to as Plan['status']);

  // App/Plan v1 (Stories 3.3 + 3.1) — when abandoning, atomically:
  //   (a) mark the App's working tree dirty (daemon refuses dispatches)
  //   (b) sweep PENDING jobs for this Plan and mark them ORPHANED
  //
  // v1 uses sequential writes (not a transactWrite) — DDB transactWrite caps
  // at 100 items and a Plan with many PENDING jobs could exceed that. The
  // daemon's canDispatchJob guard is the safety net: any job we miss here
  // gets ORPHANED on its next dispatch attempt.
  if (to === 'abandoned' && updated.appId) {
    await appRepo
      .updateApp(updated.appId, { workingTreeStatus: 'dirty-from-abandoned-plan' })
      .catch((err) => {
        console.error('Failed to mark App workingTreeStatus dirty on abandon:', err);
      });

    // Sweep PENDING jobs for this Plan and mark ORPHANED.
    // AgentJob doesn't carry a top-level `planId` field in v1; jobs link to
    // Plans via their pipeline variables (EPIC_ID → Plan via epic.planId).
    // For the v1 abandon sweep, we rely on the daemon's canDispatchJob guard
    // (Story 3.2) to mark jobs ORPHANED when they next try to dispatch — that
    // path resolves planId from the Plan row and works for every job kind.
    // A direct planId-indexed sweep is a v1.x improvement once the AgentJob
    // schema gains a denormalized planId field.
  }

  return c.json({ plan: updated });
});

// ─────────────────────────────────────────────────────────────────────
// App/Plan v1 — App lifecycle API (Epic 2, Stories 2.1–2.5)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the UI-friendly `derivedStatus` for an App grid card from raw inputs.
 * Order matters: dirty-tree dominates everything else; building dominates live.
 */
function deriveAppStatus(app: App, activePlan: Plan | null): AppCardData['derivedStatus'] {
  if (app.workingTreeStatus === 'dirty-from-abandoned-plan') return 'dirty-tree';
  if (activePlan) return 'building';
  if (app.currentlyDeployedPlanId) return 'live';
  return 'no-deploy';
}

/** GET /api/apps — Apps grid data, enriched with planCount + currentlyLiveLabel + derivedStatus. */
app.get('/api/apps', authMiddleware, async (c) => {
  const apps = await appRepo.listApps();

  const cards: AppCardData[] = await Promise.all(
    apps.map(async (a) => {
      const plans = await planRepo.listPlansByApp(a.appId);
      const activePlan =
        plans.find((p) => ['concept', 'developing', 'review', 'fixing'].includes(p.status)) ?? null;
      const liveplan = a.currentlyDeployedPlanId
        ? plans.find((p) => p.planId === a.currentlyDeployedPlanId)
        : null;
      return {
        ...a,
        planCount: plans.length,
        currentlyLiveLabel: liveplan?.iterationLabel ?? liveplan?.displayName ?? null,
        derivedStatus: deriveAppStatus(a, activePlan),
      };
    }),
  );

  return c.json({ apps: cards });
});

/**
 * POST /api/apps — Pipeline v2 App-bootstrap saga (Stories 1.4.2 + 1.4.4).
 *
 * Saga steps (single in-process flow, in-memory chain — no DDB intermediate):
 *
 *   1. Validate         — Zod, slug regex, slug not in DDB Apps, slug not at
 *                         github.com/futurator-repos/<slug> (404 = available,
 *                         200 = taken → 409). RESERVED_APP_IDS still apply.
 *   2. Create repo      — `createRepoFromTemplate(futurator-repos, <template>,
 *                         <slug>)`. On `existing: true` → 409 with suggestion.
 *   3. Atomic write     — `createAppAndBootstrapJob(app, job)` writes BOTH
 *                         the App row AND the daemon-pickup `app-bootstrap`
 *                         job in one TransactWriteCommand.
 *   4. Rollback (G-7)   — If step 3 throws, delete the GitHub repo via
 *                         `deleteRepo`. If THAT fails, write a high-severity
 *                         attention item flagging the orphaned repo. Either
 *                         way, return 500 to the caller — the rollback's
 *                         success/failure must not mask the original error.
 *
 * Backward compat: legacy callers omit `boilerplateType` / `bmadEnabled`.
 * Defaults applied here: `'nextjs'` and `true` (for the only wired type).
 */
app.post('/api/apps', authMiddleware, async (c) => {
  const body = await c.req.json();
  const parsed = appCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const input = parsed.data;

  // Apply backward-compat defaults BEFORE the saga starts.
  // PR-13 — accept legacy 'nextjs' input via normalizeBoilerplateType.
  const boilerplateType = normalizeBoilerplateType(input.boilerplateType);
  const bmadEnabled =
    input.bmadEnabled ?? (BOILERPLATE_REGISTRY[boilerplateType].bmadSupported ? true : false);

  // ── Step 1: validate ────────────────────────────────────────────────────
  // The Zod schema already enforced slug shape + 80-char display name. Reject
  // reserved slugs (homepage S3 collisions) and DDB collisions before we
  // burn a GitHub API call.
  if (RESERVED_APP_IDS.has(input.appId)) {
    throw new AppError(
      'APP_ID_RESERVED',
      `App slug "${input.appId}" is reserved (collides with homepage S3 paths).`,
      400,
    );
  }
  const existingApp = await appRepo.getApp(input.appId);
  if (existingApp) {
    throw new AppError('APP_ID_TAKEN', `App "${input.appId}" already exists.`, 409);
  }
  // GitHub-side slug check. 404 = available; 200 = taken; anything else
  // bubbles up as a connector GitHubError.
  try {
    await getRepo('futurator-repos', input.appId);
    // Reaching here = 200 = repo exists.
    throw new AppError(
      'REPO_EXISTS',
      `A repo at github.com/futurator-repos/${input.appId} already exists. Pick a different name.`,
      409,
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof GitHubError && err.status === 404) {
      // Available — continue saga.
    } else if (err instanceof GitHubError) {
      // Auth, rate-limit, etc. — surface as the connector status.
      return c.json({ error: { code: 'GITHUB_ERROR', message: err.message } }, err.status as 400);
    } else {
      throw err;
    }
  }

  // ── Step 2: create repo ─────────────────────────────────────────────────
  // boilerplateType is already normalized above; safe to index registry.
  const meta = BOILERPLATE_REGISTRY[boilerplateType as BoilerplateType];
  const [templateOwner, templateRepoName] = meta.templateRepo.split('/');

  let createdRepo: { html_url?: string; default_branch?: string } | undefined;
  try {
    const { data } = await createRepoFromTemplate(templateOwner, templateRepoName, input.appId);
    if ('existing' in data && data.existing) {
      throw new AppError(
        'REPO_EXISTS',
        `A repo at github.com/futurator-repos/${input.appId} already exists. Pick a different name.`,
        409,
      );
    }
    createdRepo = data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof GitHubError) {
      return c.json({ error: { code: 'GITHUB_ERROR', message: err.message } }, err.status as 400);
    }
    throw err;
  }

  // ── Steps 3+4: atomic App row + bootstrap job, with saga rollback ──────
  const now = new Date().toISOString();
  const app: App = {
    appId: input.appId,
    displayName: input.displayName.trim(),
    icon: input.icon,
    workingDir: `/home/ubuntu/projects/${input.appId}`,
    // PR-46 — pipeline is the only supported path; ignore client override.
    // The 'orchestrator' enum value remains in the type union for back-compat
    // with persisted App rows from before PR-46.
    executionMode: 'pipeline',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    boilerplateType,
    bmadEnabled,
    createdAt: now,
    updatedAt: now,
  };

  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    status: 'PENDING' as const,
    createdAt: now,
    updatedAt: now,
    createdBy: c.get('user')?.userId ?? 'system',
    workingDir: app.workingDir,
    jobType: 'app-bootstrap' as const,
    appBootstrapPayload: {
      appId: input.appId,
      boilerplateType,
      bmadEnabled,
      // PR-13 — pass starter pack augment files through to the daemon so it
      // can write them on top of the base after inject-values. Empty for
      // base starters and for stub types.
      augmentFiles: BOILERPLATE_REGISTRY[boilerplateType as BoilerplateType].augmentFiles,
      // Epic 2 Story 2.2 (2026-05-19) — thread the starter's default skill
      // loadout to the daemon's prepin-default-skills step. The daemon
      // can't import the TS registry, so the API Lambda is the canonical
      // reader. `null` for stub boilerplates; `undefined` shouldn't
      // happen now that the field is declared on every starter, but the
      // daemon handles it identically as `no-default-loadout`.
      defaultSkillLoadout:
        BOILERPLATE_REGISTRY[boilerplateType as BoilerplateType].defaultSkillLoadout ?? null,
    },
  };

  try {
    await appRepo.createAppAndBootstrapJob(app, job);
  } catch (txErr) {
    // Rollback: delete the GitHub repo we just created. Best-effort — log
    // failures but do NOT let them swallow the original tx error.
    let rollbackOk = true;
    let rollbackErrMsg: string | undefined;
    try {
      await deleteRepo('futurator-repos', input.appId);
    } catch (delErr) {
      rollbackOk = false;
      rollbackErrMsg = delErr instanceof Error ? delErr.message : String(delErr);
      // Surface the orphaned-repo attention item so an operator can clean up.
      try {
        await attentionRepo.createAttentionItem({
          // We synthesize a planId namespace for App-level items (no Plan
          // exists yet). Stable + greppable.
          planId: `app:${input.appId}`,
          itemId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          severity: 'high',
          category: 'pv2-app-bootstrap-rollback-orphan',
          title: `Orphaned GitHub repo futurator-repos/${input.appId}`,
          body:
            `App-create transaction failed AND the GitHub rollback also failed. ` +
            `The repo is orphaned and must be deleted by hand. ` +
            `Original tx error: ${txErr instanceof Error ? txErr.message : String(txErr)}. ` +
            `Rollback error: ${rollbackErrMsg}`,
          context: { jobId },
          suggestedActions: [
            { label: 'Open repo', kind: 'open-logs' },
            { label: 'Archive', kind: 'archive' },
          ],
          status: 'open',
        });
      } catch {
        // Even attention-write failed — operator-side runbook will catch it.
      }
    }
    const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
    console.error(
      JSON.stringify({
        level: 'error',
        message: `app-create transaction failed`,
        appId: input.appId,
        rollbackOk,
        txError: txMsg,
        rollbackError: rollbackErrMsg,
      }),
    );
    throw new AppError(
      'APP_CREATE_FAILED',
      `Failed to create App "${input.appId}". ${
        rollbackOk
          ? 'GitHub repo was rolled back.'
          : 'GitHub rollback also failed — see attention item for orphan.'
      }`,
      500,
    );
  }

  // 201 with the App row + jobId so the UI can navigate to detail and start
  // polling for the daemon's bootstrap status flip.
  return c.json(
    {
      app,
      jobId,
      // Surface the repo metadata for the UI's "Repository badge" mount.
      repo: createdRepo
        ? {
            htmlUrl: createdRepo.html_url,
            defaultBranch: createdRepo.default_branch,
          }
        : null,
    },
    201,
  );
});

/**
 * Epic 7 (2026-05-20) — /labs/skills observability endpoint.
 *
 * GET /api/apps/:appId/skills/digest
 *
 * Per-app skill activity rollup. Reads (a) the in-app manifest sha + entry
 * counts from the `bootstrappedAt`-fresh worktree by way of the most recent
 * commit metadata trailer on main, and (b) the `Skills-Used:` aggregate
 * from `git log --grep="Skills-Used:"` parsed via the existing commit-
 * metadata helpers.
 *
 * For v1 we keep this LIGHT — the heavy git-log analytics are deferred
 * to follow-on. The endpoint returns:
 *
 *   - manifest: the manifest contents (parsed)
 *   - recentSkillScoutJobs: the last N SKILL-SCOUT job rows for this app
 *   - skillsUsedAggregate: derived from agent-events `skill_activated`
 *     entries across the app's recent plans (Epic 4 source signal)
 */
app.get('/api/apps/:appId/skills/digest', authMiddleware, async (c) => {
  const appId = c.req.param('appId');
  const appRow = await appRepo.getApp(appId);
  if (!appRow) {
    throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
  }

  // Scan agent-jobs for recent SKILL-SCOUT runs on this app's worktree.
  // The job-rows carry the projectSlug under skillScoutPayload.
  const allJobs = await agentJobsRepo.scanAllJobs().catch(() => []);
  const skillScoutJobs = allJobs
    .filter((j) => {
      if (j.jobType !== 'skill-scout') return false;
      const payload = (
        j as unknown as {
          skillScoutPayload?: { projectSlug?: string };
        }
      ).skillScoutPayload;
      return payload?.projectSlug === appId;
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 10)
    .map((j) => {
      const payload = j as unknown as {
        skillScoutPayload?: { trigger?: string; rigor?: string; planId?: string };
        skillScoutDisposition?: string;
        skillScoutProposalCount?: number;
        skillScoutAcceptedCount?: number;
      };
      return {
        jobId: j.jobId,
        status: j.status,
        createdAt: j.createdAt,
        trigger: payload.skillScoutPayload?.trigger ?? null,
        rigor: payload.skillScoutPayload?.rigor ?? null,
        planId: payload.skillScoutPayload?.planId ?? null,
        disposition: payload.skillScoutDisposition ?? null,
        proposalCount: payload.skillScoutProposalCount ?? 0,
        acceptedCount: payload.skillScoutAcceptedCount ?? 0,
      };
    });

  // Plans + agent-events: aggregate skill_activated counts across this app's
  // recent plans for the "what's actually getting used" signal.
  const plans = await planRepo.listPlansByApp(appId).catch(() => []);
  const recentPlanIds = plans
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 5)
    .map((p) => p.planId);

  const activatedCounter = new Map<string, number>();
  for (const planId of recentPlanIds) {
    try {
      // collectRawEvents requires a Plan obj; reuse it by re-fetching.
      const plan = plans.find((p) => p.planId === planId);
      if (!plan) continue;
      // Inline scan of plan jobs' events — same shape collectRawEvents uses
      // (we duplicate the lookup logic here to avoid touching forensic-
      // builder's call site).
      const planJobIds = new Set<string>();
      for (const epicId of plan.epicIds ?? []) {
        const epic = await epicRepo.getEpicById(epicId).catch(() => null);
        for (const story of epic?.stories ?? []) {
          if (story.jobId) planJobIds.add(story.jobId);
        }
      }
      for (const jobId of planJobIds) {
        // Page through events using the existing getEventsAfter helper.
        const accumulated: Array<{
          eventType?: string;
          payload?: { skill?: string; source?: string };
        }> = [];
        try {
          let cursor = '000000';
          // Cap the loop to avoid runaway pagination on huge jobs.
          for (let i = 0; i < 50; i += 1) {
            const { events: batch, lastSeq } = await agentEventsRepo.getEventsAfter(
              jobId,
              cursor,
              200,
            );
            if (batch.length === 0) break;
            accumulated.push(...batch);
            if (lastSeq === cursor) break;
            cursor = lastSeq;
          }
        } catch {
          // Per-job event scan failures are non-fatal.
        }
        const events = accumulated;
        for (const ev of events) {
          if (ev.eventType !== 'skill_activated') continue;
          const skill = ev.payload?.skill;
          const source = ev.payload?.source ?? 'unknown';
          if (typeof skill !== 'string') continue;
          const key = `${skill}@${source}`;
          activatedCounter.set(key, (activatedCounter.get(key) ?? 0) + 1);
        }
      }
    } catch {
      // Per-plan failures are non-fatal — degrade gracefully.
    }
  }
  const skillsUsedAggregate = Array.from(activatedCounter.entries())
    .map(([key, count]) => {
      const [skill, source] = key.split('@');
      return { skill, source, activationCount: count };
    })
    .sort((a, b) => b.activationCount - a.activationCount);

  return c.json({
    appId,
    boilerplateType: appRow.boilerplateType,
    bootstrappedAt: appRow.bootstrappedAt ?? null,
    recentSkillScoutJobs: skillScoutJobs,
    skillsUsedAggregate,
    plansAnalyzed: recentPlanIds.length,
  });
});

/** GET /api/apps/:appId — App detail (App + plans[] + activePlan + recentDeploys). */
app.get('/api/apps/:appId', authMiddleware, async (c) => {
  const appId = c.req.param('appId');
  const appRow = await appRepo.getApp(appId);
  if (!appRow) {
    throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
  }

  const plans = await planRepo.listPlansByApp(appId);
  const activePlan = await planRepo.getActivePlanForApp(appId);

  // Last 5 deploy jobs from App.deployJobIds[]; missing jobs are skipped silently.
  const recentDeployIds = appRow.deployJobIds.slice(-5);
  const recentDeploys = (
    await Promise.all(
      recentDeployIds.map(async (jobId) => {
        try {
          return await agentJobsRepo.getJobById(jobId);
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);

  return c.json({ app: appRow, plans, activePlan, recentDeploys });
});

/** PATCH /api/apps/:appId — Update mutable App fields. */
app.patch('/api/apps/:appId', authMiddleware, async (c) => {
  const appId = c.req.param('appId');
  const body = await c.req.json();
  const parsed = updateAppInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const updated = await appRepo.updateApp(appId, parsed.data);
  return c.json({ app: updated });
});

/** DELETE /api/apps/:appId — Hard delete + cascade to all Plans + their Epics. */
app.delete('/api/apps/:appId', authMiddleware, async (c) => {
  const appId = c.req.param('appId');
  const appRow = await appRepo.getApp(appId);
  if (!appRow) {
    throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
  }

  // Cascade: list Plans, delete each Plan's Epics, delete the Plans, then the App.
  // Sequential (not transactional) — DDB transactWrite caps at 100; cascading
  // an App with many Plans + Epics could exceed it. Partial-failure recovery
  // is via the wipe script (scripts/wipe-pre-app-plan-v1.mjs).
  const plans = await planRepo.listPlansByApp(appId);
  for (const plan of plans) {
    for (const epicId of plan.epicIds || []) {
      await epicRepo.deleteEpic(epicId).catch(() => undefined);
    }
    await planRepo.deletePlan(plan.planId).catch(() => undefined);
  }
  await appRepo.deleteApp(appId);

  return c.json({ deleted: true, appId });
});

/** POST /api/apps/:appId/plans — Create a Plan, enforcing concurrency + initial-uniqueness. */
app.post('/api/apps/:appId/plans', authMiddleware, async (c) => {
  const appId = c.req.param('appId');
  const body = await c.req.json();
  const parsed = createPlanForAppInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }

  const appRow = await appRepo.getApp(appId);
  if (!appRow) {
    throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
  }

  const active = await planRepo.getActivePlanForApp(appId);
  if (active) {
    throw new AppError(
      'PLAN_ALREADY_ACTIVE',
      `App "${appId}" already has an active Plan: ${active.planId} (${active.status}). Finish or abandon it before starting another.`,
      409,
    );
  }

  const existingPlans = await planRepo.listPlansByApp(appId);
  if (parsed.data.kind === 'initial' && existingPlans.length > 0) {
    throw new AppError(
      'INITIAL_PLAN_ALREADY_EXISTS',
      `App "${appId}" already has an initial Plan. Subsequent iterations must be kind=change or kind=experiment.`,
      409,
    );
  }
  if (parsed.data.kind !== 'initial' && existingPlans.length === 0) {
    throw new AppError(
      'FIRST_PLAN_MUST_BE_INITIAL',
      `App "${appId}" has no Plans yet — the first one must be kind=initial.`,
      409,
    );
  }

  const now = new Date().toISOString();
  const planId = `plan_${appId}_${Date.now().toString(36)}`;
  const user = c.get('user');
  // PR-10 #1 — multi-plan-per-app collision fix. The legacy `plan.name`
  // doubled as a slug AND uniqueness key; in App/Plan v1 every plan on
  // the same App should be allowed (they share the App's workingDir).
  // Resolution:
  //   • If operator supplied `name`, use it (validated by the schema).
  //   • Else auto-generate `${appId}-${kind}-${shortHash}` so the second
  //     plan stops colliding with the first.
  // The shared workingDir comes from `appRow.workingDir` regardless of
  // plan.name, so the slug is now purely a label, not a path component.
  const planName =
    parsed.data.name ?? `${appId}-${parsed.data.kind}-${Date.now().toString(36).slice(-5)}`;
  const plan: Plan = {
    planId,
    appId,
    kind: parsed.data.kind,
    name: planName,
    intent: parsed.data.intent,
    description: '',
    displayName: parsed.data.displayName ?? `${appId} — ${parsed.data.kind}`,
    status: 'concept',
    epicIds: [],
    workingDir: appRow.workingDir,
    // PR-46 — pipeline is the only supported path. Ignore the App's
    // persisted executionMode and any client-supplied override; orchestrator
    // is retired. The 'orchestrator' enum value remains for back-compat with
    // existing Plan rows but new Plans always run on the pipeline.
    executionMode: 'pipeline',
    rigor:
      parsed.data.rigor ??
      existingPlans.filter((p) => p.status === 'delivered').at(-1)?.rigor ??
      'mvp',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    // PR-45 — rigor-keyed default cost ceiling (USD). Resolved from the
    // same precedence chain as `rigor` above so an inherited rigor still
    // triggers the matching ceiling.
    costCeilingUsd: defaultCostCeiling(
      parsed.data.rigor ??
        existingPlans.filter((p) => p.status === 'delivered').at(-1)?.rigor ??
        'mvp',
    ),
    createdAt: now,
    updatedAt: now,
    createdBy: user.email,
  };
  await planRepo.createPlan(plan);

  // For kind=initial Plans, enqueue the existing greenfield PM-plan pipeline —
  // same flow as POST /api/plans/from-intent. This generates the epic/story
  // breakdown from intent so the operator doesn't have to click Regenerate
  // manually on their first Plan.
  let pmJobId: string | undefined;
  // PR-23d — auto-launch PM for ALL plan kinds, not just `initial`. Change
  // plans get the brownfield clause; experiment plans skip it. Without
  // this, kind='change' plans landed in `concept` with no PM job and the
  // operator had to click Regenerate to kick the PM off.
  if (
    parsed.data.kind === 'initial' ||
    parsed.data.kind === 'change' ||
    parsed.data.kind === 'experiment'
  ) {
    pmJobId = crypto.randomUUID();
    // PR-5: thread the App's boilerplateType + Plan's rigor into the PM
    // prompt so it generates ACs that match the actual scaffold (not the
    // hardcoded "Vite+React+TS" example from the v1 prompt).
    const pipeline = generatePmPlanPipeline({
      planName: plan.name,
      intent: plan.intent,
      executionMode: plan.executionMode,
      devModel: plan.devModel,
      boilerplateType: appRow.boilerplateType ?? 'nextjs',
      rigor: plan.rigor,
      kind: parsed.data.kind, // PR-23d — brownfield mode for kind='change'.
    });
    await agentJobsRepo.createJob({
      jobId: pmJobId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      createdBy: user.email,
      workingDir: plan.workingDir,
      pipeline,
    });
  }

  // Epic 3 Story 3.4 (2026-05-20) — T2 SKILL-SCOUT enqueue. Runs in
  // parallel to PM so the operator's click-to-Start latency isn't gated
  // by SKILL-SCOUT spawn. The plan-start handler above blocks if a card
  // is open at start time — that's the actual wait gate, not the
  // reducer.
  //
  // We pass an EMPTY YAML scaffold for currentManifestYaml + a
  // placeholder for federationYaml; the daemon's executeAgentStep
  // substitutes the real content from the project's worktree at run
  // time. Same trick as Story 3.3's daemon-side T1 enqueue, but the
  // canonical TS builder is reused here since the API Lambda has the
  // type system available.
  let skillScoutJobId: string | undefined;
  if (parsed.data.kind === 'initial' || parsed.data.kind === 'change') {
    try {
      skillScoutJobId = crypto.randomUUID();
      const scoutPipeline = generateSkillScoutPipeline({
        trigger: 'T2',
        projectSlug: appId,
        planIntent: plan.intent,
        boilerplateKind: (appRow.boilerplateType ?? 'nextjs-base') as BoilerplateType,
        rigor: plan.rigor ?? 'mvp',
        // Empty YAML — daemon refreshes at run time via buildPromptContext.
        currentManifestYaml: '',
        federationYaml: '',
      });
      await agentJobsRepo.createJob({
        jobId: skillScoutJobId,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
        createdBy: user.email,
        workingDir: plan.workingDir,
        jobType: 'skill-scout',
        skillScoutPayload: {
          trigger: 'T2',
          projectSlug: appId,
          appId,
          planId: plan.planId,
          planIntent: plan.intent,
          rigor: plan.rigor ?? 'mvp',
        },
        pipeline: scoutPipeline,
      });
      // Stamp the FK on the plan so /api/plans/:id/start can check it.
      await planRepo.updatePlanFields(plan.planId, {
        pendingSkillScoutJobId: skillScoutJobId,
      });
    } catch (scoutErr) {
      // Non-fatal — plan creation succeeded; the operator can retry
      // T2 manually. Don't surface 5xx for a SKILL-SCOUT enqueue
      // failure on the happy path.
      console.warn(`[POST /api/apps/${appId}/plans] T2 SKILL-SCOUT enqueue failed:`, scoutErr);
      skillScoutJobId = undefined;
    }
  }

  // For kind=change|experiment Plans, the PM-augmentation runtime (AP-D1)
  // is deferred — the Plan stays in `concept` with empty epicIds until the
  // daemon-side handler is wired. Operator can click Regenerate to fall back
  // to the legacy PM flow in the meantime.

  return c.json({ plan, pmJobId, skillScoutJobId }, 201);
});

/**
 * Epic 3 Story 3.5 (2026-05-20) — SKILL-SCOUT decision card action endpoint.
 *
 * POST /api/skill-scout/proposals/:itemId/:action
 *   action ∈ confirm | edit | decline | defer
 *
 *   - confirm: enqueue a skill-install job for ALL proposals on the card;
 *              attention item → resolved
 *   - edit:    enqueue a skill-install job for the subset in
 *              body.acceptedProposals; attention item → resolved
 *   - decline: attention item → resolved (status='resolved'), no install
 *   - defer:   attention item → resolved (status='resolved'), no install
 *
 * The actual manifest write happens on the daemon side (Story 3.6's
 * executeSkillInstallJob); this endpoint only validates the action,
 * resolves the attention item, and queues the job-row.
 */
app.post('/api/skill-scout/proposals/:itemId/:action', authMiddleware, async (c) => {
  const itemId = c.req.param('itemId');
  const action = c.req.param('action');
  if (!['confirm', 'edit', 'decline', 'defer'].includes(action)) {
    throw new ValidationError(
      `action must be one of: confirm | edit | decline | defer (got "${action}")`,
    );
  }

  const planIdHint = c.req.query('planId');
  if (!planIdHint) {
    throw new ValidationError(
      'planId query param is required (attention items are partitioned by planId).',
    );
  }
  const item = await attentionRepo.getAttentionItem(planIdHint, itemId);
  if (!item) {
    throw new NotFoundError('AttentionItem', itemId);
  }
  if (item.category !== 'manifest-change-proposed') {
    throw new ValidationError(
      `attention item category must be manifest-change-proposed (got "${item.category}")`,
    );
  }

  // decline + defer: just resolve the attention item.
  if (action === 'decline' || action === 'defer') {
    await attentionRepo.updateAttentionStatus(item.planId, itemId, 'resolved');
    return c.json({ ok: true, action });
  }

  // confirm + edit: enqueue a skill-install job.
  const body = (await c.req.json().catch(() => ({}))) as {
    acceptedProposals?: unknown;
  };

  const context = (item.context ?? {}) as {
    trigger?: string;
    projectSlug?: string;
    appId?: string;
    proposals?: unknown[];
  };
  if (!Array.isArray(context.proposals) || !context.projectSlug || !context.trigger) {
    throw new ValidationError(
      'attention item context is missing required SKILL-SCOUT fields (proposals/projectSlug/trigger).',
    );
  }

  let acceptedProposals: unknown[];
  if (action === 'confirm') {
    acceptedProposals = context.proposals;
  } else {
    if (!Array.isArray(body.acceptedProposals) || body.acceptedProposals.length === 0) {
      throw new ValidationError(
        '`acceptedProposals` (non-empty array) is required for action=edit.',
      );
    }
    acceptedProposals = body.acceptedProposals;
  }

  const user = c.get('user');
  const now = new Date().toISOString();
  const installJobId = crypto.randomUUID();
  await agentJobsRepo.createJob({
    jobId: installJobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.email,
    workingDir: `/home/ubuntu/projects/${context.projectSlug}`,
    jobType: 'skill-install',
    skillInstallPayload: {
      projectSlug: context.projectSlug,
      appId: context.appId ?? context.projectSlug,
      output: {
        trigger: context.trigger as 'T1' | 'T2',
        projectSlug: context.projectSlug,
        proposals: acceptedProposals as never,
      },
      source: 'operator-confirm',
      originAttentionId: itemId,
    },
  });

  // Resolve the attention item once the job is queued.
  await attentionRepo.updateAttentionStatus(item.planId, itemId, 'resolved');

  return c.json({ ok: true, action, installJobId });
});

/** POST /api/apps/:appId/redeploy — v1 rollback by re-syncing a prior bundle. */
app.post('/api/apps/:appId/redeploy', authMiddleware, async (c) => {
  const appId = c.req.param('appId');
  const body = await c.req.json();
  const deployJobId = typeof body?.deployJobId === 'string' ? body.deployJobId : null;
  if (!deployJobId) {
    throw new ValidationError('deployJobId is required (must be one of App.deployJobIds[]).');
  }

  const appRow = await appRepo.getApp(appId);
  if (!appRow) {
    throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
  }
  if (!appRow.deployJobIds.includes(deployJobId)) {
    throw new AppError(
      'DEPLOY_JOB_NOT_IN_APP_HISTORY',
      `Deploy job "${deployJobId}" is not in this App's deploy history. Cannot re-deploy a bundle that doesn't belong to this App.`,
      400,
    );
  }

  // The actual re-deploy work (S3 sync of the prior bundle to apps/<appId>/)
  // is wired in a follow-up — Epic 2.5 ships the API endpoint + history-list
  // validation; the daemon-side redeploy pipeline lands alongside Epic 4's
  // pipeline plumbing. Returning 202 with sourceDeployJobId for now signals
  // the API contract is ready.
  return c.json({ status: 'accepted', appId, sourceDeployJobId: deployJobId }, 202);
});

// ── Timer Intelligence routes (Story 1.8.3) ──

/**
 * PR-17 — in-memory timing cache (per-Lambda-container).
 *
 * Live plans get polled every 60 s by the frontend; without caching every
 * poll re-runs `sliceForPlan` (~17 DDB reads × 6 jobs for a 6-story run).
 * Lambda warm containers persist module-level state across invocations,
 * so a Map keyed by planId with a short TTL collapses the read cost.
 *
 * Cold start: pays the full slicer cost once (~600 ms). Warm hit: ~5 ms.
 *
 * Terminal plans skip this cache and use the PR-16 S3 snapshot path on
 * `/timing/forensic` instead. The live `/timing` endpoint here only needs
 * to be cheap, not authoritative — wave-boundary updates land within the
 * TTL window naturally.
 */
const TIMING_CACHE_TTL_MS = 30_000;
const timingCache = new Map<string, { payload: unknown; expiresAt: number }>();

// GET /api/plans/:planId/timing
//   Returns per-plan timing aggregate + live status.
//   sliceForPlan collects slices across all jobs in the plan.
//   planTotalMs is derived from the first/last slice timestamps (not plan fields)
//   because AgentJob has no explicit startedAt/endedAt (Story 1.8.2 contract).
//   ?fresh=1 bypasses the in-memory cache (PR-17).
app.get('/api/plans/:planId/timing', async (c) => {
  const planId = c.req.param('planId');
  const skipCache = c.req.query('fresh') === '1';

  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  // PR-17 — try the in-memory cache first. Active polling will hit this
  // path; the slicer only runs on TTL expiry.
  if (!skipCache) {
    const cached = timingCache.get(planId);
    if (cached && cached.expiresAt > Date.now()) {
      return c.json({ ...(cached.payload as object), _cached: true });
    }
  }

  // Pipeline v2.0 PR-6 (F) — wrap the slicer/aggregator pipeline in a try/catch
  // so a single bad event row in DDB (legacy schema, malformed timestamp, etc.)
  // doesn't 500 the whole timing dashboard. Return an empty timing payload
  // with a non-fatal warning instead. Operator still sees the plan; debug
  // info goes to CloudWatch.
  try {
    const slices = await sliceForPlan(planId);
    const aggregate = aggregateByCategory(slices);

    // Wall-clock from first/last slice, not from plan fields
    let planTotalMs = 0;
    if (slices.length >= 2) {
      const first = new Date(slices[0].startedAt).getTime();
      const last = new Date(slices[slices.length - 1].endedAt).getTime();
      planTotalMs = Math.max(0, last - first);
    } else if (slices.length === 1) {
      planTotalMs = slices[0].durationMs;
    }

    const isLive = slices.some((s) => s.isLive === true);
    const payload = { planId, slices, aggregate, planTotalMs, isLive };

    // PR-17 — cache the result. Live plans get TTL; terminal/idle plans
    // don't need the cache because they're stable (the data doesn't change
    // between polls). Skip the cache write on `?fresh=1` so a forced
    // refresh doesn't immediately repopulate stale data.
    if (!skipCache && isLive) {
      timingCache.set(planId, {
        payload,
        expiresAt: Date.now() + TIMING_CACHE_TTL_MS,
      });
      // Cap the cache size; a single Lambda container won't see thousands
      // of distinct plans, but defensive bound prevents runaway memory.
      if (timingCache.size > 100) {
        const firstKey = timingCache.keys().next().value;
        if (firstKey) timingCache.delete(firstKey);
      }
    }

    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[timing] sliceForPlan failed for ${planId}: ${message}. Returning empty payload.`,
    );
    return c.json({
      planId,
      slices: [],
      aggregate: { byCategory: {}, totalMs: 0 },
      planTotalMs: 0,
      isLive: false,
      _warning: `Timing data unavailable: ${message.slice(0, 200)}`,
    });
  }
});

// GET /api/apps/:appId/timing
//   Returns timing summaries for the last 20 completed plans on this App,
//   plus an aggregate summed across those plans.
//   Terminal-success statuses: 'delivered' (v1 happy path).
//   Legacy 'archived' plans are excluded — they may contain abandoned work.
app.get('/api/apps/:appId/timing', async (c) => {
  const appId = c.req.param('appId');

  const app_ = await appRepo.getApp(appId);
  if (!app_) throw new NotFoundError('App', appId);

  // Load all plans for this app, filter to terminal-success, take last 20
  const allPlans = await planRepo.listPlansByApp(appId);
  const TERMINAL_SUCCESS: ReadonlySet<string> = new Set(['delivered']);
  const completed = allPlans
    .filter((p) => TERMINAL_SUCCESS.has(p.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  // Per-plan timing
  const recentPlans: Array<{
    planId: string;
    planLabel: string;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number;
    byCategory: ReturnType<typeof aggregateByCategory>['byCategory'];
  }> = [];

  // Running app-wide aggregate accumulators
  const appTotals: Record<string, number> = {};
  let appTotalMs = 0;

  for (const plan of completed) {
    const slices = await sliceForPlan(plan.planId);
    const agg = aggregateByCategory(slices);

    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let durationMs = 0;

    if (slices.length > 0) {
      startedAt = slices[0].startedAt;
      endedAt = slices[slices.length - 1].endedAt;
      durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
    }

    // Accumulate into app-level totals
    for (const [cat, summary] of Object.entries(agg.byCategory)) {
      appTotals[cat] = (appTotals[cat] ?? 0) + (summary as { totalMs: number }).totalMs;
    }
    appTotalMs += agg.totalMs;

    recentPlans.push({
      planId: plan.planId,
      planLabel: plan.iterationLabel ?? plan.displayName ?? plan.name,
      startedAt,
      endedAt,
      durationMs,
      byCategory: agg.byCategory,
    });
  }

  // Build app-level aggregate with same shape as AggregationResult.byCategory
  const appByCategory = Object.fromEntries(
    Object.entries(appTotals).map(([cat, totalMs]) => [cat, { totalMs, count: 0 }]),
  ) as ReturnType<typeof aggregateByCategory>['byCategory'];

  return c.json({
    appId,
    recentPlans,
    appAggregate: { byCategory: appByCategory, totalMs: appTotalMs },
  });
});

// GET /api/timing/cohort?templateType=<>&planKind=<>&epicCount=<>
//
//   Story 1.8.6: reads from the cron-aggregated TimingSummary DDB table
//   (a single DDB Get, O(1) instead of the previous full scan).
//
//   Returns 422 on invalid params. Returns 404 with { error: 'cohort-insufficient', samples: 0 }
//   when the row is missing or has fewer than THRESHOLDS.minSamples plans.
//
//   The dashboards already render the "accumulating" pill on 404 — the first
//   6 hours after Phase 1 deploy will return 404 for all cohorts until the
//   timing-aggregator cron has run at least once.
app.get('/api/timing/cohort', async (c) => {
  // Validate query params
  const parsed = timingCohortQuerySchema.safeParse({
    templateType: c.req.query('templateType'),
    planKind: c.req.query('planKind'),
    epicCount: c.req.query('epicCount'),
  });
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const { templateType, planKind, epicCount } = parsed.data;

  // Build the cohortKey and look up the pre-aggregated row
  const cohortKey = buildCohortKey(templateType, planKind, epicCount);
  const row = await getCohortByKey(cohortKey);

  if (!row || row.samples < THRESHOLDS.minSamples) {
    return c.json({ error: 'cohort-insufficient', samples: row?.samples ?? 0 }, 404);
  }

  // Re-shape byCategory to the CohortBaseline shape consumers expect:
  //   { medianMs, p90Ms }  (count is internal to the cron)
  const byCategory = Object.fromEntries(
    Object.entries(row.byCategory).map(([cat, stats]) => [
      cat,
      { medianMs: stats.medianMs, p90Ms: stats.p90Ms },
    ]),
  ) as Record<TimerCategory, { medianMs: number; p90Ms: number }>;

  return c.json({
    samples: row.samples,
    medianMs: row.medianMs,
    p90Ms: row.p90Ms,
    byCategory,
  });
});

// GET /api/plans/:planId/timing/forensic
//   Returns a downloadable JSON file shaped for paste-into-Claude analysis.
//   The cohort field is null when there are fewer than 5 matching plans.
//   Content-Disposition triggers a browser download.
//
// PR-16 — terminal-status snapshot cache:
//   When the plan has reached a terminal status (delivered / archived /
//   review with all stories done), the forensic payload is cached at
//   `s3://${FUTURATOR_PUBLIC_BUCKET}/timing/<planId>-forensic.json` after
//   the first computation. Subsequent GETs stream from S3 (~$0 read,
//   ~50 ms vs ~600 ms for live recompute). For non-terminal plans the
//   route always recomputes (data is changing) and never writes a snapshot
//   so we don't poison the cache with mid-run data.
//   ?fresh=1 skips the cache (force-recompute) — useful after a manual
//   regenerate or operator audit.
//
//   Bucket scope: see sst.config.ts permissions block — `timing/*` is a
//   distinct prefix from data/, media/, apps/, knowledge-live/.
const FORENSIC_S3_BUCKET = process.env.FUTURATOR_PUBLIC_BUCKET || 'futurator-ai-website';

function isPlanTerminalForForensic(plan: {
  status?: string;
  doneStories?: number;
  totalStories?: number;
}): boolean {
  if (plan.status === 'delivered' || plan.status === 'archived') return true;
  // 'review' is terminal for snapshot purposes only when every story is done
  // (i.e. the work won't change unless the operator clicks Send Back to Dev,
  // which transitions to 'developing' — at that point we'd want a fresh snapshot).
  if (
    plan.status === 'review' &&
    typeof plan.doneStories === 'number' &&
    typeof plan.totalStories === 'number' &&
    plan.totalStories > 0 &&
    plan.doneStories === plan.totalStories
  ) {
    return true;
  }
  return false;
}

app.get('/api/plans/:planId/timing/forensic', async (c) => {
  const planId = c.req.param('planId');
  const includeEvents = c.req
    .query('include')
    ?.split(',')
    .map((s) => s.trim())
    .includes('events');
  const skipCache = c.req.query('fresh') === '1';
  const filename = `${planId}-forensic.json`;
  const s3Key = `timing/${planId}-forensic.json`;

  // PR-16 — try S3 first (terminal plans only; we never cache live data).
  // Plan freshness is determined by checking the row first; the S3 read is
  // a single GetObject and only happens when we believe it might exist.
  if (!skipCache) {
    try {
      const plan = await planRepo.getPlanById(planId);
      if (plan && isPlanTerminalForForensic(plan)) {
        try {
          const s3 = new S3Client({ region: 'us-east-1' });
          const obj = await s3.send(
            new GetObjectCommand({ Bucket: FORENSIC_S3_BUCKET, Key: s3Key }),
          );
          const cached = await obj.Body?.transformToString();
          if (cached) {
            const parsed = JSON.parse(cached) as Record<string, unknown>;
            // The cached object was written WITH events. Strip on read if
            // the caller didn't ask for them — keeps the cache canonical
            // (a single object) while honouring PR-14d's opt-in default.
            if (!includeEvents) {
              delete parsed.events;
              parsed._note =
                'events[] omitted by default — pass ?include=events for the full payload';
            }
            parsed._fromCache = true;
            return c.body(JSON.stringify(parsed, null, 2), 200, {
              'Content-Type': 'application/json',
              'Content-Disposition': `attachment; filename="${filename}"`,
            });
          }
        } catch (err) {
          // S3 NoSuchKey → fall through to live compute (first-time access).
          // Other errors (perms, network) → also fall through; better to
          // serve fresh data than 500 the operator.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/NoSuchKey|NotFound/i.test(msg)) {
            console.warn(`[forensic-cache] S3 GET failed for ${planId}: ${msg}`);
          }
        }
      }
    } catch (err) {
      // Plan lookup failed — let buildForensicPayload below do its own NotFound check.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[forensic-cache] plan lookup failed for ${planId}: ${msg}`);
    }
  }

  // Story 1.8.6: cohort fetcher now reads from the pre-aggregated TimingSummary
  // table instead of scanning all apps + plans inline.
  const cohortFetcher = async (
    tmplType: string,
    pKind: string,
    epics: number,
  ): Promise<CohortBaseline | null> => {
    const key = buildCohortKey(tmplType, pKind, epics);
    const row = await getCohortByKey(key);
    if (!row || row.samples < THRESHOLDS.minSamples) return null;

    const byCategory = Object.fromEntries(
      Object.entries(row.byCategory).map(([cat, stats]) => [
        cat,
        { medianMs: stats.medianMs, p90Ms: stats.p90Ms },
      ]),
    ) as Record<TimerCategory, { medianMs: number; p90Ms: number }>;

    return {
      samples: row.samples,
      medianMs: row.medianMs,
      p90Ms: row.p90Ms,
      byCategory,
    };
  };

  const payload = await buildForensicPayload(planId, cohortFetcher);
  if (!payload) throw new NotFoundError('Plan', planId);

  // PR-16 — write the snapshot to S3 if the plan is terminal. Always include
  // events in the cached object so future GETs with ?include=events don't
  // need to recompute. Fire-and-forget (don't block the response).
  if (isPlanTerminalForForensic(payload.plan)) {
    const cacheable = JSON.stringify(payload, null, 2);
    const s3 = new S3Client({ region: 'us-east-1' });
    s3.send(
      new PutObjectCommand({
        Bucket: FORENSIC_S3_BUCKET,
        Key: s3Key,
        Body: cacheable,
        ContentType: 'application/json',
        CacheControl: 'private, max-age=0, must-revalidate',
      }),
    ).catch((err) => {
      console.warn(
        `[forensic-cache] S3 PUT failed for ${planId}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  // PR-14d — by default, omit the raw `events[]` array. Slices, aggregate,
  // narrative, and cohort are sufficient for charts + cohort comparisons,
  // and `events` is ~50 % of payload bytes (442 events × full text on the
  // dino-runner-1 export = 9800 lines, halved without). Pass
  // `?include=events` to fetch the full payload for replay/debugging.
  const out: Record<string, unknown> = { ...payload };
  if (!includeEvents) {
    delete out.events;
    out._note = 'events[] omitted by default — pass ?include=events for the full payload';
  }

  return c.body(JSON.stringify(out, null, 2), 200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
});

// ── GitHub connector routes (Story 1.2.4) ──

// GET /api/github/status — public (no auth). Calls checkConnection().
app.get('/api/github/status', async (c) => {
  const result = await checkConnection();
  if (!result.connected) {
    return c.json({ connected: false, error: result.error, rateLimit: result.rateLimit }, 503);
  }
  return c.json({ connected: true, login: result.login, rateLimit: result.rateLimit });
});

// GET /api/github/repos — list all repos in futurator-repos org.
app.get('/api/github/repos', authMiddleware, async (c) => {
  try {
    const { data: repos, rateLimit } = await listRepos();
    return c.json({ repos, rateLimit });
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json({ error: err.message, rateLimit: err.rateLimit }, err.status as 400);
    }
    throw err;
  }
});

// POST /api/github/repos — create a repo from a boilerplate template.
app.post('/api/github/repos', authMiddleware, async (c) => {
  const body = await c.req.json();
  const parsed = githubCreateRepoSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { templateType, name } = parsed.data;

  // PR-13 — accept legacy 'nextjs' input via normalizeBoilerplateType.
  const meta = BOILERPLATE_REGISTRY[normalizeBoilerplateType(templateType)];
  // templateRepo is "futurator-repos/template-nextjs" — split into owner + repo
  const [templateOwner, templateRepo] = meta.templateRepo.split('/');

  try {
    const { data, rateLimit } = await createRepoFromTemplate(templateOwner, templateRepo, name);
    if ('existing' in data && data.existing) {
      return c.json({ error: 'repo-exists', repo: data.repo, rateLimit }, 409);
    }
    return c.json({ repo: data, rateLimit }, 201);
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json({ error: err.message, rateLimit: err.rateLimit }, err.status as 400);
    }
    throw err;
  }
});

// GET /api/github/repos/:owner/:name — single repo metadata.
app.get('/api/github/repos/:owner/:name', authMiddleware, async (c) => {
  const owner = c.req.param('owner');
  const name = c.req.param('name');
  try {
    const { data: repo, rateLimit } = await getRepo(owner, name);
    return c.json({ repo, rateLimit });
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json({ error: err.message, rateLimit: err.rateLimit }, err.status as 400);
    }
    throw err;
  }
});

// GET /api/github/repos/:owner/:name/tree — recursive file tree.
app.get('/api/github/repos/:owner/:name/tree', authMiddleware, async (c) => {
  const owner = c.req.param('owner');
  const name = c.req.param('name');
  const branch = c.req.query('branch');
  try {
    const { data, rateLimit } = await getRepoTree(owner, name, branch);
    return c.json({ tree: data.tree, truncated: data.truncated, count: data.count, rateLimit });
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json({ error: err.message, rateLimit: err.rateLimit }, err.status as 400);
    }
    throw err;
  }
});

// GET /api/github/repos/:owner/:name/files — file content.
app.get('/api/github/repos/:owner/:name/files', authMiddleware, async (c) => {
  const owner = c.req.param('owner');
  const name = c.req.param('name');
  const filePath = c.req.query('path');
  const ref = c.req.query('ref');

  if (!filePath) {
    throw new ValidationError('query param ?path= is required');
  }

  try {
    const { data, rateLimit } = await getFileContent(owner, name, filePath, ref);
    if ('tooLarge' in data && data.tooLarge) {
      return c.json({ tooLarge: true, size: data.size, rateLimit });
    }
    return c.json({ ...data, rateLimit });
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json({ error: err.message, rateLimit: err.rateLimit }, err.status as 400);
    }
    throw err;
  }
});

// GET /api/github/repos/:owner/:name/git-graph — bundled commit/branch/PR
// payload that powers the Plan Dashboard "GitGraph" subtab. One round-trip
// per refresh: parallel calls to /commits, /branches, /pulls, plus a small
// per-branch top-up so feature branches contribute commits the default-
// branch fetch would have missed. Auth-required.
app.get('/api/github/repos/:owner/:name/git-graph', authMiddleware, async (c) => {
  const owner = c.req.param('owner');
  const name = c.req.param('name');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '40', 10) || 40, 5), 100);

  try {
    // Resolve repo first so we know the default branch + can short-circuit
    // 404s with a typed error before burning extra rate-limit on the rest.
    const { data: repo } = await getRepo(owner, name);

    const [commitsRes, branchesRes, pullsRes] = await Promise.all([
      listCommits(owner, name, { sha: repo.default_branch, perPage: limit }),
      listBranches(owner, name),
      listPullRequests(owner, name, { state: 'all', perPage: Math.min(limit, 30) }),
    ]);

    // Top up with commits unique to non-default branches. Cap to a few
    // branches so a runaway repo doesn't trigger many extra API calls.
    const otherBranches = branchesRes.data
      .filter((b) => b.name !== repo.default_branch)
      .slice(0, 5);
    const topupResults = await Promise.all(
      otherBranches.map((b) =>
        listCommits(owner, name, { sha: b.commit.sha, perPage: 10 }).catch(() => null),
      ),
    );

    const merged = new Map<string, GitHubCommit>();
    for (const c of commitsRes.data) merged.set(c.sha, c);
    for (const r of topupResults) {
      if (!r) continue;
      for (const c of r.data) if (!merged.has(c.sha)) merged.set(c.sha, c);
    }

    const finalCommits = [...merged.values()]
      .sort((a, b) => b.commit.author.date.localeCompare(a.commit.author.date))
      .slice(0, limit);

    return c.json({
      repo: {
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description,
        default_branch: repo.default_branch,
        html_url: repo.html_url,
      },
      commits: finalCommits,
      branches: branchesRes.data,
      pullRequests: pullsRes.data,
      rateLimit: pullsRes.rateLimit,
    });
  } catch (err) {
    if (err instanceof GitHubError) {
      return c.json({ error: err.message, rateLimit: err.rateLimit }, err.status as 400);
    }
    throw err;
  }
});

// PUT /api/github/pat — Story 1.7.1. Rotate the GitHub PAT.
// Auth-required. Validates the token against GitHub before writing to SSM.
// The PAT value is NEVER logged, echoed in responses, or stored in DynamoDB.
const rotatePATSchema = z.object({
  pat: z.string().min(1, 'PAT must not be empty'),
});

app.get('/api/github/rotated-at', authMiddleware, async (c) => {
  try {
    const rotatedAt = await readRotatedAt(ssmClient);
    return c.json({ rotatedAt });
  } catch {
    return c.json({ rotatedAt: null });
  }
});

app.put('/api/github/pat', authMiddleware, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }

  const parsed = rotatePATSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }

  // The PAT is used ONLY in the rotatePat call — never logged or returned.
  const { pat: candidateToken } = parsed.data;

  try {
    const result = await rotatePat(candidateToken, ssmClient);
    return c.json({ rotated: true, login: result.login, rotatedAt: result.rotatedAt });
  } catch (err) {
    if (err instanceof InvalidPatError) {
      return c.json({ error: 'invalid-pat', message: err.message }, 422);
    }
    const msg = err instanceof Error ? err.message : 'Unknown error during PAT rotation';
    return c.json({ error: 'rotation-failed', message: msg }, 502);
  }
});

// Global error handler
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400);
  }
  console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack }));
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

// 404 handler
app.notFound((c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: `Route ${c.req.method} ${c.req.path} not found` } },
    404,
  );
});

export { app };
export const handler = handle(app);
