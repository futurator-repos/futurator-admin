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
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerChild, unregisterChild } from './lib/child-tracker.mjs';
import { freezeFlagsOntoJob, flagMode } from '../lib/pipeline-flags.mjs';
import { buildGateSpawn } from '../lib/gate-settings.mjs';
import { handleStoryCompletion } from '../lib/story-completion-handler.mjs';
import { integrateStory } from '../lib/story-integrate.mjs';
import { extractAssistantText } from '../lib/stream-json-text.mjs';
import { planBranchName } from '../lib/plan-branch.mjs';
import { runStoryBindings } from '../lib/test-binding-runner.mjs';
import { detectTestTampering } from '../lib/tdd-gates.mjs';
// W2.2 (P3_TEST_AUTHOR_SPLIT) — isolated Test-Author phase + implementer prompt.
import { runTestAuthorPhase, buildImplementerPrompt } from './lib/test-author-phase.mjs';
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

/** Build the single-story dev prompt. PURE. Requires the agent to emit <BINDING>. */
export function buildStoryDevPrompt(payload) {
  const acLines = (payload.acceptanceCriteria || [])
    .map((ac, i) => `  ${i + 1}. [${ac.id}] ${ac.text}${ac.acClass ? ` (${ac.acClass})` : ''}`)
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
 *           updateStoryState, propagateCompletion }
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
  const gate = buildGateSpawn({
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
  // tests, proves them RED, and commits a `test(): RED` checkpoint. On ANY error
  // we fall open to the legacy single untrimmed dev spawn (byte-identical).
  const splitOn = flagMode(p3Flags, 'P3_TEST_AUTHOR_SPLIT') === 'on';
  let split = null;
  // Minimal one-shot spawn (no fix-forward loop) used only by the Test-Author.
  const spawnClaudeOnce = (onePrompt) => new Promise((res) => {
    const oneArgs = [
      '-p', onePrompt, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions', ...gate.args, ...injectionArgs,
    ];
    let out = '';
    const c = spawn(claudeBin, oneArgs, { cwd: projectRoot, env: { ...process.env, ...gate.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (ch) => { out += ch.toString('utf8'); });
    c.on('error', () => res({ exitCode: -1, text: '' }));
    c.on('close', (code) => res({ exitCode: code ?? 0, text: extractAssistantText(out) || out }));
  });
  if (splitOn) {
    try {
      split = await runTestAuthorPhase({
        payload,
        headSha,
        spawnOnce: ({ prompt }) => spawnClaudeOnce(prompt),
        commitRed: async ({ label }) => {
          if (!deps.git) return { committed: false };
          const integ = await integrateStory({
            repoDir: projectRoot, touches: payload.touches || [], storyId: payload.storyId,
            title: label, planBranch: planBranchName(payload.planSlug || payload.planId), git: deps.git,
          });
          let files = [];
          try {
            if (integ.committed && integ.sha) {
              const d = await deps.git(['diff', '--name-only', `${integ.sha}~1`, integ.sha], projectRoot);
              files = String(d.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
            }
          } catch { /* best-effort file list */ }
          return { committed: integ.committed, sha: integ.sha, files };
        },
        runBindings: ({ acceptanceCriteria, headSha: sha }) =>
          runStoryBindings({ acceptanceCriteria, headSha: sha, executors: deps.executors || {}, now: deps.now }),
        logger,
      });
      if (split?.redSha) headSha = split.redSha;
    } catch (e) {
      logger.warn?.(`[story-dev] ${payload.storyId} test-author phase failed → single-spawn fallback: ${e.message}`);
      split = null;
    }
  }
  // When split succeeded, forbid the implementer from editing the authored tests
  // via the LIVE gate (deterministic in-turn block, stronger than a post-hoc
  // revert). Rebuilt only in the split path; the default `gate` is untouched.
  const implGate = split?.ownedTestFiles?.length
    ? buildGateSpawn({
        jobId: job.jobId, p3Flags, touchPoints: payload.touches || [],
        forbiddenAreas: [...(payload.forbiddenAreas || []), ...split.ownedTestFiles],
        ledgerPath: join(projectRoot, '.pipeline', 'gate-events.jsonl'),
        ceilingUsd: payload.costCeilingUsd ?? job.costCeilingUsd,
        harnessCostDir: join(projectRoot, '.pipeline', 'harness-cost'),
        haltDir: projectRoot, observeLog: join(projectRoot, '.pipeline', 'observations.jsonl'),
        agentRole: 'story-dev',
      })
    : gate;

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
      ? buildImplementerPrompt({ ...payload, priorFailure: pf }, split.ownedTestFiles)
      : buildStoryDevPrompt({ ...payload, priorFailure: pf });
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
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

    // W2.2 — post-hoc tamper audit (the live gate already forbids editing the
    // authored tests; this surfaces any leak). Warn only, never fails the story.
    if (split?.ownedTestFiles?.length && deps.git) {
      try {
        const d = await deps.git(['diff', '--name-only', `${headSha}~1`, headSha], projectRoot);
        const changed = String(d.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const tamper = detectTestTampering(split.ownedTestFiles, changed);
        if (!tamper.ok) logger.warn?.(`[story-dev] ${payload.storyId} implementer touched authored test(s): ${tamper.tampered.join(', ')}`);
      } catch { /* audit only */ }
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
    });

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
