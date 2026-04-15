import { z } from 'zod';

const descriptionsSchema = z.object({
  headline: z.string().max(60).optional(),
  brief: z.string().max(140).optional(),
  summary: z.string().max(300).optional(),
  full: z.string().max(1000).optional(),
  aiContext: z.string().max(2000).optional(),
  homepageFlags: z
    .object({
      headline: z.boolean(),
      brief: z.boolean(),
      summary: z.boolean(),
    })
    .optional(),
});

const mediaSchema = z.object({
  id: z.string(),
  url: z.string(),
  alt: z.string().max(200),
  showOnHomepage: z.boolean(),
  order: z.number().int().min(0),
});

const featureSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['planning', 'in-progress', 'beta', 'active']),
  awsServices: z.array(z.string()).optional(),
  aiProviders: z.array(z.string()).optional(),
  integrations: z.array(z.string()).optional(),
});

export const projectUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['planning', 'in-progress', 'beta', 'active']).optional(),
    category: z
      .enum(['independent-companies', 'joint-venture', 'personal', 'shared-infra'])
      .optional(),
    descriptions: descriptionsSchema.optional(),
    media: z
      .array(mediaSchema)
      .max(6)
      .refine((arr) => arr.filter((m) => m.showOnHomepage).length <= 3, {
        message: 'Maximum 3 media items can be marked for homepage display',
      })
      .optional(),
    features: z.array(featureSchema).optional(),
    awsServices: z.array(z.string()).optional(),
    team: z.array(z.string()).optional(),
    budget: z.object({ monthlyLimit: z.number().positive() }).optional(),
    publishedToHomepage: z.boolean().optional(),
    homepageOrder: z.number().int().min(0).optional(),
  })
  .refine(
    (data) => {
      if (data.publishedToHomepage === true && data.descriptions) {
        const d = data.descriptions;
        const hasHeadline = d.headline && d.headline.length > 0;
        const hasHeadlineFlag = d.homepageFlags?.headline === true;
        const hasBrief = d.brief && d.brief.length > 0;
        const hasBriefFlag = d.homepageFlags?.brief === true;
        if (!hasHeadline || !hasHeadlineFlag || !hasBrief || !hasBriefFlag) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        'Published projects require non-empty headline and brief with homepage flags enabled',
    },
  );

// Keep existing schemas
export const costRangeSchema = z.object({
  range: z.enum(['30d', '60d', '90d']).default('30d'),
});

export const budgetSchema = z.object({
  monthlyLimit: z.number().positive(),
});

export const scheduleCreateSchema = z.object({
  resourceType: z.enum(['ec2', 'ecs']),
  resourceId: z.string().min(1),
  projectId: z.string().min(1),
  action: z.enum(['start', 'stop']),
  cronExpression: z.string().min(1),
  timezone: z.string().default('UTC'),
  enabled: z.boolean().default(true),
});

export const scheduleUpdateSchema = scheduleCreateSchema.partial();

export const manualCostSchema = z.object({
  projectId: z.string().min(1),
  service: z.string().min(1),
  amount: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().max(500).optional(),
});
