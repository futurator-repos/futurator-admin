/**
 * hotspot-graph.test.ts — the pure graph deriver for the Assess Graph subtab.
 */

import { describe, it, expect } from 'vitest';
import { buildHotspotGraph } from '../hotspot-graph';
import type { AuditHotspot } from '@/types/refactor-audit';

const h = (over: Partial<AuditHotspot>): AuditHotspot => ({
  kind: 'duplicate-subsystem',
  score: 50,
  severity: 'high',
  title: 't',
  files: [],
  evidence: {},
  suggestedAction: '',
  ...over,
});

describe('buildHotspotGraph', () => {
  it('returns empty for no hotspots', () => {
    expect(buildHotspotGraph([])).toEqual({ nodes: [], links: [] });
  });

  it('renders a god-object as a single class node (no synthetic center)', () => {
    const g = buildHotspotGraph([
      h({ kind: 'god-object', title: 'God-object: AWSProfileStorage', files: ['src/lib/aws.ts'] }),
    ]);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({ id: 'src/lib/aws.ts', kind: 'class' });
    expect(g.links).toHaveLength(0);
  });

  it('renders a duplicate hotspot as a center→files star', () => {
    const g = buildHotspotGraph([
      h({ kind: 'duplicate-subsystem', title: 'Duplicate "x.ts"', files: ['a/x.ts', 'b/x.ts'] }),
    ]);
    // 1 synthetic center + 2 files
    expect(g.nodes).toHaveLength(3);
    expect(g.links).toHaveLength(2);
    expect(
      g.links.every((l) => typeof l.source === 'string' && l.source.startsWith('hotspot:')),
    ).toBe(true);
  });

  it('strips the "(N files)" suffix from version-root file entries', () => {
    const g = buildHotspotGraph([
      h({
        kind: 'duplicate-subsystem',
        title: 'Version-marked',
        files: ['src/components/onboarding-v2  (12 files)'],
      }),
    ]);
    const fileNode = g.nodes.find((n) => n.kind === 'file');
    expect(fileNode?.id).toBe('src/components/onboarding-v2');
  });

  it('dedupes a file shared across hotspots', () => {
    const g = buildHotspotGraph([
      h({ kind: 'duplicate-subsystem', title: 'A', files: ['shared.ts'] }),
      h({ kind: 'low-cohesion-split', title: 'B', files: ['shared.ts'] }),
    ]);
    expect(g.nodes.filter((n) => n.id === 'shared.ts')).toHaveLength(1);
    expect(g.links).toHaveLength(2); // both centers link to the one shared file
  });
});
