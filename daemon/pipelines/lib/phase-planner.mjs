// phase-planner.mjs — Refactoring Scan Engine v2, the phased plan generator (design §5).
//
// Turns a flat, adjudicated ScanFinding[] pool into an ORDERED Phase 0..N plan
// via a topological sort over a REWORK-dependency DAG — NOT a severity sort.
// Severity-first forces re-touching the same files 3× as later phases re-extract;
// foundations-first (shared constants/contracts → helpers → UI → god-files →
// correctness → scale) minimizes that rework.
//
// Pure JS — no I/O, no LLM. The characterization-net safety check is INJECTED
// (opts.checkSequence) so this stays unit-testable and so the daemon can wire the
// real findCharacterizationGateViolations on the linearized sequence.
//
// Operates on ScanFinding-shaped objects (see functions/shared/schemas/scan-finding-schema.ts):
//   { id, dimension, area, severity, effort, location, issue, suggestion,
//     evidence:{ hotspotKind?, isFoundation?, isDeletion?, mechanical?,
//                foundationKind?, extractOf?, importers? }, dependsOn:[] }

const SEV = ['High', 'Medium', 'Low–Med', 'Low'];
const EFF = ['Trivial', 'Small', 'Medium', 'Large'];
const sevRank = (s) => { const i = SEV.indexOf(s); return i < 0 ? SEV.length : i; };
const effRank = (e) => { const i = EFF.indexOf(e); return i < 0 ? EFF.length : i; };

export const PHASE_NAMES = [
  'Stop-the-bleeding (Trivial)',
  'Shared constants & contracts (foundations)',
  'Shared infrastructure helpers',
  'UI centralization',
  'God-file decomposition',
  'Correctness fixes',
  'Scale & quality (optional)',
];

// One-line "why this precedes the next" rework-minimization proof per phase.
const PHASE_WHY = [
  'Free, mechanical; reduces confusion for every later diff.',
  'Every later extraction lands on these contracts/constants.',
  'Build the helpers before the UI/decomposition that consume them.',
  'Build the domain-component tier on now-settled constants & types.',
  'Cheap to split once the shared helpers exist.',
  'Now isolated behind one shared seam → fix in one place.',
  'Largest, lowest-urgency; benefits from all prior phases.',
];

const has = (s, re) => typeof s === 'string' && re.test(s);

// Band-routing signals derived from the finding's issue+suggestion TEXT — needed
// because LLM findings (the bulk) don't carry the structural evidence hints the
// deterministic mapper attaches. Tuned against the first real-app run (applicator-
// onboarding, 271 findings) where magic-numbers, hand-rolled-UI, and Trivial
// quick-wins were all collapsing into Phase 5.
const FOUNDATION_RE =
  /\bmagic numbers?\b|\bcentraliz|\bnamed constants?\b|\bsingle source of truth\b|\bscattered\b[^.]{0,40}\bconstants?\b|\bhard-?coded\b[^.]{0,40}\b(constant|threshold|limit)\b|\bshould be (a |an )?(named )?constants?\b|\bnot reusing\b[^.]{0,30}\bcentralized\b|\bconstants?\b[^.]{0,30}\bduplicat|\bduplicat\w*\b[^.]{0,30}\bconstants?\b/i;
const HELPER_RE =
  /\bextract\b[^.]{0,40}\b(helper|function|util|service)\b|\bshared (helper|util|function)\b|\bwitherrorhandling\b|\bapifetch\b|\bbatch(put|delete|write)\b|\bmakeeventid\b|\bemitevent\b|\bduplicat\w*\b[^.]{0,30}\blogic\b|\bconsolidat\w*\b[^.]{0,30}\b(logic|function|implementation|helper)\b|\bupsertfileversioned\b/i;
const UI_RE =
  /\bhand-?rolled\b|\binline (style|color|class)\b|\bhard-?coded\b[^.]{0,30}\b(color|inline)\b|\bbadges?\b|\bpills?\b|\bcallout\b|\bdesign system\b|\bcentralized (badge|component)\b|\bdomain component\b|\bshould (be |use )(a )?(shared|centralized) component\b/i;
const SCALE_RE = /\bauth(oriz|enticat)?\b|\bpaginat|\bgsi\b|\bbackground job\b|\bthroughput\b|\bo\(n/i;

/**
 * Heuristic initial band (0..6) for a finding (§5.4 canonical ladder). Uses the
 * deterministic evidence hints when present, else the issue+suggestion text so
 * LLM findings route correctly too.
 */
export function assignBand(f) {
  const e = f.evidence || {};
  const kind = e.hotspotKind || '';
  const sug = f.suggestion || '';
  const txt = `${f.issue || ''} ${sug}`;
  const eff = f.effort;
  const sev = f.severity;

  // Phase 0 — stop-the-bleeding: ALL dead code (delete candidates, gated downstream)
  // + mechanical fixes.
  if (e.mechanical) return 0;
  if (kind === 'dead-code') return 0;

  // Deterministic structural kinds route by KIND first (reliable, no text guessing).
  if (kind === 'design-system-consolidation') return 3; // UI
  if (kind === 'duplicate-subsystem' || e.helperExtraction) return 2; // helpers
  if (kind === 'god-object' || e.godFile) return 4; // god-file
  if (e.foundationKind === 'contract' || e.foundationKind === 'constant' || e.foundationKind === 'type') return 1;

  // Text-based routing for LLM findings (no evidence hints). UI precedence over the
  // generic "centralize" token so "centralized Badge component" → UI, not foundations.
  if (f.area === 'UI' || f.dimension === 'ui' || UI_RE.test(txt)) return 3;
  if ((e.isFoundation && has(sug, /\b(constant|threshold|envelope|contract|type|schema|enum)\b/i)) || FOUNDATION_RE.test(txt)) return 1;
  if (HELPER_RE.test(txt)) return 2;

  // Phase 6 — scale & quality (largest, lowest urgency).
  if (eff === 'Large' && (f.dimension === 'safety-security' || SCALE_RE.test(txt))) return 6;

  // Phase 0 (quick-wins) — Trivial, isolated, urgent fixes that need no shared seam.
  if (eff === 'Trivial' && (sev === 'High' || sev === 'Medium')) return 0;

  // Phase 5 — correctness/safety fixes (the entangled remainder).
  if (f.dimension === 'correctness' || f.dimension === 'safety-security' || f.dimension === 'compliance') return 5;
  if (f.dimension === 'architecture') return 2;
  return 5;
}

/**
 * Derive extra dependsOn edges deterministically (§5.2), layered onto any the
 * aggregator already set:
 *   (1) Foundation-before-consumer — a finding that consumes a shared artifact a
 *       foundation finding introduces gets dependsOn:[foundation].
 *   (2) Strangler-Fig — a deletion sub-finding dependsOn its extract/repoint
 *       sub-findings (matched via evidence.extractOf / shared location root).
 * Returns a NEW finding array (does not mutate inputs).
 */
export function deriveDependencies(findings) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  // (1) foundation artifacts: a foundation finding "introduces X"; consumers reference X.
  const foundations = findings.filter((f) => (f.evidence || {}).isFoundation || assignBand(f) === 1);
  // index foundations by the artifact token they introduce (from evidence.artifact or suggestion noun)
  const foundationByArtifact = new Map();
  for (const f of foundations) {
    const art = (f.evidence || {}).artifact;
    if (art) foundationByArtifact.set(String(art).toLowerCase(), f.id);
  }

  return findings.map((f) => {
    const deps = new Set(f.dependsOn || []);
    const e = f.evidence || {};
    // (1) consumer → foundation
    const consumes = e.consumesArtifact ? [].concat(e.consumesArtifact) : [];
    for (const c of consumes) {
      const fid = foundationByArtifact.get(String(c).toLowerCase());
      if (fid && fid !== f.id) deps.add(fid);
    }
    // (2) Strangler-Fig: a deletion dependsOn its extract/repoint
    if (e.isDeletion && e.extractOf) {
      for (const x of [].concat(e.extractOf)) if (byId.has(x) && x !== f.id) deps.add(x);
    }
    return { ...f, dependsOn: [...deps].filter((d) => byId.has(d)) };
  });
}

/** Topologically order ids honoring deps; ties broken by severity then effort then id. */
function topoOrder(findings) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const indeg = new Map(findings.map((f) => [f.id, 0]));
  const adj = new Map(findings.map((f) => [f.id, []]));
  for (const f of findings) {
    for (const d of f.dependsOn || []) {
      if (!byId.has(d)) continue;
      adj.get(d).push(f.id);
      indeg.set(f.id, indeg.get(f.id) + 1);
    }
  }
  const cmp = (a, b) =>
    sevRank(byId.get(a).severity) - sevRank(byId.get(b).severity) ||
    effRank(byId.get(a).effort) - effRank(byId.get(b).effort) ||
    String(a).localeCompare(String(b));
  // Kahn with a deterministic ready-set (stable, severity-first within available).
  let ready = findings.filter((f) => indeg.get(f.id) === 0).map((f) => f.id);
  const out = [];
  const seen = new Set();
  while (ready.length) {
    ready.sort(cmp);
    const id = ready.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const n of adj.get(id)) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) ready.push(n);
    }
  }
  // Cycle fallback: append any unseen (cycle-broken) in deterministic order.
  for (const f of [...findings].sort((a, b) => cmp(a.id, b.id))) if (!seen.has(f.id)) out.push(f.id);
  return out;
}

/**
 * Build the phased plan.
 * @param {Array} rawFindings  adjudicated ScanFinding[]
 * @param {object} [opts]
 *   - checkSequence(orderedFindings) → [{ findingId?, reason }]  (char-net gate; optional)
 * @returns {{ phases: Array<{phase,name,why,items:string[],tag:string}>,
 *             order: string[], violations: Array, dag: Array<{from,to}> }}
 */
export function planPhases(rawFindings, opts = {}) {
  const findings = deriveDependencies(rawFindings || []);
  const byId = new Map(findings.map((f) => [f.id, f]));

  // 1. initial band.
  const band = new Map(findings.map((f) => [f.id, assignBand(f)]));
  // 2. propagate: a finding may be PULLED LATER (never earlier) if a dep sits later.
  //    Fixpoint over deps (DAG → converges; cycle-safe via iteration cap).
  for (let pass = 0; pass < findings.length + 1; pass++) {
    let changed = false;
    for (const f of findings) {
      for (const d of f.dependsOn || []) {
        if (!byId.has(d)) continue;
        if (band.get(d) > band.get(f.id)) { band.set(f.id, band.get(d)); changed = true; }
      }
    }
    if (!changed) break;
  }

  // 3. global topo order, then 4. bucket into phase bands.
  const order = topoOrder(findings);
  const buckets = Array.from({ length: PHASE_NAMES.length }, () => []);
  for (const id of order) buckets[band.get(id)].push(id);

  // 5. safety pass: char-net gate on the linearized sequence (injected).
  let violations = [];
  if (typeof opts.checkSequence === 'function') {
    violations = opts.checkSequence(order.map((id) => byId.get(id))) || [];
  }

  const phases = buckets
    .map((items, i) => ({
      phase: i,
      name: PHASE_NAMES[i],
      why: PHASE_WHY[i],
      tag: phaseTag(items.map((id) => byId.get(id))),
      items,
    }))
    .filter((p) => p.items.length > 0);

  const dag = [];
  for (const f of findings) for (const d of f.dependsOn || []) if (byId.has(d)) dag.push({ from: d, to: f.id });

  return { phases, order, violations, dag };
}

/** A short clarity/effort tag for a phase, e.g. "High clarity" or "Large". */
function phaseTag(items) {
  if (!items.length) return '';
  const efforts = items.map((f) => f.effort);
  if (efforts.every((e) => e === 'Trivial' || e === 'Small')) return 'Low effort, high clarity';
  if (efforts.some((e) => e === 'Large')) return 'Larger effort';
  return 'Medium effort';
}

// Mirrors findCharacterizationGateViolations' DELETION_RE: ANY mutator (not just
// delete) must sit behind a characterization net — extract/repoint/consolidate
// (god-file splits, dedup) count too.
const MUTATOR_RE = /\b(delete|remove|drop|retire|repoint|consolidat|migrat|extract)\b/i;
const storyText = (f) => `${f.issue || ''} ${f.suggestion || ''}`;
const isMutatorFinding = (f) => {
  const e = f.evidence || {};
  return !!e.isDeletion || e.hotspotKind === 'dead-code' || MUTATOR_RE.test(storyText(f));
};
const needsGrepZero = (f) => {
  const e = f.evidence || {};
  return !!e.isDeletion || e.hotspotKind === 'dead-code' || e.hotspotKind === 'duplicate-subsystem';
};

/**
 * Emit a planOutputSchema-shaped object (epics/stories) from the phased plan, for
 * hand-off into create-story/dev-story. Phase N → epic E{n+1}; phases chain via
 * epic.dependsOn; story ids are S{global}. Any phase containing a deletion gets a
 * leading characterization-net story (needsBrowser) that every deletion story in
 * that phase dependsOn — so findCharacterizationGateViolations passes by
 * construction (Strangler-Fig: net before any delete/repoint).
 */
export function toPlanOutput(plan, findingsById) {
  let sCounter = 0;
  const sid = () => `S${++sCounter}`;
  const epics = plan.phases.map((p, idx) => {
    const epicNum = idx + 1;
    const items = p.items.map((id) => findingsById.get(id) || { id });
    const hasMutator = items.some(isMutatorFinding);
    const stories = [];
    const storyIdByFinding = new Map();

    // Leading characterization net for phases that mutate untested code.
    let netId = null;
    if (hasMutator) {
      netId = sid();
      stories.push({
        id: netId,
        title: `Characterization net for Phase ${p.phase} — ${p.name}`,
        description:
          'Add a thin characterization test net (Playwright/smoke + golden baselines) over the routes this phase deletes or repoints, BEFORE any mutation, so behavior is pinned.',
        dependsOn: [],
        touchPoints: ['<EPIC_WIDE>'],
        criteria: [
          { id: 'C1', text: 'A passing characterization net exists for every route this phase touches', needsBrowser: true, verify: 'behavior' },
        ],
      });
    }

    for (const f of items) {
      const s = sid();
      storyIdByFinding.set(f.id, s);
      const mutator = isMutatorFinding(f);
      const sameEpicDeps = (f.dependsOn || [])
        .map((d) => storyIdByFinding.get(d))
        .filter(Boolean);
      const dependsOn = [...sameEpicDeps];
      if (mutator && netId) dependsOn.push(netId);
      stories.push({
        id: s,
        title: (f.issue || f.id).slice(0, 200),
        description: f.suggestion || f.issue || 'Apply the remediation for this finding.',
        dependsOn: [...new Set(dependsOn)],
        touchPoints: [f.location].filter(Boolean).length ? [f.location] : ['<EPIC_WIDE>'],
        criteria: needsGrepZero(f)
          ? [{ id: 'C1', text: 'grep-zero for the removed symbol and the existing test suite passes', needsBrowser: false, verify: 'build' }]
          : [{ id: 'C1', text: f.suggestion || 'Change applied; tests pass', needsBrowser: false, verify: 'build' }],
      });
    }

    return {
      id: `E${epicNum}`,
      title: `Phase ${p.phase} — ${p.name}`,
      goal: p.why,
      dependsOn: epicNum > 1 ? [`E${epicNum - 1}`] : [],
      stories,
    };
  });
  return { plan: { epics } };
}
