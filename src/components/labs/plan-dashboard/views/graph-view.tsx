'use client';

import { GraphViewer } from '@/components/development/graph-viewer';

/**
 * Plan-scoped knowledge graph view. The Memgraph `projectId` is derived from
 * the app's working dir folder (which is the appId), so all plans against the
 * same app share one cumulative graph here.
 */
export function GraphView({ projectId }: { projectId: string | null }) {
  if (!projectId) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
        No project ID resolved for this plan — graph viewer needs an appId.
      </div>
    );
  }
  return <GraphViewer projectId={projectId} />;
}
