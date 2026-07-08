// quick-planspec — the "intent → Pipeline-3 plan" fast path core (daemon-side).
//
// Generation runs on the daemon (Claude CLI / Max subscription), so the plan_spec
// prompt + parse + ingest-layering live here as .mjs (the Lambda's TS ingest can't
// be imported by the daemon). Pure + deterministic (no I/O) so it unit-tests
// without a spawn or a table.
//
//   buildQuickPlanspecPrompt       — the single-call intent → plan_spec prompt
//   buildQuickPlanspecRepairPrompt — the audit-violation repair pass prompt
//   parseQuickPlanspec             — extract the <PLAN_SPEC> JSON, coerce to
//                                    StoryNodes, map slug dependsOn → storyIds,
//                                    normalize the DAG (cycle-break, anchors,
//                                    scope-safety edges) + audit it
//   auditPlanGraph                 — width/critical-path/god-file/linear-chain
//                                    metrics + violations (pure)
//   buildStoryNodeRows             — the Kahn layering (cohortBatch /
//                                    unblockedDepsCount / ready|blocked), a
//                                    faithful .mjs port of
//                                    functions/shared/services/plan-spec-ingest.ts
//
// PARALLELISM DESIGN (planner-parallelism-investigation.md): the P3 frontier is a
// true per-story dependsOn frontier — cohortBatch never gates dispatch — and all
// concurrent stories share ONE working tree where each story's `touches` is a
// gate-enforced allow-list (siblings' touches become its forbiddenAreas; there is
// NO merge to rescue overlaps). So the plan itself must deliver width: a frozen
// foundation contract, disjoint per-capability slices, explicit model-authored
// dependsOn, and a deterministic audit that flags serial plans for repair.

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
 * @param {{ intent: string, appSlug: string, seamHook?: string, maxStories?: number }} args
 */
export function buildQuickPlanspecPrompt({ intent, appSlug, seamHook, maxStories = MAX_STORIES }) {
  const hookName = seamHook || 'the scaffold seam hook named in SCAFFOLD.md';
  return [
    `You are the SPEC planner for a Pipeline-3 build. Turn the operator's idea into a`,
    `buildable plan_spec — a DAG of stories that PARALLEL coding agents implement`,
    `concurrently. NO epics, NO waves, NO PRD/UX/architecture prose. Be concrete and`,
    `specific to THIS idea.`,
    ``,
    `The pipeline is app-kind-agnostic: the idea may be a game, a dashboard, a data`,
    `viewer, an editor, a tool, a simulation, a form-driven workflow — anything. Do NOT`,
    `assume a genre. Read the idea and plan exactly what it describes.`,
    ``,
    `# The idea`,
    intent,
    ``,
    `# The app`,
    `A freshly scaffolded app in this working directory (slug "${appSlug}"). READ the`,
    `existing files FIRST (package.json, src/, SCAFFOLD.md) so your touches + tests fit`,
    `the real structure and framework. The scaffold exposes a test seam on`,
    `\`window.__harness\` (\`.snapshot()\` returns the live app state; \`.forceStatus(x)\`)`,
    `under NEXT_PUBLIC_TEST_HARNESS — the deployed-app QA reads app state through it.`,
    ``,
    `# How your plan is EXECUTED (design for this)`,
    `- Stories run as PARALLEL coding agents. A story starts the instant every story in`,
    `  its dependsOn is done — the graph's critical path IS the build's wall-clock. A`,
    `  false dependency wastes real time; a chain of stories is the worst possible plan.`,
    `- All concurrent stories share ONE working tree. Each agent may write ONLY files`,
    `  matching its own touches; every sibling's touches are forbidden to it (a live`,
    `  gate enforces this). There is NO merge step to rescue overlaps — two stories`,
    `  that can run at the same time MUST NOT share any file.`,
    `- Each story's agent sees ONLY its own story (title/intent/ACs/touches) plus the`,
    `  repo files already committed by its dependencies. Cross-story interfaces must`,
    `  live in the contract files the foundation commits — each story's intent should`,
    `  name the contract file(s) it implements against.`,
    ``,
    `# THINK FIRST (in this order, before writing JSON)`,
    `0. SHAPE — decide planShape FIRST, before decomposing anything. Choose "coherent"`,
    `   when the app is ONE tightly-coupled runtime (a single game loop, one canvas, one`,
    `   state machine that every capability reads/writes) OR the app is small enough`,
    `   that fan-out overhead (contract tax, cross-slice wiring) outweighs the benefit`,
    `   of parallel stories. Choose "sharded" when the capabilities are genuinely`,
    `   separable behind the frozen contract (distinct routes/views/services, each`,
    `   reading/writing its OWN slice of state) and the size justifies the width. Write`,
    `   ONE sentence explaining which you picked and why — this becomes`,
    `   planShapeRationale. Do not default to sharded out of habit: a shattered coherent`,
    `   app is a worse plan than a single well-built one.`,
    `1. CAPABILITIES — what is the CORE experience? List the distinct capabilities the`,
    `   operator asked for — every interaction, view, and rule they named. A plan that`,
    `   silently drops half of them produces a hollow, "lame" app that technically runs`,
    `   but does almost nothing. Cover the WHOLE idea; if it won't fit in ${maxStories}`,
    `   stories, make each story broader — never drop a named capability.`,
    `2. CONTRACT — design the frozen interface FIRST: the state shape \`snapshot()\``,
    `   exposes, the action/event type union, and the exact module signature each`,
    `   capability slice will export (e.g. one reducer/system/handler function per`,
    `   slice). The FOUNDATION story creates these contract files COMPLETELY; no later`,
    `   story edits them.`,
    `3. SLICES — one story per capability, each OWNING its own disjoint file(s), e.g.`,
    `   \`src/slices/<capability>.ts\` plus that capability's render piece. NEVER plan`,
    `   one shared file that every feature edits (a god reducer/store — it serializes`,
    `   the whole build). If two capabilities want the same file, split the file along`,
    `   the contract or merge those capabilities into one story.`,
    `4. GRAPH — emit dependsOn per story (by story "id"). Include ONLY true`,
    `   prerequisites — a story that consumes another story's committed output. Feature`,
    `   slices implement against the frozen contract, so they depend ONLY on the`,
    `   foundation story, NOT on each other. The final assemble story depends on all`,
    `   and composes the slices + wires the seam.`,
    `5. SELF-CHECK before emitting — fix the plan, don't ship the smell:`,
    `   (a) does any non-foundation file appear in two stories' touches? split it.`,
    `   (b) is the graph a chain (each story depending on the previous one)? you`,
    `       invented false deps — the target shape is foundation → ONE WIDE LAYER of`,
    `       independent slices → assemble.`,
    `   (c) does every user-driven capability carry a behavioral AC?`,
    `   (d) does the assemble story prove every capability through \`snapshot()\`?`,
    ``,
    `# Output — EXACTLY one JSON object inside the tags, nothing else:`,
    `<PLAN_SPEC>`,
    `{`,
    `  "planShape": "coherent|sharded",`,
    `  "planShapeRationale": "one sentence: why this shape fits THIS idea",`,
    `  "stories": [`,
    `    {`,
    `      "id": "kebab-slug-unique-in-this-plan",`,
    `      "title": "short imperative title",`,
    `      "intent": "one sentence on what this story delivers (name the contract files it implements against)",`,
    `      "dependsOn": ["id-of-a-true-prerequisite-story"],`,
    `      "acceptanceCriteria": [`,
    `        { "text": "≥5 chars, specific + testable", "verify": "build|appearance|state|behavior|manual", "needsBrowser": false,`,
    `          "when": "(behavioral only) the concrete user action", "thenObservable": "(behavioral only) snapshot.<field> equals/greater-than/contains <value>" }`,
    `      ],`,
    `      "touches": ["src/real/file/glob.ts"],`,
    `      "complexity": "trivial|standard|complex|architectural",`,
    `      "invariants": [`,
    `        { "id": "kebab-slug", "description": "a property of the domain DATA that must hold, in plain terms (foundation story / coherent build-whole story only)" }`,
    `      ]`,
    `    }`,
    `  ]`,
    `}`,
    `</PLAN_SPEC>`,
    ``,
    `# COHERENT SHAPE rules (only apply when planShape is "coherent")`,
    `- Emit EXACTLY ONE story: "id":"build-the-complete-app", "title":"Build the complete`,
    `  <app>", "touches":["src/**"], "complexity":"complex" or "architectural".`,
    `- Fold everything into that ONE story: the frozen contract, every capability from`,
    `  the idea, assembling them, and wiring the seam — all in its intent and`,
    `  acceptanceCriteria. There is no separate foundation/feature/assemble split.`,
    `- Its acceptanceCriteria MUST still include: the seam-mount AC (thenObservable`,
    `  "snapshot.status equals 'idle'" or equivalent), one behavioral AC per capability`,
    `  named in the idea, and the declared invariants (see below) as ACs the gate can`,
    `  bind to.`,
    `- dependsOn is empty (nothing to depend on — it's the only story).`,
    ``,
    `# HARD RULES`,
    `- At most ${maxStories} stories. Use as many as the idea needs — a tiny idea is 3`,
    `  (foundation, one capability, assemble); never pad, and never drop a named`,
    `  capability.`,
    `- Structure (when planShape is "sharded"): 1 foundation story (the contract files:`,
    `  state model + types/constants that \`snapshot()\` will expose + the slice module`,
    `  signatures), one story PER core capability from the idea, and a final "Assemble`,
    `  the complete app" story that wires them into one working app. (When planShape`,
    `  is "coherent", use the COHERENT SHAPE rules above instead — ONE story only.)`,
    `- INVARIANTS: the FOUNDATION story (sharded) or the build-whole story (coherent)`,
    `  MUST declare an "invariants" entry for every non-trivial piece of authored data`,
    `  it creates — seed data, maps/levels, config, a schema other stories will rely on,`,
    `  reachability of content. State each as a property of the DATA itself ("every`,
    `  reachable cell has a path to the exit", "every seeded id is unique and resolves`,
    `  in the schema") — never skip this because "it's just config"; bad seed/level`,
    `  data is exactly the class of bug a story-level test cannot catch.`,
    `- PARALLELISM: dependsOn lists ONLY true prerequisites. Feature slices depend on`,
    `  the foundation, not on each other. Stories that can run concurrently MUST have`,
    `  disjoint touches — ownership, never sharing.`,
    `- FIDELITY: the feature stories together must cover every capability the operator`,
    `  named — not a demo subset. A reviewer reading the idea and the plan should see`,
    `  nothing missing.`,
    `- INTERACTIVITY (anti-lame): every capability the user drives MUST carry at least`,
    `  one behavioral AC — \`needsBrowser: true\`, \`verify: "behavior"\`, and a`,
    `  when/thenObservable pair asserting the result through \`snapshot()\` (e.g. when`,
    `  "user selects the second item", thenObservable "snapshot.selectedId equals the`,
    `  second item's id"). Pick fields/values that fit THIS app; never leave an`,
    `  interaction verified only by a build/unit test.`,
    `- \`touches\` MUST be real file paths/globs relative to the app root.`,
    `- verify intents: "build" (pure/unit-testable, needsBrowser false) · "appearance"`,
    `  (renders/looks right) · "state" (a state transition) · "behavior" (a driven`,
    `  interaction, needsBrowser true) · "manual" (only when nothing else fits). A`,
    `  runtime behavior is NEVER verified by "build".`,
    `- SEAM WIRING (non-negotiable — QA hard-fails without it): ${hookName} is the ONLY`,
    `  thing that publishes \`window.__harness\`. The final "Assemble the complete app"`,
    `  story MUST route the live app state through that scaffold hook — a hand-rolled`,
    `  \`useReducer\`/store bypasses the seam, the harness never mounts, and every`,
    `  deployed-app QA probe fails with SEAM_NEVER_PUBLISHED. The assemble story's ACs`,
    `  MUST include one asserting the seam mounts (e.g. thenObservable "snapshot.status`,
    `  equals 'idle'") plus one behavioral AC per core capability proving it works in`,
    `  the assembled app.`,
    `- QA drives the app as a USER (keyboard/click); NEVER author forceStatus/`,
    `  __harness.dispatch in a \`when\` — the DRIVE lane is disabled during QA`,
    `  (observe-only). Write every behavioral \`when\` as a real user action (press a`,
    `  key, click a labeled control, type into a field), never a harness call that`,
    `  short-circuits driving the app.`,
    `- Output ONLY the <PLAN_SPEC> block.`,
  ].join('\n');
}

/**
 * The repair-pass prompt: the base prompt + the failed plan + the audit violations.
 * Fired by the runner when auditPlanGraph flags a serial plan / god-files; asks for
 * a FULL re-emit (same quality rules, corrected decomposition + graph). PURE.
 *
 * @param {{ intent: string, appSlug: string, seamHook?: string, maxStories?: number,
 *           stories: object[], violations: string[] }} args
 */
export function buildQuickPlanspecRepairPrompt({ intent, appSlug, seamHook, maxStories = MAX_STORIES, stories, violations }) {
  const byId = new Map(stories.map((s) => [s.storyId, s.title]));
  const planLines = stories.map((s) => {
    const deps = (s.depends_on || []).map((d) => byId.get(d) || d).join(', ') || '(none)';
    return `- "${s.title}" — touches: ${concreteTouches(s).join(', ') || '(none)'} — dependsOn: ${deps}`;
  });
  const overSharded = (violations || []).some((v) => v.startsWith('over-sharded'));
  // The WIDTH directive (linear-chain / god-file) — unchanged legacy behavior.
  const widthDirective = [
    `Re-emit the FULL corrected <PLAN_SPEC> — every story, same quality rules. Keep the`,
    `same capabilities and acceptance criteria; change the DECOMPOSITION (touches must`,
    `be disjoint per-capability slices against the frozen foundation contract) and the`,
    `GRAPH (dependsOn = foundation only for slices; assemble depends on all) so that`,
    `every violation above is eliminated.`,
  ];
  // The COLLAPSE directive — fires when the audit found feature stories are not
  // actually independent (they share a snapshot root / runtime state machine).
  const collapseDirective = [
    ``,
    `# COLLAPSE — the audit found your slices are NOT truly independent`,
    `Your feature stories observe the same underlying runtime state (a shared snapshot`,
    `root) — that means they are not separable behind the contract; sharding them cost`,
    `width for nothing (the frontier still has to serialize on the shared state) and`,
    `risks the exact class of bug that ships when no mind ever runs the whole artifact`,
    `before commit. Choose ONE:`,
    `  (a) justify the sharding by naming TRULY independent seams — each feature slice`,
    `      must assert a DISTINCT snapshot root (its own field/branch of state), not the`,
    `      same one every other slice touches; or`,
    `  (b) set "planShape":"coherent" and emit EXACTLY ONE story — "Build the complete`,
    `      <app>" — touches:["src/**"], folding the contract + every capability +`,
    `      assemble + seam wiring into its intent and ACs (see the COHERENT SHAPE rules`,
    `      above).`,
    `Re-emit the FULL corrected <PLAN_SPEC> reflecting your choice.`,
  ];
  return [
    buildQuickPlanspecPrompt({ intent, appSlug, seamHook, maxStories }),
    ``,
    `# REPAIR PASS — your previous plan FAILED the parallelism audit`,
    `You already produced this plan:`,
    ...planLines,
    ``,
    `The deterministic audit rejected it:`,
    ...violations.map((v) => `- ${v}`),
    ``,
    ...widthDirective,
    ...(overSharded ? collapseDirective : []),
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
  /\b(types?|constants?|config(uration)?|setup|scaffold(ing)?|schema|enums?|interfaces?|boilerplate|registry|register|models?|contracts?|foundation|domain|(state|data) model)\b/i;
const INTEGRATION_RE =
  /\b(assembl\w*|integrat\w*|compose|composit\w*|end-to-end|full[- ](app|build|flow)|the complete)\b/i;
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
 * The shared-touch edge is a SAFETY rule (the frontier runs concurrent stories in one
 * shared tree with no merge) — the prompt's job is to make touches disjoint so it
 * rarely fires.
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

/** Does `fromId` reach `targetId` following depends_on edges? Pure DFS. */
function reaches(map, fromId, targetId) {
  const stack = [fromId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of map.get(id)?.depends_on ?? []) stack.push(d);
  }
  return false;
}

/**
 * Drop cycle-creating (and duplicate) edges deterministically: edges are accepted
 * in story-emission order, and an edge i→d is rejected iff d already reaches i
 * through accepted edges. The frontier would deadlock on a cycle
 * (unblockedDepsCount never hits zero), so this MUST run on model-authored deps.
 */
function breakCycles(stories) {
  const accepted = new Map(stories.map((s) => [s.storyId, { depends_on: [] }]));
  let dropped = 0;
  for (const s of stories) {
    const mine = accepted.get(s.storyId).depends_on;
    const seen = new Set();
    for (const d of s.depends_on) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (reaches(accepted, d, s.storyId)) { dropped += 1; continue; }
      mine.push(d);
    }
  }
  for (const s of stories) s.depends_on = accepted.get(s.storyId).depends_on;
  return dropped;
}

/**
 * Serialize genuinely co-eligible stories that share a concrete touch. Under the
 * frontier all concurrent stories share ONE working tree and a sibling's touches
 * are gate-DENIED — an unordered overlapping pair would block each other at dev
 * time. Adds the minimal edge (later story depends on earlier); returns the count
 * so the audit can surface it as lost width.
 */
function enforceScopeSafety(stories) {
  const map = new Map(stories.map((s) => [s.storyId, s]));
  const touchSets = stories.map((s) => new Set(concreteTouches(s)));
  let added = 0;
  for (let j = 1; j < stories.length; j++) {
    for (let i = 0; i < j; i++) {
      if (!touchSets[i].size || !touchSets[j].size) continue;
      let shared = false;
      for (const t of touchSets[i]) if (touchSets[j].has(t)) { shared = true; break; }
      if (!shared) continue;
      const a = stories[i].storyId;
      const b = stories[j].storyId;
      if (reaches(map, b, a) || reaches(map, a, b)) continue; // already ordered
      stories[j].depends_on.push(a);
      added += 1;
    }
  }
  return added;
}

/**
 * Normalize the dependency graph after parse:
 *  - model emitted NO deps → deriveDeps fallback (unchanged legacy behavior);
 *  - model-authored deps  → break cycles, anchor zero-dep non-foundation stories on
 *    the foundation (the contract must exist before a slice builds against it),
 *    make a final integration story depend on all, then add scope-safety edges.
 *
 * @returns {{ modelAuthored: boolean, cyclesDropped: number, safetyEdges: number }}
 */
function normalizeDeps(stories) {
  const meta = { modelAuthored: false, cyclesDropped: 0, safetyEdges: 0 };
  if (stories.length < 2) return meta;
  meta.modelAuthored = stories.some((s) => (s.depends_on?.length ?? 0) > 0);
  if (!meta.modelAuthored) {
    deriveDeps(stories);
    return meta;
  }
  meta.cyclesDropped += breakCycles(stories);
  // Contract-first anchor: a non-foundation story with no deps would dispatch at
  // t=0, before the contract files it implements against exist.
  const foundations = stories.filter((s) => classify(s) === 'foundation');
  const anchors = (foundations.length ? foundations : [stories[0]]).map((s) => s.storyId);
  const anchorSet = new Set(anchors);
  for (const s of stories) {
    if (anchorSet.has(s.storyId)) continue;
    if (!s.depends_on.length) s.depends_on = anchors.filter((id) => id !== s.storyId);
  }
  // The final assemble/integration story composes everything — it must run last.
  const last = stories[stories.length - 1];
  if (classify(last) === 'integration') {
    const have = new Set(last.depends_on);
    for (const s of stories) {
      if (s !== last && !have.has(s.storyId)) last.depends_on.push(s.storyId);
    }
  }
  meta.safetyEdges += enforceScopeSafety(stories);
  meta.cyclesDropped += breakCycles(stories); // anchor/assemble edges could close a loop
  return meta;
}

// A `snapshot.<field>` reference anywhere in an AC's prose (when/thenObservable/
// then/text) — same vocabulary browser-probe-executor's FIELD parses, but we only
// need the ROOT segment (the first identifier), not the full dotted/indexed path.
const SNAPSHOT_ROOT_RE = /snapshot(?:\(\))?\.([\w$]+)/gi;

/** The set of snapshot roots a story's ACs observe (across when/then/thenObservable/text). PURE. */
function snapshotRoots(story) {
  const roots = new Set();
  for (const ac of story.acceptanceCriteria || []) {
    const src = [ac.thenObservable, ac.then, ac.when, ac.text].filter((s) => typeof s === 'string' && s).join(' ');
    if (!src) continue;
    SNAPSHOT_ROOT_RE.lastIndex = 0;
    let m;
    while ((m = SNAPSHOT_ROOT_RE.exec(src))) roots.add(m[1]);
  }
  return roots;
}

/**
 * Detect the pacman6-class over-sharding smell: feature stories that LOOK
 * independent (disjoint touches) but all observe the SAME underlying runtime
 * state (one snapshot root) — i.e. they are coupled through one runtime state
 * machine and sharding bought nothing but fan-out tax. PURE.
 *
 * HONESTY: this is a coarse backstop, not a full coupling analysis. A dashboard
 * whose feature stories each assert their OWN distinct snapshot root (route /
 * auth / mutation / nav) will never trip it — that's a genuinely sharded app.
 * A pacman-shaped plan where every feature slice's behavioral AC asserts
 * `snapshot.entities` or `snapshot.status` WILL trip it, because that's exactly
 * the "6 blind slices around one game loop" shape the redesign targets.
 *
 * @param {object[]} stories
 * @param {{ threshold?: number }} [opts] fraction of feature stories that must
 *        share a root before it counts as coupling (default 0.6)
 * @returns {{ overSharded: boolean, sharedRoot?: string, coupledCount: number, featureCount: number }}
 */
export function detectOverSharding(stories, { threshold = 0.6 } = {}) {
  const features = (stories || []).filter((s) => classify(s) === 'feature');
  if (features.length < 3) return { overSharded: false, coupledCount: 0, featureCount: features.length };
  const freq = new Map();
  for (const s of features) {
    for (const root of snapshotRoots(s)) freq.set(root, (freq.get(root) || 0) + 1);
  }
  let sharedRoot;
  let coupledCount = 0;
  for (const [root, count] of freq) {
    if (count > threshold * features.length && count > coupledCount) {
      sharedRoot = root;
      coupledCount = count;
    }
  }
  if (!sharedRoot) return { overSharded: false, coupledCount: 0, featureCount: features.length };
  return { overSharded: true, sharedRoot, coupledCount, featureCount: features.length };
}

/**
 * Width/critical-path audit of a normalized story DAG. PURE — the deterministic
 * gate behind the runner's repair pass, and the metrics logged at ingest.
 *
 * Violations:
 *  - linear-chain: >2 consecutive single-story topo levels before the final level
 *    (false deps or shared files are serializing the build);
 *  - god-file: a concrete path touched by ≥2 FEATURE stories (feature↔feature
 *    sharing always costs width; foundation/assemble sharing is dep-ordered anyway);
 *  - over-sharded: >threshold of feature stories observe the same snapshot root —
 *    they're coupled through one runtime state machine and should collapse to
 *    planShape:'coherent' (see detectOverSharding).
 *
 * @returns {{ levels:number[], maxWidth:number, criticalPath:number, chainRun:number,
 *             godFiles:{path:string,stories:string[]}[], violations:string[],
 *             overSharded:boolean, sharedRoot?:string }}
 */
export function auditPlanGraph(stories) {
  if (!stories?.length) {
    return { levels: [], maxWidth: 0, criticalPath: 0, chainRun: 0, godFiles: [], violations: [], overSharded: false };
  }
  const levelMap = topoLevels(stories);
  const widths = [];
  for (const s of stories) {
    const lv = levelMap.get(s.storyId) ?? 0;
    widths[lv] = (widths[lv] || 0) + 1;
  }
  const levels = Array.from(widths, (w) => w || 0);
  const maxWidth = Math.max(...levels);
  const criticalPath = levels.length;

  const owners = new Map();
  for (const s of stories) {
    for (const t of concreteTouches(s)) {
      if (!owners.has(t)) owners.set(t, []);
      owners.get(t).push(s);
    }
  }
  const godFiles = [];
  for (const [path, ss] of owners) {
    const featureOwners = ss.filter((s) => classify(s) === 'feature');
    if (featureOwners.length >= 2) godFiles.push({ path, stories: featureOwners.map((s) => s.title) });
  }

  let run = 0;
  let chainRun = 0;
  for (let i = 0; i < levels.length - 1; i++) {
    run = levels[i] === 1 ? run + 1 : 0;
    chainRun = Math.max(chainRun, run);
  }

  const sharding = detectOverSharding(stories);

  const violations = [];
  if (chainRun > 2) {
    violations.push(
      `linear-chain: ${chainRun} consecutive single-story levels — false dependencies or shared files are serializing the build`,
    );
  }
  for (const g of godFiles) {
    violations.push(
      `god-file: "${g.path}" is touched by ${g.stories.length} feature stories (${g.stories.join(' | ')}) — split it into per-capability slice files`,
    );
  }
  if (sharding.overSharded) {
    violations.push(
      `over-sharded: ${sharding.coupledCount}/${sharding.featureCount} feature stories observe snapshot.${sharding.sharedRoot} — coupled through one runtime state machine; collapse to planShape:'coherent'`,
    );
  }
  return {
    levels,
    maxWidth,
    criticalPath,
    chainRun,
    godFiles,
    violations,
    overSharded: sharding.overSharded,
    sharedRoot: sharding.sharedRoot,
  };
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
 * storyIds, maps story-local slug ids in `dependsOn` to the minted storyIds, fills
 * sane defaults, normalizes the DAG, and audits it. Never throws.
 *
 * Each story also gets `nodeKind` ('foundation'|'feature'|'integration', mirroring
 * `classify`), `isFoundation` (nodeKind==='foundation'), and `invariants` (parsed
 * from the model's `invariants` field — malformed entries dropped, ids minted).
 *
 * @returns {{ stories: object[], errors: string[],
 *             audit: ReturnType<typeof auditPlanGraph> & { modelAuthored:boolean, cyclesDropped:number, safetyEdges:number },
 *             planShape: 'coherent'|'sharded', planShapeRationale: string }}
 */
export function parseQuickPlanspec(text, { maxStories = MAX_STORIES } = {}) {
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.stories) || obj.stories.length === 0) {
    return {
      stories: [],
      errors: ['no <PLAN_SPEC> stories JSON found in the output'],
      audit: auditPlanGraph([]),
      planShape: 'sharded',
      planShapeRationale: '',
    };
  }
  const errors = [];
  const raw = obj.stories.slice(0, maxStories);

  // Mint storyIds first so slug → storyId mapping covers forward references.
  const mintedIds = raw.map((s) => (typeof s.storyId === 'string' && s.storyId ? s.storyId : randomUUID()));
  const slugToId = new Map();
  raw.forEach((s, si) => {
    const slug = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : null;
    if (slug && !slugToId.has(slug)) slugToId.set(slug, mintedIds[si]);
  });

  const stories = raw.map((s, si) => {
    const storyId = mintedIds[si];
    const title = String(s.title || `Story ${si + 1}`).slice(0, 200);
    const acsIn = Array.isArray(s.acceptanceCriteria) && s.acceptanceCriteria.length
      ? s.acceptanceCriteria
      : [{ text: title, verify: 'build' }];
    const acceptanceCriteria = acsIn.map((ac, ai) => {
      const t = typeof ac.text === 'string' && ac.text.length >= 5 ? ac.text : `${ac.text || title} (criterion)`;
      const verify = VERIFY_VALUES.has(ac.verify) ? ac.verify : undefined;
      // needsBrowser means "this AC must be driven in the real app via the browser
      // probe executor" — i.e. it is genuinely APP-LEVEL behavior. Only verify:'behavior'
      // qualifies (plus an explicit model-authored needsBrowser:true). A pure
      // verify:'state' reducer AC or a verify:'appearance' (advisory, VQA-gated) AC is
      // NOT browser-required; the old `verify !== 'build'` rule wrongly flagged those,
      // which forced pure-function ACs down the browser path. when/thenObservable
      // authoring below is untouched — the browser probe parser still reads that prose.
      const needsBrowser = ac.needsBrowser === true || verify === 'behavior';
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
    const depsIn = Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === 'string') : [];
    const nodeKind = classify({ title, touches: touchesIn });
    const invariantsIn = Array.isArray(s.invariants) ? s.invariants : [];
    let invN = 0;
    const invariants = invariantsIn
      .filter(
        (inv) => inv && typeof inv === 'object' && typeof inv.description === 'string' && inv.description.trim().length >= 5,
      )
      .map((inv) => {
        invN += 1;
        const id = typeof inv.id === 'string' && inv.id.trim() ? inv.id.trim() : `${storyId}-inv${invN}`;
        return { id, description: inv.description.slice(0, 300), validator: { status: 'declared' } };
      });
    return {
      storyId,
      cohort: { epicId: 'quick', epicTitle: 'Quick' },
      title,
      intent: String(s.intent || s.description || title).slice(0, 400),
      acceptanceCriteria,
      depends_on: depsIn.map((d) => slugToId.get(d) || d),
      touches: touchesIn.length ? touchesIn : [EPIC_WIDE_TOUCH],
      forbiddenAreas: [],
      complexity: COMPLEXITY_VALUES.has(s.complexity) ? s.complexity : 'standard',
      nodeKind,
      isFoundation: nodeKind === 'foundation',
      invariants,
    };
  });

  // Filter deps to present ids (drop dangling), then normalize + audit the DAG.
  const present = new Set(stories.map((s) => s.storyId));
  for (const s of stories) s.depends_on = s.depends_on.filter((d) => present.has(d) && d !== s.storyId);
  const meta = normalizeDeps(stories);
  const audit = { ...auditPlanGraph(stories), ...meta };
  const planShape = obj.planShape === 'coherent' || obj.planShape === 'sharded'
    ? obj.planShape
    : (stories.length === 1 ? 'coherent' : 'sharded');
  const planShapeRationale = typeof obj.planShapeRationale === 'string' ? obj.planShapeRationale.slice(0, 300) : '';
  return { stories, errors, audit, planShape, planShapeRationale };
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
