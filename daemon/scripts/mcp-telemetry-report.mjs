/**
 * mcp-telemetry-report.mjs — Story 4.3 aggregation (PRD W3/G8).
 *
 * Reads the append-only `knowledge/_graph/mcp-telemetry.jsonl` sink and reports,
 * from DATA (never a borrowed figure):
 *
 *   - adoption rate: % of eligible DEV steps that actually called the MCP
 *     (`adoptedStories / eligibleSteps`, where eligibleSteps is supplied by the
 *     caller — the bench harness knows how many DEV steps were eligible);
 *   - token delta: measured context-tokens (the structured result that lands in
 *     the agent's context = `tokensOut`) for eligible invocations vs. the
 *     grep+raw-read baseline. Positive = savings. The baseline is MEASURED and
 *     passed in — no external number is asserted.
 *
 * Pure `aggregateTelemetry` is unit-tested; the CLI just reads the file.
 */

import { readFile } from 'fs/promises';
import { parseTelemetry } from '../mcp/telemetry.mjs';

/** Tools whose use is the "token lever" we measure adoption + savings for. */
export const ELIGIBLE_TOOLS = ['blast_radius', 'query_graph'];

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const round = (n) => Math.round(n * 100) / 100;

/**
 * Aggregate telemetry records into an adoption + token-savings report.
 *
 * @param {Array<object>} records - telemetry records (see telemetry.mjs shape).
 * @param {object} [opts]
 * @param {number} [opts.eligibleSteps] - total DEV steps eligible to call the MCP
 *   (denominator for adoption). If omitted, adoptionRate is null.
 * @param {number} [opts.baselineContextTokens] - measured grep+raw-read context
 *   tokens for the baseline arm. If omitted, tokenDelta is null.
 */
export function aggregateTelemetry(records, opts = {}) {
  const byTool = {};
  for (const r of records) {
    const t = (byTool[r.tool] ??= { count: 0, tokensIn: 0, tokensOut: 0, fallbacks: 0 });
    t.count += 1;
    t.tokensIn += r.tokensIn ?? 0;
    t.tokensOut += r.tokensOut ?? 0;
    if (r.fallbackUsed) t.fallbacks += 1;
  }

  const eligible = records.filter((r) => ELIGIBLE_TOOLS.includes(r.tool));
  const adoptedStories = new Set(
    eligible.filter((r) => r.storyId != null).map((r) => r.storyId),
  ).size;
  const avgContextTokens = round(avg(eligible.map((r) => r.tokensOut ?? 0)));
  const fallbacks = eligible.filter((r) => r.fallbackUsed).length;

  const adoptionRate =
    opts.eligibleSteps && opts.eligibleSteps > 0
      ? round(adoptedStories / opts.eligibleSteps)
      : null;
  const tokenDelta =
    typeof opts.baselineContextTokens === 'number'
      ? round(opts.baselineContextTokens - avgContextTokens)
      : null;

  return {
    totalInvocations: records.length,
    byTool,
    eligibleInvocations: eligible.length,
    adoptedStories,
    adoptionRate,
    avgContextTokens,
    baselineContextTokens: opts.baselineContextTokens ?? null,
    tokenDelta,
    fallbackRate: eligible.length ? round(fallbacks / eligible.length) : 0,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { file: 'knowledge/_graph/mcp-telemetry.jsonl' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) a.file = argv[++i];
    else if (argv[i] === '--eligible-steps' && argv[i + 1]) a.eligibleSteps = Number(argv[++i]);
    else if (argv[i] === '--baseline-tokens' && argv[i + 1]) a.baselineContextTokens = Number(argv[++i]);
    else if (argv[i] === '--json') a.json = true;
  }
  return a;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('mcp-telemetry-report.mjs') ||
    process.argv[1].endsWith('mcp-telemetry-report'));

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  let jsonl = '';
  try {
    jsonl = await readFile(args.file, 'utf-8');
  } catch {
    console.error(`[mcp-telemetry-report] no telemetry at ${args.file} yet`);
    process.exit(0);
  }
  const report = aggregateTelemetry(parseTelemetry(jsonl), {
    eligibleSteps: args.eligibleSteps,
    baselineContextTokens: args.baselineContextTokens,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`MCP telemetry — ${report.totalInvocations} invocations`);
    console.log(`  eligible (token-lever) invocations: ${report.eligibleInvocations}`);
    console.log(
      `  adoption: ${report.adoptedStories} stories` +
        (report.adoptionRate != null ? ` (${(report.adoptionRate * 100).toFixed(0)}% of eligible)` : ''),
    );
    console.log(`  avg context tokens / eligible call: ${report.avgContextTokens}`);
    if (report.tokenDelta != null) {
      const verb = report.tokenDelta >= 0 ? 'saved' : 'over baseline';
      console.log(`  token delta vs baseline: ${Math.abs(report.tokenDelta)} ${verb}`);
    } else {
      console.log('  token delta: (pass --baseline-tokens once the baseline arm is measured)');
    }
    console.log(`  fallback rate: ${(report.fallbackRate * 100).toFixed(0)}%`);
  }
}
