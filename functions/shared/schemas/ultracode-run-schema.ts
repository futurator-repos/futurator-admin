/**
 * Ultracode-Reverse — request validation + row construction.
 * Zod schema for the create-run request; always use `.safeParse()` at the route.
 */

import { z } from 'zod';
import type { UltracodeRun } from '../types/ultracode-run';
import { ULTRACODE_CONFOUND } from '../types/ultracode-run';

export const ultracodeTargetSchema = z.enum(['greenfield', 'brownfield']);
export const ultracodeRigorSchema = z.enum(['prototype', 'mvp', 'production']);

/** POST /api/ultracode/runs body. */
export const createUltracodeRunSchema = z.object({
  intent: z.string().trim().min(8, 'intent must be at least 8 characters').max(2000),
  target: ultracodeTargetSchema.default('greenfield'),
  rigor: ultracodeRigorSchema.default('production'),
  reps: z.number().int().min(1).max(5).default(5),
});

export type CreateUltracodeRunInput = z.infer<typeof createUltracodeRunSchema>;

const TTL_DAYS = 90;

/**
 * Construct a fresh QUEUED run row from a validated request.
 * `now` is injected so the builder is deterministic + unit-testable.
 */
export function buildUltracodeRun(
  input: CreateUltracodeRunInput,
  ctx: { runId: string; operatorId: string; now?: Date },
): UltracodeRun {
  const now = ctx.now ?? new Date();
  const iso = now.toISOString();
  return {
    runId: ctx.runId,
    operatorId: ctx.operatorId,
    status: 'QUEUED',
    intent: input.intent,
    target: input.target,
    rigor: input.rigor,
    reps: input.reps,
    case1Status: 'PENDING',
    case2Status: 'PENDING',
    confound: ULTRACODE_CONFOUND,
    createdAt: iso,
    updatedAt: iso,
    expiresAt: Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60,
  };
}
