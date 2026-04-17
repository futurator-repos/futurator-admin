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
        IDENTITY_BROKER_URL: 'https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1',
        IDENTITY_BROKER_JWKS_URL:
          'https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1/.well-known/jwks.json',
        IDENTITY_BROKER_CLIENT_ID: 'app_d0eaa7fcc0b74d9301e6b0efe9526b20',
        IDENTITY_BROKER_CLIENT_SECRET: '9YRtqOGPfuJyBsshSVjZXxTKeDQi7LjXOlTa0rlnZQM',
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
        // Story 14-2: invalidate CloudFront cache after S3 write
        {
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::${AWS_ACCOUNT_ID}:distribution/${FUTURATOR_CF_DISTRIBUTION_ID}`,
          ],
        },
        // ec2-auth-lifecycle fix (Option E): admin UI rotates the Anthropic API key
        // used by the EC2 daemon. Parameter is a SecureString so KMS perms are needed.
        // The EC2 instance role reads this same parameter — that policy is attached
        // externally to the instance role (see docs/concepts/ec2-auth-lifecycle-analysis.md).
        {
          actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DescribeParameters'],
          resources: [
            `arn:aws:ssm:us-east-1:${AWS_ACCOUNT_ID}:parameter/futurator/daemon/anthropic-api-key`,
          ],
        },
        {
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [`arn:aws:kms:us-east-1:${AWS_ACCOUNT_ID}:alias/aws/ssm`],
        },
        // EC2 daemon control (develope-it): /api/ec2/status, /api/ec2/enable,
        // /api/ec2/disable, /api/ec2/start-daemon, /api/ec2/refresh-credentials,
        // /api/ec2/set-anthropic-key (SIGUSR1 via SSM Run Command), file browser,
        // CloudWatch metrics. SST rewrites the Lambda inline policy from this
        // list on every deploy, so anything removed here silently breaks the UI.
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
