'use client';
import { useState } from 'react';
import { useAgentJob, useCreateAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { PipelineEditor } from './pipeline-editor';
import { LiveOutputPanel } from './live-output-panel';
import type { CreateAgentJobInput } from '@/types/agent-orchestrator';

export function ClaudeCodeWorkflow() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const createJob = useCreateAgentJob();
  const { data: job } = useAgentJob(activeJobId);
  const { events, isPolling, reset } = useAgentEvents(activeJobId, job?.status);

  const isRunning = !!job?.status && job.status !== 'COMPLETED' && job.status !== 'FAILED';

  function handleRun(input: CreateAgentJobInput) {
    reset();
    createJob.mutate(input, {
      onSuccess: (data) => {
        setActiveJobId(data.jobId);
        console.log('[Labs] Job created:', data.jobId);
      },
      onError: (err) => {
        console.error('[Labs] Job creation failed:', err);
      },
    });
  }

  return (
    <div className="mt-4 space-y-6">
      <PipelineEditor onSubmit={handleRun} isLoading={createJob.isPending || isRunning} />
      {activeJobId && <LiveOutputPanel events={events} job={job} isPolling={isPolling} />}
    </div>
  );
}
