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

/**
 * Pipeline v3 — E1-S1: the PM emits `requirementRefs` on each epic (the FR-
 * coverage traceability spine) ONLY when planning from approved specs.
 */
describe('buildPmPlanPrompt — requirementRefs FR coverage (v3 E1-S1)', () => {
  it('grounded plan instructs + shows requirementRefs in the example', () => {
    const p = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'production',
      priorArtifacts: '## Functional Requirements\nFR1. A\nFR2. B',
    });
    expect(p).toContain('requirementRefs');
    expect(p).toContain('TRACEABILITY TAG'); // softened wording: a tag, not an expansion driver
    expect(p).toContain('"requirementRefs": ["FR1", "FR2"]');
    expect(p).toContain('every PRD `FR` id appears in at least one epic');
  });

  it('intent-only plan (no PRD) omits requirementRefs from the example', () => {
    const p = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });
    expect(p).not.toContain('"requirementRefs": ["FR1", "FR2"]');
  });
});

/**
 * Pipeline v3 — E2-S1: the verbose planning essays were condensed to cut
 * instruction tokens WITHOUT dropping any directive or validator-keyed phrase.
 */
describe('buildPmPlanPrompt — prose slimming preserves keyed text (v3 E2-S1)', () => {
  const p = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });

  it('keeps every validator-keyed / behavior-contract phrase', () => {
    for (const keyed of [
      'REJECTED at the', // touch-points hard rule (kept verbatim)
      'your plan is REJECTED without it', // visual-coverage hard requirement
      'needsBrowser: true',
      "verify:'appearance'",
      'idle-visible',
      'POST-INTERACTION',
      'appearance floor',
      'never propose',
      'scaffold from scratch',
    ]) {
      expect(p).toContain(keyed);
    }
  });

  // D1-A1 (2026-06-22) — feature-registration is a CAPABILITY of nextjs-*
  // starters (wiring: 'feature-registry'), not universal law. nextjs-base HAS
  // that wiring, so its prompt keeps the registration block; the harness/seam
  // language only appears for a boilerplate that actually ships a testHarness
  // (canvas-game), never leaked into a seam-less app.
  it('renders feature-registry block for a feature-registry boilerplate', () => {
    for (const keyed of ['PROGRESSIVE FEATURE REGISTRATION', 'src/features/', 'primary: true']) {
      expect(p).toContain(keyed);
    }
    // No seam on nextjs-base → no __harness probe language.
    expect(p).not.toContain('window.__harness');
  });

  it('renders the seam probe language ONLY for a boilerplate with a testHarness', () => {
    const game = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-canvas-game',
      rigor: 'mvp',
    });
    expect(game).toContain('window.__harness');
    // And the game few-shots are data-driven from the registry, not the prompt.
    expect(game).toContain('GAME OVER');
  });

  // D1-A1/A2/A3 (2026-06-22) — a route-based (non-feature-registry) boilerplate
  // must NOT inherit the single-page feature-registration model or game/sprite
  // few-shots. sst is route/API-based (no `wiring`).
  it('renders route-mounting (NOT feature-registration) for a route-based boilerplate', () => {
    const sst = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'sst', rigor: 'mvp' });
    expect(sst).toContain('MOUNT ON A REAL ROUTE');
    expect(sst).not.toContain('PROGRESSIVE FEATURE REGISTRATION');
    expect(sst).not.toContain('src/features/');
    expect(sst).not.toContain('primary: true');
    // De-gamed: no sprite/HUD/Pacman few-shots bleed into a non-game plan.
    expect(sst).not.toContain('sprite');
    expect(sst).not.toContain('Pacman');
    expect(sst).not.toContain('DinoState');
  });

  it('carries the output-budget contract (the 32K-cap truncation fix)', () => {
    // The pm-plan must be told to stay within the output cap and close the fence,
    // or a large plan overflows the CLI's CLAUDE_CODE_MAX_OUTPUT_TOKENS and is
    // never captured (the pacmanv3 32:32 / no-PLAN_JSON failure, 2026-06-20).
    expect(p).toContain('Output budget');
    expect(p).toContain('truncated');
    expect(p).toMatch(/6–12 stories/);
    expect(p).toContain('---END_PLAN_JSON---');
    const prod = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'production',
    });
    expect(prod).toMatch(/≤ ~18 stories/);
  });

  // D4 (2026-06-22) — COMPACT RETRY. After an overflow (terminal-empty prior
  // attempt), the re-fired generation must aim SMALLER, not re-emit the same
  // over-long plan that truncated.
  it('compact retry tightens the budget and adds the overflow banner', () => {
    const normal = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });
    const compact = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'mvp',
      compact: true,
    });
    // Normal mvp = 6–12 ceiling; compact = a tighter hard limit + banner.
    expect(normal).toMatch(/6–12 stories/);
    expect(normal).not.toContain('COMPACT RETRY');
    expect(compact).toContain('COMPACT RETRY');
    expect(compact).toMatch(/≤ 6 stories total/);
    expect(compact).not.toMatch(/6–12 stories/);
    // Production compact is tighter than its ~18 default.
    const prodCompact = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'production',
      compact: true,
    });
    expect(prodCompact).toMatch(/≤ 10 stories total/);
    expect(prodCompact).not.toMatch(/≤ ~18 stories/);
  });

  it('still no larger than the pre-slim prompt (regression ceiling)', () => {
    // Pre-E2-S1 mvp prompt: 21,958 chars. After the essay slimming it was
    // 20,409; the v3 output-budget contract (the fix for the 32K-token pm-plan
    // truncation, 2026-06-20) deliberately adds back ~1.2k → 21,650, still under
    // the original. The budget block is load-bearing (it prevents truncated,
    // un-parseable plans), so the ceiling tracks the original, not the trough.
    expect(p.length).toBeLessThan(21958);
  });
});

describe('buildPmPlanPrompt — {{CITABLE_SECTIONS}} placeholder (E5.1)', () => {
  it('mvp + expectsCitations, no inline sections → emits the daemon placeholder', () => {
    const p = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'mvp',
      expectsCitations: true,
    });
    expect(p).toContain('{{CITABLE_SECTIONS}}');
    expect(p).toContain('cite the upstream artifacts');
    expect(p).not.toContain('Do NOT emit `references[]` yet');
  });

  it('inline citableSections win over the placeholder', () => {
    const p = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'mvp',
      expectsCitations: true,
      citableSections: { prd: ['fr-1'] },
    });
    expect(p).toContain('prd: fr-1');
    expect(p).not.toContain('{{CITABLE_SECTIONS}}');
  });

  it('enriched WITHOUT expectsCitations → defers references (no placeholder)', () => {
    const p = buildPmPlanPrompt({ ...baseArgs, boilerplateType: 'nextjs-base', rigor: 'mvp' });
    expect(p).not.toContain('{{CITABLE_SECTIONS}}');
    expect(p).toContain('Do NOT emit `references[]` yet');
  });

  it('prototype + expectsCitations → byte-identical lean output (no placeholder)', () => {
    const p = buildPmPlanPrompt({
      ...baseArgs,
      boilerplateType: 'nextjs-base',
      rigor: 'prototype',
      expectsCitations: true,
    });
    expect(p).not.toContain('{{CITABLE_SECTIONS}}');
    expect(p).toContain('keep stories lean');
  });
});
