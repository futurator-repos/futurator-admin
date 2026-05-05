import { describe, it, expect, vi } from 'vitest';

// Mock DynamoDB
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({}) },
  ScanCommand: vi.fn(),
  GetCommand: vi.fn(),
  PutCommand: vi.fn(),
  QueryCommand: vi.fn(),
  UpdateCommand: vi.fn(),
  DeleteCommand: vi.fn(),
}));
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

// The Hono app at functions/api/index.ts is a ~3300-line module with many
// AWS-SDK / shared-repo imports; cold-importing it under parallel test load
// can exceed Vitest's default 5s. Bump to 20s to absorb cold-start latency.
const IMPORT_TIMEOUT_MS = 20_000;

describe('API Health Endpoint', () => {
  it(
    'should export a handler',
    async () => {
      const { handler } = await import('../../functions/api/index');
      expect(handler).toBeDefined();
    },
    IMPORT_TIMEOUT_MS,
  );
});

describe('API Structure', () => {
  it(
    'should export a handler function',
    async () => {
      const apiModule = await import('../../functions/api/index');
      expect(apiModule.handler).toBeDefined();
      expect(typeof apiModule.handler).toBe('function');
    },
    IMPORT_TIMEOUT_MS,
  );
});
