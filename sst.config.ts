// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'futurator-admin',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: {
          region: 'us-east-1',
        },
      },
    };
  },
  async run() {
    // ──────────────────────────────────────────────────────────────
    // Futurator.ai public homepage publish pipeline (Stories 14-1, 14-2, 13-3)
    // The S3 bucket and CloudFront distribution are externally managed
    // (the futurator.ai homepage is a separate Next.js project deployed
    // independently). Resource discovery on 2026-04-07:
    //   - Bucket:       futurator-ai-website (us-east-1, public-read on /*)
    //   - CF dist:      E1BI1YWMTLSDTE (aliases: futurator.ai, www.futurator.ai)
    //   - Origin:       futurator-ai-website.s3-website-us-east-1.amazonaws.com
    // Bucket already has static-website hosting + public-read bucket policy.
    // ──────────────────────────────────────────────────────────────
    const FUTURATOR_PUBLIC_BUCKET = 'futurator-ai-website';
    const FUTURATOR_CF_DISTRIBUTION_ID = 'E1BI1YWMTLSDTE';
    const AWS_ACCOUNT_ID = '835745294770';

    // ── DynamoDB Tables ──
    const projectsTable = new sst.aws.Dynamo('ProjectsTable', {
      fields: { projectId: 'string' },
      primaryIndex: { hashKey: 'projectId' },
      transform: {
        table: {
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const costsTable = new sst.aws.Dynamo('CostsTable', {
      fields: { projectId: 'string', date: 'string' },
      primaryIndex: { hashKey: 'projectId', rangeKey: 'date' },
      transform: {
        table: {
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const resourcesTable = new sst.aws.Dynamo('ResourcesTable', {
      fields: { projectId: 'string', resourceArn: 'string' },
      primaryIndex: { hashKey: 'projectId', rangeKey: 'resourceArn' },
      transform: {
        table: {
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const auditsTable = new sst.aws.Dynamo('AuditsTable', {
      fields: { projectId: 'string', auditDate: 'string' },
      primaryIndex: { hashKey: 'projectId', rangeKey: 'auditDate' },
      transform: {
        table: {
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const schedulesTable = new sst.aws.Dynamo('SchedulesTable', {
      fields: { scheduleId: 'string' },
      primaryIndex: { hashKey: 'scheduleId' },
      transform: {
        table: {
          billingMode: 'PAY_PER_REQUEST',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const usersTable = new sst.aws.Dynamo('UsersTable', {
      fields: { userId: 'string' },
      primaryIndex: { hashKey: 'userId' },
      transform: {
        table: {
          billingMode: 'PAY_PER_REQUEST',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const alertsTable = new sst.aws.Dynamo('AlertsTable', {
      fields: { alertId: 'string', timestamp: 'string' },
      primaryIndex: { hashKey: 'alertId', rangeKey: 'timestamp' },
      transform: {
        table: {
          billingMode: 'PAY_PER_REQUEST',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Epic Workflows Table (Labs — Agentic Workflow) ──
    const epicWorkflowsTable = new sst.aws.Dynamo('EpicWorkflowsTable', {
      fields: { epicId: 'string' },
      primaryIndex: { hashKey: 'epicId' },
      transform: {
        table: {
          name: 'futurator-epic-workflows',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Project Registry Table (Labs — Brownfield Support) ──
    const projectRegistryTable = new sst.aws.Dynamo('ProjectRegistryTable', {
      fields: { projectId: 'string' },
      primaryIndex: { hashKey: 'projectId' },
      transform: {
        table: {
          name: 'futurator-project-registry',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Agent Orchestrator Tables (Labs) ──
    const agentJobsTable = new sst.aws.Dynamo('AgentJobsTable', {
      fields: { jobId: 'string', status: 'string', createdAt: 'string' },
      primaryIndex: { hashKey: 'jobId' },
      globalIndexes: {
        'status-createdAt-index': { hashKey: 'status', rangeKey: 'createdAt' },
      },
      transform: {
        table: {
          name: 'futurator-agent-jobs',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const agentEventsTable = new sst.aws.Dynamo('AgentEventsTable', {
      fields: { jobId: 'string', eventSeq: 'string' },
      primaryIndex: { hashKey: 'jobId', rangeKey: 'eventSeq' },
      transform: {
        table: {
          name: 'futurator-agent-events',
          billingMode: 'PAY_PER_REQUEST',
          ttl: { attributeName: 'expireAt', enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Labs Party Tables (Epic 15) ──
    const partyProjectsTable = new sst.aws.Dynamo('PartyProjectsTable', {
      fields: { projectId: 'string' },
      primaryIndex: { hashKey: 'projectId' },
      transform: {
        table: {
          name: 'futurator-party-projects',
          billingMode: 'PAY_PER_REQUEST',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const partySessionsTable = new sst.aws.Dynamo('PartySessionsTable', {
      fields: {
        sessionId: 'string',
        GSI1PK: 'string',
        GSI1SK: 'string',
      },
      primaryIndex: { hashKey: 'sessionId' },
      globalIndexes: {
        GSI1: { hashKey: 'GSI1PK', rangeKey: 'GSI1SK' },
      },
      transform: {
        table: {
          name: 'futurator-party-sessions',
          billingMode: 'PAY_PER_REQUEST',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Plan-Based Labs (Epic 17) ──
    // Extended by App/Plan v1 (Story 1.4) with appId-createdAt-index GSI for
    // App-aware queries. Plans now carry an `appId` field linking to an Apps
    // row; the GSI lets `listPlansByApp(appId)` resolve in one Query.
    const plansTable = new sst.aws.Dynamo('PlansTable', {
      fields: {
        planId: 'string',
        appId: 'string',
        createdAt: 'string',
      },
      primaryIndex: { hashKey: 'planId' },
      globalIndexes: {
        'appId-createdAt-index': { hashKey: 'appId', rangeKey: 'createdAt' },
      },
      transform: {
        table: {
          name: 'futurator-plans',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── App/Plan v1 (Story 1.4) — Apps table ──
    // Apps are the immortal top-level unit; Plans are iterations beneath them.
    // Slug is the partition key (URL segment + working-tree folder), no GSIs
    // needed in v1 (single-tenant, table is small). PITR omitted because the
    // table is regenerable from Plans + deploy jobs.
    const appsTable = new sst.aws.Dynamo('AppsTable', {
      fields: { appId: 'string' },
      primaryIndex: { hashKey: 'appId' },
      transform: {
        table: {
          name: 'futurator-apps',
          billingMode: 'PAY_PER_REQUEST',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Attention Inbox (Pipeline Enhancement Plan v2 — Phase A) ──
    // Stores resilience signals (daemon-shutdown-timeout, policy-violation,
    // retry-exhausted, tamper-reverted, budget-warning, etc.). Written by
    // both the API Lambda (reducer path) and the daemon directly (inline
    // signals). Daemon IAM perms for this table are attached to the EC2
    // role `develope-it-ec2-ssm` out-of-band — update that policy whenever
    // this table changes.
    const attentionItemsTable = new sst.aws.Dynamo('AttentionItemsTable', {
      fields: { planId: 'string', itemId: 'string' },
      primaryIndex: { hashKey: 'planId', rangeKey: 'itemId' },
      transform: {
        table: {
          name: 'futurator-attention-items',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Pipeline v2 — Phase 1 (Story 1.1.2) — GitHub PAT secret ──
    // Used by the daemon and API to authenticate GitHub API calls (create repo,
    // push commits, read PR status). Value is set out-of-band by the operator:
    //   npx sst secret set GithubPat <value>          (production stage)
    //   npx sst secret set GithubPat <value> --stage dev  (dev stage)
    // NEVER commit a real PAT value. Local dev falls back to GITHUB_PAT in .env.local.
    const githubPat = new sst.Secret('GithubPat');

    // ── Pipeline v1 — Epic 3 (Talk-to-agent) tables ──
    const agentSessionsTable = new sst.aws.Dynamo('AgentSessionsTable', {
      fields: {
        sessionId: 'string',
        jobId: 'string',
        stepId: 'string',
      },
      primaryIndex: { hashKey: 'sessionId' },
      globalIndexes: {
        'jobId-stepId-index': { hashKey: 'jobId', rangeKey: 'stepId' },
      },
      transform: {
        table: {
          name: 'futurator-agent-sessions',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    const agentConversationsTable = new sst.aws.Dynamo('AgentConversationsTable', {
      fields: {
        conversationId: 'string',
        sessionId: 'string',
      },
      primaryIndex: { hashKey: 'conversationId' },
      globalIndexes: {
        'sessionId-index': { hashKey: 'sessionId' },
      },
      transform: {
        table: {
          name: 'futurator-agent-conversations',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Pipeline v2 Phase 1 — Story 1.8.6: TimingSummary (cron-aggregated cohort baselines) ──
    // PK: cohortKey (<templateType>#<planKind>#<epicCountBucket>), SK: lastUpdated (ISO-8601)
    const timingSummaryTable = new sst.aws.Dynamo('TimingSummaryTable', {
      fields: {
        cohortKey: 'string',
        lastUpdated: 'string',
      },
      primaryIndex: { hashKey: 'cohortKey', rangeKey: 'lastUpdated' },
      transform: {
        table: {
          name: 'futurator-timing-summary',
          billingMode: 'PAY_PER_REQUEST',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── API Lambda ──
    const api = new sst.aws.Function('Api', {
      handler: 'functions/api/index.handler',
      runtime: 'nodejs22.x',
      architecture: 'arm64',
      memory: '256 MB',
      timeout: '30 seconds',
      link: [
        projectsTable,
        costsTable,
        resourcesTable,
        auditsTable,
        schedulesTable,
        usersTable,
        alertsTable,
        agentJobsTable,
        agentEventsTable,
        epicWorkflowsTable,
        projectRegistryTable,
        partyProjectsTable,
        partySessionsTable,
        plansTable,
        appsTable,
        attentionItemsTable,
        agentSessionsTable,
        agentConversationsTable,
        timingSummaryTable,
        githubPat,
      ],
      environment: {
        PROJECTS_TABLE: projectsTable.name,
        COSTS_TABLE: costsTable.name,
        RESOURCES_TABLE: resourcesTable.name,
        AUDITS_TABLE: auditsTable.name,
        SCHEDULES_TABLE: schedulesTable.name,
        USERS_TABLE: usersTable.name,
        ALERTS_TABLE: alertsTable.name,
        AGENT_JOBS_TABLE: agentJobsTable.name,
        AGENT_EVENTS_TABLE: agentEventsTable.name,
        EPIC_WORKFLOWS_TABLE: epicWorkflowsTable.name,
        PROJECT_REGISTRY_TABLE: projectRegistryTable.name,
        PARTY_PROJECTS_TABLE: partyProjectsTable.name,
        PARTY_SESSIONS_TABLE: partySessionsTable.name,
        PLANS_TABLE: plansTable.name,
        APPS_TABLE: appsTable.name,
        ATTENTION_ITEMS_TABLE: attentionItemsTable.name,
        AGENT_SESSIONS_TABLE: agentSessionsTable.name,
        AGENT_CONVERSATIONS_TABLE: agentConversationsTable.name,
        TIMING_SUMMARY_TABLE: timingSummaryTable.name,
        PROJECTS_ROOT: '/home/ubuntu/projects',
        BMAD_VERSION: '6.3.0',
        BMAD_AGENTS_SOURCE: '/home/ubuntu/bmad-agents-source/bmad/agents',
        IDENTITY_BROKER_URL: 'https://auth.futurator.ai/v1',
        IDENTITY_BROKER_JWKS_URL: 'https://auth.futurator.ai/v1/.well-known/jwks.json',
        IDENTITY_BROKER_CLIENT_ID: 'app_0ed7f7e62b277aca1c1d16a8ee370384',
        IDENTITY_BROKER_CLIENT_SECRET: '7_oGr8sFcjcRRcO5Z8W_ZbjAupqfNyoiu0TmvPMRp_Q',
        ALLOWED_ORIGIN: 'https://admin.futurator.ai',
        // Futurator.ai homepage publish pipeline (Stories 14-1, 14-2)
        FUTURATOR_PUBLIC_BUCKET,
        FUTURATOR_CF_DISTRIBUTION_ID,
      },
      permissions: [
        // Story 14-1: write public projects JSON to futurator.ai bucket
        // Story 13-3: pre-signed URL uploads write user media to the same bucket
        // under media/<projectId>/<uuid>.<ext>
        {
          actions: ['s3:PutObject'],
          resources: [
            `arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/data/*`,
            `arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/media/*`,
          ],
        },
        // Party project docs (party-module §doc-upload): presigned PUT + list
        // + delete under party-docs/<projectId>/. Daemon on EC2 pulls these
        // via `aws s3 cp` using its instance role (separate perms below).
        {
          actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
          resources: [`arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/party-docs/*`],
        },
        {
          actions: ['s3:ListBucket'],
          resources: [`arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}`],
          // No prefix condition — Lambda is trusted and we already scope by
          // prefix in the API handler.
        },
        // Story 14-2: invalidate CloudFront cache after S3 write
        {
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::${AWS_ACCOUNT_ID}:distribution/${FUTURATOR_CF_DISTRIBUTION_ID}`,
          ],
        },
        // EC2 daemon control (develope-it): /api/ec2/status, /api/ec2/enable,
        // /api/ec2/disable, /api/ec2/start-daemon, file browser, CloudWatch
        // metrics. Auth is handled OUT-OF-BAND by the operator's Mac helper
        // pushing Keychain OAuth directly to EC2 via SSM — nothing Anthropic-
        // related runs through this Lambda.
        // SST rewrites the Lambda inline policy from this list on every
        // deploy, so anything removed here silently breaks the UI.
        {
          actions: ['ec2:DescribeInstances', 'ec2:StartInstances', 'ec2:StopInstances'],
          resources: ['*'],
        },
        {
          actions: ['ssm:SendCommand', 'ssm:GetCommandInvocation'],
          resources: ['*'],
        },
        {
          actions: ['cloudwatch:GetMetricData'],
          resources: ['*'],
        },
        // Identity Broker management (Phase 1+): the API Lambda calls the
        // broker's self-service GET /apps/{appId} endpoint, which requires
        // the registration key in the X-Registration-Key header. Key lives
        // in SSM as a SecureString so KMS Decrypt is also needed.
        {
          actions: ['ssm:GetParameter'],
          resources: [
            'arn:aws:ssm:us-east-1:835745294770:parameter/futurator-core/prod/REGISTRATION_API_KEY',
          ],
        },
        {
          actions: ['kms:Decrypt'],
          resources: ['arn:aws:kms:us-east-1:835745294770:alias/aws/ssm'],
        },
        // Story 1.7.1: PAT rotation — write the new PAT + rotated-at timestamp
        // to the custom /futurator/_pipeline/* SSM paths.
        {
          actions: ['ssm:PutParameter', 'ssm:GetParameter'],
          resources: ['arn:aws:ssm:us-east-1:835745294770:parameter/futurator/_pipeline/*'],
        },
        // Identity Broker management (Phase 2.5): the Admin UI is the
        // authoritative writer of each app's broker-credentials into
        // Secrets Manager, so consumer apps read the secret at runtime
        // instead of humans copy-pasting it. Path convention is
        // `futurator/{appId-env}/broker-credentials`.
        {
          actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:PutSecretValue',
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret',
            'secretsmanager:UpdateSecret',
            'secretsmanager:TagResource',
          ],
          resources: [
            'arn:aws:secretsmanager:us-east-1:835745294770:secret:futurator/*/broker-credentials-*',
          ],
        },
      ],
      url: {
        cors: {
          allowOrigins: [
            'https://admin.futurator.ai',
            'https://futurator.ai',
            'http://localhost:3000',
          ],
          allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
          allowHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
          allowCredentials: true,
        },
      },
    });

    // ── Auth Callback Lambda ──
    const authCallback = new sst.aws.Function('AuthCallback', {
      handler: 'functions/auth/callback.handler',
      runtime: 'nodejs22.x',
      architecture: 'arm64',
      memory: '256 MB',
      timeout: '10 seconds',
      environment: {
        SSM_PREFIX: '/futurator-admin/prod',
        REDIRECT_BASE_URL: 'https://admin.futurator.ai',
      },
      permissions: [
        {
          actions: ['ssm:GetParameter'],
          resources: ['arn:aws:ssm:us-east-1:835745294770:parameter/futurator-admin/prod/*'],
        },
      ],
      url: true,
    });

    // ── Cron: Cost Aggregator ──
    new sst.aws.Cron('CostAggregator', {
      schedule: 'cron(0 6 * * ? *)',
      function: {
        handler: 'functions/cron/cost-aggregator.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '512 MB',
        timeout: '60 seconds',
        link: [costsTable],
        environment: { COSTS_TABLE: costsTable.name },
        permissions: [
          {
            actions: ['ce:GetCostAndUsage', 'ce:GetCostForecast', 'ce:GetAnomalies'],
            resources: ['*'],
          },
        ],
      },
    });

    // ── Cron: Resource Discoverer ──
    new sst.aws.Cron('ResourceDiscoverer', {
      schedule: 'cron(0 7 * * ? *)',
      function: {
        handler: 'functions/cron/resource-discoverer.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '512 MB',
        timeout: '120 seconds',
        link: [resourcesTable],
        environment: { RESOURCES_TABLE: resourcesTable.name },
        permissions: [
          { actions: ['tag:GetResources'], resources: ['*'] },
          { actions: ['dynamodb:ListTables', 'dynamodb:DescribeTable'], resources: ['*'] },
          { actions: ['s3:ListAllMyBuckets', 's3:GetBucketTagging'], resources: ['*'] },
          {
            actions: ['lambda:ListFunctions', 'lambda:GetFunctionConfiguration'],
            resources: ['*'],
          },
          {
            actions: ['ecs:DescribeClusters', 'ecs:DescribeServices', 'ecs:ListTasks'],
            resources: ['*'],
          },
          { actions: ['ecr:DescribeRepositories', 'ecr:ListImages'], resources: ['*'] },
        ],
      },
    });

    // ── Cron: Tag Auditor ──
    new sst.aws.Cron('TagAuditor', {
      schedule: 'cron(30 7 * * ? *)',
      function: {
        handler: 'functions/cron/tag-auditor.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '512 MB',
        timeout: '60 seconds',
        link: [auditsTable],
        environment: { AUDITS_TABLE: auditsTable.name },
        permissions: [{ actions: ['tag:GetResources'], resources: ['*'] }],
      },
    });

    // ── Cron: User Sync ──
    new sst.aws.Cron('UserSync', {
      schedule: 'cron(0 8 * * ? *)',
      function: {
        handler: 'functions/cron/user-sync.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '256 MB',
        timeout: '30 seconds',
        link: [usersTable],
        environment: {
          USERS_TABLE: usersTable.name,
          COGNITO_USER_POOL_ID: 'us-east-1_djPwzFjUe',
        },
        permissions: [
          {
            actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminGetUser'],
            resources: ['arn:aws:cognito-idp:us-east-1:835745294770:userpool/us-east-1_djPwzFjUe'],
          },
        ],
      },
    });

    // ── Cron: Attention Digest (Pipeline v1, Story 6.4) ──
    // Hourly. Surveys every plan's attention items + per-user
    // emailDigestEnabled flag and (when SES IAM lands) sends a digest.
    new sst.aws.Cron('AttentionDigest', {
      schedule: 'rate(1 hour)',
      function: {
        handler: 'functions/cron/attention-digest.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '256 MB',
        timeout: '60 seconds',
        link: [plansTable, attentionItemsTable, usersTable],
        environment: {
          PLANS_TABLE: plansTable.name,
          ATTENTION_ITEMS_TABLE: attentionItemsTable.name,
          USERS_TABLE: usersTable.name,
        },
        // SES send permission ships when the verified-sender lands; for
        // now the cron logs the digest payload and returns.
      },
    });

    // ── Cron: Wave Completion Check (Story 16.2, extended by Story 17.4 for plan-waves) ──
    // Story 1.8.7: also links timingSummaryTable + appsTable + agentEventsTable
    // so the post-terminal escalator (evaluateThresholds) can read cohort baselines.
    new sst.aws.Cron('WaveCompletionCheck', {
      schedule: 'rate(1 minute)',
      function: {
        handler: 'functions/cron/wave-completion-check.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '256 MB',
        timeout: '120 seconds',
        link: [
          agentJobsTable,
          agentEventsTable,
          epicWorkflowsTable,
          plansTable,
          appsTable,
          attentionItemsTable,
          timingSummaryTable,
        ],
        environment: {
          AGENT_JOBS_TABLE: agentJobsTable.name,
          AGENT_EVENTS_TABLE: agentEventsTable.name,
          EPIC_WORKFLOWS_TABLE: epicWorkflowsTable.name,
          PLANS_TABLE: plansTable.name,
          APPS_TABLE: appsTable.name,
          ATTENTION_ITEMS_TABLE: attentionItemsTable.name,
          TIMING_SUMMARY_TABLE: timingSummaryTable.name,
        },
      },
    });

    // ── Cron: Timing Aggregator (Story 1.8.6 — Pipeline v2 Phase 1) ──
    // Every 6 hours. Scans delivered plans, groups by cohortKey, computes
    // median + P90 per category, upserts one TimingSummary row per cohort
    // with ≥5 samples.
    new sst.aws.Cron('TimingAggregator', {
      schedule: 'rate(6 hours)',
      function: {
        handler: 'functions/cron/timing-aggregator.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '512 MB',
        timeout: '300 seconds',
        link: [
          appsTable,
          plansTable,
          epicWorkflowsTable,
          agentJobsTable,
          agentEventsTable,
          timingSummaryTable,
        ],
        environment: {
          APPS_TABLE: appsTable.name,
          PLANS_TABLE: plansTable.name,
          EPIC_WORKFLOWS_TABLE: epicWorkflowsTable.name,
          AGENT_JOBS_TABLE: agentJobsTable.name,
          AGENT_EVENTS_TABLE: agentEventsTable.name,
          TIMING_SUMMARY_TABLE: timingSummaryTable.name,
        },
      },
    });

    // ── Cron: PAT Age Check (Story 1.7.1 — Pipeline v2 Phase 1) ──
    // Daily. Reads the last PAT rotation timestamp from SSM and writes an
    // attention item when the PAT is approaching or past its quarterly cadence.
    new sst.aws.Cron('PatAgeCheck', {
      schedule: 'cron(0 9 * * ? *)',
      function: {
        handler: 'functions/cron/pat-age-check.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '256 MB',
        timeout: '30 seconds',
        link: [attentionItemsTable],
        environment: {
          ATTENTION_ITEMS_TABLE: attentionItemsTable.name,
        },
        permissions: [
          {
            // Read the rotated-at timestamp + PAT (via SSM).
            // PutParameter is NOT granted here — rotation is API-driven.
            actions: ['ssm:GetParameter'],
            resources: ['arn:aws:ssm:us-east-1:835745294770:parameter/futurator/_pipeline/*'],
          },
        ],
      },
    });

    // ── Schedule Executor ──
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- SST resource: created for deployment side-effect
    const scheduleExecutor = new sst.aws.Function('ScheduleExecutor', {
      handler: 'functions/cron/schedule-executor.handler',
      runtime: 'nodejs22.x',
      architecture: 'arm64',
      memory: '256 MB',
      timeout: '120 seconds',
      link: [schedulesTable],
      environment: { SCHEDULES_TABLE: schedulesTable.name },
      permissions: [
        {
          actions: ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:DescribeInstances'],
          resources: ['*'],
        },
        { actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks'], resources: ['*'] },
        {
          actions: ['route53:ChangeResourceRecordSets'],
          resources: ['arn:aws:route53:::hostedzone/Z002886634JUZ2SIMCMV0'],
        },
        { actions: ['iam:PassRole'], resources: ['*'] },
      ],
    });

    // ── Static Site ──
    const site = new sst.aws.StaticSite('AdminSite', {
      path: '.',
      build: {
        command: 'npm run build',
        output: 'out',
      },
      domain: 'admin.futurator.ai',
      environment: {
        NEXT_PUBLIC_API_URL: api.url,
        NEXT_PUBLIC_AUTH_CALLBACK_URL: authCallback.url,
      },
    });

    return {
      apiUrl: api.url,
      authCallbackUrl: authCallback.url,
      siteUrl: site.url,
    };
  },
});
