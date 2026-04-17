import { z } from 'zod';

const extractorSchema = z.object({
  type: z.enum(['regex', 'between']),
  pattern: z.string().optional(),
  startDelimiter: z.string().optional(),
  endDelimiter: z.string().optional(),
});

const validationSchema = z.object({
  type: z.enum(['equals', 'not_contains', 'contains']),
  left: z.string().min(1),
  right: z.string().min(1),
  label: z.string().min(1),
});

const stepSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  resumeFromStep: z.string().optional(),
  extractors: z.record(z.string(), extractorSchema).optional(),
  validations: z.array(validationSchema).optional(),
  loopTo: z.string().optional(),
});

const agentConfigSchema = z.object({
  name: z.string().min(1),
  allowedTools: z.string().optional(),
  disallowedTools: z.string().optional(),
  model: z.string().optional(),
});

const pipelineSchema = z.object({
  agents: z
    .record(z.string(), agentConfigSchema)
    .refine((agents) => Object.keys(agents).length > 0, 'At least one agent is required'),
  steps: z.array(stepSchema).min(1, 'At least one step is required'),
  maxIterations: z.number().int().min(1).max(10).optional(),
});

export const createAgentJobSchema = z.object({
  workingDir: z
    .string()
    .min(1, 'Working directory is required')
    .startsWith('/', 'Must be an absolute path'),
  pipeline: pipelineSchema,
});

export type CreateAgentJobInput = z.infer<typeof createAgentJobSchema>;

// ── Epic-dev payload (EO-4.1, Arch Doc §3) ──

const storyComplexitySchema = z.enum(['trivial', 'standard', 'complex', 'architectural']);
const reviewRigorSchema = z.enum(['light', 'standard', 'strict']);
const storyOutcomeStatusSchema = z.enum(['APPROVED', 'FAILED', 'BLOCKED', 'SKIPPED']);
const blockerCodeSchema = z.enum([
  'ambiguous-ac',
  'insufficient-touch-points',
  'missing-dependency',
  'architectural-conflict',
  'context-gap',
  'environment',
]);

export const storyManifestEntrySchema = z.object({
  storyId: z.string().min(1),
  title: z.string().min(1),
  wave: z.number().int().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  touchPoints: z.array(z.string().min(1)).min(1, 'touchPoints cannot be empty'),
  complexity: storyComplexitySchema,
  reviewRigor: reviewRigorSchema,
  rubricEmphasis: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
});

export const blockerRecordSchema = z.object({
  code: blockerCodeSchema,
  severity: z.enum(['hard', 'soft']),
  description: z.string().min(1),
  affectedPath: z.string().optional(),
  suggestedResolution: z.string().optional(),
  detectedAt: z.number().int().nonnegative(),
});

export const storyOutcomeSchema = z.object({
  status: storyOutcomeStatusSchema,
  attempts: z.number().int().nonnegative(),
  reviewAttempts: z.number().int().nonnegative(),
  filesTouched: z.array(z.string()),
  finalDiff: z.string().optional(),
  blocker: blockerRecordSchema.optional(),
  terminalFailure: z.string().optional(),
});

export const waveResultSchema = z.object({
  waveNumber: z.number().int().min(1),
  stories: z.record(z.string(), storyOutcomeSchema),
  durationMs: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative(),
  persistedAt: z.string().optional(),
  epicId: z.string().optional(),
});

export const epicDevJobPayloadSchema = z.object({
  orchestratorModel: z.enum(['opus', 'sonnet']),
  maxParallel: z.number().int().min(1).max(32),
  maxRemediationRounds: z.number().int().min(0).max(10),
  epicGoal: z.string().min(1),
  contextDigest: z.string(),
  rubric: z.string(),
  stories: z.array(storyManifestEntrySchema).min(1, 'At least one story is required'),
});

export type EpicDevJobPayloadInput = z.infer<typeof epicDevJobPayloadSchema>;

export const createEpicDevJobSchema = z.object({
  workingDir: z.string().min(1).startsWith('/', 'Must be an absolute path'),
  epicId: z.string().min(1),
  projectId: z.string().min(1),
  phase: z.literal('epic-dev'),
  payload: epicDevJobPayloadSchema,
  resumeFromWaveResults: z.record(z.string(), waveResultSchema).optional(),
});

export type CreateEpicDevJobInput = z.infer<typeof createEpicDevJobSchema>;
