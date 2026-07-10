import { z } from 'zod';

/**
 * Queues module schemas — validate the inbound external call, the operator's
 * test call, and the manual respond/re-route action.
 *
 * For now (per the module brief) calls carry a simple body: a `source`, the
 * `prompt`/instructions, and optional response-handling config. Typed
 * per-endpoint contracts can be layered on later.
 */

export const queueTargetSchema = z.enum(['ec2', 'local']);

/**
 * Inbound ingest from an external app. Either `prompt` or `body` must carry the
 * instructions; when only `body` is given the handler stringifies it into the
 * prompt. `callbackUrl` is where the answer is POSTed (auto or manual).
 */
export const ingestQueueRequestSchema = z
  .object({
    source: z.string().min(1, 'source is required'),
    prompt: z.string().min(1).max(100_000).optional(),
    body: z.unknown().optional(),
    target: queueTargetSchema.optional(),
    receiver: z.string().min(1).optional(),
    callbackUrl: z.string().url('callbackUrl must be a valid URL').optional(),
    autoRespond: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.prompt) || v.body !== undefined, {
    message: 'Either prompt or body is required',
  });

/**
 * Operator-fired test call from the Tests tab. Same shape as ingest but the
 * operator is already authed (no shared secret) and `source` defaults to 'test'.
 */
export const testQueueRequestSchema = z
  .object({
    source: z.string().min(1).default('test'),
    prompt: z.string().min(1).max(100_000).optional(),
    body: z.unknown().optional(),
    target: queueTargetSchema.optional(),
    receiver: z.string().min(1).optional(),
    callbackUrl: z.string().url('callbackUrl must be a valid URL').optional(),
    autoRespond: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.prompt) || v.body !== undefined, {
    message: 'Either prompt or body is required',
  });

/** Manual respond / re-route: optionally override the receiver URL. */
export const respondQueueRequestSchema = z.object({
  receiverUrl: z.string().url('receiverUrl must be a valid URL').optional(),
});

/** Set the shared concurrency cap for a given daemon target. */
export const setCapSchema = z.object({
  target: queueTargetSchema,
  maxConcurrent: z.number().int().min(1).max(16),
});

export type IngestQueueRequestInput = z.infer<typeof ingestQueueRequestSchema>;
export type TestQueueRequestInput = z.infer<typeof testQueueRequestSchema>;
export type RespondQueueRequestInput = z.infer<typeof respondQueueRequestSchema>;
export type SetCapInput = z.infer<typeof setCapSchema>;
