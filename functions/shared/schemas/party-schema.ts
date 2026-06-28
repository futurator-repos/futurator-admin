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
  /**
   * Migrate-module — fine-grained PAT for THIS project. Stored in AWS
   * Secrets Manager as `futurator/brownfield-pat/<projectId>`. Optional
   * for back-compat with legacy `applicator` migration (which used the
   * shared secret).
   */
  pat: z
    .string()
    .regex(/^(github_pat_|ghp_|github_token_)/, 'pat must be a GitHub PAT')
    .max(255)
    .optional(),
  /**
   * Migrate-module — env vars written to `<projectPath>/.env` post-clone.
   * Keys must be UPPER_SNAKE_CASE.
   */
  envVars: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env var key must be UPPER_SNAKE_CASE'),
      z.string().max(8192),
    )
    .optional(),
});

/**
 * PATCH /api/migrations/:id body — operator can rotate the PAT and/or
 * update env vars without re-cloning. Story 21.2 (party-push Epic 21)
 * adds the optional `pushEnabled` field — flipping ON must include a
 * fresh contents:write PAT in the same request.
 */
export const updateMigrationInputSchema = z
  .object({
    pat: z
      .string()
      .regex(/^(github_pat_|ghp_|github_token_)/, 'pat must be a GitHub PAT')
      .max(255)
      .optional(),
    envVars: z
      .record(
        z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env var key must be UPPER_SNAKE_CASE'),
        z.string().max(8192),
      )
      .optional(),
    pushEnabled: z.boolean().optional(),
    // Opt-in auto-PR. Independent toggle — no PAT required to flip it (push
    // must already be enabled for it to have any server-side effect).
    autoOpenPr: z.boolean().optional(),
    // Opt-in auto-merge (2026-06-12). When on, the daemon merges to main +
    // reaps the worktree + marks the debate DONE after a pushed checkpoint.
    // No PAT required to flip; only effective when pushEnabled + autoOpenPr.
    autoMerge: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.pat !== undefined ||
      v.envVars !== undefined ||
      v.pushEnabled !== undefined ||
      v.autoOpenPr !== undefined ||
      v.autoMerge !== undefined,
    { message: 'must include at least one of: pat, envVars, pushEnabled, autoOpenPr, autoMerge' },
  )
  .refine(
    // Story 21.2 — flipping pushEnabled ON requires a fresh PAT in the same
    // body. The existing PAT (if any) was issued with contents:read; the
    // upgraded scope is contents:write and must come from a new GitHub
    // token. Disabling (pushEnabled=false) does NOT require a PAT — the
    // operator may want to demote a project's PAT scope after rotation.
    (v) => !(v.pushEnabled === true && v.pat === undefined),
    {
      message:
        'enabling pushEnabled requires a fresh contents:write PAT in the same request (pat field)',
    },
  );

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

/**
 * Refactoring Assessment Module (Epic B1) — path param for
 * `POST /api/party/projects/:id/assess`. Mirrors the refresh-param shape.
 */
export const assessProjectParamsSchema = z.object({
  projectId: projectIdSchema,
});

/**
 * Optional request body for the assess endpoint. Every field is optional so a
 * bare `POST` runs a default recon. `runL3`/`topN` gate the Epic C adjudication
 * (ignored by the Epic B recon stage, kept for forward-compat).
 */
export const assessProjectBodySchema = z.object({
  src: z.string().min(1).max(128).optional(),
  skipGraphify: z.boolean().optional(),
  runL3: z.boolean().optional(),
  topN: z.number().int().min(1).max(500).optional(),
  runPrivacy: z.boolean().optional(),
  // 'internal' (our own deterministic scanner, default) | 'external' (GDPR service).
  privacyMode: z.enum(['internal', 'external']).optional(),
});

/**
 * Dual-agent comparison harness — body for
 * `POST /api/party/projects/:id/agent-compare`. Spawns two agents (vanilla vs
 * + graph MCP) on the same question over the assessed clone.
 */
export const compareAgentsBodySchema = z.object({
  question: z.string().min(3).max(2000),
  model: z.string().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(30000).max(600000).optional(),
});

/**
 * Refactoring Scan Engine v2 — body for `POST /api/party/projects/:id/scan-engine`.
 * Hybrid deterministic recon + LLM swarm over the migrated brownfield clone.
 */
export const scanEngineBodySchema = z.object({
  src: z.string().min(1).max(128).optional(),
  cap: z.number().int().min(1).max(200).optional(),
});

/**
 * Party docs are scoped. `session` docs belong to a single debate (S3 key
 * `party-docs/<projectId>/_session/<sessionId>/<file>`); `shared` docs are
 * project-level knowledge visible in every debate of the project
 * (`party-docs/<projectId>/_shared/<file>`). Default is `session` so a plain
 * upload never leaks across debates.
 */
export const docScopeSchema = z.enum(['session', 'shared']).default('session');

const requireSessionForSessionScope = (d: { scope: 'session' | 'shared'; sessionId?: string }) =>
  d.scope === 'shared' || !!d.sessionId;
const sessionScopeRefinement = {
  message: 'sessionId is required for session-scoped docs',
  path: ['sessionId'] as (string | number)[],
};

export const docUploadUrlInputSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(128),
    scope: docScopeSchema,
    sessionId: sessionIdSchema.optional(),
  })
  .refine(requireSessionForSessionScope, sessionScopeRefinement);

export const docSyncInputSchema = z
  .object({
    filename: z.string().min(1).max(255),
    s3Key: z.string().min(1),
    scope: docScopeSchema,
    sessionId: sessionIdSchema.optional(),
  })
  .refine(requireSessionForSessionScope, sessionScopeRefinement);

/** Query params for listing / deleting a scoped doc. */
export const docScopeQuerySchema = z
  .object({
    scope: docScopeSchema,
    sessionId: sessionIdSchema.optional(),
  })
  .refine(requireSessionForSessionScope, sessionScopeRefinement);

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
export type UpdateMigrationInput = z.infer<typeof updateMigrationInputSchema>;
export type DocScope = z.infer<typeof docScopeSchema>;
export type DocUploadUrlInput = z.infer<typeof docUploadUrlInputSchema>;
export type DocSyncInput = z.infer<typeof docSyncInputSchema>;
export type DocScopeQuery = z.infer<typeof docScopeQuerySchema>;
