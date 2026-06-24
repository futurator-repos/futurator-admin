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
  seamHook?: string,
): PipelineDefinition {
  // pacman4 — the EARLY seam-mount gate. A seam-bearing boilerplate (canvas-game,
  // dashboard) declares a `seamHook` (e.g. useGameStateMachine); the assembled app
  // MUST import+call it or `window.__harness` never publishes — the "static
  // preview, not the live app" failure that reached QA unwired across pacman3/4/6/7.
  // We run the SAME two-stage, false-pass-proof check QA's DV-2 uses (the tested
  // daemon lib seam-mount-check.mjs), HERE — at plan-build, on the assembled app,
  // once. A failure routes the plan to 'fixing' (plan-reducer), not 'review', so an
  // unwired game is blocked the moment it's assembled, not 5h later at final QA.
  // Only emitted when the boilerplate has a seam (back-compat: no seamHook → no step).
  const seamSteps = seamHook
    ? [
        {
          id: 'plan-seam-check',
          stepType: 'shell' as const,
          command: [
            `cd ${workingDir}`,
            // Uses the canonical, unit-tested checker (daemon/lib/seam-mount-check.mjs)
            // via the established /opt/futurator-daemon import pattern — single source
            // of truth for the false-pass-proof two-stage grep.
            `node -e "import('file:///opt/futurator-daemon/lib/seam-mount-check.mjs').then(m => { const r = m.checkSeamMounted({ projectDir: process.cwd(), seamHook: ${JSON.stringify(seamHook)} }); if (r.checked && !r.mounted) { console.error('SEAM_NEVER_PUBLISHED: ' + r.reason); process.exit(1); } console.log('SEAM_MOUNT_OK: ' + r.reason); }).catch(e => { console.error('seam-check error (non-blocking): ' + e.message); })"`,
          ].join('\n'),
          timeout: 30000,
          captureAs: 'SEAM_OUTPUT',
          captureStderrAs: 'SEAM_ERROR',
          onFail: {
            action: 'retry_step' as const,
            targetStep: 'plan-seam-fix',
            injectAs: 'SEAM_ERROR',
          },
          loopTo: 'plan-seam-fix',
        },
        {
          id: 'plan-seam-fix',
          agentId: 'DEV',
          prompt: `The assembled app for plan "${planName}" never mounts the verifiability seam — the game/primary feature is not wired, so it renders as a static preview (this is why QA fails with SEAM_NEVER_PUBLISHED and the dev preview is blank).

Seam check:
{{SEAM_ERROR}}

Fix it: the PRIMARY/assembled feature must IMPORT and CALL \`${seamHook}\` and actually run the app (mount the component, run the loop/input), so the live game renders and \`window.__harness\` publishes under the test harness. This is an INTEGRATION wiring fix — the engine/render functions likely exist but are never called. Do NOT just define them; WIRE them so the app runs.

Working directory: ${workingDir}

---WORK_SUMMARY---
[What you wired so the seam mounts]
---END_WORK_SUMMARY---`,
          extractors: {
            WORK_SUMMARY: {
              type: 'between' as const,
              startDelimiter: '---WORK_SUMMARY---',
              endDelimiter: '---END_WORK_SUMMARY---',
            },
          },
          validations: [],
        },
      ]
    : [];
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
      // 2b. Seam-mount gate (pacman4) — after the build compiles, before the
      // server check. Blocks an unwired game (seam declared but never imported)
      // from reaching 'review'. Empty for non-seam boilerplates.
      ...seamSteps,
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
          // 2026-05-17 — use [c] bracket-class regex on pkill patterns so this
          // cleanup line doesn't self-match the bash interpreter running it
          // (see buildPortReclaimSnippet header comment for the full incident).
          `fuser -k -KILL $QA_PORT/tcp 2>/dev/null; pkill -TERM -f '[n]ext dev' 2>/dev/null; pkill -TERM -f '[n]ext-server' 2>/dev/null; true`,
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
