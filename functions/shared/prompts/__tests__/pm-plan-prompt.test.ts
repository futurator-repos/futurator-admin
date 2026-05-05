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
