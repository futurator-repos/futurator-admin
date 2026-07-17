'use client';
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FleetTab } from './fleet-tab';
import { PolicyTab } from './policy-tab';
import { AddServiceWizard } from './add-service-wizard';

export function ServersView() {
  // Controlled so the wizard can land the operator back on Fleet, where the
  // new server's PROVISIONING → ACTIVE progress is visible (5s poll).
  const [tab, setTab] = useState('fleet');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-page-title">Servers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Multi-provider compute fleet (Hetzner / Oracle / GCP / EC2 / local). The dispatcher
          assigns every agent job by operator policy with plan-level affinity.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="fleet">Fleet</TabsTrigger>
          <TabsTrigger value="add-service">Add Service</TabsTrigger>
          <TabsTrigger value="dispatch-policy">Dispatch Policy</TabsTrigger>
        </TabsList>
        <TabsContent value="fleet" className="mt-4">
          <FleetTab />
        </TabsContent>
        <TabsContent value="add-service" className="mt-4">
          <AddServiceWizard onDone={() => setTab('fleet')} />
        </TabsContent>
        <TabsContent value="dispatch-policy" className="mt-4">
          <PolicyTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
