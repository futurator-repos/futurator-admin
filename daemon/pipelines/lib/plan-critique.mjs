// plan-critique — the P0 adversarial "fresh eyes" pass on a just-generated
// plan_spec (pipeline-v3-redesign-fable5.md Part 2 P0 critique, Part 5 #8).
//
// ONE cheap spawn (reviewer-tier model) reads the plan the planner just wrote —
// which it did not write — and looks for exactly four defect classes: dropped
// capabilities, gameable ACs, wrong planShape, and missing seam wiring on the
// assemble/coherent story. PURE prompt-builder + tolerant parser; no I/O here
// (the runner does the spawning).

const EPIC_WIDE_TOUCH = '<EPIC_WIDE>';
const SEVERITY_VALUES = new Set(['critical', 'major', 'minor']);

function storyDeps(story) {
  return story.depends_on || story.dependsOn || [];
}

function storyTouches(story) {
  return (story.touches || []).filter((t) => t && t !== EPIC_WIDE_TOUCH);
}

/** Render one story (title/intent/touches/deps/ACs) as a few plain-text lines. */
function renderStory(story, byId) {
  const id = story.storyId || story.id || '(unknown)';
  const deps = storyDeps(story).map((d) => byId.get(d) || d).join(', ') || '(none)';
  const touches = storyTouches(story).join(', ') || '(none)';
  const acs = (story.acceptanceCriteria || []).map((ac) => {
    const flags = [ac.verify || 'build', ac.needsBrowser ? 'browser' : null].filter(Boolean).join(',');
    const observable = ac.when ? ` (when: ${ac.when} → thenObservable: ${ac.thenObservable || '(none)'})` : '';
    return `    - [${flags}] ${ac.text}${observable}`;
  });
  return [
    `- "${story.title}" (id: ${id}) — intent: ${story.intent || '(none)'} — touches: ${touches} — dependsOn: ${deps}`,
    ...acs,
  ].join('\n');
}

/**
 * Render the full plan as plain text for the critique prompt. Mirrors
 * quick-planspec.mjs's buildQuickPlanspecRepairPrompt story rendering, plus ACs
 * (the critic needs to see verify/needsBrowser/thenObservable to catch gameable ACs).
 */
function renderPlan(stories) {
  const list = stories || [];
  const byId = new Map(list.map((s) => [s.storyId || s.id, s.title]));
  return list.map((s) => renderStory(s, byId)).join('\n');
}

/**
 * The adversarial plan-critique prompt: ONE fresh, skeptical read of a just-
 * generated plan_spec, before it is ingested. PURE.
 *
 * @param {{ intent: string, appSlug: string, stories: object[], planShape?: string }} args
 */
export function buildPlanCritiquePrompt({ intent, appSlug, stories, planShape }) {
  const shape = planShape || 'unknown';
  return [
    `You are an ADVERSARIAL reviewer auditing a Pipeline-3 plan_spec BEFORE it is`,
    `built. You did NOT write this plan — read it with fresh, skeptical eyes. Find`,
    `real defects only; do not invent problems that aren't there.`,
    ``,
    `# The operator's idea`,
    intent,
    ``,
    `# The app`,
    `slug "${appSlug}"`,
    ``,
    `# The proposed plan (planShape: ${shape})`,
    renderPlan(stories),
    ``,
    `# Find defects along these FOUR dimensions ONLY`,
    `1. DROPPED / HOLLOW CAPABILITIES — does every capability the operator named in`,
    `   the idea above show up in some story's intent or acceptance criteria? Name`,
    `   anything dropped, or present in title only with no real AC behind it.`,
    `2. GAMEABLE ACs — any acceptance criterion whose real, user-facing behavior is`,
    `   verified ONLY by "build" or a unit test when it is actually a runtime`,
    `   behavior? Any \`thenObservable\` that asserts nothing real — a tautology, or a`,
    `   field that doesn't actually prove the capability happened?`,
    `3. WRONG SHAPE — this plan is shaped "${shape}". If the capabilities are tightly`,
    `   coupled through one runtime loop / one canvas / one state machine but were`,
    `   sharded into many blind slices anyway, or a large, cleanly separable app was`,
    `   jammed into one coherent story, flag it — echo the planShape you'd expect`,
    `   instead and why.`,
    `4. MISSING SEAM WIRING — does the assemble (or, if planShape is coherent, the`,
    `   single build-whole) story's acceptance criteria actually PROVE the live app`,
    `   state is routed through the scaffold's \`window.__harness\` seam, rather than`,
    `   a hand-rolled store/reducer that bypasses it?`,
    ``,
    `# Output — EXACTLY one JSON object inside the tags, nothing else:`,
    `<CRITIQUE>`,
    `{`,
    `  "findings": [`,
    `    { "severity": "critical|major|minor",`,
    `      "kind": "dropped-capability|gameable-ac|wrong-shape|missing-seam-wiring",`,
    `      "message": "specific and actionable",`,
    `      "storyId": "id of the affected story, if any" }`,
    `  ]`,
    `}`,
    `</CRITIQUE>`,
    ``,
    `Use "critical" ONLY for a defect that would ship a broken, hollow, or gamed app.`,
    `If the plan is genuinely sound, emit exactly { "findings": [] }.`,
  ].join('\n');
}

/** Extract the JSON object from a <CRITIQUE> block, a fenced block, or bare text. */
function extractCritiqueJson(text) {
  if (!text || typeof text !== 'string') return null;
  const tagged = text.match(/<CRITIQUE>\s*([\s\S]*?)\s*<\/CRITIQUE>/i);
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

/**
 * Parse the critic's output into a tolerant findings list. Never throws; garbage
 * or empty output → { findings: [], critical: false }. PURE.
 *
 * @returns {{ findings: {severity:'critical'|'major'|'minor', kind:string, message:string, storyId?:string}[], critical: boolean }}
 */
export function parsePlanCritique(text) {
  const obj = extractCritiqueJson(text);
  const raw = Array.isArray(obj?.findings) ? obj.findings : [];
  const findings = raw
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      severity: SEVERITY_VALUES.has(f.severity) ? f.severity : 'minor',
      kind: typeof f.kind === 'string' && f.kind.trim() ? f.kind.trim() : 'unspecified',
      message: typeof f.message === 'string' && f.message.trim() ? f.message.trim() : '(no message)',
      ...(typeof f.storyId === 'string' && f.storyId.trim() ? { storyId: f.storyId.trim() } : {}),
    }));
  return { findings, critical: hasCritical(findings) };
}

/** True iff any finding is severity:'critical'. PURE. */
export function hasCritical(findings) {
  return Array.isArray(findings) && findings.some((f) => f?.severity === 'critical');
}
