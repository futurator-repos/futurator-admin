// story-dev-pipeline — run ONE Claude for ONE story (development-plan §4 Dev stage).
//
// The Pipeline-3 execution unit: a single agent scoped to the story's `touches`,
// under the live gate, lazy-injected, model-routed — NOT an orchestrator managing
// waves. Because it's one story per spawn, the gate gets real PER-STORY scope
// (touchPoints = the story's touches, forbiddenAreas = its dev contract), the
// precision the plan otherwise deferred to a worktree policy file.
//
// On exit it computes the deterministic completion verdict (bound-AC gate) and
// updates the StoryNode lifecycle. Spawn + ddb are injected so the orchestration
// unit-tests without infrastructure.

import { spawn as realSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerChild, unregisterChild } from './lib/child-tracker.mjs';
import { freezeFlagsOntoJob, flagMode } from '../lib/pipeline-flags.mjs';
import { buildGateSpawn } from '../lib/gate-settings.mjs';
import { handleStoryCompletion } from '../lib/story-completion-handler.mjs';
// Reality-Spine P1/P2 (redesign Part 2, Part 5 #2/#3): foundation-story hardened
// gate (tsc+build+boot-liveness) and per-story green-trunk check. Both PURE
// classifiers live in foundation-gate.mjs; the actual gate functions are
// injected via deps (S7's makeStoryDevGateDeps factory) so this module never
// spawns tsc/build/playwright itself — it only decides WHEN to call them.
import { isFoundationStory } from '../lib/foundation-gate.mjs';
import { integrateStory } from '../lib/story-integrate.mjs';
import { extractAssistantText } from '../lib/stream-json-text.mjs';
import { planBranchName } from '../lib/plan-branch.mjs';
import { runStoryBindings } from '../lib/test-binding-runner.mjs';
import { detectTestTampering } from '../lib/tdd-gates.mjs';
// W2.2 (P3_TEST_AUTHOR_SPLIT) — isolated Test-Author phase + implementer prompt.
import { runTestAuthorPhase, buildImplementerPrompt, parsePorcelainTestFiles } from './lib/test-author-phase.mjs';
// Model/effort per agent (adaptive thinking): dev scales with story complexity,
// test-author thinks hard (tests carry the spec). Env/plan overrides inside.
import { resolveAgentPolicy, cliModelArgs } from '../lib/model-effort-policy.mjs';
// P3-parity glue (INT wiring): streaming events, skills injection/commit trailer,
// bounded fix-forward retry. buildSubagentInjectionArgs is now folded into
// buildSkillsInjection (single --append-system-prompt), so it is no longer
// imported directly here.
import {
  createStoryEventStream,
  STORY_DEV_STEP_ID,
  STORY_DEV_AGENT_ID,
} from './lib/story-dev-events.mjs';
import {
  buildSkillsInjection,
  trackSkillActivations,
  buildStoryCommitFlags,
  resetStorySkills,
  readStoryLoadedSkills,
} from './lib/story-skills-inject.mjs';
import {
  buildPriorFailureBlock,
  classifyRetryable,
  shouldRetry,
} from './lib/story-retry.mjs';

/**
 * Render one AC line with its verification semantics. A behavior/needsBrowser AC
 * is app-level: it MUST be bound testKind:'browser' (the browser probe executor
 * drives the real app via window.__harness by reading its when/thenObservable
 * prose). Surfacing verify/needsBrowser/when/thenObservable per AC is what lets the
 * agent bind correctly — the completion gate REJECTS a unit/manual binding here.
 */
function renderAcLine(ac, i) {
  const browser = ac.verify === 'behavior' || ac.needsBrowser === true;
  const tags = [
    ac.acClass ? ac.acClass : null,
    ac.verify ? `verify:${ac.verify}` : null,
    browser ? 'needsBrowser:true → MUST bind testKind:browser' : null,
  ].filter(Boolean).join(', ');
  const probe = browser && (ac.when || ac.thenObservable)
    ? `\n     when: ${ac.when || '(unspecified)'} → thenObservable: ${ac.thenObservable || '(unspecified)'}`
    : '';
  return `  ${i + 1}. [${ac.id}] ${ac.text}${tags ? ` (${tags})` : ''}${probe}`;
}

/**
 * Render the invariant-authoring block (redesign Part 4). Invariants are
 * domain properties the PLANNER declared ("every declared navigation target
 * resolves", "seed data satisfies the schema") — the story must author an
 * EXECUTABLE validator per invariant; the gate (test-binding-runner's
 * runStoryInvariants) runs it deterministically. PURE — empty string when the
 * story carries no invariants (byte-identical prompt for non-invariant stories).
 */
function renderInvariantsBlock(invariants) {
  if (!Array.isArray(invariants) || !invariants.length) return '';
  const declared = invariants
    .map((inv, i) => `  ${i + 1}. [${inv.id}] ${inv.description}`)
    .join('\n');
  const manifestFields = invariants
    .map((inv) => `"${inv.id}": { "ref": "<path-or-selector>", "kind": "script|test" }`)
    .join(', ');
  return [
    '',
    '# Invariant validators (MANDATORY — the gate executes these deterministically)',
    'This story declares invariants: properties of the domain data/contract that MUST',
    'hold. For EACH one below you MUST author an EXECUTABLE validator:',
    '  - scripts/invariants/<id>.mjs — standalone, node-runnable, imports the REAL',
    '    module/data under test, exits non-zero on violation; OR',
    '  - src/**/<id>.invariant.test.ts — a vitest file importing the REAL module.',
    'Either form MUST NOT use vi.mock(/jest.mock( of any in-repo module — a mocked',
    'validator proves nothing and the gate treats it as a failing invariant.',
    '',
    'Declared invariants:',
    declared,
    '',
    'When done, emit a manifest mapping each invariant id to its authored validator:',
    '<INVARIANTS>',
    `{ ${manifestFields} }`,
    '</INVARIANTS>',
    '',
    'You MAY write and run throwaway validators for any data you author; validators',
    'for DECLARED invariants above are MANDATORY and WILL be executed by the gate.',
  ].join('\n');
}

/** Build the single-story dev prompt. PURE. Requires the agent to emit <BINDING>. */
export function buildStoryDevPrompt(payload) {
  const acLines = (payload.acceptanceCriteria || [])
    .map((ac, i) => renderAcLine(ac, i))
    .join('\n');
  return [
    `You are implementing ONE story in an automated spec-driven pipeline.`,
    ``,
    `# Story: ${payload.title}`,
    payload.intent ? `Intent: ${payload.intent}` : '',
    ``,
    `# Acceptance criteria (the spec — implement the minimum that makes these pass)`,
    acLines,
    ``,
    `# Scope`,
    `You may ONLY create/modify files matching: ${(payload.touches || []).join(', ')}`,
    `You may NOT touch: ${(payload.forbiddenAreas || []).join(', ') || '(none beyond the defaults)'}`,
    `A live gate enforces this — out-of-scope writes are blocked.`,
    ``,
    `# Required: bind each AC to a test`,
    `When done, emit a manifest mapping each acceptance-criterion id to the test that verifies it:`,
    `<BINDING>`,
    `{ ${(payload.acceptanceCriteria || []).map((ac) => `"${ac.id}": { "testRef": "<test selector>", "testKind": "unit|integration|browser|manual" }`).join(', ')} }`,
    `</BINDING>`,
    ``,
    `# BINDING RULES (the completion gate is deterministic and fails CLOSED)`,
    `- An AC marked verify:'behavior' / needsBrowser:true MUST be bound testKind:'browser'.`,
    `  The browser executor drives the REAL app through window.__harness by reading that`,
    `  AC's when/thenObservable prose — no test file is needed for a browser binding.`,
    `  A mocked-hook unit/integration test does NOT satisfy such an AC and the gate will`,
    `  REJECT a testKind of 'unit'/'integration'/'manual' for it (the story stays not-done).`,
    `- A pure verify:'state'/'build' AC on this slice is legitimately a unit test — bind it`,
    `  testKind:'unit'. Do NOT inflate a pure-function AC to 'browser'.`,
    renderInvariantsBlock(payload.invariants),
    // Bounded fix-forward: on a retry the ONLY new instruction is the real
    // failing-test output from the prior attempt. Scope (touches/forbidden) is
    // unchanged — this is a same-scope re-spawn, not a new story.
    payload.priorFailure
      ? '\n# Prior attempt failed the bound tests — fix ONLY this:\n' + payload.priorFailure
      : '',
  ].filter((l) => l !== '').join('\n');
}

function ensureDir(d) { try { if (!existsSync(d)) mkdirSync(d, { recursive: true }); } catch { /* best-effort */ } }

/**
 * Run a story-dev job end to end.
 *
 * @param {{ job: object, eventLogDir: string, deps?: object }} opts
 *   deps: { spawn, ddb, graphTable, executors, headSha, logger, now,
 *           updateStoryState, propagateCompletion,
 *           foundationGate, greenTrunk, qaContext, buildGateSpawn }
 *     foundationGate/greenTrunk: async fns from
 *     daemon/lib/foundation-gate.mjs::makeStoryDevGateDeps({cwd,spawnSync,qaContext})
 *     — the hardened P1 gate (tsc+build+boot-liveness, foundation stories only)
 *     and the P2 green-trunk check (tsc+build, non-foundation stories) from the
 *     Reality-Spine redesign. Absent (or their flag off) → no-op, byte-identical
 *     to pre-redesign behavior.
 * @returns {Promise<{ exitCode:number, verdict?:object, newState?:string }>}
 */
export async function runStoryDevJob({ job, eventLogDir, deps = {} }) {
  const spawn = deps.spawn || realSpawn;
  const logger = deps.logger || console;
  const claudeBin = deps.claudeBin || 'claude';
  const payload = job.storyDevPayload;
  if (!payload) throw new Error('runStoryDevJob: job.storyDevPayload required');
  const projectRoot = resolve(job.workingDir);

  // Per-story skill isolation — clear any loadout tracked from a prior story so
  // the commit trailer reflects only THIS story's activations.
  resetStorySkills(projectRoot);
  const maxAttempts = deps.maxAttempts ?? 2;
  let attemptsUsed = 0;
  let lastFailureDetail = null;
  let completion = null;
  let headSha = deps.headSha || '';
  let runMetrics = null;
  let exitCode = 0;

  const p3Flags = freezeFlagsOntoJob(job, { env: process.env });
  // Gate-builder seam: injectable so the fail-closed/tamper unit tests can
  // observe the exact scope each spawn runs under (defaults to the real one —
  // byte-identical behavior when not injected).
  const buildGate = deps.buildGateSpawn || buildGateSpawn;
  const gate = buildGate({
    jobId: job.jobId,
    p3Flags,
    // PER-STORY scope — one story per spawn, so the gate enforces exactly this
    // story's touches + forbidden set (no coarse fallback needed here).
    touchPoints: payload.touches || [],
    forbiddenAreas: payload.forbiddenAreas || [],
    ledgerPath: join(projectRoot, '.pipeline', 'gate-events.jsonl'),
    ceilingUsd: payload.costCeilingUsd ?? job.costCeilingUsd,
    harnessCostDir: join(projectRoot, '.pipeline', 'harness-cost'),
    haltDir: projectRoot,
    observeLog: join(projectRoot, '.pipeline', 'observations.jsonl'),
    agentRole: 'story-dev',
  });
  // Single --append-system-prompt: gate injection + the skills PUSH loadout
  // (top-ranked skills' instructions) folded together by the glue. Computed
  // ONCE per story (not per attempt) — the loadout is scope-, not attempt-,
  // dependent.
  const injectionArgs = await buildSkillsInjection({
    workingDir: projectRoot,
    storyText: buildStoryDevPrompt(payload),
    p3Flags,
    role: 'story-dev', // W3.1 — code-producing → PUSH (unchanged default behavior)
  });

  // Stream a "skills loaded" audit signal (mirrors Claude Code's terminal
  // skill-load notice). PUSH-injected skill bodies never fire a `Skill` tool_use
  // event, so without this the operator can only see the loadout post-hoc in the
  // commit trailer — never live. buildSkillsInjection just recorded the pushed
  // set to `.context/loaded-skills.json`, so read it back (no re-rank/re-embed).
  try {
    const loaded = readStoryLoadedSkills(projectRoot);
    if (loaded.length && deps.pushEvent) {
      const names = loaded.map((s) => s.skill).filter(Boolean);
      await deps.pushEvent(job.jobId, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'skill_loaded', {
        text: `loaded ${names.length} skill${names.length === 1 ? '' : 's'}: ${names.join(', ')}`,
        skills: names,
      });
    }
  } catch {
    /* non-blocking telemetry — a missed event never affects the run */
  }

  ensureDir(eventLogDir);
  const stdoutPath = join(eventLogDir, `${job.jobId}.story-dev.stdout.log`);

  // ── W2.2 Test-Author phase (dark unless P3_TEST_AUTHOR_SPLIT=on) ──
  // Precede the implementer with an isolated Test-Author that authors FAILING
  // tests, proves them RED, and commits a `test(): RED` checkpoint. Failure
  // policy is FAIL CLOSED (pacman8 incident, 2026-07-11): the old fall-open to
  // the legacy single-spawn let the implementer author its own tests — the ONE
  // forbidden mechanism in this pipeline. A retried story now RESUMES with its
  // committed tests inside runTestAuthorPhase; a fresh failure gets ONE retry,
  // then the story fails without ever spawning the implementer.
  const splitOn = flagMode(p3Flags, 'P3_TEST_AUTHOR_SPLIT') === 'on';
  let split = null;
  // pacman3 canary fix: the Test-Author writes NEW test files, which are never in
  // the story's `touches` — the shared gate flagged its own work as out-of-scope
  // (audit today; a hard block in enforce). Give it a dedicated gate whose scope
  // additionally allows test files.
  const testAuthorGate = splitOn
    ? buildGate({
        jobId: job.jobId, p3Flags,
        touchPoints: [...(payload.touches || []), '**/*.test.*', '**/*.spec.*'],
        forbiddenAreas: payload.forbiddenAreas || [],
        ledgerPath: join(projectRoot, '.pipeline', 'gate-events.jsonl'),
        ceilingUsd: payload.costCeilingUsd ?? job.costCeilingUsd,
        harnessCostDir: join(projectRoot, '.pipeline', 'harness-cost'),
        haltDir: projectRoot, observeLog: join(projectRoot, '.pipeline', 'observations.jsonl'),
        agentRole: 'test-author',
      })
    : gate;
  // Minimal one-shot spawn (no fix-forward loop) used only by the Test-Author.
  const spawnClaudeOnce = (onePrompt) => new Promise((res) => {
    const oneArgs = [
      '-p', onePrompt, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
      ...cliModelArgs(resolveAgentPolicy({
        role: 'test-author',
        overrides: { model: payload.testModel },
      })),
      ...testAuthorGate.args, ...injectionArgs,
    ];
    let out = '';
    const c = spawn(claudeBin, oneArgs, { cwd: projectRoot, env: { ...process.env, ...testAuthorGate.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (ch) => { out += ch.toString('utf8'); });
    c.on('error', () => res({ exitCode: -1, text: '' }));
    c.on('close', (code) => res({ exitCode: code ?? 0, text: extractAssistantText(out) || out }));
  });
  if (splitOn) {
    // Sub-pipeline visibility: the Test-Author is its own stage in the story
    // timeline (stepId 'test-author'), so the UI can render
    // Test-Author → Implementer → Reviewer → Compile distinctly.
    await deps.pushEvent?.(job.jobId, 'test-author', 'test-author', 'step_start', {
      text: `test-author: writing failing tests for ${payload.storyId}`,
    })?.catch?.(() => {});
    // Fresh call per attempt (same args) — a transient failure (spawn crash,
    // missing <BINDING>, flaky RED run) gets exactly one more chance.
    const runPhase = () =>
      runTestAuthorPhase({
        payload,
        headSha,
        spawnOnce: ({ prompt }) => spawnClaudeOnce(prompt),
        commitRed: async ({ label }) => {
          if (!deps.git) return { committed: false };
          // pacman3 canary fix: the authored tests are NEW files outside the
          // story's `touches`, so staging by touches alone committed 0 test files
          // (no RED audit trail, no tamper baseline). Discover them from git
          // status and stage them explicitly alongside the touches.
          // -uall (pacman1, 2026-07-13): without it git collapses a fully
          // untracked directory to one `?? src/game/` entry, so a foundation
          // story's brand-new test dir yielded 0 matches and no RED commit —
          // -uall lists every untracked FILE individually.
          let authoredTests = [];
          try {
            const st = await deps.git(['status', '--porcelain', '-uall'], projectRoot);
            authoredTests = parsePorcelainTestFiles(st.stdout);
          } catch { /* best-effort — fall back to touches-only staging */ }
          const integ = await integrateStory({
            repoDir: projectRoot,
            touches: [...(payload.touches || []), ...authoredTests],
            storyId: payload.storyId,
            title: label, planBranch: planBranchName(payload.planSlug || payload.planId), git: deps.git,
          });
          let files = authoredTests;
          try {
            if (integ.committed && integ.sha) {
              const d = await deps.git(['diff', '--name-only', `${integ.sha}~1`, integ.sha], projectRoot);
              const committed = String(d.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
              if (committed.length) files = committed;
            }
          } catch { /* keep the status-derived list */ }
          return { committed: integ.committed, sha: integ.sha, files };
        },
        runBindings: ({ acceptanceCriteria, headSha: sha }) =>
          // RED-phase: tests are EXPECTED to fail here (no implementation yet),
          // so no-mock enforcement is off — enforcing it would fail-close a
          // legitimately red run before the implementer ever spawns.
          runStoryBindings({
            acceptanceCriteria, headSha: sha, executors: deps.executors || {}, now: deps.now,
            cwd: projectRoot, enforceNoMock: false,
          }),
        logger,
      });
    try {
      try {
        split = await runPhase();
      } catch (first) {
        logger.warn?.(`[story-dev] ${payload.storyId} test-author phase failed (attempt 1/2) — retrying once: ${first.message}`);
        split = await runPhase();
      }
    } catch (e) {
      // FAIL CLOSED — never the legacy single-spawn (the implementer would
      // author the very tests that judge it; pacman8, 2026-07-11). The story
      // fails here, before any implementer spawn, and fix-forward happens on a
      // later revival through the resume path above.
      const msg = `test-author-failed: ${e.message}`;
      logger.error?.(`[story-dev] ${payload.storyId} test-author failed twice — story fails closed (no single-spawn fallback): ${e.message}`);
      await deps.pushEvent?.(job.jobId, 'test-author', 'test-author', 'step_error', {
        text: 'test-author failed twice — story fails closed; the implementer never authors its own tests',
      })?.catch?.(() => {});
      await deps.updateStoryState?.({ storyId: payload.storyId, state: 'failed', reason: msg });
      return {
        exitCode: 0,
        newState: 'failed',
        verdict: {
          status: 'failing',
          reasons: [msg, 'test-author failed twice — story fails closed; the implementer never authors its own tests'],
        },
        attemptsUsed: 0,
        lastFailureDetail: msg,
      };
    }
    if (split?.redSha) headSha = split.redSha;
    await deps.pushEvent?.(job.jobId, 'test-author', 'test-author', 'step_complete', {
      text: split.resumed
        ? `resume — reusing ${split.ownedTestFiles.length} committed test file(s) from a prior attempt`
        : `RED confirmed — ${split.ownedTestFiles.length} test file(s) committed @${(split.redSha || '').slice(0, 7)}`,
    })?.catch?.(() => {});
  }
  // In the split path the implementer may not write ANY test file via the LIVE
  // gate (deterministic in-turn block, stronger than a post-hoc revert): the
  // authored/owned files by name PLUS the **/*.test.* / **/*.spec.* globs —
  // its <BINDING> comes from the Test-Author, so a NEW implementer-authored
  // test could only ever be self-serving. Built ALWAYS when split ran (even a
  // resume with no derivable owned files); the default `gate` is untouched.
  const implGate = split
    ? buildGate({
        jobId: job.jobId, p3Flags, touchPoints: payload.touches || [],
        forbiddenAreas: [...(payload.forbiddenAreas || []), ...(split.ownedTestFiles || []), '**/*.test.*', '**/*.spec.*'],
        ledgerPath: join(projectRoot, '.pipeline', 'gate-events.jsonl'),
        ceilingUsd: payload.costCeilingUsd ?? job.costCeilingUsd,
        harnessCostDir: join(projectRoot, '.pipeline', 'harness-cost'),
        haltDir: projectRoot, observeLog: join(projectRoot, '.pipeline', 'observations.jsonl'),
        agentRole: 'story-dev',
      })
    : gate;

  // Chip honesty (pacman1, 2026-07-13): the row was written at claim and then
  // only terminally, so the UI read "Claimed" for the story's entire life.
  // Stamp 'developing' once at the first implementer spawn — fire-and-forget;
  // the frontier only claims 'ready' rows, so an intermediate state never
  // affects dispatch.
  try { await deps.updateStoryState?.({ storyId: payload.storyId, state: 'developing' }); }
  catch { /* telemetry-grade — never blocks the story */ }

  // Inline the authored tests into the implementer prompt (pacman1): they ARE
  // the story's spec and are known at spawn time — without this the agent
  // re-opens every test file turn by turn on EVERY attempt. Size-capped and
  // fail-soft: an unreadable/oversized file stays list-only and the agent
  // reads it from disk as before.
  const testContents = {};
  if (split?.ownedTestFiles?.length) {
    let budget = 24_000;
    for (const f of split.ownedTestFiles) {
      try {
        const src = readFileSync(join(projectRoot, f), 'utf8');
        if (src.length <= 8_000 && src.length <= budget) {
          testContents[f] = src;
          budget -= src.length;
        }
      } catch { /* list-only */ }
    }
  }

  // Bounded fix-forward loop (development-plan §4.4). Each attempt re-spawns the
  // SAME-scoped agent; on a failing bound-AC we feed back the REAL failing-test
  // output and re-run the SAME deterministic bound tests (the agent cannot
  // self-pass — testBinding.status is set only by the real executor exit code).
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const pf = attempt > 1 ? buildPriorFailureBlock(completion) : null;
    // Split path: implement against the committed tests (trimmed prompt).
    // Default path: the single untrimmed dev prompt (author + implement).
    const prompt = split
      ? buildImplementerPrompt({ ...payload, priorFailure: pf }, split.ownedTestFiles, testContents)
      : buildStoryDevPrompt({ ...payload, priorFailure: pf });
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      ...cliModelArgs(resolveAgentPolicy({
        role: 'dev',
        complexity: payload.complexity,
        overrides: { model: payload.devModel, effort: payload.devEffort },
      })),
      ...implGate.args,
      ...injectionArgs,
    ];

    logger.info?.(`[story-dev] spawning story=${payload.storyId} attempt=${attempt}/${maxAttempts} touches=[${(payload.touches || []).join(', ')}]` +
      (gate.env.FUTURATOR_GATE_MODE ? ` gate=${gate.env.FUTURATOR_GATE_MODE}` : ''));

    const startedAt = (deps.now?.() ?? Date.now());
    const evstream = createStoryEventStream({
      pushEvent: deps.pushEvent,
      jobId: job.jobId,
      stepId: STORY_DEV_STEP_ID,
      agentId: STORY_DEV_AGENT_ID,
      logger,
    });
    evstream.emitStepStart(`story ${payload.storyId} attempt ${attempt}`);

    const child = spawn(claudeBin, args, {
      cwd: projectRoot,
      env: { ...process.env, ...implGate.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    registerChild(job.jobId, child);

    // extractAssistantText (below) REQUIRES the raw stream-json buffer, so keep
    // accumulating `output` AND feed the same chunk to the live event stream.
    let output = '';
    const outFile = createWriteStream(stdoutPath, { flags: 'a' });
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      output += s;
      evstream.ingest(s);
      try { outFile.write(c); } catch { /* ignore */ }
    });
    child.stderr.on('data', (c) => logger.warn?.(`[story-dev:${job.jobId}:stderr] ${c.toString('utf8').trimEnd()}`));

    exitCode = await new Promise((res) => {
      child.on('error', (err) => { unregisterChild(job.jobId, child); logger.error?.(`[story-dev] spawn error: ${err.message}`); res(-1); });
      child.on('close', (code) => { unregisterChild(job.jobId, child); outFile.end(); res(code ?? 0); });
    });

    evstream.finalize();
    runMetrics = { ...evstream.metrics, durationMs: (deps.now?.() ?? Date.now()) - startedAt };

    if (exitCode !== 0) {
      // Spawn crash is NOT an AC failure — do not consume a fix-forward attempt;
      // escalate immediately.
      evstream.emitStepError(`dev exit ${exitCode}`);
      await deps.updateStoryState?.({ storyId: payload.storyId, state: 'failed', reason: `dev exit ${exitCode}`, metrics: runMetrics });
      break;
    }

    // Populate .context/loaded-skills.json from the transcript so the commit
    // trailer below is non-empty.
    trackSkillActivations({ workingDir: projectRoot, rawOutput: output });

    // ── Integrate (development-plan §4.1): commit THIS story's files to the plan
    // branch under the commit lock, stamping the per-story skills commit trailer.
    // The commit SHA is what the bound-AC tests bind against (staleness guard) —
    // a fresh headSha PER attempt so the deterministic oracle is never stale.
    // Skipped when no git helper is injected (unit tests) — fall back to headSha.
    if (deps.git) {
      const integ = await integrateStory({
        repoDir: projectRoot,
        touches: payload.touches || [],
        storyId: payload.storyId,
        title: payload.title,
        // Per-PLAN branch (development-plan §4.1); slug if available, else planId.
        planBranch: planBranchName(payload.planSlug || payload.planId),
        git: deps.git,
        extraCommitFlagBodies: buildStoryCommitFlags({ workingDir: projectRoot, rigor: payload.rigor || 'mvp' }),
      });
      if (integ.committed && integ.sha) headSha = integ.sha;
      else if (!integ.committed) logger.warn?.(`[story-dev] ${payload.storyId} integrate: ${integ.reason}`);
    }

    // W3.2 — contract_frozen: once the story's code is committed, mark it far
    // enough along (merging) so a dependent can start early under a graded
    // frontier mode. Dark under default kahn; guarded + non-blocking.
    if (flagMode(p3Flags, 'P3_FRONTIER_MODE') !== 'kahn' && deps.markContractFrozen) {
      try { await deps.markContractFrozen({ storyId: payload.storyId, sha: headSha }); }
      catch (e) { logger.warn?.(`[story-dev] ${payload.storyId} contract_frozen mark failed (non-blocking): ${e.message}`); }
    }

    // W5.1 — selective cross-story regression (dark unless P3_SELECTIVE_REGRESSION).
    // Non-blocking detection: run only the prior tests covering a symbol THIS
    // story changed (the retired wave-merge full-suite safety, made surgical).
    if (flagMode(p3Flags, 'P3_SELECTIVE_REGRESSION') !== 'off' && deps.selectiveRegression) {
      try { await deps.selectiveRegression({ storyId: payload.storyId, headSha, jobId: job.jobId }); }
      catch (e) { logger.warn?.(`[story-dev] ${payload.storyId} selective-regression failed (non-blocking): ${e.message}`); }
    }

    // W2.2 — post-hoc tamper audit. The live gate is the primary defense (it
    // forbids the implementer every test file); this is the deterministic
    // backstop for a gate leak. Detection runs here (right after integrate, on
    // this attempt's commit diff); the hit is APPLIED after handleStoryCompletion
    // below — it fails the attempt (was warn-only) and consumes a fix-forward
    // retry exactly like a failing bound AC.
    let tamper = null;
    if (split?.ownedTestFiles?.length && deps.git) {
      try {
        const d = await deps.git(['diff', '--name-only', `${headSha}~1`, headSha], projectRoot);
        const changed = String(d.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const t = detectTestTampering(split.ownedTestFiles, changed);
        if (!t.ok) {
          tamper = t;
          logger.warn?.(`[story-dev] ${payload.storyId} implementer touched authored test(s): ${t.tampered.join(', ')}`);
        }
      } catch { /* detection is best-effort — no diff, no verdict */ }
    }

    // Decode the stream-json transcript to the agent's plain text so the
    // <BINDING> manifest parses (its JSON is escaped inside stream-json fields).
    const devText = extractAssistantText(output) || output;

    // Deterministic completion verdict (bound-AC gate), bound to the committed SHA.
    completion = await handleStoryCompletion({
      storyNode: { storyId: payload.storyId, acceptanceCriteria: payload.acceptanceCriteria },
      // Split path: the AC→test <BINDING> comes from the Test-Author, not the
      // implementer (which only implements). Default path: the dev's own output.
      devOutput: split ? split.bindingOutput : devText,
      headSha,
      executors: deps.executors || {},
      now: deps.now,
      // W2.1 — additive quality verdict (dark unless P3_QUALITY_GATE on/shadow).
      qualityMode: flagMode(p3Flags, 'P3_QUALITY_GATE'),
      // W2.1b — risk-tiered reviewer (only fed into the verdict when qualityMode==='on').
      spawnReviewer: deps.spawnReviewer,
      // Reality-Spine #5 (no-mock rule): cwd threads through to
      // runStoryBindings so a state-verify AC bound to a test that mocks the
      // in-repo module under test is rejected (misbound) instead of passing.
      cwd: projectRoot,
      // Reality-Spine #6 (invariant validators): the story's declared
      // invariants + the raw agent text (for the <INVARIANTS> manifest) —
      // absent a manifest, invariants stay 'declared' and fail the gate closed.
      invariants: payload.invariants,
    });

    // W2.2 tamper escalation — a tamper hit FAILS the attempt regardless of the
    // AC verdict (a green run over modified acceptance tests proves nothing).
    // Applied before the foundation/green-trunk gates so no further gate work
    // is spent on a disqualified attempt.
    if (tamper) {
      completion.newState = 'failed';
      completion.propagate = false;
      completion.verdict = {
        ...completion.verdict,
        status: 'failing',
        failing: [...(completion.verdict.failing || []), 'test-tampering'],
        reasons: [
          ...(completion.verdict.reasons || []),
          `test-tampering: implementer modified authored test(s): ${tamper.tampered.join(', ')}`,
        ],
      };
      lastFailureDetail = `test-tampering: implementer modified authored test(s): ${tamper.tampered.join(', ')}`;
    }

    // Reality-Spine P1/P2 (redesign Part 2, Part 5 #2/#3) — the foundation
    // gate and green-trunk check run INSIDE the attempt loop, right after the
    // deterministic AC verdict and BEFORE it is persisted/branches on, so a
    // failure here consumes a fix-forward retry (same-scope re-spawn with the
    // real failure text) exactly like a failing bound AC does. Both are
    // no-ops when their flag is off or the daemon didn't inject the gate.
    if (
      flagMode(p3Flags, 'P3_FOUNDATION_GATE') === 'on'
      && isFoundationStory(payload)
      && completion.newState === 'done'
      && deps.foundationGate
    ) {
      const fg = await deps.foundationGate({ cwd: projectRoot, headSha, qaContext: deps.qaContext });
      if (!fg.passed) {
        completion.newState = 'failed';
        completion.propagate = false;
        completion.verdict = {
          ...completion.verdict,
          status: 'failing',
          failing: [...(completion.verdict.failing || []), 'foundation-gate'],
          reasons: [...(completion.verdict.reasons || []), ...fg.reasons],
        };
        lastFailureDetail = fg.reasons.join('\n');
      }
    }
    const gtOn = flagMode(p3Flags, 'P3_GREEN_TRUNK') === 'on' && deps.greenTrunk;
    if (gtOn && !isFoundationStory(payload) && completion.newState === 'done') {
      // Foundation stories skip green-trunk: the foundation gate above already
      // supersets tsc+build+boot for that story.
      const gt = await deps.greenTrunk({ cwd: projectRoot });
      if (!gt.passed) {
        completion.newState = 'failed';
        completion.propagate = false;
        completion.verdict = {
          ...completion.verdict,
          status: 'failing',
          failing: [...(completion.verdict.failing || []), 'green-trunk'],
          reasons: [...(completion.verdict.reasons || []), ...gt.reasons],
        };
        lastFailureDetail = gt.reasons.join('\n');
      }
    }

    // The dev step spawn completed (regardless of AC pass/fail) — emit metrics.
    evstream.emitStepComplete(runMetrics);

    // Persist the FULL post-run story state (state + bound ACs + commit + cost
    // + the loaded skill set so the forensic Skills tab reads it from the row).
    await deps.updateStoryState?.({
      storyId: payload.storyId,
      state: completion.newState,
      verdict: completion.verdict,
      acceptanceCriteria: completion.acceptanceCriteria,
      commitSha: headSha,
      metrics: runMetrics,
      loadedSkills: readStoryLoadedSkills(projectRoot),
    });

    if (completion.newState === 'done') {
      if (completion.propagate) await deps.propagateCompletion?.({ completedStoryId: payload.storyId });
      break;
    }
    lastFailureDetail = buildPriorFailureBlock(completion);
    if (!shouldRetry(completion, attempt, maxAttempts) || !classifyRetryable(completion)) break;
  }

  return {
    exitCode,
    verdict: completion?.verdict,
    newState: completion?.newState || 'failed',
    attemptsUsed,
    lastFailureDetail,
    acceptanceCriteria: completion?.acceptanceCriteria,
    metrics: runMetrics,
    commitSha: headSha,
  };
}
