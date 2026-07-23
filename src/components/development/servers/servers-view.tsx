'use client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FleetTab } from './fleet-tab';
import { PolicyTab } from './policy-tab';
import { MonitoringTab } from './monitoring-tab';

export function ServersView() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-page-title">Servers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Multi-provider compute fleet (Hetzner / Oracle / GCP / EC2 / local). The dispatcher
          assigns every agent job by operator policy with plan-level affinity.
        </p>
      </div>

      {/* Adding a server is an action on the fleet, not a place you navigate to
          — it lives behind the Fleet tab's button. */}
      <Tabs defaultValue="fleet">
        <TabsList>
          <TabsTrigger value="fleet">Fleet</TabsTrigger>
          <TabsTrigger value="dispatch-policy">Dispatch Policy</TabsTrigger>
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
        </TabsList>
        <TabsContent value="fleet" className="mt-4">
          <FleetTab />
        </TabsContent>
        <TabsContent value="dispatch-policy" className="mt-4">
          <PolicyTab />
        </TabsContent>
        <TabsContent value="monitoring" className="mt-4">
          <MonitoringTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
