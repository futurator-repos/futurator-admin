import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const HOOK_SCRIPT = join(dirname(__filename), '..', 'lib', 'free-agent-commit-msg-hook.sh');

let workDir;
let msgFile;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fa-commit-msg-hook-'));
  msgFile = join(workDir, 'COMMIT_EDITMSG');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function runHook(env, args = [msgFile]) {
  try {
    const { stdout, stderr } = await exec('/usr/bin/env', ['bash', HOOK_SCRIPT, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

describe('free-agent-commit-msg-hook.sh — installation & basic shape', () => {
  it('is executable on disk', () => {
    const stat = statSync(HOOK_SCRIPT);
    expect(stat.mode & 0o100).toBe(0o100);
  });
});

describe('free-agent-commit-msg-hook.sh — trailer append (AC #1)', () => {
  it('appends the trailer to a single-line message', async () => {
    writeFileSync(msgFile, 'fix: bug\n', 'utf8');
    const { code } = await runHook({ FREE_AGENT_SESSION_ID: 'sid-abc' });
    expect(code).toBe(0);
    const content = readFileSync(msgFile, 'utf8');
    expect(content).toContain('fix: bug');
    expect(content).toContain('Agent: FREE-AGENT-sid-abc');
  });

  it('inserts a leading blank line between prose and trailer', async () => {
    writeFileSync(msgFile, 'feat: add widget\n\nDetails here.\n', 'utf8');
    await runHook({ FREE_AGENT_SESSION_ID: 'sid-1' });
    const content = readFileSync(msgFile, 'utf8');
    // The trailer should be separated from "Details here." by a blank line.
    expect(content).toMatch(/Details here\.\s*\n\s*\nAgent: FREE-AGENT-sid-1\s*$/);
  });

  it('coexists with trailers from other agents', async () => {
    writeFileSync(
      msgFile,
      'refactor: rename helper\n\nCarried-Forward-From: experiment/x\nAgent: DEV-job-7\n',
      'utf8',
    );
    await runHook({ FREE_AGENT_SESSION_ID: 'sid-1' });
    const content = readFileSync(msgFile, 'utf8');
    expect(content).toContain('Carried-Forward-From: experiment/x');
    expect(content).toContain('Agent: DEV-job-7');
    expect(content).toContain('Agent: FREE-AGENT-sid-1');
  });
});

describe('free-agent-commit-msg-hook.sh — idempotency (AC #2)', () => {
  it('no-ops when trailer already present', async () => {
    writeFileSync(msgFile, 'fix: bug\n\nAgent: FREE-AGENT-sid-abc\n', 'utf8');
    const before = readFileSync(msgFile, 'utf8');
    await runHook({ FREE_AGENT_SESSION_ID: 'sid-abc' });
    const after = readFileSync(msgFile, 'utf8');
    expect(after).toBe(before);
    // Trailer appears exactly once.
    const matches = (after.match(/Agent: FREE-AGENT-sid-abc/g) || []).length;
    expect(matches).toBe(1);
  });

  it('appends a NEW trailer for a different sessionId', async () => {
    writeFileSync(msgFile, 'fix: bug\n\nAgent: FREE-AGENT-sid-old\n', 'utf8');
    await runHook({ FREE_AGENT_SESSION_ID: 'sid-new' });
    const content = readFileSync(msgFile, 'utf8');
    expect(content).toContain('Agent: FREE-AGENT-sid-old');
    expect(content).toContain('Agent: FREE-AGENT-sid-new');
  });
});

describe('free-agent-commit-msg-hook.sh — defensive defaults', () => {
  it('uses "unknown" sessionId when FREE_AGENT_SESSION_ID is unset', async () => {
    writeFileSync(msgFile, 'feat: thing\n', 'utf8');
    const { code } = await runHook({});
    expect(code).toBe(0);
    const content = readFileSync(msgFile, 'utf8');
    expect(content).toContain('Agent: FREE-AGENT-unknown');
  });

  it('no-ops (exit 0) when msg-file path is missing', async () => {
    const { code } = await runHook({ FREE_AGENT_SESSION_ID: 'sid-1' }, []);
    expect(code).toBe(0);
  });

  it('no-ops (exit 0) when msg-file does not exist', async () => {
    const { code } = await runHook({ FREE_AGENT_SESSION_ID: 'sid-1' }, [
      join(workDir, 'does-not-exist'),
    ]);
    expect(code).toBe(0);
  });

  it('ignores commented and blank lines when deciding whether to add a leading blank', async () => {
    writeFileSync(
      msgFile,
      'feat: thing\n\n# Please enter the commit message for your changes.\n# Lines starting with #...\n\n',
      'utf8',
    );
    await runHook({ FREE_AGENT_SESSION_ID: 'sid-1' });
    const content = readFileSync(msgFile, 'utf8');
    // Trailer present
    expect(content).toContain('Agent: FREE-AGENT-sid-1');
  });
});
