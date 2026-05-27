import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  probeMainSha,
  rsyncRecencySeconds,
  takeSnapshot,
  rsyncFromWorktree,
  restartDaemon,
  awaitHealthy,
  rollbackToSnapshot,
  HEALTH_CHECK_BUDGET_MS,
} from '../deployer-orchestrator';

/**
 * 2026-05-27 PR C.c — deployer orchestration unit tests.
 *
 * Coverage:
 *   - probeMainSha: extracts 40-char hex from SSM output; null on miss
 *   - rsyncRecencySeconds: parses RSYNC_AGE_SEC, returns null on no-marker
 *   - takeSnapshot: throws on missing OK marker, returns dest on success
 *   - rsyncFromWorktree: extracts SHA from RSYNC_OK; throws on failure
 *   - restartDaemon: returns the restart timestamp on success; throws on miss
 *   - awaitHealthy: resolves when isHealthy returns true within budget;
 *     throws on timeout
 *   - rollbackToSnapshot: throws when ROLLBACK_NO_SNAPSHOT path returned
 */

function fakeDeps(output: string) {
  return {
    sendSsmCommand: vi.fn(async (_cmd: string) => 'cmd-id-1'),
    waitForSsmOutput: vi.fn(async () => output),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('probeMainSha', () => {
  it('extracts the 40-char SHA from the SSM output', async () => {
    const deps = fakeDeps('MAIN_SHA=abcdef0123456789abcdef0123456789abcdef01\n');
    expect(await probeMainSha(deps)).toBe('abcdef0123456789abcdef0123456789abcdef01');
  });

  it('returns null when the SSM output has no SHA', async () => {
    expect(await probeMainSha(fakeDeps('git: not found\n'))).toBeNull();
  });

  it('runs git fetch as the ubuntu user', async () => {
    const deps = fakeDeps('MAIN_SHA=ab12ef0123456789abcdef0123456789abcdef01\n');
    await probeMainSha(deps);
    const cmd = deps.sendSsmCommand.mock.calls[0][0];
    expect(cmd).toContain('git fetch origin main');
    expect(cmd).toContain('sudo -u ubuntu');
  });
});

describe('rsyncRecencySeconds', () => {
  it('returns null when the marker is absent', async () => {
    expect(await rsyncRecencySeconds(fakeDeps('RSYNC_NO_MARKER\n'))).toBeNull();
  });

  it('parses RSYNC_AGE_SEC into seconds', async () => {
    expect(await rsyncRecencySeconds(fakeDeps('RSYNC_AGE_SEC=123\n'))).toBe(123);
  });
});

describe('takeSnapshot', () => {
  it('returns the destination on SNAPSHOT_OK', async () => {
    const deps = fakeDeps('SNAPSHOT_OK /opt/.rollback/2026-05-27T20-00-00\n');
    const dest = await takeSnapshot(deps, '2026-05-27T20-00-00');
    expect(dest).toBe('/opt/.rollback/2026-05-27T20-00-00');
  });

  it('throws when the OK marker is missing', async () => {
    await expect(takeSnapshot(fakeDeps('cp: disk full\n'), 'X')).rejects.toThrow(/snapshot failed/);
  });
});

describe('rsyncFromWorktree', () => {
  it('returns the deployed SHA on RSYNC_OK', async () => {
    const deps = fakeDeps('git output...\nRSYNC_OK 12345678901234567890123456789012345678ab\n');
    expect(await rsyncFromWorktree(deps)).toBe('12345678901234567890123456789012345678ab');
  });

  it('throws when RSYNC_OK is absent', async () => {
    await expect(rsyncFromWorktree(fakeDeps('git pull failed\n'))).rejects.toThrow(/rsync failed/);
  });
});

describe('restartDaemon', () => {
  it('returns the restart timestamp on RESTART_OK', async () => {
    const deps = { ...fakeDeps('RESTART_OK\n'), now: () => 1_700_000_000_000 };
    expect(await restartDaemon(deps)).toBe(1_700_000_000_000);
  });

  it('throws when RESTART_OK is absent', async () => {
    await expect(restartDaemon(fakeDeps('systemctl: not found\n'))).rejects.toThrow(
      /restart failed/,
    );
  });
});

describe('awaitHealthy', () => {
  it('resolves on first healthy probe', async () => {
    const isHealthy = vi.fn(async () => ({ healthy: true }));
    const result = await awaitHealthy({ isHealthy, budgetMs: 500, intervalMs: 10 });
    expect(result.healthy).toBe(true);
    expect(isHealthy).toHaveBeenCalledTimes(1);
  });

  it('retries until healthy or budget exhausted', async () => {
    let calls = 0;
    const isHealthy = vi.fn(async () => {
      calls += 1;
      return { healthy: calls >= 3, detail: 'still warming' };
    });
    const result = await awaitHealthy({ isHealthy, budgetMs: 500, intervalMs: 10 });
    expect(result.healthy).toBe(true);
    expect(isHealthy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('throws on timeout, surfacing the last detail', async () => {
    const isHealthy = vi.fn(async () => ({ healthy: false, detail: 'not active' }));
    await expect(awaitHealthy({ isHealthy, budgetMs: 50, intervalMs: 10 })).rejects.toThrow(
      /health-check timed out.*not active/,
    );
  });
});

describe('rollbackToSnapshot', () => {
  it('returns silently on ROLLBACK_OK', async () => {
    const deps = fakeDeps('ROLLBACK_OK\n');
    await expect(rollbackToSnapshot(deps, '/opt/.rollback/X')).resolves.toBeUndefined();
  });

  it('throws on ROLLBACK_NO_SNAPSHOT', async () => {
    await expect(
      rollbackToSnapshot(fakeDeps('ROLLBACK_NO_SNAPSHOT /opt/.rollback/X\n'), '/opt/.rollback/X'),
    ).rejects.toThrow(/rollback failed/);
  });

  it('uses rsync --delete to overwrite /opt/futurator-daemon', async () => {
    const deps = fakeDeps('ROLLBACK_OK\n');
    await rollbackToSnapshot(deps, '/opt/.rollback/X');
    const cmd = deps.sendSsmCommand.mock.calls[0][0];
    expect(cmd).toContain('rsync -a --delete');
    expect(cmd).toContain('/opt/futurator-daemon');
    expect(cmd).toContain('systemctl restart futurator-daemon');
  });
});

describe('budget constant', () => {
  it('matches the 60s budget the spec calls out', () => {
    expect(HEALTH_CHECK_BUDGET_MS).toBe(60_000);
  });
});
