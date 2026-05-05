'use client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { STATUS_COLORS, CATEGORY_LABELS } from '@/lib/constants';
import { CostPieChart } from '@/components/charts/cost-pie-chart';
import { CostTrendLine } from '@/components/charts/cost-trend-line';
import { BudgetBar } from '@/components/charts/budget-bar';
import { IdentityBrokerPanel } from '@/components/projects/identity-broker-panel';
import { useProjectCosts } from '@/hooks/use-costs';
import { useProjectResources } from '@/hooks/use-resources';
import { useUIStore } from '@/stores/ui-store';
import type { Project } from '@/types/project';

// Legacy bare-name broker registrations for projects whose id doesn't match
// the broker's. Surfaced in the Identity Broker tab as a migration banner —
// new registrations follow the `{projectId}-{env}` convention.
const LEGACY_BROKER_APP_ID: Record<string, string> = {
  'admin-hub': 'futurator-admin',
  contento: 'contento',
  songster: 'songster',
};

export function ProjectTabs({ project }: { project: Project }) {
  const { dateRange, setDateRange } = useUIStore();
  const { data: costData } = useProjectCosts(project.projectId, dateRange);
  const { data: resourceData } = useProjectResources(project.projectId);
  const legacyBrokerAppId = LEGACY_BROKER_APP_ID[project.projectId];

  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="features">Features ({project.features.length})</TabsTrigger>
        <TabsTrigger value="costs">Costs</TabsTrigger>
        <TabsTrigger value="resources">
          Resources {resourceData ? `(${resourceData.total})` : ''}
        </TabsTrigger>
        <TabsTrigger value="identity-broker">Identity Broker</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-sm text-muted-foreground">Status</span>
            <div>
              <Badge className={STATUS_COLORS[project.status]}>{project.status}</Badge>
            </div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Category</span>
            <p className="text-sm">{CATEGORY_LABELS[project.category]}</p>
          </div>
          <div className="col-span-2">
            <span className="text-sm text-muted-foreground">Description</span>
            <p className="text-sm">{project.descriptions?.brief}</p>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Team</span>
            <p className="text-sm">{project.team.join(', ')}</p>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">AWS Services</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {project.awsServices.map((svc) => (
                <Badge key={svc} variant="outline" className="text-xs">
                  {svc}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="features" className="mt-4">
        <div className="space-y-2">
          {project.features.map((feature) => (
            <div
              key={feature.id}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div>
                <span className="font-medium">{feature.name}</span>
                {feature.awsServices && (
                  <div className="mt-1 flex gap-1">
                    {feature.awsServices.map((svc) => (
                      <Badge key={svc} variant="outline" className="text-xs">
                        {svc}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <Badge className={STATUS_COLORS[feature.status]}>{feature.status}</Badge>
            </div>
          ))}
        </div>
      </TabsContent>
      <TabsContent value="costs" className="mt-4 space-y-4">
        <div className="flex gap-2">
          {(['30d', '60d', '90d'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${dateRange === r ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}
            >
              {r}
            </button>
          ))}
        </div>
        {costData && (
          <>
            {costData.budget && (
              <BudgetBar used={costData.budget.used} limit={costData.budget.limit} />
            )}
            <CostTrendLine
              data={costData.daily.map((d) => ({ date: d.date, amount: d.totalAmount }))}
              title="Daily Cost Trend"
            />
            {costData.daily.length > 0 && (
              <CostPieChart
                data={Object.entries(
                  costData.daily.reduce(
                    (acc, d) => {
                      Object.entries(d.breakdown || {}).forEach(([k, v]) => {
                        acc[k] = (acc[k] || 0) + v;
                      });
                      return acc;
                    },
                    {} as Record<string, number>,
                  ),
                ).map(([name, value]) => ({ name, value }))}
                title="Cost by Service"
              />
            )}
          </>
        )}
      </TabsContent>
      <TabsContent value="resources" className="mt-4">
        {resourceData ? (
          <div className="space-y-4">
            {Object.entries(resourceData.groups).map(([serviceType, resources]) => (
              <div key={serviceType}>
                <h4 className="mb-2 text-sm font-semibold capitalize">
                  {serviceType} ({resources.length})
                </h4>
                <div className="space-y-1">
                  {resources.map((r) => (
                    <div
                      key={r.resourceArn}
                      className="flex items-center justify-between rounded border p-2 text-sm"
                    >
                      <span>{r.resourceName}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{r.region}</span>
                        <Badge
                          variant={r.tagCompliant ? 'default' : 'destructive'}
                          className="text-xs"
                        >
                          {r.tagCompliant ? 'Compliant' : 'Non-compliant'}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading resources...</p>
        )}
      </TabsContent>
      <TabsContent value="identity-broker" className="mt-4">
        <IdentityBrokerPanel
          projectId={project.projectId}
          projectName={project.name}
          legacyAppIdFallback={legacyBrokerAppId}
        />
      </TabsContent>
    </Tabs>
  );
}
