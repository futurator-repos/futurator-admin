// script-capture.mjs — M0 capture (design doc §3 / strategy §5). Dependency-free (pure node).
//
// Watches the running ultracode session's on-disk script dir and grabs the generated workflow
// `.js` the instant it is written — BEFORE the fan-out runs (strategy §5.1 proved the script
// exists at t=0 while agents run for minutes after). Pair with a manually-launched interactive
// `claude` for the first proof; `case1-runner.mjs` automates the launch+cancel later.
//
//   Terminal 1:  node spikes/ultra-reverse/capture/script-capture.mjs --cwd "$PWD" --out /tmp/case1
//   Terminal 2:  claude        # then type:  ultracode <your intent>
//   → on the approval card, this prints CAPTURED + the script path; you cancel (the live [VERIFY]).
//
// Path layout (verified, strategy §5.1):
//   ~/.claude/projects/<munged-cwd>/<session-uuid>/workflows/
//     scripts/<name>-wf_<id>.js     ← the generated script (readable JS)
//     wf_<id>.json                  ← journal+meta: scriptPath, phases[], defaultModel, totalTokens, agentCount

import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, readdirSync, statSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));
const cwd = args.cwd || process.cwd();
const outDir = args.out || join(process.cwd(), 'case1-capture');

// harvest.mjs path-munge: macOS /tmp → /private/tmp, then `/` and `.` → `-`
function mungedProjectDir(realCwd) {
  const real = realCwd.startsWith('/tmp/') ? `/private${realCwd}` : realCwd;
  return join(homedir(), '.claude', 'projects', real.replace(/[/.]/g, '-'));
}

/** A run is REAL ultracode (not a hand-written harness script) iff a `workflows/scripts/` copy exists. */
function isGeneratedScript(scriptPath) {
  return /\/workflows\/scripts\/[^/]+\.js$/.test(scriptPath);
}

function readWfMeta(scriptPath) {
  // sibling wf_<id>.json lives one dir up from scripts/
  const id = (basename(scriptPath).match(/wf_[A-Za-z0-9-]+/) || [])[0];
  if (!id) return null;
  const jsonPath = join(dirname(dirname(scriptPath)), `${id}.json`);
  if (!existsSync(jsonPath)) return null;
  try {
    const wf = JSON.parse(readFileSync(jsonPath, 'utf8'));
    return {
      scriptPath: wf.scriptPath ?? scriptPath,
      phases: Array.isArray(wf.phases) ? wf.phases.map((p) => p.title ?? p) : [],
      defaultModel: wf.defaultModel ?? null,
      totalTokens: wf.totalTokens ?? 0,
      agentCount: wf.agentCount ?? 0,
    };
  } catch { return null; }
}

function emit(scriptPath) {
  if (!isGeneratedScript(scriptPath)) return false;
  let stable;
  try { stable = statSync(scriptPath).size; } catch { return false; }
  // debounce: only read once the file size is non-zero (atomic-write guard, strategy §5.3)
  if (!stable) return false;

  const scriptJs = readFileSync(scriptPath, 'utf8');
  const meta = readWfMeta(scriptPath) || {};
  const result = {
    scriptJs,
    scriptPath,
    phasesFromCard: meta.phases ?? [],      // cross-check vs the AST (case1ToDecision)
    defaultModel: meta.defaultModel ?? null,
    tokensSpent: meta.totalTokens ?? 0,     // assert ~planning-only; should be tiny at capture
    agentCount: meta.agentCount ?? 0,       // MUST be 0 after a clean cancel (the live [VERIFY])
    capturedVia: 'fswatch',
    capturedAt: new Date().toISOString(),   // wall time is fine here (not a workflow script)
  };
  mkdirSync(outDir, { recursive: true });
  const stamp = basename(scriptPath).replace(/\.js$/, '');
  writeFileSync(join(outDir, `${stamp}.script.js`), scriptJs);
  writeFileSync(join(outDir, `${stamp}.case1.json`), JSON.stringify(result, null, 2));

  console.log('\n✅ CAPTURED real ultracode script');
  console.log('   script :', scriptPath);
  console.log('   phases :', result.phasesFromCard.join(' → ') || '(none in wf json)');
  console.log('   tokens :', result.tokensSpent, ' agentCount:', result.agentCount);
  console.log('   saved  :', join(outDir, `${stamp}.case1.json`));
  console.log('\n👉 NOW CANCEL the run (the live [VERIFY]: confirm agentCount stays 0).');
  console.log('   Candidates to try, pick the one that leaves subagents/ empty:');
  console.log('     • backspace right after the `ultracode` keyword');
  console.log('     • alt+w   • Esc   • the approval card’s “No”\n');
  return true;
}

const projDir = mungedProjectDir(cwd);
console.log('▸ watching for generated ultracode scripts under:');
console.log('   ', projDir);
console.log('   (cwd =', cwd, ')\n   launch `claude` and type:  ultracode <intent>\n');

if (!existsSync(projDir)) {
  console.log('  (project dir does not exist yet — it is created when the session starts; re-run after launching claude in that cwd)');
}

const seen = new Set();
function scanOnce() {
  if (!existsSync(projDir)) return;
  const stack = [projDir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && full.endsWith('.js') && /\/workflows\/scripts\//.test(full) && !seen.has(full)) {
        seen.add(full);
        if (emit(full)) process.exitCode = 0;
      }
    }
  }
}

// recursive fs.watch (macOS supports it) + a poll fallback for reliability
try {
  watch(projDir, { recursive: true }, () => scanOnce());
} catch {
  // some platforms reject recursive watch on a not-yet-existing dir — poll instead
}
const poll = setInterval(scanOnce, 400);
scanOnce();
process.on('SIGINT', () => { clearInterval(poll); process.exit(0); });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') out.cwd = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}
