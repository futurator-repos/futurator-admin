import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildAgentConfig } from './role-policy';
import { buildFrameworkDetectSnippet, buildPortReclaimSnippet } from './framework-detect';

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
      //
      // PR-59 (2026-05-13) — runtime framework detection. Was hardcoded to
      // 5173 (Vite default); fails silently on Next.js / Remix / Expo / etc.
      // The detect snippet inspects package.json and exports QA_PORT,
      // QA_DEV_CMD, QA_HEALTH_PATH appropriate to the actual stack.
      {
        id: 'plan-server-check',
        stepType: 'shell' as const,
        command: [
          buildFrameworkDetectSnippet({ cwd: workingDir }),
          // 2026-05-17 dino-7: replaced `kill $(lsof -ti:$QA_PORT)` with the
          // multi-pass reclaim helper. The single-port kill missed Next.js
          // daemon-forked instances from prior plans on the same EC2 host
          // and led to plan-server-check failures with "Another `next dev`".
          buildPortReclaimSnippet(),
          `cd ${workingDir} && nohup $QA_DEV_CMD > /tmp/plan-devserver-$QA_PORT.log 2>&1 </dev/null &`,
          `sleep 2`,
          `STATUS=000`,
          `for i in $(seq 1 30); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$QA_PORT$QA_HEALTH_PATH 2>/dev/null); [ "$STATUS" = "200" ] && break; done`,
          `kill $(lsof -ti:$QA_PORT) 2>/dev/null; pkill -TERM -f 'next dev' 2>/dev/null; pkill -TERM -f 'next-server' 2>/dev/null; true`,
          `[ "$STATUS" = "200" ] || { echo "PLAN_SERVER_CHECK_FAILED: framework=$QA_FRAMEWORK port=$QA_PORT"; tail -40 /tmp/plan-devserver-$QA_PORT.log >&2 || true; exit 1; }`,
        ].join('\n'),
        timeout: 60000,
        captureAs: 'SERVER_OUTPUT',
        captureStderrAs: 'SERVER_ERROR',
        onFail: { action: 'fail' as const, injectAs: 'SERVER_ERROR' },
      },
    ],
  };
}
