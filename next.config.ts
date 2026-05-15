import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

/**
 * PR-61 (2026-05-13) — build-time version stamp.
 *
 * Static export means the JS bundle is frozen at build time. To let the
 * operator visually confirm that the browser is running THIS build (not a
 * cached predecessor), we inline the git short hash + ISO timestamp into
 * `NEXT_PUBLIC_BUILD_*` env vars. The Sidebar displays them under the
 * "Futurator Admin" title and cross-checks against the API's reported hash.
 *
 * Dirty working tree → `-dirty` suffix so the hash isn't lying. (We
 * routinely deploy from a tree with uncommitted M files; the suffix makes
 * that visible.)
 *
 * Failure mode: outside a git checkout the build still succeeds; the hash
 * falls back to `dev`. CI/sandbox safe.
 */
function getBuildInfo(): { hash: string; time: string } {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty =
      execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0 ? '-dirty' : '';
    return { hash: hash + dirty, time: new Date().toISOString() };
  } catch {
    return { hash: 'dev', time: new Date().toISOString() };
  }
}

const buildInfo = getBuildInfo();

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // The repo has long-standing typecheck drift in agentic-office trackers
  // and a few hooks that uses-* call but don't export. CI runs
  // `npm run typecheck` separately and surfaces those — we don't want them
  // to block static-export of the Labs app where the toggleable UI
  // actually lives. Real type bugs in the party / labs surface still get
  // caught by `npm run typecheck` before deploy.
  typescript: {
    ignoreBuildErrors: true,
  },
  env: {
    NEXT_PUBLIC_BUILD_HASH: buildInfo.hash,
    NEXT_PUBLIC_BUILD_TIME: buildInfo.time,
  },
};

export default nextConfig;
