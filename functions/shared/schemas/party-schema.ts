import { z } from 'zod';
import { MAX_MESSAGE_BYTES, PROJECT_ID_REGEX } from '../types/party';

export const projectIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PROJECT_ID_REGEX, 'projectId must match ^[a-z0-9][a-z0-9-]{0,63}$');

export const bmadStatusSchema = z.enum([
  'MISSING',
  'INSTALLING',
  'HEALTHY',
  'DRIFTED',
  'CORRUPTED',
  'FAILED',
]);

export const partySessionStatusSchema = z.enum([
  'ACTIVE',
  'PROCESSING',
  'IDLE',
  'ERROR',
  'ARCHIVED',
]);

export const partyProjectSchema = z.object({
  projectId: projectIdSchema,
  path: z.string().startsWith('/'),
  bmadStatus: bmadStatusSchema,
  bmadVersion: z.string().optional(),
  customAgentsSHA: z.string().optional(),
  agentCount: z.number().int().nonnegative().optional(),
  expectedAgentCount: z.number().int().positive(),
  lastInspectedAt: z.string().optional(),
  lastBootstrapJobId: z.string().optional(),
  failureReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sessionIdSchema = z.string().regex(uuidRegex, 'sessionId must be a UUID');

export const partySessionSchema = z.object({
  sessionId: sessionIdSchema,
  projectId: projectIdSchema,
  projectPath: z.string().startsWith('/'),
  claudeSessionId: z.string().nullable(),
  status: partySessionStatusSchema,
  turnCount: z.number().int().nonnegative(),
  lastTurnAt: z.string().optional(),
  createdAt: z.string(),
  topic: z.string().max(200).optional(),
  bmadVersionAtStart: z.string(),
  GSI1PK: z.string(),
  GSI1SK: z.string(),
});

export const bootstrapInputSchema = z.object({
  forceReinstall: z.boolean().optional(),
  createFolder: z.boolean().optional(),
});

export const createPartyProjectInputSchema = z.object({
  projectId: projectIdSchema,
});

export const docUploadUrlInputSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(128),
});

export const docSyncInputSchema = z.object({
  filename: z.string().min(1).max(255),
  s3Key: z.string().min(1),
});

export const createSessionInputSchema = z.object({
  projectId: projectIdSchema,
  topic: z.string().max(200).optional(),
});

export const sendMessageInputSchema = z.object({
  content: z
    .string()
    .min(1, 'content is required')
    .refine(
      (s) => Buffer.byteLength(s, 'utf8') <= MAX_MESSAGE_BYTES,
      `content must be at most ${MAX_MESSAGE_BYTES} bytes`,
    ),
});

export type ProjectId = z.infer<typeof projectIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type BootstrapInput = z.infer<typeof bootstrapInputSchema>;
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export type CreatePartyProjectInput = z.infer<typeof createPartyProjectInputSchema>;
export type DocUploadUrlInput = z.infer<typeof docUploadUrlInputSchema>;
export type DocSyncInput = z.infer<typeof docSyncInputSchema>;
