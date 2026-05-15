/**
 * skill-scout-runner.mjs — Pipeline v2 Phase 3 / Story 3-C-3-2.
 *
 * Daemon-side orchestration for SKILL-SCOUT runs. Loads the federation
 * manifest from the in-memory cache (PR-69), reads the project's skill
 * manifest from disk (PR-71 augment file), serializes both for the prompt,
 * builds the pipeline args the daemon's spawn loop consumes, and parses
 * the resulting between-marker block into validated proposals.
 *
 * Three trigger entry points share this runner (Story 3-C-3-2 follow-ons
 * wire each):
 *
 *   T1: post-bootstrap — daemon fires after app-bootstrap-saga completes
 *   T2: pre-PM        — daemon fires before plan PM decomposition
 *   T3: brownfield    — API Lambda enqueues via POST /api/apps/:slug/skills/audit
 *
 * The runner is decoupled from the actual spawn — it produces `args` that
 * the existing daemon spawn loop consumes (mirroring the pm-plan + story
 * pipeline pattern). Callers handle the agent invocation; this module
 * handles the read/serialize side + the parse/validate side.
 *
 * Proposal handling per v2.5 §37.1:
 *  - Zero proposals → no decision card surfaces (operator not interrupted)
 *  - ≥ 1 proposal under T1/T2 prototype rigor + confidence ≥ 0.9 → auto-confirm
 *    (v2.5 §38 rigor matrix; SKILL-SCOUT trigger map)
 *  - All other cases → decision card with manifest-change-proposed severity=medium
 *  - T3 NEVER auto-confirms regardless of rigor (brownfield is operator-driven)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';

/**
 * Read the project's skill manifest from disk. Returns `null` when missing
 * (e.g. stub boilerplate, brownfield project pre-3-F audit) — the caller
 * surfaces this as the empty-manifest baseline.
 *
 * @param {string} projectPath absolute path to the project working tree
 * @returns {{ raw: string, parsed: object } | null}
 */
export function readProjectManifest(projectPath) {
  const manifestPath = join(projectPath, '.claude', 'skills.manifest.yaml');
  if (!existsSync(manifestPath)) return null;
  const raw = readFileSync(manifestPath, 'utf-8');
  try {
    const parsed = parseYaml(raw);
    return { raw, parsed };
  } catch (e) {
    // Bubble up as a runtime error — the caller decides whether this is
    // an attention item or a hard fail.
    throw new Error(`skill manifest parse failed: ${e.message}`);
  }
}

/**
 * Build the YAML strings the SKILL-SCOUT prompt expects. Federation is
 * always pulled from cache; project manifest is read from disk if present,
 * otherwise a minimal-empty placeholder is used so the prompt's
 * "currentManifestYaml" block is never blank.
 *
 * @param {{
 *   federationCache: { get: () => { manifest: object } },
 *   projectPath: string,
 *   projectSlug: string,
 * }} args
 * @returns {{ currentManifestYaml: string, federationYaml: string, manifestSource: 'disk' | 'placeholder' }}
 */
export function buildPromptContext({ federationCache, projectPath, projectSlug }) {
  const { manifest: federation } = federationCache.get();
  const federationYaml = yamlStringify(federation);

  const fromDisk = readProjectManifest(projectPath);
  if (fromDisk) {
    return {
      currentManifestYaml: fromDisk.raw,
      federationYaml,
      manifestSource: 'disk',
    };
  }
  const placeholder = {
    project: projectSlug,
    'manifest-version': 1,
    'generated-by': 'placeholder@runner',
    core: [],
    stack: [],
    domain: [],
    vendor: [],
    plans: {},
    gaps: [],
  };
  return {
    currentManifestYaml: yamlStringify(placeholder),
    federationYaml,
    manifestSource: 'placeholder',
  };
}

/**
 * Decide whether a parsed SKILL-SCOUT result should auto-confirm or
 * surface a decision card. Per v2.5 §38 rigor matrix + Story 3-C-3-2 AC #2:
 *
 *   T1 / T2:
 *     prototype  + all proposals confidence ≥ 0.9 → auto-confirm
 *     prototype  + any proposal  confidence < 0.9 → surface card
 *     mvp        → always surface card
 *     production → always surface card
 *   T3:
 *     all rigors → always surface card (never auto-confirm brownfield)
 *
 * Empty proposals → no card, no auto-confirm (no-op return).
 *
 * @param {{ output: import('../../functions/shared/pipelines/skill-scout-pipeline').SkillScoutOutput, rigor: 'prototype' | 'mvp' | 'production' }} args
 * @returns {{ disposition: 'noop' | 'auto-confirm' | 'surface-card', reason: string }}
 */
export function disposeProposals({ output, rigor }) {
  if (!output.proposals || output.proposals.length === 0) {
    return { disposition: 'noop', reason: 'empty proposals — no card surfaces' };
  }
  // T3 (brownfield), T4 (speculation), T6 (REVIEWER repeats), T8 (weekly
  // refresh) NEVER auto-confirm — they're either operator-initiated
  // (T3), production-rigor-only (T4 — speculation gated to prod per
  // v2.5 §28.4), or organizational signals that need operator review
  // (T6, T8). v2.5 §38 trigger map columns.
  const ALWAYS_SURFACE = new Set(['T3', 'T4', 'T6', 'T8']);
  if (ALWAYS_SURFACE.has(output.trigger)) {
    return {
      disposition: 'surface-card',
      reason: `${output.trigger} always surfaces (never auto-confirms regardless of rigor)`,
    };
  }
  // T1 / T2 / T5 / T7 — standard rigor-gated auto-confirm path.
  if (rigor === 'prototype') {
    const allHighConfidence = output.proposals.every((p) => p.confidence >= 0.9);
    if (allHighConfidence) {
      return {
        disposition: 'auto-confirm',
        reason: `prototype rigor + all ${output.proposals.length} proposal(s) confidence ≥ 0.9`,
      };
    }
    return {
      disposition: 'surface-card',
      reason: 'prototype rigor + at least one proposal confidence < 0.9',
    };
  }
  return {
    disposition: 'surface-card',
    reason: `${rigor} rigor — operator confirms`,
  };
}

/**
 * Attention-item factory for the SKILL-SCOUT decision card. The daemon's
 * existing attention writer (`daemon/pipelines/lib/attention-writer.mjs`)
 * consumes this shape; callers pass it through.
 *
 * @param {{
 *   output: import('../../functions/shared/pipelines/skill-scout-pipeline').SkillScoutOutput,
 *   projectSlug: string,
 *   appId?: string,
 *   planId?: string,
 * }} args
 * @returns {object} attention item
 */
export function buildDecisionCard({ output, projectSlug, appId, planId }) {
  const proposalSummary = output.proposals
    .map((p) => `${p.kind} ${p.skill}@${p.source} → ${p.manifestBucket} (conf=${p.confidence})`)
    .join('\n');

  return {
    severity: 'medium',
    category: 'manifest-change-proposed',
    title: `SKILL-SCOUT ${output.trigger}: ${output.proposals.length} proposal(s) for ${projectSlug}`,
    body: proposalSummary,
    actions: ['confirm', 'edit', 'decline', 'defer'],
    context: {
      trigger: output.trigger,
      projectSlug,
      appId,
      planId,
      proposalCount: output.proposals.length,
      proposals: output.proposals,
    },
  };
}

/**
 * Forensic step event factory. Daemon emits this through its existing
 * event-forwarder so the Plan dashboard timing panel + cohort tracker pick
 * up SKILL-SCOUT activity.
 *
 * Returns `{ eventType, payload }`. The actual emit call lives in the
 * daemon's spawn loop (Story 3-C-3-2 follow-on wires it).
 */
export function buildForensicEvent({ trigger, output, durationMs, tokensConsumed }) {
  return {
    eventType: `step.skill-scout.${trigger}`,
    payload: {
      trigger,
      projectSlug: output?.projectSlug,
      proposalCount: output?.proposals?.length ?? 0,
      acceptedCount: 0, // populated by the decision-card handler post-confirm
      verifyFailureCount: 0, // reserved for the deterministic verify step (Story 3-C-3-1 AC #3)
      durationMs,
      tokensConsumed,
    },
  };
}
