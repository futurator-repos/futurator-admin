/**
 * skill-scout-pipeline-builder.test.mjs — Pipeline v2 Phase 3-C Epic 3
 * (Story 3.3, 2026-05-20).
 *
 * Sanity tests for the daemon-side mirror of generateSkillScoutPipeline.
 * Keep this file in sync with the TS-side equivalent
 * (`functions/shared/pipelines/__tests__/skill-scout-pipeline.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import {
  buildSkillScoutPromptDaemon,
  buildSkillScoutPipelineDaemon,
} from '../skill-scout-pipeline-builder.mjs';

describe('buildSkillScoutPromptDaemon', () => {
  it('embeds projectSlug + trigger + boilerplateKind in the header', () => {
    const p = buildSkillScoutPromptDaemon({
      trigger: 'T1',
      projectSlug: 'dino-test-3',
      boilerplateKind: 'nextjs-canvas-game',
    });
    expect(p).toContain('PROJECT: dino-test-3');
    expect(p).toContain('TRIGGER: T1');
    expect(p).toContain('BOILERPLATE: nextjs-canvas-game');
  });

  it('includes T1 trigger guidance for T1 trigger', () => {
    const p = buildSkillScoutPromptDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b',
    });
    expect(p).toContain('Project init');
    expect(p).not.toContain('PLAN INTENT'); // T1 has no plan intent
  });

  it('includes PLAN INTENT placeholder for T2 trigger', () => {
    const p = buildSkillScoutPromptDaemon({
      trigger: 'T2', projectSlug: 'a', boilerplateKind: 'b',
    });
    expect(p).toContain('PLAN INTENT (T2):');
    expect(p).toContain('{{planIntent}}');
  });

  it('embeds {{currentManifestYaml}} + {{federationYaml}} placeholders', () => {
    const p = buildSkillScoutPromptDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b',
    });
    expect(p).toContain('{{currentManifestYaml}}');
    expect(p).toContain('{{federationYaml}}');
  });

  it('emits OUTPUT CONTRACT block with between-marker schema', () => {
    const p = buildSkillScoutPromptDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b',
    });
    expect(p).toContain('---SKILL_PROPOSALS---');
    expect(p).toContain('---END_SKILL_PROPOSALS---');
    expect(p).toContain('"manifestBucket"');
    expect(p).toContain('"confidence"');
  });
});

describe('buildSkillScoutPipelineDaemon', () => {
  it('produces a pipeline with one agent + one step', () => {
    const pl = buildSkillScoutPipelineDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b', rigor: 'prototype',
    });
    expect(Object.keys(pl.agents)).toEqual(['SKILL_SCOUT']);
    expect(pl.steps).toHaveLength(1);
    expect(pl.steps[0].id).toBe('skill-scout-resolve');
    expect(pl.steps[0].agentId).toBe('SKILL_SCOUT');
  });

  it('declares the SKILL_PROPOSALS_JSON between-extractor', () => {
    const pl = buildSkillScoutPipelineDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b', rigor: 'prototype',
    });
    const ext = pl.steps[0].extractors.SKILL_PROPOSALS_JSON;
    expect(ext.type).toBe('between');
    expect(ext.startDelimiter).toBe('---SKILL_PROPOSALS---');
    expect(ext.endDelimiter).toBe('---END_SKILL_PROPOSALS---');
  });

  it('agent config carries name + allowedTools + model', () => {
    const pl = buildSkillScoutPipelineDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b',
      rigor: 'prototype',
    });
    const agent = pl.agents.SKILL_SCOUT;
    expect(agent.name).toBe('Skill Scout');
    expect(agent.model).toBe('sonnet');
    expect(typeof agent.allowedTools).toBe('string');
    expect(agent.allowedTools.length).toBeGreaterThan(0);
  });

  it('allows model override (Opus for skill-author sub-plan)', () => {
    const pl = buildSkillScoutPipelineDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b',
      rigor: 'production', model: 'opus',
    });
    expect(pl.agents.SKILL_SCOUT.model).toBe('opus');
  });

  it('sets maxIterations = 2 (matches TS module)', () => {
    const pl = buildSkillScoutPipelineDaemon({
      trigger: 'T1', projectSlug: 'a', boilerplateKind: 'b', rigor: 'prototype',
    });
    expect(pl.maxIterations).toBe(2);
  });
});
