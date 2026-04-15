'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ClaudeCodeWorkflow } from '@/components/labs/claude-code-workflow';
import { AgenticWorkflow } from '@/components/labs/agentic-workflow';
import { DaemonStatus } from '@/components/labs/daemon-status';
import { Ec2Toggle } from '@/components/labs/ec2-toggle';

export default function LabsPage() {
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-4">
          {/* Compact header */}
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-page-title">Labs</h1>
            <div className="flex items-center gap-4">
              <DaemonStatus />
              <Ec2Toggle />
            </div>
          </div>

          {/* Main tabs */}
          <Tabs defaultValue="agentic-workflow">
            <TabsList variant="line">
              <TabsTrigger value="agentic-workflow">Agentic Workflow</TabsTrigger>
              <TabsTrigger value="claude-code-workflow">Claude Code Pipeline</TabsTrigger>
            </TabsList>
            <TabsContent value="agentic-workflow">
              <AgenticWorkflow />
            </TabsContent>
            <TabsContent value="claude-code-workflow">
              <ClaudeCodeWorkflow />
            </TabsContent>
          </Tabs>
        </div>
      </AppShell>
    </AuthGuard>
  );
}
