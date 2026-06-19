import { describe, it, expect } from 'vitest';
import { runSolutioningGate, type GateInput } from '../solutioning-gate';
import { generateSectionManifest } from '../../concept/section-manifest';
import type { EpicWorkflow } from '../../types/epic-workflow';

const { manifest: archManifest } = generateSectionManifest(
  `# Architecture\n\nIntro.\n\n## State Model\n\nReducer.`,
  { artifact: 'architecture', rev: 1 },
);

/** A clean, well-formed epic with a foundation epic + a BDD-rich story. */
function cleanEpics(overrides: Partial<EpicWorkflow['stories'][number]> = {}): EpicWorkflow[] {
  return [
    {
      epicId: 'E-1',
      title: 'Foundation',
      description: 'Foundation',
      acceptanceCriteria: '',
      workingDir: '/x',
      status: 'draft',
      dependsOnEpics: [],
      requirementRefs: ['FR-1'],
      stories: [
        {
          storyId: 'S-1',
          order: 0,
          title: 'Render board',
          description: 'desc',
          status: 'pending',
          userStory: { role: 'player', action: 'see the board', benefit: 'play' },
          criteria: [
            {
              id: 'AC-1',
              text: 'board renders at load',
              needsBrowser: true,
              given: 'a fresh load',
              when: 'the page loads',
              then: 'the board is visible',
              verify: 'appearance',
            },
          ],
          ...overrides,
        },
      ],
    },
  ] as unknown as EpicWorkflow[];
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    plan: {
      rigor: 'mvp',
      conceptPlan: {
        uiBearing: true,
        complexity: 'low',
        artifacts: [],
        gate: 'light',
        rationale: 'r',
      },
    },
    epics: cleanEpics(),
    ...over,
  };
}

describe('runSolutioningGate (Concept v2 — E9)', () => {
  it('prototype auto-passes (no gate)', () => {
    const r = runSolutioningGate(input({ plan: { rigor: 'prototype' } }));
    expect(r.verdict).toBe('auto-pass');
    expect(r.blocks).toBe(false);
  });

  it('a clean mvp plan is ready', () => {
    const r = runSolutioningGate(input());
    expect(r.verdict).toBe('ready');
    expect(r.blocks).toBe(false);
  });

  it('E9.2 — no foundation epic blocks (not-ready)', () => {
    const epics = cleanEpics();
    epics[0].dependsOnEpics = ['E-2']; // every epic now depends on something
    const r = runSolutioningGate(input({ epics }));
    expect(r.verdict).toBe('not-ready');
    expect(r.blocks).toBe(true);
    expect(r.errors.join(' ')).toMatch(/foundation epic|unknown epic/i);
  });

  it('E9.3 [W2] — a dangling reference (not in manifest) is a blocking error', () => {
    const epics = cleanEpics({
      references: [{ source: 'architecture', section: 'made-up' }],
    });
    const r = runSolutioningGate(input({ epics, manifests: { architecture: archManifest } }));
    expect(r.blocks).toBe(true);
    expect(r.errors.join(' ')).toContain('made-up');
  });

  it('E9.3 — a resolving reference passes', () => {
    const epics = cleanEpics({ references: [{ source: 'architecture', section: 'state-model' }] });
    const r = runSolutioningGate(input({ epics, manifests: { architecture: archManifest } }));
    expect(r.verdict).toBe('ready');
  });

  it('E9.4 [W5] — a manual AC surfaces as a condition; missing manualReason blocks', () => {
    const withManual = cleanEpics({
      criteria: [
        { id: 'AC-1', text: 'renders', needsBrowser: true, verify: 'appearance' },
        {
          id: 'AC-2',
          text: 'real payment',
          needsBrowser: false,
          verify: 'manual',
          manualReason: 'real-payment',
        },
      ],
    });
    const r = runSolutioningGate(input({ epics: withManual }));
    expect(r.verdict).toBe('ready-with-conditions');
    expect(r.conditions.join(' ')).toMatch(/manual AC/i);

    const missingReason = cleanEpics({
      criteria: [{ id: 'AC-2', text: 'x', needsBrowser: false, verify: 'manual' }],
    });
    const r2 = runSolutioningGate(input({ epics: missingReason }));
    expect(r2.blocks).toBe(true);
  });

  it('E9.4 [W9] — appearance floor: condition at mvp, error at production', () => {
    const noAppearance = cleanEpics({
      criteria: [
        {
          id: 'AC-1',
          text: 'score rises',
          needsBrowser: true,
          given: 'g',
          when: 'w',
          then: 't',
          verify: 'behavior',
        },
      ],
    });
    const mvp = runSolutioningGate(
      input({
        epics: noAppearance,
        plan: {
          rigor: 'mvp',
          conceptPlan: {
            uiBearing: true,
            complexity: 'low',
            artifacts: [],
            gate: 'light',
            rationale: 'r',
          },
        },
      }),
    );
    expect(mvp.verdict).toBe('ready-with-conditions');
    expect(mvp.blocks).toBe(false);

    const prod = runSolutioningGate(
      input({
        epics: noAppearance,
        plan: {
          rigor: 'production',
          conceptPlan: {
            uiBearing: true,
            complexity: 'low',
            artifacts: [],
            gate: 'strict',
            rationale: 'r',
          },
        },
      }),
    );
    expect(prod.verdict).toBe('not-ready');
    expect(prod.blocks).toBe(true);
  });

  it('E9.5 [W7c] — non-UI route with a visual AC raises a reconciliation condition', () => {
    const r = runSolutioningGate(
      input({
        plan: {
          rigor: 'mvp',
          conceptPlan: {
            uiBearing: false,
            complexity: 'low',
            artifacts: [],
            gate: 'light',
            rationale: 'r',
          },
        },
      }),
    );
    expect(r.conditions.join(' ')).toMatch(/non-UI-bearing|re-check the route/i);
  });

  it('E9.3 — references are NOT checked when manifests are omitted (Lambda start-gate defers to decompose)', () => {
    const epics = cleanEpics({ references: [{ source: 'architecture', section: 'anything' }] });
    // No manifests passed (the start endpoint can't read EC2 disk) → no error.
    const r = runSolutioningGate(input({ epics }));
    expect(r.verdict).toBe('ready');
    expect(r.errors).toEqual([]);
  });

  it('E1-S2 — PRD requirement coverage: an uncovered FR is a condition at mvp, error at production', () => {
    // cleanEpics() covers FR-1 via requirementRefs; FR-99 is dropped.
    const prdRequirementIds = ['FR-1', 'FR-99'];
    const mvp = runSolutioningGate(input({ prdRequirementIds }));
    expect(mvp.verdict).toBe('ready-with-conditions');
    expect(mvp.blocks).toBe(false);
    expect(mvp.conditions.join(' ')).toMatch(/FR-99 is not covered/);

    const prod = runSolutioningGate(
      input({
        prdRequirementIds,
        plan: {
          rigor: 'production',
          conceptPlan: {
            uiBearing: true,
            complexity: 'low',
            artifacts: [],
            gate: 'strict',
            rationale: 'r',
          },
        },
      }),
    );
    expect(prod.verdict).toBe('not-ready');
    expect(prod.blocks).toBe(true);
    expect(prod.errors.join(' ')).toMatch(/FR-99 is not covered/);
  });

  it('E1-S2 — fully-covered PRD requirements pass; absent prdRequirementIds skips the check', () => {
    expect(runSolutioningGate(input({ prdRequirementIds: ['FR-1'] })).verdict).toBe('ready');
    // Legacy/prototype: no PRD ids supplied → coverage branch is inert.
    expect(runSolutioningGate(input()).verdict).toBe('ready');
  });

  it('the readiness report renders the verdict + issues', () => {
    const epics = cleanEpics({ references: [{ source: 'architecture', section: 'nope' }] });
    const r = runSolutioningGate(input({ epics, manifests: { architecture: archManifest } }));
    expect(r.report).toContain('# Implementation readiness report');
    expect(r.report).toContain('Blocking issues');
  });
});
