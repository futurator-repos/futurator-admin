'use client';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAgentJob } from '@/hooks/use-agent-job';
import {
  useRunPoReview,
  useRunVisualQa,
  useStartDevServer,
  useDeployApp,
  useSubmitBugReport,
  useSubmitFeatureRequest,
} from '@/hooks/use-epic-workflow';
import { StoryLiveOutput } from './story-live-output';
import { useEc2Status } from '@/hooks/use-ec2-daemon';
import type { EpicWorkflow } from '@/types/epic-workflow';

interface EpicInfoPanelProps {
  epic: EpicWorkflow;
}

export function EpicInfoPanel({ epic }: EpicInfoPanelProps) {
  const [devServerJobId, setDevServerJobId] = useState<string | null>(null);
  const [deployJobId, setDeployJobId] = useState<string | null>(null);
  const runPoReview = useRunPoReview();
  const runVisualQa = useRunVisualQa();
  const startDevServer = useStartDevServer();
  const deployApp = useDeployApp();
  const { data: ec2Status } = useEc2Status(true);

  const { data: qaJob } = useAgentJob(epic.qaJobId || null);
  const { data: poJob } = useAgentJob(epic.poJobId || null);
  const { data: devJob } = useAgentJob(devServerJobId);

  const allStoriesDone = epic.stories.every((s) => s.status === 'done');
  const poStatus = poJob?.status;
  const poVerdict = poJob?.variables?.VERDICT;
  const poReport = poJob?.variables?.PO_REPORT || '';
  const rawDevUrl = devJob?.variables?.DEV_SERVER_URL;
  // Replace private/localhost IPs with public EC2 IP if available
  const publicIp = ec2Status?.publicIp;
  const devUrl =
    rawDevUrl && publicIp
      ? rawDevUrl.replace(
          /\/\/(localhost|127\.0\.0\.1|172\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)/,
          `//${publicIp}`,
        )
      : rawDevUrl;
  const devPid = devJob?.variables?.DEV_SERVER_PID;
  const devStatus = devJob?.variables?.STATUS;

  const copyCommand = () => {
    navigator.clipboard.writeText(`cd ${epic.workingDir} && npm run dev`);
  };

  function handleStartDevServer() {
    startDevServer.mutate(epic.epicId, {
      onSuccess: (data) => {
        setDevServerJobId(data.jobId);
        console.log('[Epic] Dev server job:', data.jobId);
      },
    });
  }

  function handleRunPoReview() {
    runPoReview.mutate(epic.epicId);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Epic Actions & Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Project info */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Working directory:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{epic.workingDir}</code>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Test command:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
              cd {epic.workingDir} && npm run dev
            </code>
            <button
              onClick={copyCommand}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              [copy]
            </button>
          </div>
          {epic.testingProfile && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">Testing:</span>
              {epic.testingProfile.hasBrowserTests ? (
                <span className="rounded bg-purple-900/50 px-1.5 py-0.5 text-[10px] text-purple-400">
                  Browser tests
                </span>
              ) : (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  Code only
                </span>
              )}
              {epic.testingProfile.viewport && (
                <span className="text-muted-foreground font-mono text-[10px]">
                  {epic.testingProfile.viewport}
                </span>
              )}
              {epic.testingProfile.interactionModel && (
                <span className="text-muted-foreground text-[10px]">
                  {epic.testingProfile.interactionModel}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Dev server control */}
        <div className="rounded border border-input p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold">Dev Server</h4>
            <button
              onClick={handleStartDevServer}
              disabled={
                startDevServer.isPending ||
                devJob?.status === 'PENDING' ||
                devJob?.status === 'RUNNING'
              }
              className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {devJob?.status === 'PENDING' || devJob?.status === 'RUNNING'
                ? 'Starting...'
                : 'Start Dev Server'}
            </button>
          </div>
          {devJob?.status === 'COMPLETED' && devUrl && (
            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-green-500 font-medium">Running</span>
                <a
                  href={devUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 underline hover:text-blue-300"
                >
                  {devUrl}
                </a>
                {devPid && <span className="text-muted-foreground">PID: {devPid}</span>}
              </div>
              <p className="text-muted-foreground text-[10px]">
                Server is running in background. To stop:{' '}
                <code className="bg-muted px-1">kill {devPid}</code>
              </p>
            </div>
          )}
          {devJob?.status === 'COMPLETED' && !devUrl && (
            <div className="text-xs text-yellow-500">
              Server started but URL not detected. Status: {devStatus || 'unknown'}
            </div>
          )}
          {devJob?.status === 'FAILED' && (
            <div className="text-xs text-red-500">
              Failed to start dev server{devJob.errorMessage ? `: ${devJob.errorMessage}` : ''}
            </div>
          )}
        </div>

        {/* Visual QA — only shown if epic has browser tests */}
        {epic.testingProfile?.hasBrowserTests && (
          <VisualQaSection
            epic={epic}
            qaJob={qaJob}
            onRun={() => runVisualQa.mutate(epic.epicId)}
            isRunning={runVisualQa.isPending}
            allStoriesDone={allStoriesDone}
          />
        )}

        {/* PO Review */}
        <div className="rounded border border-input p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold">Product Owner Review</h4>
            <button
              onClick={handleRunPoReview}
              disabled={
                !allStoriesDone ||
                runPoReview.isPending ||
                poStatus === 'PENDING' ||
                poStatus === 'RUNNING'
              }
              className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              title={!allStoriesDone ? 'All stories must be done first' : ''}
            >
              {poStatus === 'PENDING' || poStatus === 'RUNNING' ? 'Reviewing...' : 'Run PO Review'}
            </button>
          </div>

          {!allStoriesDone && (
            <p className="text-[10px] text-muted-foreground">
              Complete all stories before running PO review
            </p>
          )}

          {(poStatus === 'PENDING' || poStatus === 'RUNNING') && epic.poJobId && (
            <StoryLiveOutput jobId={epic.poJobId} />
          )}

          {poStatus === 'COMPLETED' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={
                    poVerdict === 'PASS' ? 'text-green-500 font-medium' : 'text-red-500 font-medium'
                  }
                >
                  {poVerdict || 'No verdict'}
                </span>
                {poJob?.totalCost != null && poJob.totalCost > 0 && (
                  <span className="text-muted-foreground">${poJob.totalCost.toFixed(4)}</span>
                )}
                {poJob?.stepResults && poJob.stepResults.length > 0 && (
                  <span className="text-muted-foreground">
                    {(poJob.stepResults[0].durationMs || 0) / 1000}s
                  </span>
                )}
              </div>
              {poReport && (
                <details className="group">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Full PO Report
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground bg-muted/30 rounded p-2 max-h-64 overflow-auto">
                    {poReport
                      .replace(/^---PO_REPORT---\n?/, '')
                      .replace(/\n?---END_PO_REPORT---$/, '')}
                  </pre>
                </details>
              )}
            </div>
          )}

          {poStatus === 'FAILED' && poJob?.errorMessage && (
            <div className="text-xs text-red-500">{poJob.errorMessage}</div>
          )}
        </div>

        {/* Publish / Deploy */}
        <PublishSection
          epic={epic}
          deployJobId={deployJobId}
          onDeploy={() => {
            deployApp.mutate(
              { epicId: epic.epicId, environment: 'production' },
              {
                onSuccess: (data) => {
                  setDeployJobId(data.jobId);
                  console.log('[Deploy] Job:', data.jobId, 'URL:', data.publicUrl);
                },
              },
            );
          }}
          isDeploying={deployApp.isPending}
        />

        {/* Brownfield: Bug Reports & Feature Requests — only for deployed apps */}
        {epic.deployUrl && (
          <BrownfieldSection appName={epic.workingDir.split('/').filter(Boolean).pop() || ''} />
        )}
      </CardContent>
    </Card>
  );
}

function VisualQaSection({
  epic,
  qaJob,
  onRun,
  isRunning,
  allStoriesDone,
}: {
  epic: EpicWorkflow;
  qaJob: ReturnType<typeof useAgentJob>['data'];
  onRun: () => void;
  isRunning: boolean;
  allStoriesDone: boolean;
}) {
  const qaStatus = qaJob?.status;
  const qaVerdict = qaJob?.variables?.OVERALL_VERDICT;
  const qaReport = qaJob?.variables?.QA_REPORT || '';
  const failedTests = qaJob?.variables?.FAILED_TESTS || '';
  const hasFailed = failedTests.trim() && failedTests.trim().toLowerCase() !== 'none';

  const visualTestCount = epic.stories.reduce((sum, s) => sum + (s.visualTests?.length || 0), 0);

  return (
    <div className="rounded border border-purple-900/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold">
          Visual QA
          <span className="ml-2 text-[10px] text-muted-foreground font-normal">
            {visualTestCount} test{visualTestCount !== 1 ? 's' : ''} across{' '}
            {epic.stories.filter((s) => s.hasBrowserTests).length} stories
          </span>
        </h4>
        <button
          onClick={onRun}
          disabled={
            !allStoriesDone || isRunning || qaStatus === 'PENDING' || qaStatus === 'RUNNING'
          }
          className="rounded bg-purple-600 px-3 py-1 text-xs text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          title={!allStoriesDone ? 'All stories must be done first' : ''}
        >
          {qaStatus === 'PENDING' || qaStatus === 'RUNNING'
            ? 'Testing...'
            : qaJob
              ? 'Re-run QA'
              : 'Run Visual QA'}
        </button>
      </div>

      {!allStoriesDone && (
        <p className="text-[10px] text-muted-foreground">
          Complete all stories before running visual QA
        </p>
      )}

      {(qaStatus === 'PENDING' || qaStatus === 'RUNNING') && epic.qaJobId && (
        <div className="space-y-2">
          <p className="text-xs text-purple-400">Running visual tests against dev server...</p>
          <StoryLiveOutput jobId={epic.qaJobId} />
        </div>
      )}

      {qaStatus === 'COMPLETED' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={
                qaVerdict === 'PASS' ? 'text-green-500 font-medium' : 'text-red-500 font-medium'
              }
            >
              {qaVerdict || 'No verdict'}
            </span>
            {qaJob?.totalCost != null && qaJob.totalCost > 0 && (
              <span className="text-muted-foreground">${qaJob.totalCost.toFixed(4)}</span>
            )}
            {hasFailed && (
              <span className="text-red-400 text-[10px]">Failed: {failedTests.trim()}</span>
            )}
          </div>
          {qaReport && (
            <details className="group">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Full QA Report
              </summary>
              <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground bg-muted/30 rounded p-2 max-h-64 overflow-auto">
                {qaReport.replace(/^---QA_REPORT---\n?/, '').replace(/\n?---END_QA_REPORT---$/, '')}
              </pre>
            </details>
          )}
        </div>
      )}

      {qaStatus === 'FAILED' && qaJob?.errorMessage && (
        <div className="text-xs text-red-500">{qaJob.errorMessage}</div>
      )}
    </div>
  );
}

function BrownfieldSection({ appName }: { appName: string }) {
  const [bugText, setBugText] = useState('');
  const [featureText, setFeatureText] = useState('');
  const submitBug = useSubmitBugReport();
  const submitFeature = useSubmitFeatureRequest();

  const bugJobId = submitBug.data?.jobId;
  const featureJobId = submitFeature.data?.jobId;
  const { data: bugJob } = useAgentJob(bugJobId || null);
  const { data: featureJob } = useAgentJob(featureJobId || null);

  return (
    <div className="rounded border border-amber-900/50 p-3 space-y-3">
      <h4 className="text-xs font-semibold">Iterate on Deployed App</h4>

      {/* Bug Report */}
      <div className="space-y-1.5">
        <label className="text-[10px] text-muted-foreground font-medium uppercase">
          Bug Report
        </label>
        <textarea
          value={bugText}
          onChange={(e) => setBugText(e.target.value)}
          placeholder="Describe the bug..."
          className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs resize-none focus:border-ring focus:outline-none"
          rows={2}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              submitBug.mutate({ projectId: appName, description: bugText });
              setBugText('');
            }}
            disabled={!bugText.trim() || submitBug.isPending}
            className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
          >
            {submitBug.isPending ? 'Submitting...' : 'Fix Bug'}
          </button>
          {bugJob?.status === 'RUNNING' && (
            <span className="text-[10px] text-yellow-500">Fixing...</span>
          )}
          {bugJob?.status === 'COMPLETED' && (
            <span className="text-[10px] text-green-500">Fixed!</span>
          )}
          {bugJob?.status === 'FAILED' && <span className="text-[10px] text-red-500">Failed</span>}
        </div>
      </div>

      {/* Feature Request */}
      <div className="space-y-1.5">
        <label className="text-[10px] text-muted-foreground font-medium uppercase">
          Feature Request
        </label>
        <textarea
          value={featureText}
          onChange={(e) => setFeatureText(e.target.value)}
          placeholder="Describe the new feature..."
          className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs resize-none focus:border-ring focus:outline-none"
          rows={2}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              submitFeature.mutate({ projectId: appName, description: featureText });
              setFeatureText('');
            }}
            disabled={!featureText.trim() || submitFeature.isPending}
            className="rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {submitFeature.isPending ? 'Submitting...' : 'Add Feature'}
          </button>
          {featureJob?.status === 'RUNNING' && (
            <span className="text-[10px] text-yellow-500">PM planning...</span>
          )}
          {featureJob?.status === 'COMPLETED' && (
            <span className="text-[10px] text-green-500">Epic generated — create from XML</span>
          )}
          {featureJob?.status === 'FAILED' && (
            <span className="text-[10px] text-red-500">Failed</span>
          )}
        </div>
      </div>
    </div>
  );
}

function PublishSection({
  epic,
  deployJobId,
  onDeploy,
  isDeploying,
}: {
  epic: EpicWorkflow;
  deployJobId: string | null;
  onDeploy: () => void;
  isDeploying: boolean;
}) {
  const { data: deployJob } = useAgentJob(deployJobId || epic.deployJobId || null);

  const deployUrl = deployJob?.variables?.DEPLOY_URL || epic.deployUrl;
  const deployStatus = deployJob?.variables?.DEPLOY_STATUS;
  const deployDetails = deployJob?.variables?.DEPLOY_DETAILS;
  const appName = epic.workingDir.split('/').filter(Boolean).pop() || 'app';
  const isRunning = deployJob?.status === 'PENDING' || deployJob?.status === 'RUNNING';
  const allStoriesDone = epic.stories.every((s) => s.status === 'done');
  // The agent can exit COMPLETED but not actually succeed — e.g. Claude asked
  // for permission on an Edit it wasn't allowed to do, or never emitted
  // DEPLOY_STATUS. Treat "COMPLETED without DEPLOY_STATUS=success" as failure
  // so the UI surfaces it instead of collapsing to empty.
  const completedWithoutSuccess = deployJob?.status === 'COMPLETED' && deployStatus !== 'success';

  return (
    <div className="rounded border border-input p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold">Publish to Web</h4>
        <button
          onClick={onDeploy}
          disabled={!allStoriesDone || isDeploying || isRunning}
          className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          title={!allStoriesDone ? 'Complete all stories first' : ''}
        >
          {isRunning ? 'Deploying...' : deployUrl ? 'Redeploy' : 'Publish'}
        </button>
      </div>

      {!allStoriesDone && (
        <p className="text-[10px] text-muted-foreground">Complete all stories before publishing</p>
      )}

      {isRunning && (
        <div className="space-y-2">
          <p className="text-xs text-yellow-500">Building and deploying {appName}...</p>
          {(deployJobId || epic.deployJobId) && (
            <StoryLiveOutput jobId={(deployJobId || epic.deployJobId)!} />
          )}
        </div>
      )}

      {deployUrl && !isRunning && deployStatus === 'success' && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-green-500 font-medium">Published</span>
            <a
              href={deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline hover:text-blue-300"
            >
              {deployUrl}
            </a>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Shareable link — anyone can access this URL
          </p>
        </div>
      )}

      {deployJob?.status === 'FAILED' && (
        <div className="space-y-1">
          <p className="text-xs text-red-500">Deploy failed.</p>
          {deployJob.errorMessage && (
            <p className="text-[10px] text-red-400">{deployJob.errorMessage}</p>
          )}
        </div>
      )}

      {completedWithoutSuccess && (
        <div className="space-y-1 rounded border border-red-900/60 bg-red-950/30 p-2">
          <p className="text-xs text-red-400 font-medium">Deploy did not complete successfully</p>
          <p className="text-[10px] text-muted-foreground">
            The agent finished without emitting{' '}
            <code className="font-mono">DEPLOY_STATUS: success</code>. Most likely it tried a tool
            it wasn&apos;t allowed to use or the build failed.
          </p>
          {deployDetails && <p className="text-[10px] text-yellow-400">Details: {deployDetails}</p>}
          {(deployJobId || epic.deployJobId) && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                Show agent log
              </summary>
              <div className="mt-1">
                <StoryLiveOutput jobId={(deployJobId || epic.deployJobId)!} />
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
