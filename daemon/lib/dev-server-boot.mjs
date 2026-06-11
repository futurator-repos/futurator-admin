/**
 * dev-server-boot.mjs — v2.6 wave-gate VQA (M2, 2026-06-11).
 *
 * Boot/drain/health-check for a dev server in a worktree, extracted from the
 * battle-hardened review-runtime bash (story-pipeline.ts) so the wave gate
 * and (M3) story smoke share ONE implementation of the lessons:
 *
 *  - dino1: SIGTERM + fixed sleep corrupted the next boot's build cache —
 *    wait until the port actually frees (up to 10s), then SIGKILL.
 *  - dino1 root-cause: regenerate generated wiring BEFORE boot (file-guarded
 *    no-op for apps without a generator).
 *  - Next 16 + Turbopack cold-start regularly exceeds 30s in a fresh
 *    worktree — poll the healthcheck 60×1s.
 *
 * All process control flows through the injected `shell` (the wave-merge
 * runner's sudo-as-ubuntu bash executor) so tests can fake it and the daemon
 * keeps one privilege path.
 */

const DEFAULT_TRIES = 60;

/** Kill whatever holds `port`, wait for it to actually free, escalate to -9. */
export async function drainPort({ port, shell, cwd }) {
  // pong1 (2026-06-12) — lsof is BLIND to Next 16's listening socket on the
  // EC2 host (`lsof -ti:3000` rc=1 while `ss -ltnp` shows next-server
  // LISTENING), so the old kill/wait/kill-9 chain was a silent no-op and the
  // fresh boot died with EADDRINUSE against a squatter. fuser/ss are ground
  // truth: graceful TERM by port → wait until ss shows it free → KILL.
  await shell(
    [
      `fuser -k -TERM ${port}/tcp 2>/dev/null || true`,
      `for i in $(seq 1 10); do ss -ltn "sport = :${port}" 2>/dev/null | grep -q LISTEN || break; sleep 1; done`,
      `fuser -k -KILL ${port}/tcp 2>/dev/null || true`,
      `sleep 1`,
    ].join('\n'),
    cwd,
    30_000,
  );
}

/**
 * Boot the boilerplate's dev server in `cwd` on `port` and wait for the
 * healthcheck. Returns `{ ok, status, logTail, stop }` — `stop()` drains the
 * port again. The server log lives at `logFile` (default under /tmp, keyed
 * by port so concurrent gates never share a log).
 *
 * `port` SHOULD be offset from qaContext.defaultPort when used by the wave
 * gate: per-story review servers run on the default port on the same host,
 * and draining the shared port would kill a sibling story's server mid-
 * screenshot (pre-existing race this offset removes).
 */
export async function bootDevServer({
  cwd,
  qaContext,
  port,
  shell,
  log = () => {},
  logFile,
  tries = DEFAULT_TRIES,
}) {
  const p = port ?? qaContext?.defaultPort ?? 3000;
  const healthPath = qaContext?.healthcheckPath ?? '/';
  const devCommand = qaContext?.devCommand ?? 'npm run dev -- --port';
  const serverLog = logFile ?? `/tmp/wave-vqa-devserver-${p}.log`;

  await drainPort({ port: p, shell, cwd });

  // Regenerate generated wiring before boot (no-op without a generator).
  await shell(
    `[ -f scripts/generate-wiring.mjs ] && node scripts/generate-wiring.mjs || true`,
    cwd,
    60_000,
  );

  log('info', `[dev-server-boot] booting "${devCommand} ${p}" in ${cwd} (log ${serverLog})`);
  await shell(`(nohup ${devCommand} ${p} > ${serverLog} 2>&1 </dev/null &)`, cwd, 30_000);

  let status = '000';
  for (let i = 0; i < tries; i++) {
    const r = await shell(
      `sleep 1; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${p}${healthPath} 2>/dev/null || echo 000`,
      cwd,
      15_000,
    );
    status = (r.stdout || '').trim().slice(-3) || '000';
    if (status === '200') break;
  }

  const tail = await shell(`tail -c 2500 ${serverLog} 2>/dev/null || true`, cwd, 15_000);
  const logTail = tail.stdout || '';

  // pong1 tripwire — if OUR boot died with EADDRINUSE, any HTTP 200 above
  // came from a SQUATTER on the port: judging its page is judging the wrong
  // server. Treat as no-boot (env-blocked upstream), never screenshot it.
  if (status === '200' && /EADDRINUSE|Failed to start server/.test(logTail)) {
    log('warn', `[dev-server-boot] port ${p} answered 200 but OUR server died (EADDRINUSE) — squatter detected, refusing to verify the wrong server`);
    await drainPort({ port: p, shell, cwd });
    return {
      ok: false,
      status: 'squatter',
      port: p,
      logTail,
      serverLog,
      stop: () => drainPort({ port: p, shell, cwd }),
    };
  }

  if (status === '200' && (qaContext?.warmupMs ?? 0) > 0) {
    // SSR shells 200 immediately but render asynchronously — wait it out.
    await new Promise((r) => setTimeout(r, qaContext.warmupMs));
  }

  const stop = () => drainPort({ port: p, shell, cwd });
  if (status !== '200') {
    log('warn', `[dev-server-boot] no-boot (status=${status}) — log tail:\n${logTail.slice(-800)}`);
    await stop();
    return { ok: false, status, port: p, logTail, serverLog, stop };
  }
  log('info', `[dev-server-boot] healthy on :${p} (status 200)`);
  return { ok: true, status, port: p, logTail, serverLog, stop };
}

/**
 * Environment recovery for the dino1 corrupted-build-cache class: stop the
 * server, delete the gitignored build cache (registry-declared, e.g.
 * `.next`), reboot. Returns the new boot result.
 */
export async function cleanCacheAndReboot({ boot, qaContext, cwd, shell, log = () => {} }) {
  await drainPort({ port: boot.port, shell, cwd });
  const cacheDir = qaContext?.buildCacheDir;
  if (cacheDir && /^[A-Za-z0-9._-]+$/.test(cacheDir)) {
    log('info', `[dev-server-boot] env-fix: removing build cache ${cacheDir} and rebooting`);
    await shell(`rm -rf -- ${cacheDir}`, cwd, 60_000);
  }
  return bootDevServer({ cwd, qaContext, port: boot.port, shell, log, logFile: boot.serverLog });
}
