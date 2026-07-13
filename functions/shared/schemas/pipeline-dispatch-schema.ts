import { z } from 'zod';

/**
 * External pipeline-dispatch schema — the machine-callable "intent → running
 * Pipeline-3 plan" fast path (mirrors the Labs3 `POST /api/plans/quick-p3`
 * body, but reached by an external `x-queue-key` caller instead of the
 * operator JWT). Follows the queue-request-schema style: parse with
 * `.safeParse()` at the call site.
 *
 * - `source`  — the calling app/system id (stamped into `createdBy`).
 * - `intent`  — raw product intent the planner turns into StoryNodes.
 * - `name`    — optional human label; when absent the slug derives from intent.
 */
export const dispatchPipelineSchema = z.object({
  source: z.string().min(1, 'source is required'),
  intent: z.string().min(3, 'intent must be at least 3 chars'),
  name: z.string().optional(),
});

export type DispatchPipelineInput = z.infer<typeof dispatchPipelineSchema>;
