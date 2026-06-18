import type { Plan } from '../types/plan';
import type { EpicWorkflow } from '../types/epic-workflow';
import { hasSection, type SectionManifest, type ArtifactKind } from '../concept/section-manifest';

/**
 * Concept v2 (E9, §8) — the solutioning gate-check: a SEMANTIC readiness gate
 * on top of the existing structural Start-development checks. Pure function over
 * the persisted plan + epics (+ artifact manifests); the API wires it into
 * `POST /api/plans/:id/start`.
 *
 * Severity model:
 *   • errors → "not-ready", BLOCK start (real gaps).
 *   • conditions → "ready-with-conditions", surfaced but never hard-block (e.g.
 *     manual ACs are confirmed downstream in QA Review, not at planning).
 * Rigor-scaled: prototype auto-passes (no gate); some checks (appearance floor,
 * missing BDD) are errors at `production` but only conditions at `mvp` (W9).
 */

export type GateVerdict = 'auto-pass' | 'ready' | 'ready-with-conditions' | 'not-ready';

export interface GateResult {
  verdict: GateVerdict;
  errors: string[];
  conditions: string[];
  /** True iff start should be blocked (errors present on a gated plan). */
  blocks: boolean;
  /** Human-readable readiness-report.md body. */
  report: string;
}

export interface GateInput {
  plan: Pick<Plan, 'rigor' | 'conceptPlan'>;
  epics: EpicWorkflow[];
  /** Section manifests for reference resolution (E4.1). Absent → reference checks skipped. */
  manifests?: Partial<Record<ArtifactKind, SectionManifest>>;
  /** PRD functional-requirement ids, when known (E9.2 coverage). */
  prdRequirementIds?: string[];
}

export function runSolutioningGate(input: GateInput): GateResult {
  const rigor = input.plan.rigor ?? 'mvp';
  if (rigor === 'prototype') {
    return {
      verdict: 'auto-pass',
      errors: [],
      conditions: [],
      blocks: false,
      report: '# Readiness report\n\nprototype rigor — gate auto-passed.',
    };
  }

  const isProd = rigor === 'production';
  const errors: string[] = [];
  const conditions: string[] = [];
  /** Push at error severity for production, condition severity for mvp. */
  const scaled = (msg: string) => (isProd ? errors : conditions).push(msg);

  const epics = input.epics ?? [];
  const allStories = epics.flatMap((e) => e.stories ?? []);
  const allCriteria = allStories.flatMap((s) => s.criteria ?? []);

  // ── E9.2 — structural + coverage ──
  if (epics.length === 0) errors.push('Plan has no epics.');
  // Foundation epic: at least one epic with no epic-deps (wave 0).
  if (epics.length > 0 && !epics.some((e) => (e.dependsOnEpics ?? []).length === 0)) {
    errors.push('No foundation epic (every epic depends on another — cyclic or missing root).');
  }
  // No forward epic deps (a dep must point at an epic that exists).
  const epicIds = new Set(epics.map((e) => e.epicId));
  for (const e of epics) {
    for (const dep of e.dependsOnEpics ?? []) {
      if (!epicIds.has(dep)) errors.push(`Epic ${e.epicId} depends on unknown epic ${dep}.`);
    }
  }
  // Every story has ≥1 AC; non-prototype expects a user-story triple + ≥1 BDD AC.
  for (const s of allStories) {
    const crit = s.criteria ?? [];
    if (crit.length === 0) errors.push(`Story ${s.storyId} has no acceptance criteria.`);
    if (!s.userStory) scaled(`Story ${s.storyId} is missing a user-story triple.`);
    const hasBdd = crit.some((c) => c.given || c.when || c.then);
    if (crit.length > 0 && !hasBdd) scaled(`Story ${s.storyId} has no BDD (given/when/then) AC.`);
  }
  // Requirement coverage: every PRD requirement maps to ≥1 epic via requirementRefs.
  if (input.prdRequirementIds && input.prdRequirementIds.length > 0) {
    const covered = new Set(epics.flatMap((e) => e.requirementRefs ?? []));
    for (const req of input.prdRequirementIds) {
      if (!covered.has(req)) scaled(`PRD requirement ${req} is not covered by any epic.`);
    }
  }

  // ── E9.3 [W2] — every reference resolves (set-membership against the manifest) ──
  // Only enforced when manifests are SUPPLIED. The Lambda start-gate can't read
  // the EC2 project dir, so it passes `manifests: undefined` and defers this to
  // decompose-time (validateReferenceSections, E4.2) / a manifest-loading caller.
  if (input.manifests !== undefined) {
    for (const s of allStories) {
      for (const ref of s.references ?? []) {
        if (ref.source === 'harness') continue; // resolved against the harness schema (E8)
        const manifest = input.manifests[ref.source as ArtifactKind];
        if (!manifest) {
          errors.push(
            `Story ${s.storyId} references ${ref.source}#${ref.section}, but no ${ref.source} manifest exists.`,
          );
        } else if (!hasSection(manifest, ref.section)) {
          errors.push(
            `Story ${s.storyId} references ${ref.source}#${ref.section}, which is not a section in ${ref.source}.md.`,
          );
        }
      }
    }
  }

  // ── E9.4 [W5] — flag manual ACs (condition) + validate manualReason ──
  const manualAcs = allCriteria.filter((c) => c.verify === 'manual');
  for (const c of manualAcs) {
    if (!c.manualReason) {
      errors.push(`Manual AC ${c.id} is missing a manualReason (closed enum).`);
    }
  }
  if (manualAcs.length > 0) {
    conditions.push(
      `${manualAcs.length} manual AC(s) require operator confirmation in QA Review (never auto-passed).`,
    );
  }

  // ── E9.4 [W9] — appearance-coverage floor for UI-bearing plans ──
  if (input.plan.conceptPlan?.uiBearing) {
    const appearanceCount = allCriteria.filter((c) => c.verify === 'appearance').length;
    if (appearanceCount === 0) {
      scaled(
        'UI-bearing plan has zero verify:appearance ACs (appearance floor — a blank load screen could pass).',
      );
    }
  }

  // ── E9.5 [W7c] — route↔AC reconciliation ──
  if (input.plan.conceptPlan && !input.plan.conceptPlan.uiBearing) {
    const visualAc = allCriteria.find((c) => c.verify === 'appearance' || c.verify === 'behavior');
    if (visualAc) {
      conditions.push(
        `Router classified the app non-UI-bearing, but AC ${visualAc.id} is verify:${visualAc.verify} — re-check the route.`,
      );
    }
  }

  const verdict: GateVerdict =
    errors.length > 0 ? 'not-ready' : conditions.length > 0 ? 'ready-with-conditions' : 'ready';

  const report = renderReport(rigor, verdict, errors, conditions);
  return { verdict, errors, conditions, blocks: errors.length > 0, report };
}

function renderReport(
  rigor: string,
  verdict: GateVerdict,
  errors: string[],
  conditions: string[],
): string {
  const lines = [
    '# Implementation readiness report',
    '',
    `**Rigor:** ${rigor}`,
    `**Verdict:** ${verdict}`,
    '',
  ];
  if (errors.length > 0) {
    lines.push('## Blocking issues', ...errors.map((e) => `- ❌ ${e}`), '');
  }
  if (conditions.length > 0) {
    lines.push('## Conditions (surfaced, non-blocking)', ...conditions.map((c) => `- ⚠️ ${c}`), '');
  }
  if (errors.length === 0 && conditions.length === 0) {
    lines.push('All readiness checks passed. ✅');
  }
  return lines.join('\n');
}
