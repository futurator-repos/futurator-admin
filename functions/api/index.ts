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
import {
  bootstrapInputSchema,
  projectIdSchema,
  createSessionInputSchema,
  sessionIdSchema,
  sendMessageInputSchema,
  createPartyProjectInputSchema,
  docUploadUrlInputSchema,
  docSyncInputSchema,
} from '../shared/schemas/party-schema';
import {
  EXPECTED_AGENT_COUNT,
  PARTY_DOC_ALLOWED_CONTENT_TYPES,
  PARTY_DOCS_S3_PREFIX,
} from '../shared/types/party';
import { createAgentJobSchema } from '../shared/schemas/agent-orchestrator-schema';
import { resolveBlockerSchema } from '../shared/schemas/resolve-blocker-schema';
import { validateEpicForOrchestratorStart } from '../shared/services/epic-dev-launcher';
import { launchPipelineWave, findFirstWave } from '../shared/services/pipeline-launcher';
import { launchStoryRerun } from '../shared/services/story-rerun-launcher';
import { launchVisualQa } from '../shared/services/visual-qa-launcher';
import { launchDevServer } from '../shared/services/dev-server-launcher';
import { generateStoryPipeline } from '../shared/pipelines/story-pipeline';
import { aggregateOrchestratorMetrics } from '../shared/services/epic-orchestrator-metrics';
import { enqueueResumeJob } from '../shared/services/resume-job';
import * as epicRepo from '../shared/repositories/epic-workflow-repository';
import * as planRepo from '../shared/repositories/plan-repository';
import * as attentionRepo from '../shared/repositories/attention-items-repository';
import type { AttentionStatus } from '../shared/types/attention';
import { buildQaReport } from '../shared/repositories/qa-report-aggregator';
import {
  parseVisualTests as sharedParseVisualTests,
  buildQaPipeline as sharedBuildQaPipeline,
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
import { generatePlanBuildPipeline } from '../shared/pipelines/plan-build-pipeline';
import { parsePlanOutput, applyPlanOutput } from '../shared/services/plan-generation-service';
import { computePlanWaves, epicsInPlanWave } from '../shared/services/plan-waves';
import type { PipelineDefinition } from '../shared/types/agent-orchestrator';
import { exportPublicProjects } from '../shared/export-public-projects';
import { renderFlatLog, filterEvents } from '../shared/rendering/flat-log';
import type { AgentEvent } from '../shared/types/agent-orchestrator';
import {
  S3Client,
  PutObjectCommand,
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
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { format } from 'date-fns';

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
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
  };

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
  const pipeline = generatePmPlanPipeline({
    planName: plan.name,
    intent: plan.intent,
    executionMode: plan.executionMode,
    devModel: plan.devModel,
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

  return c.json({ planId, pmJobId, plan }, 201);
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

  return c.json({ plan: result.plan, epics: result.epics });
});

// POST /api/plans/:id/regenerate — start a fresh PM-plan job on the same intent.
// Existing epic tree is NOT dropped; the client applies the new output via
// /apply-plan which (as of V1) appends — if the operator wants a clean slate
// they should delete epics first via the UI's tree editor.
app.post('/api/plans/:id/regenerate', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');

  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);
  if (plan.status !== 'concept') {
    throw new ValidationError(`Cannot regenerate a plan in status "${plan.status}" — only concept`);
  }

  const pmJobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const pipeline = generatePmPlanPipeline({
    planName: plan.name,
    intent: plan.intent,
    executionMode: plan.executionMode,
    devModel: plan.devModel,
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

  // 4. Delete EC2 folder (or .trash folder).
  try {
    await deletePlanFolder(plan, { sendSsmCommand, waitForSsmOutput });
    results.push({ step: 'folder', status: 'done' });
  } catch (err) {
    results.push({ step: 'folder', status: 'error', detail: String(err) });
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

  // Collect every jobId we care about: qaJobId, poJobId, waveBuildJobs values.
  const jobIdSet = new Set<string>();
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

// POST /api/plans/:id/qa-review
//   Fans out: enqueues a Visual QA job for every epic with visual tests.
//   Called by the manual "Run QA Review" button AND by the wave-completion
//   cron when plan.autoRunQa is true. Skipped epics (no visual tests or
//   already running) are reported in the response.
app.post('/api/plans/:id/qa-review', async (c) => {
  const planId = c.req.param('id');
  const user = c.get('user');
  const plan = await planRepo.getPlanById(planId);
  if (!plan) throw new NotFoundError('Plan', planId);

  const results: Array<{ epicId: string; jobId?: string; skipped?: string }> = [];
  const now = new Date().toISOString();

  for (const epicId of plan.epicIds ?? []) {
    const epic = await epicRepo.getEpicById(epicId);
    if (!epic) {
      results.push({ epicId, skipped: 'epic-not-found' });
      continue;
    }
    const result = await launchVisualQa(epic, user.userId, now, {
      getJobById: agentJobsRepo.getJobById,
      createJob: agentJobsRepo.createJob,
      parseVisualTests,
      buildQaPipeline,
      uuid: () => crypto.randomUUID(),
    });
    if (!result.ok) {
      results.push({ epicId, skipped: result.message });
      continue;
    }
    const patch: Partial<import('../shared/types/epic-workflow').EpicWorkflow> = {
      qaJobId: result.jobId,
      status: 'in_review',
    };
    if (result.storiesChanged) patch.stories = result.updatedStories;
    await epicRepo.updateEpicFields(epicId, patch);
    results.push({ epicId, jobId: result.jobId });
  }

  return c.json({ planId, results }, 201);
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
  const result = await launchStoryRerun(epic, storyId, user.userId, now, {
    generatePipeline: generateStoryPipeline,
    createJob: agentJobsRepo.createJob,
    uuid: () => crypto.randomUUID(),
  });
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

  const commandId = await sendSsmCommand(bootstrap);
  return c.json({ commandId, message: 'Daemon start command sent' });
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

app.get('/api/ec2/files', async (c) => {
  const { state } = await getInstanceState();
  if (state !== 'running') {
    throw new AppError('EC2_NOT_RUNNING', `EC2 instance is ${state}`, 400);
  }

  const dirPath = c.req.query('path') || '/home/ubuntu';
  // Sanitize: only allow absolute paths, no shell metacharacters
  if (!/^\/[\w/.\-]+$/.test(dirPath)) {
    throw new ValidationError('Invalid path');
  }

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

// ── Apps list (all epics with computed status) ──
app.get('/api/apps', async (c) => {
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
 * Create a brand-new Party project — used to stand up a "canonical" chat
 * project (e.g. bmad-canon) without going through the Plan-creation flow.
 * Upserts the DDB row, then enqueues a bootstrap job with `createFolder=true`
 * so the daemon mkdir's the folder and runs BMAD install + custom-agent
 * injection in one shot.
 */
app.post('/api/party/projects', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createPartyProjectInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid body');
  }
  const projectId = parsed.data.projectId;
  const projectPath = resolvePartyProjectPath(projectId);

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
    partyBootstrapPayload: {
      projectId,
      projectPath,
      forceReinstall: false,
      createFolder: true,
    },
  });

  return c.json({ jobId, projectId, projectPath }, 201);
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

app.get('/api/party/projects/:projectId/sessions', async (c) => {
  const projectId = c.req.param('projectId');
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0]?.message || 'invalid projectId');
  }
  const sessions = await partySessionsRepo.listSessionsByProject(parsed.data);
  return c.json({ sessions });
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

export const handler = handle(app);
