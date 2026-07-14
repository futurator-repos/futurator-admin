import { describe, it, expect } from 'vitest';
import {
  buildQuickPlanspecPrompt,
  buildQuickPlanspecRepairPrompt,
  parseQuickPlanspec,
  auditPlanGraph,
  buildStoryNodeRows,
  detectOverSharding,
} from '../quick-planspec.mjs';
// End-to-end scope proof (finding fix): run a parsed walking-skeleton plan through the
// REAL dev-scope contract + the REAL scope-violation detector — the exact path the
// foundation's stub writes take at RED — to prove the foundation's declared touches
// clear its own mandated stub creation, and that OMITTING the stub path is what fails.
import { buildStoryDevContract } from '../../../lib/story-job-minter.mjs';
import { detectScopeViolations } from '../scope-violation-detector.mjs';

const SPEC = JSON.stringify({
  stories: [
    { title: 'Define game types and constants', intent: 'foundation', touches: ['src/types.ts'],
      acceptanceCriteria: [{ text: 'types compile with no tsc errors', verify: 'build' }], complexity: 'standard' },
    { title: 'Implement the dino entity', intent: 'feature', touches: ['src/dino.ts'],
      acceptanceCriteria: [{ text: 'dino jumps when Space pressed', verify: 'state', needsBrowser: true,
        when: 'press Space', thenObservable: "snapshot.status equals 'running'" }] },
    { title: 'Assemble the complete game', intent: 'integration', touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'the game renders and runs end to end', verify: 'behavior', needsBrowser: true }] },
  ],
});

// A model-authored WIDE plan: contract → 3 disjoint slices → assemble.
const WIDE_SPEC = JSON.stringify({
  stories: [
    { id: 'contract', title: 'Define the contract types and state model', touches: ['src/game/types.ts', 'src/game/actions.ts'],
      acceptanceCriteria: [{ text: 'contract types compile clean', verify: 'build' }] },
    { id: 'movement', title: 'Implement movement slice', dependsOn: ['contract'], touches: ['src/slices/movement.ts'],
      acceptanceCriteria: [{ text: 'arrow key moves the player', verify: 'behavior', needsBrowser: true, when: 'press ArrowLeft', thenObservable: 'snapshot.playerX decreases' }] },
    { id: 'scoring', title: 'Implement scoring slice', dependsOn: ['contract'], touches: ['src/slices/scoring.ts'],
      acceptanceCriteria: [{ text: 'eating a pellet raises the score', verify: 'state', when: 'pellet eaten', thenObservable: 'snapshot.score increases' }] },
    { id: 'ghosts', title: 'Implement ghosts slice', dependsOn: ['contract'], touches: ['src/slices/ghosts.ts'],
      acceptanceCriteria: [{ text: 'ghosts leave the vault over time', verify: 'state' }] },
    { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract', 'movement', 'scoring', 'ghosts'], touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'the app runs end to end', verify: 'behavior', needsBrowser: true }] },
  ],
});

// A model-authored SERIAL plan: god-file reducer.ts shared by every feature.
const GOD_FILE_SPEC = JSON.stringify({
  stories: [
    { id: 'contract', title: 'Define the contract types', touches: ['src/game/types.ts'],
      acceptanceCriteria: [{ text: 'contract types compile clean', verify: 'build' }] },
    { id: 'movement', title: 'Implement movement', dependsOn: ['contract'], touches: ['src/game/reducer.ts', 'src/game/movement.ts'],
      acceptanceCriteria: [{ text: 'arrow key moves the player', verify: 'behavior', needsBrowser: true }] },
    { id: 'scoring', title: 'Implement scoring', dependsOn: ['contract'], touches: ['src/game/reducer.ts', 'src/game/scoring.ts'],
      acceptanceCriteria: [{ text: 'eating a pellet raises the score', verify: 'state' }] },
    { id: 'ghosts', title: 'Implement ghosts', dependsOn: ['contract'], touches: ['src/game/reducer.ts'],
      acceptanceCriteria: [{ text: 'ghosts chase the player around', verify: 'state' }] },
    { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract', 'movement', 'scoring', 'ghosts'], touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'the app runs end to end', verify: 'behavior', needsBrowser: true }] },
  ],
});

// An over-sharded plan: 4 "independent" feature stories with disjoint touches
// that ALL observe the same underlying snapshot root (`entities`) — the
// pacman6-class smell: looks parallel, is actually one coupled state machine.
const OVER_SHARDED_SPEC = JSON.stringify({
  stories: [
    { id: 'contract', title: 'Define the contract types', touches: ['src/game/types.ts'],
      acceptanceCriteria: [{ text: 'contract types compile clean', verify: 'build' }] },
    { id: 'movement', title: 'Implement pacman movement', dependsOn: ['contract'], touches: ['src/slices/movement.ts'],
      acceptanceCriteria: [{ text: 'arrow key moves pacman', verify: 'behavior', needsBrowser: true,
        when: 'press ArrowLeft', thenObservable: 'snapshot.entities.pacman.dir equals "left"' }] },
    { id: 'ghosts', title: 'Implement ghost AI', dependsOn: ['contract'], touches: ['src/slices/ghosts.ts'],
      acceptanceCriteria: [{ text: 'ghosts leave the vault over time', verify: 'state',
        thenObservable: "snapshot.entities.ghosts[0].mode equals 'chase'" }] },
    { id: 'scoring', title: 'Implement scoring', dependsOn: ['contract'], touches: ['src/slices/scoring.ts'],
      acceptanceCriteria: [{ text: 'eating a pellet raises the score', verify: 'state',
        thenObservable: 'snapshot.entities.score increases' }] },
    { id: 'rendering', title: 'Implement level rendering', dependsOn: ['contract'], touches: ['src/slices/render.ts'],
      acceptanceCriteria: [{ text: 'the maze renders on screen', verify: 'appearance', needsBrowser: true,
        thenObservable: 'snapshot.entities.level.rendered is true' }] },
    { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract', 'movement', 'ghosts', 'scoring', 'rendering'],
      touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'the app runs end to end', verify: 'behavior', needsBrowser: true }] },
  ],
});

describe('buildQuickPlanspecPrompt', () => {
  it('embeds the idea, the harness contract, and the PLAN_SPEC output tags', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a dino runner game', appSlug: 'dino9' });
    expect(p).toContain('a dino runner game');
    expect(p).toContain('window.__harness');
    expect(p).toContain('<PLAN_SPEC>');
    expect(p).toMatch(/NO epics/i);
  });

  it('teaches the execution substrate and demands a wide model-authored DAG', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a kanban board', appSlug: 'kb1' });
    expect(p).toContain('PARALLEL');
    expect(p).toContain('dependsOn');
    expect(p).toMatch(/disjoint/i);
    expect(p).toMatch(/god reducer\/store/i);
    expect(p).toMatch(/critical path/i);
    // quality rules survived the rewrite
    expect(p).toContain('FIDELITY');
    expect(p).toContain('INTERACTIVITY');
    expect(p).toContain('SEAM WIRING');
  });

  it('teaches planShape right-sizing (coherent vs sharded) with a rationale field', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a pacman game', appSlug: 'pm1' });
    expect(p).toMatch(/planShape/);
    expect(p).toContain('coherent');
    expect(p).toContain('sharded');
    expect(p).toContain('planShapeRationale');
    expect(p).toMatch(/PHASED-COHERENT/);
  });

  it('coherent means PHASED (3–7 stories), never one mega-story — the pacman8 fix', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a pacman game', appSlug: 'pm1' });
    expect(p).not.toContain('EXACTLY ONE story');
    expect(p).toMatch(/3–7 stories/);
    expect(p).toMatch(/NEVER fold the whole app into one story/i);
    expect(p).toMatch(/boots/i); // boot-alive foundation skeleton
    // Incident F/G: the redundant assemble mega-story is GONE — the foundation
    // already composed + mounted the app, so no separate assemble story exists.
    expect(p).toMatch(/NO redundant "assemble" story/i);
    expect(p).toMatch(/dependsOn CHAIN is fine/);
  });

  it('emits the PLAN_THINKING contract before PLAN_SPEC with the four labeled sections', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a chess trainer', appSlug: 'ch1' });
    expect(p).toContain('<PLAN_THINKING>');
    expect(p).toContain('CLASSIFICATION:');
    expect(p).toContain('PHASES:');
    expect(p).toContain('QUALITY PATTERNS & RISKS:');
    expect(p).toContain('MODEL ASSIGNMENT:');
    // thinking comes BEFORE the spec block in the output contract
    expect(p.indexOf('<PLAN_THINKING>')).toBeLessThan(p.indexOf('<PLAN_SPEC>'));
    expect(p).toMatch(/prose only, NO code fences/);
  });

  it('carries the 6-AC hard budget and the isolated-test-author sizing rule', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a todo app', appSlug: 'td2' });
    expect(p).toContain('AC BUDGET');
    expect(p).toMatch(/at most 6 acceptanceCriteria per story/);
    expect(p).toMatch(/isolated test-author/);
  });

  it('F4: demands ATOMIC ACs — one claim per AC, split the story rather than bundle', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a settings panel', appSlug: 'sp1' });
    expect(p).toContain('ATOMIC ACs');
    expect(p).toMatch(/EXACTLY ONE verifiable claim/);
    expect(p).toMatch(/NEVER\s+bundle/);
    expect(p).toMatch(/SPLIT the story/);
    // the atomic rule keeps the ≤6 budget as the split trigger, not a bundling license
    expect(p).toMatch(/never bundle claims to\s*\n?\s*fit the budget/);
    // generic mechanics only — no app/game-specific claim leaked into the example
    expect(p).not.toMatch(/buildInitialState|ghosts|pacman/i);
  });

  it('F5: reserves verify:build for a whole-project compile — data/state properties are verify:state', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz2' });
    expect(p).toMatch(/"build" is ONLY a genuine whole-project compile/);
    expect(p).toMatch(/is verify:'state'/);
    expect(p).toMatch(/NEVER verified by "build"/);
    // a data/state property must not be mislabeled build (Incident C C3)
    expect(p).toMatch(/data\/state property is NEVER verified by "build"/);
  });

  it('F5: forbids declaring one property as BOTH an AC and an invariant (double-declaration)', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz3' });
    expect(p).toMatch(/ONE HOME per property/);
    expect(p).toMatch(/never BOTH/);
    expect(p).toMatch(/Declare\s+data\/schema properties as invariants/);
  });

  it('teaches the complexity → model ladder and caps architectural seats at 2', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a paint app', appSlug: 'pa1' });
    expect(p).toContain('COMPLEXITY drives which model');
    expect(p).toMatch(/at most 2 architectural seats/);
  });

  it('brownfield prompt swaps the scaffold framing for existing-tests-are-LAW rules', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'add a replay mode', appSlug: 'pm1', brownfield: true });
    expect(p).toContain('EXISTING TEST FILES ARE LAW');
    expect(p).toContain('BROWNFIELD');
    expect(p).toMatch(/GROW the app/);
    expect(p).toMatch(/never\s+rewrite a working module/);
    expect(p).toMatch(/keep the WHOLE existing suite green/);
    expect(p).not.toContain('freshly scaffolded');
    // the greenfield prompt keeps its framing and never mentions the LAW rule
    const g = buildQuickPlanspecPrompt({ intent: 'add a replay mode', appSlug: 'pm1' });
    expect(g).toContain('freshly scaffolded');
    expect(g).not.toContain('EXISTING TEST FILES ARE LAW');
  });

  it('disables the harness DRIVE lane during QA (observe-only seam)', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a todo app', appSlug: 'td1' });
    expect(p).toMatch(/observe-only/);
    expect(p).toMatch(/forceStatus/);
  });

  it('requires the foundation/build-whole story to declare invariants for authored data', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    expect(p).toMatch(/INVARIANTS/);
    expect(p).toContain('invariants');
  });

  it('instructs the planner to give every story a phase name drawn from its own PHASES', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    // the field appears in the PLAN_SPEC schema block
    expect(p).toContain('"phase"');
    // a HARD RULE teaches phase naming + same-layer/same-phase sharing
    expect(p).toMatch(/PHASE:/);
    expect(p).toMatch(/PHASES section of your OWN PLAN_THINKING/);
    expect(p).toMatch(/same dependency layer that belong to the same phase/i);
    // generic mechanics only — no hardcoded taxonomy leaked into the prompt
    expect(p).toMatch(/Never use a hardcoded\/generic taxonomy/);
  });
});

// Incident F/G (pacman3): the assembly failures had two roots — (G) a capability
// slice grabbed APP-LEVEL surface (a second competing feature that also published
// the seam), and the planner added a redundant assemble mega-story whose job the
// foundation already did; (F) that assemble story then died on RED-first restating
// already-true foundation state. Slice A's fix is the WALKING-SKELETON model:
// the foundation owns ALL app surface + stubs every capability so the app boots
// live from batch 0, capability slices are PURE modules that replace a stub, and
// there is no redundant assemble story.
describe('buildQuickPlanspecPrompt — walking-skeleton app-surface ownership (Incident F/G)', () => {
  it('carries the APP-SURFACE OWNERSHIP hard rule: only the foundation owns feature/seam/page/composition', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    expect(p).toMatch(/app-surface ownership/i);
    expect(p).toMatch(/Exactly ONE story owns the APP SURFACE/);
    // the four app-surface artifacts the foundation exclusively owns
    expect(p).toMatch(/app feature\/entry/);
    expect(p).toMatch(/COMPOSITION file/);
    expect(p).toMatch(/run loop/);
    // a slice's touches may NOT be a feature / page / seam / composition file
    expect(p).toMatch(/A slice's touches MUST NOT include ANY `\*\.feature\.\*`/);
    expect(p).toMatch(/the app page\/entry, the seam file, or the composition\/reducer file/);
    // applies to BOTH shapes
    expect(p).toMatch(/applies to BOTH shapes/i);
    // named as the fix for the competing-feature collision (generic, no pacman)
    expect(p).toMatch(/competing-feature collision/);
    expect(p).not.toMatch(/pacman/i);
  });

  it('describes the foundation as a boots-live walking skeleton that STUBS capabilities and mounts the seam', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    expect(p).toMatch(/WALKING SKELETON/);
    expect(p).toMatch(/BOOTS LIVE from the very\s+first batch/);
    // the foundation composes the reducer + runs the loop + mounts the seam
    expect(p).toMatch(/composes the reducer .*and runs the loop/s);
    // and stubs every capability so the app boots before any slice lands
    expect(p).toMatch(/TRIVIAL STUB/);
    expect(p).toMatch(/BOOTS[\s\S]*?with the seam live BEFORE any capability lands/);
  });

  it("requires the foundation's touches to cover every file it writes, including capability stub paths", () => {
    // The walking skeleton MANDATES the foundation create a stub for every capability
    // module. If the planner omits those stub paths from the foundation's own `touches`,
    // the foundation's mandated stub write is out-of-scope → the live scope gate rejects
    // the foundation (or, in pretool-enforce, blocks the write → missing module → boot
    // fails). The prompt must close that gap.
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    expect(p).toMatch(/foundation's `touches` MUST COVER every file the foundation itself writes/);
    expect(p).toMatch(/every capability STUB module path/);
    // both remedies offered: explicit paths OR a covering directory glob
    expect(p).toMatch(/list each stub path, or declare the stub directory as a glob/);
    // the foundation↔slice overlap on a stub path is called out as legitimate
    expect(p).toMatch(/foundation↔slice overlap is legitimate/);
    // the self-check reinforces it before emit
    expect(p).toMatch(/does the FOUNDATION's touches cover EVERY file it writes/);
    // stays generic — no app/game/pacman hardcoding
    expect(p).not.toMatch(/pacman|ghost|pellet/i);
  });

  it('puts the SEAM WIRING mandate on the FOUNDATION, not on an assemble story', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    expect(p).toContain('SEAM WIRING');
    // the mandate now targets the foundation
    expect(p).toMatch(/The FOUNDATION \(walking skeleton\) story\s*[\s\S]{0,40}?— and ONLY it — MUST route the live app state through that scaffold hook/);
    // the OLD mandate ("the final Assemble the complete app story MUST route…") is gone
    expect(p).not.toMatch(/"Assemble the complete app"\s*\n?\s*story MUST route/);
    // the seam is mounted once, by the foundation; no slice may create a competing feature
    expect(p).toMatch(/NO capability slice may mount the seam or create a competing/);
  });

  it('no longer instructs a separate assemble story to compose/mount the app (both shapes)', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    // coherent phased rules: the redundant assemble story is explicitly dropped
    expect(p).toMatch(/NO redundant "assemble" story/);
    expect(p).toMatch(/the foundation ALREADY composed the app and\s*\n?\s*mounted the seam/);
    // sharded structure rule: no separate assemble story either
    expect(p).toMatch(/There is NO separate "assemble"\s*\n?\s*story — the foundation already assembled/);
    // any final story is a THIN journeys story that adds NO app surface / composition
    expect(p).toMatch(/THIN final\s*\n?\s*"end-to-end journeys" story that adds NO app surface and NO composition/);
    expect(p).toMatch(/Prefer NO final story/);
  });

  it('requires each capability slice to be a PURE MODULE that replaces its stub and carries its own behavioral AC', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a maze game', appSlug: 'mz1' });
    expect(p).toMatch(/EVERY capability slice is a PURE MODULE ONLY/);
    expect(p).toMatch(/REPLACES\s*\n?\s*its own stub/);
    // observable against the already-live app through the seam
    expect(p).toMatch(/carries its OWN behavioral AC proving its mechanic through `snapshot\(\)` against/);
  });

  it('the walking-skeleton rules stay generic — no app/game/pacman hardcoding leaks in', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a data dashboard', appSlug: 'db1' });
    expect(p).not.toMatch(/pacman|ghost|pellet/i);
  });
});

// The finding: the walking-skeleton foundation must WRITE a stub for every capability
// module (hard-imported by the reducer), yet nothing proved that the foundation's own
// stub writes clear the dev-scope contract. These tests run a parsed walking-skeleton
// plan through the REAL contract builder + REAL scope detector — the daemon's own path
// (agent-daemon.mjs builds the contract with NO siblingTouches, so forbiddenAreas is
// only DANGER_PATHS; the live gate is the touchPoints check against the story's OWN
// touches). They prove: (1) a foundation whose touches cover the stub dir clears every
// stub write; (2) a foundation that OMITS the stub path fails on that exact write —
// which is precisely what the prompt fix instructs the planner to avoid.
describe('walking-skeleton foundation stub ownership clears the scope contract (finding fix)', () => {
  // A walking-skeleton plan: the foundation owns app surface + a covering stub glob;
  // each slice owns exactly its own stub module path.
  const SKELETON_SPEC = JSON.stringify({
    planShape: 'coherent',
    stories: [
      { id: 'foundation', title: 'Define the contract and boot the app skeleton',
        touches: ['src/app.tsx', 'src/game/types.ts', 'src/game/reducer.ts', 'src/slices/**'],
        acceptanceCriteria: [{ text: 'the skeleton mounts and idles', verify: 'behavior', needsBrowser: true }] },
      { id: 'movement', title: 'Implement movement', dependsOn: ['foundation'], touches: ['src/slices/movement.ts'],
        acceptanceCriteria: [{ text: 'arrow key moves the player', verify: 'state' }] },
      { id: 'ghosts', title: 'Implement ghosts', dependsOn: ['foundation'], touches: ['src/slices/ghosts.ts'],
        acceptanceCriteria: [{ text: 'ghosts leave the vault over time', verify: 'state' }] },
    ],
  });

  // The files the foundation MUST write at RED: its app surface + composition + a TRIVIAL
  // STUB for each capability module the reducer hard-imports.
  const FOUNDATION_WRITES = [
    'src/app.tsx', 'src/game/types.ts', 'src/game/reducer.ts',
    'src/slices/movement.ts', 'src/slices/ghosts.ts', // the stubs
  ];

  it('a foundation whose touches cover the stub dir clears every one of its stub writes', () => {
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${SKELETON_SPEC}</PLAN_SPEC>`);
    const foundation = stories.find((s) => s.isFoundation);
    expect(foundation).toBeTruthy();
    // The daemon builds the contract with NO siblingTouches (agent-daemon.mjs:1741) —
    // forbiddenAreas is DANGER_PATHS only; the live check is touchPoints vs own touches.
    const contract = buildStoryDevContract({ storyNode: foundation });
    const report = detectScopeViolations({
      modifiedFiles: FOUNDATION_WRITES,
      touchPoints: contract.allowedPaths,
      forbiddenAreas: contract.forbiddenAreas,
    });
    expect(report.touchPointsViolations).toEqual([]); // every stub write is in-scope
    expect(report.forbiddenViolations).toEqual([]); // a stub is never a sibling-forbidden path
    expect(report.skipped.touchPointsCheck).toBe(false); // the check actually ran
  });

  it('a foundation that OMITS the stub path fails on its own mandated stub write (the bug the fix prevents)', () => {
    const OMITTED_SPEC = JSON.stringify({
      planShape: 'coherent',
      stories: [
        { id: 'foundation', title: 'Define the contract and boot the app skeleton',
          // NOTE: no src/slices coverage — the omission the prompt now forbids.
          touches: ['src/app.tsx', 'src/game/types.ts', 'src/game/reducer.ts'],
          acceptanceCriteria: [{ text: 'the skeleton mounts and idles', verify: 'behavior', needsBrowser: true }] },
        { id: 'ghosts', title: 'Implement ghosts', dependsOn: ['foundation'], touches: ['src/slices/ghosts.ts'],
          acceptanceCriteria: [{ text: 'ghosts leave the vault over time', verify: 'state' }] },
      ],
    });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${OMITTED_SPEC}</PLAN_SPEC>`);
    const foundation = stories.find((s) => s.isFoundation);
    const contract = buildStoryDevContract({ storyNode: foundation });
    const report = detectScopeViolations({
      modifiedFiles: ['src/app.tsx', 'src/game/types.ts', 'src/game/reducer.ts', 'src/slices/ghosts.ts'],
      touchPoints: contract.allowedPaths,
      forbiddenAreas: contract.forbiddenAreas,
    });
    // The stub the foundation had to create is out-of-scope → the foundation fails.
    expect(report.touchPointsViolations).toEqual([{ file: 'src/slices/ghosts.ts' }]);
  });

  it('foundation↔slice stub overlap does NOT trip the god-file audit (only feature↔feature does)', () => {
    // The stub path lives in BOTH the foundation's touches (glob) and the slice's touches
    // (exact). That overlap is legitimate; the audit must not flag it as a god-file.
    const { audit } = parseQuickPlanspec(`<PLAN_SPEC>${SKELETON_SPEC}</PLAN_SPEC>`);
    expect(audit.godFiles).toEqual([]);
    expect(audit.violations.join(' ')).not.toMatch(/god-file/);
  });
});

describe('buildQuickPlanspecRepairPrompt', () => {
  it('includes the failed plan, the violations, and the full base rules', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${GOD_FILE_SPEC}</PLAN_SPEC>`);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', stories, violations: audit.violations,
    });
    expect(p).toContain('REPAIR PASS');
    expect(p).toContain('Implement movement');
    expect(p).toContain('god-file');
    expect(p).toContain('SEAM WIRING'); // base rules ride along
  });

  it('renders the WIDTH directive (not PHASE) for a god-file-only violation', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${GOD_FILE_SPEC}</PLAN_SPEC>`);
    expect(audit.overSharded).toBe(false);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', stories, violations: audit.violations,
    });
    expect(p).toMatch(/DECOMPOSITION/);
    expect(p).not.toContain('# PHASE —');
  });

  it('renders the PHASE directive (in addition to width) for an over-sharded violation', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${OVER_SHARDED_SPEC}</PLAN_SPEC>`);
    expect(audit.overSharded).toBe(true);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', stories, violations: audit.violations,
    });
    expect(p).toContain('# PHASE —');
    expect(p).toMatch(/planShape.*coherent/s);
    expect(p).toMatch(/DECOMPOSITION/); // width directive still rendered alongside
  });

  it('never mandates collapsing to one story — the directive orders coupled slices into phases', () => {
    // The old COLLAPSE directive ("emit EXACTLY ONE story") minted the pacman8
    // 16-AC mega-story. The PHASE directive must order, never merge.
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${OVER_SHARDED_SPEC}</PLAN_SPEC>`);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', stories, violations: audit.violations,
    });
    expect(p).not.toContain('EXACTLY ONE story');
    expect(p).toMatch(/ORDER the coupled slices into a phased chain/);
    expect(p).toMatch(/NEVER collapse the plan to a single story/);
  });

  it('passes brownfield through to the embedded base prompt', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${GOD_FILE_SPEC}</PLAN_SPEC>`);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', brownfield: true, stories, violations: audit.violations,
    });
    expect(p).toContain('EXISTING TEST FILES ARE LAW');
    expect(p).not.toContain('freshly scaffolded');
  });

  it('instructs the repair pass to keep a phase name on every re-emitted story', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${GOD_FILE_SPEC}</PLAN_SPEC>`);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', stories, violations: audit.violations,
    });
    expect(p).toMatch(/Keep a "phase" name on every story/);
  });
});

describe('parseQuickPlanspec', () => {
  it('extracts stories, assigns ids, and derives foundation→feature→integration deps', () => {
    const { stories, errors } = parseQuickPlanspec(`chatter…\n<PLAN_SPEC>${SPEC}</PLAN_SPEC>\nmore`);
    expect(errors).toEqual([]);
    expect(stories).toHaveLength(3);
    const [found, feat, integ] = stories;
    expect(found.storyId).toMatch(/[0-9a-f-]{36}/);
    expect(found.depends_on).toEqual([]); // foundation
    expect(feat.depends_on).toEqual([found.storyId]); // feature → foundation
    expect(integ.depends_on.sort()).toEqual([found.storyId, feat.storyId].sort()); // integration → all
    // AC coercion
    expect(feat.acceptanceCriteria[0].needsBrowser).toBe(true);
    expect(feat.acceptanceCriteria[0].acClass).toBe('deterministic');
    expect(found.acceptanceCriteria[0].testBinding.status).toBe('unbound');
  });

  it('tolerates a bare/fenced JSON object (no tags)', () => {
    const { stories } = parseQuickPlanspec('```json\n' + SPEC + '\n```');
    expect(stories).toHaveLength(3);
  });

  it('reports an error when there is no parseable spec', () => {
    const { stories, errors } = parseQuickPlanspec('the model refused and wrote prose only');
    expect(stories).toEqual([]);
    expect(errors[0]).toMatch(/no <PLAN_SPEC>/);
  });

  it('extracts the PLAN_THINKING narrative when present', () => {
    const thinking = 'CLASSIFICATION: arcade game, coherent — one game loop.\nPHASES: contract → movement → assemble.';
    const { planNarrative, stories } = parseQuickPlanspec(
      `<PLAN_THINKING>\n${thinking}\n</PLAN_THINKING>\n<PLAN_SPEC>${SPEC}</PLAN_SPEC>`,
    );
    expect(planNarrative).toBe(thinking);
    expect(stories).toHaveLength(3); // spec parsing unaffected by the prose block
  });

  it('returns an empty narrative when PLAN_THINKING is absent', () => {
    const { planNarrative } = parseQuickPlanspec(`<PLAN_SPEC>${SPEC}</PLAN_SPEC>`);
    expect(planNarrative).toBe('');
  });

  it('caps an oversize narrative at 4000 chars (it rides in a plan row)', () => {
    const big = 'CLASSIFICATION: ' + 'x'.repeat(6000);
    const { planNarrative } = parseQuickPlanspec(
      `<PLAN_THINKING>${big}</PLAN_THINKING>\n<PLAN_SPEC>${SPEC}</PLAN_SPEC>`,
    );
    expect(planNarrative).toHaveLength(4000);
  });

  it('keeps the narrative even when the spec JSON is unparseable (traceable artifact)', () => {
    const { planNarrative, errors } = parseQuickPlanspec(
      '<PLAN_THINKING>CLASSIFICATION: something</PLAN_THINKING>\nthen the JSON got garbled',
    );
    expect(errors[0]).toMatch(/no <PLAN_SPEC>/);
    expect(planNarrative).toContain('CLASSIFICATION');
  });

  it('maps slug dependsOn → minted storyIds and keeps the model-authored wide DAG', () => {
    const { stories, errors, audit } = parseQuickPlanspec(`<PLAN_SPEC>${WIDE_SPEC}</PLAN_SPEC>`);
    expect(errors).toEqual([]);
    expect(stories).toHaveLength(5);
    const [contract, movement, scoring, ghosts, assemble] = stories;
    expect(movement.depends_on).toEqual([contract.storyId]);
    expect(scoring.depends_on).toEqual([contract.storyId]);
    expect(ghosts.depends_on).toEqual([contract.storyId]);
    expect(assemble.depends_on.sort()).toEqual(
      [contract.storyId, movement.storyId, scoring.storyId, ghosts.storyId].sort(),
    );
    expect(audit.modelAuthored).toBe(true);
    expect(audit.maxWidth).toBe(3); // the three slices share one level
    expect(audit.criticalPath).toBe(3); // contract → slices → assemble
    expect(audit.violations).toEqual([]);
    const { summary } = buildStoryNodeRows({ stories, planId: 'p', appId: 'a' });
    expect(summary).toEqual({ stories: 5, ready: 1, blocked: 4, maxBatch: 2 });
  });

  it('serializes co-eligible stories that share a touch (scope-safety) and flags the god-file', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${GOD_FILE_SPEC}</PLAN_SPEC>`);
    expect(audit.safetyEdges).toBeGreaterThan(0); // reducer.ts overlaps got dependency-ordered
    expect(audit.violations.join(' ')).toMatch(/god-file/);
    expect(audit.violations.join(' ')).toContain('src/game/reducer.ts');
    // safety edges keep the plan CORRECT for the shared-tree frontier: no two
    // co-eligible stories share a file.
    const byId = new Map(stories.map((s) => [s.storyId, s]));
    const levels = new Map(
      buildStoryNodeRows({ stories, planId: 'p', appId: 'a' }).rows.map((r) => [r.storyId, r.cohortBatch]),
    );
    for (const a of stories) {
      for (const b of stories) {
        if (a === b || levels.get(a.storyId) !== levels.get(b.storyId)) continue;
        const shared = a.touches.filter((t) => t !== '<EPIC_WIDE>' && b.touches.includes(t));
        expect({ pair: [a.title, b.title], shared }).toEqual({ pair: [a.title, b.title], shared: [] });
      }
    }
    expect(byId.size).toBe(5);
  });

  it('breaks dependency cycles deterministically (frontier would deadlock)', () => {
    const cyc = JSON.stringify({ stories: [
      { id: 'alpha', title: 'Alpha widget', dependsOn: ['beta'], touches: ['src/a.ts'],
        acceptanceCriteria: [{ text: 'alpha works fine', verify: 'build' }] },
      { id: 'beta', title: 'Beta widget', dependsOn: ['alpha'], touches: ['src/b.ts'],
        acceptanceCriteria: [{ text: 'beta works fine', verify: 'build' }] },
    ] });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${cyc}</PLAN_SPEC>`);
    const [alpha, beta] = stories;
    expect(alpha.depends_on).toEqual([beta.storyId]); // first-emitted edge wins
    expect(beta.depends_on).toEqual([]); // back-edge dropped
    const { summary } = buildStoryNodeRows({ stories, planId: 'p', appId: 'a' });
    expect(summary.ready).toBe(1); // no deadlock: something can start
  });

  it('anchors a zero-dep slice on the foundation (contract must exist first)', () => {
    const spec = JSON.stringify({ stories: [
      { id: 'contract', title: 'Define the contract types', touches: ['src/types.ts'],
        acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
      { id: 'list', title: 'Implement the list view', dependsOn: ['contract'], touches: ['src/slices/list.ts'],
        acceptanceCriteria: [{ text: 'list renders rows', verify: 'appearance', needsBrowser: true }] },
      { id: 'detail', title: 'Implement the detail view', dependsOn: [], touches: ['src/slices/detail.ts'],
        acceptanceCriteria: [{ text: 'detail shows fields', verify: 'appearance', needsBrowser: true }] },
    ] });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    const [contract, , detail] = stories;
    expect(detail.depends_on).toEqual([contract.storyId]);
  });

  it('makes the final assemble story depend on every other story', () => {
    const spec = JSON.stringify({ stories: [
      { id: 'contract', title: 'Define the contract types', touches: ['src/types.ts'],
        acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
      { id: 'list', title: 'Implement the list view', dependsOn: ['contract'], touches: ['src/slices/list.ts'],
        acceptanceCriteria: [{ text: 'list renders rows', verify: 'appearance', needsBrowser: true }] },
      { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract'], touches: ['src/app.tsx'],
        acceptanceCriteria: [{ text: 'the app runs end to end', verify: 'behavior', needsBrowser: true }] },
    ] });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    const [contract, list, assemble] = stories;
    expect(assemble.depends_on.sort()).toEqual([contract.storyId, list.storyId].sort());
  });

  it('needsBrowser tracks verify:behavior only — a pure verify:state AC is NOT browser-required', () => {
    // Slice C: the old `verify !== build` rule wrongly flagged pure-reducer state
    // ACs as needsBrowser, forcing them down the browser path. Tighten to behavior.
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${WIDE_SPEC}</PLAN_SPEC>`);
    const [, movement, scoring, ghosts] = stories;
    expect(movement.acceptanceCriteria[0].verify).toBe('behavior');
    expect(movement.acceptanceCriteria[0].needsBrowser).toBe(true); // app-level
    expect(scoring.acceptanceCriteria[0].verify).toBe('state');
    expect(scoring.acceptanceCriteria[0].needsBrowser).toBeUndefined(); // pure reducer → unit
    expect(ghosts.acceptanceCriteria[0].needsBrowser).toBeUndefined();
  });

  it('honors an explicit model-authored needsBrowser:true even on a state AC', () => {
    const spec = JSON.stringify({ stories: [
      { id: 'c', title: 'Define the contract types', touches: ['src/types.ts'],
        acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
      { id: 'x', title: 'Implement widget', dependsOn: ['c'], touches: ['src/slices/x.ts'],
        acceptanceCriteria: [{ text: 'state flips on toggle', verify: 'state', needsBrowser: true }] },
    ] });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(stories[1].acceptanceCriteria[0].needsBrowser).toBe(true);
  });

  it('appearance ACs become advisory-taste; missing ACs synthesize one', () => {
    const { stories } = parseQuickPlanspec(
      `<PLAN_SPEC>${JSON.stringify({ stories: [
        { title: 'Show splash', acceptanceCriteria: [{ text: 'the splash looks right', verify: 'appearance', needsBrowser: true }] },
        { title: 'No criteria story' },
      ] })}</PLAN_SPEC>`,
    );
    expect(stories[0].acceptanceCriteria[0].acClass).toBe('advisory-taste');
    expect(stories[1].acceptanceCriteria).toHaveLength(1); // synthesized
  });

  it('reads planShape + planShapeRationale from the model JSON when present', () => {
    const spec = JSON.stringify({
      planShape: 'coherent',
      planShapeRationale: 'one game loop; sharding buys nothing',
      stories: [
        { title: 'Build the complete pacman game', touches: ['src/**'], complexity: 'architectural',
          acceptanceCriteria: [{ text: 'the game runs end to end', verify: 'behavior', needsBrowser: true }] },
      ],
    });
    const { planShape, planShapeRationale } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(planShape).toBe('coherent');
    expect(planShapeRationale).toBe('one game loop; sharding buys nothing');
  });

  it("forces the coherent build-whole story to FOUNDATION despite its 'the complete' title", () => {
    // "Build the complete <app>" matches INTEGRATION_RE, so classify() alone would
    // tag it 'integration' and the hardened foundation gate (boot-liveness) would
    // never run on the exact single-loop shape it targets. planShape wins here.
    const spec = JSON.stringify({
      planShape: 'coherent',
      stories: [
        { title: 'Build the complete pacman game', touches: ['src/**'], complexity: 'architectural',
          acceptanceCriteria: [{ text: 'the game runs end to end', verify: 'behavior', needsBrowser: true }] },
      ],
    });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(stories).toHaveLength(1);
    expect(stories[0].nodeKind).toBe('foundation');
    expect(stories[0].isFoundation).toBe(true);
  });

  it('forces stories[0] to FOUNDATION on a coherent multi-story plan with no classified foundation', () => {
    // A phased-coherent model may title its contract story past FOUNDATION_RE
    // (e.g. "Core loop skeleton") — the boot-liveness gate keys off isFoundation,
    // so a coherent plan must never ship without a foundation seat.
    const spec = JSON.stringify({
      planShape: 'coherent',
      stories: [
        { id: 'core', title: 'Core loop skeleton that boots', touches: ['src/core.ts'],
          acceptanceCriteria: [{ text: 'the skeleton mounts and idles', verify: 'behavior', needsBrowser: true }] },
        { id: 'movement', title: 'Player movement', dependsOn: ['core'], touches: ['src/movement.ts'],
          acceptanceCriteria: [{ text: 'arrow key moves the player', verify: 'state' }] },
        { id: 'ghosts', title: 'Ghost chase behavior', dependsOn: ['movement'], touches: ['src/ghosts.ts'],
          acceptanceCriteria: [{ text: 'ghosts chase the player', verify: 'state' }] },
      ],
    });
    const { stories, planShape } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(planShape).toBe('coherent');
    expect(stories.map((s) => s.nodeKind === 'foundation')).toEqual([true, false, false]);
    expect(stories[0].isFoundation).toBe(true);
  });

  it('leaves a classified foundation alone on a coherent multi-story plan', () => {
    const spec = JSON.stringify({
      planShape: 'coherent',
      stories: [
        { id: 'contract', title: 'Define the contract types and state model', touches: ['src/types.ts'],
          acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
        { id: 'movement', title: 'Player movement', dependsOn: ['contract'], touches: ['src/movement.ts'],
          acceptanceCriteria: [{ text: 'arrow key moves the player', verify: 'state' }] },
      ],
    });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(stories[0].isFoundation).toBe(true); // classified, not forced
    expect(stories[1].isFoundation).toBe(false);
  });

  it('defaults planShape to coherent for a single-story plan when the model omits it', () => {
    const spec = JSON.stringify({
      stories: [
        { title: 'Build the complete widget', touches: ['src/**'],
          acceptanceCriteria: [{ text: 'the widget works end to end', verify: 'behavior', needsBrowser: true }] },
      ],
    });
    const { planShape } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(planShape).toBe('coherent');
  });

  it('defaults planShape to sharded for a multi-story plan when the model omits it', () => {
    const { planShape } = parseQuickPlanspec(`<PLAN_SPEC>${SPEC}</PLAN_SPEC>`);
    expect(planShape).toBe('sharded');
  });

  it('ignores a garbage planShape value and falls back to size-based derivation', () => {
    const spec = JSON.stringify({ planShape: 'medium-ish', stories: JSON.parse(SPEC).stories });
    const { planShape } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(planShape).toBe('sharded'); // 3 stories, garbage value ignored
  });

  it('sets nodeKind/isFoundation on stories, mirroring classify()', () => {
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${SPEC}</PLAN_SPEC>`);
    const [found, feat, integ] = stories;
    expect(found.nodeKind).toBe('foundation');
    expect(found.isFoundation).toBe(true);
    expect(feat.nodeKind).toBe('feature');
    expect(feat.isFoundation).toBe(false);
    expect(integ.nodeKind).toBe('integration');
    expect(integ.isFoundation).toBe(false);
  });

  it('coerces a model-authored phase onto each story (trimmed, capped ≤40 chars)', () => {
    const spec = JSON.stringify({
      stories: [
        { id: 'contract', title: 'Define the contract types', phase: '  Foundation  ', touches: ['src/types.ts'],
          acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
        { id: 'movement', title: 'Implement movement', dependsOn: ['contract'],
          phase: 'x'.repeat(60), touches: ['src/slices/movement.ts'],
          acceptanceCriteria: [{ text: 'arrow key moves the player', verify: 'state' }] },
        { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract', 'movement'],
          touches: ['src/app.tsx'],
          acceptanceCriteria: [{ text: 'the app runs end to end', verify: 'behavior', needsBrowser: true }] },
      ],
    });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    const [contract, movement, assemble] = stories;
    expect(contract.phase).toBe('Foundation'); // trimmed
    expect(movement.phase).toHaveLength(40); // capped
    expect(assemble.phase).toBeUndefined(); // absent stays undefined
  });

  it('carries the parsed phase through buildStoryNodeRows onto the row', () => {
    const spec = JSON.stringify({
      stories: [
        { id: 'contract', title: 'Define the contract types', phase: 'Foundation', touches: ['src/types.ts'],
          acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
        { id: 'movement', title: 'Implement movement', dependsOn: ['contract'], phase: 'core-mechanics',
          touches: ['src/slices/movement.ts'],
          acceptanceCriteria: [{ text: 'arrow key moves the player', verify: 'state' }] },
      ],
    });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    const { rows } = buildStoryNodeRows({ stories, planId: 'p', appId: 'a' });
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('Define the contract types').phase).toBe('Foundation');
    expect(byTitle.get('Implement movement').phase).toBe('core-mechanics');
  });

  it('tolerates an absent or non-string phase (stays undefined, no throw)', () => {
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${SPEC}</PLAN_SPEC>`); // SPEC has no phase
    expect(stories.every((s) => s.phase === undefined)).toBe(true);
    const spec = JSON.stringify({
      stories: [
        { id: 'c', title: 'Define the contract types', phase: 42, touches: ['src/types.ts'],
          acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
        { id: 'x', title: 'Implement widget', dependsOn: ['c'], phase: '   ', touches: ['src/x.ts'],
          acceptanceCriteria: [{ text: 'widget works fine', verify: 'state' }] },
      ],
    });
    const { stories: s2 } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    expect(s2[0].phase).toBeUndefined(); // non-string ignored
    expect(s2[1].phase).toBeUndefined(); // whitespace-only trims to empty -> undefined
  });

  it('parses invariants onto the foundation story: mints ids, drops malformed entries', () => {
    const spec = JSON.stringify({
      stories: [
        { title: 'Define the contract types and state model', touches: ['src/types.ts'],
          acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }],
          invariants: [
            { id: 'maze-reachable', description: 'every pellet cell has a path to the exit' },
            { description: 'every seeded id resolves in the schema' }, // no id -> minted
            { description: 'ab' }, // too short -> dropped
            { id: 'no-description' }, // missing description -> dropped
            'not an object', // wrong type -> dropped
          ] },
        { title: 'Implement the dino entity', dependsOn: [], touches: ['src/dino.ts'],
          acceptanceCriteria: [{ text: 'dino jumps when Space pressed', verify: 'state' }] },
      ],
    });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    const [found, feat] = stories;
    expect(found.invariants).toHaveLength(2);
    // Model-emitted slugs are NAMESPACED with the minted storyId: the id feeds
    // the mandated `<id>.invariant.test.*` file name and the gate's worktree-wide
    // convention rebind, so a bare slug shared by two stories would bind one
    // story's gate to the OTHER story's validator file.
    expect(found.invariants[0]).toEqual({
      id: `${found.storyId}-maze-reachable`,
      description: 'every pellet cell has a path to the exit',
      validator: { status: 'declared' },
    });
    expect(found.invariants[1].id).toBe(`${found.storyId}-inv2`);
    expect(found.invariants[1].validator.status).toBe('declared');
    expect(feat.invariants).toEqual([]); // non-foundation story declared none
  });

  it('namespaces invariant ids per story: the SAME model-emitted slug on two stories yields distinct ids', () => {
    const spec = JSON.stringify({
      stories: [
        { title: 'Define the contract types and state model', touches: ['src/types.ts'],
          acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }],
          invariants: [{ id: 'seed-data-valid', description: 'every seeded id resolves in the schema' }] },
        { title: 'Implement the level loader', dependsOn: [], touches: ['src/levels.ts'],
          acceptanceCriteria: [{ text: 'levels load without error', verify: 'state' }],
          invariants: [{ id: 'seed-data-valid', description: 'every level references only seeded ids' }] },
      ],
    });
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${spec}</PLAN_SPEC>`);
    const [a, b] = stories;
    expect(a.invariants[0].id).toBe(`${a.storyId}-seed-data-valid`);
    expect(b.invariants[0].id).toBe(`${b.storyId}-seed-data-valid`);
    expect(a.invariants[0].id).not.toBe(b.invariants[0].id);
  });
});

describe('detectOverSharding', () => {
  const feature = (title, root) => ({
    title,
    touches: [`src/slices/${title.replace(/\s+/g, '-').toLowerCase()}.ts`],
    acceptanceCriteria: [{ text: 'does a thing', thenObservable: `snapshot.${root} changes` }],
  });

  it('flags 4 feature stories that all observe the same snapshot root (entities)', () => {
    const stories = [
      feature('Implement pacman movement', 'entities'),
      feature('Implement ghost AI', 'entities'),
      feature('Implement scoring', 'entities'),
      feature('Implement level rendering', 'entities'),
    ];
    const result = detectOverSharding(stories);
    expect(result.overSharded).toBe(true);
    expect(result.sharedRoot).toBe('entities');
    expect(result.coupledCount).toBe(4);
    expect(result.featureCount).toBe(4);
  });

  it('does not flag 4 feature stories that each observe a distinct snapshot root', () => {
    const stories = [
      feature('Implement routing', 'route'),
      feature('Implement auth', 'auth'),
      feature('Implement mutations', 'mutation'),
      feature('Implement navigation', 'nav'),
    ];
    const result = detectOverSharding(stories);
    expect(result.overSharded).toBe(false);
  });

  it('never flags fewer than 3 feature stories, even if they share a root', () => {
    const stories = [feature('Implement movement', 'entities'), feature('Implement scoring', 'entities')];
    const result = detectOverSharding(stories);
    expect(result.overSharded).toBe(false);
    expect(result.featureCount).toBe(2);
  });
});

describe('auditPlanGraph', () => {
  it('flags over-sharding when >60% of feature stories share a snapshot root', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${OVER_SHARDED_SPEC}</PLAN_SPEC>`);
    expect(audit.overSharded).toBe(true);
    expect(audit.sharedRoot).toBe('entities');
    expect(audit.violations.join(' ')).toMatch(/over-sharded/);
    expect(audit.violations.join(' ')).toContain('snapshot.entities');
    expect(audit.violations.join(' ')).toContain("planShape:'coherent'");
    // Direct call on the normalized stories agrees with the parsed audit.
    expect(auditPlanGraph(stories).overSharded).toBe(true);
  });


  it('flags a linear chain of false dependencies even with disjoint files', () => {
    const chain = JSON.stringify({ stories: [
      { id: 's1', title: 'Define the contract types', touches: ['src/types.ts'],
        acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
      { id: 's2', title: 'Implement movement', dependsOn: ['s1'], touches: ['src/slices/movement.ts'],
        acceptanceCriteria: [{ text: 'movement works well', verify: 'state' }] },
      { id: 's3', title: 'Implement scoring', dependsOn: ['s2'], touches: ['src/slices/scoring.ts'],
        acceptanceCriteria: [{ text: 'scoring works well', verify: 'state' }] },
      { id: 's4', title: 'Implement ghosts', dependsOn: ['s3'], touches: ['src/slices/ghosts.ts'],
        acceptanceCriteria: [{ text: 'ghosts work well', verify: 'state' }] },
      { id: 's5', title: 'Assemble the complete app', dependsOn: ['s4'], touches: ['src/app.tsx'],
        acceptanceCriteria: [{ text: 'the app runs end to end', verify: 'behavior', needsBrowser: true }] },
    ] });
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${chain}</PLAN_SPEC>`);
    expect(audit.violations.join(' ')).toMatch(/linear-chain/);
    expect(audit.godFiles).toEqual([]);
    expect(audit.maxWidth).toBe(1);
    expect(auditPlanGraph(stories).criticalPath).toBe(5);
  });

  it('a coherent 5-story phased chain is the intended shape — NO linear-chain violation', () => {
    const chain = JSON.stringify({ planShape: 'coherent', stories: [
      { id: 's1', title: 'Define the contract types and boot skeleton', touches: ['src/types.ts', 'src/core.ts'],
        acceptanceCriteria: [{ text: 'the skeleton boots and idles', verify: 'behavior', needsBrowser: true }] },
      { id: 's2', title: 'Player movement', dependsOn: ['s1'], touches: ['src/movement.ts'],
        acceptanceCriteria: [{ text: 'movement works well', verify: 'state' }] },
      { id: 's3', title: 'Pellet eating', dependsOn: ['s2'], touches: ['src/pellets.ts'],
        acceptanceCriteria: [{ text: 'pellets get eaten', verify: 'state' }] },
      { id: 's4', title: 'Ghost chase behavior', dependsOn: ['s3'], touches: ['src/ghosts.ts'],
        acceptanceCriteria: [{ text: 'ghosts chase well', verify: 'state' }] },
      { id: 's5', title: 'Assemble & harden the complete app', dependsOn: ['s4'], touches: ['src/app.tsx'],
        acceptanceCriteria: [{ text: 'the app runs end to end', verify: 'behavior', needsBrowser: true }] },
    ] });
    const { stories, audit, planShape } = parseQuickPlanspec(`<PLAN_SPEC>${chain}</PLAN_SPEC>`);
    expect(planShape).toBe('coherent');
    expect(audit.violations).toEqual([]);
    // the SAME graph audited as sharded still trips the chain smell — the skip is
    // shape-scoped, not a blanket removal of the guardrail
    expect(auditPlanGraph(stories, { planShape: 'sharded' }).violations.join(' ')).toMatch(/linear-chain/);
    expect(auditPlanGraph(stories, { planShape: 'coherent' }).violations).toEqual([]);
  });

  it('mega-story fires at 7 acceptance criteria, not at 6 (hard AC budget)', () => {
    const ac = (i) => ({ text: `criterion number ${i} holds`, verify: 'state' });
    const mk = (n) => [{
      storyId: 'sx', title: 'Build the whole thing', touches: ['src/**'], depends_on: [],
      acceptanceCriteria: Array.from({ length: n }, (_, i) => ac(i + 1)),
    }];
    const at6 = auditPlanGraph(mk(6), { planShape: 'coherent' });
    expect(at6.violations).toEqual([]);
    const at7 = auditPlanGraph(mk(7), { planShape: 'coherent' });
    expect(at7.violations.join(' ')).toMatch(/mega-story/);
    expect(at7.violations.join(' ')).toContain('"Build the whole thing" has 7 acceptance criteria (max 6)');
    expect(at7.violations.join(' ')).toMatch(/split it into phased stories/);
    // shape-independent: a sharded mega-story is just as unbindable
    expect(auditPlanGraph(mk(7), { planShape: 'sharded' }).violations.join(' ')).toMatch(/mega-story/);
  });

  it('over-sharded never fires for a coherent plan (shared snapshot root is by design)', () => {
    const coherent = JSON.stringify({ planShape: 'coherent', ...JSON.parse(OVER_SHARDED_SPEC) });
    const { audit, planShape } = parseQuickPlanspec(`<PLAN_SPEC>${coherent}</PLAN_SPEC>`);
    expect(planShape).toBe('coherent');
    expect(audit.violations.join(' ')).not.toMatch(/over-sharded/);
    // the detection metric is still reported — only the violation is shape-gated
    expect(audit.overSharded).toBe(true);
    expect(audit.sharedRoot).toBe('entities');
  });

  it('a wide contract-first plan passes clean', () => {
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${WIDE_SPEC}</PLAN_SPEC>`);
    const audit = auditPlanGraph(stories);
    expect(audit.violations).toEqual([]);
    expect(audit.levels).toEqual([1, 3, 1]);
    expect(audit.chainRun).toBeLessThanOrEqual(2);
  });

  it('is safe on empty input', () => {
    expect(auditPlanGraph([]).violations).toEqual([]);
  });
});

describe('buildStoryNodeRows', () => {
  it('assigns cohortBatch levels + ready/blocked from the derived DAG', () => {
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${SPEC}</PLAN_SPEC>`);
    const { rows, summary } = buildStoryNodeRows({ stories, planId: 'p1', appId: 'a1', now: () => 'T' });
    expect(summary).toEqual({ stories: 3, ready: 1, blocked: 2, maxBatch: 2 });
    const byBatch = rows.map((r) => r.cohortBatch).sort();
    expect(byBatch).toEqual([0, 1, 2]);
    const found = rows.find((r) => r.title.includes('types'));
    expect(found.state).toBe('ready');
    expect(found.unblockedDepsCount).toBe(0);
    expect(found.planId).toBe('p1');
    expect(found.createdAt).toBe('T');
  });
});
