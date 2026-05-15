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

  lines.push(
    `echo "[framework-detect] framework=$QA_FRAMEWORK port=$QA_PORT cmd=\\"$QA_DEV_CMD\\""`,
  );

  return lines.join('\n');
}
