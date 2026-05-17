/**
 * TTY-aware logger for the migration runner.
 *
 * - Color codes only emit when stdout is a TTY.
 * - All write methods are synchronous (the runner is single-threaded).
 * - The redactor is passed in so log lines never carry the raw PAT.
 *
 * Public methods:
 *   info(msg)               plain line
 *   ok(msg)                 ✔ green
 *   skip(msg)               ✔ grey + "(already provisioned)" suffix
 *   warn(msg)               ⚠ yellow
 *   fail(msg)               ✖ red, writes to stderr
 *   step(n, total, label)   numbered section header
 *   raw(line)               unprefixed line for daemon-output streaming
 *
 * Test hook: pass `{ stream, errStream, isTty }` overrides to capture
 * output in vitest.
 */

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  grey: '\x1b[90m',
  cyan: '\x1b[36m',
};

export function createLogger({
  stream = process.stdout,
  errStream = process.stderr,
  isTty = process.stdout.isTTY,
  redactor = (s) => s,
} = {}) {
  function paint(c, s) {
    return isTty ? `${c}${s}${ANSI.reset}` : s;
  }
  function writeOut(line) {
    stream.write(redactor(line) + '\n');
  }
  function writeErr(line) {
    errStream.write(redactor(line) + '\n');
  }
  return {
    info(msg) {
      writeOut(msg);
    },
    ok(msg) {
      writeOut(`${paint(ANSI.green, '✔')} ${msg}`);
    },
    skip(msg) {
      writeOut(`${paint(ANSI.grey, '✔ ' + msg + ' (already provisioned)')}`);
    },
    warn(msg) {
      writeOut(`${paint(ANSI.yellow, '⚠')} ${msg}`);
    },
    fail(msg) {
      writeErr(`${paint(ANSI.red, '✖')} ${msg}`);
    },
    step(n, total, label) {
      writeOut('');
      writeOut(paint(ANSI.bold + ANSI.cyan, `[${n}/${total}] ${label}`));
    },
    raw(line) {
      // Preserve trailing newlines as-is; the daemon's event stream often
      // ships chunks with embedded newlines and we want them passed
      // through.
      stream.write(redactor(line));
    },
  };
}
