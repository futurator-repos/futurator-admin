/**
 * metrics-csv.mjs — Pipeline v2 Phase 2-A / Story 2-A-7-2 (PR-84).
 *
 * Tees `step_complete` events to `<plan-workingDir>/.pipeline/metrics.csv`
 * per v2.5 §19. The csv is the durable substrate that 3-C-6 distillation
 * + 3-E-7 wrap-it threshold read from at plan close — neither of those
 * stories can ship until this file exists.
 *
 * Schema (header row written on first append):
 *
 *   timestamp,planId,waveId,storyId,stepId,agentRole,durationMs,inputTokens,outputTokens,exitCode,numTurns
 *
 * Wave threshold check (v2.5 §19) — flags a wave whose step durations
 * exceed 1.5× the rolling cohort median. The rolling-median maintenance
 * happens client-side on each emit; the threshold check returns a list
 * of attention items for the daemon to emit.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const HEADER =
  'timestamp,planId,waveId,storyId,stepId,agentRole,durationMs,inputTokens,outputTokens,exitCode,numTurns\n';

/**
 * Append a single `step_complete` row. Lazily writes the header if the
 * file doesn't exist yet.
 *
 * @param {{
 *   workingDir: string,
 *   event: {
 *     timestamp?: string,
 *     planId: string,
 *     waveId?: string,
 *     storyId?: string,
 *     stepId: string,
 *     agentRole?: string,
 *     durationMs?: number,
 *     inputTokens?: number,
 *     outputTokens?: number,
 *     exitCode?: number,
 *     numTurns?: number,
 *   },
 * }} args
 * @returns {string} the path written to
 */
export function appendStepEvent({ workingDir, event }) {
  const path = csvPath(workingDir);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, HEADER, 'utf-8');
  }
  appendFileSync(path, formatRow(event), 'utf-8');
  return path;
}

function csvPath(workingDir) {
  return join(workingDir, '.pipeline', 'metrics.csv');
}

function csvEscape(value) {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatRow(event) {
  const cols = [
    event.timestamp || new Date().toISOString(),
    event.planId,
    event.waveId ?? '',
    event.storyId ?? '',
    event.stepId,
    event.agentRole ?? '',
    event.durationMs ?? '',
    event.inputTokens ?? '',
    event.outputTokens ?? '',
    event.exitCode ?? '',
    event.numTurns ?? '',
  ];
  return cols.map(csvEscape).join(',') + '\n';
}

/**
 * Read metrics.csv back into rows. Used by the cohort-aggregator + by
 * 3-C-6 distillation at plan close. Returns empty when file missing.
 *
 * @param {string} workingDir
 * @returns {Array<Record<string, string>>}
 */
export function readMetricsRows(workingDir) {
  const path = csvPath(workingDir);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  return parseCsv(text);
}

function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? '';
    out.push(row);
  }
  return out;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else if (c === '"' && cur.length === 0) {
      inQuote = true;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Rolling-median by (stepId, agentRole) — used as the cohort baseline
 * for wave-level threshold checks per v2.5 §19. Returns
 * `Map<"<stepId>::<agentRole>", median>` over the supplied rows.
 */
export function computeRollingMedians(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const dur = Number(r.durationMs);
    if (!Number.isFinite(dur) || dur < 0) continue;
    const key = `${r.stepId}::${r.agentRole}`;
    const arr = buckets.get(key) ?? [];
    arr.push(dur);
    buckets.set(key, arr);
  }
  const out = new Map();
  for (const [key, arr] of buckets.entries()) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    out.set(key, median);
  }
  return out;
}

/**
 * Wave threshold check (v2.5 §19). Returns the list of (stepId,
 * agentRole) buckets whose median in the given wave exceeds
 * `multiplier`× the rolling cohort median. Default multiplier = 1.5.
 *
 * @param {{
 *   waveRows: Array<Record<string, string>>,
 *   cohortRows: Array<Record<string, string>>,
 *   multiplier?: number,
 * }} args
 * @returns {Array<{ stepId: string, agentRole: string, waveMedian: number, cohortMedian: number, ratio: number }>}
 */
export function checkWaveThreshold({ waveRows, cohortRows, multiplier = 1.5 }) {
  const wave = computeRollingMedians(waveRows);
  const cohort = computeRollingMedians(cohortRows);
  const flagged = [];
  for (const [key, waveMedian] of wave.entries()) {
    const cohortMedian = cohort.get(key);
    if (cohortMedian == null || cohortMedian === 0) continue;
    const ratio = waveMedian / cohortMedian;
    if (ratio > multiplier) {
      const [stepId, agentRole] = key.split('::');
      flagged.push({ stepId, agentRole, waveMedian, cohortMedian, ratio });
    }
  }
  return flagged.sort((a, b) => b.ratio - a.ratio);
}
