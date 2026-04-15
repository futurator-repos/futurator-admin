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
