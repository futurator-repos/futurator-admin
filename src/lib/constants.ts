export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '') + '/api';

export const STALE_TIME = 5 * 60 * 1000; // 5 minutes

// Status badge colors use semantic theme tokens (Stories 9-1 / 9-5) so they
// adapt automatically to light/dark mode rather than rendering pale-on-dark
// or vice-versa. The /20 suffix uses the modern Tailwind alpha-modifier syntax
// which works on `bg-` for tokens defined in @theme inline.
export const STATUS_COLORS: Record<string, string> = {
  active: 'bg-success/20 text-success border border-success/30',
  beta: 'bg-warning/20 text-warning border border-warning/30',
  'in-progress': 'bg-accent-blue/20 text-accent-blue border border-accent-blue/30',
  planning: 'bg-muted text-muted-foreground border border-border',
};

export const CATEGORY_LABELS: Record<string, string> = {
  'independent-companies': 'Independent',
  'joint-venture': 'Joint Venture',
  personal: 'Personal',
  'shared-infra': 'Shared Infra',
};

export const SERVICE_ICONS: Record<string, string> = {
  dynamodb: '🗄️',
  s3: '📦',
  lambda: 'λ',
  ecs: '🐳',
  ecr: '📋',
  cloudfront: '🌐',
  'api-gateway': '🔌',
  cognito: '🔐',
  bedrock: '🤖',
  ses: '📧',
  eventbridge: '⏰',
  sqs: '📬',
  sns: '🔔',
};

export const AWS_SERVICES = [
  's3',
  'dynamodb',
  'lambda',
  'cloudfront',
  'api-gateway',
  'cognito',
  'ecs',
  'ecr',
  'ec2',
  'bedrock',
  'ses',
  'eventbridge',
  'cloudwatch',
  'iam',
  'route53',
  'acm',
  'ssm',
  'secrets-manager',
  'sqs',
  'sns',
  'step-functions',
  'kinesis',
  'athena',
  'glue',
] as const;

export const AI_PROVIDERS = [
  'bedrock',
  'anthropic',
  'openai',
  'elevenlabs',
  'google-ai',
  'replicate',
  'huggingface',
  'stability-ai',
  'cohere',
] as const;

export const INTEGRATIONS = [
  'google-oauth',
  'linkedin-api',
  'stripe',
  'github-api',
  'slack-api',
  'google-drive',
  'google-calendar',
  'sendgrid',
  'twilio',
  'bim-api',
  'spotify-api',
] as const;
