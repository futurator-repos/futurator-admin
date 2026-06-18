import { z } from 'zod';

/**
 * VQA v3 (E2.1) — wire validator for the probe action grammar. Mirrors
 * `VisualTestFlowStep` / `ProbeStepAction` / `AssertOp` in
 * `functions/shared/types/epic-workflow.ts` (the type is the source of truth).
 *
 * Driver-agnostic: actions are intent verbs, not Playwright calls (FR-29). All
 * step fields are optional so legacy `{action, url, selector, value, ms, label}`
 * steps still validate (back-compat) — the only required field is `action`.
 */
export const assertOpSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'truthy',
  'falsy',
]);

export const probeStepActionSchema = z.enum([
  // legacy
  'navigate',
  'click',
  'wait',
  'screenshot',
  'fill',
  // VQA v3 interaction grammar
  'press',
  'hold',
  'tap',
  'pointer',
  'clock',
  'select',
  'drag',
  'assert',
  'seed',
  // H10 coverage-class gaps
  'viewport',
  'upload',
  'download',
  'network',
  'stroke',
]);

export const probeStepSchema = z.object({
  action: probeStepActionSchema,
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  ms: z.number().optional(),
  label: z.string().optional(),
  // interaction grammar
  key: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  clockMode: z.enum(['install', 'fastForward', 'runFor']).optional(),
  // L2-state assert oracle
  expr: z.string().optional(),
  op: assertOpSchema.optional(),
  expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
  // H10 grammar gaps
  w: z.number().optional(),
  h: z.number().optional(),
  network: z.enum(['offline', 'online']).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
});

export type ProbeStep = z.infer<typeof probeStepSchema>;

/** A probe flow is an ordered list of steps. */
export const probeFlowSchema = z.array(probeStepSchema);
