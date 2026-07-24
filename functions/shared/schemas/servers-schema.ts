import { z } from 'zod';

const providerIds = ['hetzner', 'oracle', 'gcp', 'aws', 'local'] as const;

const serverCapabilities = ['browser', 'docker', 'graph', 'git-push', 'interactive'] as const;

export const createServerSchema = z.object({
  name: z.string().min(1).max(64),
  provider: z.enum(providerIds),
  // 'serverless' is catalogued but not creatable in v1 (spec §2 Google shape)
  serviceType: z.enum(['vm', 'local-machine']),
  region: z.string().min(1),
  size: z.string().min(1),
  arch: z.enum(['arm64', 'x86_64']),
  maxConcurrent: z.number().int().min(1).max(16),
  costPerHour: z.number().min(0),
});

export const updateServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(16).optional(),
  costPerHour: z.number().min(0).optional(),
  // Operator override of the daemon-self-reported capability matrix.
  capabilities: z.array(z.enum(serverCapabilities)).optional(),
});

// One band of the JOB-priority ranking (which job goes first) — a different
// axis from host selection (mode/priorityOrder/weights). Ordered highest-first.
const jobPriorityTierSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  jobTypes: z.array(z.string().min(1).max(64)),
});

export const dispatchPolicySchema = z.object({
  mode: z.enum(['priority', 'weighted', 'cheapest']),
  priorityOrder: z.array(z.string()),
  weights: z.record(z.string(), z.number().min(0).max(100)),
  // Optional job-priority tiers; undefined falls back to DEFAULT_JOB_PRIORITY_TIERS
  // at selection time. Persisted through the same policy row (dispatch-state.ts
  // JSON-stringifies the whole object and re-validates on read).
  jobPriority: z.array(jobPriorityTierSchema).optional(),
});

const credentialShapes = {
  hetzner: z.object({ token: z.string().min(1) }),
  oracle: z.object({
    tenancyOcid: z.string().min(1),
    userOcid: z.string().min(1),
    fingerprint: z.string().min(1),
    privateKeyPem: z.string().min(1),
    compartmentId: z.string().min(1),
    region: z.string().min(1), // e.g. 'eu-frankfurt-1'
    imageId: z.string().min(1), // Ubuntu 24.04 ARM image OCID for the region
    availabilityDomains: z.array(z.string().min(1)).min(1),
  }),
  gcp: z.object({
    serviceAccountJson: z.string().min(1), // full SA key file content
    projectId: z.string().min(1),
    zone: z.string().min(1), // e.g. 'europe-west3-a'
  }),
} as const;

export const providerCredentialsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('hetzner'), credentials: credentialShapes.hetzner }),
  z.object({ provider: z.literal('oracle'), credentials: credentialShapes.oracle }),
  z.object({ provider: z.literal('gcp'), credentials: credentialShapes.gcp }),
]);
