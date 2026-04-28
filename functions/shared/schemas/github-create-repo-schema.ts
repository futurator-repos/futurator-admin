import { z } from 'zod';

/**
 * Zod schema for POST /api/github/repos request body.
 *
 * `templateType` — one of the four BoilerplateType values. Kept as a
 * literal string enum here so this schema has no runtime dependency on
 * the registry module (avoids circular imports if the registry ever
 * imports from schemas).
 *
 * `name` — kebab-case GitHub repo slug.
 *   Rule: starts with a lowercase letter, followed by 1–39 chars that
 *   are lowercase letters, digits, or hyphens. No leading/trailing
 *   hyphen; no consecutive hyphens enforced by the regex itself.
 *   Matches the constraint in PR-1 of the Phase 1 epic plan.
 */
export const githubCreateRepoSchema = z.object({
  templateType: z.enum(['nextjs', 'sst', 'vite', 'mobile'], {
    errorMap: () => ({
      message: "templateType must be one of: 'nextjs', 'sst', 'vite', 'mobile'",
    }),
  }),
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{1,39}$/,
      'name must match ^[a-z][a-z0-9-]{1,39}$ (kebab-case, 2–40 chars, starts with a letter)',
    ),
});

export type GitHubCreateRepoInput = z.infer<typeof githubCreateRepoSchema>;
