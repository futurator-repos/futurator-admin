// Plan Retrospect — Skills detector (rubric §3.10 SK1–SK6, §0.6 rows 132–137)
//
// Scores the skill subsystem deterministically from `forensic.skills` (the
// ForensicSkillsBlock built by `buildSkillsBlock` in forensic-builder.ts) plus
// the reflector rows (SK6 only). NO LLM, NO log-parsing — every signal is a
// field on the skills block the forensic export already computes.
//
// The pacman3 lesson (rubric §3.10 / §12 de-bias #4): skills are *loaded but
// unused, not ranked by relevance, and never discovered for the plan's domain*
// — the primary defect is activation + relevance (SK2/SK3), NOT catalog size.
// So SK1 (a healthy [MECH] loader) must never be allowed to mask a dead
// SK2 ([AGENT] activation). Each criterion is rendered on its OWN line.
//
// Honesty guard (spec §4a): SK3 (loadout ranking) and SK5 (trust) need signals
// that are NOT on the forensic skills block (an embeddings-read signal / an
// index trustTier). Those emit verdict '⚪' with a `[needs-instrumentation: …]`
// note and `score: null` — excluded from the rollup denominator. NEVER fabricate.
//
// Sources:
//   - rubric §0.6 rows SK1–SK6 (evidenceField + thresholdExpr, lines 132–137)
//   - rubric §3.10 SK1–SK6 detail table (lines 398–403)
//   - spec §4a (module shape, honesty guard), §4d (ScorecardSlice)
//   - forensic-builder.ts ForensicSkillsBlock (the read surface)

import type { DetectorContext, ScorecardSlice, EvidenceRef, Verdict, FixRef } from '../types';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes } from '../ie-to-f-map';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a slice, pulling stage/weight from the canonical CRITERIA_META. */
function makeSlice(args: {
  criterionId: string;
  score: ScorecardSlice['score'];
  verdict: Verdict;
  value: number | string;
  evidence: EvidenceRef;
  note?: string;
  ieIds?: string[];
  fixIds?: FixRef[];
}): ScorecardSlice {
  const meta = CRITERIA_META[args.criterionId];
  return {
    criterionId: args.criterionId,
    stage: meta.stage,
    score: args.score,
    verdict: args.verdict,
    value: args.value,
    evidence: args.evidence,
    ...(args.note ? { note: args.note } : {}),
    ieIds: args.ieIds ?? [],
    fixIds: args.fixIds ?? [],
    engine: 'deterministic',
  };
}

/** A `forensic.skills.<field>` evidence ref. */
function skRef(field: string): EvidenceRef {
  return { kind: 'forensic', ref: `skills.${field}` };
}

/**
 * The IE ids each SK criterion reproduces when its threshold is breached, read
 * straight from CRITERIA_META.ieLink (the §0.6 contract). Fixes resolve via the
 * canonical IE→Fix map so per-finding shipped/open state is honest (rubric §8).
 */
function ieAndFixes(criterionId: string): { ieIds: string[]; fixIds: FixRef[] } {
  const ieIds = CRITERIA_META[criterionId].ieLink;
  const fixIds = ieIds.flatMap((ie) => mapIeToFixes(ie));
  return { ieIds, fixIds };
}

/**
 * When the skills block is null (a pre-Epic-3/4 plan emitted zero skill events),
 * every SK criterion is unknowable from the Lambda inputs → '⚪'.
 */
function allUnknown(reason: string): ScorecardSlice[] {
  return (['SK1', 'SK2', 'SK3', 'SK4', 'SK5', 'SK6'] as const).map((id) =>
    makeSlice({
      criterionId: id,
      score: null,
      verdict: '⚪',
      value: 'n/a',
      evidence: skRef('(block null)'),
      note: `[needs-instrumentation: ${reason}]`,
    }),
  );
}

// ── detector ───────────────────────────────────────────────────────────────

/**
 * Score SK1–SK6 from the forensic skills block (+ reflector rows for SK6).
 * Returns one ScorecardSlice per criterion, in id order.
 */
export function scoreSkills(ctx: DetectorContext): ScorecardSlice[] {
  const sk = ctx.skills;

  // Older plan (pre-Epic-3/4): no skill events were ever observed, so
  // buildSkillsBlock returned null. We cannot fabricate availability/activation.
  if (!sk) {
    return allUnknown(
      'forensic.skills is null — plan ran before the daemon emitted skills_available / skill_activated / skill-scout events',
    );
  }

  const out: ScorecardSlice[] = [];

  // ── SK1 — Skill availability (loadout present, no zero-skill sessions) ─────
  // §0.6: 🟢 `hasSkillTool ∧ sessionsReportingZeroSkills==0`; 🔴 any zero-skill
  // session. [MECH] loader health — a green here must not mask SK2.
  {
    const hasSkillTool = sk.hasSkillTool === true;
    const zeroSessions = sk.sessionsReportingZeroSkills ?? 0;
    const reporting = sk.sessionsReportingAvailability ?? 0;

    if (reporting === 0) {
      // The block exists (some skill signal fired) but no session reported its
      // CLI-init availability probe — we can't assert the loader's health.
      out.push(
        makeSlice({
          criterionId: 'SK1',
          score: null,
          verdict: '⚪',
          value: 'no availability probe',
          evidence: skRef('sessionsReportingAvailability'),
          note: '[needs-instrumentation: no session emitted a skills_available event (CLI system/init probe); loader health unobservable]',
        }),
      );
    } else if (hasSkillTool && zeroSessions === 0) {
      out.push(
        makeSlice({
          criterionId: 'SK1',
          score: 4,
          verdict: '🟢',
          value: `${sk.availableSkillCount ?? 0} skills, 0 zero-skill sessions`,
          evidence: skRef('hasSkillTool'),
        }),
      );
    } else {
      // Any zero-skill session is the loading-defect signature (horse-runner1
      // "66 skills loaded, 0 activated" reporting artifact's sibling).
      out.push(
        makeSlice({
          criterionId: 'SK1',
          score: 0,
          verdict: '🔴',
          value: hasSkillTool
            ? `${zeroSessions}/${reporting} sessions reported zero skills`
            : 'Skill tool absent from init',
          evidence: skRef('sessionsReportingZeroSkills'),
          note: hasSkillTool
            ? 'A session loaded zero skills — skill loadout failed for at least one agent invocation.'
            : 'No session reported the Skill tool present at init.',
        }),
      );
    }
  }

  // ── SK2 — Activation when relevant (agents invoke the skills given) ────────
  // §0.6: `totalSkillToolUseEvents ÷ sessionsReportingAvailability`; 🟢 ≥0.30;
  // 🟡 0.10–0.30; 🔴 <0.10. IE25 → F24. Pacman3 measured 5.2% (deep red).
  {
    const uses = sk.totalSkillToolUseEvents ?? 0;
    const sessions = sk.sessionsReportingAvailability ?? 0;
    if (sessions === 0) {
      out.push(
        makeSlice({
          criterionId: 'SK2',
          score: null,
          verdict: '⚪',
          value: 'no availability denominator',
          evidence: skRef('sessionsReportingAvailability'),
          note: '[needs-instrumentation: sessionsReportingAvailability==0 — activation rate has no denominator (no CLI init probe observed)]',
        }),
      );
    } else {
      const rate = uses / sessions;
      let verdict: Verdict;
      let score: ScorecardSlice['score'];
      if (rate >= 0.3) {
        verdict = '🟢';
        score = 4;
      } else if (rate >= 0.1) {
        verdict = '🟡';
        score = 2;
      } else {
        verdict = '🔴';
        score = 0;
      }
      const { ieIds, fixIds } = ieAndFixes('SK2');
      out.push(
        makeSlice({
          criterionId: 'SK2',
          score,
          verdict,
          value: Number(rate.toFixed(4)),
          evidence: skRef('totalSkillToolUseEvents'),
          note: `${uses} Skill tool-uses ÷ ${sessions} sessions = ${(rate * 100).toFixed(1)}% activation`,
          // Only attach the IE/fix when the threshold is actually breached
          // (the IE is the *defect*, not the criterion).
          ...(verdict === '🟢' ? {} : { ieIds, fixIds }),
        }),
      );
    }
  }

  // ── SK3 — Loadout relevance / ranking ──────────────────────────────────────
  // §0.6: is `index.embeddings.json` read at LOAD time? `skills-prompt.mjs`
  // ordering. 4=relevance-ranked (vector/keyword); 0=flat pins-then-readdir,
  // embeddings write-only. This signal is NOT on the forensic skills block —
  // it requires a registry/embeddings-read probe the Lambda does not have →
  // honest '⚪'. IE27 → F27. (Do NOT co-locate with SK2 — own line, §3.10.)
  {
    out.push(
      makeSlice({
        criterionId: 'SK3',
        score: null,
        verdict: '⚪',
        value: 'no embeddings-read signal',
        evidence: skRef('(no ranking probe)'),
        note: '[needs-instrumentation: loadout ranking needs an index.embeddings.json read-at-load signal / skills-prompt.mjs ordering probe — not present on forensic.skills (IE27→F27)]',
      }),
    );
  }

  // ── SK4 — Discovery (scout) fired for the plan's need ──────────────────────
  // §0.6: `skillScoutRuns.length`; 🟢 ≥1 run surfacing a relevant skill;
  // 🔴 `skillScoutRuns.length==0` for a domain-clear intent. IE26 → F25.
  // We can count runs deterministically; "relevant to intent" is an LLM
  // judgment (deferred to the Assessor), so a count≥1 scores 🟡 (fired but
  // relevance unverified) rather than a fabricated 🟢.
  {
    const runs = sk.skillScoutRuns?.length ?? 0;
    if (runs === 0) {
      const { ieIds, fixIds } = ieAndFixes('SK4');
      out.push(
        makeSlice({
          criterionId: 'SK4',
          score: 0,
          verdict: '🔴',
          value: 0,
          evidence: skRef('skillScoutRuns.length'),
          note: 'SKILL-SCOUT never fired for this plan (scout dormancy) — no discovery pass ran for the plan’s domain.',
          ieIds,
          fixIds,
        }),
      );
    } else {
      out.push(
        makeSlice({
          criterionId: 'SK4',
          score: 2,
          verdict: '🟡',
          value: runs,
          evidence: skRef('skillScoutRuns'),
          note: `SKILL-SCOUT fired ${runs} run(s); whether a surfaced skill was relevant to the plan intent is an Assessor judgment (not deterministically verifiable here).`,
        }),
      );
    }
  }

  // ── SK5 — Trust integrity of what loads ────────────────────────────────────
  // §0.6: index `trustTier` / source `auto-trust`; vendor "BLOCKED" log.
  // 🟢 all loaded skills trusted; 🔴 ≥1 unvetted reached the app. IE28 → Story
  // 4.2 (+F26 bridge). This is N/A pre-institution (the trust tier / vendor
  // gate is a build target, not yet emitting a signal) → honest '⚪' with the
  // Story-4.2/F26 dependency surfaced.
  {
    const { ieIds, fixIds } = ieAndFixes('SK5');
    out.push(
      makeSlice({
        criterionId: 'SK5',
        score: null,
        verdict: '⚪',
        value: 'N/A pre-institution',
        evidence: skRef('(no trustTier signal)'),
        note: '[needs-instrumentation: skill trust tier / vendor-BLOCKED log not emitted pre-Skills-Institution — IE28 build target, depends on Story 4.2 (+F26 scout→inbox trust bridge)]',
        ieIds,
        fixIds,
      }),
    );
  }

  // ── SK6 — Registry self-improvement (left the registry better) ─────────────
  // §0.6: reflector `project-skill` proposals WRITTEN; app-evolved SKILL.md
  // authored & loadable next run. 🟢 ≥1 authored & consumable next run; 🔴
  // none / write-lost. IE29 → F5,F28. The reflector is OV8/F5 IAM-blocked
  // (written=0). We can read the written count from ctx.reflections (skill-
  // targeted rows). "Loadable next run" is not deterministically verifiable
  // from this plan's inputs, so a written>0 scores 🟡, never a fabricated 🟢.
  {
    const skillReflections = countSkillReflections(ctx.reflections);
    if (skillReflections === null) {
      out.push(
        makeSlice({
          criterionId: 'SK6',
          score: null,
          verdict: '⚪',
          value: 'no reflector rows',
          evidence: { kind: 'ddb', ref: 'reflections#target=project-skill' },
          note: '[needs-instrumentation: reflector rows not provided to the scorer — registry self-improvement (project-skill proposals written) unobservable (OV8/F5 IAM-blocked, written=0)]',
        }),
      );
    } else if (skillReflections === 0) {
      const { ieIds, fixIds } = ieAndFixes('SK6');
      out.push(
        makeSlice({
          criterionId: 'SK6',
          score: 0,
          verdict: '🔴',
          value: 0,
          evidence: { kind: 'ddb', ref: 'reflections#target=project-skill' },
          note: 'No app-evolved / project-skill proposals were written this plan — the registry was not improved (reflector write-loss, OV8/F5).',
          ieIds,
          fixIds,
        }),
      );
    } else {
      out.push(
        makeSlice({
          criterionId: 'SK6',
          score: 2,
          verdict: '🟡',
          value: skillReflections,
          evidence: { kind: 'ddb', ref: 'reflections#target=project-skill' },
          note: `${skillReflections} skill-targeted reflector proposal(s) written; "loadable next run" is not deterministically verifiable from this plan’s inputs (Assessor confirms consumability).`,
        }),
      );
    }
  }

  return out;
}

/**
 * Count skill-targeted reflector proposals from the (untyped) ctx.reflections
 * input. Returns null when no rows are provided (the field is absent / not an
 * array) so SK6 can emit a needs-instrumentation '⚪' rather than a fabricated
 * 0. Narrows defensively — `target` is the ReflectionTarget discriminator
 * ('project-skill' / 'org-skill').
 */
function countSkillReflections(reflections: unknown): number | null {
  if (!Array.isArray(reflections)) return null;
  let count = 0;
  for (const row of reflections) {
    if (row && typeof row === 'object') {
      const target = (row as { target?: unknown }).target;
      if (target === 'project-skill' || target === 'org-skill') count += 1;
    }
  }
  return count;
}
