/**
 * rsync-based sync of the admin repo's `bmad/agents/` source of truth onto a
 * target project's `bmad/agents/` directory.
 *
 * `--delete` is intentional: an agent removed from source should be removed
 * from projects on re-sync so drift never accumulates.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function syncCustomAgents({ sourceDir, projectPath, onOutput }) {
  if (!sourceDir || !projectPath) {
    throw new Error('syncCustomAgents: sourceDir and projectPath are required');
  }
  if (!existsSync(sourceDir)) {
    throw new Error(
      `syncCustomAgents: sourceDir does not exist: ${sourceDir}. ` +
        'One-time setup on EC2 required: git clone admin repo to ' +
        '/home/ubuntu/bmad-agents-source/',
    );
  }

  const targetDir = join(projectPath, 'bmad', 'agents');
  mkdirSync(targetDir, { recursive: true });

  // Trailing slash on source is critical for rsync semantics (copy contents,
  // not the directory itself).
  const src = sourceDir.endsWith('/') ? sourceDir : `${sourceDir}/`;
  const dst = targetDir.endsWith('/') ? targetDir : `${targetDir}/`;

  const { code, stdout, stderr } = await run(
    'rsync',
    ['-av', '--checksum', '--delete', src, dst],
    onOutput,
  );
  if (code !== 0) {
    const err = new Error(`rsync exited with code ${code}`);
    err.stdout = stdout;
    err.stderr = stderr;
    err.code = code;
    throw err;
  }
  return { stdout, stderr };
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
