/**
 * auth-probe-classifier.mjs — 2026-05-21.
 *
 * Pure-function classifier for the daemon's auth-probe outcome. The
 * probe spawns `claude -p ok --model haiku --output-format json` every
 * ~5 minutes and uses this helper to decide whether the OAuth is still
 * usable.
 *
 * Bug history: Claude Code in `-p` mode sometimes exits non-zero for
 * BENIGN reasons (rate-limit response headers being parsed after the
 * JSON body, trace fragments emitted after the result, OS signal during
 * shutdown). The pre-fix probe required `exitCode === 0`, so it flipped
 * `authState.valid = false` on those flakes — the UI showed "auth
 * expired" even though the OAuth was working and the very next job
 * spawn succeeded (visible to operator: "agent runs anyway").
 *
 * Decision matrix:
 *
 *   parsed JSON?  | is_error    | auth-failure phrase? | outcome
 *   --------------+-------------+----------------------+--------
 *   yes           | true        | (any)                | FAIL
 *   yes           | false       | yes                  | FAIL
 *   yes           | false       | no                   | OK  ← exit code IGNORED
 *   no            | (n/a)       | yes                  | FAIL
 *   no            | (n/a)       | no, exit !== 0       | FAIL
 *   no            | (n/a)       | no, exit === 0       | OK
 *
 * The auth-failure phrase regex catches the strings Claude Code emits on
 * actual OAuth rejection (401, "Please run /login", etc.) — that always
 * wins regardless of exit code or parsed JSON.
 */

/**
 * Detect Claude Code's actual auth-failure phrases. Stays in sync with
 * the inline version in agent-daemon.mjs so the daemon and the test can
 * share semantics without a circular import on the daemon entry.
 */
export function isAuthFailureOutput(text) {
  if (!text) return false;
  return /401|authentication_error|unauthenticated|Failed to authenticate|Not logged in|Please run \/login/i.test(
    text,
  );
}

/**
 * Classify the probe's outcome from its raw signals.
 *
 * @param {{
 *   exitCode: number,
 *   parsed: { is_error?: boolean, result?: string } | null,
 *   combinedOutput: string,
 * }} args
 * @returns {boolean} true = auth OK; false = auth probe FAIL
 */
export function classifyAuthProbeResult({ exitCode, parsed, combinedOutput }) {
  if (isAuthFailureOutput(combinedOutput)) return false;
  if (parsed) {
    return parsed.is_error !== true;
  }
  return exitCode === 0;
}
