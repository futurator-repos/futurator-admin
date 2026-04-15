/**
 * Epic Compilation Pipeline — MY-3.1
 *
 * Generates a two-step pipeline definition for epic-level knowledge compilation.
 * Triggered when an epic transitions to `completed` status.
 *
 * Steps:
 *   1. Agent (COMPILER) — cross-story synthesis, supersession scan, maturity update, lint
 *   2. Shell — graph-sync --full-resync to rebuild Memgraph from updated wiki
 *
 * Usage:
 *   import { getEpicCompileSteps } from './epic-compile-pipeline.mjs';
 *   const pipeline = getEpicCompileSteps(projectId, epicId);
 *
 * [Source: docs/concepts/mycelium-labs-architecture.md#4.3-Epic-Compilation-Step]
 */

// ── COMPILER Agent Prompt Template ──

const EPIC_COMPILE_PROMPT = `You are the Knowledge Compiler performing an EPIC-LEVEL compilation.

Epic: {{EPIC_TITLE}}
Epic ID: {{epicId}}
Stories completed: {{STORY_COUNT}}
Project knowledge index:
{{INDEX_CONTENT}}

Tasks — execute ALL of the following in order:

1. READ ALL ARTICLES for this epic:
   - Read every file in knowledge/code/ whose frontmatter \`createdByEpic\` matches "{{epicId}}" or whose \`lastMutatedByStory\` references any story in this epic.
   - Also read knowledge/decisions/ and knowledge/requirements/ articles linked to this epic.

2. CROSS-STORY SYNTHESIS — write knowledge/planning/epic-{{epicId}}-synthesis.md:
   Frontmatter:
   \`\`\`
   ---
   title: "Epic {{epicId}} Synthesis — {{EPIC_TITLE}}"
   type: planning
   phase: planning
   status: active
   maturity: 0.8
   created: {{date}}
   updated: {{date}}
   createdByEpic: {{epicId}}
   tags: [synthesis, epic-compilation]
   ---
   \`\`\`
   Sections:
   - ## Purpose — What this epic accomplished across all stories
   - ## Stories Completed — List each story with a one-line summary of what it built
   - ## Cross-Story Patterns — Patterns that emerged across stories (shared utilities, common approaches, architectural themes)
   - ## Dependencies Created — Key dependency chains established by this epic's work
   - ## Open Items — Anything flagged, incomplete, or deferred
   - ## Notes — Additional context for future epics

3. SUPERSESSION SCAN:
   - For each pair of articles where a later story (\`lastMutatedByStory\`) modified a file first created by an earlier story (\`createdByStory\`), check if the later version substantially rewrote the earlier content.
   - If so: update the older article's frontmatter to \`status: superseded\` and add a \`## Supersedes\` section with a [[wikilink]] to the newer version.
   - The newer article should have a \`## Supersedes\` section with [[wikilink]] pointing to the older (superseded) version.

4. MATURITY UPDATE:
   - For each requirement and decision node related to this epic, reassess maturity based on implementation outcomes.
   - If the code articles implementing a requirement are complete and solid, increase the requirement's maturity.
   - If implementation revealed gaps, lower the maturity and note the gaps in the article.

5. LINT PASS:
   - Check for contradictions between articles (e.g., two articles claiming different approaches to the same problem).
   - Find orphan nodes: articles with no [[wikilinks]] to or from other articles.
   - Find stale cross-references: [[wikilinks]] pointing to files that no longer exist or have been renamed.
   - Format lint output:
     - [WARN] for non-critical issues (orphan nodes, low maturity)
     - [CRITICAL] for contradictions and broken references

6. UPDATE knowledge/system/pending-work.md:
   - List all nodes with maturity < 0.6 or status: flagged, grouped by phase.
   - Include any incomplete items from this epic.
   - For critical lint issues, add them with severity and remediation hints.

7. UPDATE knowledge/index.md:
   - Add the new synthesis article entry.
   - Update summaries for any modified articles.

8. APPEND to knowledge/log.md:
   - Add a compilation record with timestamp, epic ID, story count, and lint summary.
   - Format: [EPIC-COMPILE] {{date}} | Epic: {{epicId}} | Stories: {{STORY_COUNT}} | Warnings: N | Critical: M
   - Append any [WARN] and [CRITICAL] lint entries below the compilation record.

Use [[wikilinks]] for ALL cross-references between articles. Be precise about Dependencies and Dependents sections — these become graph edges in Memgraph.`;

// ── Pipeline Step Definitions ──

/**
 * Returns the epic compilation pipeline steps for the daemon to execute.
 *
 * @param {string} projectId  - Project identifier (e.g., "spyhunter")
 * @param {string} epicId     - Epic identifier (e.g., "E1", "MY-3")
 * @returns {object} Pipeline definition conforming to PipelineDefinition interface
 */
export function getEpicCompileSteps(projectId, epicId) {
  return {
    id: 'epic-compile',
    projectId,
    epicId,
    steps: [
      // Step 1: COMPILER agent — consolidation, synthesis, supersession, maturity, lint
      {
        id: 'consolidate',
        stepType: 'agent',
        agentId: 'COMPILER',
        prompt: EPIC_COMPILE_PROMPT,
        allowedTools: 'Read,Write,Edit,Glob,Grep',
        templateVars: {
          projectId,
          epicId,
          // These are injected at runtime by the daemon before execution:
          // EPIC_TITLE     — from EpicWorkflow record
          // STORY_COUNT    — count of stories in the epic
          // INDEX_CONTENT  — contents of knowledge/index.md
          // date           — ISO date string
        },
        onFail: {
          action: 'fail',
          // Epic compilation failure does NOT revert the epic's completed status.
          // Errors are logged to futurator-agent-events with full stack traces.
          propagate: false,
        },
      },

      // Step 2: Full Memgraph resync — re-embeds all articles
      {
        id: 'graph-resync',
        stepType: 'shell',
        command: [
          'node /home/ubuntu/scripts/graph-sync.mjs',
          '--project {{projectId}}',
          '--full-resync',
          '--knowledge-dir {{workingDir}}/knowledge',
          '--state-file {{workingDir}}/.mycelium/compile-state.json',
        ].join(' '),
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
 * Generates a complete epic compilation pipeline job payload ready for
 * enqueuing to futurator-agent-jobs DynamoDB table.
 *
 * @param {string} epicId       - Epic identifier
 * @param {string} projectId    - Project identifier
 * @param {string} epicTitle    - Human-readable epic title
 * @param {number} storyCount   - Number of stories in the epic
 * @param {string} workingDir   - Absolute path to project workspace on EC2
 * @returns {object} Job payload for DynamoDB PutCommand
 */
export function generateEpicCompilePipeline(epicId, projectId, epicTitle, storyCount, workingDir) {
  const pipeline = getEpicCompileSteps(projectId, epicId);
  const now = new Date().toISOString();

  return {
    jobId: `epic-compile-${projectId}-${epicId}-${Date.now()}`,
    projectId,
    pipelineId: pipeline.id,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    context: {
      epicId,
      epicTitle,
      storyCount,
      workingDir,
      EPIC_TITLE: epicTitle,
      STORY_COUNT: String(storyCount),
      date: now.split('T')[0],
    },
    steps: pipeline.steps,
    currentStepIndex: 0,
    compilationStatus: 'pending', // success | failed | skipped
  };
}

// ── Lint Output Formatting ──

/**
 * Formats lint results for log.md and pending-work.md.
 *
 * @param {Array<{level: string, message: string, nodeId?: string, remediation?: string}>} issues
 * @param {string} epicId
 * @param {string} date
 * @returns {{ logEntries: string, criticalItems: Array<{message: string, remediation: string}> }}
 */
export function formatLintOutput(issues, epicId, date) {
  const warnings = issues.filter(i => i.level === 'WARN');
  const criticals = issues.filter(i => i.level === 'CRITICAL');

  const logLines = [];
  logLines.push(`[EPIC-COMPILE] ${date} | Epic: ${epicId} | Warnings: ${warnings.length} | Critical: ${criticals.length}`);

  for (const issue of warnings) {
    logLines.push(`  [WARN] ${issue.message}${issue.nodeId ? ` (node: ${issue.nodeId})` : ''}`);
  }

  for (const issue of criticals) {
    logLines.push(`  [CRITICAL] ${issue.message}${issue.nodeId ? ` (node: ${issue.nodeId})` : ''}`);
  }

  return {
    logEntries: logLines.join('\n'),
    criticalItems: criticals.map(c => ({
      message: c.message,
      remediation: c.remediation || 'Review and resolve the contradiction or broken reference.',
      nodeId: c.nodeId,
    })),
  };
}

// ── Epic Status Transition Detection ──

/**
 * Checks if an epic status transition should trigger compilation.
 * Epic compilation triggers on transition TO `completed` status.
 *
 * @param {string} previousStatus - Previous epic status
 * @param {string} newStatus      - New epic status
 * @returns {boolean} True if compilation should be triggered
 */
export function shouldTriggerEpicCompile(previousStatus, newStatus) {
  return newStatus === 'completed' && previousStatus !== 'completed';
}

/**
 * Creates a pipeline status event for futurator-agent-events DynamoDB table.
 *
 * @param {string} jobId    - Pipeline job ID
 * @param {string} stepId   - Current step ID (e.g., 'consolidate', 'graph-resync')
 * @param {string} status   - Step status (running, completed, failed)
 * @param {object} [details] - Optional details (error message, timing, etc.)
 * @returns {object} Event payload for DynamoDB PutCommand
 */
export function createPipelineEvent(jobId, stepId, status, details = {}) {
  const now = new Date().toISOString();
  return {
    jobId,
    eventId: `${jobId}-${stepId}-${status}-${Date.now()}`,
    timestamp: now,
    type: 'pipeline-step',
    stepId,
    status,
    ...details,
    // TTL for automatic cleanup (24 hours)
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };
}
