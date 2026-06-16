import { describe, it, expect, vi } from 'vitest';
import {
  applyConceptArtifactOutput,
  artifactJobVars,
  artifactSourceFromJob,
} from '../concept-artifact-service';
import { generateSectionManifest } from '../../concept/section-manifest';
import { recordApproval, applyEdit, type ConceptArtifact } from '../../concept/artifact-version';
import type { Plan } from '../../types/plan';
import type { AgentJob } from '../../types/agent-orchestrator';

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

  it('autopilot re-apply of IDENTICAL content never resurrects a stale row (Story 3.3)', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const hash = generateSectionManifest(ARCH_MD, { artifact: 'architecture', rev: 0 }).manifest
      .contentHash;
    // A row marked stale (regenerate requested), whose old content hash matches
    // the OLD completed generator job we re-apply.
    const plan = {
      planId: 'p1',
      conceptArtifacts: [
        { kind: 'architecture', rev: 1, contentHash: hash, status: 'stale', dependsOn: [] },
      ],
    } as unknown as Plan;
    const res = await applyConceptArtifactOutput(
      plan,
      'architecture',
      { rawMarkdown: ARCH_MD },
      { updatePlanFields, autoApprove: true },
    );
    expect(res).toMatchObject({ status: 'stale', changed: false });
    expect(updatePlanFields).not.toHaveBeenCalled();
  });

  it('autopilot apply of NEW content to a stale row advances + approves it (Story 3.3)', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const plan = {
      planId: 'p1',
      conceptArtifacts: [
        { kind: 'architecture', rev: 1, contentHash: 'sha256:old', status: 'stale', dependsOn: [] },
      ],
    } as unknown as Plan;
    const res = await applyConceptArtifactOutput(
      plan,
      'architecture',
      { rawMarkdown: ARCH_MD },
      { updatePlanFields, autoApprove: true },
    );
    expect(res).toMatchObject({ rev: 2, status: 'approved', changed: true });
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
});

describe('artifactJobVars + artifactSourceFromJob (E2.4 — job → apply source)', () => {
  function job(vars: Record<string, string>): AgentJob {
    return { jobId: 'j1', status: 'COMPLETED', variables: vars } as unknown as AgentJob;
  }

  it('maps each kind to its MD + SECTIONS_JSON variable names', () => {
    expect(artifactJobVars('prd')).toEqual({ mdVar: 'PRD_MD', sectionsVar: 'PRD_SECTIONS_JSON' });
    expect(artifactJobVars('ux')).toEqual({ mdVar: 'UX_MD', sectionsVar: 'UX_SECTIONS_JSON' });
    expect(artifactJobVars('architecture')).toEqual({
      mdVar: 'ARCHITECTURE_MD',
      sectionsVar: 'ARCHITECTURE_SECTIONS_JSON',
    });
  });

  it('prefers the daemon-captured manifest sidecar variable', () => {
    const { manifest } = generateSectionManifest(ARCH_MD, { artifact: 'architecture', rev: 0 });
    const src = artifactSourceFromJob(
      job({ ARCHITECTURE_SECTIONS_JSON: JSON.stringify(manifest), ARCHITECTURE_MD: ARCH_MD }),
      'architecture',
    );
    expect('manifest' in src ? src.manifest?.contentHash : undefined).toBe(manifest.contentHash);
  });

  it('falls back to raw MD when no manifest var is present', () => {
    const src = artifactSourceFromJob(job({ PRD_MD: PRD_MD }), 'prd');
    expect('rawMarkdown' in src ? src.rawMarkdown : undefined).toBe(PRD_MD);
  });

  it('throws when the job carries neither variable', () => {
    expect(() => artifactSourceFromJob(job({}), 'prd')).toThrow(/neither/);
  });

  it('throws on a corrupt manifest JSON var', () => {
    expect(() => artifactSourceFromJob(job({ PRD_SECTIONS_JSON: '{bad' }), 'prd')).toThrow(
      /not valid JSON/,
    );
  });

  it('end-to-end: job → source → apply registers the row', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const { manifest } = generateSectionManifest(PRD_MD, { artifact: 'prd', rev: 0 });
    const plan = {
      planId: 'p1',
      conceptArtifacts: [{ kind: 'prd', rev: 0, contentHash: '', status: 'draft', dependsOn: [] }],
    } as unknown as Plan;
    const src = artifactSourceFromJob(job({ PRD_SECTIONS_JSON: JSON.stringify(manifest) }), 'prd');
    const res = await applyConceptArtifactOutput(plan, 'prd', src, { updatePlanFields });
    expect(res).toMatchObject({ kind: 'prd', rev: 1, changed: true });
    expect(res.contentHash).toBe(manifest.contentHash);
  });
});

describe('concept-artifact-service — validation guards', () => {
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
