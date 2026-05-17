import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const HOOK_SCRIPT = join(dirname(__filename), '..', 'lib', 'free-agent-path-hook.sh');

/**
 * Run the hook with controlled env vars. Returns { code, stdout, stderr }.
 * Never throws on non-zero exit (we assert on `code`).
 */
async function runHook(env) {
  try {
    const { stdout, stderr } = await exec('/usr/bin/env', ['bash', HOOK_SCRIPT], {
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

let confinementRoot;

beforeAll(() => {
  // Use a real temp dir so realpath calls inside the hook succeed.
  confinementRoot = mkdtempSync(join(tmpdir(), 'free-agent-hook-test-'));
  // Create a nested subdir to test in-scope absolute paths
  mkdirSync(join(confinementRoot, 'sub'), { recursive: true });
});

describe('free-agent-path-hook.sh — installation & basic shape', () => {
  it('is executable on disk', () => {
    const stat = statSync(HOOK_SCRIPT);
    // Owner-execute bit set
    expect(stat.mode & 0o100).toBe(0o100);
  });
});

describe('free-agent-path-hook.sh — non-Bash tools pass through (AC #5 / AC #8 n)', () => {
  it('exits 0 for Read tool without inspecting input', async () => {
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Read',
      CLAUDE_TOOL_INPUT: '{"file_path":"/etc/passwd"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });

  it('exits 0 for Edit tool', async () => {
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Edit',
      CLAUDE_TOOL_INPUT: '{"file_path":"/tmp/foo"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });

  it('exits 0 for Write tool', async () => {
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Write',
      CLAUDE_TOOL_INPUT: '{"file_path":"/tmp/bar"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });
});

describe('free-agent-path-hook.sh — Bash tool path enforcement (AC #5 / AC #8 k-m)', () => {
  it('rejects cd /etc && ls (AC #8 k)', async () => {
    const { code, stderr } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"command":"cd /etc && ls"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/escapes confinement root/);
    expect(stderr).toContain('/etc');
  });

  it('allows ls -la src/ (in-scope relative) (AC #8 l)', async () => {
    const { code, stderr } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"command":"ls -la src/"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('allows in-scope absolute cd (AC #8 m)', async () => {
    const subDir = join(confinementRoot, 'sub');
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: `{"command":"cd ${subDir} && ls"}`,
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });

  it('rejects cat /etc/passwd (absolute path token outside root)', async () => {
    const { code, stderr } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"command":"cat /etc/passwd"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/escapes confinement root/);
  });

  it('rejects chained cd-out then ls', async () => {
    const { code, stderr } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"command":"cd /tmp; ls"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(1);
    expect(stderr).toContain('/tmp');
  });

  it('allows simple relative-path commands with no cd', async () => {
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"command":"echo hello"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });

  it('allows the confinement root itself as a cd target', async () => {
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: `{"command":"cd ${confinementRoot} && ls"}`,
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });

  it('emits informative stderr on rejection (AC #8 n)', async () => {
    const { code, stderr } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"command":"cd /root"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/free-agent-path-hook: rejected/);
    expect(stderr).toMatch(/escapes confinement root/);
  });
});

describe('free-agent-path-hook.sh — defensive defaults', () => {
  it('denies when FREE_AGENT_CONFINEMENT_ROOT is not set (fail closed)', async () => {
    const { code, stderr } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"command":"ls"}',
      // FREE_AGENT_CONFINEMENT_ROOT intentionally omitted
      PWD: confinementRoot,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/FREE_AGENT_CONFINEMENT_ROOT not set/);
  });

  it('allows when CLAUDE_TOOL_INPUT is empty (nothing to escape with)', async () => {
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });

  it('allows when JSON parses but has no command field', async () => {
    const { code } = await runHook({
      CLAUDE_TOOL_NAME: 'Bash',
      CLAUDE_TOOL_INPUT: '{"some_other_field":"value"}',
      FREE_AGENT_CONFINEMENT_ROOT: confinementRoot,
      PWD: confinementRoot,
    });
    expect(code).toBe(0);
  });
});
