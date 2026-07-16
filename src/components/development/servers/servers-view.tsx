'use client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FleetTab } from './fleet-tab';
import { PolicyTab } from './policy-tab';

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

      <Tabs defaultValue="fleet">
        <TabsList>
          <TabsTrigger value="fleet">Fleet</TabsTrigger>
          <TabsTrigger value="add-service">Add Service</TabsTrigger>
          <TabsTrigger value="dispatch-policy">Dispatch Policy</TabsTrigger>
        </TabsList>
        <TabsContent value="fleet" className="mt-4">
          <FleetTab />
        </TabsContent>
        <TabsContent value="add-service" className="mt-4">
          {/* Task 22 — Add Service wizard */}
          <p className="text-sm text-muted-foreground">Add Service wizard — coming soon.</p>
        </TabsContent>
        <TabsContent value="dispatch-policy" className="mt-4">
          <PolicyTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
