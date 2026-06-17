/**
 * framework-detect.ts — runtime framework detection for shell pipeline steps.
 *
 * Why a bash snippet (not a Lambda lookup):
 *   The qa-prepare / server-check / build-check steps need to know which
 *   port to bind, which host flag to pass, and which dev command to run.
 *   The "right answer" depends on the framework actually present in the
 *   working directory's `package.json` — not on the App's registered
 *   `boilerplateType`, which can drift if the PM agent generated different
 *   code than the bootstrap saga's scaffold expected.
 *
 *   Lambda can't see `/home/ubuntu/projects/<slug>/package.json` because
 *   the working directory lives on EC2. So detection has to happen in the
 *   shell step itself, just before the dev server boots.
 *
 * Contract:
 *   The emitted snippet runs in `bash -c`, reads `${cwd}/package.json`,
 *   and exports four shell variables:
 *
 *     QA_PORT         — port the dev server will bind (5173 / 3000 / 19006 / …)
 *     QA_DEV_CMD      — the full command to start the dev server
 *     QA_HEALTH_PATH  — path to GET when probing readiness ('/')
 *     QA_FRAMEWORK    — short label for logs (vite / next / expo / unknown)
 *
 *   Subsequent shell lines in the same step can `kill $(lsof -ti:$QA_PORT)`,
 *   `nohup $QA_DEV_CMD > log &`, `curl http://127.0.0.1:$QA_PORT$QA_HEALTH_PATH`,
 *   etc., and they work regardless of whether the project is Vite, Next.js,
 *   Expo, or anything else.
 *
 * Why bash and not Node:
 *   The shell step is already running in bash; an inline detection snippet
 *   adds zero new processes. A Node-based detector would require its own
 *   spawn + module resolution overhead per step.
 *
 * Adding a framework:
 *   Add another `elif grep -q '<package-marker>' package.json` branch
 *   below. Keep ordering specific → general (Next.js before React, etc.).
 */

export interface DetectionOpts {
  /**
   * Working directory containing `package.json`. Required — the snippet
   * runs `cd $cwd` before reading.
   */
  cwd: string;

  /**
   * Override the detected port. Useful for tests that want a specific
   * port regardless of framework. When set, QA_PORT is forced.
   */
  forcePort?: number;
}

/**
 * Build a bash snippet that detects the framework and exports
 * QA_PORT / QA_DEV_CMD / QA_HEALTH_PATH / QA_FRAMEWORK.
 *
 * The snippet is multi-line; callers join with `\n` along with the rest
 * of their command.
 */
export function buildFrameworkDetectSnippet(opts: DetectionOpts): string {
  const { cwd, forcePort } = opts;

  const lines: string[] = [
    `cd ${cwd} || { echo 'FRAMEWORK_DETECT_ERROR: cannot cd to ${cwd}' >&2; exit 1; }`,
    `if [ ! -f package.json ]; then`,
    `  echo 'FRAMEWORK_DETECT_ERROR: package.json not found in ${cwd}' >&2; exit 1;`,
    `fi`,
    `# Order matters: more-specific markers first.`,
    `if grep -q '"next"' package.json; then`,
    `  QA_FRAMEWORK=next; QA_PORT=3000; QA_HEALTH_PATH='/';`,
    `  QA_DEV_CMD='npm run dev -- --hostname 0.0.0.0 --port '$QA_PORT;`,
    `elif grep -q '"vite"' package.json; then`,
    `  QA_FRAMEWORK=vite; QA_PORT=5173; QA_HEALTH_PATH='/';`,
    `  QA_DEV_CMD='npm run dev -- --host 0.0.0.0 --port '$QA_PORT;`,
    `elif grep -q '"@remix-run/dev"' package.json; then`,
    `  QA_FRAMEWORK=remix; QA_PORT=3000; QA_HEALTH_PATH='/';`,
    `  QA_DEV_CMD='npm run dev';`,
    `elif grep -q '"expo"' package.json; then`,
    `  QA_FRAMEWORK=expo; QA_PORT=19006; QA_HEALTH_PATH='/';`,
    `  QA_DEV_CMD='npx expo start --web --port '$QA_PORT;`,
    `elif grep -q '"@sveltejs/kit"' package.json; then`,
    `  QA_FRAMEWORK=sveltekit; QA_PORT=5173; QA_HEALTH_PATH='/';`,
    `  QA_DEV_CMD='npm run dev -- --host 0.0.0.0 --port '$QA_PORT;`,
    `elif grep -q '"nuxt"' package.json; then`,
    `  QA_FRAMEWORK=nuxt; QA_PORT=3000; QA_HEALTH_PATH='/';`,
    `  QA_DEV_CMD='npm run dev -- --host 0.0.0.0 --port '$QA_PORT;`,
    `else`,
    `  # Fallback: assume Vite-flavoured. Most modern boilerplates honor`,
    `  # --host / --port; if not, the dev script's defaults stand.`,
    `  QA_FRAMEWORK=unknown; QA_PORT=5173; QA_HEALTH_PATH='/';`,
    `  QA_DEV_CMD='npm run dev';`,
    `fi`,
  ];

  if (typeof forcePort === 'number' && forcePort > 0) {
    lines.push(
      `# Operator-forced port — overrides framework default.`,
      `QA_PORT=${forcePort}`,
      `# Re-derive QA_DEV_CMD if we previously embedded the port.`,
      `case "$QA_FRAMEWORK" in`,
      `  next) QA_DEV_CMD='npm run dev -- --hostname 0.0.0.0 --port '$QA_PORT;;`,
      `  vite|sveltekit|nuxt) QA_DEV_CMD='npm run dev -- --host 0.0.0.0 --port '$QA_PORT;;`,
      `  expo) QA_DEV_CMD='npx expo start --web --port '$QA_PORT;;`,
      `esac`,
    );
  }

  // ── Base-path detection (2026-06-17) ────────────────────────────────────
  // A dev-deploy bakes a sub-path into the build so the app can be served under
  // `/apps/_dev/<name>` on CloudFront — Next `basePath:` or Vite `base:`. That
  // path is committed to the config the QA branch checks out, so `next dev` /
  // the dev server serve the app UNDER that prefix and a request to `/` renders
  // the framework's not-found page (the styled 404 the visual judge then
  // screenshots — "everything failed", brick1 2026-06-16). Detect the prefix and
  // route QA's health-check + every screenshot through it, so QA exercises the
  // app exactly where it is actually served.
  lines.push(
    `QA_BASE_PATH=''`,
    `if ls next.config.* >/dev/null 2>&1; then`,
    `  QA_BASE_PATH=$(grep -hoE "basePath:[[:space:]]*['\\"][^'\\"]+['\\"]" next.config.* 2>/dev/null | head -1 | grep -oE "['\\"][^'\\"]+['\\"]" | tr -d "\\"'");`,
    `fi`,
    `if [ -z "$QA_BASE_PATH" ] && ls vite.config.* >/dev/null 2>&1; then`,
    `  QA_BASE_PATH=$(grep -hoE "base:[[:space:]]*['\\"][^'\\"]+['\\"]" vite.config.* 2>/dev/null | head -1 | grep -oE "['\\"][^'\\"]+['\\"]" | tr -d "\\"'");`,
    `fi`,
    `# Normalize: drop a trailing slash; "/" alone means no real prefix.`,
    `QA_BASE_PATH=$(printf '%s' "$QA_BASE_PATH" | sed 's:/*$::')`,
    `if [ "$QA_BASE_PATH" = "" ]; then :; else QA_HEALTH_PATH="$QA_BASE_PATH/"; fi`,
    `export QA_BASE_PATH`,
    `echo "[framework-detect] framework=$QA_FRAMEWORK port=$QA_PORT basePath=\\"$QA_BASE_PATH\\" cmd=\\"$QA_DEV_CMD\\""`,
  );

  return lines.join('\n');
}

/**
 * Build a bash snippet that aggressively reclaims a dev-server port before
 * a fresh spawn. Used by plan-server-check + wave-build server-check.
 *
 * 2026-05-17 dino-7 incident: `kill $(lsof -ti:3000)` alone is insufficient
 * when a prior step's `next dev` daemon-forked into a process that no longer
 * holds the port but still owns the Next.js dev-server lockfile / RPC
 * socket. The next `npm run dev` spawn fires up, says "Ready in 637ms",
 * then immediately aborts with `⨯ Another \`next dev\` ...` from Next.js's
 * own internal duplicate-instance detector — and the entire plan-build
 * fails with exit 1.
 *
 * The cleanup needs three passes:
 *   1. SIGTERM by process pattern (`pkill -f`) so daemon-forked next-dev /
 *      vite / expo processes from prior plans on the same EC2 host die,
 *      regardless of which port they're now hogging.
 *   2. SIGKILL by port (`lsof -ti`) so anything actively bound to the port
 *      is gone.
 *   3. Sleep so the kernel reclaims the port + the Node runtime tears down
 *      its lockfile (Next.js writes `.next/server-running.txt` on boot
 *      and removes it on SIGTERM — racing here leaves the file).
 *
 * Both passes use `|| true` so an empty match doesn't fail the chain. The
 * snippet expects `$QA_PORT` to already be exported (call buildFrameworkDetectSnippet
 * first).
 */
export function buildPortReclaimSnippet(): string {
  // 2026-05-17 snake-3 incident: the prior pkill patterns were bare strings
  // that also appeared in this bash script's own argv (visible to pgrep via
  // /proc/PID/cmdline). The script SIGTERM'd itself in <50ms every retry,
  // making plan-server-check unsurvivable and stranding plans at "developing".
  // Fix: wrap the first character of each pattern in a [c] regex class. The
  // bracket-class matches the same single character at regex time, so real
  // node/vite/expo processes match exactly as before — but the literal bytes
  // of this script's argv now contain "[n]" / "[v]" / "[e]" rather than the
  // bare pattern, so the script no longer self-matches. Classic pgrep trick.
  // Comments here intentionally avoid spelling out the un-bracketed pattern
  // strings (would re-introduce the self-match via this comment text).
  return [
    `# Kill lingering dev-servers by name pattern (covers daemon-forked orphans`,
    `# from prior plans on the same EC2 host that no longer hold the port).`,
    `pkill -TERM -f '[n]ext dev' 2>/dev/null || true`,
    `pkill -TERM -f '[n]ext-server' 2>/dev/null || true`,
    // 2026-05-18 snake-4 follow-up #1: dropped the `.*` from `[v]ite.* serve`.
    // Greedy `.*` let the regex bridge across the entire script body: `vite`
    // (in `grep -q "vite"` from framework-detect) + `.*` (matches anything)
    // + ` serve` (the literal space-then-serve at the end of the pkill
    // pattern itself) = match against the parent bash's cmdline. Result:
    // bash SIGTERM'd itself in 34ms every time.
    `pkill -TERM -f '[v]ite serve' 2>/dev/null || true`,
    // 2026-05-18 snake-4 follow-up #2: removed the `[e]xpo start` pkill.
    // The bracket trick stops the literal pattern string from self-matching,
    // but the expo elif branch's QA_DEV_CMD itself contains the bare bytes
    // `expo start` (in `'npx expo start --web --port '`), so the regex
    // `expo start` still matched the parent bash. We don't ship Expo apps in
    // Labs production, and the port-based kill below catches any expo dev
    // server that holds its port. Re-add when we have an Expo target and a
    // pkill pattern that survives the framework-detect script body (likely
    // a path-anchored pattern matching `node_modules/.*expo`).
    `# Kill by port as a backstop for anything still listening.`,
    ...buildPortDrainLines('$QA_PORT'),
    `# Wait for port + lockfile teardown.`,
    `sleep 2`,
  ].join('\n');
}

/**
 * pong1 (2026-06-12) — THE PORT-DRAIN DISEASE, finally diagnosed.
 *
 * Every drain in the pipeline was `kill $(lsof -ti:$PORT)`. On the EC2
 * daemon host, `lsof -ti:3000` returns NOTHING (rc=1, run as root OR
 * ubuntu) while `ss -ltnp` shows `next-server (v16)` LISTENING on
 * 0.0.0.0:3000 — lsof is blind to Next 16's listening socket there. So
 * every "kill + wait-until-free + kill -9" sequence was a silent no-op:
 * the wait loop saw an "empty" port instantly and proceeded, the fresh
 * boot died with EADDRINUSE, the healthcheck curl got HTTP 200 from the
 * SQUATTER, and the screenshot judged a different server's page. This is
 * the root under dino-7's "kill alone is insufficient" (patched with
 * pkill by name) and pong1's blank-smoke loop (the curl 200s in the
 * feedback even convinced the retry DEV nothing was wrong).
 *
 * `fuser`/`ss` are the ground truth (verified against the live squatter:
 * `fuser 3000/tcp` → pid; `ss -ltn "sport = :3000"` → LISTEN). The
 * canonical drain: graceful TERM by port → wait until ss shows the port
 * actually free → KILL by port → settle. `portExpr` may be a shell var
 * (`$QA_PORT`) or a literal — bash substitutes either.
 */
export function buildPortDrainLines(portExpr: string): string[] {
  return [
    `fuser -k -TERM ${portExpr}/tcp 2>/dev/null || true`,
    `for i in $(seq 1 10); do ss -ltn "sport = :${portExpr}" 2>/dev/null | grep -q LISTEN || break; sleep 1; done`,
    `fuser -k -KILL ${portExpr}/tcp 2>/dev/null || true`,
  ];
}

/** One-shot, non-waiting port kill (post-screenshot teardown paths). */
export function buildPortKillLine(portExpr: string): string {
  return `fuser -k -KILL ${portExpr}/tcp 2>/dev/null || true`;
}
