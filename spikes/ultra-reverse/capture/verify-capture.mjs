// verify-capture.mjs — resolve the live cancel [VERIFY] (design §10.1, strategy §5.4).
//
// After a manual `ultracode` run captured by script-capture.mjs + a cancel keystroke, this checks
// the on-disk evidence that NO agents ran (zero token burn). Run it pointing at either the captured
// `*.case1.json` or the session's `workflows/` dir.
//
//   node spikes/ultra-reverse/capture/verify-capture.mjs --case1 /tmp/case1/<name>.case1.json
//   node spikes/ultra-reverse/capture/verify-capture.mjs --session ~/.claude/projects/<proj>/<uuid>
//
// PASS = agentCount 0 AND no per-agent transcripts under subagents/workflows/. A PASS confirms the
// cancel keystroke used cleaves zero agents — closing the last M0 unknown.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const a = parseArgs(process.argv.slice(2));
let agentCount = null;
let transcripts = [];
const findings = [];

if (a.case1) {
  const cap = JSON.parse(readFileSync(a.case1, 'utf8'));
  agentCount = cap.agentCount ?? null;
  findings.push(`captured agentCount = ${agentCount}`);
  findings.push(`tokensSpent = ${cap.tokensSpent ?? '?'} (planning-only expected)`);
  findings.push(`phases = ${(cap.phasesFromCard ?? []).join(' → ') || '(none)'}`);
}

if (a.session) {
  // count per-agent transcripts under subagents/workflows/wf_*/agent-*.jsonl
  const subRoot = join(a.session, 'subagents', 'workflows');
  if (existsSync(subRoot)) {
    for (const wf of safeDirs(subRoot)) {
      const wfDir = join(subRoot, wf);
      for (const f of safeFiles(wfDir)) if (/^agent-.*\.jsonl$/.test(f)) transcripts.push(join(wf, f));
    }
  }
  findings.push(`per-agent transcripts under subagents/workflows/ = ${transcripts.length}`);
  // also read wf_*.json agentCount if present
  const wfRoot = join(a.session, 'workflows');
  if (existsSync(wfRoot)) {
    for (const f of safeFiles(wfRoot)) {
      if (/^wf_.*\.json$/.test(f)) {
        try { const j = JSON.parse(readFileSync(join(wfRoot, f), 'utf8')); agentCount = j.agentCount ?? agentCount; } catch { /* ignore */ }
      }
    }
  }
}

if (!a.case1 && !a.session) {
  console.error('usage: verify-capture.mjs --case1 <*.case1.json> | --session <session-dir>');
  process.exit(2);
}

const zeroAgents = (agentCount === 0 || agentCount === null) && transcripts.length === 0;
console.log('\n▸ M0 capture verification');
for (const f of findings) console.log('   -', f);
if (zeroAgents) {
  console.log('\n✅ PASS — zero agents ran. The cancel keystroke cleaves clean; M0 [VERIFY] closed.\n');
  process.exit(0);
} else {
  console.log(`\n❌ FAIL — agents executed (agentCount=${agentCount}, transcripts=${transcripts.length}).`);
  console.log('   Try a different cancel keystroke (backspace-after-keyword / alt+w / Esc / approval-card No)');
  console.log('   and capture earlier. See strategy §5.4 / design §10.1.\n');
  process.exit(1);
}

function safeDirs(d) { try { return readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()); } catch { return []; } }
function safeFiles(d) { try { return readdirSync(d).filter((n) => statSync(join(d, n)).isFile()); } catch { return []; } }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--case1') out.case1 = argv[++i]; else if (argv[i] === '--session') out.session = argv[++i]; }
  return out;
}
