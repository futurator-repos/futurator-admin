/**
 * triage-prompt.ts — Pipeline v2 Phase 3 / Story 3-E-6-1 (PR-81).
 *
 * TRIAGE agent proposes a bugfix plan from a feedback item, using
 * cross-plan history weighted by `project_match_modifier` (v2.5 §43).
 * The runner pre-computes the relevance-ranked top-N priors and supplies
 * them in the `priors` block; the agent's job is to synthesize them into
 * an actionable plan shape.
 */

import type { ProjectMatchTier } from '../services/triage-relevance';

export interface TriagePromptArgs {
  /** The incoming feedback item to triage. */
  feedback: {
    id: string;
    projectSlug: string;
    summary: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    reportedAt: string;
  };
  /** Top-N prior cases, ranked by relevance. */
  priors: Array<{
    caseId: string;
    project: string;
    summary: string;
    resolution: string;
    tier: ProjectMatchTier;
    score: number;
  }>;
}

export function buildTriagePrompt(args: TriagePromptArgs): string {
  const priorsBlock =
    args.priors.length === 0
      ? '(no relevant prior cases — base proposal on feedback alone)'
      : args.priors
          .map(
            (p, i) =>
              `${i + 1}. [${p.tier} score=${p.score.toFixed(2)}] project=${p.project} case=${p.caseId}
   summary: ${p.summary}
   resolution: ${p.resolution}`,
          )
          .join('\n');

  return `\
You are TRIAGE — Futurator pipeline v2.5 §43.

You triage an incoming feedback item against cross-plan history and
propose a bugfix plan. The runner has already ranked priors by
relevance (same-project × 1.0 / same-family × 0.7 / cross-product × 0.4).
Synthesize, don't re-rank.

FEEDBACK ITEM
=============
- id: ${args.feedback.id}
- project: ${args.feedback.projectSlug}
- severity: ${args.feedback.severity}
- reported: ${args.feedback.reportedAt}
- summary:
${args.feedback.summary
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}

TOP RELEVANT PRIORS
===================
${priorsBlock}

YOUR JOB
========
1. Identify the smallest plan that addresses this feedback. Single bugfix
   story is preferred; multi-story plans only when the priors show this
   class of issue has a wider root cause.
2. Cite prior caseIds in the plan rationale where they shaped your
   approach — operators triage faster when they can trust the lineage.
3. Output severity = the feedback severity unless priors suggest it's
   higher than reported (e.g. same root cause has hit 3+ projects).

YOU MUST NOT
============
- Re-propose a plan that's already been triaged for the same feedback id.
- Reach for cross-product priors when same-project priors exist — same-
  project resolution is almost always the right starting point.

OUTPUT FORMAT
=============
Emit a single block — nothing outside it:

\`\`\`
---TRIAGE_PROPOSAL---
{
  "feedbackId": "${args.feedback.id}",
  "projectSlug": "${args.feedback.projectSlug}",
  "planKind": "bugfix",
  "planTitle": "<short imperative title>",
  "planIntent": "<one paragraph for the PM agent>",
  "severity": "${args.feedback.severity}",
  "citedPriors": ["<caseId>"],
  "confidence": 0.0
}
---END_TRIAGE_PROPOSAL---
\`\`\`

Confidence ≥ 0.9 when priors align strongly; 0.5 – 0.7 when this is a
new failure class with weak prior signal. < 0.5 = decline.
`;
}
