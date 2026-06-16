import { describe, it, expect } from 'vitest';
import { buildPmPlanPrompt } from '../pm-plan-prompt';

const baseArgs = {
  planName: 'dino-runner',
  intent: 'Build a dino-runner browser game',
  executionMode: 'pipeline' as const,
};

describe('buildPmPlanPrompt — boilerplate-aware contract', () => {
  describe('nextjs', () => {
    const prompt = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });

    it('mentions Next.js as the framework', () => {
      expect(prompt).toContain('Next.js');
    });

    it('does NOT mention "Vite+React+TS" anywhere', () => {
      // The v1 hardcoded "Vite+React+TS" string was the disease — fail loudly
      // if it ever creeps back in.
      expect(prompt).not.toContain('Vite+React+TS');
      expect(prompt).not.toMatch(/Vite\s*\+\s*React\s*\+\s*TypeScript/i);
    });

    it('uses Next.js conventional paths in the example', () => {
      expect(prompt).toContain('src/types/');
      expect(prompt).toContain('src/app/');
      expect(prompt).toContain('next.config.ts');
    });

    it('uses npm run build / npm run dev as commands', () => {
      expect(prompt).toContain('npm run build');
      expect(prompt).toContain('npm run dev');
    });

    it('lists what is already scaffolded (do-not-recreate hint)', () => {
      expect(prompt).toContain('ALREADY in place');
      expect(prompt).toContain('Next.js');
    });

    it('explicitly forbids "Bootstrap with X" / "Create a new project" ACs', () => {
      // The anti-disease guardrail.
      expect(prompt).toContain('never propose');
      expect(prompt.toLowerCase()).toContain('scaffold from scratch');
    });
  });

  describe('vite', () => {
    const prompt = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'vite', rigor: 'mvp' });

    it('mentions Vite as the framework', () => {
      expect(prompt).toContain('Vite');
    });

    it('uses Vite conventional paths', () => {
      expect(prompt).toContain('src/main.tsx');
      expect(prompt).toContain('vite.config.ts');
    });

    it('uses vite build in example AC', () => {
      expect(prompt).toContain('vite build');
    });
  });

  describe('rigor variation', () => {
    it('prototype guidance suggests 1-3 ACs per story', () => {
      const prompt = buildPmPlanPrompt({
        ...baseArgs,
        boilerplateType: 'nextjs-base',
        rigor: 'prototype',
      });
      expect(prompt).toContain('Prototype rigor');
      expect(prompt).toContain('1-3 ACs');
    });

    it('mvp guidance suggests 3-5 ACs per story', () => {
      const prompt = buildPmPlanPrompt({
        ...baseArgs,
        boilerplateType: 'nextjs-base',
        rigor: 'mvp',
      });
      expect(prompt).toContain('MVP rigor');
      expect(prompt).toContain('3-5 ACs');
    });

    it('production guidance suggests 4-6 ACs per story', () => {
      const prompt = buildPmPlanPrompt({
        ...baseArgs,
        boilerplateType: 'nextjs-base',
        rigor: 'production',
      });
      expect(prompt).toContain('Production rigor');
      expect(prompt).toContain('4-6 ACs');
    });
  });

  describe('error handling', () => {
    it('throws on unknown boilerplate type', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'bogus' as any, rigor: 'mvp' }),
      ).toThrow(/unknown boilerplateType/);
    });
  });

  describe('plan name & intent are still injected verbatim', () => {
    it('injects plan name', () => {
      const prompt = buildPmPlanPrompt({
        ...baseArgs,
        planName: 'my-cool-plan',
        boilerplateType: 'nextjs-base',
        rigor: 'mvp',
      });
      expect(prompt).toContain('my-cool-plan');
    });

    it('injects intent', () => {
      const prompt = buildPmPlanPrompt({
        ...baseArgs,
        intent: 'Build a fancy thing',
        boilerplateType: 'nextjs-base',
        rigor: 'mvp',
      });
      expect(prompt).toContain('Build a fancy thing');
    });
  });
});

/**
 * Concept v2 — Story E1.5: the PM prompt must teach the `verify` intent and
 * apply the relaxed idle-visible rule (appearance MUST be idle-visible;
 * behavior/state MAY describe a post-interaction state).
 */
describe('buildPmPlanPrompt — Concept v2 verify intent + idle-visible relaxation (E1.5)', () => {
  const prompt = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });

  it('instructs the PM to set a verify intent on every AC, listing all five', () => {
    expect(prompt).toContain('`verify` intent on every AC');
    for (const v of ['build', 'appearance', 'state', 'behavior', 'manual']) {
      expect(prompt).toContain(v);
    }
  });

  it('requires manualReason from the closed enum for manual ACs', () => {
    expect(prompt).toContain('manualReason');
    expect(prompt).toContain('no-stub-possible');
    expect(prompt.toLowerCase()).toContain('dodge');
  });

  it('relaxes idle-visible: appearance MUST be idle-visible, behavior/state MAY be post-interaction', () => {
    expect(prompt).toContain("verify:'appearance'");
    expect(prompt).toContain('idle-visible');
    expect(prompt).toContain('POST-INTERACTION');
    // The probe reaches post-interaction state — the old "contort into a load frame" rule is gone.
    expect(prompt).toContain('appearance floor');
  });

  it('keeps `then` prose-observable (PM authors no assertions)', () => {
    expect(prompt).toContain('PROSE-OBSERVABLE');
  });
});

/**
 * Concept v2 — Story E3.1: the PM emits BMAD-grade story fields
 * (userStory/technicalNotes/tasks) for mvp/production; prototype stays lean.
 * references[] are NOT emitted yet (Epic E7).
 */
describe('buildPmPlanPrompt — BMAD-grade story fields are rigor-gated (E3.1)', () => {
  const mvp = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });
  const proto = buildPmPlanPrompt({
    ...baseArgs,
    boilerplateType: 'nextjs-base',
    rigor: 'prototype',
  });

  it('mvp instructs userStory + technicalNotes + tasks with acRefs', () => {
    expect(mvp).toContain('BMAD-grade definition');
    expect(mvp).toContain('userStory');
    expect(mvp).toContain('technicalNotes');
    expect(mvp).toContain('acRefs');
    // The example JSON shows the enriched shape.
    expect(mvp).toContain('"tasks"');
  });

  it('mvp does NOT yet ask for references[] (deferred to E7)', () => {
    expect(mvp).toContain('Do NOT emit `references[]`');
  });

  it('prototype stays lean — no BMAD-grade fields in the example or instructions', () => {
    expect(proto).toContain('keep stories lean');
    expect(proto).not.toContain('"userStory"');
    expect(proto).not.toContain('BMAD-grade definition');
  });
});

/**
 * Concept v2 — Story E7.8: the PM cites artifact sections via references[] ONLY
 * when citableSections are supplied (i.e. after prd/ux/architecture exist).
 */
describe('buildPmPlanPrompt — references[] are gated on citableSections (E7.8)', () => {
  it('mvp WITHOUT citableSections defers references', () => {
    const p = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });
    expect(p).toContain('Do NOT emit `references[]` yet');
  });

  it('mvp WITH citableSections instructs citing those exact ids', () => {
    const p = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'mvp',
      citableSections: { architecture: ['state-model', 'error-handling'], prd: ['fr-3'] },
    });
    expect(p).toContain('cite the upstream artifacts');
    expect(p).toContain('architecture: state-model, error-handling');
    expect(p).toContain('prd: fr-3');
    expect(p).not.toContain('Do NOT emit `references[]` yet');
  });

  it('prototype ignores citableSections (stays lean)', () => {
    const p = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'prototype',
      citableSections: { architecture: ['state-model'] },
    });
    expect(p).toContain('keep stories lean');
    expect(p).not.toContain('cite the upstream artifacts');
  });
});
