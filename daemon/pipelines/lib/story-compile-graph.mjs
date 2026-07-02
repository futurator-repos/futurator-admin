// story-compile-graph — G3 (Pipeline-3 parity): fire-and-forget COMPILE phase
// after a GREEN story so the real **code knowledge graph** grows.
//
// This is the P3 story-path analogue of the epic/orchestrator COMPILE phase.
// The legacy plan-reducer/orchestrator never runs on the P3 per-story path, so
// nothing was re-embedding the graph after each story. Without this, the
// Development → Graph tab (fed by `knowledge-live/<appId>/_graph/graph-snapshot.json`)
// stayed frozen at the last wave/epic compile — it never GREW per story.
//
// We reuse the SAME 3-step COMPILE definition the epic path uses
// (compile-pipeline.mjs `getCompileSteps` / `getCompilerAgent`), running only:
//   diff-extract  → git HEAD~1..HEAD diff → DIFF_MANIFEST      (shell)
//   compile-knowledge → Knowledge Compiler writes/updates code/ wiki articles (agent)
//   embed-sync    → graph-sync.mjs → Voyage embed + Memgraph upsert +
//                   knowledge/_graph/graph-snapshot.json + S3 backup          (shell)
//
// The per-story git commit (compile-commit-on-pass) and the origin push
// (compile-push) are deliberately SKIPPED: INT already committed this story via
// integrateStory (that commit's SHA is `headSha`, so HEAD~1..HEAD scopes to
// exactly this story), and re-running the commit step would fail the
// non-empty-diff guard.
//
// NON-BLOCKING by contract: this is invoked `.catch(() => {})` from the daemon
// and must NEVER throw or reject in a way that affects the story verdict. Every
// error is swallowed and surfaced only on the returned `reason`.

import { spawn as realSpawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompileSteps, getCompilerAgent } from '../compile-pipeline.mjs';

// The 3 COMPILE steps we run on the per-story path (in execution order). We omit
// compile-commit-on-pass (INT already committed) and compile-push (wave/epic
// path owns origin pushes).
const STORY_COMPILE_STEP_IDS = ['compile-diff', 'compile-knowledge', 'compile-sync'];

/**
 * Run one child process to completion, collecting stdout/stderr. Resolves (never
 * rejects) with { code, stdout, stderr, timedOut }. Honors an optional timeout by
 * killing the child and resolving with timedOut:true.
 */
function runProc(spawn, file, args, { cwd, env, timeout } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, timedOut });
    };
    child.stdout?.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => { stderr += String(err?.message || err); finish(-1); });
    child.on('close', (code) => finish(code));
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
        finish(-1, true);
      }, timeout);
    }
  });
}

/**
 * W1.2 (P3_SEMANTIC_COMPILE) — run ts-morph `semantic-extract.mjs` and write its
 * cross-file CALLS/RENDERS facts to `.mycelium/semantic-facts.json` so the very
 * next `compile-sync` (graph-sync's `processSystemGraphFacts`) ingests real
 * symbol-level dependency edges — which per-story tree-sitter (same-file only)
 * misses. Isolated in its own try/catch: a ts-morph failure must NEVER abort the
 * graph sync. `on` = every story; `cohort` = only the last story of a cohort
 * (ts-morph loads the whole TS program, so cohort-close is the cheaper default).
 */
/** Pure gate: does P3_SEMANTIC_COMPILE fire this cycle? Default 'off' → never. */
export function shouldRunSemantic(semanticCompile, isCohortClose) {
  return semanticCompile === 'on' || (semanticCompile === 'cohort' && !!isCohortClose);
}

async function maybeRunSemanticExtract({ spawn, workingDir, semanticCompile, isCohortClose, timeout, log, warn }) {
  if (!shouldRunSemantic(semanticCompile, isCohortClose)) return;
  try {
    const script = fileURLToPath(new URL('../../scripts/semantic-extract.mjs', import.meta.url));
    const { code, stdout, stderr, timedOut } = await runProc(
      spawn,
      process.execPath,
      [script, '--root', workingDir],
      { cwd: workingDir, timeout: timeout || 300_000 },
    );
    if (code !== 0 || !stdout.trim()) {
      warn(`semantic-extract exit ${code}${timedOut ? ' (timeout)' : ''}${stderr ? `: ${stderr.slice(0, 200)}` : ''} — skipping semantic facts`);
      return;
    }
    const outDir = join(workingDir, '.mycelium');
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'semantic-facts.json'), stdout, 'utf-8');
    log(`semantic-extract wrote ${stdout.length}B of cross-file facts (mode=${semanticCompile})`);
  } catch (err) {
    warn(`semantic-extract failed (non-blocking): ${err?.message || err}`);
  }
}

/** Read { nodeCount, edgeCount, generatedAt } from the graph snapshot, or null if absent/unreadable. */
async function readSnapshotStats(snapshotPath) {
  try {
    const raw = await readFile(snapshotPath, 'utf-8');
    const doc = JSON.parse(raw);
    return {
      nodeCount: typeof doc.nodeCount === 'number' ? doc.nodeCount : (Array.isArray(doc.nodes) ? doc.nodes.length : 0),
      edgeCount: typeof doc.edgeCount === 'number' ? doc.edgeCount : (Array.isArray(doc.edges) ? doc.edges.length : 0),
      generatedAt: doc.generatedAt || null,
    };
  } catch {
    return null;
  }
}

/** Build the claude CLI args for the COMPILER agent step (haiku, tight tool policy). */
function buildCompilerArgs(prompt, compilerCfg) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];
  if (compilerCfg.allowedTools) args.push('--allowedTools', compilerCfg.allowedTools);
  if (compilerCfg.disallowedTools) args.push('--disallowedTools', compilerCfg.disallowedTools);
  if (compilerCfg.model) args.push('--model', compilerCfg.model);
  return args;
}

/**
 * Fire-and-forget COMPILE phase for one green story. Grows the code knowledge
 * graph and refreshes knowledge/_graph/graph-snapshot.json (the Graph tab's data
 * source). Non-blocking; swallows all errors.
 *
 * @param {object} opts
 * @param {string} opts.projectId   — canonical app slug (S3/graph partition, e.g. "spyhunter")
 * @param {string} opts.workingDir  — absolute path to the project workspace
 * @param {string} opts.storyId     — the just-completed story id (frontmatter context)
 * @param {string} opts.planId      — used as the epicId context for the compiler
 * @param {string} [opts.headSha]   — story's integrate commit (HEAD~1..HEAD scopes the diff)
 * @param {string} [opts.rigor]     — mvp | prototype | … (threaded to getCompileSteps)
 * @param {string[]} [opts.loadedSkills] — skills loaded by the dev agent (commit-flag context)
 * @param {object} opts.deps        — { spawn, claudeBin, logger }
 * @returns {Promise<{ ran: boolean, graphUpdated?: boolean, reason?: string }>}
 */
export async function runStoryCompileGraph({
  projectId,
  workingDir,
  storyId,
  planId,
  headSha,
  rigor = 'mvp',
  loadedSkills = [],
  // W1.2 — P3_SEMANTIC_COMPILE ('off'|'cohort'|'on'), resolved by the caller.
  // `isCohortClose` lets 'cohort' mode fire only on the last story of a cohort.
  semanticCompile = 'off',
  isCohortClose = false,
  deps = {},
} = {}) {
  const spawn = deps.spawn || realSpawn;
  const logger = deps.logger || console;
  const claudeBin = deps.claudeBin || 'claude';
  const log = (m) => { try { logger.info?.(`[story-compile] ${m}`); } catch { /* ignore */ } };
  const warn = (m) => { try { logger.warn?.(`[story-compile] ${m}`); } catch { /* ignore */ } };

  if (!projectId || !workingDir) {
    return { ran: false, reason: 'missing projectId/workingDir' };
  }

  try {
    const knowledgeDir = join(workingDir, 'knowledge');
    const snapshotPath = join(knowledgeDir, '_graph', 'graph-snapshot.json');
    const before = await readSnapshotStats(snapshotPath);

    // Reuse the epic path's COMPILE step definitions verbatim so the per-story
    // compile stays byte-identical to production (compiler prompt, graph-sync
    // invocation, S3 mirror). We only run a subset of them (see above).
    const allSteps = getCompileSteps(
      projectId,
      workingDir,
      planId || '(story)',
      storyId,
      { title: storyId, epicTitle: planId || '(plan)' },
      { rigor, loadedSkills },
    );
    const byId = new Map(allSteps.map((s) => [s.id, s]));
    const compilerCfg = getCompilerAgent().COMPILER;

    let diffManifest = '';
    log(`compile phase for story=${storyId} project=${projectId} headSha=${headSha || '(none)'}`);

    for (const stepId of STORY_COMPILE_STEP_IDS) {
      const step = byId.get(stepId);
      if (!step) continue;

      // Materialize cross-file semantic facts immediately BEFORE the graph sync
      // so they're ingested in the same cycle (dark unless P3_SEMANTIC_COMPILE on).
      if (stepId === 'compile-sync') {
        await maybeRunSemanticExtract({
          spawn, workingDir, semanticCompile, isCohortClose, timeout: step.timeout, log, warn,
        });
      }

      if (step.stepType === 'agent') {
        // compile-knowledge — inject the captured diff + a work summary into the
        // compiler prompt, then spawn the COMPILER (haiku).
        const prompt = String(step.prompt || '')
          .replace('{{DIFF_MANIFEST}}', diffManifest || '(no diff captured)')
          .replace('{{WORK_SUMMARY}}', `Story ${storyId} completed on plan ${planId || ''} (commit ${headSha || 'HEAD'}).`);
        const args = buildCompilerArgs(prompt, compilerCfg);
        const { code, timedOut } = await runProc(spawn, claudeBin, args, {
          cwd: workingDir,
          timeout: step.timeout,
        });
        if (code !== 0) {
          warn(`compile-knowledge exit ${code}${timedOut ? ' (timeout)' : ''} — continuing to sync`);
        }
      } else {
        // shell step (compile-diff / compile-sync) — run its command verbatim.
        const { code, stdout, stderr, timedOut } = await runProc(spawn, '/bin/sh', ['-c', step.command], {
          cwd: workingDir,
          timeout: step.timeout,
        });
        if (stepId === 'compile-diff') diffManifest = stdout;
        if (code !== 0) {
          warn(`${stepId} exit ${code}${timedOut ? ' (timeout)' : ''}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`);
          // A failed embed-sync means the graph didn't grow this cycle. Bail with
          // a reason rather than mislabelling graphUpdated.
          if (stepId === 'compile-sync') {
            return { ran: true, graphUpdated: false, reason: `compile-sync exit ${code}` };
          }
        }
      }
    }

    const after = await readSnapshotStats(snapshotPath);
    // graphUpdated = graph-sync (re)wrote the snapshot this cycle. Newly created,
    // or a fresh generatedAt, or a grown node/edge count all count as "updated".
    const graphUpdated =
      !!after &&
      (
        before == null ||
        after.generatedAt !== before.generatedAt ||
        after.nodeCount > before.nodeCount ||
        after.edgeCount > before.edgeCount
      );

    if (after) {
      log(`graph ${graphUpdated ? 'updated' : 'unchanged'}: ${after.nodeCount} nodes, ${after.edgeCount} edges`);
    } else {
      log('graph snapshot not found after sync (Memgraph unavailable?) — non-blocking');
    }

    return { ran: true, graphUpdated, reason: after ? undefined : 'no-snapshot' };
  } catch (err) {
    // Absolute backstop — the compile phase can NEVER surface an error to the
    // story verdict. Swallow and report on `reason`.
    warn(`compile phase failed (non-blocking): ${err?.message || err}`);
    return { ran: false, reason: String(err?.message || err) };
  }
}
