/**
 * retro-scan-skills.mjs — Skills Institution, Story 4.1 (2026-06-17).
 *
 * One-time (idempotent) Gate-1 retro-scan of the incumbent registry: every skill
 * that predates the Institution carries NO securityStatus/trustTier, yet the
 * scout treats them as installable. This script runs the SAME deterministic
 * Gate-1 scanner over each body and stamps real facets so none wears a trust it
 * didn't earn — while grandfathering the established working set so prod keeps
 * running (see Story 4.2: clean skills on this canonical AUTO-TRUST registry are
 * stamped `trusted`, not `reviewed`; a freshly-pulled community skill would get
 * `reviewed` and stay un-installable until ratified).
 *
 * Operates on a LOCAL checkout of `futurator-repos/futurator-skills` (same
 * pattern as ingest-skills.mjs): reads index.json + skills/<name>/SKILL.md,
 * writes the faceted index.json back, and appends REPORT.md. The operator
 * commits + pushes the result.
 *
 * Idempotent + safe:
 *   - securityStatus is ALWAYS refreshed from the live scan.
 *   - trustTier is PRESERVED when already set (never clobbers an operator ratify
 *     or deprecate); only un-stamped entries are graded.
 *   - framework (index-only, body-less) skills are constitutional → trusted,
 *     securityStatus unverified (nothing to scan).
 *
 * Usage:
 *   node scripts/retro-scan-skills.mjs [registryDir] [--dry-run] [--tier-on-pass=trusted|reviewed]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSkill } from '../daemon/lib/security-scan.mjs';

/**
 * Pure core: grade every entry. `readBody(name)` returns the SKILL.md body or
 * null (framework/body-less). Returns the updated skills array + a report.
 *
 * @param {object} args
 * @param {{ skills: Array<object> }} args.index
 * @param {(name: string) => string | null} args.readBody
 * @param {'trusted'|'reviewed'} [args.tierOnPass]
 * @param {() => string} [args.now]
 */
export function retroScanIndex({ index, readBody, tierOnPass = 'trusted', now = () => new Date().toISOString() }) {
  const report = {
    at: now(),
    scanned: 0,
    clean: 0,
    flagged: 0,
    quarantined: 0,
    frameworkSkipped: 0,
    bodyMissing: 0,
    perQuarantine: /** @type {Array<{ name: string, patterns: string[] }>} */ ([]),
  };

  const skills = (index.skills ?? []).map((entry) => {
    const next = { ...entry };

    if (entry.framework) {
      report.frameworkSkipped += 1;
      next.securityStatus = entry.securityStatus ?? 'unverified';
      next.trustTier = entry.trustTier ?? 'trusted'; // platform-owned, constitutional
      next.provenanceClass = entry.provenanceClass ?? 'constitutional';
      return next;
    }

    const body = readBody(entry.name);
    if (body == null) {
      report.bodyMissing += 1;
      next.securityStatus = entry.securityStatus ?? 'unverified';
      next.trustTier = entry.trustTier ?? 'draft';
      return next;
    }

    const scan = scanSkill({ body });
    report.scanned += 1;
    next.securityStatus = scan.securityStatus;
    if (scan.securityStatus === 'quarantined') {
      report.quarantined += 1;
      report.perQuarantine.push({
        name: entry.name,
        patterns: [...new Set(scan.patternsHit.filter((h) => h.severity === 'blocking').map((h) => h.id))],
      });
      // A failed scan never grants trust; leave/seed as draft (not installable).
      next.trustTier = entry.trustTier && entry.trustTier !== 'trusted' ? entry.trustTier : 'draft';
    } else {
      if (scan.securityStatus === 'flagged') report.flagged += 1;
      else report.clean += 1;
      // Grandfather: only stamp a tier when none exists (preserve operator decisions).
      next.trustTier = entry.trustTier ?? tierOnPass;
    }
    next.provenanceClass = entry.provenanceClass ?? 'vendored';
    if (next.qualityGrade === undefined) next.qualityGrade = 'ungraded';
    return next;
  });

  return { skills, report };
}

/** Render a REPORT.md section for one retro-scan pass. */
export function renderReport(report) {
  const lines = [
    `## Retro-scan ${report.at}`,
    '',
    `- scanned: ${report.scanned} (clean ${report.clean}, flagged ${report.flagged}, quarantined ${report.quarantined})`,
    `- framework (constitutional, skipped): ${report.frameworkSkipped}`,
    `- body missing (index-only): ${report.bodyMissing}`,
  ];
  if (report.perQuarantine.length > 0) {
    lines.push('', '### Quarantined');
    for (const q of report.perQuarantine) {
      lines.push(`- \`${q.name}\` — ${q.patterns.join(', ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tierArg = args.find((a) => a.startsWith('--tier-on-pass='));
  const tierOnPass = tierArg ? tierArg.split('=')[1] : 'trusted';
  const registryDir = args.find((a) => !a.startsWith('--')) ?? process.cwd();

  const indexPath = join(registryDir, 'index.json');
  if (!existsSync(indexPath)) {
    console.error(`retro-scan: no index.json at ${indexPath}`);
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  const readBody = (name) => {
    const p = join(registryDir, 'skills', name, 'SKILL.md');
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };

  const { skills, report } = retroScanIndex({ index, readBody, tierOnPass });
  const reportMd = renderReport(report);
  console.log(reportMd);

  if (dryRun) {
    console.log('[dry-run] no files written.');
    return;
  }

  writeFileSync(indexPath, `${JSON.stringify({ ...index, skills }, null, 2)}\n`, 'utf-8');
  const reportPath = join(registryDir, 'REPORT.md');
  const existing = existsSync(reportPath)
    ? readFileSync(reportPath, 'utf-8')
    : '# Skills Registry — Curation Report\n';
  writeFileSync(reportPath, `${existing.replace(/\s*$/, '')}\n\n${reportMd}`, 'utf-8');
  console.log(`retro-scan: wrote index.json (${skills.length} entries) + REPORT.md`);
}

// Run only as a CLI (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
