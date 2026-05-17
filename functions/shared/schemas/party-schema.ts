import { z } from 'zod';
import { GITHUB_HTTPS_URL_REGEX, MAX_MESSAGE_BYTES, PROJECT_ID_REGEX } from '../types/party';

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
  'REFRESHING',
]);

export const partyProjectKindSchema = z.enum(['greenfield', 'brownfield']);

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
  kind: partyProjectKindSchema,
  bmadStatus: bmadStatusSchema,
  bmadVersion: z.string().optional(),
  customAgentsSHA: z.string().optional(),
  agentCount: z.number().int().nonnegative().optional(),
  expectedAgentCount: z.number().int().positive(),
  lastInspectedAt: z.string().optional(),
  lastBootstrapJobId: z.string().optional(),
  failureReason: z.string().optional(),
  gitRepoUrl: z.string().optional(),
  gitBranch: z.string().optional(),
  lastPulledAt: z.string().nullable().optional(),
  lastCommitSha: z.string().nullable().optional(),
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

/**
 * Greenfield create input — the legacy shape. `kind` defaults to 'greenfield'
 * when omitted so existing clients continue to work without modification.
 */
export const greenfieldProjectInputSchema = z.object({
  kind: z.literal('greenfield').optional(),
  projectId: projectIdSchema,
});

/**
 * Brownfield create input (Story 15.4). The operator supplies the upstream
 * GitHub HTTPS URL and optional branch; the daemon clones via PAT and skips
 * the BMAD install steps.
 */
export const brownfieldProjectInputSchema = z.object({
  kind: z.literal('brownfield'),
  name: projectIdSchema,
  gitRepoUrl: z.string().regex(GITHUB_HTTPS_URL_REGEX, 'gitRepoUrl must be an HTTPS GitHub URL'),
  gitBranch: z
    .string()
    .min(1)
    .max(120)
    .regex(/^\S+$/, 'gitBranch must not contain whitespace')
    .default('main'),
});

/**
 * Discriminated union over `kind` for POST /api/party/projects. Clients that
 * omit `kind` are treated as greenfield (back-compat).
 */
export const createPartyProjectInputSchema = z.union([
  brownfieldProjectInputSchema,
  greenfieldProjectInputSchema,
]);

export const refreshProjectParamsSchema = z.object({
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
export type GreenfieldProjectInput = z.infer<typeof greenfieldProjectInputSchema>;
export type BrownfieldProjectInput = z.infer<typeof brownfieldProjectInputSchema>;
export type RefreshProjectParams = z.infer<typeof refreshProjectParamsSchema>;
export type DocUploadUrlInput = z.infer<typeof docUploadUrlInputSchema>;
export type DocSyncInput = z.infer<typeof docSyncInputSchema>;
