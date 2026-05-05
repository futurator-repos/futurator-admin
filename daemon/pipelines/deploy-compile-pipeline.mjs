/**
 * Deployment Compilation Pipeline — MY-3.3
 *
 * Generates a three-step pipeline definition for post-deployment knowledge compilation.
 * Triggered after successful deployment (S3 sync + CloudFront invalidation).
 *
 * Steps:
 *   1. Shell — S3 wiki snapshot (tar.gz archive)
 *   2. Agent (COMPILER) — deploy record, status marking, manifest update
 *   3. Shell — graph-sync --full-resync --prune
 *
 * Usage:
 *   import { getDeployCompileSteps } from './deploy-compile-pipeline.mjs';
 *   const pipeline = getDeployCompileSteps(projectId, deployUrl, date);
 *
 * [Source: docs/concepts/mycelium-labs-architecture.md#4.4-Deployment-Compilation-Step]
 */

import {
  buildAllowedToolsString,
  buildDisallowedToolsString,
} from './lib/role-policy.mjs';

// ── COMPILER Agent Prompt Template (Post-Deployment) ──

const DEPLOY_COMPILE_PROMPT = `Post-deployment compilation for {{PROJECT_NAME}}.

Deploy URL: {{DEPLOY_URL}}
Date: {{date}}
Project ID: {{projectId}}

Tasks — execute ALL of the following in order:

1. CREATE DEPLOYMENT RECORD — knowledge/release/deploy-{{date}}.md:
   Frontmatter:
   \`\`\`
   ---
   title: "Deployment — {{date}}"
   type: deployment-record
   phase: release
   status: active
   maturity: 1.0
   created: {{date}}
   updated: {{date}}
   deployUrl: "{{DEPLOY_URL}}"
   tags: [deployment, release]
   ---
   \`\`\`
   Sections:
   - ## Summary — What was deployed (project name, date, deploy URL)
   - ## Deployed Articles — List ALL code articles included in this deploy using [[wikilinks]]
   - ## Deploy Configuration — Deploy URL, S3 bucket, CloudFront distribution
   - ## Release Notes — High-level summary of changes since last deployment

2. MARK CODE ARTICLES AS DEPLOYED:
   - Scan all files in knowledge/code/
   - For each code article whose frontmatter has an epic with status \`completed\`:
     Update frontmatter to \`status: deployed\`
   - Also set \`deployedAt: {{date}}\` and \`deployUrl: "{{DEPLOY_URL}}"\`

3. UPDATE knowledge/system/deployment-manifest.md:
   - Set latest deploy date: {{date}}
   - Set deploy URL: {{DEPLOY_URL}}
   - Update counts: deployed vs. pending vs. superseded
   - Link to the deployment record: [[release/deploy-{{date}}]]

4. APPEND to knowledge/log.md:
   - Format: [DEPLOY] {{date}} | Project: {{PROJECT_NAME}} | URL: {{DEPLOY_URL}} | Articles deployed: N
   - Include a one-line summary of the deployment

5. UPDATE knowledge/index.md:
   - Add the new deployment record article entry
   - Update any modified article summaries

Use [[wikilinks]] for ALL cross-references.`;

// ── S3 Snapshot Shell Command ──

function buildSnapshotCommand(projectId, date) {
  return [
    'cd {{workingDir}}',
    `tar -czf /tmp/knowledge-${projectId}-${date}.tar.gz knowledge/`,
    `aws s3 cp /tmp/knowledge-${projectId}-${date}.tar.gz s3://futurator-ai-website/knowledge-archives/${projectId}/${date}.tar.gz`,
    `rm -f /tmp/knowledge-${projectId}-${date}.tar.gz`,
  ].join(' && ');
}

// ── Graph Sync + Prune Shell Command ──

function buildPruneSyncCommand() {
  return [
    'node /home/ubuntu/scripts/graph-sync.mjs',
    '--project {{projectId}}',
    '--full-resync',
    '--prune',
    '--knowledge-dir {{workingDir}}/knowledge',
    '--state-file {{workingDir}}/.mycelium/compile-state.json',
  ].join(' ');
}

// ── Pipeline Step Definitions ──

/**
 * Returns the deployment compilation pipeline steps for the daemon to execute.
 *
 * @param {string} projectId  - Project identifier (e.g., "spyhunter")
 * @param {string} deployUrl  - Production deploy URL
 * @param {string} date       - Deployment date (YYYY-MM-DD)
 * @returns {object} Pipeline definition conforming to PipelineDefinition interface
 */
export function getDeployCompileSteps(projectId, deployUrl, date) {
  return {
    id: 'deploy-compile',
    projectId,
    steps: [
      // Step 1: S3 wiki snapshot — archive before any modifications
      {
        id: 'snapshot',
        stepType: 'shell',
        command: buildSnapshotCommand(projectId, date),
        templateVars: { projectId },
        onFail: {
          // Snapshot failure logs a warning but does NOT block remaining steps
          action: 'continue',
          logLevel: 'warn',
          message: 'S3 wiki snapshot failed — continuing with deployment compilation.',
        },
      },

      // Step 2: COMPILER agent — deploy record creation, status marking, manifest update
      {
        id: 'deploy-nodes',
        stepType: 'agent',
        agentId: 'COMPILER',
        prompt: DEPLOY_COMPILE_PROMPT,
        // PR-32b — resolved from the daemon role-policy mirror.
        allowedTools: buildAllowedToolsString('DEPLOY'),
        disallowedTools: buildDisallowedToolsString('DEPLOY'),
        templateVars: {
          projectId,
          DEPLOY_URL: deployUrl,
          date,
          // PROJECT_NAME injected at runtime by the daemon
        },
        onFail: {
          action: 'fail',
          // Deploy compilation failure does NOT affect the deployment status.
          // The app is already deployed.
          propagate: false,
        },
      },

      // Step 3: Full Memgraph resync with prune flag
      {
        id: 'prune-sync',
        stepType: 'shell',
        command: buildPruneSyncCommand(),
        templateVars: { projectId },
        onFail: {
          action: 'fail',
          propagate: false,
        },
      },
    ],
  };
}

// ── Pipeline Generation for Daemon Integration ──

/**
 * Generates a complete deployment compilation pipeline job payload ready for
 * enqueuing to futurator-agent-jobs DynamoDB table.
 *
 * @param {string} projectId    - Project identifier
 * @param {string} projectName  - Human-readable project name
 * @param {string} deployUrl    - Production deploy URL
 * @param {string} date         - Deployment date (YYYY-MM-DD)
 * @param {string} workingDir   - Absolute path to project workspace on EC2
 * @returns {object} Job payload for DynamoDB PutCommand
 */
export function generateDeployCompilePipeline(projectId, projectName, deployUrl, date, workingDir) {
  const pipeline = getDeployCompileSteps(projectId, deployUrl, date);
  const now = new Date().toISOString();

  return {
    jobId: `deploy-compile-${projectId}-${date}-${Date.now()}`,
    projectId,
    pipelineId: pipeline.id,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    context: {
      projectName,
      deployUrl,
      date,
      workingDir,
      PROJECT_NAME: projectName,
      DEPLOY_URL: deployUrl,
    },
    steps: pipeline.steps,
    currentStepIndex: 0,
  };
}

// ── Deployment Completion Detection ──

/**
 * Checks if a pipeline completion event should trigger deployment compilation.
 * Deployment compilation triggers when a deploy pipeline completes successfully.
 *
 * @param {string} pipelineId  - Pipeline identifier
 * @param {string} status      - Pipeline completion status
 * @returns {boolean} True if deployment compilation should be triggered
 */
export function shouldTriggerDeployCompile(pipelineId, status) {
  // Trigger on successful deploy pipelines (not on compilation pipelines themselves)
  const isDeployPipeline = pipelineId && (
    pipelineId.startsWith('deploy-') ||
    pipelineId.includes('deployment')
  );
  const isCompilePipeline = pipelineId && (
    pipelineId.includes('compile') ||
    pipelineId.includes('compilation')
  );

  return isDeployPipeline && !isCompilePipeline && status === 'completed';
}

/**
 * Creates a pipeline status event for futurator-agent-events.
 *
 * @param {string} jobId    - Pipeline job ID
 * @param {string} stepId   - Current step ID
 * @param {string} status   - Step status
 * @param {object} [details] - Optional details
 * @returns {object} Event payload
 */
export function createDeployPipelineEvent(jobId, stepId, status, details = {}) {
  const now = new Date().toISOString();
  return {
    jobId,
    eventId: `${jobId}-${stepId}-${status}-${Date.now()}`,
    timestamp: now,
    type: 'pipeline-step',
    stepId,
    status,
    ...details,
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };
}
