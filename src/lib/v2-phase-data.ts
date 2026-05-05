/**
 * Pipeline v2 phase metadata — shared between the Roadmap strip (Story 1.6.1)
 * and the full /labs/roadmap page (Story 1.6.2).
 *
 * Story counts are a hardcoded snapshot of sprint-status.yaml. Real
 * live-reading from sprint-status.yaml is still deferred to Phase 2.
 *
 * 2026-05-05 — Phase 1 wrap. All 26 Phase 1 stories shipped; 4/5 ship-gate
 * conditions PASS, #4 (3× escalator cohort accumulation) is data-dependent
 * and satisfies organically as more plans run. Stabilisation pass shipped
 * as PR-1 → PR-31 (see §14 of epics-pipeline-v2-phase-1.md). Phase 2 entry
 * point begins at Phase 2-A — Inner-loop discipline; PR-2/3/4/5 already
 * touched ~30% of that scope.
 */

// ── Story progress snapshot ────────────────────────────────────────────────

/** Total Phase 1 stories (26 per sprint-status.yaml, 8 epics). */
export const PHASE_1_TOTAL_STORIES = 26;

/**
 * Phase 1 stories shipped (built + deployed + validated end-to-end). Tracked
 * informally — sprint-status.yaml has these at `review` (workflow's terminal
 * pre-retrospective state); we treat shipped + production-validated as the
 * UI signal. Formal *story-done sweep deferred.
 */
export const PHASE_1_DONE_STORIES = 26;

/** 0–100 integer progress percentage for Phase 1. */
export const PHASE_1_PROGRESS_PCT = Math.round(
  (PHASE_1_DONE_STORIES / PHASE_1_TOTAL_STORIES) * 100,
);

// ── Phase status types ─────────────────────────────────────────────────────

export type PhaseStatus = 'active' | 'pending' | 'done';

export interface EpicEntry {
  id: string;
  title: string;
  effort: string;
  stories: number;
  status: 'backlog' | 'in-progress' | 'done';
}

export interface PhaseData {
  number: 1 | 2 | 3;
  title: string;
  tagline: string;
  status: PhaseStatus;
  /** Single paragraph shown in the collapsed strip expanded view. */
  summary: string;
  /** Prose shown on the full roadmap page (plain text, rendered as-is). */
  narrative: string;
  /** Estimated calendar duration. */
  duration: string;
  /** Ship gate — the pass/fail condition for this phase being done. */
  shipGate: string;
  /** Key items explicitly deferred to a later phase. */
  deferrals: string[];
  /** Epic list (Phase 1 is fully enumerated; Phase 2 & 3 are summarised). */
  epics: EpicEntry[];
}

// ── Phase 1 — SUBSTRATE ────────────────────────────────────────────────────

const PHASE_1: PhaseData = {
  number: 1,
  title: 'Phase 1 — Substrate',
  tagline: 'GitHub-backed Apps, typed boilerplates, roadmap visibility, Timer Intelligence',
  status: 'done',
  duration: '~16–18 dev days',
  summary:
    'GitHub repo per App, typed boilerplates (Next.js / SST / Vite / Mobile), real ' +
    'futurator-repos org integration, PAT in SSM, App-bootstrap saga, big-picture roadmap ' +
    'visibility, and the Timer Intelligence measurement layer. The instrument that ' +
    'proves Phase 2/3 actually improve things has to predate the things being measured.',
  narrative:
    'Phase 1 establishes the substrate every later phase runs on. ' +
    'By the end of this phase each App in Labs is backed by a real GitHub repository ' +
    'under the futurator-repos org, provisioned from a typed boilerplate template. ' +
    'The App-bootstrap saga is a single atomic job with five idempotent sub-steps — ' +
    'failure at any point surfaces one actionable attention item. ' +
    'Timer Intelligence adds MECE time accounting per plan so every Phase-2 claim of ' +
    '"this is faster" is measurable, not anecdote.',
  shipGate:
    'Five pass/fail conditions: (1) end-to-end App creation in 90 s; ' +
    '(2) all four boilerplate types selectable, three gracefully empty; ' +
    '(3) Timer Intelligence captures and reports a real plan with forensic JSON export; ' +
    '(4) 3× escalator fires after cohort accumulation; ' +
    '(5) Pipeline v2 Roadmap strip rendered on every App detail page.',
  deferrals: [
    'The 11-step inner pipeline loop (Phase 2)',
    'Tool allowlists at spawn time (Phase 2)',
    'ARCHITECT + aws.manifest.yaml (Phase 2)',
    'Per-story wip/ worktrees (Phase 2)',
    'Skills federation + SKILL-SCOUT (Phase 3)',
    'REFLECTOR + Reflection Inbox (Phase 3)',
    'Speculation explore/ branches with EVALUATOR (Phase 3)',
    'Production rigor — 24 h soak, drift detection (Phase 3)',
    'Inbound GitHub webhook receiver (Phase 2)',
    'Real sprint-status.yaml reading for Roadmap strip progress (Phase 2)',
  ],
  epics: [
    {
      id: 'pv2-p1-1',
      title: 'Epic 1.1 — Prerequisite settle (PR-1 → PR-12)',
      effort: 'S×3',
      stories: 3,
      status: 'done',
    },
    {
      id: 'pv2-p1-2',
      title: 'Epic 1.2 — GitHub connector + API routes',
      effort: 'M×4',
      stories: 4,
      status: 'done',
    },
    {
      id: 'pv2-p1-3',
      title: 'Epic 1.3 — Boilerplate template repos + registry',
      effort: 'M×3',
      stories: 3,
      status: 'done',
    },
    {
      id: 'pv2-p1-4',
      title: 'Epic 1.4 — App-bootstrap saga + extended New App modal',
      effort: 'M×4',
      stories: 4,
      status: 'done',
    },
    {
      id: 'pv2-p1-5',
      title: 'Epic 1.5 — App detail Repository badge + Source tab',
      effort: 'M×2',
      stories: 2,
      status: 'done',
    },
    {
      id: 'pv2-p1-6',
      title: 'Epic 1.6 — Pipeline v2 Roadmap visibility',
      effort: 'M×2',
      stories: 2,
      status: 'done',
    },
    {
      id: 'pv2-p1-7',
      title: 'Epic 1.7 — Settings → GitHub panel',
      effort: 'M×1',
      stories: 1,
      status: 'done',
    },
    {
      id: 'pv2-p1-8',
      title: 'Epic 1.8 — Timer Intelligence module',
      effort: 'M×7',
      stories: 7,
      status: 'done',
    },
  ],
};

// ── Phase 2 — PIPELINE ─────────────────────────────────────────────────────

const PHASE_2: PhaseData = {
  number: 2,
  title: 'Phase 2 — Pipeline',
  tagline: 'The 11-step inner loop, branch-per-story, ARCHITECT + aws.manifest.yaml',
  status: 'active',
  duration: '~25–30 dev days',
  summary:
    'The 11-step inner loop with tool allowlists at spawn time, branch-per-story ' +
    'wip/ worktrees, ARCHITECT + aws.manifest.yaml, expanded Plan.kind enum, ' +
    'GitHub Actions OIDC, and basic CDK deploys. Brings v2.5 Parts A, B, D to life.',
  narrative:
    'Phase 2 is the pipeline proper. Each story runs as TEST → DEV → REVIEWER → ' +
    'COMPILER inside a wip/<storyId> branch and a dedicated worktree. ' +
    'Wave merge is --no-ff with a full test re-run. ' +
    'The ARCHITECT agent resolves plan intent against aws.manifest.yaml and emits a ' +
    'cost estimate before any implementation starts. ' +
    'GitHub Actions OIDC removes long-lived credentials from the daemon; ' +
    'CDK generates infrastructure from the manifest automatically. ' +
    'The inbound webhook receiver, sprint-status.yaml live-reading for the Roadmap ' +
    'strip, and per-plan ephemeral AWS sessions also land in this phase.',
  shipGate:
    'A feature plan on a Phase-1 App runs end-to-end through all 11 pipeline steps ' +
    '(TEST red gate → DEV → REVIEWER pass → COMPILER commit) inside a wip/ branch, ' +
    'merges to main via wave-merge, and the Timer Intelligence panel shows correct ' +
    'per-category attribution for the full plan.',
  deferrals: [
    'Skills federation + SKILL-SCOUT (Phase 3)',
    'REFLECTOR + Reflection Inbox (Phase 3)',
    'Speculation explore/ branches (Phase 3)',
    'Production rigor 24 h soak (Phase 3)',
    'EVALUATOR agent (Phase 3)',
    'Persona evolution (Phase 3)',
  ],
  epics: [
    {
      id: 'pv2-p2-A',
      title: 'Phase A — Inner-loop discipline (10 items, partially shipped)',
      effort: '~11 days',
      stories: 10,
      status: 'in-progress',
    },
    {
      id: 'pv2-p2-B',
      title: 'Phase B — Git substrate (12 items)',
      effort: '~17 days',
      stories: 12,
      status: 'backlog',
    },
    {
      id: 'pv2-p2-D',
      title: 'Phase D — AWS + integrations (18 items)',
      effort: '~33 days',
      stories: 18,
      status: 'backlog',
    },
  ],
};

// ── Phase 3 — COMPOUNDING ──────────────────────────────────────────────────

const PHASE_3: PhaseData = {
  number: 3,
  title: 'Phase 3 — Compounding',
  tagline: 'Skills federation, REFLECTOR, speculation explore/ branches, production rigor',
  status: 'pending',
  duration: '~25–30 dev days',
  summary:
    'Skills federation + SKILL-SCOUT, REFLECTOR + Reflection Inbox, speculation ' +
    'explore/ branches with EVALUATOR, production rigor with 24 h soak, drift ' +
    'detection, and persona evolution. v2.5 Parts C, E, F.',
  narrative:
    'Phase 3 is where the system compounds its own learning. ' +
    'SKILL-SCOUT proposes skill adds/removes/upgrades at four trigger points. ' +
    'REFLECTOR observes each completed wave and plan, proposes CLAUDE.md edits and ' +
    'skill candidates — always propose-only, never auto-apply. ' +
    'The Reflection Inbox (reusing the Feedback Inbox component) routes proposals ' +
    'to the operator. ' +
    'Speculation explore/ branches let two implementations race; EVALUATOR declares ' +
    'a winner by applying a defined winner-rule. ' +
    'Production rigor adds a 24 h soak gate, drift detection, and ' +
    'a required-review branch-protection policy on main.',
  shipGate:
    'REFLECTOR fires after a completed plan and produces at least one proposal in the ' +
    'Reflection Inbox. A skill promoted from a project-local skill to org-wide is ' +
    'visible in the federation manifest. An explore/ speculation branch runs and ' +
    'EVALUATOR declares a winner. A plan tagged production rigor passes the 24 h soak.',
  deferrals: [
    'Claude Managed Agents (MA) migration — opt-in per project, blocked on EU residency (Phase G)',
    'Brownfield audit for pre-v2 Futurator projects (Phase F, ~2 days per project)',
    'REFLECTOR-REVIEWER (guard against compromised reflection) — after Phase 3 baseline',
  ],
  epics: [
    {
      id: 'pv2-p3-C',
      title: 'Phase C — Skills managed resource (9 items)',
      effort: '~17 days',
      stories: 9,
      status: 'backlog',
    },
    {
      id: 'pv2-p3-E',
      title: 'Phase E — Reflection loop (10 items)',
      effort: '~17 days',
      stories: 10,
      status: 'backlog',
    },
    {
      id: 'pv2-p3-F',
      title: 'Phase F — Brownfield migration (4 items + 2/project)',
      effort: '~4 days fixed',
      stories: 4,
      status: 'backlog',
    },
  ],
};

// ── Exported collection ────────────────────────────────────────────────────

export const V2_PHASES: PhaseData[] = [PHASE_1, PHASE_2, PHASE_3];
