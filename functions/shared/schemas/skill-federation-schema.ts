/**
 * Skill federation manifest schema — Pipeline v2 Phase 3 / Story 3-C-1-1.
 *
 * The federation is the operator-level registry-of-registries that
 * SKILL-SCOUT searches when resolving skills (v2.5 §35.1). Stored at
 * `~/.futurator/skill-federation.yaml` on the daemon EC2 instance; backed
 * up to S3 daily by the federation-backup tick.
 *
 * The daemon parses this file with a hand-rolled shape check in
 * `daemon/lib/federation-loader.mjs` because mjs cannot import Zod types
 * directly. This file is the canonical contract — keep the two
 * implementations in sync (matches the Phase 2 PR-32b "daemon-side mirror"
 * pattern: TS schema authoritative, daemon mirror validates the same
 * fields at runtime).
 *
 * PR-69 (Phase 3 prerequisite resolution): federation manifest location
 * is `~/.futurator/skill-federation.yaml` with daily S3 backup.
 */

import { z } from 'zod';

const RefreshCadenceSchema = z.enum(['daily', 'weekly', 'monthly']);

/** A single registered skill source — see v2.5 §35.1 illustrative example. */
export const FederationSourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  'auto-trust': z.boolean(),
  priority: z.number().int().positive(),
  /**
   * Optional per-source override of the manifest-level refresh cadence.
   * v2.5 §35.1 uses one cadence for all sources by default; this field
   * lets the operator opt a single source (e.g. `community`) into a
   * tighter loop without bumping the rest.
   */
  'refresh-cadence': RefreshCadenceSchema.optional(),
});

export const SkillFederationSchema = z.object({
  'manifest-version': z.literal(1),
  sources: z.array(FederationSourceSchema).min(1),
  'refresh-cadence': RefreshCadenceSchema,
});

export type FederationSource = z.infer<typeof FederationSourceSchema>;
export type SkillFederation = z.infer<typeof SkillFederationSchema>;
export type RefreshCadence = z.infer<typeof RefreshCadenceSchema>;

/**
 * Embedded fallback used when `~/.futurator/skill-federation.yaml` is
 * missing or unparseable. Three sources: Anthropic-official + futurator-
 * internal at auto-trust, community at non-auto-trust priority 99.
 *
 * Operators who want vercel-web, stripe-official, zxkane-aws, etc. (per the
 * v2.5 §35.1 illustrative manifest) author them into the real file. The
 * fallback keeps the daemon bootstrappable on a fresh EC2 instance with
 * no operator-config volume.
 */
export const EMBEDDED_DEFAULT_FEDERATION: SkillFederation = Object.freeze({
  'manifest-version': 1,
  sources: [
    {
      id: 'anthropic-official',
      url: 'https://github.com/anthropics/skills',
      'auto-trust': true,
      priority: 1,
    },
    {
      id: 'futurator-internal',
      url: 'https://github.com/futurator/futurator-skills',
      'auto-trust': true,
      priority: 2,
    },
    {
      id: 'community',
      url: 'https://github.com/anthropics/skills-community',
      'auto-trust': false,
      priority: 99,
    },
  ],
  'refresh-cadence': 'weekly',
}) as SkillFederation;

/**
 * Resolve the effective refresh cadence for a given source — either its
 * own override, or the manifest-level default.
 */
export function effectiveRefreshCadence(
  source: FederationSource,
  manifest: SkillFederation,
): RefreshCadence {
  return source['refresh-cadence'] ?? manifest['refresh-cadence'];
}
