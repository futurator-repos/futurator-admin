import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildAgentConfig } from './role-policy';
import { buildFrameworkDetectSnippet } from './framework-detect';

/**
 * Wave-level build + server-check pipeline.
 *
 * Runs after all stories in a wave complete successfully. If `npm run build`
 * fails, the build-fix loop asks DEV to patch; if the dev server fails to
 * boot on port 5173 within 15s, the server-fix loop kicks in.
 *
 * Story 16.2 extracted this out of `functions/api/index.ts` so the cron-driven
 * wave-completion reducer can share it without bundling the Hono app.
 */
export function generateWaveBuildPipeline(
  workingDir: string,
  waveNum: number,
  storyTitles: string[],
): PipelineDefinition {
  return {
    maxIterations: 3,
    agents: {
      // PR-32 — DEV-as-Build-Fixer policy resolved from RolePolicy.
      DEV: buildAgentConfig({
        boilerplateKind: 'nextjs-base',
        rigor: 'mvp',
        role: 'DEV',
        name: 'Build Fixer',
        model: 'sonnet',
      }),
    },
    steps: [
      // 1. Build check
      {
        id: 'build-check',
        stepType: 'shell' as const,
        command: `cd ${workingDir} && npm run build 2>&1`,
        timeout: 60000,
        captureAs: 'BUILD_OUTPUT',
        captureStderrAs: 'BUILD_OUTPUT',
        onFail: {
          action: 'retry_step' as const,
          targetStep: 'dev-build-fix',
          injectAs: 'BUILD_ERROR',
        },
        loopTo: 'dev-build-fix',
      },
      // 2. Build fix (loop-only)
      {
        id: 'dev-build-fix',
        agentId: 'DEV',
        prompt: `The project build failed after completing wave ${waveNum} stories:
${storyTitles.map((t) => `- ${t}`).join('\n')}

Build error:
{{BUILD_ERROR}}

Fix ONLY the build errors. Do not refactor or add features.
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
      // 3. Server health check.
      //
      // PR-26 (2026-05-04) — dropped the `-- --host 0.0.0.0` argument that
      // was passed to `npm run dev`. That flag is Vite syntax; Next.js
      // rejects `--host` (it wants `--hostname`). Plan 2 of dino-runner-1
      // hung wave-1 launch for 5 min retrying before failing because the
      // boilerplate's dev script (`next dev --port 5173 --hostname 0.0.0.0`)
      // already binds to all interfaces. The pipeline doesn't need to add
      // anything — the package.json script handles binding.
      //
      // For Vite-based starters (still in stub status as of PR-13), the
      // package.json `dev` script should ALSO encode `--host 0.0.0.0`
      // explicitly. Pipeline stays framework-agnostic.
      // PR-59 (2026-05-13) — runtime framework detection.
      //
      // Was hardcoded to port 5173 (Vite default). Plans on Next.js,
      // Expo, Remix, etc. would silently fail this gate because the
      // dev server binds elsewhere (3000 / 19006 / etc.). The detect
      // snippet reads `package.json` and exports QA_PORT / QA_DEV_CMD
      // appropriate to the framework, so this gate works for any stack.
      {
        id: 'server-check',
        stepType: 'shell' as const,
        command: [
          buildFrameworkDetectSnippet({ cwd: workingDir }),
          `kill $(lsof -ti:$QA_PORT) 2>/dev/null; sleep 1`,
          `cd ${workingDir} && (nohup $QA_DEV_CMD > /tmp/wave-build-devserver-$QA_PORT.log 2>&1 </dev/null &)`,
          `STATUS=000`,
          `for i in $(seq 1 30); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$QA_PORT$QA_HEALTH_PATH 2>/dev/null); [ "$STATUS" = "200" ] && break; done`,
          `kill $(lsof -ti:$QA_PORT) 2>/dev/null`,
          `[ "$STATUS" = "200" ] || { echo "SERVER_CHECK_FAILED: framework=$QA_FRAMEWORK port=$QA_PORT"; tail -40 /tmp/wave-build-devserver-$QA_PORT.log >&2 || true; exit 1; }`,
        ].join('\n'),
        timeout: 60000,
        captureAs: 'SERVER_OUTPUT',
        captureStderrAs: 'SERVER_ERROR',
        onFail: {
          action: 'retry_step' as const,
          targetStep: 'dev-server-fix',
          injectAs: 'SERVER_ERROR',
        },
        loopTo: 'dev-server-fix',
      },
      // 4. Server fix (loop-only)
      {
        id: 'dev-server-fix',
        agentId: 'DEV',
        prompt: `The dev server failed to start after wave ${waveNum}. Error:

{{SERVER_ERROR}}

Fix the issue so the app serves correctly on port 5173.
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
    ],
  };
}
