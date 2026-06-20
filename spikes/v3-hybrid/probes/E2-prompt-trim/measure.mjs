#!/usr/bin/env node
// E2-S2 — deterministic pm-plan prompt token/field probe (v3, no LLM, no daemon).
//
// The token-REDUCTION acceptance (FR-B1) needs no model: render the REAL
// `buildPmPlanPrompt(args)` and count its instruction tokens. This probe does
// exactly that for a fixed args matrix, compares against the recorded pre-slim
// baseline, and writes a delta row to ../../results/E2-prompt-trim.json.
//
// The story-FIELD-diff half of E2-S2 (FR-B2 — "no per-story field dropped after
// the trim") needs a live generation, which only runs on the daemon/EC2 arm;
// this probe records the deterministic token delta + the field CONTRACT the
// post-trim prompt still instructs, so a regression that silently drops a field
// instruction is caught here without spending a token.
//
// Usage:  node measure.mjs [--json]
// Imports the TS prompt via tsx's loader (dev-only; never shipped to Lambda).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', '..', 'results');

// Recorded pre-slim baseline (measured 2026-06-19 on the mvp/nextjs fixture,
// commit before E2-S1). The post-slim number is computed live below.
const BASELINE_MVP_CHARS = 21958;

// A cheap, deterministic token estimate (no tokenizer dep): GPT-style ≈ chars/4,
// floored. Stable across runs — the AC is a RELATIVE reduction, not an exact count.
const estTokens = (s) => Math.floor(s.length / 4);

// The per-story field instructions the post-trim prompt MUST still carry (FR-B2
// "no field dropped"). Each entry is a substring that proves the field is still
// requested. A trim that removes one of these fails the probe.
const REQUIRED_FIELD_CONTRACT = [
  'touchPoints',
  'requirementRefs', // v3 E1-S1 coverage spine
  'userStory',
  'technicalNotes',
  'acRefs',
  'needsBrowser',
  'verify',
  'src/features/', // progressive feature registration
  'primary: true',
  'window.__harness',
];

async function main() {
  const { buildPmPlanPrompt } = await import('../../../../functions/shared/prompts/pm-plan-prompt.ts');

  const base = { planName: 'pacman', intent: 'A faithful browser Pac-Man', executionMode: 'pipeline' };
  const matrix = [
    { label: 'mvp/nextjs', args: { ...base, boilerplateType: 'nextjs-base', rigor: 'mvp' } },
    { label: 'production/nextjs+grounded', args: { ...base, boilerplateType: 'nextjs-base', rigor: 'production', priorArtifacts: '## Functional Requirements\nFR1. A\nFR2. B' } },
    { label: 'prototype/vite', args: { ...base, boilerplateType: 'vite', rigor: 'prototype' } },
  ];

  const rows = matrix.map(({ label, args }) => {
    const prompt = buildPmPlanPrompt(args);
    const missing = REQUIRED_FIELD_CONTRACT.filter(
      // requirementRefs + the BMAD fields only appear on enriched/grounded prompts
      (f) => {
        const enriched = args.rigor !== 'prototype';
        const grounded = !!args.priorArtifacts;
        if (f === 'requirementRefs') return grounded && !prompt.includes(f);
        if (['userStory', 'technicalNotes', 'acRefs'].includes(f)) return enriched && !prompt.includes(f);
        return !prompt.includes(f);
      },
    );
    return { label, chars: prompt.length, tokens: estTokens(prompt), fieldContractDropped: missing };
  });

  const mvp = rows.find((r) => r.label === 'mvp/nextjs');
  const charDelta = BASELINE_MVP_CHARS - mvp.chars;
  const pctReduction = Math.round((charDelta / BASELINE_MVP_CHARS) * 1000) / 10;
  const anyFieldDropped = rows.some((r) => r.fieldContractDropped.length > 0);

  const result = {
    probe: 'E2-prompt-trim',
    baselineMvpChars: BASELINE_MVP_CHARS,
    postSlimMvpChars: mvp.chars,
    charDelta,
    pctReduction,
    rows,
    fieldContractHeld: !anyFieldDropped,
    verdict: charDelta > 0 && !anyFieldDropped ? 'PASS' : 'FAIL',
  };

  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, 'E2-prompt-trim.json'), JSON.stringify(result, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nE2-prompt-trim · pm-plan prompt token reduction (deterministic, no LLM)`);
    for (const r of rows) {
      const drop = r.fieldContractDropped.length ? `  ⚠ DROPPED: ${r.fieldContractDropped.join(', ')}` : '';
      console.log(`  ${r.label.padEnd(28)} ${String(r.chars).padStart(6)} chars  ~${r.tokens} tok${drop}`);
    }
    console.log(`\n  mvp/nextjs: ${BASELINE_MVP_CHARS} → ${mvp.chars} chars  (−${charDelta}, −${pctReduction}%)`);
    console.log(`  field contract held: ${result.fieldContractHeld}`);
    console.log(`\n  verdict: ${result.verdict}`);
    console.log(`PROBE-RESULT: E2 baselineChars=${BASELINE_MVP_CHARS} postChars=${mvp.chars} delta=${charDelta} pct=${pctReduction} fieldsHeld=${result.fieldContractHeld} verdict=${result.verdict}\n`);
  }
  process.exit(result.verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(`E2-prompt-trim probe failed: ${e.stack || e.message}`);
  process.exit(2);
});
