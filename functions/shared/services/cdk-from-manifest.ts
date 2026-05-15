/**
 * cdk-from-manifest.ts — Pipeline v2 Phase 2-D / Story 2-D-7-1 (PR-96).
 *
 * Emits CDK TypeScript from an `aws.manifest.yaml` parsed shape. COMPILER
 * calls this at the end of the Implementation Spec plan template (Story
 * 2-D-8) to materialize `deployment/cdk/` from the declared state.
 *
 * v2.5 §25.1 — manifest is declared state; CDK is derived. The
 * synthesizer never reads the operator-edited CDK directly; it always
 * reads the manifest + regenerates. This keeps the manifest authoritative
 * and prevents drift between two source-of-truth surfaces.
 *
 * Coverage: the six service kinds Songster + Dino exercise. Other kinds
 * land via per-skill cost-shim (Story 2-D-9 / PR-97) plus their own CDK
 * generator extension here.
 */

import type { AwsManifest, AwsEnvironment } from '../schemas/aws-manifest-schema';

export type CdkServiceGenerator = (service: Record<string, unknown>, env: string) => string;

const GENERATORS: Record<string, CdkServiceGenerator> = {
  s3: generateS3,
  dynamodb: generateDynamoDb,
  lambda: generateLambda,
  'ecs-fargate': generateEcsFargate,
  'ecs-fargate-gpu': generateEcsFargateGpu,
  cloudfront: generateCloudfront,
  'api-gateway': generateApiGateway,
  'bedrock-model-access': generateBedrockAccess,
  'secrets-manager': generateSecretsManager,
  sqs: generateSqs,
  sns: generateSns,
};

function pascal(name: string): string {
  return name
    .split(/[-_/]/)
    .map((s) => (s.length ? s[0].toUpperCase() + s.slice(1) : ''))
    .join('');
}

function generateS3(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  return `    new s3.Bucket(this, '${id}', {
      bucketName: '${name}',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });`;
}

function generateDynamoDb(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  const partitionKey = String(service['partition-key'] || 'pk');
  const billing = service.billing === 'provisioned' ? 'PROVISIONED' : 'PAY_PER_REQUEST';
  return `    new dynamodb.Table(this, '${id}', {
      tableName: '${name}',
      partitionKey: { name: '${partitionKey}', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.${billing},
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });`;
}

function generateLambda(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  const handler = String(service.handler || 'index.handler');
  const runtime = String(service.runtime || 'NODEJS_22_X');
  const memory = Number(service.memory || 256);
  const timeout = Number(service.timeout || 30);
  return `    new lambda.Function(this, '${id}', {
      functionName: '${name}',
      runtime: lambda.Runtime.${runtime},
      handler: '${handler}',
      code: lambda.Code.fromAsset('dist/${name}'),
      memorySize: ${memory},
      timeout: cdk.Duration.seconds(${timeout}),
    });`;
}

function generateEcsFargate(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  const cpu = Number(service.cpu || 512);
  const memory = Number(service.memory || 1024);
  const desired = Number(service.desired ?? 1);
  return `    // ECS Fargate service: ${name}
    new ecsPatterns.ApplicationLoadBalancedFargateService(this, '${id}', {
      cluster,
      desiredCount: ${desired},
      cpu: ${cpu},
      memoryLimitMiB: ${memory},
      taskImageOptions: { image: ecs.ContainerImage.fromRegistry('${name}:latest') },
    });`;
}

function generateEcsFargateGpu(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  const cpu = Number(service.cpu || 4096);
  const memory = Number(service.memory || 16384);
  const desired = Number(service.desired ?? 0); // scale-to-zero per v2.5 §25
  return `    // ECS Fargate-GPU (scale-to-zero, EventBridge wake): ${name}
    // Requires the ecs-fargate-gpu-audio-pipeline skill (PR-72 SKILL-SCOUT manifest entry).
    new ecs.FargateService(this, '${id}', {
      cluster,
      taskDefinition: ${id}TaskDef,
      desiredCount: ${desired},
      capacityProviderStrategies: [{ capacityProvider: 'FARGATE', weight: 1, base: ${desired} }],
    });
    // cpu=${cpu} memory=${memory} gpu=1 — wire the task definition above.`;
}

function generateCloudfront(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  return `    new cloudfront.Distribution(this, '${id}', {
      defaultBehavior: { origin: new origins.S3Origin(${id}OriginBucket) },
      // Configure cache policy, custom domain, viewer cert per env in
      // deployment/cdk/lib/<project>-${name}-stack.ts.
    });`;
}

function generateApiGateway(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  return `    new apigw.HttpApi(this, '${id}', {
      apiName: '${name}',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigw.CorsHttpMethod.ANY],
      },
    });`;
}

function generateBedrockAccess(service: Record<string, unknown>): string {
  const name = String(service.name);
  const models = Array.isArray(service.models) ? (service.models as string[]) : [];
  const provisioned = Boolean(service['provisioned-throughput']);
  return `    // Bedrock model access: ${name}
    // Models: ${models.join(', ')}
    // Provisioned throughput: ${provisioned ? 'YES — costs ~$15/hr per model unit' : 'on-demand'}
    new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
${models.map((m) => `        \`arn:aws:bedrock:\${cdk.Aws.REGION}::foundation-model/${m}\``).join(',\n')}
      ],
    });`;
}

function generateSecretsManager(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  return `    new secretsmanager.Secret(this, '${id}', {
      secretName: '${name}',
      description: 'Managed by ARCHITECT; secret value populated out-of-band.',
    });`;
}

function generateSqs(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  const visibility = Number(service['visibility-timeout-sec'] || 30);
  return `    new sqs.Queue(this, '${id}', {
      queueName: '${name}',
      visibilityTimeout: cdk.Duration.seconds(${visibility}),
    });`;
}

function generateSns(service: Record<string, unknown>): string {
  const name = String(service.name);
  const id = pascal(name);
  return `    new sns.Topic(this, '${id}', {
      topicName: '${name}',
    });`;
}

/**
 * Generate the full CDK stack file for one environment.
 *
 * @param {AwsManifest} manifest
 * @param {'dev' | 'staging' | 'production'} envName
 * @returns {string} CDK TypeScript source (caller writes to disk)
 */
export function generateCdkStack(
  manifest: AwsManifest,
  envName: 'dev' | 'staging' | 'production',
): string {
  const env: AwsEnvironment | undefined = manifest.environments?.[envName];
  if (!env) {
    return `// No '${envName}' environment in aws.manifest.yaml — empty stack.\n`;
  }

  const projectId = pascal(manifest.project);
  const envId = pascal(envName);
  const stackId = `${projectId}${envId}Stack`;

  const bodies: string[] = [];
  const unsupported: string[] = [];
  for (const service of env.services ?? []) {
    const gen = GENERATORS[service.kind];
    if (!gen) {
      unsupported.push(`${service.kind} (${service.name})`);
      continue;
    }
    bodies.push(gen(service as Record<string, unknown>, envName));
  }

  const unsupportedBlock =
    unsupported.length === 0
      ? ''
      : `    // ── Unsupported service kinds (need generator extension) ──\n` +
        unsupported.map((u) => `    //   • ${u}`).join('\n') +
        '\n\n';

  return `// Auto-generated by Futurator pipeline-v2 COMPILER (PR-96).
// Source manifest: .deployment/aws.manifest.yaml (environment: ${envName})
// Edits to this file are overwritten on next plan close — modify the
// manifest, not this generated CDK.

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export class ${stackId} extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

${unsupportedBlock}${bodies.join('\n\n')}
  }
}
`;
}

/**
 * Generate a `bin/<project>.ts` CDK app entrypoint that instantiates
 * every environment's stack.
 */
export function generateCdkBinEntrypoint(manifest: AwsManifest): string {
  const envs = Object.keys(manifest.environments ?? {}) as Array<'dev' | 'staging' | 'production'>;
  const projectId = pascal(manifest.project);
  const stackImports = envs
    .map(
      (env) =>
        `import { ${projectId}${pascal(env)}Stack } from '../lib/${manifest.project}-${env}-stack';`,
    )
    .join('\n');
  const stackInstantiations = envs
    .map((env) => `new ${projectId}${pascal(env)}Stack(app, '${projectId}${pascal(env)}Stack');`)
    .join('\n');

  return `#!/usr/bin/env node
// Auto-generated by Futurator pipeline-v2 COMPILER (PR-96).
// Entry point for \`cdk synth\` / \`cdk deploy\`.

import * as cdk from 'aws-cdk-lib';
${stackImports}

const app = new cdk.App();
${stackInstantiations}
`;
}

/**
 * Return the list of service kinds that currently have a CDK generator.
 * The CLI displays this in `npx skills audit` so operators know what
 * kinds will materialize automatically vs. need a skill extension.
 */
export function supportedServiceKinds(): string[] {
  return Object.keys(GENERATORS).sort();
}
