// scan-finding-map.mjs — Refactoring Scan Engine v2, B1 mappers.
//
// Maps DETERMINISTIC recon rows (hotspot-detect kinds, privacy categories) into
// the canonical ScanFinding shape (functions/shared/schemas/scan-finding-schema.ts),
// attaching the evidence HINTS the phase-planner reads (hotspotKind, isFoundation,
// isDeletion, godFile, helperExtraction, foundationKind, safeCandidate, artifact).
// Also the anchored-path post-check that drops LLM findings whose file:line is not
// a real node in graph.resolved.json (hallucination guard). Pure JS — no I/O.

// hotspot severity (critical|high|medium|low) → ScanSeverity (High|Medium|Low–Med|Low)
const SEV_MAP = { critical: 'High', high: 'High', medium: 'Medium', low: 'Low' };
export const mapSeverity = (s) => SEV_MAP[String(s || '').toLowerCase()] || 'Medium';

// dimension per hotspot kind
const KIND_DIMENSION = {
  'god-object': 'architecture',
  'duplicate-subsystem': 'architecture',
  'design-system-consolidation': 'architecture',
  'low-cohesion-split': 'architecture',
  'dead-code': 'code-quality-refactoring',
};

const SHARD_PREFIX = '§sys:';
/** Parent-dir boundary of a relative path; root files fold under '.'. */
export function boundaryOf(rel) {
  const p = String(rel || '').replace(/^[./]+/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}
/** Stable shardKey for a boundary, matching subsystem-extract's '§sys:' convention. */
export function shardKeyForFile(rel) {
  return `${SHARD_PREFIX}${boundaryOf(rel).replace(/\//g, '--')}`;
}

const slug = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
const primaryFile = (h) => h?.evidence?.file || (Array.isArray(h?.files) ? h.files[0] : '') || '';

/** Effort heuristic — the one axis recon can't compute; sized from structural evidence. */
function effortForHotspot(h) {
  const e = h.evidence || {};
  switch (h.kind) {
    case 'dead-code':
      return e.confidence === 'safe-candidate' ? 'Trivial' : 'Small';
    case 'god-object':
      return (e.methods || 0) > 25 ? 'Large' : (e.methods || 0) > 12 ? 'Medium' : 'Small';
    case 'duplicate-subsystem': {
      const copies = e.count || e.totalFiles || (Array.isArray(e.copies) ? e.copies.length : 0);
      return copies > 4 ? 'Large' : 'Medium';
    }
    case 'design-system-consolidation':
      return (e.duplicatedComponents?.length || 0) > 3 ? 'Large' : 'Medium';
    case 'low-cohesion-split':
      return (e.size || 0) > 20 ? 'Large' : 'Medium';
    default:
      return 'Medium';
  }
}

/**
 * Map one hotspot-detect row → ScanFinding (source='deterministic').
 * @param {object} h    an AuditHotspot
 * @param {Set<string>} [hubs] high-fan-in files (for isFoundation tagging)
 */
export function hotspotToFinding(h, hubs = new Set()) {
  const file = primaryFile(h);
  const e = h.evidence || {};
  const isUI = h.kind === 'design-system-consolidation';
  const evidence = {
    hotspotKind: h.kind,
    score: h.score,
    ...(e.methods != null ? { methods: e.methods } : {}),
    ...(e.importers != null ? { importers: e.importers } : {}),
    ...(e.community != null ? { community: e.community } : {}),
  };
  if (h.kind === 'dead-code') {
    evidence.isDeletion = true;
    evidence.safeCandidate = e.confidence === 'safe-candidate';
  }
  if (h.kind === 'duplicate-subsystem') evidence.helperExtraction = true;
  if (h.kind === 'god-object') evidence.godFile = true;
  // A high-fan-in hub that other code lands on is a foundation seam.
  if (file && hubs.has(file)) evidence.isFoundation = true;

  return {
    id: `det:${h.kind}:${slug(file || h.title)}`,
    dimension: KIND_DIMENSION[h.kind] || 'code-quality-refactoring',
    area: isUI ? 'UI' : file ? shardKeyForFile(file) : 'cross-cutting',
    severity: mapSeverity(h.severity),
    effort: effortForHotspot(h),
    location: file ? `${file}:1` : (Array.isArray(h.files) && h.files[0] ? `${h.files[0]}:1` : 'multiple'),
    issue: h.title || `${h.kind} finding`,
    suggestion: h.suggestedAction || `Address the ${h.kind}`,
    evidence,
    source: 'deterministic',
    dependsOn: [],
  };
}

/**
 * Map a privacy category rollup (from summarizePrivacyReport) → ScanFinding[]
 * (dimension='compliance'). One finding per category per regulation — never
 * per-file (category-first; sample files ride in evidence).
 * @param {object} privacySummary  PrivacyAuditSummary { byRegulation:{[reg]:{categories:[...]}} }
 */
export function privacyToFindings(privacySummary) {
  const out = [];
  const byReg = privacySummary?.byRegulation || {};
  for (const reg of Object.keys(byReg)) {
    for (const cat of byReg[reg].categories || []) {
      const sample = (cat.sampleFiles || [])[0]?.file;
      out.push({
        id: `priv:${reg}:${slug(cat.category)}`,
        dimension: 'compliance',
        area: sample ? shardKeyForFile(sample) : 'cross-cutting',
        severity: mapSeverity(cat.severity),
        effort: cat.fileCount > 10 ? 'Large' : cat.fileCount > 3 ? 'Medium' : 'Small',
        location: sample ? `${sample}:1` : 'multiple',
        issue: cat.category,
        suggestion: cat.remediation || 'Review and remediate per the cited regulation.',
        evidence: { regulation: reg, fileCount: cat.fileCount, citation: cat.citation, compliance: true },
        source: 'deterministic',
        dependsOn: [],
      });
    }
  }
  return out;
}

/** The path portion of a "path:line" location (or the whole thing). */
export function locPath(location) {
  const s = String(location || '');
  const m = s.match(/^(.*?):\d+$/);
  return m ? m[1] : s;
}

/**
 * Anchored-path post-check: keep deterministic findings always; keep LLM findings
 * only if their file exists in the recon node set (drops hallucinations). Sentinel
 * locations ('multiple', 'cross-cutting', '<EPIC_WIDE>') always pass.
 * @param {Array} findings
 * @param {Set<string>} anchoredPaths  source_file set from graph.resolved.json
 */
export function dropUnanchored(findings, anchoredPaths) {
  const SENTINELS = new Set(['multiple', 'cross-cutting', '<EPIC_WIDE>', '']);
  return (findings || []).filter((f) => {
    if (f.source === 'deterministic') return true;
    const p = locPath(f.location);
    if (SENTINELS.has(p)) return true;
    return anchoredPaths.has(p);
  });
}
