import { describe, it, expect, vi } from 'vitest';
import { applyConceptArtifactOutput } from '../concept-artifact-service';
import { generateSectionManifest } from '../../concept/section-manifest';
import { recordApproval, applyEdit, type ConceptArtifact } from '../../concept/artifact-version';
import type { Plan } from '../../types/plan';

const ARCH_MD = ['# Architecture', '', 'body', '', '## Tech Stack', '', 'stack'].join('\n');
const PRD_MD = ['# PRD', '', 'scope', '', '## Functional Requirements', '', 'FR1'].join('\n');

function seeded(): ConceptArtifact[] {
  return [
    { kind: 'prd', rev: 0, contentHash: '', status: 'draft', dependsOn: [] },
    { kind: 'architecture', rev: 0, contentHash: '', status: 'draft', dependsOn: ['prd'] },
  ];
}

describe('concept-artifact-service (E1.3 — generic apply funnel)', () => {
  it('first landing bumps a seeded rev:0 row to draft/rev:1 with the manifest contentHash', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const plan = { planId: 'p1', conceptArtifacts: seeded() } as Plan;
    const res = await applyConceptArtifactOutput(
      plan,
      'architecture',
      { rawMarkdown: ARCH_MD },
      {
        updatePlanFields,
      },
    );
    const expectedHash = generateSectionManifest(ARCH_MD, { artifact: 'architecture', rev: 0 })
      .manifest.contentHash;
    expect(res).toMatchObject({ kind: 'architecture', rev: 1, status: 'draft', changed: true });
    expect(res.contentHash).toBe(expectedHash);
    const patch = updatePlanFields.mock.calls[0][1];
    const arch = patch.conceptArtifacts?.find((a) => a.kind === 'architecture');
    expect(arch).toMatchObject({ rev: 1, status: 'draft', contentHash: expectedHash });
  });

  it('accepts a prebuilt on-disk sidecar manifest WITHOUT re-annotating (hash verbatim)', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const { manifest } = generateSectionManifest(ARCH_MD, { artifact: 'architecture', rev: 1 });
    const plan = { planId: 'p1', conceptArtifacts: seeded() } as Plan;
    const res = await applyConceptArtifactOutput(
      plan,
      'architecture',
      { manifest },
      {
        updatePlanFields,
      },
    );
    expect(res.contentHash).toBe(manifest.contentHash);
    expect(res.changed).toBe(true);
  });

  it('re-apply with identical content is a no-op (no double rev bump, no write)', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const hash = generateSectionManifest(ARCH_MD, { artifact: 'architecture', rev: 0 }).manifest
      .contentHash;
    const plan = {
      planId: 'p1',
      conceptArtifacts: [
        { kind: 'prd', rev: 1, contentHash: 'sha256:prd', status: 'draft', dependsOn: [] },
        { kind: 'architecture', rev: 1, contentHash: hash, status: 'draft', dependsOn: ['prd'] },
      ],
    } as Plan;
    const res = await applyConceptArtifactOutput(
      plan,
      'architecture',
      { rawMarkdown: ARCH_MD },
      {
        updatePlanFields,
      },
    );
    expect(res).toMatchObject({ rev: 1, changed: false });
    expect(updatePlanFields).not.toHaveBeenCalled();
  });

  it('re-apply with NEW content (regenerate) bumps the rev again', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const plan = {
      planId: 'p1',
      conceptArtifacts: [
        { kind: 'architecture', rev: 1, contentHash: 'sha256:old', status: 'draft', dependsOn: [] },
      ],
    } as unknown as Plan;
    const res = await applyConceptArtifactOutput(
      plan,
      'architecture',
      { rawMarkdown: ARCH_MD },
      {
        updatePlanFields,
      },
    );
    expect(res.rev).toBe(2);
    expect(res.changed).toBe(true);
  });

  it('editing the PRD flips an approved dependent architecture stale (W1 cascade)', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    // Build a registry where prd+arch are approved (arch pins prd hash).
    let registry: ConceptArtifact[] = [
      { kind: 'prd', rev: 1, contentHash: 'sha256:prd-v1', status: 'draft', dependsOn: [] },
      {
        kind: 'architecture',
        rev: 1,
        contentHash: 'sha256:arch',
        status: 'draft',
        dependsOn: ['prd'],
      },
    ];
    registry = recordApproval(registry, 'prd');
    registry = recordApproval(registry, 'architecture'); // snapshots prd hash
    expect(registry.find((a) => a.kind === 'architecture')!.status).toBe('approved');

    // Now the PRD is regenerated through the apply-service → new hash → cascade.
    const plan = { planId: 'p1', conceptArtifacts: registry } as Plan;
    await applyConceptArtifactOutput(plan, 'prd', { rawMarkdown: PRD_MD }, { updatePlanFields });
    const patch = updatePlanFields.mock.calls[0][1];
    const arch = patch.conceptArtifacts?.find((a) => a.kind === 'architecture');
    expect(arch?.status).toBe('stale');
    // sanity: the same cascade is what artifact-version's applyEdit produces directly.
    const direct = applyEdit(
      registry,
      'prd',
      patch.conceptArtifacts!.find((a) => a.kind === 'prd')!.contentHash,
    );
    expect(direct.find((a) => a.kind === 'architecture')!.status).toBe('stale');
  });

  it('throws on empty markdown and on a sectionless document', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const plan = { planId: 'p1', conceptArtifacts: seeded() } as Plan;
    await expect(
      applyConceptArtifactOutput(
        plan,
        'architecture',
        { rawMarkdown: '   ' },
        { updatePlanFields },
      ),
    ).rejects.toThrow(/empty/);
    await expect(
      applyConceptArtifactOutput(
        plan,
        'architecture',
        { rawMarkdown: 'just prose, no headings' },
        { updatePlanFields },
      ),
    ).rejects.toThrow(/no ATX headings/);
  });
});
