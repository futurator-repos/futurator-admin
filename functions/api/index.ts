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
import * as costRepo from '../shared/repositories/cost-repository';
import * as resourceRepo from '../shared/repositories/resource-repository';
import * as auditRepo from '../shared/repositories/audit-repository';
import * as scheduleRepo from '../shared/repositories/schedule-repository';
import * as userRepo from '../shared/repositories/user-repository';
import * as alertRepo from '../shared/repositories/alert-repository';
import * as agentJobsRepo from '../shared/repositories/agent-jobs-repository';
import * as agentEventsRepo from '../shared/repositories/agent-events-repository';
import { createAgentJobSchema } from '../shared/schemas/agent-orchestrator-schema';
import { resolveBlockerSchema } from '../shared/schemas/resolve-blocker-schema';
import { validateEpicForOrchestratorStart } from '../shared/services/epic-dev-launcher';
import { aggregateOrchestratorMetrics } from '../shared/services/epic-orchestrator-metrics';
import { enqueueResumeJob } from '../shared/services/resume-job';
import * as epicRepo from '../shared/repositories/epic-workflow-repository';
import * as registryRepo from '../shared/repositories/project-registry-repository';
import type { EpicStory } from '../shared/types/epic-workflow';
import type { PipelineDefinition } from '../shared/types/agent-orchestrator';
import { exportPublicProjects } from '../shared/export-public-projects';
import { renderFlatLog, filterEvents } from '../shared/rendering/flat-log';
import type { AgentEvent } from '../shared/types/agent-orchestrator';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
  PutParameterCommand,
  GetParameterCommand,
} from '@aws-sdk/client-ssm';
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

function generateStoryPipeline(
  story: EpicStory,
  epicTitle: string,
  workingDir: string,
  opts: {
    devModel?: string;
    devEffort?: string;
    reviewerModel?: string;
    reviewerEffort?: string;
    epicId?: string;
  },
): PipelineDefinition {
  // Derive projectId from workingDir: /home/ubuntu/projects/{name}/
  // Strip trailing slashes before splitting to avoid empty string from pop()
  const projectId = workingDir.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'unknown';

  // Note: compile step definitions below are kept in sync with
  // daemon/pipelines/compile-pipeline.mjs (the canonical reusable module).
  // The daemon imports isCompileStep() and event helpers from those modules.
  // The inline definitions here are the pipeline-generation source of truth
  // since generateStoryPipeline() runs in Lambda (separate from the daemon).

  return {
    // Inject STORY_ID, EPIC_ID, PROJECT_ID into initial variables so they're
    // available throughout the pipeline (e.g., for compile log fallback entries)
    initialVariables: {
      STORY_ID: story.storyId,
      EPIC_ID: opts.epicId || '(not provided)',
      PROJECT_ID: projectId,
    },
    maxIterations: 3,
    agents: {
      DEV: {
        name: 'Developer',
        allowedTools: 'Bash,Read,Edit,Write,Glob,Grep',
        model: opts.devModel || undefined,
      },
      REVIEWER: {
        name: 'Code Reviewer',
        allowedTools: 'Read,Grep,Glob',
        disallowedTools: 'Write,Edit',
        model: opts.reviewerModel || undefined,
      },
      COMPILER: {
        name: 'Knowledge Compiler',
        allowedTools: 'Read,Write,Edit,Glob,Grep',
        // Haiku sufficient for structured markdown — Sonnet caused OOM on t2.micro
        model: 'haiku',
      },
    },
    steps: [
      // 1. Dev implements story
      {
        id: 'dev',
        agentId: 'DEV',
        prompt: `You are a senior developer working on the "${epicTitle}" project.

This is attempt {{ITERATION}} of {{MAX_ITERATIONS}} for this story.

## Story to implement:
${story.title}

${story.description}

## Instructions:
- Implement ONLY this story. Do not work on other stories.
- Working directory: ${workingDir}
- If this is the first story, set up the project structure.
- Output a brief summary of what you did (not full file contents, show diffs or summaries).${
          story.hasBrowserTests
            ? `
- This story has browser-testable criteria (marked [needs_browser=true]). After implementing the code, also output visual test definitions describing how to verify each browser criterion:

---VISUAL_TESTS---
- id: VT-${story.storyId}-1
  criteriaRef: AC-1
  description: "What to verify visually"
  setup: "How to reach the testable state (e.g., load page, navigate to section)"
  action: "none | keypress:Space | click:.selector"
  expect: "What the correct result looks like"
---END_VISUAL_TESTS---

Write one test per needs_browser=true criterion. Be specific about what the visual result should look like.`
            : ''
        }
- End with:
---WORK_SUMMARY---
[Brief summary of files created/modified and what was done]
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
          ...(story.hasBrowserTests && {
            VISUAL_TESTS: {
              type: 'between' as const,
              startDelimiter: '---VISUAL_TESTS---',
              endDelimiter: '---END_VISUAL_TESTS---',
            },
          }),
        },
        validations: [],
      },

      // 2. Code review
      {
        id: 'review',
        agentId: 'REVIEWER',
        prompt: `You are a code reviewer (attempt {{ITERATION}} of {{MAX_ITERATIONS}}).

Review the work done for this story in the project at ${workingDir}.

## Story:
${story.title}

${story.description}

## Developer's summary:
{{WORK_SUMMARY}}

## Review checklist:
1. Do all files mentioned in the acceptance criteria exist?
2. Does the code follow the project structure?
3. Are the acceptance criteria met?
4. Is the code quality acceptable (no obvious bugs, proper types)?${
          story.hasBrowserTests
            ? `
5. This story has browser-testable criteria. Verify the developer included visual test definitions (between ---VISUAL_TESTS--- and ---END_VISUAL_TESTS--- markers) that cover all needs_browser=true criteria. Each test definition must have: id, criteriaRef, description, setup, and expect fields.`
            : ''
        }

Output: VERDICT: PASS or VERDICT: FAIL
Then: FEEDBACK: [specific findings — what passed, what needs fixing]

Be constructive. If the code is close but has minor issues, PASS with suggestions.`,
        extractors: {
          VERDICT: { type: 'regex', pattern: 'VERDICT:\\s*\\*{0,2}(PASS|FAIL)\\*{0,2}' },
          FEEDBACK: { type: 'regex', pattern: 'FEEDBACK:\\s*([\\s\\S]+?)$' },
        },
        validations: [
          { type: 'equals', left: 'VERDICT', right: 'PASS', label: 'Code review approved' },
        ],
        loopTo: 'retry',
      },

      // 3. Dev retry on review failure
      {
        id: 'retry',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `The code reviewer checked your work (attempt {{ITERATION}} of {{MAX_ITERATIONS}}).

Feedback: {{FEEDBACK}}
Verdict: {{VERDICT}}

Fix the issues mentioned. Output only what you changed, then:
---WORK_SUMMARY---
[Updated summary of changes]
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },

      // ── COMPILE phase (non-blocking: failures do NOT fail the story pipeline) ──
      // Note: these inline definitions mirror daemon/pipelines/compile-pipeline.mjs

      // 4. Diff extraction -- identifies changed files
      {
        id: 'compile-diff',
        stepType: 'shell' as const,
        command: `cd ${workingDir} && mkdir -p .mycelium && (git diff --name-status HEAD~1 HEAD 2>/dev/null | { grep -v -E 'node_modules/|\\.git/|knowledge/|\\.mycelium/' || true; } || find . -newer .mycelium/last-compile-marker -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './knowledge/*' -not -path './.mycelium/*' 2>/dev/null | sed 's|^\\./||' | sed 's/^/A\\t/') && touch .mycelium/last-compile-marker`,
        timeout: 15000,
        captureAs: 'DIFF_MANIFEST',
        onFail: { action: 'fail' as const, injectAs: 'COMPILE_DIFF_ERROR' },
      },
      {
        id: 'compile-knowledge',
        stepType: 'agent' as const,
        agentId: 'COMPILER',
        prompt: `You are the Knowledge Compiler for the "${epicTitle}" project.

For each changed file listed in DIFF_MANIFEST below:

1. If a wiki article already exists in knowledge/code/ for this file:
   - UPDATE it: revise Purpose, Dependencies, Dependents, Signals, Missing Signals
   - Update frontmatter: lastMutatedByStory: "${story.storyId}", updated date, maturity score

2. If no article exists:
   - CREATE one following the standard article format
   - Set frontmatter: createdByStory: "${story.storyId}", createdByEpic: "${opts.epicId || '(not provided)'}", type: code, phase: implementation, status: active

3. For deleted files (D status): mark their article status: superseded

4. Extract any architectural DECISIONS from WORK_SUMMARY:
   - Library choices, pattern selections, API design decisions
   - Create/update articles in knowledge/decisions/
   - Link to the code articles that implement them

5. Update knowledge/system/dependency-map.md with new import relationships

6. Update knowledge/index.md — add new articles, update changed entries

7. Append a compilation record to knowledge/log.md:
   | {ISO timestamp} | ${story.storyId} | success | {created}/{updated}/{superseded} | OK |

Use [[wikilinks]] for ALL cross-references (e.g., [[code/src--components--auth.tsx]]).
File naming: knowledge/code/{slug}.md where slug uses -- for path separators.
Article frontmatter fields: title, type, phase, status, maturity, created, updated, createdByEpic, createdByStory, lastMutatedByStory, tags.
Article sections: Purpose, Key Exports, Dependencies (with [[wikilinks]]), Dependents (with [[wikilinks]]), Signals, Missing Signals, Notes.

Working directory: ${workingDir}
Read source files to understand purpose, exports, and imports before writing articles.

## Story Acceptance Criteria
${story.description}

## Changed Files (DIFF_MANIFEST)
\`\`\`
{{DIFF_MANIFEST}}
\`\`\`

## Developer Work Summary
{{WORK_SUMMARY}}`,
        captureAs: 'COMPILE_RESULT',
        extractors: {},
        validations: [],
        onFail: { action: 'fail' as const },
      },
      {
        id: 'compile-sync',
        stepType: 'shell' as const,
        command: `node /home/ubuntu/scripts/graph-sync.mjs --project ${projectId} --knowledge-dir ${workingDir}/knowledge --state-file ${workingDir}/.mycelium/compile-state.json && aws s3 sync ${workingDir}/knowledge/ s3://futurator-ai-website/knowledge-live/${projectId}/ 2>&1 || echo "S3 backup skipped (non-critical)"`,
        timeout: 60000,
        onFail: { action: 'fail' as const, injectAs: 'COMPILE_SYNC_ERROR' },
      },
    ],
  };
}

// ── Wave-level build + server check pipeline ──
function generateWaveBuildPipeline(
  workingDir: string,
  waveNum: number,
  storyTitles: string[],
): PipelineDefinition {
  return {
    maxIterations: 3,
    agents: {
      DEV: {
        name: 'Build Fixer',
        allowedTools: 'Bash,Read,Edit,Write,Glob,Grep',
        model: 'sonnet',
      },
    },
    steps: [
      // 1. Build check
      {
        id: 'build-check',
        stepType: 'shell' as const,
        command: `cd ${workingDir} && npm run build 2>&1`,
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
      // 2. Build fix (loop-only)
      {
        id: 'dev-build-fix',
        agentId: 'DEV',
        prompt: `The project build failed after completing wave ${waveNum} stories:
${storyTitles.map((t) => `- ${t}`).join('\n')}

Build error:
{{BUILD_ERROR}}

Fix ONLY the build errors. Do not refactor or add features.
Working directory: ${workingDir}

---WORK_SUMMARY---
[What you fixed]
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },
      // 3. Server health check
      {
        id: 'server-check',
        stepType: 'shell' as const,
        command: `kill $(lsof -ti:5173) 2>/dev/null; sleep 1; cd ${workingDir} && (npm run dev -- --host 0.0.0.0 &) && STATUS=000; for i in $(seq 1 15); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null); [ "$STATUS" = "200" ] && break; done; kill $(lsof -ti:5173) 2>/dev/null; [ "$STATUS" = "200" ]`,
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
      // 4. Server fix (loop-only)
      {
        id: 'dev-server-fix',
        agentId: 'DEV',
        prompt: `The dev server failed to start after wave ${waveNum}. Error:

{{SERVER_ERROR}}

Fix the issue so the app serves correctly on port 5173.
Working directory: ${workingDir}

---WORK_SUMMARY---
[What you fixed]
---END_WORK_SUMMARY---`,
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
}

// ── Parse visual test definitions from YAML-like text output ──
function parseVisualTests(raw: string): {
  id: string;
  criteriaRef: string;
  description: string;
  setup: string;
  action?: string;
  expect: string;
}[] {
  const tests: {
    id: string;
    criteriaRef: string;
    description: string;
    setup: string;
    action?: string;
    expect: string;
  }[] = [];

  // Split on "- id:" to get individual test blocks
  const blocks = raw.split(/(?=^- id:)/m).filter((b) => b.trim().startsWith('- id:'));

  for (const block of blocks) {
    const id = block.match(/^- id:\s*(.+)/m)?.[1]?.trim() || '';
    const criteriaRef = block.match(/criteriaRef:\s*(.+)/m)?.[1]?.trim() || '';
    const description = block.match(/description:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || '';
    const setup = block.match(/setup:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || '';
    const action = block.match(/action:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const expect = block.match(/expect:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || '';

    if (id && description) {
      tests.push({
        id,
        criteriaRef,
        description,
        setup,
        action: action === 'none' ? undefined : action,
        expect,
      });
    }
  }

  return tests;
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
        prompt: `You are a senior Product Manager. A user has described a product idea. Your job is to create a structured epic with stories, dependencies, and acceptance criteria.

## Product Idea:
${idea}

## Tech Stack:
React + TypeScript + Vite (frontend web app)

## Instructions:
1. Break the idea into 5-10 small, implementable stories
2. The FIRST story must always scaffold the project (npm create vite, folder structure, types)
3. Each subsequent story should create ONE component or module
4. The LAST story should assemble everything in App.tsx
5. Maximize parallelism — stories that don't depend on each other should be in the same wave
6. Each story must have clear, testable acceptance criteria
7. Think about dependencies carefully — a component can only be used if it's been built
8. For each acceptance criterion in each story, classify whether verifying it requires a running browser:
   - needs_browser="true": visual appearance, layout, animations, user interactions, responsive behavior, canvas rendering, CSS styling
   - needs_browser="false": code structure, file existence, types, build success, API logic, package installation, data transformations
9. Add a <testing_profile> section based on the overall app:
   - has_browser_tests: true if ANY criterion across ANY story has needs_browser="true"
   - viewport: recommended viewport size (e.g., "800x600" for games, "1280x720" for dashboards, "375x667" for mobile-first)
   - interaction_model: primary input method ("keyboard", "mouse", "touch", or combinations like "keyboard,mouse")

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
      <description>
        As a user, I want...

        Acceptance Criteria:
        - [needs_browser=false] Component file exists
        - [needs_browser=true] Component renders at correct size
      </description>
    </story>
    <story id="S3">
      <title>Story 3 — Another Component</title>
      <depends_on>S1</depends_on>
      <description>...</description>
    </story>
    <story id="S4">
      <title>Story 4 — Assembly</title>
      <depends_on>S2,S3</depends_on>
      <description>...</description>
    </story>
  </stories>
</epic>

IMPORTANT RULES:
- depends_on uses comma-separated story IDs (S1,S2,S3) or empty for no deps
- Story IDs are S1, S2, S3... (sequential)
- The first story (S1) always has NO dependencies
- The last story assembles everything and depends on all component stories
- Maximize stories that can run in parallel (same wave = same depends_on set)
- Each story should modify 1-3 files maximum
- Every acceptance criterion MUST include the [needs_browser=true/false] prefix
- needs_browser="true" on the criterion tag in <acceptance_criteria> section
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

    return {
      storyId,
      title: storyTitle,
      description: desc,
      dependsOn: depIds,
      criteria,
      hasBrowserTests,
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

  const epicId = crypto.randomUUID();
  const now = new Date().toISOString();

  const epic = await epicRepo.createEpic({
    epicId,
    title: epicTitle,
    description: epicDesc,
    acceptanceCriteria: epicAC,
    workingDir: workingDir || '',
    status: 'draft',
    stories: storiesWithWaves,
    testingProfile,
    yoloMode: !!body.yoloMode,
    devModel: body.devModel,
    devEffort: body.devEffort,
    reviewerModel: body.reviewerModel,
    reviewerEffort: body.reviewerEffort,
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
  });

  return c.json({ epicId: epic.epicId, storiesCount: storiesWithWaves.length }, 201);
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
    yoloMode: !!body.yoloMode,
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

  const user = c.get('user');
  let finalStories = epic.stories;
  let finalStatus = epic.status;
  let needsUpdate = false;

  // ── Sync-on-read: check running stories' job statuses ──
  const syncedStories = await Promise.all(
    epic.stories.map(async (story) => {
      if (story.status !== 'running' || !story.jobId) return story;
      const job = await agentJobsRepo.getJobById(story.jobId);
      if (!job) return story;
      if (job.status === 'COMPLETED') {
        needsUpdate = true;
        const updated: typeof story = { ...story, status: 'done' as const };

        // Extract visual test definitions from job variables if story has browser tests
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
      return story;
    }),
  );
  finalStories = syncedStories;

  // ── Wave build checks: trigger when all stories in a wave complete ──
  if (needsUpdate) {
    const waveBuildJobs = { ...(epic.waveBuildJobs || {}) };
    const waveMap = new Map<number, typeof finalStories>();
    for (const s of finalStories) {
      const w = s.wave ?? 0;
      if (!waveMap.has(w)) waveMap.set(w, []);
      waveMap.get(w)!.push(s);
    }

    for (const [waveNum, waveStories] of waveMap) {
      const waveKey = String(waveNum);
      // Skip if build check already triggered for this wave
      if (waveBuildJobs[waveKey]) continue;
      // Check if all stories in wave are done (not just running/pending)
      const allWaveDone = waveStories.every((s) => s.status === 'done');
      if (!allWaveDone) continue;

      console.log(
        `[Wave ${waveNum}] All ${waveStories.length} stories done — triggering build check`,
      );

      const buildPipeline = generateWaveBuildPipeline(
        epic.workingDir,
        waveNum,
        waveStories.map((s) => s.title),
      );

      const buildJobId = crypto.randomUUID();
      const now = new Date().toISOString();
      await agentJobsRepo.createJob({
        jobId: buildJobId,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
        createdBy: user.userId,
        workingDir: epic.workingDir,
        pipeline: buildPipeline,
      });

      waveBuildJobs[waveKey] = buildJobId;
    }

    // Save if any new wave build jobs were triggered
    if (Object.keys(waveBuildJobs).length !== Object.keys(epic.waveBuildJobs || {}).length) {
      await epicRepo.updateEpicFields(epic.epicId, { waveBuildJobs });
    }
  }

  // ── Session capture: extract session metadata from completed stories ──
  if (needsUpdate) {
    const appName = epic.workingDir.split('/').filter(Boolean).pop() || '';
    if (appName) {
      // Fire-and-forget: capture session data for newly-done stories
      const newlyDone = finalStories.filter(
        (s) =>
          s.status === 'done' &&
          epic.stories.find((os) => os.storyId === s.storyId)?.status === 'running',
      );
      for (const story of newlyDone) {
        if (!story.jobId) continue;
        captureSessionToRegistry(appName, epic, story).catch((err) =>
          console.error(`[Registry] Session capture failed for ${story.storyId}:`, err.message),
        );
      }
    }
  }

  // ── Server-side YOLO: if yoloMode is on, trigger any newly-ready stories ──
  if (epic.yoloMode) {
    const doneSet = new Set(finalStories.filter((s) => s.status === 'done').map((s) => s.storyId));
    const waveBuildJobs = epic.waveBuildJobs || {};

    // Check which waves have passed their build checks
    const waveBuildPassed = new Set<number>();
    for (const [waveKey, jobId] of Object.entries(waveBuildJobs)) {
      const job = await agentJobsRepo.getJobById(jobId);
      if (job?.status === 'COMPLETED') waveBuildPassed.add(Number(waveKey));
    }

    // A story is ready if: deps done AND all dependency waves have passed build checks
    const readyToStart = finalStories.filter((s) => {
      if (s.status !== 'pending' && s.status !== 'failed') return false;
      if (!(s.dependsOn || []).every((d) => doneSet.has(d))) return false;

      // Check that all waves of dependency stories have completed build checks
      const depWaves = new Set<number>();
      for (const depId of s.dependsOn || []) {
        const depStory = finalStories.find((ds) => ds.storyId === depId);
        if (depStory?.wave !== undefined) depWaves.add(depStory.wave);
      }
      for (const w of depWaves) {
        if (waveBuildJobs[String(w)] && !waveBuildPassed.has(w)) return false; // build check running/pending
      }
      return true;
    });

    if (readyToStart.length > 0) {
      console.log(
        `[YOLO] Server triggering ${readyToStart.length} ready stories for epic ${epic.epicId.slice(0, 8)}`,
      );

      for (const story of readyToStart) {
        const pipeline = generateStoryPipeline(story, epic.title, epic.workingDir, {
          devModel: epic.devModel,
          devEffort: epic.devEffort,
          reviewerModel: epic.reviewerModel,
          reviewerEffort: epic.reviewerEffort,
          epicId: epic.epicId,
        });

        const jobId = crypto.randomUUID();
        const now = new Date().toISOString();
        await agentJobsRepo.createJob({
          jobId,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
          createdBy: user.userId,
          workingDir: epic.workingDir,
          pipeline,
        });

        finalStories = finalStories.map((s) =>
          s.storyId === story.storyId ? { ...s, status: 'running' as const, jobId } : s,
        );
        needsUpdate = true;
        console.log(`[YOLO] Server triggered story ${story.storyId} → job ${jobId.slice(0, 8)}`);
      }
    }

    // All stories done AND all wave builds passed → proceed to QA/PO
    const allStoriesDone =
      finalStories.length > 0 && finalStories.every((s) => s.status === 'done');
    const allWaveBuildsPassed =
      Object.keys(waveBuildJobs).length > 0
        ? Object.keys(waveBuildJobs).every((w) => waveBuildPassed.has(Number(w)))
        : true;
    const allDone = allStoriesDone && allWaveBuildsPassed;

    if (allDone) {
      const hasBrowserTests = epic.testingProfile?.hasBrowserTests;

      // Step 1: If has browser tests and no QA job yet → trigger Visual QA
      if (hasBrowserTests && !epic.qaJobId) {
        console.log(`[YOLO] Server triggering Visual QA for epic ${epic.epicId.slice(0, 8)}`);

        // Collect visual tests from stories
        const allVisualTests = finalStories
          .filter((s) => s.visualTests && s.visualTests.length > 0)
          .flatMap((s) =>
            s.visualTests!.map((vt) => ({ ...vt, storyId: s.storyId, storyTitle: s.title })),
          );

        if (allVisualTests.length > 0) {
          const viewport = epic.testingProfile?.viewport || '1280x720';
          const qaPipeline = buildQaPipeline(epic.workingDir, epic.title, viewport, allVisualTests);

          const qaJobId = crypto.randomUUID();
          const now = new Date().toISOString();
          await agentJobsRepo.createJob({
            jobId: qaJobId,
            status: 'PENDING',
            createdAt: now,
            updatedAt: now,
            createdBy: user.userId,
            workingDir: epic.workingDir,
            pipeline: qaPipeline,
          });

          await epicRepo.updateEpicFields(epic.epicId, { qaJobId, status: 'in_review' });
          return c.json({ ...epic, stories: finalStories, qaJobId, status: 'in_review' as const });
        }
      }

      // Step 2: If QA completed, check result before proceeding to PO
      if (epic.qaJobId) {
        const qaJob = await agentJobsRepo.getJobById(epic.qaJobId);
        if (qaJob?.status === 'RUNNING' || qaJob?.status === 'PENDING') {
          // QA still running — return current state
          if (needsUpdate) {
            await epicRepo.updateEpicFields(epic.epicId, {
              stories: finalStories,
              status: 'in_review',
            });
          }
          return c.json({ ...epic, stories: finalStories, status: 'in_review' as const });
        }
        if (qaJob?.status === 'COMPLETED') {
          const qaVerdict = qaJob.variables?.OVERALL_VERDICT;
          if (qaVerdict !== 'PASS') {
            // QA failed — don't trigger PO yet
            if (needsUpdate) {
              await epicRepo.updateEpicFields(epic.epicId, {
                stories: finalStories,
                status: 'fixing',
              });
            }
            return c.json({ ...epic, stories: finalStories, status: 'fixing' as const });
          }
          // QA passed — fall through to PO trigger
        }
        // QA failed to run — fall through to PO anyway
      }

      // Step 3: Trigger PO review (no browser tests, or QA passed)
      if (!epic.poJobId) {
        console.log(`[YOLO] Server triggering PO review for epic ${epic.epicId.slice(0, 8)}`);

        const poPipeline: PipelineDefinition = {
          maxIterations: 1,
          agents: {
            PO: { name: 'Product Owner', allowedTools: 'Read,Grep,Glob,Bash', model: 'opus' },
          },
          steps: [
            {
              id: 'po_review',
              agentId: 'PO',
              prompt: `You are a Product Owner performing final acceptance testing on a completed epic.

## Epic: ${epic.title}

## Description:
${epic.description}

## Acceptance Criteria (must ALL be met):
${epic.acceptanceCriteria}

## Stories that were implemented:
${epic.stories.map((s) => `- ${s.title}`).join('\n')}

## Instructions:
1. The code is in the current working directory (${epic.workingDir}).
2. Read key files to verify the implementation matches the epic description.
3. Run \`npm run build\` or \`tsc --noEmit\` to verify it compiles.
4. Check each acceptance criterion against the actual code.
5. Be strict but fair.

Output format:
---PO_REPORT---
VERDICT: PASS or FAIL

CRITERIA CHECK:
[For each criterion: ✓ or ✗ with brief reason]

OVERALL FEEDBACK:
[2-3 sentences on the delivery]

SUGGESTED NEXT STEPS:
[What would you do next?]
---END_PO_REPORT---`,
              extractors: {
                PO_REPORT: {
                  type: 'between',
                  startDelimiter: '---PO_REPORT---',
                  endDelimiter: '---END_PO_REPORT---',
                },
                VERDICT: { type: 'regex', pattern: 'VERDICT:\\s*\\*{0,2}(PASS|FAIL)\\*{0,2}' },
              },
              validations: [],
            },
          ],
        };

        const poJobId = crypto.randomUUID();
        const now = new Date().toISOString();
        await agentJobsRepo.createJob({
          jobId: poJobId,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
          createdBy: user.userId,
          workingDir: epic.workingDir,
          pipeline: poPipeline,
        });

        await epicRepo.updateEpicFields(epic.epicId, { poJobId });
        return c.json({ ...epic, stories: finalStories, poJobId, status: 'completed' as const });
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

app.post('/api/epic-workflows/:id/stories/:storyId/run', async (c) => {
  const epicId = c.req.param('id');
  const storyId = c.req.param('storyId');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  const story = epic.stories.find((s) => s.storyId === storyId);
  if (!story) throw new NotFoundError('Story', storyId);

  const pipeline = generateStoryPipeline(story, epic.title, epic.workingDir, {
    devModel: epic.devModel,
    devEffort: epic.devEffort,
    reviewerModel: epic.reviewerModel,
    reviewerEffort: epic.reviewerEffort,
    epicId: epic.epicId,
  });

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: epic.workingDir,
    pipeline,
  });

  // Update story status and jobId
  const updatedStories = epic.stories.map((s) =>
    s.storyId === storyId ? { ...s, status: 'running' as const, jobId } : s,
  );
  await epicRepo.updateEpicFields(epicId, { stories: updatedStories, status: 'in_progress' });

  return c.json({ jobId, storyId }, 201);
});

// ── Epic Orchestrator: start a single `phase: 'epic-dev'` job (EO-4.4) ──
// Feature-flagged by `epic.useEpicOrchestrator`. When the flag is off the
// endpoint returns 409 so the UI can fall back to legacy per-story buttons.
app.post('/api/epic-workflows/:id/start', async (c) => {
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

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
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  const poPipeline: PipelineDefinition = {
    maxIterations: 1,
    agents: {
      PO: {
        name: 'Product Owner',
        allowedTools: 'Read,Grep,Glob,Bash',
        model: 'opus',
      },
    },
    steps: [
      {
        id: 'po_review',
        agentId: 'PO',
        prompt: `You are a Product Owner performing final acceptance testing on a completed epic.

## Epic: ${epic.title}

## Description:
${epic.description}

## Acceptance Criteria (must ALL be met):
${epic.acceptanceCriteria}

## Stories that were implemented:
${epic.stories.map((s) => `- ${s.title}`).join('\n')}

## Instructions:
1. The code is in the current working directory (${epic.workingDir}).
2. Read key files to verify the implementation matches the epic description.
3. If this is a Node/TypeScript project, run \`npm run build\` or \`tsc --noEmit\` to verify it compiles.
4. Check each acceptance criterion against the actual code.
5. Be strict but fair. If the criteria are met, pass it.

Output format:
---PO_REPORT---
VERDICT: PASS or FAIL

CRITERIA CHECK:
[For each acceptance criterion, show: ✓ or ✗ and a brief reason]

OVERALL FEEDBACK:
[2-3 sentences on the quality of the delivery]

SUGGESTED NEXT STEPS:
[What would you do next if you were the PO?]
---END_PO_REPORT---`,
        extractors: {
          PO_REPORT: {
            type: 'between',
            startDelimiter: '---PO_REPORT---',
            endDelimiter: '---END_PO_REPORT---',
          },
          VERDICT: { type: 'regex', pattern: 'VERDICT:\\s*\\*{0,2}(PASS|FAIL)\\*{0,2}' },
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
    workingDir: epic.workingDir,
    pipeline: poPipeline,
  });

  await epicRepo.updateEpicFields(epicId, { poJobId: jobId });

  return c.json({ jobId, epicId }, 201);
});

// ── Build Visual QA pipeline definition ──
function buildQaPipeline(
  workingDir: string,
  epicTitle: string,
  viewport: string,
  allVisualTests: {
    id: string;
    description: string;
    setup: string;
    action?: string;
    expect: string;
    storyTitle: string;
  }[],
): PipelineDefinition {
  // Group tests by story for a cleaner summary
  const testSummary = allVisualTests
    .map((t) => `- ${t.id}: ${t.description} (expect: ${t.expect})`)
    .join('\n');

  return {
    maxIterations: 1,
    agents: {
      QA: {
        name: 'Visual QA Tester',
        allowedTools: 'Bash,Read,Write,Glob',
        model: 'sonnet',
      },
    },
    steps: [
      // 1. Start dev server
      {
        id: 'qa-start-server',
        stepType: 'shell' as const,
        command: `kill $(lsof -ti:5173) 2>/dev/null; sleep 1; cd ${workingDir} && (npm run dev -- --host 0.0.0.0 &) && STATUS=000; for i in $(seq 1 20); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null); [ "$STATUS" = "200" ] && break; done; [ "$STATUS" = "200" ]`,
        timeout: 45000,
        captureAs: 'SERVER_STATUS',
        onFail: { action: 'fail' as const, injectAs: 'SERVER_ERROR' },
      },

      // 2. QA Agent — simple screenshot + evaluation approach
      {
        id: 'qa-evaluate',
        agentId: 'QA',
        prompt: `You are a Visual QA Tester. The app "${epicTitle}" is running at http://localhost:5173.
Viewport: ${viewport}

## Your Task
Take screenshots of the app's main states and evaluate visual quality. Do NOT write complex test scripts.

## Simple Approach — use these exact commands:

1. Take a screenshot of the main page:
\`\`\`bash
npx playwright screenshot --viewport-size="${viewport}" http://localhost:5173 /tmp/vt-screenshots/main.png 2>&1
\`\`\`

2. Check that the screenshot was created:
\`\`\`bash
ls -la /tmp/vt-screenshots/
\`\`\`

3. Read the app's source code to understand what SHOULD render:
\`\`\`bash
cat ${workingDir}/src/App.tsx
\`\`\`

4. Use the DOM to verify key elements exist on the page:
\`\`\`bash
npx playwright evaluate --viewport-size="${viewport}" "document.querySelectorAll('[data-testid]').length + ' testids, ' + document.querySelectorAll('canvas, svg, img').length + ' visual elements'" http://localhost:5173 2>&1
\`\`\`

## Visual Tests to Evaluate:
${testSummary}

## How to Evaluate
- Read App.tsx to understand expected visual structure
- The screenshot confirms the app renders without blank screen / crash
- DOM queries confirm key elements exist
- If the app shows content (not blank/error), most visual criteria PASS
- Only FAIL tests where the expected element is clearly missing from the code

## Output Format
---QA_REPORT---
OVERALL_VERDICT: PASS or FAIL

SCREENSHOT: /tmp/vt-screenshots/main.png (captured: yes/no)
DOM_ELEMENTS: [count of data-testid, visual elements found]

RESULTS:
${allVisualTests.map((t) => `- ${t.id}: PASS or FAIL — [one-line observation]`).join('\n')}

FAILED_TESTS:
[comma-separated IDs or "none"]

OBSERVATIONS:
[1-2 sentences on overall visual quality]
---END_QA_REPORT---`,
        extractors: {
          QA_REPORT: {
            type: 'between',
            startDelimiter: '---QA_REPORT---',
            endDelimiter: '---END_QA_REPORT---',
          },
          OVERALL_VERDICT: {
            type: 'regex',
            pattern: 'OVERALL_VERDICT:\\s*\\*{0,2}(PASS|FAIL)\\*{0,2}',
          },
          FAILED_TESTS: {
            type: 'regex',
            pattern: 'FAILED_TESTS:\\s*([\\s\\S]*?)(?:\\n\\n|\\nOBSERVATIONS:)',
          },
        },
        validations: [],
      },

      // 3. Kill dev server
      {
        id: 'qa-stop-server',
        stepType: 'shell' as const,
        command: `kill $(lsof -ti:5173) 2>/dev/null; echo "Server stopped"`,
        timeout: 5000,
      },
    ],
  };
}

// ── Visual QA: run consolidated visual testing after all stories complete ──
app.post('/api/epic-workflows/:id/visual-qa', async (c) => {
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  // Collect visual tests from stories — backfill from jobs if not yet stored
  let storiesUpdated = false;
  const enrichedStories = await Promise.all(
    epic.stories.map(async (story) => {
      if (story.visualTests && story.visualTests.length > 0) return story;
      if (!story.hasBrowserTests || !story.jobId) return story;
      const job = await agentJobsRepo.getJobById(story.jobId);
      const rawVT = job?.variables?.VISUAL_TESTS;
      if (!rawVT) return story;
      const parsed = parseVisualTests(rawVT);
      if (parsed.length > 0) {
        storiesUpdated = true;
        return { ...story, visualTests: parsed };
      }
      return story;
    }),
  );

  if (storiesUpdated) {
    await epicRepo.updateEpicFields(epicId, { stories: enrichedStories });
  }

  const allVisualTests = enrichedStories
    .filter((s) => s.visualTests && s.visualTests.length > 0)
    .flatMap((s) =>
      s.visualTests!.map((vt) => ({ ...vt, storyId: s.storyId, storyTitle: s.title })),
    );

  if (allVisualTests.length === 0) {
    return c.json(
      {
        error:
          'No visual tests defined in any story. Dev agents may not have produced VISUAL_TESTS output.',
      },
      400,
    );
  }

  const viewport = epic.testingProfile?.viewport || '1280x720';
  const qaPipeline = buildQaPipeline(epic.workingDir, epic.title, viewport, allVisualTests);

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId,
    workingDir: epic.workingDir,
    pipeline: qaPipeline,
  });

  await epicRepo.updateEpicFields(epicId, { qaJobId: jobId, status: 'in_review' });

  return c.json({ jobId, epicId }, 201);
});

// ── Start Dev Server: launch `npm run dev` in background and capture URL ──
app.post('/api/epic-workflows/:id/dev-server', async (c) => {
  const epicId = c.req.param('id');
  const user = c.get('user');

  const epic = await epicRepo.getEpicById(epicId);
  if (!epic) throw new NotFoundError('EpicWorkflow', epicId);

  const devServerPipeline: PipelineDefinition = {
    maxIterations: 1,
    agents: {
      OPS: {
        name: 'DevOps',
        allowedTools: 'Bash',
        model: 'haiku',
      },
    },
    steps: [
      {
        id: 'start_server',
        agentId: 'OPS',
        prompt: `You are a DevOps agent. Start the dev server for the project in the current working directory (${epic.workingDir}).

Instructions:
1. First, check if package.json exists with: \`cat package.json | head -20\`
2. If node_modules is missing, run \`npm install\` first.
3. Start the dev server in background with --host 0.0.0.0 so it's accessible externally:
   \`nohup npm run dev -- --host 0.0.0.0 > /tmp/futurator-devserver.log 2>&1 & echo "PID=$!"\`
4. Wait 8 seconds for the server to boot: \`sleep 8\`
5. Read the log to find the URL: \`cat /tmp/futurator-devserver.log\`
6. Get the public IP of this machine: \`curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo localhost\`
7. The URL should use the public IP, not localhost.

Output format:
DEV_SERVER_URL: http://[PUBLIC_IP]:5173
DEV_SERVER_PID: [the PID you captured]
STATUS: running

If you fail, output:
STATUS: failed
REASON: [what went wrong]`,
        extractors: {
          DEV_SERVER_URL: { type: 'regex', pattern: 'DEV_SERVER_URL:\\s*(https?://[^\\s]+)' },
          DEV_SERVER_PID: { type: 'regex', pattern: 'DEV_SERVER_PID:\\s*(\\d+)' },
          STATUS: { type: 'regex', pattern: 'STATUS:\\s*(\\w+)' },
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
    workingDir: epic.workingDir,
    pipeline: devServerPipeline,
  });

  return c.json({ jobId, epicId }, 201);
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

  // Pull latest daemon code from S3 (in case it was updated) then start the service
  const bootstrap = [
    'cd /opt/futurator-daemon',
    'sudo aws s3 cp s3://futurator-admin-production-adminsiteassetsbucket-czucfmdf/develope-it/agent-daemon.mjs ./agent-daemon.mjs',
    'sudo chown ubuntu:ubuntu ./agent-daemon.mjs',
    'sudo systemctl restart futurator-daemon',
    'sleep 2',
    'sudo systemctl is-active futurator-daemon',
  ].join(' && ');

  const commandId = await sendSsmCommand(bootstrap);
  return c.json({ commandId, message: 'Daemon start command sent' });
});

const ANTHROPIC_KEY_SSM_PARAM = '/futurator/daemon/anthropic-api-key';

// Admin UI rotates the Anthropic API key the daemon uses (Option E in
// ec2-auth-lifecycle-analysis.md). The daemon re-reads SSM every 10 min so no
// restart is needed — in-flight jobs keep running with the current process env,
// and newly spawned claude subprocesses pick up the rotated key.
app.post('/api/ec2/set-anthropic-key', async (c) => {
  const { apiKey } = (await c.req.json()) as { apiKey?: string };
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return c.json({ error: { code: 'MISSING', message: 'apiKey is required' } }, 400);
  }
  if (!/^sk-ant-(api03|admin)-/.test(trimmed)) {
    return c.json(
      {
        error: {
          code: 'INVALID_FORMAT',
          message: 'Expected an Anthropic API key (sk-ant-api03-...)',
        },
      },
      400,
    );
  }
  await ssmClient.send(
    new PutParameterCommand({
      Name: ANTHROPIC_KEY_SSM_PARAM,
      Value: trimmed,
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  // Tell the daemon to hot-reload immediately via SIGUSR1 (handled in
  // daemon/agent-daemon.mjs). Fire-and-forget — if the instance is stopped
  // or the daemon isn't running, the next SSM polling cycle (2 min) will
  // still pick up the new key on startup.
  let signalSent = false;
  try {
    const { state } = await getInstanceState();
    if (state === 'running') {
      await sendSsmCommand("pkill -USR1 -f 'agent-daemon.mjs' || true");
      signalSent = true;
    }
  } catch (err) {
    console.warn('SIGUSR1 dispatch failed (non-fatal):', err);
  }

  return c.json({
    ok: true,
    param: ANTHROPIC_KEY_SSM_PARAM,
    signalSent,
    message: signalSent
      ? 'API key stored. Daemon was signalled — the new key should be live in ~5s.'
      : 'API key stored. Daemon will load it on next SSM poll (≤2 min) or when it starts.',
  });
});

app.get('/api/ec2/anthropic-key-status', async (c) => {
  try {
    const { Parameter } = await ssmClient.send(
      new GetParameterCommand({ Name: ANTHROPIC_KEY_SSM_PARAM, WithDecryption: false }),
    );
    const v = Parameter?.Value || '';
    return c.json({
      exists: true,
      param: ANTHROPIC_KEY_SSM_PARAM,
      lastModified: Parameter?.LastModifiedDate || null,
      preview: v ? `${v.slice(0, 12)}…${v.slice(-4)}` : null,
    });
  } catch (err) {
    const name = (err as { name?: string }).name || '';
    if (name === 'ParameterNotFound') {
      return c.json({ exists: false, param: ANTHROPIC_KEY_SSM_PARAM });
    }
    throw err;
  }
});

app.post('/api/ec2/refresh-credentials', async (c) => {
  const { state } = await getInstanceState();
  if (state !== 'running') {
    return c.json(
      { error: { code: 'NOT_RUNNING', message: `Instance is ${state}, not running` } },
      400,
    );
  }

  const { credentials } = (await c.req.json()) as { credentials: string };
  if (!credentials?.trim()) {
    return c.json({ error: { code: 'MISSING', message: 'Credentials payload required' } }, 400);
  }

  // Write credentials to EC2 via SSM using base64 to avoid shell escaping issues.
  // Claude CLI reads .credentials.json per-invocation, so we intentionally DO NOT
  // restart the daemon here — restarting would SIGTERM every in-flight agent job
  // (see ec2-auth-lifecycle-analysis.md Problem 3). The next spawned claude
  // process will pick up the new file automatically.
  const b64 = Buffer.from(credentials.trim()).toString('base64');
  const writeCmd = [
    `echo '${b64}' | base64 -d > /home/ubuntu/.claude/.credentials.json`,
    'chown ubuntu:ubuntu /home/ubuntu/.claude/.credentials.json',
    'chmod 600 /home/ubuntu/.claude/.credentials.json',
  ].join(' && ');

  const commandId = await sendSsmCommand(writeCmd);
  return c.json({
    commandId,
    message: 'Credentials written. In-flight jobs were NOT interrupted.',
  });
});

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
          DEPLOY_URL: { type: 'regex', pattern: 'DEPLOY_URL:\\s*(https?://[^\\s]+)' },
          DEPLOY_STATUS: { type: 'regex', pattern: 'DEPLOY_STATUS:\\s*(\\w+)' },
          DEPLOY_DETAILS: { type: 'regex', pattern: 'DEPLOY_DETAILS:\\s*(.+)' },
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
