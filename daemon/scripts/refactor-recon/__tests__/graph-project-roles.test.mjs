/**
 * graph-project-roles.test.mjs — locks the role/provider projection onto graph
 * nodes (the "graph distinguishes infra vs 3rd-party" feature). Runs the REAL
 * graph-project.mjs against a synthetic graphify-out whose resolved-imports.json
 * carries fileRoles (as alias-resolve now emits), and asserts each file node
 * surfaces role + providers for the AI agent to explore.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, '..', 'graph-project.mjs');

let dir;
let ui;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-roles-'));
  const file = (p) => p; // relative ids, as alias-resolve emits
  const graph = {
    repo: '/x',
    nodes: [
      { label: 'claude.ts', source_file: 'src/ai/claude.ts', community: 0 },
      { label: 'users.ts', source_file: 'src/db/users.ts', community: 1 },
      { label: 'util.ts', source_file: 'src/util.ts', community: 1 },
    ],
  };
  const resolved = {
    repo: '/x',
    hubs: [
      { file: 'src/util.ts', inDegree: 2 },
      { file: 'src/db/users.ts', inDegree: 1 },
    ],
    edges: [
      { source: 'src/ai/claude.ts', target: 'src/util.ts' },
      { source: 'src/db/users.ts', target: 'src/util.ts' },
    ],
    fileRoles: {
      'src/ai/claude.ts': {
        role: 'ai',
        kinds: ['ai'],
        detections: [
          { kind: 'ai', provider: 'Anthropic (Claude API)', residency: 'external' },
        ],
      },
      'src/db/users.ts': {
        role: 'db',
        kinds: ['db'],
        detections: [{ kind: 'db', provider: 'DynamoDB', residency: 'in-account' }],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph));
  fs.writeFileSync(path.join(dir, 'resolved-imports.json'), JSON.stringify(resolved));
  fs.writeFileSync(path.join(dir, 'hotspots.json'), JSON.stringify({ hotspots: [] }));
  void file;

  execFileSync('node', [PROJECT, dir], { encoding: 'utf8' });
  ui = JSON.parse(fs.readFileSync(path.join(dir, 'graph-ui.json'), 'utf8'));
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const node = (id) => ui.nodes.find((n) => n.id === id);

describe('role projection', () => {
  it('tags the AI file with role + Claude provider', () => {
    const n = node('src/ai/claude.ts');
    expect(n.role).toBe('ai');
    expect(n.providers).toContainEqual({
      provider: 'Anthropic (Claude API)',
      kind: 'ai',
      residency: 'external',
    });
  });

  it('tags the db file with role + DynamoDB provider (in-account)', () => {
    const n = node('src/db/users.ts');
    expect(n.role).toBe('db');
    expect(n.providers[0]).toMatchObject({ provider: 'DynamoDB', residency: 'in-account' });
  });

  it('leaves role-less files null with empty providers', () => {
    const n = node('src/util.ts');
    expect(n.role).toBeNull();
    expect(n.providers).toEqual([]);
  });
});
