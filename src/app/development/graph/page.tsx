'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { GraphViewer } from '@/components/development/graph-viewer';

export default function GraphPage() {
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <div>
            <h1 className="text-page-title">Knowledge Graph</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Real-time view of the Memgraph knowledge graph for a project. Nodes are wiki articles
              authored by the Compiler agent after each story passes review; edges come from{' '}
              <code>[[wikilinks]]</code> in those articles. Snapshot is refreshed by{' '}
              <code>compile-sync</code> after every story.
            </p>
          </div>
          <GraphViewer />
        </div>
      </AppShell>
    </AuthGuard>
  );
}
