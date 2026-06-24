// case1-runner.mjs — M0 automation scaffold (design doc §3 / strategy §5.2–§5.4).
//
// Drives `claude` in an interactive pty so the TUI renders, types an `ultracode <intent>` prompt,
// lets the planner write its script, then CANCELS before any agent runs. Capture itself is done by
// script-capture.mjs (fs.watch); this file owns only the launch + the cancel keystroke.
//
// ⛔ THE LIVE [VERIFY] (design §10.1, strategy §5.4): the exact cancel keystroke that provably
//    leaves `agentCount: 0` and an empty `subagents/workflows/` is UNRESOLVED on claude 2.1.186.
//    This scaffold tries candidates in order; a human must confirm which one cleaves zero agents.
//    Do NOT trust this unattended until that run is done.
//
// Requires node-pty (native; not a repo dep). Install in the spike dir when you run it:
//   cd spikes/ultra-reverse && npm init -y && npm i node-pty
//   node capture/case1-runner.mjs --intent "create me a pacman game" --cwd "$PWD"

const args = parseArgs(process.argv.slice(2));
const intent = args.intent || 'create me a pacman game';
const cwd = args.cwd || process.cwd();

let pty;
try {
  pty = await import('node-pty');
} catch {
  console.error('✗ node-pty not installed. Run:  cd spikes/ultra-reverse && npm i node-pty');
  console.error('  (or use the manual flow: script-capture.mjs + a hand-launched `claude`.)');
  process.exit(2);
}

// Cancel-keystroke candidates to try, weakest→strongest (strategy §5.4). The watcher confirms
// which leaves agentCount:0 — until then this is a [VERIFY], not a guarantee.
const CANCEL_SEQUENCES = {
  backspace: '\x7f', // right after the keyword highlight
  altW: '\x1bw', // alt+w dismisses the keyword highlight
  esc: '\x1b',
  // the approval card's "No" is usually selecting + Enter; left as a manual fallback
};

const term = pty.spawn('claude', [], {
  name: 'xterm-color',
  cols: 120,
  rows: 40,
  cwd,
  env: process.env,
});

let captured = false;
let buf = '';
term.onData((d) => {
  buf += d;
  process.stdout.write(d); // mirror the TUI so a human can watch
  // crude approval-card detector — refine against the real 2.1.186 card text [VERIFY]
  if (!captured && /review (the )?dynamic workflow|approve|run workflow|\bphases?\b/i.test(buf)) {
    captured = true;
    console.error('\n[case1-runner] approval card detected → sending cancel candidate(s)…');
    // try ESC first (least likely to spawn); a human verifies agentCount via the watcher
    setTimeout(() => term.write(CANCEL_SEQUENCES.esc), 150);
    setTimeout(() => term.write(CANCEL_SEQUENCES.altW), 400);
    setTimeout(() => { console.error('[case1-runner] confirm agentCount:0 in the watcher output, then Ctrl+C here.'); }, 800);
  }
});

term.onExit(({ exitCode }) => { console.error(`\n[case1-runner] claude exited (${exitCode})`); process.exit(exitCode || 0); });

// type the intent once the session is ready
setTimeout(() => {
  term.write(`ultracode ${intent}\r`);
}, 2500);

process.on('SIGINT', () => { try { term.kill(); } catch {} process.exit(0); });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--intent') out.intent = argv[++i];
    else if (argv[i] === '--cwd') out.cwd = argv[++i];
  }
  return out;
}
