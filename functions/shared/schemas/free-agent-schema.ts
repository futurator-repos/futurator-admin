/**
 * free-agent-schema.ts — Story 18.2 (Epic 18: Free Claude Code Agent)
 *
 * Zod schemas for free-agent session creation, message-send input, and status
 * enum. All callers use `.safeParse()` only (project convention; never `.parse()`
 * at the boundary).
 */

import { z } from 'zod';

export const FreeAgentSessionStatusSchema = z.enum([
  'ACTIVE',
  'PROCESSING',
  'IDLE',
  'EXPIRED',
  'BUDGET_EXHAUSTED',
  'ERROR',
]);

export const FreeAgentScopeKindSchema = z.enum(['project', 'plan', 'app', 'workspace']);

export const FreeAgentScopeSchema = z.object({
  kind: FreeAgentScopeKindSchema,
  id: z.string().min(1).max(128).optional(),
});

/** Three labeled options surfaced in the v1 UI plus any future Claude model id. */
export const ModelInputSchema = z.string().min(1).max(64);

/** Input shape for the API route POST /api/free-agent/sessions (Story 18.5). */
export const CreateFreeAgentSessionInputSchema = z.object({
  scope: FreeAgentScopeSchema,
  model: ModelInputSchema,
  /** Optional override of the per-session default ($10). */
  costCapUsd: z.number().positive().max(1000).optional(),
});

/** Input shape for the API route POST /api/free-agent/sessions/:id/messages (Story 18.5). */
export const SendFreeAgentMessageInputSchema = z.object({
  content: z.string().min(1).max(8192, 'message content must be ≤8192 bytes'),
});

/** Daemon-side job payload validator (informational; daemon also has its own
 *  validateFreeAgentSessionJob in job-router.mjs for early rejection). */
export const FreeAgentSessionJobPayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  scope: FreeAgentScopeSchema,
  model: ModelInputSchema,
  costCapUsd: z.number().positive().max(1000),
  credentials: z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1),
    expiration: z.string(), // ISO-8601
  }),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .min(1),
});

export type CreateFreeAgentSessionInputSchemaType = z.infer<
  typeof CreateFreeAgentSessionInputSchema
>;
export type SendFreeAgentMessageInputSchemaType = z.infer<typeof SendFreeAgentMessageInputSchema>;
export type FreeAgentSessionJobPayloadSchemaType = z.infer<typeof FreeAgentSessionJobPayloadSchema>;
