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
    // 2026-05-17 — production-only deploy guard.
    //
    // The shared DynamoDB tables (`futurator-agent-jobs`, `futurator-plans`,
    // `futurator-epic-workflows`, etc.) are declared with hardcoded
    // `transform.table.name` values — no stage namespacing. Any stage that
    // deploys cron Lambdas (especially WaveCompletionCheck at rate(1 min))
    // writes to the SAME production data plane. This was the root cause of
    // the snake-1 bifurcation: a stale `ricardoarayafarias` stage's cron
    // ran 2026-04-28 code that pre-dated the substrate work, racing the
    // production cron on wave-advancement and writing 8-step legacy job
    // shapes into `futurator-agent-jobs`.
    //
    // Until the shared tables are stage-namespaced (a much larger refactor
    // that would require new env vars + daemon table-name discovery), the
    // only safe stage to deploy infra to is `production`. Local development
    // uses `sst dev` (live-Lambda mode, no infra changes); operator-side
    // experiments should run on a fork or against a personal AWS account.
    //
    // This guard refuses to provision any resource when the stage isn't
    // `production`. Reachable via:
    //   `sst deploy --stage <foo>`  → fatal.
    //   `sst deploy`                → uses default stage (`production` per
    //                                  the user's CLI config) → fine.
    //   `sst dev`                   → runs only the linked Lambda locally,
    //                                  doesn't reach this code path.
    // ──────────────────────────────────────────────────────────────
    if ($app.stage !== 'production') {
      throw new Error(
        `[sst.config] Stage "${$app.stage}" is not allowed to deploy infrastructure. ` +
          `The shared agent/plan/epic DynamoDB tables are NOT stage-namespaced — ` +
          `deploying crons or the API Lambda from this stage would write to ` +
          `production data and reintroduce the 2026-05-17 bifurcation. ` +
          `If you need an isolated environment, fork the repo to a separate AWS ` +
          `account; if you just want local dev, use \`sst dev\` (live-Lambda mode).`,
      );
    }

    // ──────────────────────────────────────────────────────────────
    // PR-61 (2026-05-13) — build version stamp.
    //
    // Compute the git short hash + ISO timestamp at deploy time and pipe
    // them into the API Lambda's env so `/api/health` can report which
    // build is live. The Sidebar fetches /api/health and cross-checks
    // against its own `NEXT_PUBLIC_BUILD_HASH` (set in next.config.ts)
    // so the operator can visually confirm the running build matches
    // what they just deployed.
    //
    // Mirror of the logic in next.config.ts so both sides stamp the
    // *same* commit (assuming a clean working tree). Dirty trees get a
    // `-dirty` suffix so the hash doesn't lie.
    // ──────────────────────────────────────────────────────────────
    const { execSync: _execSync } = await import('node:child_process');
    const _gitHash = (() => {
      try {
        return _execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
      } catch {
        return 'dev';
      }
    })();
    const _gitDirty = (() => {
      try {
        return _execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0
          ? '-dirty'
          : '';
      } catch {
        return '';
      }
    })();
    const BUILD_HASH = _gitHash + _gitDirty;
    const BUILD_TIME = new Date().toISOString();

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

    // ── Party Mode — Inline Q&A (text-selection mini-panel) ──
    // Stores per-selection follow-up questions answered by direct calls to the
    // Anthropic API (not the Claude CLI). Anchored to a session + roundId +
    // snippet so the UI can scroll the chat back to the highlight on click.
    // PK: questionId. GSI: sessionId-createdAt-index → list per session, newest-first.
    const partyInlineQuestionsTable = new sst.aws.Dynamo('PartyInlineQuestionsTable', {
      fields: {
        questionId: 'string',
        sessionId: 'string',
        createdAt: 'string',
      },
      primaryIndex: { hashKey: 'questionId' },
      globalIndexes: {
        'sessionId-createdAt-index': { hashKey: 'sessionId', rangeKey: 'createdAt' },
      },
      transform: {
        table: {
          name: 'futurator-party-inline-questions',
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

    // ── Wave Conflict Events (Story C — agentic-integration, 2026-05-29) ──
    // Durable, queryable record of every wave-merge conflict (and, if a
    // future Phase-2 MERGER agent ever auto-resolves, every resolution).
    // This IS the "data on how common conflicts are" that worktree-rollout-
    // design.md §2 named as the precondition for ever revisiting
    // auto-resolution. PK = planId (operator "conflicts in this plan" query);
    // SK = conflictId (ULID-shape). GSI appId-createdAt for the cross-plan
    // conflict-rate view. Written by the daemon directly (inline, on the
    // halt path) — the EC2 role `develope-it-ec2-ssm` needs PutItem + Query
    // on this table, attached OUT-OF-BAND (same as futurator-attention-items;
    // update that policy whenever this table changes). PITR on: losing
    // conflict telemetry would silently re-open the door to a
    // pressure-driven auto-resolution reversal with no data.
    const waveConflictsTable = new sst.aws.Dynamo('WaveConflictsTable', {
      fields: { planId: 'string', conflictId: 'string', appId: 'string', createdAt: 'string' },
      primaryIndex: { hashKey: 'planId', rangeKey: 'conflictId' },
      globalIndexes: {
        'appId-createdAt-index': { hashKey: 'appId', rangeKey: 'createdAt' },
      },
      transform: {
        table: {
          name: 'futurator-wave-conflicts',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Epic 6 — Story 6.5: consent-gated PROPAGATOR proposals ──
    // Substrate-targeted port-briefs filed as PROPOSED sibling stories awaiting
    // operator approve/reject. PK = proposalId. Low volume (a handful per wave
    // gate). PITR enabled — losing an approved propagation decision would
    // silently re-brief the same change.
    const propagatorProposalsTable = new sst.aws.Dynamo('PropagatorProposalsTable', {
      fields: { proposalId: 'string' },
      primaryIndex: { hashKey: 'proposalId' },
      transform: {
        table: {
          name: 'futurator-propagator-proposals',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ── Pipeline v2 Phase 3 — Story 3-E-3-1 (PR-76): Reflection Inbox ──
    // REFLECTOR proposals stored per-project. PK = projectSlug (Query for
    // labs UI per-project view); SK = id (ULID-shape, sort-friendly).
    // Cross-project list at /labs/reflections uses Scan — proposal volume
    // is low (single-digit per plan-close). PITR enabled because losing
    // operator-confirmed proposals would silently regress the knowledge
    // ratchet.
    const reflectionsTable = new sst.aws.Dynamo('ReflectionsTable', {
      fields: { projectSlug: 'string', id: 'string' },
      primaryIndex: { hashKey: 'projectSlug', rangeKey: 'id' },
      transform: {
        table: {
          name: 'futurator-reflections',
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

    // ── Party Mode — Anthropic API key for inline Q&A on text selections ──
    // Set with:
    //   npx sst secret set AnthropicApiKey <sk-ant-…> --stage production
    // Local dev fallback: ANTHROPIC_API_KEY in .env.local (used by the Hono
    // app when it can't read the secret-resolved Lambda env var).
    const anthropicApiKey = new sst.Secret('AnthropicApiKey');

    // ── Story 15.4 — Brownfield Party PAT ──
    // Fine-grained GitHub PAT scoped contents:read on the four target repos
    // (debatator, applicator, songster, futurator). Loaded once at daemon
    // startup; used to clone private repos into PROJECTS_ROOT/<projectId>.
    // Set with:
    //   npx sst secret set BrownfieldGithubPat <github_pat_…> --stage production
    // The daemon's IAM role needs secretsmanager:GetSecretValue on this ARN
    // (granted via sst link below — sst.Secret IAM is auto-resolved for
    // linked functions; the EC2 daemon reads BROWNFIELD_PAT_SECRET_NAME from
    // its env and calls GetSecretValueCommand directly).
    const brownfieldGithubPat = new sst.Secret('BrownfieldGithubPat');

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

    // ──────────────────────────────────────────────────────────────
    // Story 18.2 — FreeAgentSessionsTable (Epic 18: Free Claude Code Agent)
    //
    // One row per free-agent session. PK is the session UUID. Two GSIs:
    //   - operator-recent-index: for "my recent sessions" (Story 18.6 list UI)
    //   - scope-recent-index: for "conversations about this plan / app"
    // 90-day TTL on `expiresAt` (epoch seconds) keeps the table bounded.
    //
    // The FreeAgentSessionRole (Story 18.1) already grants r/w on this table
    // by NAME — creating it here activates those permissions.
    // ──────────────────────────────────────────────────────────────
    const freeAgentSessionsTable = new sst.aws.Dynamo('FreeAgentSessionsTable', {
      fields: {
        sessionId: 'string',
        operatorId: 'string',
        scopeIdComposite: 'string',
        lastActivityAt: 'string',
      },
      primaryIndex: { hashKey: 'sessionId' },
      globalIndexes: {
        'operator-recent-index': { hashKey: 'operatorId', rangeKey: 'lastActivityAt' },
        'scope-recent-index': { hashKey: 'scopeIdComposite', rangeKey: 'lastActivityAt' },
      },
      ttl: 'expiresAt',
      transform: {
        table: {
          name: 'futurator-free-agent-sessions',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────
    // Story 18.6 — FreeAgentConversationsTable (Epic 18: Free Claude Code Agent)
    //
    // One row per message in a free-agent session. PK is the sessionId; SK is
    // a zero-padded 6-digit messageIndex so Query returns messages sorted
    // ascending. 90-day TTL on `expiresAt` (epoch seconds) keeps the table
    // bounded; conversation history outlasts the 7-day agent-events TTL.
    //
    // v1 writes USER messages from the API layer (POST /messages). Assistant-
    // message writes from the daemon are deferred to v1.1.
    // ──────────────────────────────────────────────────────────────
    const freeAgentConversationsTable = new sst.aws.Dynamo('FreeAgentConversationsTable', {
      fields: {
        sessionId: 'string',
        messageIndex: 'string',
      },
      primaryIndex: { hashKey: 'sessionId', rangeKey: 'messageIndex' },
      ttl: 'expiresAt',
      transform: {
        table: {
          name: 'futurator-free-agent-conversations',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────
    // 2026-05-27 PR B — AgentFlagsTable
    //
    // Global feature flags read by the daemon before claiming PENDING jobs.
    // v1 key: `agent.paused` ('true' | 'false'). Future keys: `agent.daily-
    // spend-cap`, `agent.max-concurrent-override`, etc. Single-row reads;
    // no GSI; no TTL. PK is the flag name. Cached 5s in the daemon.
    //
    // Writes only from API admin routes (/api/admin/pause + /resume). Reads
    // from daemon (pre-claim gate) + API GET (header pill displays state).
    // ──────────────────────────────────────────────────────────────
    const agentFlagsTable = new sst.aws.Dynamo('AgentFlagsTable', {
      fields: { flagName: 'string' },
      primaryIndex: { hashKey: 'flagName' },
      transform: {
        table: {
          name: 'futurator-agent-flags',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────
    // 2026-05-27 PR D.a — RemediationPoliciesTable
    //
    // Per-AttentionCategory mapping to a remediation policy
    // ('manual' | 'auto-draft' | 'auto-fix'). The daemon's attention-
    // poller (PR D.b) uses this to decide whether to spawn a free-agent
    // session for newly-opened items. Operator-managed via the Settings
    // → Agent → Remediation Policies panel.
    //
    // v1: all categories default to 'manual' on first read (the repo's
    // `getPolicy()` returns 'manual' for absent rows). Operator graduates
    // individual categories as confidence builds.
    // ──────────────────────────────────────────────────────────────
    const remediationPoliciesTable = new sst.aws.Dynamo('RemediationPoliciesTable', {
      fields: { category: 'string' },
      primaryIndex: { hashKey: 'category' },
      transform: {
        table: {
          name: 'futurator-remediation-policies',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────
    // 2026-05-27 PR D.f — PushSubscriptionsTable
    //
    // One row per device. PK subscriptionId (uuid). Body holds the
    // PushSubscription endpoint + keys returned by the browser's
    // pushManager.subscribe() call. GSI1 by operatorId so the
    // push-sender can resolve "all devices for this operator" in one
    // query.
    //
    // No TTL — operators may use the same browser for months. Stale
    // subscriptions (404 from the Push gateway) are pruned by the
    // push-sender on the next send attempt.
    // ──────────────────────────────────────────────────────────────
    const pushSubscriptionsTable = new sst.aws.Dynamo('PushSubscriptionsTable', {
      fields: {
        subscriptionId: 'string',
        operatorId: 'string',
      },
      primaryIndex: { hashKey: 'subscriptionId' },
      globalIndexes: {
        'operator-index': { hashKey: 'operatorId' },
      },
      transform: {
        table: {
          name: 'futurator-push-subscriptions',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────
    // 2026-05-27 PR C.e — FixCyclesTable
    //
    // One row per (planId, waveNumber) pair tracking how many free-agent
    // fix-attempt PRs have targeted that wave failure. At 3 attempts, the
    // 4th /open-pr against the same wave returns 409 CYCLE_CAP_EXHAUSTED
    // and writes an attention item ("3 fix attempts exhausted on plan X
    // wave Y — manual investigation needed").
    //
    // Per §9.5 RESOLVED: the cap applies ONLY to pipeline-v2 wave fixes
    // (sessions whose `/open-pr` carries `targetWaveFailure` metadata).
    // Greenfield/brownfield module-development sessions are uncapped here;
    // the daily-spend cap is their only backstop.
    //
    // 30-day TTL on `expiresAt`: a wave that drifts 30 days without retry
    // is effectively abandoned; we re-claim the row.
    // ──────────────────────────────────────────────────────────────
    const fixCyclesTable = new sst.aws.Dynamo('FixCyclesTable', {
      fields: { cycleKey: 'string' },
      primaryIndex: { hashKey: 'cycleKey' },
      ttl: 'expiresAt',
      transform: {
        table: {
          name: 'futurator-fix-cycles',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────
    // 2026-05-27 PR B — AgentSpendLogTable
    //
    // One row per completed agent job — wall-clock × per-second cost.
    // Per §9.5 RESOLVED: per-job wall-clock seconds × $0.02/sec (configurable
    // via env AGENT_COST_PER_SEC). GSI1 (date, createdAt) for "today's
    // accumulated spend" query. 90d TTL on `expiresAt` (epoch seconds).
    //
    // PR B writes the rows + read-only daily-spend pill. PR C enforces the
    // cap (refuses new sessions when getDailySpend(today) > AGENT_DAILY_CAP).
    // ──────────────────────────────────────────────────────────────
    const agentSpendLogTable = new sst.aws.Dynamo('AgentSpendLogTable', {
      fields: {
        logId: 'string',
        GSI1PK: 'string',
        GSI1SK: 'string',
      },
      primaryIndex: { hashKey: 'logId' },
      globalIndexes: {
        'date-createdAt-index': { hashKey: 'GSI1PK', rangeKey: 'GSI1SK' },
      },
      ttl: 'expiresAt',
      transform: {
        table: {
          name: 'futurator-agent-spend-log',
          billingMode: 'PAY_PER_REQUEST',
          pointInTimeRecovery: { enabled: true },
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────
    // Story 18.1 — FreeAgentSessionRole (Epic 18: Free Claude Code Agent)
    //
    // A standalone IAM role assumed per-session by the free-agent chat
    // widget. Each session gets its own short-lived STS credentials
    // (1h max) carrying session tags (`project`, `sessionId`, `operator`)
    // that resolve into the inline permissions policy at runtime — so
    // S3 reads are scoped to the session's project and DDB writes are
    // restricted to the session's own conversation rows.
    //
    // Trust: any IAM role in this account whose ARN matches the API
    //        Lambda's name prefix (`futurator-admin-production-Api*`).
    //        Caller must set all three session tags (project / sessionId
    //        / operator) per the inline policy's Null condition.
    // Scope: read-only on shared pipeline state; own-conversation
    //        writes only; explicit deny on iam/secretsmanager/lambda
    //        destructive actions.
    //
    // The new free-agent DDB tables (`futurator-free-agent-sessions`,
    // `futurator-free-agent-conversations`) are referenced here by NAME;
    // they are introduced in Stories 18.2 and 18.6 respectively. IAM
    // permissions on a not-yet-existing table are legal — they become
    // effective when the table is created.
    // ──────────────────────────────────────────────────────────────
    const accountId = aws.getCallerIdentityOutput().accountId;

    const freeAgentSessionRole = new aws.iam.Role('FreeAgentSessionRole', {
      name: 'futurator-free-agent-session',
      description: 'Story 18.1 - per-session role for the Free Claude Code Agent widget',
      maxSessionDuration: 3600,
      assumeRolePolicy: accountId.apply((acctId) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'TrustApiLambdaWithSessionTags',
              Effect: 'Allow',
              Principal: { AWS: `arn:aws:iam::${acctId}:root` },
              Action: ['sts:AssumeRole', 'sts:TagSession'],
              Condition: {
                StringLike: {
                  'aws:PrincipalArn': `arn:aws:iam::${acctId}:role/futurator-admin-production-Api*`,
                },
                Null: {
                  'aws:RequestTag/project': 'false',
                  'aws:RequestTag/sessionId': 'false',
                  'aws:RequestTag/operator': 'false',
                },
              },
            },
          ],
        }),
      ),
      tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
    });

    new aws.iam.RolePolicy('FreeAgentSessionRolePolicy', {
      role: freeAgentSessionRole.id,
      policy: accountId.apply((acctId) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'ReadProjectKnowledgeLive',
              Effect: 'Allow',
              Action: ['s3:GetObject'],
              Resource: [
                `arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/knowledge-live/\${aws:PrincipalTag/project}/*`,
              ],
            },
            {
              Sid: 'ListProjectKnowledgeLive',
              Effect: 'Allow',
              Action: ['s3:ListBucket'],
              Resource: [`arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}`],
              Condition: {
                StringLike: {
                  's3:prefix': ['knowledge-live/${aws:PrincipalTag/project}/*'],
                },
              },
            },
            {
              Sid: 'ReadPipelineState',
              Effect: 'Allow',
              Action: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
              Resource: [
                `arn:aws:dynamodb:us-east-1:${acctId}:table/futurator-agent-jobs`,
                `arn:aws:dynamodb:us-east-1:${acctId}:table/futurator-agent-jobs/index/*`,
                `arn:aws:dynamodb:us-east-1:${acctId}:table/futurator-attention-items`,
                `arn:aws:dynamodb:us-east-1:${acctId}:table/futurator-plans`,
                `arn:aws:dynamodb:us-east-1:${acctId}:table/futurator-free-agent-conversations`,
                `arn:aws:dynamodb:us-east-1:${acctId}:table/futurator-free-agent-sessions`,
              ],
            },
            {
              Sid: 'WriteOwnConversations',
              Effect: 'Allow',
              Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
              Resource: [
                `arn:aws:dynamodb:us-east-1:${acctId}:table/futurator-free-agent-conversations`,
              ],
              Condition: {
                'ForAllValues:StringEquals': {
                  'dynamodb:LeadingKeys': ['${aws:PrincipalTag/sessionId}'],
                },
              },
            },
            {
              Sid: 'ExplicitDenyDestructive',
              Effect: 'Deny',
              Action: [
                'iam:*',
                'lambda:UpdateFunctionCode',
                'lambda:DeleteFunction',
                'secretsmanager:GetSecretValue',
                'secretsmanager:PutSecretValue',
                's3:DeleteObject',
                's3:PutBucketPolicy',
                'dynamodb:DeleteTable',
                'dynamodb:UpdateTable',
              ],
              Resource: ['*'],
            },
          ],
        }),
      ),
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
        propagatorProposalsTable,
        agentEventsTable,
        epicWorkflowsTable,
        projectRegistryTable,
        partyProjectsTable,
        partySessionsTable,
        partyInlineQuestionsTable,
        plansTable,
        appsTable,
        attentionItemsTable,
        waveConflictsTable,
        reflectionsTable,
        agentSessionsTable,
        agentConversationsTable,
        timingSummaryTable,
        freeAgentSessionsTable,
        freeAgentConversationsTable,
        agentFlagsTable,
        agentSpendLogTable,
        fixCyclesTable,
        remediationPoliciesTable,
        pushSubscriptionsTable,
        githubPat,
        anthropicApiKey,
        brownfieldGithubPat,
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
        // Epic 6 — Story 6.5: consent-gated PROPAGATOR proposals queue.
        PROPAGATOR_PROPOSALS_TABLE: propagatorProposalsTable.name,
        AGENT_EVENTS_TABLE: agentEventsTable.name,
        EPIC_WORKFLOWS_TABLE: epicWorkflowsTable.name,
        PROJECT_REGISTRY_TABLE: projectRegistryTable.name,
        PARTY_PROJECTS_TABLE: partyProjectsTable.name,
        PARTY_SESSIONS_TABLE: partySessionsTable.name,
        PARTY_INLINE_QUESTIONS_TABLE: partyInlineQuestionsTable.name,
        // Anthropic SDK reads this directly. SST resolves the secret to the
        // Lambda env at deploy time.
        ANTHROPIC_API_KEY: anthropicApiKey.value,
        PLANS_TABLE: plansTable.name,
        APPS_TABLE: appsTable.name,
        ATTENTION_ITEMS_TABLE: attentionItemsTable.name,
        WAVE_CONFLICTS_TABLE: waveConflictsTable.name,
        REFLECTIONS_TABLE: reflectionsTable.name,
        AGENT_SESSIONS_TABLE: agentSessionsTable.name,
        AGENT_CONVERSATIONS_TABLE: agentConversationsTable.name,
        TIMING_SUMMARY_TABLE: timingSummaryTable.name,
        // Story 18.1 — ARN the API Lambda passes to STS AssumeRoleCommand
        // when minting per-session free-agent credentials. Read by
        // `functions/shared/lib/free-agent-iam.ts:assumeFreeAgentSessionRole`.
        FREE_AGENT_SESSION_ROLE_ARN: freeAgentSessionRole.arn,
        // Story 18.2 — free-agent sessions table. Consumed by both the API
        // Lambda (when creating sessions) and the daemon (when running them).
        FREE_AGENT_SESSIONS_TABLE: freeAgentSessionsTable.name,
        // Story 18.6 — free-agent conversations table (per-message rows).
        FREE_AGENT_CONVERSATIONS_TABLE: freeAgentConversationsTable.name,
        // 2026-05-27 PR B — global agent feature flags (e.g. agent.paused).
        AGENT_FLAGS_TABLE: agentFlagsTable.name,
        // 2026-05-27 PR B — per-job spend rows (wall-clock × cost-per-sec).
        AGENT_SPEND_LOG_TABLE: agentSpendLogTable.name,
        // 2026-05-27 PR C.e — fix-cycle counter per (plan, wave).
        FIX_CYCLES_TABLE: fixCyclesTable.name,
        // 2026-05-27 PR D.a — per-category remediation policy.
        REMEDIATION_POLICIES_TABLE: remediationPoliciesTable.name,
        // 2026-05-27 PR D.f — PWA push subscriptions.
        PUSH_SUBSCRIPTIONS_TABLE: pushSubscriptionsTable.name,
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
        // PR-61 — build version stamp surfaced by /api/health
        BUILD_HASH,
        BUILD_TIME,
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
        // PR-16 — Plan forensic snapshots. When a plan reaches terminal
        // status (delivered/archived) the forensic JSON is computed once and
        // cached under timing/<planId>-forensic.json. Subsequent
        // /timing/forensic GETs read from S3 instead of re-running the
        // slicer + aggregator + cohort fetcher (~$0 vs ~17 DDB reads per
        // call). Scoped to timing/* — does not collide with the public
        // homepage's other paths (data/, media/, apps/, knowledge-live/).
        {
          actions: ['s3:PutObject', 's3:GetObject'],
          resources: [`arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/timing/*`],
        },
        // 2026-05-19 — App-delete cascade. DELETE /api/apps/:appId cleans up
        // the App's deployed artifacts (`apps/<appId>/*`) and Mycelium
        // mirror (`knowledge-live/<appId>/*`). Read + list + delete only;
        // never write outside the App's own prefix. Scope is intentionally
        // narrow — the homepage's other paths (data/, media/, party-docs/,
        // timing/) remain off-limits to delete.
        {
          actions: ['s3:GetObject', 's3:DeleteObject'],
          resources: [
            `arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/apps/*`,
            `arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/knowledge-live/*`,
          ],
        },
        // s3:ListBucket has no Resource ARN below the bucket level — it
        // applies to the bucket itself. We don't gate by prefix here
        // (SST's permission shape is opinionated and rejects Pulumi's
        // `condition: [{test, variable, values}]` form). Listing all
        // keys is read-only; the actual destructive scope still rides
        // on the GetObject+DeleteObject grant above, which IS narrow.
        {
          actions: ['s3:ListBucket'],
          resources: [`arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}`],
        },
        // Story 18.1 — let the API Lambda assume the FreeAgentSessionRole
        // with session tags when opening a new free-agent chat session. The
        // role's trust policy further restricts to this Lambda's role ARN
        // prefix; this permission only gates the *caller's* ability to invoke
        // STS at all.
        {
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [freeAgentSessionRole.arn],
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
        // Migrate-module (Epic 18, brownfield Party PAT vault):
        // /migrate UI registers each brownfield project's PAT under
        // `futurator/brownfield-pat/<projectId>`. The API Lambda owns
        // the lifecycle (create on register, put on rotate, delete with
        // 30-day recovery on teardown). Read happens here too because
        // GET /api/migrations enriches list responses without exposing
        // secret material. The daemon EC2 role has a parallel read-only
        // grant for the same ARN pattern.
        {
          actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:PutSecretValue',
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret',
            'secretsmanager:DeleteSecret',
            'secretsmanager:TagResource',
          ],
          resources: [
            'arn:aws:secretsmanager:us-east-1:835745294770:secret:futurator/brownfield-pat/*',
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
          allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
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

    // ──────────────────────────────────────────────────────────────
    // 2026-05-27 PR D.c — CloudWatch → Attention Items bridge.
    //
    // SNS topic `futurator-cw-alarms` receives CloudWatch alarm
    // notifications; this Lambda subscribes and writes corresponding
    // attention-item rows. Wire each alarm in CloudWatch with an
    // OK/ALARM action that publishes to this topic.
    //
    // The Lambda is intentionally light — classification + DDB write
    // only. The Rung 5 autotrigger flow continues via the daemon's
    // attention-poller (PR D.b) which spawns sessions based on the
    // resolved remediation policy.
    // ──────────────────────────────────────────────────────────────
    const cwAlarmsTopic = new sst.aws.SnsTopic('CloudWatchAlarmsTopic', {
      transform: {
        topic: {
          name: 'futurator-cw-alarms',
          tags: { 'futurator:project': 'admin-hub', 'futurator:managed-by': 'sst' },
        },
      },
    });

    cwAlarmsTopic.subscribe('CloudWatchToAttention', {
      handler: 'functions/cron/cw-to-attention.handler',
      runtime: 'nodejs22.x',
      architecture: 'arm64',
      memory: '256 MB',
      timeout: '30 seconds',
      link: [attentionItemsTable],
      environment: {
        ATTENTION_ITEMS_TABLE: attentionItemsTable.name,
      },
    });

    // ──────────────────────────────────────────────────────────────
    // 2026-05-27 PR C.c — DeployerLambda (self-deploy daemon on main push)
    //
    // Cron-polls every 60s; when origin/main advances past
    // agent.deployer.last-deployed-sha (futurator-agent-flags), runs the
    // snapshot → rsync → restart → 60s-health-check → auto-rollback flow.
    // The lambda is itself danger-listed (PR C.b) so changes to it require
    // operator typed-confirmation.
    //
    // Timeout 5 min covers worst case: 60s SSM dispatch lag + 60s rsync +
    // 60s restart + 60s health-check + 60s rollback budget.
    //
    // SSM permission is broad — the cron Lambda needs to send shell
    // commands to the daemon EC2 instance for snapshot/rsync/restart/
    // health-check. Scoped to the same instance the API Lambda already
    // controls (no expanded blast radius).
    // ──────────────────────────────────────────────────────────────
    new sst.aws.Cron('DeployerLambda', {
      schedule: 'rate(1 minute)',
      function: {
        handler: 'functions/cron/deployer-lambda.handler',
        runtime: 'nodejs22.x',
        architecture: 'arm64',
        memory: '256 MB',
        timeout: '300 seconds',
        link: [agentFlagsTable, agentEventsTable, attentionItemsTable],
        environment: {
          AGENT_FLAGS_TABLE: agentFlagsTable.name,
          AGENT_EVENTS_TABLE: agentEventsTable.name,
          ATTENTION_ITEMS_TABLE: attentionItemsTable.name,
          EC2_INSTANCE_ID: process.env.EC2_INSTANCE_ID ?? 'i-0826d68c316ae97dd',
        },
        permissions: [
          {
            actions: [
              'ssm:SendCommand',
              'ssm:GetCommandInvocation',
              'ssm:DescribeInstanceInformation',
            ],
            resources: ['*'],
          },
        ],
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
