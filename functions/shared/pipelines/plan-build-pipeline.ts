import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildAgentConfig } from './role-policy';

/**
 * Plan-level final integration check.
 *
 * Runs after the last plan-wave completes: `npm run build` + dev-server
 * smoke test against the full merged codebase. Same 2-step shape as the
 * wave-build-pipeline but at the plan-root working dir.
 *
 * Uses nohup + redirect for the dev server (lesson from the QA-stuck bug on
 * 2026-04-21): otherwise the backgrounded process keeps stdout open and the
 * daemon hangs waiting for EOF.
 *
 * PR-31a (2026-05-05) — dropped the `-- --host 0.0.0.0` argument that was
 * passed to `npm run dev`. Same bug as PR-26 fixed in wave-build-pipeline.ts
 * but missed here. Next.js rejects `--host` (it wants `--hostname`); the
 * boilerplate's package.json `dev` script already encodes
 * `--hostname 0.0.0.0`, so the pipeline doesn't need to add anything.
 *
 * Plan-3 of dino-runner-1 ran the plan-server-check, Next.js died on the
 * unknown flag, the job was marked FAILED (no fix-loop on this step), and
 * plan-reducer flipped plan.status to 'fixing' even though every story +
 * the deploy succeeded.
 */
export function generatePlanBuildPipeline(
  workingDir: string,
  planName: string,
): PipelineDefinition {
  return {
    maxIterations: 2,
    agents: {
      // PR-32 — DEV-as-Integration-Fixer policy resolved from RolePolicy.
      DEV: buildAgentConfig({
        boilerplateKind: 'nextjs-base',
        rigor: 'mvp',
        role: 'DEV',
        name: 'Integration Fixer',
        model: 'sonnet',
      }),
    },
    steps: [
      // 1. Build check
      {
        id: 'plan-build-check',
        stepType: 'shell' as const,
        command: `cd ${workingDir} && npm run build 2>&1`,
        timeout: 120000,
        captureAs: 'BUILD_OUTPUT',
        captureStderrAs: 'BUILD_OUTPUT',
        onFail: {
          action: 'retry_step' as const,
          targetStep: 'plan-build-fix',
          injectAs: 'BUILD_ERROR',
        },
        loopTo: 'plan-build-fix',
      },
      // 2. Build fix (loop-only)
      {
        id: 'plan-build-fix',
        agentId: 'DEV',
        prompt: `The final integration build failed for plan "${planName}" after all epics completed.

Build error:
{{BUILD_ERROR}}

Fix ONLY the build errors. Do not refactor or add features. The per-epic
stories have already passed their own reviews; this is an integration issue
between epics (type mismatches, missing exports, etc.).

Working directory: ${workingDir}

---WORK_SUMMARY---
[What you fixed]
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
        },
        validations: [],
      },
      // 3. Server health check — uses nohup + redirect to avoid daemon-stdout-hang (see 2026-04-21 incident)
      {
        id: 'plan-server-check',
        stepType: 'shell' as const,
        command: `kill $(lsof -ti:5173) 2>/dev/null; sleep 1; cd ${workingDir} && nohup npm run dev > /tmp/plan-devserver.log 2>&1 & sleep 2; STATUS=000; for i in $(seq 1 20); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null); [ "$STATUS" = "200" ] && break; done; kill $(lsof -ti:5173) 2>/dev/null; [ "$STATUS" = "200" ]`,
        timeout: 45000,
        captureAs: 'SERVER_OUTPUT',
        captureStderrAs: 'SERVER_ERROR',
        onFail: { action: 'fail' as const, injectAs: 'SERVER_ERROR' },
      },
    ],
  };
}
