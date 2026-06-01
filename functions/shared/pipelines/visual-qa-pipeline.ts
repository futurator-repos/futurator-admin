/**
 * Visual QA pipeline builder + VT parser.
 *
 * Pipeline v2.0 PR-8 — full QA stage redesign per
 * docs/concepts/pipeline-v2/futurator-pipeline-qa-stage-redesign.md.
 *
 * Two builders live here:
 *
 *   • `buildQaAggregatePipeline(plan, tests, …)` — Q4.1 stage. ONE shell
 *     step. Validates schema, classifies levels, runs coverage +
 *     specificity checks, writes `visual-tests-draft.md`, emits the
 *     contract-review report card. Job ends with
 *     `OVERALL_VERDICT=PENDING_APPROVAL` so the dashboard surfaces the
 *     contract gate.
 *
 *   • `buildQaExecutePipeline(plan, approvedTests, …)` — Q2/Q3/Q5
 *     execution stage. Seven steps: qa-prepare → qa-judge-l0 →
 *     qa-judge-l1 → qa-judge-l2 → qa-report → qa-cleanup. Boots ONE
 *     dev server (per Q1 plan-scoping), captures screenshots in bash,
 *     routes each test through the cheapest judge that can answer it,
 *     emits one consolidated report.
 *
 * Legacy `buildQaPipeline(epic, …)` is preserved as a thin wrapper so
 * `/api/epic-workflows/:id/visual-qa` keeps working until UI cutover.
 *
 * Key invariants:
 *   • The LLM is invoked at exactly two places: qa-judge-l1 (Haiku per
 *     test, parallel) and qa-judge-l2 (Sonnet per test, sequential).
 *     Every other step is bash. Reviewer addendum §16.2 motivates the
 *     Sonnet-not-Haiku at L1 fallback flag (defaults Haiku for now per
 *     redesign; toggle via env if measurement says otherwise).
 *   • Per-test budget kills are enforced at the daemon, not in the
 *     pipeline definition — the pipeline declares budgets, daemon
 *     consumes them.
 *   • The viewport flag is hardened at the schema layer
 *     (`parseVisualTestViewport`) so the playwright `--viewport-size=`
 *     bug class can't recur.
 */

import type { PipelineDefinition } from '../types/agent-orchestrator';
import type { VisualTestDef, VisualTestFlowStep, VisualTestLevel } from '../types/epic-workflow';
import type { Plan } from '../types/plan';
import type { BoilerplateMetadata } from '../boilerplates/types';
import { parseVisualTestViewport, formatViewport } from '../services/visual-test-classifier';
import { buildAgentConfig } from './role-policy';
import { buildFrameworkDetectSnippet } from './framework-detect';

// ── Parser ───────────────────────────────────────────────────────────

/**
 * Parse visual-test YAML-like blocks emitted by the Dev agent into the
 * structured `VisualTestDef[]` our daemon + repo expect.
 *
 * PR-8 extension: recognizes `level:`, `viewport:`, `url:`, `expectText:`,
 * `consoleErrorAllow:`, plus nested `screenshot:` and `flow:` blocks.
 * Backward compatible — pre-PR-8 blocks (plain id/criteriaRef/
 * description/setup/expect) parse unchanged and are auto-classified
 * downstream by `classifyVisualTest`.
 *
 * Leniency: tolerates quoted values, optional `action:` lines, and
 * adjacent blocks on the same line (splits on `- id:` markers).
 */
export function parseVisualTests(raw: string): VisualTestDef[] {
  const tests: VisualTestDef[] = [];
  const blocks = raw.split(/(?=^- id:)/m).filter((b) => b.trim().startsWith('- id:'));

  for (const block of blocks) {
    const id = block.match(/^- id:\s*(.+)/m)?.[1]?.trim() || '';
    const criteriaRef = block.match(/criteriaRef:\s*(.+)/m)?.[1]?.trim() || '';
    const description = block.match(/description:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || '';
    const setup = block.match(/setup:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || '';
    const action = block.match(/action:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const expect = block.match(/expect:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || '';

    // PR-8 fields. All optional in source — the classifier fills gaps.
    const levelRaw = block.match(/level:\s*(L0|L1|L2)/m)?.[1] as VisualTestLevel | undefined;
    const viewport = block.match(/viewport:\s*(\d+\s*[,x]\s*\d+)/m)?.[1]?.trim();
    const url = block.match(/url:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
    const judge = block.match(/judge:\s*\|\s*\n([\s\S]*?)(?=\n\s*\w+:|$)/m)?.[1]?.trim();
    const expectTextRaw = block.match(/expectText:\s*\[([^\]]*)\]/m)?.[1];
    const expectText = expectTextRaw
      ? expectTextRaw
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : undefined;
    const consoleErrorAllowRaw = block.match(/consoleErrorAllow:\s*\[([^\]]*)\]/m)?.[1];
    const consoleErrorAllow = consoleErrorAllowRaw
      ? consoleErrorAllowRaw
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : undefined;

    // Nested screenshot block: `screenshot:\n    selector: ...\n    waitFor: ...`
    let screenshot: VisualTestDef['screenshot'];
    const screenshotMatch = block.match(/screenshot:\s*\n((?:\s{4,}[\w-]+:.*\n?)+)/m);
    if (screenshotMatch) {
      const inner = screenshotMatch[1];
      const selector = inner.match(/selector:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim();
      const waitFor = inner.match(/wait-?for:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim();
      screenshot = { selector, waitFor };
    }

    // Nested flow: `flow:\n    - action: navigate\n      url: /\n    - …`
    let flow: VisualTestFlowStep[] | undefined;
    const flowMatch = block.match(/flow:\s*\n((?:\s+- action:[\s\S]*?)(?=\n\s*\w+:|$))/m);
    if (flowMatch) {
      flow = parseFlowSteps(flowMatch[1]);
    }

    if (id && description) {
      const test: VisualTestDef = {
        id,
        criteriaRef,
        description,
        setup,
        action: action === 'none' ? undefined : action,
        expect,
      };
      if (levelRaw) test.level = levelRaw;
      if (viewport) {
        // Normalize to comma form via the classifier's parser (which
        // throws on legacy "WxH"). Caller still gets the raw to surface
        // as a warning at qa-aggregate time.
        try {
          const dims = parseVisualTestViewport(viewport);
          test.viewport = formatViewport(dims.width, dims.height);
        } catch {
          // Keep raw — qa-aggregate's specificity check flags it.
          test.viewport = viewport;
        }
      }
      if (url) test.url = url;
      if (judge) test.judge = judge;
      if (expectText) test.expectText = expectText;
      if (consoleErrorAllow) test.consoleErrorAllow = consoleErrorAllow;
      if (screenshot) test.screenshot = screenshot;
      if (flow) test.flow = flow;
      tests.push(test);
    }
  }
  return tests;
}

function parseFlowSteps(raw: string): VisualTestFlowStep[] {
  const steps: VisualTestFlowStep[] = [];
  const stepBlocks = raw.split(/(?=\s+-\s*action:)/m).filter((s) => /action:/.test(s));
  for (const sb of stepBlocks) {
    const action = sb.match(/action:\s*(\w+)/)?.[1] as VisualTestFlowStep['action'] | undefined;
    if (!action) continue;
    const url = sb.match(/url:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim();
    const selector = sb.match(/selector:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim();
    const value = sb.match(/value:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim();
    const ms = Number(sb.match(/ms:\s*(\d+)/)?.[1]) || undefined;
    const label = sb.match(/label:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim();
    steps.push({
      action,
      ...(url ? { url } : {}),
      ...(selector ? { selector } : {}),
      ...(value ? { value } : {}),
      ...(ms ? { ms } : {}),
      ...(label ? { label } : {}),
    });
  }
  return steps;
}

// ── Pipeline builders ─────────────────────────────────────────────────

/** Default port when only one QA job runs at a time. PR-8a plan-scoped
 * QA always uses this — there is no concurrent fan-out to escape from. */
export const DEFAULT_QA_PORT = 5173;

/**
 * Default per-level budgets. Reviewer addendum §16.2: L1 starts at Haiku
 * 4.5 per the redesign, with the option to flip via env once measurement
 * agreement data exists.
 */
export const QA_LEVEL_DEFAULTS: Record<
  VisualTestLevel,
  { wallclockSec: number; costUsd: number; model: string }
> = {
  L0: { wallclockSec: 5, costUsd: 0, model: '' /* no LLM */ },
  L1: { wallclockSec: 30, costUsd: 0.02, model: 'claude-haiku-4-5-20251001' },
  L2: { wallclockSec: 90, costUsd: 0.1, model: 'claude-sonnet-4-6' },
};

export interface QaPipelineInputs {
  plan: Plan;
  /** Tests collected across every story across every epic (PR-8a flat shape). */
  allVisualTests: ReadonlyArray<
    VisualTestDef & {
      storyId: string;
      storyTitle: string;
      epicId?: string;
      epicTitle?: string;
    }
  >;
  /** Snapshot prefix in the public bucket (e.g., `qa-snapshots/dino1/<jobId>/`). */
  snapshotPrefix: string;
  /** Job ID — used in temp-file paths so concurrent runs don't collide. */
  jobId: string;
  /** Boilerplate qaContext (port, dev command, warmup, error allowlist). */
  boilerplate?: BoilerplateMetadata['qaContext'];
  /** Override port — defaults to `boilerplate.defaultPort` or `DEFAULT_QA_PORT`. */
  port?: number;
  /**
   * Pipeline v2.0 PR-8 (Q4.3) — every acceptance criterion across every
   * story in the plan, used by qa-aggregate to enforce the coverage
   * rule ("every needsBrowser AC has ≥1 visual test"). Empty array
   * disables the coverage check (specificity check still runs).
   */
  acceptanceCriteria?: ReadonlyArray<{ id: string; needsBrowser: boolean }>;
}

/**
 * Pipeline v2.0 PR-8 (Q4.1) — qa-aggregate stage.
 *
 * One shell step. Reads each test definition (passed inline as JSON),
 * classifies missing levels via the Node-side `classifyVisualTest`,
 * runs coverage + specificity checks, writes `visual-tests-draft.md` to
 * the plan's working directory, emits the contract-review variables.
 *
 * Job ends with `OVERALL_VERDICT=PENDING_APPROVAL`. The plan dashboard
 * surfaces the contract gate; nothing else runs until the operator
 * calls `POST /api/plans/:id/qa-contract/approve` (which then launches
 * the execute pipeline against the approved tests).
 *
 * Emitted variables:
 *   • CONTRACT_STATUS — always `PENDING_APPROVAL` on first run.
 *   • TOTAL_TESTS, L0_COUNT, L1_COUNT, L2_COUNT
 *   • ESTIMATED_COST_USD, ESTIMATED_WALLCLOCK_SEC
 *   • COVERAGE_WARNINGS, SPECIFICITY_WARNINGS — JSON arrays
 *   • CLASSIFIED_TESTS — JSON array of {testId, level, reason}
 *   • OVERALL_VERDICT — `PENDING_APPROVAL`
 */
export function buildQaAggregatePipeline(inputs: QaPipelineInputs): PipelineDefinition {
  const { plan, allVisualTests } = inputs;
  // Inline the test JSON + the criteria list into the bash command.
  // Node parses, classifies, emits the variables. No LLM call here.
  const testsJson = JSON.stringify(allVisualTests);
  // Q4.3 — caller passes the full AC list across the plan's epics so the
  // coverage check ("every needsBrowser AC has ≥1 test") can run. Empty
  // array means the launcher couldn't collect ACs (e.g., a legacy plan);
  // the specificity check still runs.
  const acsJson = JSON.stringify(inputs.acceptanceCriteria ?? []);
  // PR-8f #2 — rigor caps classifier output. Pass the plan's rigor (or
  // 'mvp' as the default for legacy plans without rigor set) so qa-aggregate
  // surfaces the "forced by rigor" warnings on the contract card.
  const planRigorJson = JSON.stringify(plan.rigor ?? 'mvp');

  return {
    maxIterations: 1,
    agents: {},
    steps: [
      {
        id: 'qa-aggregate',
        stepType: 'shell',
        // The classifier module is bundled with the API Lambda but we
        // need it on EC2 too. The daemon's working tree is rsync'd from
        // the repo so the relative import works. We invoke node with
        // ts-node-style transpilation via tsx.
        //
        // The heredoc passes the test list + AC list as JSON on stdin;
        // the Node script writes visual-tests-draft.md and emits the
        // KEY=VALUE marker block the extractors capture.
        command: [
          `cd ${plan.workingDir}`,
          `node -e "$(cat <<'NODE_EOF'`,
          `const { aggregateVisualTests } = require(process.env.QA_CLASSIFIER_PATH || '/opt/futurator-daemon/lib/visual-test-classifier-bundle.cjs');`,
          `const fs = require('fs');`,
          `const tests = ${testsJson};`,
          `const acs = ${acsJson};`,
          `const planRigor = ${planRigorJson};`,
          `const report = aggregateVisualTests(tests, acs, planRigor);`,
          `// Write the draft contract — operator reads + edits + approves.`,
          `const lines = ['# Visual Test Contract — DRAFT', '', '> Generated by qa-aggregate at ' + new Date().toISOString(), '> Operator must approve before QA executes.', ''];`,
          `lines.push('## Summary');`,
          `lines.push('- Total tests: ' + report.totalTests);`,
          `lines.push('- L0: ' + report.byLevel.L0 + ' / L1: ' + report.byLevel.L1 + ' / L2: ' + report.byLevel.L2);`,
          `lines.push('- Estimated cost: $' + report.estimatedCostUsd.toFixed(3));`,
          `lines.push('- Estimated wall-clock: ' + report.estimatedWallclockSec + 's');`,
          `lines.push('');`,
          `lines.push('## Tests');`,
          `for (const c of report.classifications) {`,
          `  const t = tests.find(x => x.id === c.testId);`,
          `  lines.push('### ' + c.testId + ' (' + c.classification.level + ')');`,
          `  lines.push('- criteriaRef: ' + (t.criteriaRef || '(none)'));`,
          `  lines.push('- expect: ' + (t.expect || '(missing)'));`,
          `  lines.push('- classifier reason: ' + c.classification.reason);`,
          `  lines.push('');`,
          `}`,
          `if (report.coverageWarnings.length) { lines.push('## Coverage warnings'); for (const w of report.coverageWarnings) lines.push('- ⚠️ ' + w.message); lines.push(''); }`,
          `if (report.specificityWarnings.length) { lines.push('## Specificity warnings'); for (const w of report.specificityWarnings) lines.push('- ⚠️ ' + w.message); lines.push(''); }`,
          `fs.writeFileSync('visual-tests-draft.md', lines.join('\\n'));`,
          `// Emit the variables the extractors capture.`,
          `console.log('---QA_AGGREGATE_REPORT---');`,
          `console.log('CONTRACT_STATUS: PENDING_APPROVAL');`,
          `console.log('OVERALL_VERDICT: PENDING_APPROVAL');`,
          `console.log('TOTAL_TESTS: ' + report.totalTests);`,
          `console.log('L0_COUNT: ' + report.byLevel.L0);`,
          `console.log('L1_COUNT: ' + report.byLevel.L1);`,
          `console.log('L2_COUNT: ' + report.byLevel.L2);`,
          `console.log('ESTIMATED_COST_USD: ' + report.estimatedCostUsd.toFixed(4));`,
          `console.log('ESTIMATED_WALLCLOCK_SEC: ' + report.estimatedWallclockSec);`,
          `console.log('COVERAGE_WARNINGS: ' + JSON.stringify(report.coverageWarnings));`,
          `console.log('SPECIFICITY_WARNINGS: ' + JSON.stringify(report.specificityWarnings));`,
          `console.log('CLASSIFIED_TESTS: ' + JSON.stringify(report.classifications));`,
          `console.log('---END_QA_AGGREGATE_REPORT---');`,
          `NODE_EOF`,
          `)"`,
        ].join('\n'),
        timeout: 60000,
        captureAs: 'AGGREGATE_OUTPUT',
        extractors: {
          QA_AGGREGATE_REPORT: {
            type: 'between',
            startDelimiter: '---QA_AGGREGATE_REPORT---',
            endDelimiter: '---END_QA_AGGREGATE_REPORT---',
          },
          CONTRACT_STATUS: {
            type: 'regex',
            pattern: 'CONTRACT_STATUS:\\s*(\\w+)',
          },
          OVERALL_VERDICT: {
            type: 'regex',
            pattern: 'OVERALL_VERDICT:\\s*(\\w+)',
          },
          TOTAL_TESTS: { type: 'regex', pattern: 'TOTAL_TESTS:\\s*(\\d+)' },
          L0_COUNT: { type: 'regex', pattern: 'L0_COUNT:\\s*(\\d+)' },
          L1_COUNT: { type: 'regex', pattern: 'L1_COUNT:\\s*(\\d+)' },
          L2_COUNT: { type: 'regex', pattern: 'L2_COUNT:\\s*(\\d+)' },
          ESTIMATED_COST_USD: {
            type: 'regex',
            pattern: 'ESTIMATED_COST_USD:\\s*([\\d.]+)',
          },
          ESTIMATED_WALLCLOCK_SEC: {
            type: 'regex',
            pattern: 'ESTIMATED_WALLCLOCK_SEC:\\s*(\\d+)',
          },
          COVERAGE_WARNINGS: {
            type: 'regex',
            pattern: 'COVERAGE_WARNINGS:\\s*(\\[[\\s\\S]*?\\])',
          },
          SPECIFICITY_WARNINGS: {
            type: 'regex',
            pattern: 'SPECIFICITY_WARNINGS:\\s*(\\[[\\s\\S]*?\\])',
          },
          CLASSIFIED_TESTS: {
            type: 'regex',
            pattern: 'CLASSIFIED_TESTS:\\s*(\\[[\\s\\S]*?\\])',
          },
        },
        onFail: { action: 'fail', injectAs: 'AGGREGATE_ERROR' },
      },
    ],
  };
}

/**
 * Pipeline v2.0 PR-8 (Q2/Q3/Q5) — qa-execute stage.
 *
 * Runs after the operator approves the test contract. Boots ONE dev
 * server (Q1: plan-scoped, not per-epic), captures screenshots in bash
 * (Q2.1: not via the agent), routes each test through the cheapest
 * judge that can answer it (Q3: L0 bash / L1 Haiku / L2 Sonnet),
 * emits ONE consolidated report (Q5.3 per-test results).
 *
 * Steps:
 *   1. qa-prepare       — boot dev server + capture all screenshots
 *   2. qa-judge-l0      — bash-only L0 verification, parallel
 *   3. qa-judge-l1      — Haiku per-test, parallel batches of 5
 *   4. qa-judge-l2      — Sonnet per-test, sequential
 *   5. qa-report        — aggregate per-test results
 *   6. qa-cleanup       — kill dev server, archive logs
 *
 * Emits:
 *   • OVERALL_VERDICT (PASS|FAIL|PARTIAL)
 *   • TEST_RESULTS — JSON array of {testId, level, verdict, rationale,
 *     screenshotUrl, costUsd, durationMs}
 *   • SCREENSHOTS — markdown list of testId → URL
 *   • OVERVIEW_URL — landing-state screenshot URL
 *   • TOTAL_PASS, TOTAL_FAIL, TOTAL_UNCERTAIN
 *   • COST_USD, WALLCLOCK_SEC
 *   • FAILED_TESTS — comma-separated test IDs
 */
export function buildQaExecutePipeline(inputs: QaPipelineInputs): PipelineDefinition {
  const { plan, allVisualTests, snapshotPrefix, jobId, boilerplate } = inputs;
  // PR-59 (2026-05-13) — framework detection moved to runtime.
  //
  // Previously, port + devCommand + healthcheck path were resolved at
  // pipeline-build time from `boilerplate.qaContext` (BOILERPLATE_REGISTRY
  // lookup keyed on App.boilerplateType). When the registered type drifts
  // from what the working dir actually contains — e.g. App created as
  // `nextjs-canvas-game` but PM generated Vite code — qa-prepare boots
  // with the wrong flags (--hostname vs --host) and the dev server never
  // becomes ready. spyhunter-1 hit this 2026-05-08: --hostname rejected
  // by Vite CLI, every retry stalled.
  //
  // Fix: the qa-prepare bash command now reads `package.json` at runtime
  // via `buildFrameworkDetectSnippet()`. Detection works for vite, next,
  // remix, expo, sveltekit, nuxt; falls back to Vite-flavoured defaults
  // for unknown frameworks. Operator can still override port via
  // `inputs.port` (kept for the rare manual case).
  const warmupMs = boilerplate?.warmupMs ?? 0;
  const forcePort = inputs.port;
  // `port` retained as a *fallback* used by steps that run after qa-prepare
  // (qa-l0/l1/l2, qa-cleanup) — those steps read `qa-port.txt` written by
  // qa-prepare and fall back to this value only if the file is missing.
  const port = inputs.port ?? boilerplate?.defaultPort ?? DEFAULT_QA_PORT;

  // L0 / L1 / L2 partition. Caller has classified everything by now —
  // any unclassified test is treated as L0 (safest default; pure bash).
  const l0Tests = allVisualTests.filter((t) => (t.level ?? 'L0') === 'L0');
  const l1Tests = allVisualTests.filter((t) => t.level === 'L1');
  const l2Tests = allVisualTests.filter((t) => t.level === 'L2');

  const testsJson = JSON.stringify(allVisualTests);
  const l0Json = JSON.stringify(l0Tests);
  const l1Json = JSON.stringify(l1Tests);
  const l2Json = JSON.stringify(l2Tests);

  const cdnPrefix = `https://futurator.ai/${snapshotPrefix}`;
  const tmpResultsDir = `/tmp/qa-${jobId}`;

  return {
    maxIterations: 1,
    agents: {},
    steps: [
      // ── 1. qa-prepare — boot dev server, capture all screenshots ──
      {
        id: 'qa-prepare',
        stepType: 'shell',
        command: [
          // ── Pipeline-v2 fix (2026-06-01): advance the source to the plan branch ──
          // The legacy `projects/<appId>` dir is a worktree of the bare repo,
          // frozen on `main` (the bootstrap scaffold). All story work merges into
          // `plan/<slug>` in the bare repo, but this worktree never advanced — so
          // QA was testing (and deploy was shipping) the SCAFFOLD, not the built
          // app. Fast-forward `main` here to the plan tip so QA tests the real
          // code. This also makes `main` track the latest plan, so the NEXT plan's
          // first story forks brownfield off the delivered state (story-worktree
          // resolveParentRef falls back to `main`). Belt-and-braces: if the plan
          // branch is missing we test current HEAD and warn rather than fail.
          `cd ${plan.workingDir} || { echo "QA_SYNC_ERROR: cannot cd ${plan.workingDir}"; exit 1; }`,
          `if git rev-parse --verify --quiet refs/heads/plan/${plan.name} >/dev/null 2>&1; then`,
          `  git checkout -f main >/dev/null 2>&1 || git checkout -f -B main >/dev/null 2>&1 || true`,
          `  git reset --hard plan/${plan.name} >/dev/null 2>&1 && echo "[qa-sync] advanced ${plan.workingDir} -> plan/${plan.name} @ $(git rev-parse --short HEAD)"`,
          `  npm install --prefer-offline --no-audit --no-fund >/dev/null 2>&1 || true`,
          `else`,
          `  echo "[qa-sync] WARN: plan/${plan.name} not found in bare repo — QA running against current HEAD $(git rev-parse --short HEAD 2>/dev/null)"`,
          `fi`,
          // PR-59 — runtime framework detection. Sets QA_PORT, QA_DEV_CMD,
          // QA_HEALTH_PATH, QA_FRAMEWORK by inspecting package.json. All
          // subsequent commands in this step use those bash variables.
          buildFrameworkDetectSnippet({ cwd: plan.workingDir, forcePort }),
          `mkdir -p ${tmpResultsDir} ${tmpResultsDir}/screenshots`,
          `# Persist QA_PORT so downstream steps (qa-l1, qa-cleanup) read it`,
          `# without re-detecting. Cheap belt-and-braces — re-detect would also work.`,
          `echo "$QA_PORT" > ${tmpResultsDir}/qa-port.txt`,
          `# Kill any process holding our port (defense in depth — Q1 dropped fan-out so this is rarely needed)`,
          `kill $(lsof -ti:$QA_PORT) 2>/dev/null || true`,
          `sleep 1`,
          `cd ${plan.workingDir}`,
          `# Detached subshell so npm reparents to init and bash never wait4()s on it.`,
          `# QA_DEV_CMD is set by the framework-detect snippet above.`,
          `(nohup $QA_DEV_CMD > ${tmpResultsDir}/devserver.log 2>&1 </dev/null &)`,
          `# Healthcheck loop — 60 attempts (was 30) to give Next.js / SvelteKit cold starts headroom.`,
          `STATUS=000`,
          `for i in $(seq 1 60); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$QA_PORT$QA_HEALTH_PATH 2>/dev/null); [ "$STATUS" = "200" ] && break; done`,
          `[ "$STATUS" = "200" ] || { echo "QA_PREPARE_ERROR: server boot failed (framework=$QA_FRAMEWORK port=$QA_PORT)"; tail -40 ${tmpResultsDir}/devserver.log >&2 || true; exit 1; }`,
          warmupMs > 0 ? `sleep $((${warmupMs} / 1000))` : `# no warmup`,
          `# Overview screenshot`,
          `npx playwright screenshot --viewport-size=1280,720 --wait-for-timeout=2000 http://localhost:$QA_PORT$QA_HEALTH_PATH ${tmpResultsDir}/screenshots/overview.png 2>&1 || true`,
          `# Per-test screenshots driven by tests JSON. Parallel batches of 5.`,
          `# QA_PORT exported via env so the heredoc stays single-quoted —`,
          `# protects against $ characters inside test descriptions in tests JSON.`,
          `# PR-60 (2026-05-13) — explicit process.exit(0) at end of IIFE.`,
          `# Without it, the unconsumed child.stdout pipes (we only listen on`,
          `# child.stderr) pin Node's event loop after Playwright children`,
          `# close, and bash waits forever on \`node\` until the step timeout`,
          `# SIGKILLs it (exit null). spyhunter-1 forensic 2026-05-13.`,
          `echo "[qa-prepare] $(date -u +%H:%M:%S) capturing per-test screenshots…"`,
          `QA_PORT=$QA_PORT node -e "$(cat <<'NODE_EOF'`,
          `const { execSync, spawn } = require('child_process');`,
          `const fs = require('fs');`,
          `const tests = ${testsJson};`,
          `const port = parseInt(process.env.QA_PORT, 10);`,
          `const dir = '${tmpResultsDir}/screenshots';`,
          `const failures = [];`,
          `function runOne(t) { return new Promise((resolve) => {`,
          `  const url = 'http://localhost:' + port + (t.url || '/');`,
          `  const vp = (t.viewport || '1280,720').replace(/x/i, ',');`,
          `  const out = dir + '/' + t.id + '.png';`,
          `  const args = ['playwright', 'screenshot', '--viewport-size=' + vp, '--wait-for-timeout=2000', url, out];`,
          `  const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });`,
          `  let stderr = '';`,
          `  // Drain both stdout and stderr — leaving stdout unread can pin`,
          `  // Node's event loop after the child closes (PR-60).`,
          `  child.stdout.on('data', () => {});`,
          `  child.stderr.on('data', (d) => { stderr += d.toString(); });`,
          `  child.on('close', (code) => { if (code !== 0) failures.push({ id: t.id, error: stderr.slice(0, 200) }); resolve(); });`,
          `  child.on('error', (e) => { failures.push({ id: t.id, error: 'spawn: ' + String(e).slice(0, 150) }); resolve(); });`,
          `}); }`,
          `(async () => {`,
          `  const batchSize = 5;`,
          `  for (let i = 0; i < tests.length; i += batchSize) {`,
          `    await Promise.all(tests.slice(i, i + batchSize).map(runOne));`,
          `  }`,
          `  fs.writeFileSync('${tmpResultsDir}/screenshot-failures.json', JSON.stringify(failures));`,
          `  console.log('SCREENSHOTS_CAPTURED: ' + (tests.length - failures.length) + '/' + tests.length);`,
          `  // PR-60 — force exit. Belt-and-braces in case any stdio handle`,
          `  // remains ref'd despite the drain handlers above.`,
          `  process.exit(0);`,
          `})().catch((e) => { console.error('SCREENSHOT_LOOP_ERROR:', e); process.exit(1); });`,
          `NODE_EOF`,
          `)"`,
          `echo "[qa-prepare] $(date -u +%H:%M:%S) uploading screenshots to S3…"`,
          `# Upload all screenshots to S3 in parallel.`,
          `# PR-60 (2026-05-13) — each upload is wrapped in \`timeout 30\` so a`,
          `# single hanging aws-cli call (IAM token refresh, throttling, etc.)`,
          `# can't stall the whole step until the daemon SIGKILLs it.`,
          `for f in ${tmpResultsDir}/screenshots/*.png; do`,
          `  base=$(basename "$f")`,
          `  timeout 30 aws s3 cp "$f" "s3://futurator-ai-website/${snapshotPrefix}$base" --content-type image/png > /dev/null 2>&1 &`,
          `done`,
          `wait`,
          `echo "[qa-prepare] $(date -u +%H:%M:%S) S3 uploads done"`,
          `# Capture console errors from the dev-server log for L0 console-error checks`,
          `grep -iE 'error|warn' ${tmpResultsDir}/devserver.log > ${tmpResultsDir}/console-errors.log 2>/dev/null || true`,
          `echo "QA_PREPARE_OK"`,
          `echo "OVERVIEW_URL: ${cdnPrefix}overview.png"`,
        ].join('\n'),
        timeout: 300000,
        captureAs: 'PREPARE_OUTPUT',
        extractors: {
          OVERVIEW_URL: {
            type: 'regex',
            pattern: 'OVERVIEW_URL:\\s*(https?://[^\\s*_`]+)',
          },
        },
        onFail: { action: 'fail', injectAs: 'PREPARE_ERROR' },
      },

      // ── 2. qa-judge-l0 — pure bash verification ──
      {
        id: 'qa-judge-l0',
        stepType: 'shell',
        command: [
          `node -e "$(cat <<'NODE_EOF'`,
          `const { execSync } = require('child_process');`,
          `const fs = require('fs');`,
          `const tests = ${l0Json};`,
          `const port = ${port};`,
          `const consoleLog = '${tmpResultsDir}/console-errors.log';`,
          `const consoleText = fs.existsSync(consoleLog) ? fs.readFileSync(consoleLog, 'utf8') : '';`,
          `const results = [];`,
          `for (const t of tests) {`,
          `  const start = Date.now();`,
          `  let verdict = 'pass';`,
          `  let rationale = 'L0 checks pass';`,
          `  // Check 1: HTTP status`,
          `  try {`,
          `    const status = execSync('curl -s -o /dev/null -w \\'%{http_code}\\' http://localhost:' + port + (t.url || '/'), { encoding: 'utf8', timeout: 5000 }).trim();`,
          `    if (status !== '200') { verdict = 'fail'; rationale = 'HTTP ' + status + ' (expected 200)'; }`,
          `  } catch (e) { verdict = 'errored'; rationale = 'curl error: ' + String(e).slice(0, 100); }`,
          `  // Check 2: console errors (skip if test allowed-list-only)`,
          `  if (verdict === 'pass' && consoleText) {`,
          `    const allow = (t.consoleErrorAllow || []).map(p => new RegExp(p, 'i'));`,
          `    const errLines = consoleText.split('\\n').filter(l => /error/i.test(l));`,
          `    const blocking = errLines.filter(l => !allow.some(r => r.test(l)));`,
          `    if (blocking.length > 0) { verdict = 'fail'; rationale = 'console error: ' + blocking[0].slice(0, 120); }`,
          `  }`,
          `  // Check 3: page contains expectText (any-of)`,
          `  if (verdict === 'pass' && t.expectText && t.expectText.length > 0) {`,
          `    try {`,
          `      const body = execSync('curl -s http://localhost:' + port + (t.url || '/'), { encoding: 'utf8', timeout: 5000 });`,
          `      const matched = t.expectText.some(s => body.includes(s));`,
          `      if (!matched) { verdict = 'fail'; rationale = 'page does not contain any of: ' + t.expectText.join(', '); }`,
          `    } catch (e) { verdict = 'errored'; rationale = 'page fetch error'; }`,
          `  }`,
          `  // Check 4: screenshot file size (non-blank check)`,
          `  const shot = '${tmpResultsDir}/screenshots/' + t.id + '.png';`,
          `  if (verdict === 'pass' && fs.existsSync(shot)) {`,
          `    const size = fs.statSync(shot).size;`,
          `    if (size < 2048) { verdict = 'fail'; rationale = 'screenshot is < 2KB (likely blank)'; }`,
          `  }`,
          `  results.push({ testId: t.id, level: 'L0', verdict, rationale, screenshotUrl: '${cdnPrefix}' + t.id + '.png', costUsd: 0, durationMs: Date.now() - start });`,
          `}`,
          `fs.writeFileSync('${tmpResultsDir}/l0-results.json', JSON.stringify(results));`,
          `console.log('L0_RESULTS: ' + JSON.stringify(results));`,
          `NODE_EOF`,
          `)"`,
        ].join('\n'),
        timeout: 60000,
        captureAs: 'L0_OUTPUT',
        extractors: {
          L0_RESULTS: {
            type: 'regex',
            pattern: 'L0_RESULTS:\\s*(\\[[\\s\\S]*?\\])',
          },
        },
        onFail: { action: 'fail', injectAs: 'L0_ERROR' },
      },

      // ── 3. qa-judge-l1 — Haiku per-test, parallel batches of 5 ──
      // Q5.1: each test gets a per-test wallclock budget (default 30s,
      // overridable via `test.budgetWallclockSec`). When the budget
      // expires, the claude process is SIGTERM'd and the test is marked
      // `uncertain` (not fail) — uncertain surfaces to operator triage,
      // fail counts against the plan verdict.
      // Q5.2: plan-level cost ceiling (`plan.qaCostBudgetUsd`) is checked
      // before each batch — when running cost would exceed it, remaining
      // tests are marked `skipped-budget`.
      {
        id: 'qa-judge-l1',
        stepType: 'shell',
        command: [
          `node -e "$(cat <<'NODE_EOF'`,
          `const { spawn } = require('child_process');`,
          `const fs = require('fs');`,
          `const tests = ${l1Json};`,
          `const cdnPrefix = '${cdnPrefix}';`,
          `const model = '${QA_LEVEL_DEFAULTS.L1.model}';`,
          `const defaultWallclockMs = ${QA_LEVEL_DEFAULTS.L1.wallclockSec * 1000};`,
          `const defaultCostUsd = ${QA_LEVEL_DEFAULTS.L1.costUsd};`,
          `const planBudgetUsd = ${plan.qaCostBudgetUsd ?? 0};`,
          `function judgeOne(t) { return new Promise((resolve) => {`,
          `  const start = Date.now();`,
          `  const wallclockMs = (t.budgetWallclockSec ? t.budgetWallclockSec * 1000 : defaultWallclockMs);`,
          `  const screenshotUrl = cdnPrefix + t.id + '.png';`,
          // 2026-06-01 — judge reads the LOCAL screenshot file (rendered by the
          // Read tool) instead of a CDN URL it cannot fetch from the sandbox
          // (the L2 "Unable to fetch the screenshot URL" failure). screenshotUrl
          // is still recorded for the UI gallery link.
          `  const localShot = '${tmpResultsDir}/screenshots/' + t.id + '.png';`,
          `  const prompt = ['You are a Visual QA judge. Use the Read tool to open the screenshot image file at ' + localShot + ' and inspect it.', 'Test expectation: ' + (t.expect || ''), '', 'Reply on ONE line in this exact format:', 'VERDICT: PASS|FAIL|UNCERTAIN — <one-line rationale>', '', 'Use UNCERTAIN only if the image file is missing or genuinely ambiguous.'].join('\\n');`,
          `  const child = spawn('claude', ['-p', prompt, '--model', model, '--output-format', 'text', '--allowedTools', 'Read'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: wallclockMs });`,
          `  let out = '';`,
          `  child.stdout.on('data', d => { out += d.toString(); });`,
          `  let killed = false;`,
          `  const killer = setTimeout(() => { killed = true; child.kill('SIGTERM'); }, wallclockMs);`,
          `  child.on('close', (code) => {`,
          `    clearTimeout(killer);`,
          `    if (killed) { resolve({ testId: t.id, level: 'L1', verdict: 'uncertain', rationale: 'wallclock budget exceeded', screenshotUrl, costUsd: 0, durationMs: Date.now() - start }); return; }`,
          `    const m = out.match(/VERDICT:\\s*(PASS|FAIL|UNCERTAIN)\\s*[—-]?\\s*(.*)/i);`,
          `    if (!m) { resolve({ testId: t.id, level: 'L1', verdict: 'errored', rationale: 'judge output unparseable', screenshotUrl, costUsd: 0, durationMs: Date.now() - start }); return; }`,
          `    const verdictRaw = m[1].toLowerCase();`,
          `    const verdict = verdictRaw === 'pass' ? 'pass' : verdictRaw === 'fail' ? 'fail' : 'uncertain';`,
          `    resolve({ testId: t.id, level: 'L1', verdict, rationale: (m[2] || '').slice(0, 200), screenshotUrl, costUsd: (t.budgetCostUsd ?? defaultCostUsd), durationMs: Date.now() - start });`,
          `  });`,
          `  child.on('error', () => { clearTimeout(killer); resolve({ testId: t.id, level: 'L1', verdict: 'errored', rationale: 'spawn error', screenshotUrl, costUsd: 0, durationMs: Date.now() - start }); });`,
          `}); }`,
          `(async () => {`,
          `  const results = [];`,
          `  let runningCost = 0;`,
          `  for (let i = 0; i < tests.length; i += 5) {`,
          `    const batch = tests.slice(i, i + 5);`,
          `    if (planBudgetUsd > 0 && runningCost >= planBudgetUsd) {`,
          `      // Plan budget exhausted — mark remainder as skipped.`,
          `      for (const t of batch) {`,
          `        results.push({ testId: t.id, level: 'L1', verdict: 'skipped-budget', rationale: 'plan cost ceiling reached', screenshotUrl: cdnPrefix + t.id + '.png', costUsd: 0, durationMs: 0 });`,
          `      }`,
          `      continue;`,
          `    }`,
          `    const batchResults = await Promise.all(batch.map(judgeOne));`,
          `    for (const r of batchResults) runningCost += (r.costUsd || 0);`,
          `    results.push(...batchResults);`,
          `  }`,
          `  fs.writeFileSync('${tmpResultsDir}/l1-results.json', JSON.stringify(results));`,
          `  console.log('L1_RESULTS: ' + JSON.stringify(results));`,
          `})();`,
          `NODE_EOF`,
          `)"`,
        ].join('\n'),
        // Generous total budget: 90s per test × parallelism factor 5.
        timeout: Math.max(60000, l1Tests.length * 30000),
        captureAs: 'L1_OUTPUT',
        extractors: {
          L1_RESULTS: {
            type: 'regex',
            pattern: 'L1_RESULTS:\\s*(\\[[\\s\\S]*?\\])',
          },
        },
        onFail: { action: 'fail', injectAs: 'L1_ERROR' },
      },

      // ── 4. qa-judge-l2 — Sonnet per-test, sequential ──
      // Sequential because Playwright flows can race if interleaved.
      // Q5.1 + Q5.2 budget enforcement matches qa-judge-l1.
      {
        id: 'qa-judge-l2',
        stepType: 'shell',
        command: [
          `node -e "$(cat <<'NODE_EOF'`,
          `const { spawn } = require('child_process');`,
          `const fs = require('fs');`,
          `const tests = ${l2Json};`,
          `const cdnPrefix = '${cdnPrefix}';`,
          `const model = '${QA_LEVEL_DEFAULTS.L2.model}';`,
          `const defaultWallclockMs = ${QA_LEVEL_DEFAULTS.L2.wallclockSec * 1000};`,
          `const defaultCostUsd = ${QA_LEVEL_DEFAULTS.L2.costUsd};`,
          `const planBudgetUsd = ${plan.qaCostBudgetUsd ?? 0};`,
          `// L1 results' cost contributes to the running plan budget — load it.`,
          `let runningCost = 0;`,
          `try { const l1 = JSON.parse(fs.readFileSync('${tmpResultsDir}/l1-results.json', 'utf8')); runningCost = l1.reduce((s, r) => s + (r.costUsd || 0), 0); } catch {}`,
          `function judgeOne(t) { return new Promise((resolve) => {`,
          `  const start = Date.now();`,
          `  const wallclockMs = (t.budgetWallclockSec ? t.budgetWallclockSec * 1000 : defaultWallclockMs);`,
          `  const screenshotUrl = cdnPrefix + t.id + '.png';`,
          // 2026-06-01 — judge reads LOCAL screenshot files via the Read tool
          // (sandbox can't fetch the CDN URL). Flow shots + the base shot map to
          // their on-disk paths; screenshotUrl stays for the gallery link.
          `  const shotDir = '${tmpResultsDir}/screenshots/';`,
          `  const flowShots = (t.flow || []).filter(s => s.action === 'screenshot').map(s => shotDir + t.id + '-' + (s.label || 'shot') + '.png');`,
          `  const allShots = flowShots.length > 0 ? flowShots : [shotDir + t.id + '.png'];`,
          `  const judgeText = t.judge || ('Test expectation: ' + (t.expect || ''));`,
          `  const prompt = ['You are a Visual QA judge for a multi-screenshot behavioral test.', 'Use the Read tool to open each of these screenshot image files in order:', allShots.map((u, i) => '  ' + (i + 1) + '. ' + u).join('\\n'), '', judgeText, '', 'Reply on ONE line in this exact format:', 'VERDICT: PASS|FAIL|UNCERTAIN — <one-line rationale>', '', 'Use UNCERTAIN only if an image file is missing or genuinely ambiguous.'].join('\\n');`,
          `  const child = spawn('claude', ['-p', prompt, '--model', model, '--output-format', 'text', '--allowedTools', 'Read'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: wallclockMs });`,
          `  let out = '';`,
          `  child.stdout.on('data', d => { out += d.toString(); });`,
          `  let killed = false;`,
          `  const killer = setTimeout(() => { killed = true; child.kill('SIGTERM'); }, wallclockMs);`,
          `  child.on('close', (code) => {`,
          `    clearTimeout(killer);`,
          `    if (killed) { resolve({ testId: t.id, level: 'L2', verdict: 'uncertain', rationale: 'wallclock budget exceeded', screenshotUrl, costUsd: 0, durationMs: Date.now() - start }); return; }`,
          `    const m = out.match(/VERDICT:\\s*(PASS|FAIL|UNCERTAIN)\\s*[—-]?\\s*(.*)/i);`,
          `    if (!m) { resolve({ testId: t.id, level: 'L2', verdict: 'errored', rationale: 'judge output unparseable', screenshotUrl, costUsd: 0, durationMs: Date.now() - start }); return; }`,
          `    const verdictRaw = m[1].toLowerCase();`,
          `    const verdict = verdictRaw === 'pass' ? 'pass' : verdictRaw === 'fail' ? 'fail' : 'uncertain';`,
          `    resolve({ testId: t.id, level: 'L2', verdict, rationale: (m[2] || '').slice(0, 200), screenshotUrl, costUsd: (t.budgetCostUsd ?? defaultCostUsd), durationMs: Date.now() - start });`,
          `  });`,
          `  child.on('error', () => { clearTimeout(killer); resolve({ testId: t.id, level: 'L2', verdict: 'errored', rationale: 'spawn error', screenshotUrl, costUsd: 0, durationMs: Date.now() - start }); });`,
          `}); }`,
          `(async () => {`,
          `  const results = [];`,
          `  for (const t of tests) {`,
          `    if (planBudgetUsd > 0 && runningCost >= planBudgetUsd) {`,
          `      results.push({ testId: t.id, level: 'L2', verdict: 'skipped-budget', rationale: 'plan cost ceiling reached', screenshotUrl: cdnPrefix + t.id + '.png', costUsd: 0, durationMs: 0 });`,
          `      continue;`,
          `    }`,
          `    const r = await judgeOne(t);`,
          `    runningCost += (r.costUsd || 0);`,
          `    results.push(r);`,
          `  }`,
          `  fs.writeFileSync('${tmpResultsDir}/l2-results.json', JSON.stringify(results));`,
          `  console.log('L2_RESULTS: ' + JSON.stringify(results));`,
          `})();`,
          `NODE_EOF`,
          `)"`,
        ].join('\n'),
        timeout: Math.max(60000, l2Tests.length * 120000),
        captureAs: 'L2_OUTPUT',
        extractors: {
          L2_RESULTS: {
            type: 'regex',
            pattern: 'L2_RESULTS:\\s*(\\[[\\s\\S]*?\\])',
          },
        },
        onFail: { action: 'fail', injectAs: 'L2_ERROR' },
      },

      // ── 5. qa-report — aggregate per-test results ──
      {
        id: 'qa-report',
        stepType: 'shell',
        command: [
          `node -e "$(cat <<'NODE_EOF'`,
          `const fs = require('fs');`,
          `function load(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } }`,
          `const results = [`,
          `  ...load('${tmpResultsDir}/l0-results.json'),`,
          `  ...load('${tmpResultsDir}/l1-results.json'),`,
          `  ...load('${tmpResultsDir}/l2-results.json'),`,
          `];`,
          `let pass = 0, fail = 0, uncertain = 0, errored = 0;`,
          `for (const r of results) {`,
          `  if (r.verdict === 'pass') pass++;`,
          `  else if (r.verdict === 'fail') fail++;`,
          `  else if (r.verdict === 'uncertain') uncertain++;`,
          `  else errored++;`,
          `}`,
          `const cost = results.reduce((s, r) => s + (r.costUsd || 0), 0);`,
          `const wallclock = results.reduce((s, r) => s + (r.durationMs || 0), 0) / 1000;`,
          `const failedTests = results.filter(r => r.verdict === 'fail').map(r => r.testId).join(',');`,
          `const overall = fail > 0 ? 'FAIL' : (uncertain > 0 || errored > 0) ? 'PARTIAL' : 'PASS';`,
          `const screenshots = results.map(r => '- ' + r.testId + ': ' + (r.screenshotUrl || '')).join('\\n');`,
          `console.log('---QA_REPORT---');`,
          `console.log('OVERALL_VERDICT: ' + overall);`,
          `console.log('OVERVIEW_URL: ${cdnPrefix}overview.png');`,
          `console.log('TOTAL_PASS: ' + pass);`,
          `console.log('TOTAL_FAIL: ' + fail);`,
          `console.log('TOTAL_UNCERTAIN: ' + uncertain);`,
          `console.log('TOTAL_ERRORED: ' + errored);`,
          `console.log('COST_USD: ' + cost.toFixed(4));`,
          `console.log('WALLCLOCK_SEC: ' + wallclock.toFixed(1));`,
          `console.log('FAILED_TESTS: ' + (failedTests || 'none'));`,
          `console.log('SCREENSHOTS:');`,
          `console.log(screenshots);`,
          `console.log('TEST_RESULTS: ' + JSON.stringify(results));`,
          `console.log('---END_QA_REPORT---');`,
          `NODE_EOF`,
          `)"`,
        ].join('\n'),
        timeout: 30000,
        captureAs: 'REPORT_OUTPUT',
        extractors: {
          QA_REPORT: {
            type: 'between',
            startDelimiter: '---QA_REPORT---',
            endDelimiter: '---END_QA_REPORT---',
          },
          OVERALL_VERDICT: {
            type: 'regex',
            pattern: 'OVERALL_VERDICT:\\s*(PASS|FAIL|PARTIAL)',
          },
          OVERVIEW_URL: {
            type: 'regex',
            pattern: 'OVERVIEW_URL:\\s*(https?://[^\\s*_`]+)',
          },
          TOTAL_PASS: { type: 'regex', pattern: 'TOTAL_PASS:\\s*(\\d+)' },
          TOTAL_FAIL: { type: 'regex', pattern: 'TOTAL_FAIL:\\s*(\\d+)' },
          TOTAL_UNCERTAIN: {
            type: 'regex',
            pattern: 'TOTAL_UNCERTAIN:\\s*(\\d+)',
          },
          TOTAL_ERRORED: {
            type: 'regex',
            pattern: 'TOTAL_ERRORED:\\s*(\\d+)',
          },
          COST_USD: { type: 'regex', pattern: 'COST_USD:\\s*([\\d.]+)' },
          WALLCLOCK_SEC: {
            type: 'regex',
            pattern: 'WALLCLOCK_SEC:\\s*([\\d.]+)',
          },
          SCREENSHOTS: {
            type: 'between',
            startDelimiter: 'SCREENSHOTS:',
            endDelimiter: 'TEST_RESULTS:',
          },
          FAILED_TESTS: {
            type: 'regex',
            pattern: 'FAILED_TESTS:\\s*([^\\n]+)',
          },
          TEST_RESULTS: {
            type: 'regex',
            pattern: 'TEST_RESULTS:\\s*(\\[[\\s\\S]*?\\])',
          },
        },
      },

      // ── 6. qa-cleanup — kill dev server ──
      {
        id: 'qa-cleanup',
        stepType: 'shell',
        command: [
          // PR-59 — port is whatever qa-prepare wrote; fallback to the
          // pipeline default if the file is missing (qa-prepare crashed
          // before writing it).
          `QA_PORT=$(cat ${tmpResultsDir}/qa-port.txt 2>/dev/null || echo ${port})`,
          `kill $(lsof -ti:$QA_PORT) 2>/dev/null || true`,
          `# Archive logs to S3 for post-mortem`,
          `aws s3 cp ${tmpResultsDir}/devserver.log s3://futurator-ai-website/${snapshotPrefix}devserver.log --content-type text/plain > /dev/null 2>&1 || true`,
          `aws s3 cp ${tmpResultsDir}/console-errors.log s3://futurator-ai-website/${snapshotPrefix}console-errors.log --content-type text/plain > /dev/null 2>&1 || true`,
          `echo "QA_CLEANUP_OK"`,
        ].join('\n'),
        timeout: 30000,
      },
    ],
  };
}

// ── Legacy entrypoint (preserved for /api/epic-workflows/:id/visual-qa) ──

/**
 * Pre-PR-8 single-epic builder. Kept so the legacy
 * `/api/epic-workflows/:id/visual-qa` route doesn't break during the
 * UI cutover. New code paths must use `buildQaAggregatePipeline` +
 * `buildQaExecutePipeline`.
 *
 * @deprecated Use `buildQaAggregatePipeline` + `buildQaExecutePipeline`.
 */
export function buildQaPipeline(
  workingDir: string,
  epicTitle: string,
  viewport: string,
  allVisualTests: {
    id: string;
    description: string;
    setup: string;
    action?: string;
    expect: string;
    storyTitle: string;
  }[],
  snapshotPrefix: string,
  port: number = DEFAULT_QA_PORT,
): PipelineDefinition {
  const testSummary = allVisualTests
    .map((t) => `- ${t.id}: ${t.description} (expect: ${t.expect})`)
    .join('\n');
  return {
    maxIterations: 1,
    agents: {
      // PR-32 — QA policy resolved from RolePolicy. The resolver adds the
      // PR-3 baseline deny (Task,Agent,WebFetch,WebSearch) which the
      // hand-written declaration lacked. Same allowlist as before.
      QA: buildAgentConfig({
        boilerplateKind: 'nextjs-base',
        rigor: 'mvp',
        role: 'QA',
        name: 'Visual QA Tester',
        model: 'sonnet',
      }),
    },
    steps: [
      {
        id: 'qa-start-server',
        stepType: 'shell',
        command: `kill $(lsof -ti:${port}) 2>/dev/null; sleep 1; cd ${workingDir} && (nohup npm run dev -- --host 0.0.0.0 --port ${port} > /tmp/qa-devserver-${port}.log 2>&1 </dev/null &); STATUS=000; for i in $(seq 1 20); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port} 2>/dev/null); [ "$STATUS" = "200" ] && break; done; [ "$STATUS" = "200" ]`,
        timeout: 45000,
        captureAs: 'SERVER_STATUS',
        onFail: { action: 'fail', injectAs: 'SERVER_ERROR' },
      },
      {
        id: 'qa-evaluate',
        agentId: 'QA',
        prompt: `You are a headless Visual QA Tester for "${epicTitle}" running at http://localhost:${port} (viewport ${viewport}).

Run through these visual tests, take screenshots, upload to S3, emit a QA_REPORT block.

${testSummary}

Output:
---QA_REPORT---
OVERALL_VERDICT: PASS or FAIL
OVERVIEW_URL: https://futurator.ai/${snapshotPrefix}overview.png
SCREENSHOTS:
${allVisualTests.map((t) => `- ${t.id}: https://futurator.ai/${snapshotPrefix}${t.id}.png`).join('\n')}
RESULTS:
${allVisualTests.map((t) => `- ${t.id}: PASS or FAIL — [observation]`).join('\n')}
FAILED_TESTS:
[comma-separated IDs or "none"]
---END_QA_REPORT---`,
        extractors: {
          QA_REPORT: {
            type: 'between',
            startDelimiter: '---QA_REPORT---',
            endDelimiter: '---END_QA_REPORT---',
          },
          OVERALL_VERDICT: {
            type: 'regex',
            pattern: '[*_`]*OVERALL_VERDICT[*_`]*:\\s*[*_`]*\\s*(PASS|FAIL)',
          },
          OVERVIEW_URL: {
            type: 'regex',
            pattern: '[*_`]*OVERVIEW_URL[*_`]*:\\s*(https?://[^\\s*_`]+)',
          },
          SCREENSHOTS: {
            type: 'between',
            startDelimiter: 'SCREENSHOTS:',
            endDelimiter: 'RESULTS:',
          },
          FAILED_TESTS: {
            type: 'regex',
            pattern: '[*_`]*FAILED_TESTS[*_`]*:\\s*([\\s\\S]*?)(?:\\n\\n|\\nOBSERVATIONS:|---END)',
          },
        },
        validations: [],
      },
      {
        id: 'qa-stop-server',
        stepType: 'shell',
        command: `kill $(lsof -ti:${port}) 2>/dev/null; echo "Server on ${port} stopped"`,
        timeout: 5000,
      },
    ],
  };
}
