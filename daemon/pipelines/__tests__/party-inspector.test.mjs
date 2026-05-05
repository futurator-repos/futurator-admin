import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProject } from '../party-inspector.mjs';

let projectPath;
let sourcePath;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'party-inspect-proj-'));
  sourcePath = mkdtempSync(join(tmpdir(), 'party-inspect-src-'));
});

afterEach(() => {
  try {
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(sourcePath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function writeManifestYaml(version) {
  mkdirSync(join(projectPath, 'bmad', '_cfg'), { recursive: true });
  writeFileSync(
    join(projectPath, 'bmad', '_cfg', 'manifest.yaml'),
    `installation:\n  version: '${version}'\n`,
    'utf8',
  );
}

function writeAgentManifestCsv(rowCount) {
  mkdirSync(join(projectPath, 'bmad', '_cfg'), { recursive: true });
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push(
      `"agent${i}","agent${i}","T","?","role","id","style","principles","agents","bmad/agents/a${i}/a${i}.md"`,
    );
  }
  const csv = [
    'name,displayName,title,icon,role,identity,communicationStyle,principles,module,path',
    ...rows,
  ].join('\n');
  writeFileSync(join(projectPath, 'bmad', '_cfg', 'agent-manifest.csv'), csv + '\n', 'utf8');
}

function writeAgentFile(dir, name, body) {
  mkdirSync(join(projectPath, 'bmad', 'agents', name), { recursive: true });
  writeFileSync(join(projectPath, 'bmad', 'agents', name, `${name}.md`), body, 'utf8');
}

function writeSourceAgentFile(name, body) {
  mkdirSync(join(sourcePath, name), { recursive: true });
  writeFileSync(join(sourcePath, name, `${name}.md`), body, 'utf8');
}

describe('inspectProject — MISSING', () => {
  it('returns MISSING when the project directory has no bmad/', async () => {
    const result = await inspectProject({
      projectId: 'p',
      projectPath,
      expectedBmadVersion: '6.0.0-alpha.7',
    });
    expect(result.status).toBe('MISSING');
  });

  it('returns MISSING when projectPath does not exist', async () => {
    const result = await inspectProject({
      projectId: 'p',
      projectPath: '/nonexistent/path/for/tests',
      expectedBmadVersion: '6.0.0-alpha.7',
    });
    expect(result.status).toBe('MISSING');
  });
});

describe('inspectProject — CORRUPTED', () => {
  it('returns CORRUPTED when manifest.yaml exists but CSV is missing', async () => {
    writeManifestYaml('6.0.0-alpha.7');
    const result = await inspectProject({
      projectId: 'p',
      projectPath,
      expectedBmadVersion: '6.0.0-alpha.7',
    });
    expect(result.status).toBe('CORRUPTED');
    expect(result.failureReason).toContain('agent-manifest.csv missing');
  });
});

describe('inspectProject — DRIFTED', () => {
  it('returns DRIFTED on version mismatch', async () => {
    writeManifestYaml('5.0.0');
    writeAgentManifestCsv(23);
    writeAgentFile(projectPath, 'rick', '<agent id="agents/rick" name="rick" title="R" icon="🧪"></agent>');
    writeSourceAgentFile('rick', '<agent id="agents/rick" name="rick" title="R" icon="🧪"></agent>');
    const result = await inspectProject({
      projectId: 'p',
      projectPath,
      expectedBmadVersion: '6.0.0-alpha.7',
      customAgentsSourceDir: sourcePath,
    });
    expect(result.status).toBe('DRIFTED');
    expect(result.bmadVersion).toBe('5.0.0');
    expect(result.failureReason).toContain('version drift');
  });

  it('returns DRIFTED when custom-agent SHA differs from source', async () => {
    writeManifestYaml('6.0.0-alpha.7');
    writeAgentManifestCsv(23);
    writeAgentFile(projectPath, 'rick', '<agent id="agents/rick" name="rick" title="R" icon="🧪"></agent>');
    writeSourceAgentFile(
      'rick',
      '<agent id="agents/rick" name="rick" title="RICK-NEW" icon="🧪"></agent>',
    );
    const result = await inspectProject({
      projectId: 'p',
      projectPath,
      expectedBmadVersion: '6.0.0-alpha.7',
      customAgentsSourceDir: sourcePath,
    });
    expect(result.status).toBe('DRIFTED');
    expect(result.customAgentsSHA).not.toBe(result.expectedCustomAgentsSHA);
  });
});

describe('inspectProject — HEALTHY', () => {
  it('returns HEALTHY when version matches and SHAs match', async () => {
    writeManifestYaml('6.0.0-alpha.7');
    writeAgentManifestCsv(23);
    const sameBody = '<agent id="agents/rick" name="rick" title="R" icon="🧪"></agent>';
    writeAgentFile(projectPath, 'rick', sameBody);
    writeSourceAgentFile('rick', sameBody);
    const result = await inspectProject({
      projectId: 'p',
      projectPath,
      expectedBmadVersion: '6.0.0-alpha.7',
      customAgentsSourceDir: sourcePath,
    });
    expect(result.status).toBe('HEALTHY');
    expect(result.bmadVersion).toBe('6.0.0-alpha.7');
    expect(result.agentCount).toBe(23);
  });

  it('returns HEALTHY without SHA check when source dir is unavailable', async () => {
    writeManifestYaml('6.0.0-alpha.7');
    writeAgentManifestCsv(23);
    writeAgentFile(projectPath, 'rick', '<agent id="agents/rick" name="rick" title="R" icon="🧪"></agent>');
    const result = await inspectProject({
      projectId: 'p',
      projectPath,
      expectedBmadVersion: '6.0.0-alpha.7',
      // no customAgentsSourceDir provided
    });
    expect(result.status).toBe('HEALTHY');
  });
});
