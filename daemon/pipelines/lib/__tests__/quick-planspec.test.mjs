import { describe, it, expect } from 'vitest';
import {
  buildQuickPlanspecPrompt,
  buildQuickPlanspecRepairPrompt,
  parseQuickPlanspec,
  auditPlanGraph,
  buildStoryNodeRows,
  detectOverSharding,
} from '../quick-planspec.mjs';

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
    expect(p).toMatch(/COHERENT SHAPE/);
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

  it('renders the WIDTH directive (not COLLAPSE) for a god-file-only violation', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${GOD_FILE_SPEC}</PLAN_SPEC>`);
    expect(audit.overSharded).toBe(false);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', stories, violations: audit.violations,
    });
    expect(p).toMatch(/DECOMPOSITION/);
    expect(p).not.toContain('# COLLAPSE');
  });

  it('renders the COLLAPSE directive (in addition to width) for an over-sharded violation', () => {
    const { stories, audit } = parseQuickPlanspec(`<PLAN_SPEC>${OVER_SHARDED_SPEC}</PLAN_SPEC>`);
    expect(audit.overSharded).toBe(true);
    const p = buildQuickPlanspecRepairPrompt({
      intent: 'a pacman game', appSlug: 'pm1', stories, violations: audit.violations,
    });
    expect(p).toContain('# COLLAPSE');
    expect(p).toMatch(/planShape.*coherent/s);
    expect(p).toMatch(/DECOMPOSITION/); // width directive still rendered alongside
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
    expect(found.invariants[0]).toEqual({
      id: 'maze-reachable',
      description: 'every pellet cell has a path to the exit',
      validator: { status: 'declared' },
    });
    expect(found.invariants[1].id).toBe(`${found.storyId}-inv2`);
    expect(found.invariants[1].validator.status).toBe('declared');
    expect(feat.invariants).toEqual([]); // non-foundation story declared none
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
