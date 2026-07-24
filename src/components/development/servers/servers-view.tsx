'use client';
import { useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FleetTab } from './fleet-tab';
import { PolicyTab } from './policy-tab';
import { MonitoringTab } from './monitoring-tab';
// Queue + Tests are the former standalone "Queues" module, now folded in as
// tabs. Imported directly (no wrappers) — they own their own state/hooks.
import { QueuesTab } from '@/components/development/queues/queues-tab';
import { TestsTab } from '@/components/development/queues/tests-tab';

// Dispatch control center. All agentic work — fleet health, live host
// telemetry, inbound REST queue, dispatch policy and dispatch tests — lives
// under these tabs. Deep-linked via ?tab= for bookmarks and cross-page links.
const VALID_TABS = ['fleet', 'dashboard', 'queue', 'policy', 'tests'] as const;
type ServersTab = (typeof VALID_TABS)[number];

function isTab(v: string | null): v is ServersTab {
  return v !== null && (VALID_TABS as readonly string[]).includes(v);
}

export function ServersView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const urlTab = params.get('tab');
  const activeTab: ServersTab = useMemo(() => (isTab(urlTab) ? urlTab : 'fleet'), [urlTab]);

  const setTab = (tab: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set('tab', tab);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-page-title">Servers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Multi-provider compute fleet (Hetzner / Oracle / GCP / EC2 / local). The dispatcher
          assigns every agent job by operator policy with plan-level affinity. Live host telemetry,
          inbound REST queue calls and dispatch tests all live here.
        </p>
      </div>

      {/* Adding a server is an action on the fleet, not a place you navigate to
          — it lives behind the Fleet tab's button. */}
      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="fleet">Fleet</TabsTrigger>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="policy">Policy</TabsTrigger>
          <TabsTrigger value="tests">Tests</TabsTrigger>
        </TabsList>
        <TabsContent value="fleet" className="mt-4">
          <FleetTab />
        </TabsContent>
        <TabsContent value="dashboard" className="mt-4">
          <MonitoringTab />
        </TabsContent>
        <TabsContent value="queue" className="mt-4">
          <QueuesTab />
        </TabsContent>
        <TabsContent value="policy" className="mt-4">
          <PolicyTab />
        </TabsContent>
        <TabsContent value="tests" className="mt-4">
          <TestsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
