/**
 * Wraps `npx bmad-method@<version> install` with streaming stdout capture.
 *
 * Idempotency: if `<projectPath>/bmad/_cfg/manifest.yaml` already exists and
 * the installed version matches the requested version, skip the spawn and
 * return { skipped: true }.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function installBmad({ projectPath, version, force = false, onOutput }) {
  if (!projectPath || !version) {
    throw new Error('installBmad: projectPath and version are required');
  }

  const manifestPath = join(projectPath, 'bmad', '_cfg', 'manifest.yaml');
  if (!force && existsSync(manifestPath)) {
    const installed = readInstalledVersion(manifestPath);
    if (installed === version) {
      return { skipped: true, reason: 'version-match', installedVersion: installed };
    }
  }

  const args = [
    `bmad-method@${version}`,
    'install',
    '--directory',
    projectPath,
    '--modules',
    'core,bmm,cis',
    '--tools',
    'claude-code',
    '--yes',
  ];

  const { code, stdout, stderr } = await run('npx', args, onOutput);
  if (code !== 0) {
    const err = new Error(`bmad install exited with code ${code}`);
    err.stdout = stdout;
    err.stderr = stderr;
    err.code = code;
    throw err;
  }
  return { skipped: false, installedVersion: version, stdout, stderr };
}

function readInstalledVersion(manifestPath) {
  try {
    const text = readFileSync(manifestPath, 'utf8');
    const m = text.match(/version:\s*['"]?([^'"\n]+)['"]?/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function run(cmd, args, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stdout += s;
      if (onOutput) onOutput({ stream: 'stdout', data: s });
    });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderr += s;
      if (onOutput) onOutput({ stream: 'stderr', data: s });
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
