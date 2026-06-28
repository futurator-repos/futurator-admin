// scan-engine-prompts.mjs — Refactoring Scan Engine v2, B2.
//
// The LLM swarm's prompt builders + a loose findings parser/validator. Two
// layers (Mycelium's model): per-subsystem analyzers (local smells) + whole-repo
// cross-cutting passes (the breadth to see "27 copies across 22 routes"). Every
// pass is SEEDED with deterministic candidates ("confirm these sites"), never
// "go find smells", and forbidden from re-deriving repo structure (recon already
// did). Findings come back in a fixed ---FINDINGS--- envelope, ScanFinding-shaped.

export const SCAN_DIMENSIONS = ['architecture', 'safety-security', 'compliance', 'code-quality-refactoring', 'correctness'];
export const SCAN_SEVERITIES = ['High', 'Medium', 'Low–Med', 'Low'];
export const SCAN_EFFORTS = ['Trivial', 'Small', 'Medium', 'Large'];

const FINDING_SHAPE = `Each finding is an object:
{
  "dimension": one of ${JSON.stringify(SCAN_DIMENSIONS)},
  "severity": one of ${JSON.stringify(SCAN_SEVERITIES)},
  "effort": one of ${JSON.stringify(SCAN_EFFORTS)},
  "location": "relative/path.ts:LINE"  (a REAL path from the repo + a line number),
  "issue": "<12-word problem statement",
  "suggestion": "names exactly ONE concrete fix/centralized artifact",
  "evidence": { ...short structured pointers, NEVER a code dump... }
}
Return ONLY: ---FINDINGS---\n{"findings":[ ... ]}\n---END_FINDINGS---
Ground EVERY finding in a real file you read. Do not invent paths. Analysis only — no code.`;

/** Per-subsystem analyzer (Layer 1) — local smells, scoped to one shard. */
export function analyzerPrompt(shard) {
  const members = (shard.members || []).slice(0, 40);
  return `You are a senior engineer reviewing ONE subsystem of a codebase your working directory is the repo root. Do NOT re-derive the repo structure — it is given.

SUBSYSTEM: ${shard.name} (${shard.shardKey})
FOCUS (what's hot here, from deterministic recon): ${shard.focus}
FILES (read these with Read; they are the scoped set): ${JSON.stringify(members)}
DEPENDS ON: ${JSON.stringify((shard.depends || []).slice(0, 10))}

Find concrete refactoring/quality/correctness/safety issues IN THESE FILES that a structural graph cannot see: fragile parsing, missing error checks, unsafe casts, dead/parallel code, duplicated logic, magic numbers, leaky abstractions, contract drift. Prefer the files named in FOCUS.

${FINDING_SHAPE}`;
}

/**
 * Cross-cutting passes (Layer 2) — whole-repo breadth, each seeded with the
 * deterministic candidate sites recon already flagged. `seed` is a short string
 * of suspicious files/sites to CONFIRM (not a starting point to wander from).
 */
export const CROSS_CUTTING = [
  {
    area: 'error-handling',
    dimension: 'correctness',
    title: 'Error handling & contract drift',
    instruction: `Confirm and characterize INCONSISTENT/MISSING error handling across the repo: client fetches that never check res.ok, swallowed catches, divergent error envelopes ({error} vs {error:{code,message}}), and the same try/catch-to-500 tail copy-pasted across routes. Name the ONE helper/HOF that fixes each (apiFetch<T>, withErrorHandling, respondError).`,
  },
  {
    area: 'magic-numbers',
    dimension: 'code-quality-refactoring',
    title: 'Magic numbers & config drift',
    instruction: `Confirm scattered magic numbers / divergent thresholds (timeouts, caps like slice(-40), top-K, token budgets, hardcoded cutoffs) that bypass a central constants module, and any two config sources that disagree. Name the constant each should resolve to.`,
  },
  {
    area: 'type-safety',
    dimension: 'correctness',
    title: 'Type safety & unsafe casts',
    instruction: `Confirm unsafe casts (as any, as unknown as), weak unions missing an error variant, and stale dynamic imports that defeat type-checking. Name the typed alias / union member that fixes each.`,
  },
  {
    area: 'ui-centralization',
    dimension: 'architecture',
    title: 'UI centralization & design system',
    instruction: `Confirm repeated hand-rolled UI patterns (badges/pills, status indicators, dialogs, panel prop bundles, inline-styled re-implementations of an existing primitive) that should lift into a centralized DOMAIN component tier. For each: name the proposed component and EVERY file that should adopt it. Set dimension="architecture", area="UI".`,
  },
  {
    area: 'safety-security',
    dimension: 'safety-security',
    title: 'Safety & security',
    instruction: `Confirm safety/security issues: routes with no auth/authorization or ownership checks, user-controlled values interpolated into queries (Cypher/SQL) without clamp/validation, secrets/PII written to logs, unbounded/unpaginated queries that silently drop rows. Flag, don't fix.`,
  },
];

export function crossCuttingPrompt(pass, seed) {
  return `You are auditing an ENTIRE repository for ONE cross-cutting concern. Working dir is the repo root. Use Grep/Read. Do NOT map the whole repo — recon already did; focus on confirming the concern.

CONCERN: ${pass.title}
${pass.instruction}

DETERMINISTIC CANDIDATE SITES to confirm first (recon flagged these; verify each, then sweep for siblings):
${seed || '(no pre-flagged candidates — sweep by pattern)'}

For each confirmed finding set dimension (default "${pass.dimension}"), severity, effort, a REAL location file:line, the issue, and the ONE centralized fix.
${FINDING_SHAPE}`;
}

/** The single aggregator/report-writer — writes the fixed-section markdown. */
export function reportWriterPrompt({ projectName, findings, phases, lowConfidence }) {
  return `You are the aggregator. Write a refactoring & system-design scan report as MARKDOWN for "${projectName}". This is an ASSESSMENT, not a spec: NO implementation code, NO [[wiki-links]]. Every finding must trace to a real path.

You are given the ALREADY-ADJUDICATED, DEDUPED finding pool (JSON) and the ALREADY-COMPUTED phased plan. Do NOT re-order phases or invent findings — synthesize prose from these inputs.

FINDINGS (JSON): ${JSON.stringify(findings)}

PHASED PLAN (deterministic topo-sort, DO NOT reorder): ${JSON.stringify(phases)}
${lowConfidence ? '\nNOTE: subsystem decomposition was LOW-CONFIDENCE (flat/degenerate structure) — say so in the summary.' : ''}

Required sections IN THIS ORDER:
1. # ${projectName} — Refactoring & System-Design Scan
2. A one-line > blockquote: assessment not spec; no code; every finding anchored to a path.
3. ## Executive Summary — 4-6 numbered themes, each a BOLD lead clause naming the smell-class + 1-3 sentences citing file:line exemplars; close with one paragraph of correctness risks that sit on top.
4. ## Priority Matrix — a table with columns EXACTLY: Finding | Severity | Effort | Area. Every finding once, sorted High→Low.
5. ## By Dimension — group findings under ### architecture / ### safety-security / ### compliance / ### code-quality-refactoring / ### correctness.
6. ## Recommended Sequencing — restate the given phases as **Phase N — <name> (<tag>).** + a paragraph naming the items and WHY they precede later phases.

Write ONLY the markdown report (it will be saved verbatim).`;
}

// ── loose parse + validate ──

/** Extract the findings array from an agent's ---FINDINGS--- envelope (tolerant). */
export function parseFindings(text) {
  if (!text || typeof text !== 'string') return [];
  const m = text.match(/---FINDINGS---\s*([\s\S]*?)\s*---END_FINDINGS---/);
  const raw = m ? m[1] : text;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const brace = raw.match(/\{[\s\S]*\}/);
    if (!brace) return [];
    try { parsed = JSON.parse(brace[0]); } catch { return []; }
  }
  return Array.isArray(parsed?.findings) ? parsed.findings : Array.isArray(parsed) ? parsed : [];
}

const slug = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);

/**
 * Normalize+validate one raw LLM finding → ScanFinding, or null if unusable.
 * @param {object} raw
 * @param {object} ctx { area, dimension }  defaults for the pass
 */
export function validateFinding(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const location = String(raw.location || '').trim();
  const issue = String(raw.issue || '').trim();
  const suggestion = String(raw.suggestion || '').trim();
  if (!location || !issue || !suggestion) return null;
  const dimension = SCAN_DIMENSIONS.includes(raw.dimension) ? raw.dimension : (ctx.dimension || 'code-quality-refactoring');
  const severity = SCAN_SEVERITIES.includes(raw.severity) ? raw.severity : 'Medium';
  const effort = SCAN_EFFORTS.includes(raw.effort) ? raw.effort : 'Medium';
  return {
    id: `llm:${ctx.area || dimension}:${slug(location)}:${slug(issue)}`,
    dimension,
    area: String(raw.area || ctx.area || 'cross-cutting'),
    severity,
    effort,
    location,
    issue: issue.slice(0, 240),
    suggestion: suggestion.slice(0, 400),
    evidence: raw.evidence && typeof raw.evidence === 'object' ? raw.evidence : {},
    source: 'llm',
    dependsOn: [],
  };
}

/** Parse + validate an agent's whole output into normalized findings. */
export function parseAndValidate(text, ctx = {}) {
  return parseFindings(text).map((r) => validateFinding(r, ctx)).filter(Boolean);
}
