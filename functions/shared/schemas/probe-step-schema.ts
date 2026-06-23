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
  // VQA v3 Phase 2 — agentic event-driven verbs
  'waitForEvent',
  'repeat',
  // H10 coverage-class gaps
  'viewport',
  'upload',
  'download',
  'network',
  'stroke',
]);

/** The inner action a `repeat` step loops (a single simple act). Non-recursive
 *  on purpose — the interpreter only drives press/hold/pointer/tap/click/wait
 *  inside the loop, so we don't need (or want) full-grammar recursion here. */
export const repeatInnerStepSchema = z.object({
  action: z.enum(['press', 'hold', 'pointer', 'tap', 'click', 'wait']),
  key: z.string().optional(),
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  ms: z.number().optional(),
});

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
  // VQA v3 Phase 2 — agentic event-driven verbs (waitForEvent / repeat)
  timeoutMs: z.number().optional(),
  untilExpr: z.string().optional(),
  untilOp: assertOpSchema.optional(),
  untilExpected: z.union([z.string(), z.number(), z.boolean()]).optional(),
  maxIterations: z.number().optional(),
  budgetMs: z.number().optional(),
  intervalMs: z.number().optional(),
  step: repeatInnerStepSchema.optional(),
  // H10 grammar gaps
  w: z.number().optional(),
  h: z.number().optional(),
  network: z.enum(['offline', 'online']).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
});

export type ProbeStep = z.infer<typeof probeStepSchema>;

/** A probe flow is an ordered list of steps. */
export const probeFlowSchema = z.array(probeStepSchema);
