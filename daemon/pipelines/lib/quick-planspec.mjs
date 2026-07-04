// quick-planspec — the "intent → Pipeline-3 plan" fast path core (daemon-side).
//
// Generation runs on the daemon (Claude CLI / Max subscription), so the plan_spec
// prompt + parse + ingest-layering live here as .mjs (the Lambda's TS ingest can't
// be imported by the daemon). Pure + deterministic (no I/O) so it unit-tests
// without a spawn or a table.
//
//   buildQuickPlanspecPrompt  — the single-call intent → plan_spec prompt
//   parseQuickPlanspec        — extract the <PLAN_SPEC> JSON, coerce to StoryNodes,
//                               derive dependency edges (foundation→feature→
//                               integration) when the model gives none
//   buildStoryNodeRows        — the Kahn layering (cohortBatch / unblockedDepsCount
//                               / ready|blocked), a faithful .mjs port of
//                               functions/shared/services/plan-spec-ingest.ts

import { randomUUID } from 'node:crypto';

const EPIC_WIDE_TOUCH = '<EPIC_WIDE>';
const VERIFY_VALUES = new Set(['build', 'appearance', 'state', 'behavior', 'manual']);
const COMPLEXITY_VALUES = new Set(['trivial', 'standard', 'complex', 'architectural']);
const MAX_STORIES = 8;

/**
 * The single-call prompt: an intent → a plan_spec the story-dev pipeline can run.
 * Emits ONE JSON object inside <PLAN_SPEC>…</PLAN_SPEC>. No epics/waves.
 *
 * `seamHook` is BOILERPLATE METADATA (BOILERPLATE_REGISTRY[type].testHarness
 * .seamHook, stamped into the job payload by the quick-create endpoint) — the
 * pipeline itself is app-kind-agnostic; never hardcode a game/dashboard hook here.
 *
 * @param {{ intent: string, appSlug: string, seamHook?: string }} args
 */
export function buildQuickPlanspecPrompt({ intent, appSlug, seamHook }) {
  const hookName = seamHook || 'the scaffold seam hook named in SCAFFOLD.md';
  return [
    `You are the SPEC planner for a Pipeline-3 build. Turn the operator's idea into a`,
    `minimal, buildable plan_spec — a flat list of stories a coding agent will implement`,
    `one-by-one. NO epics, NO waves, NO PRD/UX/architecture prose. Be concrete.`,
    ``,
    `# The idea`,
    intent,
    ``,
    `# The app`,
    `A freshly scaffolded app in this working directory (slug "${appSlug}"). READ the`,
    `existing files first (package.json, src/, SCAFFOLD.md) so your touches + tests fit`,
    `the real structure. The scaffold exposes a test seam:`,
    `\`window.__harness\` (\`.snapshot()\`, \`.forceStatus(x)\`) under NEXT_PUBLIC_TEST_HARNESS.`,
    ``,
    `# Output — EXACTLY one JSON object inside the tags, nothing else:`,
    `<PLAN_SPEC>`,
    `{`,
    `  "stories": [`,
    `    {`,
    `      "title": "short imperative title",`,
    `      "intent": "one sentence on what this story delivers",`,
    `      "acceptanceCriteria": [`,
    `        { "text": "≥5 chars, testable", "verify": "build|appearance|state|behavior|manual", "needsBrowser": false,`,
    `          "when": "(behavioral only) the action", "thenObservable": "(behavioral only) snapshot.<field> equals/greater-than <value>" }`,
    `      ],`,
    `      "touches": ["src/real/file/glob.ts"],`,
    `      "complexity": "trivial|standard|complex|architectural"`,
    `    }`,
    `  ]`,
    `}`,
    `</PLAN_SPEC>`,
    ``,
    `# HARD RULES`,
    `- At most ${MAX_STORIES} stories. Order them foundation → features → a final`,
    `  integration/assemble story (dependencies are DERIVED from that ordering — do NOT`,
    `  emit dependsOn).`,
    `- Split the work: 1 foundation story (types/constants/setup), feature stories,`,
    `  1 "Assemble the complete app" integration story last.`,
    `- \`touches\` MUST be real file paths/globs relative to the app root.`,
    `- EVERY acceptance criterion has a \`verify\` intent. A browser/runtime behavior`,
    `  MUST use \`needsBrowser: true\` with \`verify\` of appearance|state|behavior (NEVER`,
    `  "build"), and behavioral ACs assert \`window.__harness.snapshot()\` via`,
    `  when/thenObservable (e.g. thenObservable "snapshot.status equals 'running' and`,
    `  snapshot.score is greater than 0"). Pure/build ACs use verify "build",`,
    `  needsBrowser false, and a unit-testable claim.`,
    `- SEAM WIRING (non-negotiable — QA hard-fails without it): ${hookName} is the`,
    `  ONLY thing that publishes \`window.__harness\`. The final "Assemble the complete`,
    `  app" story MUST route the live app state through that scaffold hook — a`,
    `  hand-rolled \`useReducer\`/store bypasses the seam, the harness never mounts, and`,
    `  every deployed-app QA probe fails with SEAM_NEVER_PUBLISHED. The assemble`,
    `  story's ACs MUST include one asserting the seam mounts (e.g. thenObservable`,
    `  "snapshot.status equals 'idle'").`,
    `- Output ONLY the <PLAN_SPEC> block.`,
  ].join('\n');
}

/** Extract the JSON object from a <PLAN_SPEC> block, a fenced block, or bare text. */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const tagged = text.match(/<PLAN_SPEC>\s*([\s\S]*?)\s*<\/PLAN_SPEC>/i);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidates = [tagged?.[1], fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const FOUNDATION_RE =
  /\b(types?|constants?|config(uration)?|setup|scaffold(ing)?|schema|enums?|interfaces?|boilerplate|registry|register|models?)\b/i;
const INTEGRATION_RE =
  /\b(assembl\w*|integrat\w*|compose|composit\w*|end-to-end|full[- ](game|app|build|flow)|the complete)\b/i;
const LAYER = { foundation: 0, feature: 1, integration: 2 };

function classify(node) {
  const title = node.title || '';
  const epicWide = (node.touches || []).includes(EPIC_WIDE_TOUCH);
  if (epicWide || INTEGRATION_RE.test(title)) return 'integration';
  if (FOUNDATION_RE.test(title)) return 'foundation';
  return 'feature';
}

function concreteTouches(node) {
  return (node.touches || []).filter((t) => t && t !== EPIC_WIDE_TOUCH);
}

/**
 * Derive a foundation→feature→integration DAG (+ same-layer shared-touch edges)
 * when the model emitted no deps. Mirrors legacy-plan-to-plan-spec.deriveStoryDependencies.
 */
function deriveDeps(stories) {
  if (stories.length < 2) return;
  if (stories.some((s) => (s.depends_on?.length ?? 0) > 0)) return;
  const layers = stories.map((s) => LAYER[classify(s)]);
  const touchSets = stories.map((s) => new Set(concreteTouches(s)));
  for (let i = 0; i < stories.length; i++) {
    const deps = new Set();
    for (let j = 0; j < stories.length; j++) {
      if (j === i) continue;
      if (layers[j] < layers[i]) deps.add(stories[j].storyId);
      else if (layers[j] === layers[i] && j < i && touchSets[i].size) {
        for (const t of touchSets[j]) if (touchSets[i].has(t)) { deps.add(stories[j].storyId); break; }
      }
    }
    stories[i].depends_on = [...deps];
  }
}

function acClassOf(ac) {
  if (ac.acClass === 'advisory-security' || ac.acClass === 'advisory-taste' || ac.acClass === 'deterministic') {
    return ac.acClass;
  }
  return ac.verify === 'appearance' ? 'advisory-taste' : 'deterministic';
}

/**
 * BMAD P0–P3 risk tier (mirror of functions/shared/services/ac-cartographer.ts
 * deriveRiskTag — the daemon can't import TS). Quick-flow plans bypass the API's
 * Cartographer, so without this the quality gate's P-bands are all vacuous and
 * the risk-tiered reviewer never fires. PURE.
 */
export function deriveRiskTag(ac) {
  if (ac.acClass === 'advisory-security') return 'P0';
  if (ac.verify === 'behavior' || ac.verify === 'appearance' || ac.needsBrowser) return 'P1';
  if (ac.given || ac.when || ac.then) return 'P2';
  return 'P3';
}

/**
 * Parse the model's output into StoryNodes. Coerces loose shapes, assigns stable
 * storyIds, fills sane defaults, and derives dependency edges. Never throws.
 *
 * @returns {{ stories: object[], errors: string[] }}
 */
export function parseQuickPlanspec(text) {
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.stories) || obj.stories.length === 0) {
    return { stories: [], errors: ['no <PLAN_SPEC> stories JSON found in the output'] };
  }
  const errors = [];
  const raw = obj.stories.slice(0, MAX_STORIES);
  const stories = raw.map((s, si) => {
    const storyId = typeof s.storyId === 'string' && s.storyId ? s.storyId : randomUUID();
    const title = String(s.title || `Story ${si + 1}`).slice(0, 200);
    const acsIn = Array.isArray(s.acceptanceCriteria) && s.acceptanceCriteria.length
      ? s.acceptanceCriteria
      : [{ text: title, verify: 'build' }];
    const acceptanceCriteria = acsIn.map((ac, ai) => {
      const t = typeof ac.text === 'string' && ac.text.length >= 5 ? ac.text : `${ac.text || title} (criterion)`;
      const verify = VERIFY_VALUES.has(ac.verify) ? ac.verify : undefined;
      const needsBrowser = ac.needsBrowser === true || (verify && verify !== 'build');
      return {
        id: `${storyId}-ac${ai + 1}`,
        text: t,
        needsBrowser: needsBrowser || undefined,
        given: ac.given || undefined,
        when: ac.when || undefined,
        then: ac.then || undefined,
        thenObservable: ac.thenObservable || undefined,
        verify,
        testBinding: { status: 'unbound' },
        acClass: acClassOf(ac),
        riskTag: deriveRiskTag({ ...ac, verify, needsBrowser, acClass: acClassOf(ac) }),
      };
    });
    const touchesIn = Array.isArray(s.touches) ? s.touches.filter((x) => typeof x === 'string' && x.trim()) : [];
    return {
      storyId,
      cohort: { epicId: 'quick', epicTitle: 'Quick' },
      title,
      intent: String(s.intent || s.description || title).slice(0, 400),
      acceptanceCriteria,
      depends_on: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === 'string') : [],
      touches: touchesIn.length ? touchesIn : [EPIC_WIDE_TOUCH],
      forbiddenAreas: [],
      complexity: COMPLEXITY_VALUES.has(s.complexity) ? s.complexity : 'standard',
    };
  });

  // Filter deps to present ids (drop dangling), then derive when empty.
  const present = new Set(stories.map((s) => s.storyId));
  for (const s of stories) s.depends_on = s.depends_on.filter((d) => present.has(d) && d !== s.storyId);
  deriveDeps(stories);
  return { stories, errors };
}

/** Topological level per story (cohortBatch). Assumes a DAG. Pure. */
function topoLevels(stories) {
  const ids = new Set(stories.map((s) => s.storyId));
  const map = new Map(stories.map((s) => [s.storyId, s]));
  const level = new Map();
  const resolve = (id, seen) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = (map.get(id)?.depends_on ?? []).filter((d) => ids.has(d));
    const lv = deps.length ? Math.max(...deps.map((d) => resolve(d, seen))) + 1 : 0;
    level.set(id, lv);
    return lv;
  };
  for (const s of stories) resolve(s.storyId, new Set());
  return level;
}

/**
 * Build the plan-spec-graph rows from parsed StoryNodes — the daemon-side port of
 * ingestPlanSpec's row shaping (cohortBatch / unblockedDepsCount / ready|blocked).
 *
 * @returns {{ rows: object[], summary: {stories:number,ready:number,blocked:number,maxBatch:number}, errors: string[] }}
 */
export function buildStoryNodeRows({ stories, planId, appId, now = () => new Date().toISOString() }) {
  if (!stories?.length) return { rows: [], summary: { stories: 0, ready: 0, blocked: 0, maxBatch: 0 }, errors: ['no stories'] };
  const levels = topoLevels(stories);
  const ts = now();
  let ready = 0;
  let blocked = 0;
  let maxBatch = 0;
  const rows = stories.map((s) => {
    const unblockedDepsCount = s.depends_on.length;
    const state = unblockedDepsCount === 0 ? 'ready' : 'blocked';
    if (state === 'ready') ready += 1;
    else blocked += 1;
    const cohortBatch = levels.get(s.storyId) ?? 0;
    maxBatch = Math.max(maxBatch, cohortBatch);
    return { ...s, planId, appId, state, unblockedDepsCount, cohortBatch, version: 1, createdAt: ts, updatedAt: ts };
  });
  return { rows, summary: { stories: rows.length, ready, blocked, maxBatch }, errors: [] };
}
