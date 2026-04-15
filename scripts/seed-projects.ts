import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.PROJECTS_TABLE || 'futurator-admin-projects';

const projects = [
  {
    projectId: 'contento',
    name: 'Contento',
    status: 'beta',
    category: 'independent-companies',
    brief:
      'AI-based web builder for small entrepreneurs. Headless CMS, booking, payments, newsletters, multi-language.',
    features: [
      {
        id: 'headless-cms',
        name: 'Headless CMS',
        status: 'active',
        awsServices: ['dynamodb', 's3', 'lambda'],
      },
      {
        id: 'booking',
        name: 'Booking System',
        status: 'in-progress',
        awsServices: ['dynamodb', 'ses'],
      },
      { id: 'payments', name: 'Payments', status: 'planning', awsServices: ['lambda'] },
      {
        id: 'newsletters',
        name: 'Newsletters',
        status: 'in-progress',
        awsServices: ['ses', 'sqs'],
      },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront', 'ses', 'sqs'],
    team: ['richie'],
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'sellebra',
    name: 'Sellebra',
    status: 'planning',
    category: 'independent-companies',
    brief:
      'AI-based full e-commerce with omnichannel PIM. Multi-channel selling, B2B modules, audits, templates.',
    features: [
      {
        id: 'pim',
        name: 'Product Information Management',
        status: 'planning',
        awsServices: ['dynamodb', 's3'],
      },
      {
        id: 'multi-channel',
        name: 'Multi-Channel Selling',
        status: 'planning',
        awsServices: ['lambda', 'sqs'],
      },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront', 'sqs'],
    team: ['richie'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'mbe',
    name: 'MBE',
    status: 'in-progress',
    category: 'joint-venture',
    brief:
      'AI-based SaaS for architects. Theoretical frameworks, BIM integration, VR+EEG validation, document intelligence.',
    features: [
      {
        id: 'evidence-graph',
        name: 'Evidence Graph',
        status: 'active',
        awsServices: ['dynamodb', 'lambda', 'bedrock'],
      },
      {
        id: 'pascal-editor',
        name: 'Pascal Editor (BIM)',
        status: 'in-progress',
        awsServices: ['s3'],
      },
      {
        id: 'document-intelligence',
        name: 'Document Intelligence',
        status: 'active',
        awsServices: ['bedrock', 'lambda', 's3'],
      },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront', 'cognito', 'ses'],
    team: ['richie'],
    createdAt: '2025-03-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'applicator',
    name: 'MyApplicator',
    status: 'beta',
    category: 'personal',
    brief:
      'AI-based CV engine, interview simulator, interactive profiles. LinkedIn integration, TTS/STT, PDF generation.',
    features: [
      {
        id: 'cv-engine',
        name: 'CV Engine',
        status: 'active',
        awsServices: ['dynamodb', 'lambda', 'bedrock'],
      },
      {
        id: 'interview-sim',
        name: 'Interview Simulator',
        status: 'beta',
        awsServices: ['bedrock', 'lambda'],
      },
      { id: 'pdf-gen', name: 'PDF Generation', status: 'active', awsServices: ['lambda', 's3'] },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront', 'cognito'],
    team: ['richie'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'gomad',
    name: 'GoMAD / Debatator',
    status: 'beta',
    category: 'personal',
    brief:
      'Multi-agent debate engine. Six Thinking Hats, knowledge graph, heavy TTS, 100+ page document processing.',
    features: [
      {
        id: 'debate-engine',
        name: 'Multi-Agent Debate',
        status: 'active',
        awsServices: ['bedrock', 'lambda'],
      },
      { id: 'knowledge-graph', name: 'Knowledge Graph', status: 'beta', awsServices: ['dynamodb'] },
      { id: 'tts', name: 'Text-to-Speech', status: 'active', awsServices: ['lambda'] },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront'],
    team: ['richie'],
    createdAt: '2025-02-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'atlassinator',
    name: 'Atlassinator',
    status: 'beta',
    category: 'personal',
    brief:
      'AI for Atlassian consultants. Python code generation, sandboxed execution, JET token auth, shareable dashboards.',
    features: [
      {
        id: 'code-gen',
        name: 'Code Generation',
        status: 'active',
        awsServices: ['bedrock', 'lambda'],
      },
      { id: 'sandbox', name: 'Sandboxed Execution', status: 'beta', awsServices: ['lambda'] },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront'],
    team: ['richie'],
    createdAt: '2025-04-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'dasher',
    name: 'Dasher',
    status: 'in-progress',
    category: 'personal',
    brief:
      'AI-based dashboard engine. Conversational UI, 15 chart types, shareable dashboards, data privacy focus.',
    features: [
      { id: 'chart-engine', name: 'Chart Engine', status: 'in-progress', awsServices: ['lambda'] },
      {
        id: 'conversational-ui',
        name: 'Conversational UI',
        status: 'in-progress',
        awsServices: ['bedrock'],
      },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront'],
    team: ['richie'],
    createdAt: '2025-09-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'songster',
    name: 'Songster',
    status: 'in-progress',
    category: 'personal',
    brief:
      'AI music collaboration & song storyboard. Drag-and-drop sections, AI audio inpainting, multi-stem chord detection.',
    features: [
      {
        id: 'storyboard',
        name: 'Song Storyboard',
        status: 'in-progress',
        awsServices: ['s3', 'lambda'],
      },
      {
        id: 'audio-processing',
        name: 'Audio Processing',
        status: 'in-progress',
        awsServices: ['lambda', 's3'],
      },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'cloudfront'],
    team: ['richie'],
    createdAt: '2025-11-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'mycelium',
    name: 'Mycelium',
    status: 'in-progress',
    category: 'personal',
    brief:
      'GraphRAG project management. Knowledge graph, cold-start document decomposition, cross-project integration.',
    features: [
      {
        id: 'graph-rag',
        name: 'GraphRAG Engine',
        status: 'in-progress',
        awsServices: ['bedrock', 'lambda'],
      },
      {
        id: 'doc-decomposition',
        name: 'Document Decomposition',
        status: 'in-progress',
        awsServices: ['bedrock', 's3'],
      },
    ],
    awsServices: ['ecs', 'dynamodb', 's3', 'lambda', 'bedrock', 'cloudfront'],
    team: ['richie'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'admin-hub',
    name: 'Futurator Admin Hub',
    status: 'in-progress',
    category: 'personal',
    brief: 'Centralised cost observatory and control plane for all Futurator projects.',
    features: [
      {
        id: 'cost-dashboard',
        name: 'Cost Dashboard',
        status: 'in-progress',
        awsServices: ['lambda', 'dynamodb'],
      },
      {
        id: 'resource-map',
        name: 'Resource Map',
        status: 'planning',
        awsServices: ['lambda', 'dynamodb'],
      },
      {
        id: 'project-registry',
        name: 'Project Registry',
        status: 'in-progress',
        awsServices: ['dynamodb'],
      },
    ],
    awsServices: ['s3', 'cloudfront', 'lambda', 'dynamodb', 'api-gateway', 'eventbridge'],
    team: ['richie'],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
  {
    projectId: 'identity-broker',
    name: 'Identity Broker',
    status: 'active',
    category: 'shared-infra',
    brief:
      'Centralised authentication service for all Futurator apps. Google OAuth, JWT, JWKS, multi-provider.',
    features: [
      {
        id: 'google-oauth',
        name: 'Google OAuth',
        status: 'active',
        awsServices: ['lambda', 'cognito'],
      },
      {
        id: 'jwt-management',
        name: 'JWT Management',
        status: 'active',
        awsServices: ['lambda', 'dynamodb'],
      },
      {
        id: 'multi-provider',
        name: 'Multi-Provider OAuth',
        status: 'active',
        awsServices: ['lambda'],
      },
    ],
    awsServices: ['lambda', 'dynamodb', 'api-gateway', 'cognito'],
    team: ['richie'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
  },
];

async function seed() {
  console.log(`Seeding ${projects.length} projects to ${TABLE}...`);
  for (const project of projects) {
    await client.send(new PutCommand({ TableName: TABLE, Item: project }));
    console.log(`  ✓ ${project.projectId} (${project.name})`);
  }
  console.log('Done!');
}

seed().catch(console.error);
