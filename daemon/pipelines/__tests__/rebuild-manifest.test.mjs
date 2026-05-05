import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildManifest, quoteField, _internals } from '../lib/rebuild-manifest.mjs';

let bmadRoot;

function writeAgent(relPath, body) {
  const full = join(bmadRoot, relPath);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, body, 'utf8');
}

function minimalAgent({ name, title, icon, role, identity, communicationStyle, principles }) {
  return `---
name: ${name}
---

<agent id="agents/${name}" name="${name}" title="${title}" icon="${icon}">
<role>${role ?? ''}</role>
<identity>${identity ?? ''}</identity>
<communication_style>${communicationStyle ?? ''}</communication_style>
<principles>${principles ?? ''}</principles>
</agent>
`;
}

beforeEach(() => {
  bmadRoot = mkdtempSync(join(tmpdir(), 'bmad-rebuild-'));
  // _cfg dir must exist for the output file.
  mkdirSync(join(bmadRoot, '_cfg'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(bmadRoot, { recursive: true, force: true });
  } catch {
    // tolerate best-effort cleanup
  }
});

describe('quoteField (RFC 4180)', () => {
  it('wraps plain fields in quotes', () => {
    expect(quoteField('hello')).toBe('"hello"');
  });

  it('doubles internal quotes', () => {
    expect(quoteField('say "hi"')).toBe('"say ""hi"""');
  });

  it('preserves commas verbatim inside quotes', () => {
    expect(quoteField('a, b, c')).toBe('"a, b, c"');
  });

  it('preserves newlines verbatim inside quotes', () => {
    expect(quoteField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('deriveModule', () => {
  const { deriveModule } = _internals;
  it('classifies core', () => {
    expect(deriveModule('/r/core/agents/x.md', '/r')).toBe('core');
  });
  it('classifies bmb', () => {
    expect(deriveModule('/r/bmb/agents/x.md', '/r')).toBe('bmb');
  });
  it('classifies bmm', () => {
    expect(deriveModule('/r/bmm/agents/x.md', '/r')).toBe('bmm');
  });
  it('classifies cis', () => {
    expect(deriveModule('/r/cis/agents/x.md', '/r')).toBe('cis');
  });
  it('classifies agents (custom)', () => {
    expect(deriveModule('/r/agents/rick/rick.md', '/r')).toBe('agents');
  });
});

describe('rebuildManifest — minimal tree', () => {
  it('writes a CSV with just the header when no agents exist', async () => {
    const count = await rebuildManifest(bmadRoot);
    expect(count).toBe(0);
    const csv = readFileSync(join(bmadRoot, '_cfg', 'agent-manifest.csv'), 'utf8');
    expect(csv).toBe(
      'name,displayName,title,icon,role,identity,communicationStyle,principles,module,path\n',
    );
  });

  it('writes one row for a single core agent', async () => {
    writeAgent(
      'core/agents/bmad-master.md',
      minimalAgent({
        name: 'bmad-master',
        title: 'Master',
        icon: '🧙',
        role: 'Orchestrator',
        identity: 'Expert',
        communicationStyle: 'Direct',
        principles: 'Runtime loading',
      }),
    );

    const count = await rebuildManifest(bmadRoot);
    expect(count).toBe(1);

    const csv = readFileSync(join(bmadRoot, '_cfg', 'agent-manifest.csv'), 'utf8');
    const lines = csv.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // header + 1
    expect(lines[0]).toBe(
      'name,displayName,title,icon,role,identity,communicationStyle,principles,module,path',
    );
    expect(lines[1]).toContain('"bmad-master"');
    expect(lines[1]).toContain('"core"');
    expect(lines[1]).toContain('"bmad/core/agents/bmad-master.md"');
  });
});

describe('rebuildManifest — module ordering', () => {
  it('sorts rows as core → bmb → bmm → cis → agents', async () => {
    writeAgent(
      'cis/agents/storyteller.md',
      minimalAgent({ name: 'storyteller', title: 'ST', icon: '📖' }),
    );
    writeAgent('agents/rick/rick.md', minimalAgent({ name: 'rick', title: 'R', icon: '🧪' }));
    writeAgent('bmm/agents/dev.md', minimalAgent({ name: 'dev', title: 'Dev', icon: '💻' }));
    writeAgent('bmb/agents/bmad-builder.md', minimalAgent({ name: 'bmad-builder', title: 'B', icon: '🧙' }));
    writeAgent('core/agents/bmad-master.md', minimalAgent({ name: 'bmad-master', title: 'M', icon: '🧙' }));

    const count = await rebuildManifest(bmadRoot);
    expect(count).toBe(5);

    const csv = readFileSync(join(bmadRoot, '_cfg', 'agent-manifest.csv'), 'utf8');
    const rows = csv.split('\n').filter((l) => l.length > 0).slice(1);
    const modules = rows.map((r) => {
      const m = r.match(/"([^"]+)","([^"]+)"$/);
      return m ? m[1] : null;
    });
    expect(modules).toEqual(['core', 'bmb', 'bmm', 'cis', 'agents']);
  });
});

describe('rebuildManifest — CSV escaping (RFC 4180)', () => {
  it('correctly escapes commas in principles', async () => {
    writeAgent(
      'bmm/agents/analyst.md',
      minimalAgent({
        name: 'analyst',
        title: 'Business Analyst',
        icon: '📊',
        principles: 'a, b, c, d',
      }),
    );
    await rebuildManifest(bmadRoot);
    const csv = readFileSync(join(bmadRoot, '_cfg', 'agent-manifest.csv'), 'utf8');
    expect(csv).toContain('"a, b, c, d"');
  });

  it('correctly escapes double quotes by doubling them', async () => {
    writeAgent(
      'bmm/agents/pm.md',
      minimalAgent({
        name: 'pm',
        title: 'PM',
        icon: '📋',
        identity: 'asks the "why" behind every requirement',
      }),
    );
    await rebuildManifest(bmadRoot);
    const csv = readFileSync(join(bmadRoot, '_cfg', 'agent-manifest.csv'), 'utf8');
    expect(csv).toContain('"asks the ""why"" behind every requirement"');
  });
});

describe('rebuildManifest — file filtering', () => {
  it('excludes *.source.md and *.customize.yaml siblings', async () => {
    writeAgent('agents/rick/rick.md', minimalAgent({ name: 'rick', title: 'R', icon: '🧪' }));
    writeFileSync(join(bmadRoot, 'agents/rick/rick-source.source.md'), '# source template', 'utf8');
    writeFileSync(join(bmadRoot, 'agents/rick/rick.customize.yaml'), 'key: value', 'utf8');
    const count = await rebuildManifest(bmadRoot);
    expect(count).toBe(1);
  });

  it('tolerates an agent file missing persona tags', async () => {
    const stripped = `<agent id="agents/plain" name="plain" title="P" icon="?"></agent>`;
    writeAgent('agents/plain/plain.md', stripped);
    const count = await rebuildManifest(bmadRoot);
    expect(count).toBe(1);
    const csv = readFileSync(join(bmadRoot, '_cfg', 'agent-manifest.csv'), 'utf8');
    // Empty persona fields should appear as "" (quoted empty).
    expect(csv).toContain('"plain"');
  });
});
