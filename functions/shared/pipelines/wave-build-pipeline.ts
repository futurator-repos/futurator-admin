import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildAgentConfig } from './role-policy';
import { buildFrameworkDetectSnippet, buildPortReclaimSnippet } from './framework-detect';

/**
 * Wave-level build + server-check pipeline.
 *
 * Runs after all stories in a wave complete successfully. If `npm run build`
 * fails, the build-fix loop asks DEV to patch; if the dev server fails to
 * boot on port 5173 within 15s, the server-fix loop kicks in.
 *
 * Story 16.2 extracted this out of `functions/api/index.ts` so the cron-driven
 * wave-completion reducer can share it without bundling the Hono app.
 *
 * @param requiredSources — file paths (story touch points) that the wave's
 *   stories were supposed to write. PR-68 adds a `bundle-source-check`
 *   step that scans build sourcemaps for each path; any missing path
 *   means the file exists in source but is orphaned (no import path from
 *   the entry). Pass `[]` or omit to disable the check. Framework-agnostic:
 *   sourcemap `.sources` arrays are emitted by Vite, Rollup, Webpack,
 *   esbuild, Turbopack, and SvelteKit; the check works for any project
 *   that ships sourcemaps.
 */
export function generateWaveBuildPipeline(
  workingDir: string,
  waveNum: number,
  storyTitles: string[],
  requiredSources: string[] = [],
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
      // 2.5. PR-68 (2026-05-15) — bundle-source-check.
      //
      // After `npm run build` succeeds, verify every file the wave's stories
      // were supposed to touch is REACHABLE from the entry point — not just
      // sitting orphaned in `src/`. We grep the production sourcemaps'
      // `.sources[]` arrays (which list every source file compiled into the
      // bundle, surviving minification). If a story's touch point doesn't
      // appear in any sourcemap, the build is "green" but the code is dead.
      //
      // Framework-agnostic: Vite, Rollup, Webpack, esbuild, Turbopack, and
      // SvelteKit all emit standard sourcemaps with a `.sources` array.
      // The check is skipped (exits 0 with a marker) when:
      //   - no requiredSources were declared
      //   - no sourcemap files exist (rare — production minified builds
      //     usually ship maps; bare `vite build --sourcemap=false` skips this)
      //
      // spyhunter-1 forensic 2026-05-13: `src/components/GameScene.ts`,
      // `src/app/page.ts`, `src/hooks/useGameLoop.ts` were all in the source
      // tree but `src/main.ts` (Vite's entry per `index.html`) never imported
      // them. Bundle source-check would have caught it instantly: those
      // paths would have been missing from every sourcemap.
      ...(requiredSources.length > 0
        ? [
            {
              id: 'bundle-source-check',
              stepType: 'shell' as const,
              command: [
                `cd ${workingDir}`,
                // Detect bundler output dir. Order matters: Next.js export
                // (`out/_next/`) before plain `out/`; SvelteKit before Vite.
                `OUT=""`,
                `for cand in out/_next/static/chunks .next/static/chunks .svelte-kit/output/client/_app build/client/_app dist out build; do`,
                `  if [ -d "$cand" ]; then OUT="$cand"; break; fi`,
                `done`,
                `if [ -z "$OUT" ]; then echo "BUNDLE_CHECK_SKIPPED: no recognised build output dir under ${workingDir}"; exit 0; fi`,
                `echo "[bundle-source-check] scanning sourcemaps under $OUT/"`,
                // Concatenate every sourcemap's `.sources` field. `find` is
                // POSIX-portable; `node -e` parses the JSON because `jq` isn't
                // guaranteed on EC2.
                `MAPS=$(find "$OUT" -type f -name '*.js.map' 2>/dev/null)`,
                `if [ -z "$MAPS" ]; then echo "BUNDLE_CHECK_SKIPPED: no .js.map files found under $OUT/ — build without sourcemaps cannot be verified"; exit 0; fi`,
                `node -e "$(cat <<'NODE_EOF'`,
                `const fs = require('fs');`,
                `const path = require('path');`,
                `const required = ${JSON.stringify(requiredSources)};`,
                `const maps = process.argv.slice(1);`,
                `const allSources = new Set();`,
                `for (const m of maps) {`,
                `  try {`,
                `    const j = JSON.parse(fs.readFileSync(m, 'utf8'));`,
                `    if (Array.isArray(j.sources)) for (const s of j.sources) allSources.add(s);`,
                `  } catch (e) { console.error('[bundle-source-check] skip bad map:', m, String(e).slice(0,80)); }`,
                `}`,
                `// Match by suffix: sourcemap entries are often prefixed with`,
                `// '../../../src/...' or 'webpack:///./src/...'. A trailing-slash`,
                `// suffix match is robust to all of them.`,
                `const missing = [];`,
                `for (const tp of required) {`,
                `  // Normalise both sides: strip leading ./ and any '..' prefixes.`,
                `  const norm = tp.replace(/^\\.\\//, '');`,
                `  let found = false;`,
                `  for (const src of allSources) {`,
                `    if (src.endsWith('/' + norm) || src.endsWith(norm)) { found = true; break; }`,
                `  }`,
                `  if (!found) missing.push(tp);`,
                `}`,
                `if (missing.length > 0) {`,
                `  console.error('BUNDLE_ORPHAN_FILES: the following wave-${waveNum} touch points are not reachable from the build entry:');`,
                `  for (const m of missing) console.error('  - ' + m);`,
                `  console.error('');`,
                `  console.error('Likely cause: the file was written but not imported by anything in the entry-point import graph. Common patterns:');`,
                `  console.error('  • Vite scaffold leaves src/main.ts pointing at a stub; new code in src/app/ or src/components/ never gets imported.');`,
                `  console.error('  • A new module exists but the entry (or its parent component) never imports it.');`,
                `  console.error('  • The dev wrote to a different path than the touchPoint declared in the plan.');`,
                `  console.error('');`,
                `  console.error('Hint: open the framework entry file (index.html, src/main.ts, app/layout.tsx, etc.) and verify it imports the touch points above (or imports something that does).');`,
                `  process.exit(1);`,
                `}`,
                `console.log('[bundle-source-check] all ' + required.length + ' touch points reachable from the bundle entry');`,
                `NODE_EOF`,
                `)" $MAPS`,
              ].join('\n'),
              timeout: 30000,
              captureAs: 'BUNDLE_CHECK_OUTPUT' as const,
              captureStderrAs: 'BUNDLE_CHECK_ERROR' as const,
              onFail: { action: 'fail' as const, injectAs: 'BUNDLE_CHECK_ERROR' as const },
            },
          ]
        : []),
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
          // 2026-05-17 — multi-pass reclaim. Single port-kill misses
          // daemon-forked Next.js / Vite / Expo orphans from prior waves
          // running on the same EC2 host. See framework-detect.ts.
          buildPortReclaimSnippet(),
          `cd ${workingDir} && (nohup $QA_DEV_CMD > /tmp/wave-build-devserver-$QA_PORT.log 2>&1 </dev/null &)`,
          `STATUS=000`,
          `for i in $(seq 1 30); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$QA_PORT$QA_HEALTH_PATH 2>/dev/null); [ "$STATUS" = "200" ] && break; done`,
          // 2026-05-17 — use [c] bracket-class regex on pkill patterns so this
          // cleanup line doesn't self-match the bash interpreter running it
          // (see framework-detect buildPortReclaimSnippet for the full incident).
          `kill $(lsof -ti:$QA_PORT) 2>/dev/null; pkill -TERM -f '[n]ext dev' 2>/dev/null; pkill -TERM -f '[n]ext-server' 2>/dev/null; true`,
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
