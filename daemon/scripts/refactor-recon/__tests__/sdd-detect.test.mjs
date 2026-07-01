/**
 * sdd-detect.test.mjs — content-signal SDD-readiness detector. Must find design
 * intent ANYWHERE (no folder convention) and report low for spec-less brownfield.
 */

import { describe, it, expect } from 'vitest';
import { buildSddReport, classifyDoc, detectApiContract } from '../sdd-detect.mjs';

const f = (rel, content) => ({ rel, content });
const has = (r, check) => r.findings.some((x) => x.evidence?.check === check);

describe('classifyDoc — design intent by content, not folder', () => {
  it('recognizes ADRs by template shape or path/name', () => {
    expect(classifyDoc('notes/0007-use-dynamo.md', '# Use Dynamo\n## Status\nAccepted\n## Context\n…\n## Decision\n…')).toBe('adr');
    expect(classifyDoc('random/decisions/x.md', '## Status\nProposed\n## Consequences\n…')).toBe('adr');
  });
  it('recognizes PRDs and user stories by requirement language', () => {
    expect(classifyDoc('a.md', 'Acceptance Criteria:\n- must do x')).toBe('prd');
    expect(classifyDoc('b.md', 'As a user I want to log in so that…')).toBe('story');
    expect(classifyDoc('c.md', 'Feature: login\n  Scenario: happy path\n    Given a user')).toBe('story');
  });
  it('recognizes design/architecture docs + mermaid', () => {
    expect(classifyDoc('deep/ARCHITECTURE.md', '## Architecture\nWe use…')).toBe('design');
    expect(classifyDoc('x.md', '```mermaid\ngraph TD\n```')).toBe('design');
    expect(classifyDoc('README.md', '## Architecture\n…')).toBe('design');
  });
  it('ignores a plain README / non-spec doc', () => {
    expect(classifyDoc('README.md', '# app\nnpm install && npm run dev')).toBe(null);
  });
});

describe('detectApiContract', () => {
  it('detects OpenAPI / GraphQL / protobuf / JSON-schema', () => {
    expect(detectApiContract('api.yaml', 'openapi: 3.0.1\npaths: {}')).toBe('openapi');
    expect(detectApiContract('schema.graphql', 'type Query { me: User }')).toBe('graphql');
    expect(detectApiContract('svc.proto', 'syntax = "proto3";\nmessage X {}')).toBe('protobuf');
    expect(detectApiContract('s.json', '{"$schema":"https://json-schema.org/draft/2020-12/schema"}')).toBe('jsonschema');
    expect(detectApiContract('pkg.json', '{"name":"x"}')).toBe(null);
  });
});

describe('buildSddReport', () => {
  it('spec-less brownfield → zero specs + the "no design intent" migration finding', () => {
    const r = buildSddReport([f('README.md', '# app\nrun it'), f('src/a.ts', 'export const x = 1')]);
    expect(r.summary.specCount).toBe(0);
    expect(r.summary.hasSpecs).toBe(false);
    expect(has(r, 'no-design-intent')).toBe(true);
  });

  it('rich SDD → high signal diversity, no migration finding', () => {
    const r = buildSddReport([
      f('docs/0001-db.md', '## Status\nAccepted\n## Decision\nUse Dynamo'),
      f('docs/PRD.md', 'Acceptance Criteria:\n- x'),
      f('ARCHITECTURE.md', '## Architecture\n```mermaid\ngraph TD\n```'),
      f('api/openapi.yaml', 'openapi: 3.1.0\npaths: {}'),
    ]);
    expect(r.summary.specCount).toBe(4);
    expect(r.summary.signals).toBe(4); // adr + prd + design + apiContract
    expect(has(r, 'no-design-intent')).toBe(false);
  });

  it('design docs but no ADRs → gentle "record decisions" nudge', () => {
    const r = buildSddReport([f('design/system.md', '## Architecture\n…')]);
    expect(r.summary.designDocCount).toBe(1);
    expect(r.summary.adrCount).toBe(0);
    expect(has(r, 'no-adrs')).toBe(true);
  });

  it('finds specs regardless of folder (cluttered repo)', () => {
    const r = buildSddReport([f('random/deep/nested/whatever-0003-thing.md', '## Status\nAccepted\n## Context\nx')]);
    expect(r.summary.adrCount).toBe(1);
  });
});
