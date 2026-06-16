// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./.sst/platform/config.d.ts" />

// Fixture SST app for the system-graph extractors (Story SG-1.1).
// Deliberately small but complete: one Dynamo, one Function, one Cron, one
// Secret, one Bucket with a scoped path, and one SNS topic + subscribe, so
// infra-extract / route-extract / service-extract tests each have a target.
// NOT deployed — parsed by tree-sitter only.

export default $config({
  app() {
    return { name: 'mini-sst', home: 'aws' };
  },
  async run() {
    // ── Secret → external service (REPRESENTS) ──
    const anthropicApiKey = new sst.Secret('AnthropicApiKey');

    // ── Dynamo table with a data contract (fields + primaryIndex) ──
    const scoresTable = new sst.aws.Dynamo('ScoresTable', {
      fields: {
        playerName: 'string',
        score: 'number',
      },
      primaryIndex: { hashKey: 'playerName' },
    });

    // ── Bucket with a scoped write path (dual-bucket safety rule) ──
    const mediaBucket = new sst.aws.Bucket('MediaBucket');

    // ── API Lambda: handler + link + environment + permissions ──
    const api = new sst.aws.Function('Api', {
      handler: 'functions/api/index.handler',
      url: true,
      link: [scoresTable, anthropicApiKey],
      environment: {
        SCORES_TABLE: scoresTable.name,
        ANTHROPIC_API_KEY: anthropicApiKey.value,
        IDENTITY_BROKER_URL: 'https://auth.futurator.ai',
      },
      permissions: [
        {
          actions: ['s3:PutObject'],
          resources: [`arn:aws:s3:::${mediaBucket.name}/media/*`],
        },
      ],
    });

    // ── Cron wrapping a function ──
    const digestCron = new sst.aws.Cron('DigestCron', {
      schedule: 'rate(1 day)',
      function: {
        handler: 'functions/cron/digest.handler',
        link: [scoresTable],
      },
    });

    // ── SNS topic + subscribe (event-driven; SG-1.3 W5 target) ──
    const alarmsTopic = new sst.aws.SnsTopic('AlarmsTopic');
    alarmsTopic.subscribe('AlarmToAttention', {
      handler: 'functions/cron/alarm.handler',
      link: [scoresTable],
    });

    // ── Cron referencing an EXISTING function var → cron TRIGGERS lambda (W5) ──
    const reportFn = new sst.aws.Function('ReportFn', {
      handler: 'functions/cron/report.handler',
    });
    new sst.aws.Cron('ReportCron', {
      schedule: 'rate(7 days)',
      function: reportFn,
    });

    return {
      api: api.url,
      cron: digestCron.id,
    };
  },
});
