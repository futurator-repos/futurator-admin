'use client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { QueuesTab } from './queues-tab';
import { TestsTab } from './tests-tab';

export function QueuesView() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-page-title">Queues</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inbound REST calls from external apps (atlassinator, applicator, gomad, mycelium, …) run
          as Claude sessions under the shared concurrency cap. Calls that arrive while the cap is
          saturated are queued and processed in order.
        </p>
      </div>

      <Tabs defaultValue="queues">
        <TabsList>
          <TabsTrigger value="queues">Queues</TabsTrigger>
          <TabsTrigger value="tests">Tests</TabsTrigger>
        </TabsList>
        <TabsContent value="queues" className="mt-4">
          <QueuesTab />
        </TabsContent>
        <TabsContent value="tests" className="mt-4">
          <TestsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
