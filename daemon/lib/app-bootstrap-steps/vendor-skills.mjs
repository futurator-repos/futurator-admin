/**
 * vendor-skills.mjs — Pipeline v2 Phase 3-C Epic 2 (Story 2.3, 2026-05-19).
 *
 * Materializes the project's skill manifest into vendored SKILL.md files
 * under `.claude/skills/<name>/` by invoking the in-worktree
 * `scripts/skills-sync.mjs` (shipped via PR-71 augment, lives at
 * `<worktreeDir>/scripts/skills-sync.mjs`). The sync script reads
 * `.claude/skills.manifest.yaml`, fetches each declared skill's SKILL.md
 * from the federation source's GitHub raw URL, and writes it to disk.
 *
 * This step's job is JUST to spawn the script and translate its exit
 * code + stdout into a structured result the saga can decide on.
 *
 * Exit-code contract (per skills-sync.mjs:539-545):
 *   0 — clean sync (every manifest entry materialized + SHA verified)
 *   1 — fatal (manifest missing/malformed, federation missing, network)
 *   2 — drift (one or more local SKILL.md SHAs don't match the pinned version)
 *
 * Mapping to step outcomes (Epic 2 design — non-blocking either way):
 *   0 → success
 *   2 → success-with-attention (severity=low, category=skill-manifest-out-of-sync)
 *   1 → skipped-with-attention (severity=medium, category=skill-sync-failed)
 *
 * Why non-blocking: Epic 2's value comes from the HAPPY path (skills
 * vendored, agents activate them). If vendoring fails on a fresh app, we
 * surface the issue but let bootstrap complete — the operator sees the
 * attention item, fixes the underlying cause (usually a missing
 * `~/.futurator/skill-federation.yaml`), and re-runs vendor-skills via
 * `npx skills sync` or by re-bootstrapping the affected app.
 *
 * The script self-skips when the manifest declares zero skills (see
 * skills-sync.mjs:586-589: "manifest declares no skills — nothing to
 * sync"), so the step is naturally a no-op on starters whose
 * defaultSkillLoadout is null (sst/vite/mobile after PR-71 + Story 2.1).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SYNC_SCRIPT_REL = 'scripts/skills-sync.mjs';
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min — 4 skills × ~5 GitHub raw fetches

/**
 * Default federation path. Overridable via env so tests + alternate
 * deployments can swap it. Matches the path the operator authors per
 * Epic 1.2 (architecture.md §10 operator-side provisioning).
 */
const DEFAULT_FEDERATION_PATH = '/home/ubuntu/.futurator/skill-federation.yaml';

/**
 * Spawn the in-worktree skills-sync script and resolve to a structured
 * outcome. Pure-async; the only side effect is the subprocess + on-disk
 * writes the script makes.
 *
 * @param {object}   args
 * @param {string}   args.worktreeDir         — absolute path to the worktree
 * @param {boolean}  [args.skip]              — caller-supplied skip (stub types)
 * @param {function} [args.onOutput]          — `(stream, data) => void`,
 *                                              matches makeOutputSink contract
 * @param {function} [args.spawnImpl]         — injectable for tests
 * @param {number}   [args.timeoutMs]
 * @param {string}   [args.federationPath]
 * @returns {Promise<{
 *   skipped: boolean,
 *   reason?: string,
 *   vendoredCount: number,
 *   drift?: number,
 *   attentionCategory?: 'skill-sync-failed' | 'skill-manifest-out-of-sync',
 *   attentionSeverity?: 'low' | 'medium',
 *   exitCode?: number,
 *   stderr?: string,
 * }>}
 */
export async function runVendorSkills({
  worktreeDir,
  skip = false,
  onOutput,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  federationPath = process.env.FUTURATOR_FEDERATION_PATH || DEFAULT_FEDERATION_PATH,
} = {}) {
  if (!worktreeDir) throw new Error('runVendorSkills: worktreeDir required');

  if (skip) {
    return { skipped: true, reason: 'stub-boilerplate', vendoredCount: 0 };
  }

  const scriptPath = join(worktreeDir, SYNC_SCRIPT_REL);
  if (!existsSync(scriptPath)) {
    return { skipped: true, reason: 'sync-script-missing', vendoredCount: 0 };
  }

  return new Promise((resolve) => {
    const proc = spawnImpl('node', [SYNC_SCRIPT_REL], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        FUTURATOR_FEDERATION_PATH: federationPath,
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (typeof onOutput === 'function') onOutput('stdout', s);
    });
    proc.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (typeof onOutput === 'function') onOutput('stderr', s);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // already exited — fine.
      }
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        skipped: true,
        reason: `spawn-error: ${err.message}`,
        vendoredCount: 0,
        attentionCategory: 'skill-sync-failed',
        attentionSeverity: 'medium',
        stderr: err.message,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      const vendoredCount = (stdout.match(/^\[skills-sync\] WROTE /gm) || []).length;
      const driftCount = (stdout.match(/^\[skills-sync\] DRIFT /gm) || []).length;

      if (timedOut) {
        resolve({
          skipped: true,
          reason: 'timeout',
          vendoredCount,
          drift: driftCount,
          attentionCategory: 'skill-sync-failed',
          attentionSeverity: 'medium',
          stderr: stderr.slice(-2000),
        });
        return;
      }

      if (code === 0) {
        resolve({
          skipped: false,
          vendoredCount,
          drift: 0,
          exitCode: 0,
        });
        return;
      }

      if (code === 2) {
        // Drift detected — some local SKILL.md doesn't match the pinned
        // version. Non-blocking; surface low-severity attention so the
        // operator can decide between `--resync` (overwrite local) or
        // re-pinning via `/skills audit`.
        resolve({
          skipped: false,
          vendoredCount,
          drift: driftCount,
          exitCode: 2,
          attentionCategory: 'skill-manifest-out-of-sync',
          attentionSeverity: 'low',
          stderr: stderr.slice(-2000),
        });
        return;
      }

      // code === 1 OR unknown non-zero: hard sync failure (missing
      // federation, malformed manifest, network). Skip the step's
      // success contract but stay non-blocking — bootstrap continues.
      resolve({
        skipped: true,
        reason: `sync-failed-exit-${code}`,
        vendoredCount,
        drift: driftCount,
        exitCode: code,
        attentionCategory: 'skill-sync-failed',
        attentionSeverity: 'medium',
        stderr: stderr.slice(-2000),
      });
    });
  });
}
