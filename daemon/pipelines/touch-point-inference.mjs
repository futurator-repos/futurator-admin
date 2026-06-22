/**
 * Touch-point inference module (Touch-Point Inference §6, §7).
 *
 * Library API: `inferTouchPoints({ epic, workingDir, ... })`.
 *
 * For each story in the epic, spawns Haiku via the Claude CLI with the
 * template at `./templates/touch-point-inference.md.tpl`, parses an
 * `<INFERENCE>` JSON block, retries once on failure, and falls back to a
 * keyword-derived glob set when Haiku remains unusable.
 *
 * After all stories are inferred, runs deterministic cross-story collision
 * detection (`./lib/glob-intersect.mjs`) and splits overlapping stories
 * into adjacent waves while respecting existing `dependsOn` order.
 *
 * Events are appended to `{eventLogDir}/{jobId}.ndjson` in the format the
 * NDJSON forwarder consumes (role: "orchestrator", per-story storyId).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as realSpawn } from 'node:child_process';
import { buildCodebaseIndex } from './lib/codebase-index.mjs';
import { detectCollisions, reassignWaves } from './lib/glob-intersect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'templates', 'touch-point-inference.md.tpl');

const COMPLEXITY_VALUES = new Set(['trivial', 'standard', 'complex', 'architectural']);
const REVIEW_RIGOR_VALUES = new Set(['light', 'standard', 'strict']);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);

// Haiku pricing (per 1M tokens). §10.2 — update if pricing changes.
const HAIKU_INPUT_COST_PER_MTOK = 1.0;
const HAIKU_OUTPUT_COST_PER_MTOK = 5.0;

/**
 * Parse the first `<INFERENCE>…</INFERENCE>` block from Claude output.
 *
 * @returns {{ ok: true, inference: object } | { ok: false, reason: string }}
 */
export function parseInference(output) {
  if (typeof output !== 'string') return { ok: false, reason: 'no-block' };
  const match = output.match(/<INFERENCE>\s*(\{[\s\S]*?\})\s*<\/INFERENCE>/);
  if (!match) return { ok: false, reason: 'no-block' };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  if (!Array.isArray(parsed.touchPoints) || parsed.touchPoints.length === 0) {
    return { ok: false, reason: 'empty-touch-points' };
  }
  if (parsed.touchPoints.some((tp) => typeof tp !== 'string' || tp.length === 0)) {
    return { ok: false, reason: 'invalid-touch-points' };
  }
  if (!COMPLEXITY_VALUES.has(parsed.complexity)) {
    return { ok: false, reason: 'invalid-complexity' };
  }
  if (!REVIEW_RIGOR_VALUES.has(parsed.reviewRigor)) {
    return { ok: false, reason: 'invalid-review-rigor' };
  }
  if (!CONFIDENCE_VALUES.has(parsed.confidence)) {
    return { ok: false, reason: 'invalid-confidence' };
  }
  const collisionsWith = Array.isArray(parsed.collisionsWith)
    ? parsed.collisionsWith.filter((s) => typeof s === 'string')
    : [];

  return {
    ok: true,
    inference: {
      touchPoints: parsed.touchPoints,
      complexity: parsed.complexity,
      reviewRigor: parsed.reviewRigor,
      confidence: parsed.confidence,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      collisionsWith,
    },
  };
}

/**
 * Read `{workingDir}/CLAUDE.md` and extract Architecture + Key Conventions sections.
 * Returns empty string if CLAUDE.md is absent.
 */
export function buildConventionsDigest(workingDir) {
  const path = join(workingDir, 'CLAUDE.md');
  if (!existsSync(path)) return '';
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const sections = [extractSection(content, 'Architecture'), extractSection(content, 'Key Conventions')];
  return sections.filter(Boolean).join('\n\n').slice(0, 3 * 1024);
}

function extractSection(markdown, heading) {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const m = markdown.match(re);
  if (!m) return '';
  return `## ${heading}\n\n${m[1].trim()}`;
}

/**
 * Keyword-glob fallback used when Haiku fails twice.
 * Deterministic: same story → same globs. Confidence always 'low'.
 */
export function keywordGlobFallback(story) {
  const text = `${story.title || ''} ${story.description || ''}`.toLowerCase();
  const touchPoints = new Set();

  const rules = [
    [/\bapi\b|\broute\b|\bendpoint\b|\bhono\b/, 'functions/api/index.ts'],
    [/\brepository\b|\bdynamo(db)?\b|\btable\b/, 'functions/shared/repositories/*.ts'],
    [/\bhook\b|\btanstack\b|\bquery\b/, 'src/hooks/*.ts'],
    [/\bstore\b|\bzustand\b/, 'src/stores/*.ts'],
    [/\bpage\b|\bapp router\b|\broute\b/, 'src/app/**/page.tsx'],
    [/\bcomponent\b|\bbutton\b|\bform\b|\bcard\b|\bmodal\b/, 'src/components/**/*.tsx'],
    [/\bcron\b|\bschedule(r)?\b/, 'functions/cron/*.ts'],
    [/\bauth\b|\bjwt\b|\btoken\b/, 'functions/shared/auth-middleware.ts'],
    [/\bdaemon\b|\bagent\b|\bpipeline\b/, 'daemon/**/*.mjs'],
    [/\bsst\b|\binfra(structure)?\b/, 'sst.config.ts'],
  ];

  for (const [re, glob] of rules) {
    if (re.test(text)) touchPoints.add(glob);
  }
  if (touchPoints.size === 0) touchPoints.add('src/**/*.ts');

  return {
    touchPoints: Array.from(touchPoints),
    complexity: 'standard',
    reviewRigor: 'standard',
    confidence: 'low',
    reasoning: 'Fallback: keyword-glob match (Haiku inference failed).',
    collisionsWith: [],
  };
}

function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) =>
    name in vars ? String(vars[name] ?? '') : '',
  );
}

function renderCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return '(none specified)';
  return criteria
    .map((c) => {
      if (typeof c === 'string') return `- ${c}`;
      const text = c?.text || c?.description || c?.given || '';
      return `- ${text}`;
    })
    .join('\n');
}

function renderSiblings(epic, currentStoryId) {
  const siblings = (epic.stories || []).filter((s) => s.storyId !== currentStoryId);
  if (siblings.length === 0) return '(no siblings)';
  return siblings.map((s) => `- ${s.storyId}: ${s.title || ''}`).join('\n');
}

/**
 * Invoke the Claude CLI once for a single story, returning the raw stdout
 * plus basic usage metadata (token counts parsed from the --print tail, if
 * present). No retries here — caller does the retry + fallback dance.
 */
function runClaudeOnce({ prompt, claudeBin, haikuModel, spawnFn, env }) {
  return new Promise((resolve) => {
    const args = ['--model', haikuModel, '--allowedTools', '', '--print'];
    const child = spawnFn(claudeBin, args, {
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    try {
      child.stdin?.write?.(prompt);
      child.stdin?.end?.();
    } catch (err) {
      // spawn errored before stdin was ready; resolve handler above fires.
    }
  });
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4); // rough approximation, same heuristic used elsewhere in the codebase
}

async function inferStoryViaHaiku({
  story,
  epic,
  codebaseIndex,
  conventionsDigest,
  template,
  claudeBin,
  haikuModel,
  spawnFn,
  env,
}) {
  const vars = {
    storyId: story.storyId,
    title: story.title || '',
    description: story.description || '',
    criteriaBullets: renderCriteria(story.criteria),
    conventionsDigest: conventionsDigest || '(no CLAUDE.md)',
    codebaseIndex: codebaseIndex || '(no codebase index available)',
    siblingBullets: renderSiblings(epic, story.storyId),
  };
  const prompt = renderTemplate(template, vars);

  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await runClaudeOnce({ prompt, claudeBin, haikuModel, spawnFn, env });
    attempts.push(result);
    if (result.code !== 0) continue;
    const parsed = parseInference(result.stdout);
    if (parsed.ok) {
      return {
        ok: true,
        inference: parsed.inference,
        retries: attempt - 1,
        inputTokens: estimateTokens(prompt),
        outputTokens: estimateTokens(result.stdout),
      };
    }
  }
  return {
    ok: false,
    reason: deriveFailureReason(attempts),
    retries: 1,
    inputTokens: estimateTokens(prompt) * attempts.length,
    outputTokens: attempts.reduce((sum, a) => sum + estimateTokens(a.stdout), 0),
  };
}

function deriveFailureReason(attempts) {
  const last = attempts[attempts.length - 1];
  if (!last) return 'no-attempts';
  if (last.code !== 0) return `claude-exit-${last.code}`;
  const parsed = parseInference(last.stdout);
  if (!parsed.ok) return parsed.reason;
  return 'unknown';
}

function computeCost(inputTokens, outputTokens) {
  return (
    (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_MTOK +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_MTOK
  );
}

/**
 * Append a single event to `{eventLogDir}/{jobId}.ndjson`. No-op if
 * `eventLogDir` or `jobId` is missing.
 */
function emitEvent({ eventLogDir, jobId, event }) {
  if (!eventLogDir || !jobId) return;
  try {
    if (!existsSync(eventLogDir)) mkdirSync(eventLogDir, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    appendFileSync(join(eventLogDir, `${jobId}.ndjson`), line);
  } catch {
    // event emission must never break inference
  }
}

function makeEvent({ epicId, jobId, eventType, storyId, payload, now }) {
  const ts = now();
  return {
    jobId,
    epicId,
    eventType,
    role: 'orchestrator',
    storyId,
    ts,
    timestamp: new Date(ts).toISOString(),
    payload: payload || {},
  };
}

async function runBatched(items, maxParallel, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function pump() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(maxParallel, items.length) }, () => pump());
  await Promise.all(workers);
  return results;
}

/**
 * @typedef {Object} InferenceResult
 * @property {string} epicId
 * @property {Array<object>} stories
 * @property {Array<object>} collisions
 * @property {Array<object>} waveReassignments
 * @property {string[]} requiresOperatorReview
 * @property {number} totalCostUSD
 * @property {number} fallbacksApplied
 */

/**
 * Infer touch points for every story in `epic`.
 *
 * @param {{
 *   epic: { epicId: string, stories: Array<object> },
 *   workingDir: string,
 *   codebaseIndex?: string,
 *   conventionsDigest?: string,
 *   maxParallel?: number,
 *   haikuModel?: string,
 *   claudeBin?: string,
 *   eventLogDir?: string,
 *   jobId?: string,
 *   templatePath?: string,
 *   spawn?: typeof realSpawn,
 *   now?: () => number,
 *   logger?: Console,
 * }} opts
 * @returns {Promise<InferenceResult>}
 */
export async function inferTouchPoints(opts) {
  if (!opts?.epic) throw new Error('inferTouchPoints: epic is required');
  if (!opts?.workingDir) throw new Error('inferTouchPoints: workingDir is required');

  const {
    epic,
    workingDir,
    maxParallel = 8,
    haikuModel = 'haiku',
    claudeBin = 'claude',
    eventLogDir,
    jobId,
    templatePath = TEMPLATE_PATH,
    spawn = realSpawn,
    now = () => Date.now(),
    logger = console,
  } = opts;

  const stories = epic.stories || [];
  const codebaseIndex =
    opts.codebaseIndex ?? (await buildCodebaseIndex(workingDir, { logger }));
  const conventionsDigest =
    opts.conventionsDigest ?? buildConventionsDigest(workingDir);
  const template = readFileSync(templatePath, 'utf8');

  emitEvent({
    eventLogDir,
    jobId,
    event: makeEvent({
      epicId: epic.epicId,
      jobId,
      eventType: 'inference_start',
      storyId: null,
      payload: { storyCount: stories.length, maxParallel },
      now,
    }),
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let fallbacksApplied = 0;

  const perStory = await runBatched(stories, maxParallel, async (story) => {
    const haiku = await inferStoryViaHaiku({
      story,
      epic,
      codebaseIndex,
      conventionsDigest,
      template,
      claudeBin,
      haikuModel,
      spawnFn: spawn,
      env: opts.env,
    });
    totalInputTokens += haiku.inputTokens;
    totalOutputTokens += haiku.outputTokens;

    if (haiku.ok) {
      emitEvent({
        eventLogDir,
        jobId,
        event: makeEvent({
          epicId: epic.epicId,
          jobId,
          eventType: 'story_inferred',
          storyId: story.storyId,
          payload: {
            complexity: haiku.inference.complexity,
            reviewRigor: haiku.inference.reviewRigor,
            confidence: haiku.inference.confidence,
            touchPointCount: haiku.inference.touchPoints.length,
            retries: haiku.retries,
          },
          now,
        }),
      });
      return {
        storyId: story.storyId,
        wave: story.wave,
        dependsOn: story.dependsOn,
        ...haiku.inference,
        retries: haiku.retries,
        fallbackApplied: false,
        requiresOperatorReview: haiku.inference.confidence === 'low',
      };
    }

    fallbacksApplied += 1;
    const fb = keywordGlobFallback(story);
    emitEvent({
      eventLogDir,
      jobId,
      event: makeEvent({
        epicId: epic.epicId,
        jobId,
        eventType: 'inference_failed',
        storyId: story.storyId,
        payload: { reason: haiku.reason, fallbackApplied: true, retries: haiku.retries },
        now,
      }),
    });
    emitEvent({
      eventLogDir,
      jobId,
      event: makeEvent({
        epicId: epic.epicId,
        jobId,
        eventType: 'story_inferred',
        storyId: story.storyId,
        payload: {
          complexity: fb.complexity,
          reviewRigor: fb.reviewRigor,
          confidence: fb.confidence,
          touchPointCount: fb.touchPoints.length,
          retries: haiku.retries,
          fallbackApplied: true,
        },
        now,
      }),
    });
    return {
      storyId: story.storyId,
      wave: story.wave,
      dependsOn: story.dependsOn,
      ...fb,
      retries: haiku.retries,
      fallbackApplied: true,
      requiresOperatorReview: true,
    };
  });

  // D3-2 (2026-06-22) — carry each story's persisted actualTouchPoints (the
  // files its DEV agent actually edited on a prior run, recorded by the
  // dev-scope gate) into the collision input, so `detectCollisions` unions them
  // with the (re-inferred) declared set. Two siblings that collided only on a
  // measured-but-undeclared file then serialize on this recompute.
  const actualByStoryId = new Map(
    (epic.stories || []).map((s) => [s.storyId, s.actualTouchPoints]),
  );
  const waveInput = perStory.map((s) => ({
    storyId: s.storyId,
    wave: s.wave,
    dependsOn: s.dependsOn,
    complexity: s.complexity,
    touchPoints: s.touchPoints,
    actualTouchPoints: actualByStoryId.get(s.storyId),
    collisionsWith: s.collisionsWith,
  }));
  const collisionsDetected = detectCollisions(waveInput);
  const { stories: reassigned, reassignments } = reassignWaves(waveInput);

  const waveById = new Map(reassigned.map((s) => [s.storyId, s.wave]));
  for (const s of perStory) {
    s.wave = waveById.get(s.storyId);
  }

  for (const r of reassignments) {
    emitEvent({
      eventLogDir,
      jobId,
      event: makeEvent({
        epicId: epic.epicId,
        jobId,
        eventType: 'wave_conflict_autosplit',
        storyId: r.storyId,
        payload: { fromWave: r.from, toWave: r.to, reason: r.reason },
        now,
      }),
    });
  }

  const collisions = collisionsDetected.map((c) => {
    const bumpMatch = reassignments.find((r) => r.storyId === c.a || r.storyId === c.b);
    let resolution = 'split-wave';
    if (!bumpMatch) resolution = 'dependsOn';
    else if (bumpMatch.reason === 'haiku_flagged') resolution = 'haiku-flagged';
    return { stories: [c.a, c.b], overlap: c.paths, resolution };
  });

  const requiresOperatorReview = perStory
    .filter((s) => s.requiresOperatorReview)
    .map((s) => s.storyId);

  const totalCostUSD = computeCost(totalInputTokens, totalOutputTokens);

  emitEvent({
    eventLogDir,
    jobId,
    event: makeEvent({
      epicId: epic.epicId,
      jobId,
      eventType: 'inference_complete',
      storyId: null,
      payload: {
        totalStories: stories.length,
        requiresOperatorReview: requiresOperatorReview.length,
        totalCostUSD: Number(totalCostUSD.toFixed(6)),
        fallbacksApplied,
      },
      now,
    }),
  });

  logger?.info?.(
    `[touch-point-inference] epic=${epic.epicId} stories=${stories.length} ` +
      `fallbacks=${fallbacksApplied} collisions=${collisions.length} ` +
      `reassigned=${reassignments.length} cost=$${totalCostUSD.toFixed(4)}`,
  );

  return {
    epicId: epic.epicId,
    stories: perStory,
    collisions,
    waveReassignments: reassignments,
    requiresOperatorReview,
    totalCostUSD,
    fallbacksApplied,
  };
}

export { TEMPLATE_PATH };

/**
 * Merge an `InferenceResult` back into the epic's full stories array.
 *
 * - When `storyIdFilter` is non-empty, only those stories are updated;
 *   the rest are returned unchanged.
 * - Stories not touched by inference keep their existing fields untouched.
 * - Each updated story gets `touchPoints`, `complexity`, `reviewRigor`,
 *   `wave`, and `inferenceMetadata` set.
 */
export function mergeInferenceIntoEpic(epic, inferenceResult, { storyIdFilter } = {}) {
  const filter = storyIdFilter && storyIdFilter.length > 0 ? new Set(storyIdFilter) : null;
  const inferredById = new Map(inferenceResult.stories.map((s) => [s.storyId, s]));
  const now = new Date().toISOString();

  const merged = (epic.stories || []).map((story) => {
    if (filter && !filter.has(story.storyId)) return story;
    const inferred = inferredById.get(story.storyId);
    if (!inferred) return story;
    return {
      ...story,
      touchPoints: inferred.touchPoints,
      complexity: inferred.complexity,
      reviewRigor: inferred.reviewRigor,
      wave: inferred.wave ?? story.wave,
      inferenceMetadata: {
        inferredAt: now,
        model: 'haiku',
        confidence: inferred.confidence,
        reasoning: inferred.reasoning,
        retries: inferred.retries ?? 0,
        fallbackApplied: inferred.fallbackApplied === true,
        requiresOperatorReview: inferred.requiresOperatorReview === true,
      },
    };
  });

  return merged;
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--epic-id' && argv[i + 1]) opts.epicId = argv[++i];
    else if (a === '--working-dir' && argv[i + 1]) opts.workingDir = argv[++i];
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (a === '--stories' && argv[i + 1]) opts.stories = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max-parallel' && argv[i + 1]) opts.maxParallel = parseInt(argv[++i], 10);
    else if (a === '--haiku-model' && argv[i + 1]) opts.haikuModel = argv[++i];
    else if (a === '--job-id' && argv[i + 1]) opts.jobId = argv[++i];
    else if (a === '--event-log-dir' && argv[i + 1]) opts.eventLogDir = argv[++i];
    else if (a === '--table' && argv[i + 1]) opts.tableName = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--skip-persist') opts.skipPersist = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node daemon/pipelines/touch-point-inference.mjs \\',
    '    --epic-id EPIC-42 \\',
    '    --working-dir /path/to/repo \\',
    '    --out /tmp/out.json \\',
    '    [--stories STORY-7,STORY-9] [--force] [--max-parallel 8] \\',
    '    [--haiku-model haiku] [--job-id job-xyz] [--event-log-dir /var/log/.../events] \\',
    '    [--table futurator-epic-workflows] [--skip-persist]',
  ].join('\n');
}

/**
 * Run inference for an epic, write the JSON report to disk, and persist
 * merged story fields back to DynamoDB.
 *
 * Injectable repo + spawn for tests; defaults wire up the real AWS SDK.
 */
export async function runInferenceCli({
  argv,
  repo,
  spawn,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const opts = parseCliArgs(argv || []);
  if (opts.help) {
    logger.info(usage());
    return { exitCode: 0 };
  }
  if (!opts.epicId || !opts.workingDir || !opts.out) {
    logger.error(usage());
    return { exitCode: 1 };
  }

  const epic = await repo.getEpicById(opts.epicId);
  if (!epic) {
    logger.error(`[touch-point-inference] epic not found: ${opts.epicId}`);
    return { exitCode: 2 };
  }

  const allStoryIds = (epic.stories || []).map((s) => s.storyId);
  const hasExistingInference = (epic.stories || []).some(
    (s) => s.inferenceMetadata && Array.isArray(s.touchPoints) && s.touchPoints.length > 0,
  );
  if (hasExistingInference && !opts.force && !opts.stories) {
    logger.error(
      `[touch-point-inference] epic ${opts.epicId} already has inference results. Use --force to re-run all, or --stories to re-run specific stories.`,
    );
    return { exitCode: 3 };
  }

  const storyFilter = opts.stories && opts.stories.length > 0 ? opts.stories : null;
  const epicForInference =
    storyFilter
      ? { ...epic, stories: (epic.stories || []).filter((s) => storyFilter.includes(s.storyId)) }
      : epic;

  if (storyFilter) {
    const unknown = storyFilter.filter((id) => !allStoryIds.includes(id));
    if (unknown.length > 0) {
      logger.error(`[touch-point-inference] unknown story ids: ${unknown.join(', ')}`);
      return { exitCode: 4 };
    }
  }

  const result = await inferTouchPoints({
    epic: epicForInference,
    workingDir: opts.workingDir,
    maxParallel: opts.maxParallel,
    haikuModel: opts.haikuModel,
    eventLogDir: opts.eventLogDir,
    jobId: opts.jobId,
    spawn,
    logger,
    now,
  });

  try {
    mkdirSync(dirname(opts.out), { recursive: true });
  } catch {
    // directory may exist
  }
  writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
  logger.info?.(`[touch-point-inference] wrote ${opts.out}`);

  if (!opts.skipPersist) {
    const mergedStories = mergeInferenceIntoEpic(epic, result, {
      storyIdFilter: storyFilter || undefined,
    });
    await repo.persistInferenceResult(opts.epicId, {
      stories: mergedStories,
      inferenceSummary: {
        lastInferredAt: new Date().toISOString(),
        totalCostUSD: result.totalCostUSD,
        fallbacksApplied: result.fallbacksApplied,
        requiresOperatorReview: result.requiresOperatorReview,
        waveReassignments: result.waveReassignments,
        collisions: result.collisions,
      },
    });
    logger.info?.(`[touch-point-inference] persisted inference to epic ${opts.epicId}`);
  }

  if (result.fallbacksApplied > 0) {
    logger.warn?.(
      `[touch-point-inference] ${result.fallbacksApplied} stories required fallback; re-run with --stories to retry`,
    );
    return { exitCode: 10, result };
  }
  return { exitCode: 0, result };
}

// ── CLI Entry Point ──

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('touch-point-inference.mjs') ||
    process.argv[1].endsWith('touch-point-inference'));

if (isMain) {
  (async () => {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const { createEpicRepo } = await import('./lib/epic-repo.mjs');

    const region = process.env.AWS_REGION || 'us-east-1';
    const tableName = process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows';
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const repo = createEpicRepo({ ddb, tableName });

    try {
      const { exitCode } = await runInferenceCli({ argv: process.argv.slice(2), repo });
      process.exit(exitCode);
    } catch (err) {
      console.error(`[touch-point-inference] fatal: ${err.message}`);
      process.exit(1);
    }
  })();
}
